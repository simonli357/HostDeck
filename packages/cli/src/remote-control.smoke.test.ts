import { Buffer } from "node:buffer";
import { Resolver } from "node:dns/promises";
import { mkdtempSync, rmSync } from "node:fs";
import {
  createServer,
  type IncomingHttpHeaders,
  type Server
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  defaultResourceBudget,
  type RemoteIngressAdmissionProof,
  type RemoteIngressObservationSnapshot,
  type RemoteIngressState,
  type RemoteServeDescriptor,
  remoteServeDescriptorSchema
} from "@hostdeck/contracts";
import {
  createHostDeckRemoteIngressRouteRegistration,
  createHostDeckRequestAuthenticationPolicy,
  createHostDeckTailscaleServeFastifyApp,
  createRemoteIngressControlService,
  createSecurityMutationAuditExecutor,
  createTailscaleObserver,
  createTailscaleServeManager,
  createTailscaleServeProxyTrustPolicy,
  type HostDeckFastifyInstance,
  type TailscaleObserver,
  type TailscaleServeManager
} from "@hostdeck/server";
import {
  createRemoteIngressAdmissionProofRepository,
  createRemoteIngressStateRepository,
  createSelectedAuditRepository,
  openMigratedDatabase
} from "@hostdeck/storage";
import { describe, it } from "vitest";
import { cliExitCodes } from "./exit-codes.js";
import { runCli } from "./shell.js";

const requireSmoke = process.env.HOSTDECK_REQUIRE_REMOTE_CONTROL_SMOKE === "1";
const describeSmoke = requireSmoke ? describe : describe.skip;
const tailscaleDnsServer = "100.100.100.100";
const remoteResponseMaxBytes = defaultResourceBudget.cli_response_max_bytes;

describeSmoke("real dedicated-profile remote control vertical", () => {
  it("enables, reads, proxies, disables, and proves exact cleanup", async () => {
    const controller = new AbortController();
    const directory = mkdtempSync(join(tmpdir(), "hostdeck-remote-control-smoke-"));
    const opened = openMigratedDatabase(join(directory, "hostdeck.sqlite"));
    const states = createRemoteIngressStateRepository(opened.db);
    const proofs = createRemoteIngressAdmissionProofRepository(opened.db);
    const observer = createTailscaleObserver({ signal: controller.signal });
    const manager = createTailscaleServeManager({
      observer,
      signal: controller.signal
    });
    let app: HostDeckFastifyInstance | null = null;
    let fallbackCleanup: CleanupTarget | null = null;

    try {
      const candidate = requireDedicatedAbsentCandidate(
        await observer.observeCandidate()
      );
      const port = await reserveLoopbackPort();
      const localOrigin = `http://127.0.0.1:${port}`;
      fallbackCleanup = Object.freeze({
        expectedProfileKey: candidate.expectedProfileKey,
        expectedServe: remoteServeDescriptorSchema.parse({
          external_origin: candidate.externalOrigin,
          https_port: 443,
          path: "/",
          proxy_origin: localOrigin,
          visibility: "private"
        })
      });

      let wallTime = Date.now();
      let auditIndex = 0;
      const now = () => {
        wallTime = Math.max(wallTime + 1, Date.now());
        return new Date(wallTime);
      };
      const service = createRemoteIngressControlService({
        admissionProofs: proofs,
        audit: createSecurityMutationAuditExecutor({
          repository: createSelectedAuditRepository(opened.db),
          now: () => now().toISOString(),
          create_record_id: () =>
            `audit:real:remote-control:${++auditIndex}`
        }),
        localOrigin,
        manager,
        monotonicNow: () => performance.now(),
        now,
        observer,
        states
      });
      app = createHostDeckTailscaleServeFastifyApp({
        observeInternalError: () => undefined,
        requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
          authenticateDeviceToken() {
            throw new Error("Unexpected device authentication in remote-control smoke.");
          },
          now
        }),
        resourceBudget: defaultResourceBudget,
        routePlugins: [
          createHostDeckRemoteIngressRouteRegistration({ service })
        ],
        tailscaleServeProxyTrustPolicy: createTailscaleServeProxyTrustPolicy({
          localOrigin,
          readRemoteAdmission: service.readAdmission
        })
      });
      await app.listen({ host: "127.0.0.1", port });

      const env = Object.freeze({
        HOME: directory,
        HOSTDECK_API_BASE_URL: localOrigin,
        HOSTDECK_STATE_DIR: directory
      });
      const generatedActions: string[] = [];
      const createOperationId = (action: "disable" | "enable") => {
        generatedActions.push(action);
        return `op_real_remote_control_${action}_01`;
      };
      const privateValues = Object.freeze([
        candidate.externalOrigin,
        candidate.expectedProfileKey
      ]);

      assertCliState(
        await runCli(["remote", "status", "--json"], { env }),
        "disabled",
        privateValues
      );
      assertClosedAdmission(service.readAdmission());

      assertCliState(
        await runCli(["remote", "enable", "--json"], {
          createOperationId,
          env
        }),
        "ready",
        privateValues
      );
      assertOpenAdmission(
        service.readAdmission(),
        candidate.externalOrigin
      );
      assertCliState(
        await runCli(["remote", "status", "--json"], { env }),
        "ready",
        privateValues
      );
      await assertUnpairedRemoteBoundary(candidate.externalOrigin);

      assertCliState(
        await runCli(["remote", "disable", "--json"], {
          createOperationId,
          env
        }),
        "disabled",
        privateValues
      );
      assertClosedAdmission(service.readAdmission());
      assertCliState(
        await runCli(["remote", "status", "--json"], { env }),
        "disabled",
        privateValues
      );

      requireCondition(
        generatedActions.join(",") === "enable,disable",
        "Remote-control smoke generated an unexpected operation sequence."
      );
      assertFinalStorage(states.read(), proofs.read());
      assertAuditTrail(opened.db);
      const managerState = manager.snapshot();
      requireCondition(
        managerState.active === false &&
          managerState.command_attempts === 2 &&
          managerState.succeeded_operations === 2,
        "Remote-control smoke manager accounting is invalid."
      );
    } finally {
      try {
        const cleanup = cleanupTarget(states.read(), fallbackCleanup);
        if (cleanup !== null) {
          await proveOrRestoreAbsent(observer, manager, cleanup);
        }
      } finally {
        controller.abort();
        await closeSmokeResources(app, opened.db, directory);
      }
    }
  });
});

interface CleanupTarget {
  readonly expectedProfileKey: string;
  readonly expectedServe: RemoteServeDescriptor;
}

interface CliResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

function requireDedicatedAbsentCandidate(
  snapshot: RemoteIngressObservationSnapshot
): Readonly<{ externalOrigin: string; expectedProfileKey: string }> {
  const expectedProfileKey =
    snapshot.profile.comparison.expected_profile_key;
  const activeProfileKey = snapshot.profile.comparison.active_profile_key;
  const externalOrigin = snapshot.external_origin;
  requireCondition(
    snapshot.client === "available" &&
      snapshot.failure === null &&
      snapshot.profile.state === "dedicated" &&
      snapshot.profile.comparison.relation === "match" &&
      typeof expectedProfileKey === "string" &&
      expectedProfileKey === activeProfileKey &&
      typeof externalOrigin === "string" &&
      snapshot.serve === "absent",
    "Remote-control smoke requires one clean active dedicated profile."
  );
  return Object.freeze({
    externalOrigin: externalOrigin as string,
    expectedProfileKey: expectedProfileKey as string
  });
}

function assertCliState(
  result: CliResult,
  availability: "disabled" | "ready",
  privateValues: readonly string[]
): void {
  requireCondition(
    result.exitCode === cliExitCodes.ok && result.stderr === "",
    `Remote-control CLI command failed (${result.exitCode}:${boundedCliErrorCode(result.stderr)}).`
  );
  assertNoPrivateValue(result.stdout, privateValues);
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error("Remote-control CLI returned invalid JSON.");
  }
  requireCondition(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Remote-control CLI returned an invalid state object."
  );
  const state = value as Record<string, unknown>;
  requireCondition(
    Object.keys(state).sort().join(",") ===
      "availability,generation,laptop_action_required,observed_at,reason" &&
      state.availability === availability &&
      Number.isSafeInteger(state.generation) &&
      state.laptop_action_required === (availability !== "ready") &&
      !Object.hasOwn(state, "external_origin"),
    "Remote-control CLI returned an invalid public projection."
  );
}

function boundedCliErrorCode(stderr: string): string {
  const match = /^HostDeck CLI error \(([a-z_]+)\):/u.exec(stderr);
  return match?.[1] ?? "unknown";
}

function assertNoPrivateValue(
  output: string,
  privateValues: readonly string[]
): void {
  requireCondition(
    privateValues.every((value) => !output.includes(value)) &&
      !/profile_key|account|node_key|auth_key|credential|proof_id|audit_id/iu.test(
        output
      ),
    "Remote-control CLI output retained private identity data."
  );
}

function assertOpenAdmission(
  admission: Readonly<{
    admission: string;
    external_origin: string | null;
    generation: number;
  }>,
  expectedOrigin: string
): void {
  requireCondition(
    admission.admission === "open" &&
      admission.external_origin === expectedOrigin &&
      Number.isSafeInteger(admission.generation) &&
      admission.generation > 0,
    "Remote-control smoke did not establish exact admission."
  );
}

function assertClosedAdmission(
  admission: Readonly<{
    admission: string;
    external_origin: string | null;
    generation: number;
  }>
): void {
  requireCondition(
    admission.admission === "closed" &&
      admission.external_origin === null &&
      Number.isSafeInteger(admission.generation),
    "Remote-control smoke admission was not closed."
  );
}

async function assertUnpairedRemoteBoundary(origin: string): Promise<void> {
  const response = await requestPrivateIngress(
    new URL("/api/v1/remote/status", origin)
  );
  requireCondition(
    response.status === 401 &&
      response.headers["set-cookie"] === undefined &&
      !response.body.includes(origin),
    "Remote-control smoke remote authorization boundary is invalid."
  );
}

async function requestPrivateIngress(url: URL): Promise<Readonly<{
  readonly body: string;
  readonly headers: IncomingHttpHeaders;
  readonly status: number;
}>> {
  requireCondition(
    url.protocol === "https:" &&
      (url.port === "" || url.port === "443") &&
      url.username === "" &&
      url.password === "",
    "Remote-control smoke received an invalid private HTTPS origin."
  );
  const address = await resolveTailnetIpv4(url.hostname);
  return await new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        agent: false,
        headers: {
          accept: "application/json",
          connection: "close",
          host: url.host
        },
        hostname: address,
        method: "GET",
        path: `${url.pathname}${url.search}`,
        port: 443,
        rejectUnauthorized: true,
        servername: url.hostname
      },
      (response) => {
        const declaredLength = response.headers["content-length"];
        if (
          typeof declaredLength === "string" &&
          /^\d+$/u.test(declaredLength) &&
          Number(declaredLength) > remoteResponseMaxBytes
        ) {
          response.destroy(
            new Error("Remote-control smoke HTTPS response was oversized.")
          );
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.byteLength;
          if (bytes > remoteResponseMaxBytes) {
            response.destroy(
              new Error("Remote-control smoke HTTPS response was oversized.")
            );
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () => {
          const status = response.statusCode;
          if (status === undefined || !Number.isSafeInteger(status)) {
            reject(new Error("Remote-control smoke received no HTTPS status."));
            return;
          }
          resolve(
            Object.freeze({
              body: Buffer.concat(chunks, bytes).toString("utf8"),
              headers: response.headers,
              status
            })
          );
        });
        response.on("error", (error) => reject(safeTransportFailure(error)));
        response.on("aborted", () =>
          reject(new Error("Remote-control smoke HTTPS response was incomplete."))
        );
        response.on("close", () => {
          if (!response.complete) {
            reject(
              new Error("Remote-control smoke HTTPS response was incomplete.")
            );
          }
        });
      }
    );
    request.setTimeout(10_000, () => {
      request.destroy(
        new Error("Remote-control smoke private HTTPS request timed out.")
      );
    });
    request.on("error", (error) => reject(safeTransportFailure(error)));
    request.end();
  });
}

async function resolveTailnetIpv4(hostname: string): Promise<string> {
  const resolver = new Resolver({ timeout: 2_000, tries: 2 });
  resolver.setServers([tailscaleDnsServer]);
  let addresses: readonly string[];
  try {
    addresses = await resolver.resolve4(hostname);
  } catch (error) {
    throw safeTransportFailure(error, "Tailnet DNS resolution");
  }
  const address = addresses.find(isTailnetIpv4);
  requireCondition(
    address !== undefined && addresses.length <= 8,
    "Remote-control smoke Tailnet DNS response is invalid."
  );
  return address;
}

function isTailnetIpv4(value: string): boolean {
  const parts = value.split(".").map(Number);
  return (
    parts.length === 4 &&
    parts.every(
      (part) => Number.isInteger(part) && part >= 0 && part <= 255
    ) &&
    parts[0] === 100 &&
    (parts[1] as number) >= 64 &&
    (parts[1] as number) <= 127
  );
}

function safeTransportFailure(
  error: unknown,
  operation = "Private HTTPS request"
): Error {
  return new Error(`${operation} failed (${boundedTransportCode(error)}).`);
}

function boundedTransportCode(error: unknown): string {
  if (error === null || typeof error !== "object") return "unknown";
  const cause = Reflect.get(error, "cause");
  if (cause === null || typeof cause !== "object") return "unknown";
  const code = Reflect.get(cause, "code");
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/u.test(code)
    ? code
    : "unknown";
}

function assertFinalStorage(
  state: RemoteIngressState | null,
  proof: RemoteIngressAdmissionProof | null
): void {
  requireCondition(
    state !== null &&
      state.intent === "disabled" &&
      state.availability === "disabled" &&
      state.admission === "closed" &&
      state.expected_serve === null &&
      state.external_origin === null &&
      state.profile.comparison.expected_profile_key === null &&
      state.operation_failure === null &&
      proof === null,
    "Remote-control smoke retained selected state after cleanup."
  );
}

function assertAuditTrail(
  db: ReturnType<typeof openMigratedDatabase>["db"]
): void {
  const rows = db
    .prepare(
      "SELECT action, phase, outcome, COUNT(*) AS count " +
        "FROM selected_audit_events " +
        "GROUP BY action, phase, outcome ORDER BY action, phase, outcome"
    )
    .all() as Array<{
    readonly action: string;
    readonly count: number;
    readonly outcome: string;
    readonly phase: string;
  }>;
  requireCondition(
    JSON.stringify(rows) ===
      JSON.stringify([
        {
          action: "remote_disable",
          phase: "accepted",
          outcome: "accepted",
          count: 1
        },
        {
          action: "remote_disable",
          phase: "terminal",
          outcome: "succeeded",
          count: 1
        },
        {
          action: "remote_enable",
          phase: "accepted",
          outcome: "accepted",
          count: 1
        },
        {
          action: "remote_enable",
          phase: "terminal",
          outcome: "succeeded",
          count: 1
        }
      ]),
    "Remote-control smoke audit trail is invalid."
  );
}

function cleanupTarget(
  state: RemoteIngressState | null,
  fallback: CleanupTarget | null
): CleanupTarget | null {
  const profileKey = state?.profile.comparison.expected_profile_key;
  if (
    state !== null &&
    typeof profileKey === "string" &&
    state.expected_serve !== null
  ) {
    return Object.freeze({
      expectedProfileKey: profileKey,
      expectedServe: state.expected_serve
    });
  }
  return fallback;
}

async function proveOrRestoreAbsent(
  observer: TailscaleObserver,
  manager: TailscaleServeManager,
  cleanup: CleanupTarget
): Promise<void> {
  const current = await observer.observeConfigured({
    expected_profile_key: cleanup.expectedProfileKey,
    expected_serve: cleanup.expectedServe
  });
  requireCondition(
    current.client === "available" &&
      current.failure === null &&
      current.profile.state === "dedicated" &&
      current.profile.comparison.relation === "match" &&
      (current.serve === "absent" || current.serve === "exact"),
    "Remote-control smoke cannot prove ownership-safe cleanup."
  );
  if (current.serve === "absent") return;

  const removed = await manager.disable({
    expected_profile_key: cleanup.expectedProfileKey,
    expected_serve: cleanup.expectedServe
  });
  requireCondition(
    removed.outcome === "succeeded" &&
      removed.after !== null &&
      removed.after.serve === "absent" &&
      removed.after.failure === null,
    "Remote-control smoke cleanup did not remove owned Serve state."
  );
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await listen(server, 0);
  const address = server.address();
  requireCondition(
    address !== null && typeof address !== "string",
    "Remote-control smoke could not reserve a loopback port."
  );
  const port = (address as AddressInfo).port;
  await close(server);
  return port;
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

async function closeSmokeResources(
  app: HostDeckFastifyInstance | null,
  db: ReturnType<typeof openMigratedDatabase>["db"],
  directory: string
): Promise<void> {
  let failed = false;
  try {
    if (app !== null) await app.close();
  } catch {
    failed = true;
  }
  try {
    db.close();
  } catch {
    failed = true;
  }
  try {
    rmSync(directory, { force: true, recursive: true });
  } catch {
    failed = true;
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (process.getActiveResourcesInfo().includes("ChildProcess")) failed = true;
  requireCondition(!failed, "Remote-control smoke resource cleanup failed.");
}

function requireCondition(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) throw new Error(message);
}
