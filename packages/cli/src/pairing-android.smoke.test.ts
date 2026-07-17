import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  defaultResourceBudget,
  type RemoteIngressObservationSnapshot,
  type RemoteServeDescriptor,
  remoteProxyTrustRejectionReasons,
  remoteServeDescriptorSchema,
  selectedPairingFragmentPrefix,
  selectedPairingLinkSchema,
  selectedRequestAuthenticationContextSchema
} from "@hostdeck/contracts";
import {
  createHostDeckCsrfPolicy,
  createHostDeckCsrfRouteRegistration,
  createHostDeckPairingPolicy,
  createHostDeckPairingRouteRegistration,
  createHostDeckRemoteIngressRequestAuthorityPolicy,
  createHostDeckRemoteIngressRouteRegistration,
  createHostDeckRequestAuthenticationPolicy,
  createHostDeckTailscaleServeFastifyApp,
  createRemoteIngressControlService,
  createSecurityMutationAuditExecutor,
  createTailscaleObserver,
  createTailscaleServeManager,
  createTailscaleServeProxyTrustPolicy,
  type HostDeckFastifyInstance,
  type HostDeckRoutePluginRegistration,
  type RemoteIngressControlService,
  requireHostDeckRequestAuthentication,
  resolveHostDeckRequestAuthentication,
  type TailscaleObserver,
  type TailscaleServeManager,
  tailscaleServeProxyTrustSnapshot
} from "@hostdeck/server";
import {
  createAuthDeviceRepository,
  createPairingCodeRepository,
  createRemoteIngressAdmissionProofRepository,
  createRemoteIngressStateRepository,
  createSelectedAuditRepository,
  createSelectedCsrfAuthorizationRepository,
  openMigratedDatabase
} from "@hostdeck/storage";
import { type Browser, type BrowserContext, chromium, type Page } from "@playwright/test";
import QRCode from "qrcode";
import { build as viteBuild } from "vite";
import { describe, it } from "vitest";
import { cliExitCodes } from "./exit-codes.js";
import { runCli } from "./shell.js";

const requirePhysicalPairing =
  process.env.HOSTDECK_REQUIRE_PAIRING_ANDROID_SMOKE === "1";
const describePhysical = requirePhysicalPairing ? describe : describe.skip;
const overallTimeoutMs = 10 * 60_000;
const claimTimeoutMs = 5 * 60_000;
const tailscaleDnsServer = "100.100.100.100";
const physicalPageMaxBytes = defaultResourceBudget.cli_response_max_bytes;
const deviceForbiddenValues = new Set<string>();
let adbCommandCount = 0;

describePhysical("IFC-V1-077 physical fragment-safe Android pairing", () => {
  it(
    "scans one private QR, scrubs Chrome, claims once, reloads safely, and cleans up",
    async () => {
      requireOneAuthorizedDevice();
      const controller = new AbortController();
      const directory = mkdtempSync(join(tmpdir(), "hostdeck-pairing-android-"));
      const dbPath = join(directory, "hostdeck.sqlite");
      const opened = openMigratedDatabase(dbPath);
      const states = createRemoteIngressStateRepository(opened.db);
      const proofs = createRemoteIngressAdmissionProofRepository(opened.db);
      const observer = createTailscaleObserver({ signal: controller.signal });
      const manager = createTailscaleServeManager({
        observer,
        signal: controller.signal
      });
      const secrets = createSecretRegistry();
      const requestInspection: RequestInspection = {
        claimRequests: 0,
        csrfRequests: 0,
        fragmentLeaks: 0,
        noReferrerApiRequests: 0,
        hardenedCookieObserved: false
      };
      let app: HostDeckFastifyInstance | null = null;
      let display: QrDisplay | null = null;
      let displayBrowser: Browser | null = null;
      let displayContext: BrowserContext | null = null;
      let displayPage: Page | null = null;
      let cdp: CdpClient | null = null;
      let forwardPort: number | null = null;
      let leaseKeeper: AdmissionLeaseKeeper | null = null;
      let remoteEnabled = false;
      let fallbackCleanup: CleanupTarget | null = null;
      let externalOrigin: string | null = null;
      let localOrigin: string | null = null;
      let env: Readonly<Record<string, string>> | null = null;

      try {
        const browserBundle = await buildPhysicalBrowserBundle();
        const candidate = requireDedicatedAbsentCandidate(
          await observer.observeCandidate()
        );
        await closeExistingChromeOriginTabs(candidate.externalOrigin);
        externalOrigin = candidate.externalOrigin;
        const port = await reserveLoopbackPort();
        localOrigin = `http://127.0.0.1:${port}`;
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

        const now = increasingWallClock();
        const audit = createSelectedAuditRepository(opened.db);
        let auditIndex = 0;
        const auditExecutor = createSecurityMutationAuditExecutor({
          repository: audit,
          now: () => now().toISOString(),
          create_record_id: () => `audit:physical:pairing:${++auditIndex}`
        });
        const service = createRemoteIngressControlService({
          admissionProofs: proofs,
          audit: auditExecutor,
          localOrigin,
          manager,
          monotonicNow: () => performance.now(),
          now,
          observer,
          states
        });
        const auth = createAuthDeviceRepository(opened.db);
        const pairing = createPairingCodeRepository(opened.db, {
          policy: defaultResourceBudget,
          generatePairingCode: () => secrets.create(16),
          generateDeviceId: () => `client_${createOpaqueIdentifier(18)}`,
          generateDeviceToken: () => secrets.create(32),
          generateCsrfToken: () => secrets.create(32)
        });
        const pairingPolicy = createHostDeckPairingPolicy({
          pairing: {
            issue: (input) => pairing.issue(input),
            claim: (input) => pairing.claim(input)
          },
          now,
          createPairingId: () => `pair_${createOpaqueIdentifier(18)}`
        });
        const csrfRepository = createSelectedCsrfAuthorizationRepository(
          opened.db,
          { generateCsrfToken: () => secrets.create(32) }
        );
        const csrfPolicy = createHostDeckCsrfPolicy({
          csrf: {
            authorizeBrowserWrite: (input) =>
              csrfRepository.authorizeBrowserWrite(input),
            rotateBootstrap: (input) => csrfRepository.rotateBootstrap(input)
          },
          now
        });
        const remoteRequestAuthority =
          createHostDeckRemoteIngressRequestAuthorityPolicy();

        app = createHostDeckTailscaleServeFastifyApp({
          observeInternalError: () => undefined,
          requestAuthenticationPolicy: createHostDeckRequestAuthenticationPolicy({
            authenticateDeviceToken: (input) =>
              auth.authenticateDeviceToken(input),
            now
          }),
          resourceBudget: defaultResourceBudget,
          remoteIngressRequestAuthority: remoteRequestAuthority,
          routePlugins: [
            createHostDeckRemoteIngressRouteRegistration({ service }),
            createHostDeckPairingRouteRegistration({
              audit: auditExecutor,
              pairing: pairingPolicy
            }),
            createHostDeckCsrfRouteRegistration({
              audit: auditExecutor,
              csrf: csrfPolicy
            }),
            physicalPageRoute(browserBundle),
            physicalProtectedRoute()
          ],
          tailscaleServeProxyTrustPolicy: createTailscaleServeProxyTrustPolicy({
            localOrigin,
            readRemoteAdmission: () =>
              remoteRequestAuthority.synchronize(service.readAdmission())
          })
        });
        installRequestInspection(app, requestInspection, secrets);
        await app.listen({ host: "127.0.0.1", port });
        env = Object.freeze({
          HOME: directory,
          HOSTDECK_API_BASE_URL: localOrigin,
          HOSTDECK_STATE_DIR: directory
        });

        assertRemoteCliResult(
          await runCli(["remote", "enable", "--json"], {
            createOperationId: () => "op_physical_remote_enable_0001",
            env
          }),
          "ready"
        );
        remoteEnabled = true;
        requireOpenAdmission(service.readAdmission(), candidate.externalOrigin);
        await assertTrustedPhysicalPage(candidate.externalOrigin);

        const rendered: PairingRenderCapture = {
          link: null,
          qrImage: null
        };
        let pairResult: Awaited<ReturnType<typeof runCli>> | null =
          await runCli(["pair", "--label", "Physical Android Chrome", "--write"], {
            createPairOperationId: () => "op_physical_pair_request_0001",
            env,
            renderPairingQr: async (link) => {
              rendered.link = selectedPairingLinkSchema.parse(link);
              rendered.qrImage = await QRCode.toDataURL(link, {
                errorCorrectionLevel: "M",
                margin: 4,
                type: "image/png",
                width: 560
              });
              return "Private QR display ready.";
            }
          });
        const pairingLink = rendered.link;
        const qrImage = rendered.qrImage;
        requireCondition(
          pairResult.exitCode === cliExitCodes.ok &&
            pairResult.stderr === "" &&
            typeof pairingLink === "string" &&
            typeof qrImage === "string" &&
            pairResult.stdout.includes(pairingLink) &&
            pairResult.stdout.includes("Private QR display ready.") &&
            !pairResult.stdout.includes("Code:"),
          "Physical pairing CLI did not produce one private link."
        );
        const parsedLink = new URL(pairingLink);
        const pairingCode = parsedLink.hash.slice(
          selectedPairingFragmentPrefix.length
        );
        requireCondition(
          parsedLink.origin === candidate.externalOrigin &&
            parsedLink.pathname === "/" &&
            parsedLink.search === "" &&
            /^[A-Za-z0-9_-]{22}$/u.test(pairingCode) &&
            secrets.has(pairingCode) &&
            !qrImage.includes(pairingCode),
          "Physical pairing link did not match the selected contract."
        );
        deviceForbiddenValues.add(pairingLink);
        pairResult = null;
        leaseKeeper = await startAdmissionLeaseKeeper(
          service,
          Math.max(1_000, Math.floor(observer.poll_interval_ms / 3))
        );

        display = await startQrDisplay(qrImage);
        rendered.link = null;
        rendered.qrImage = null;
        displayBrowser = await chromium.launch({ headless: false });
        displayContext = await displayBrowser.newContext({
          viewport: { width: 760, height: 860 }
        });
        displayPage = await displayContext.newPage();
        await displayPage.goto(display.url, { waitUntil: "load" });
        await displayPage.bringToFront();
        await displayPage.locator("img").waitFor({ state: "visible" });
        display.clear();

        adb(["shell", "am", "force-stop", "com.android.chrome"]);
        openDefaultCamera();
        await waitFor(
          () =>
            countRows(opened.db, "auth_devices") === 1 ||
            firstProxyRejection(app as HostDeckFastifyInstance) !== null ||
            (leaseKeeper as AdmissionLeaseKeeper).failed,
          claimTimeoutMs,
          "The physical phone did not claim the private QR in time."
        );
        const proxyRejection = firstProxyRejection(app);
        requireCondition(
          !leaseKeeper.failed,
          "The physical pairing admission lease could not be renewed."
        );
        requireCondition(
          proxyRejection === null,
          `The physical phone was rejected at the Serve boundary (${proxyRejection}).`
        );
        await displayPage.locator("#status").evaluate((element) => {
          element.textContent = "Pairing accepted. Inspecting the phone...";
        });
        await displayContext.close();
        displayContext = null;
        await displayBrowser.close();
        displayBrowser = null;
        await closeServer(display.server);
        display = null;
        displayPage = null;

        requireChromeRunning();
        forwardPort = createChromeForward();
        const target = await waitForChromeTarget(
          forwardPort,
          candidate.externalOrigin,
          30_000
        );
        cdp = await CdpClient.connect(
          target.webSocketDebuggerUrl,
          deviceForbiddenValues
        );
        await cdp.send("Runtime.enable");
        await cdp.send("Page.enable");
        await waitFor(
          async () =>
            (await readPhoneSnapshot(cdp as CdpClient)).state === "paired",
          30_000,
          "Physical Chrome did not publish paired browser state."
        );
        const initialPhone = await readPhoneSnapshot(cdp);
        assertPairedPhoneSnapshot(initialPhone);
        requireCondition(
          (await cdp.evaluate<number>(protectedReadExpression)) === 200,
          "Physical paired cookie did not authorize a protected read."
        );
        assertPairingRuntimeTruth(opened.db, requestInspection);
        assertPairingAudit(opened.db);
        assertSecretsAbsentFromDatabase(dbPath, secrets.values());

        await cdp.send("Page.reload", { ignoreCache: true });
        await waitFor(
          async () =>
            (await readPhoneSnapshot(cdp as CdpClient)).state === "no_fragment",
          30_000,
          "Physical Chrome reload did not reach the fragment-free state."
        );
        const reloadedPhone = await readPhoneSnapshot(cdp);
        assertReloadedPhoneSnapshot(reloadedPhone);
        requireCondition(
          (await cdp.evaluate<number>(protectedReadExpression)) === 200,
          "Physical reload lost the HttpOnly device authority."
        );
        assertPairingRuntimeTruth(opened.db, requestInspection);

        await cdp.send("Storage.clearDataForOrigin", {
          origin: candidate.externalOrigin,
          storageTypes:
            "cookies,local_storage,session_storage,indexeddb,cache_storage,service_workers"
        });
        requireCondition(
          (await cdp.evaluate<number>(protectedReadExpression)) === 401,
          "Physical HostDeck site-data cleanup did not remove device authority."
        );
        await cdp.send("Page.close").catch(() => undefined);
        cdp.close();
        cdp = null;
        adb(["forward", "--remove", `tcp:${forwardPort}`]);
        forwardPort = null;
        adb(["shell", "am", "force-stop", "com.android.chrome"]);
        adb(["shell", "input", "keyevent", "KEYCODE_HOME"]);
        await leaseKeeper.stop();
        requireCondition(
          leaseKeeper.renewals >= 1,
          "Physical pairing did not prove a current remote observation lease."
        );
        leaseKeeper = null;

        assertRemoteCliResult(
          await runCli(["remote", "disable", "--json"], {
            createOperationId: () => "op_physical_remote_disable_0001",
            env
          }),
          "disabled"
        );
        remoteEnabled = false;
        requireClosedAdmission(service.readAdmission());
        await requireConfiguredServeAbsent(
          observer,
          candidate.expectedProfileKey,
          fallbackCleanup.expectedServe
        );
        requireCondition(
          adbCommandCount > 0,
          "Physical pairing acceptance did not exercise guarded ADB control."
        );
      } finally {
        if (cdp !== null) cdp.close();
        if (forwardPort !== null) {
          try {
            adb(["forward", "--remove", `tcp:${forwardPort}`]);
          } catch {
            // Continue through ownership-safe host cleanup.
          }
        }
        try {
          adb(["shell", "am", "force-stop", "com.android.chrome"]);
          adb(["shell", "input", "keyevent", "KEYCODE_HOME"]);
        } catch {
          // A disconnected phone is reported by the main physical assertion.
        }
        if (displayContext !== null) await displayContext.close().catch(() => undefined);
        if (displayBrowser !== null) await displayBrowser.close().catch(() => undefined);
        if (display !== null) await closeServer(display.server).catch(() => undefined);
        if (leaseKeeper !== null) await leaseKeeper.stop().catch(() => undefined);
        if (
          remoteEnabled &&
          env !== null &&
          app !== null &&
          externalOrigin !== null &&
          localOrigin !== null
        ) {
          try {
            assertRemoteCliResult(
              await runCli(["remote", "disable", "--json"], {
                createOperationId: () => "op_physical_remote_disable_cleanup_0001",
                env
              }),
              "disabled"
            );
            remoteEnabled = false;
          } catch {
            // The exact manager fallback below still proves or restores absence.
          }
        }
        try {
          if (fallbackCleanup !== null) {
            await proveOrRestoreAbsent(observer, manager, fallbackCleanup);
          }
        } finally {
          controller.abort();
          if (app !== null) await app.close().catch(() => undefined);
          if (opened.db.open) opened.db.close();
          rmSync(directory, { force: true, recursive: true });
          deviceForbiddenValues.clear();
        }
      }
    },
    overallTimeoutMs
  );
});

interface CleanupTarget {
  readonly expectedProfileKey: string;
  readonly expectedServe: RemoteServeDescriptor;
}

interface RequestInspection {
  claimRequests: number;
  csrfRequests: number;
  fragmentLeaks: number;
  noReferrerApiRequests: number;
  hardenedCookieObserved: boolean;
}

interface PairingRenderCapture {
  link: string | null;
  qrImage: string | null;
}

interface AdmissionLeaseKeeper {
  readonly failed: boolean;
  readonly renewals: number;
  readonly stop: () => Promise<void>;
}

interface QrDisplay {
  readonly server: HttpServer;
  readonly url: string;
  readonly clear: () => void;
}

interface ChromeTarget {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly url: string;
  readonly webSocketDebuggerUrl: string;
}

interface ChromeTargetSnapshot {
  readonly endpointAvailable: boolean;
  readonly targets: readonly ChromeTarget[];
}

interface PhoneSnapshot {
  readonly cacheCount: number;
  readonly cookieLength: number;
  readonly csrfGeneration: number | null;
  readonly domHasPairFragment: boolean;
  readonly hash: string;
  readonly indexedDbCount: number;
  readonly localStorageCount: number;
  readonly pathname: string;
  readonly permission: string | null;
  readonly referrerHasPairFragment: boolean;
  readonly resourceHasPairFragment: boolean;
  readonly search: string;
  readonly serviceWorkerCount: number;
  readonly sessionStorageCount: number;
  readonly state: string;
  readonly summaryKeys: readonly string[];
}

interface CdpMessage {
  readonly error?: unknown;
  readonly id?: number;
  readonly method?: string;
  readonly result?: unknown;
}

const protectedReadExpression =
  "fetch('/__physical/protected',{credentials:'include',cache:'no-store',referrerPolicy:'no-referrer'}).then((response)=>response.status)";

function createSecretRegistry(): Readonly<{
  create(bytes: number): string;
  has(value: string): boolean;
  values(): readonly string[];
}> {
  const values: string[] = [];
  return Object.freeze({
    create(bytes) {
      const value = randomBytes(bytes).toString("base64url");
      values.push(value);
      deviceForbiddenValues.add(value);
      return value;
    },
    has(value) {
      return values.includes(value);
    },
    values() {
      return Object.freeze([...values]);
    }
  });
}

function createOpaqueIdentifier(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function increasingWallClock(): () => Date {
  let wallTime = Date.now();
  return () => {
    wallTime = Math.max(wallTime + 1, Date.now());
    return new Date(wallTime);
  };
}

async function startAdmissionLeaseKeeper(
  service: RemoteIngressControlService,
  intervalMs: number
): Promise<AdmissionLeaseKeeper> {
  requireCondition(
    Number.isSafeInteger(intervalMs) && intervalMs >= 1_000,
    "Physical admission lease interval was invalid."
  );
  const controller = new AbortController();
  let failed = false;
  let renewals = 0;

  const renew = async () => {
    const state = await service.readStatus();
    const admission = service.readAdmission();
    requireCondition(
      state.availability === "ready" &&
        admission.admission === "open" &&
        state.generation === admission.generation,
      "Physical admission lease renewal did not remain ready."
    );
    renewals += 1;
  };

  await renew();
  const completion = (async () => {
    while (!controller.signal.aborted) {
      await abortableDelay(intervalMs, controller.signal);
      if (controller.signal.aborted) return;
      await renew();
    }
  })().catch(() => {
    failed = true;
  });

  return Object.freeze({
    get failed() {
      return failed;
    },
    get renewals() {
      return renewals;
    },
    async stop() {
      controller.abort();
      await completion;
    }
  });
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });

    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

async function buildPhysicalBrowserBundle(): Promise<string> {
  const entry = fileURLToPath(
    new URL("../../../tests/browser/fixtures/physical-pairing-entry.ts", import.meta.url)
  );
  const result = await viteBuild({
    configFile: false,
    logLevel: "silent",
    build: {
      target: "es2022",
      minify: false,
      sourcemap: false,
      write: false,
      rollupOptions: {
        input: entry,
        output: { codeSplitting: false, format: "es" }
      }
    }
  });
  const candidates = (Array.isArray(result) ? result : [result]).flatMap(
    (output) => ("output" in output ? output.output : [])
  );
  const entries = candidates.filter(
    (output) => output.type === "chunk" && output.isEntry
  );
  requireCondition(
    entries.length === 1 &&
      entries[0]?.type === "chunk" &&
      entries[0].code.length > 0 &&
      Buffer.byteLength(entries[0].code, "utf8") <= physicalPageMaxBytes &&
      !/<\/script/iu.test(entries[0].code),
    "Physical pairing browser bundle is invalid."
  );
  return entries[0].code;
}

function physicalPageRoute(bundle: string): HostDeckRoutePluginRegistration {
  const nonce = randomBytes(18).toString("base64url");
  const html =
    "<!doctype html><html lang=\"en\"><head>" +
    "<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<title>HostDeck pairing acceptance</title></head>" +
    "<body><main><h1>HostDeck</h1><p id=\"status\">starting</p></main>" +
    `<script type="module" nonce="${nonce}">${bundle}</script></body></html>`;
  const registration: HostDeckRoutePluginRegistration = {
    id: "physical-fragment-pairing-page",
    surface: "static",
    register(app) {
      app.get("/", async (_request, reply) => {
        reply.headers({
          "cache-control": "no-store",
          "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
          "content-type": "text/html; charset=utf-8",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff"
        });
        return reply.send(html);
      });
    }
  };
  return Object.freeze(registration);
}

function physicalProtectedRoute(): HostDeckRoutePluginRegistration {
  const registration: HostDeckRoutePluginRegistration = {
    id: "physical-fragment-pairing-protected-read",
    surface: "api",
    register(app) {
      app.get(
        "/__physical/protected",
        {
          async preHandler(request) {
            requireHostDeckRequestAuthentication(request, "device_cookie");
          },
          schema: {
            response: { 200: selectedRequestAuthenticationContextSchema }
          }
        },
        async (request) => resolveHostDeckRequestAuthentication(request)
      );
    }
  };
  return Object.freeze(registration);
}

function installRequestInspection(
  app: HostDeckFastifyInstance,
  inspection: RequestInspection,
  secrets: ReturnType<typeof createSecretRegistry>
): void {
  app.addHook("onRequest", async (request) => {
    const referrer = request.headers.referer;
    const observed = `${request.url}\n${typeof referrer === "string" ? referrer : ""}`;
    if (secrets.values().some((secret) => observed.includes(secret))) {
      inspection.fragmentLeaks += 1;
    }
    if (request.url === "/api/v1/access/pairing-claims") {
      inspection.claimRequests += 1;
      if (referrer === undefined) inspection.noReferrerApiRequests += 1;
    }
    if (request.url === "/api/v1/access/csrf") {
      inspection.csrfRequests += 1;
      if (referrer === undefined) inspection.noReferrerApiRequests += 1;
    }
  });
  app.addHook("onResponse", async (request, reply) => {
    if (
      request.url === "/api/v1/access/pairing-claims" &&
      reply.statusCode >= 200 &&
      reply.statusCode < 300
    ) {
      const raw = reply.getHeader("set-cookie");
      const values = Array.isArray(raw) ? raw.map(String) : raw === undefined ? [] : [String(raw)];
      inspection.hardenedCookieObserved =
        values.length === 1 &&
        /;\s*Secure(?:;|$)/iu.test(values[0] ?? "") &&
        /;\s*HttpOnly(?:;|$)/iu.test(values[0] ?? "") &&
        /;\s*SameSite=Strict(?:;|$)/iu.test(values[0] ?? "") &&
        /;\s*Path=\/(?:;|$)/iu.test(values[0] ?? "") &&
        !/;\s*Domain=/iu.test(values[0] ?? "");
    }
  });
}

function requireDedicatedAbsentCandidate(
  snapshot: RemoteIngressObservationSnapshot
): Readonly<{ externalOrigin: string; expectedProfileKey: string }> {
  const expectedProfileKey = snapshot.profile.comparison.expected_profile_key;
  requireCondition(
    snapshot.client === "available" &&
      snapshot.failure === null &&
      snapshot.profile.state === "dedicated" &&
      snapshot.profile.comparison.relation === "match" &&
      typeof expectedProfileKey === "string" &&
      expectedProfileKey === snapshot.profile.comparison.active_profile_key &&
      typeof snapshot.external_origin === "string" &&
      snapshot.serve === "absent",
    "Physical pairing requires one clean active dedicated profile."
  );
  return Object.freeze({
    externalOrigin: snapshot.external_origin,
    expectedProfileKey
  });
}

function assertRemoteCliResult(
  result: Awaited<ReturnType<typeof runCli>>,
  expected: "disabled" | "ready"
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }
  requireCondition(
    result.exitCode === cliExitCodes.ok &&
      result.stderr === "" &&
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).availability === expected &&
      !Object.hasOwn(parsed as object, "external_origin"),
    "Physical pairing remote control returned invalid public state."
  );
}

function requireOpenAdmission(
  admission: Readonly<{
    admission: string;
    external_origin: string | null;
    generation: number;
  }>,
  origin: string
): void {
  requireCondition(
    admission.admission === "open" &&
      admission.external_origin === origin &&
      Number.isSafeInteger(admission.generation) &&
      admission.generation > 0,
    "Physical pairing did not establish selected remote admission."
  );
}

function requireClosedAdmission(admission: Readonly<{
  admission: string;
  external_origin: string | null;
  generation: number;
}>): void {
  requireCondition(
    admission.admission === "closed" && admission.external_origin === null,
    "Physical pairing did not close selected remote admission."
  );
}

async function assertTrustedPhysicalPage(origin: string): Promise<void> {
  const url = new URL("/", origin);
  const address = await resolveTailnetIpv4(url.hostname);
  const response = await new Promise<{
    readonly body: string;
    readonly status: number;
  }>((resolve, reject) => {
    const pending = httpsRequest(
      {
        agent: false,
        headers: { accept: "text/html", connection: "close", host: url.host },
        hostname: address,
        method: "GET",
        path: "/",
        port: 443,
        rejectUnauthorized: true,
        servername: url.hostname
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        incoming.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.byteLength;
          if (bytes > physicalPageMaxBytes) {
            incoming.destroy(new Error("Physical page response exceeded its limit."));
            return;
          }
          chunks.push(buffer);
        });
        incoming.on("end", () => {
          resolve({
            body: Buffer.concat(chunks, bytes).toString("utf8"),
            status: incoming.statusCode ?? 0
          });
        });
        incoming.on("error", () => reject(new Error("Physical HTTPS preflight failed.")));
      }
    );
    pending.setTimeout(10_000, () =>
      pending.destroy(new Error("Physical HTTPS preflight timed out."))
    );
    pending.on("error", () => reject(new Error("Physical HTTPS preflight failed.")));
    pending.end();
  });
  requireCondition(
    response.status === 200 &&
      response.body.includes("HostDeck pairing acceptance") &&
      response.body.includes("__hostDeckPhysicalPairing"),
    "Physical HTTPS page preflight was invalid."
  );
}

async function resolveTailnetIpv4(hostname: string): Promise<string> {
  const { Resolver } = await import("node:dns/promises");
  const resolver = new Resolver({ timeout: 2_000, tries: 2 });
  resolver.setServers([tailscaleDnsServer]);
  let addresses: readonly string[];
  try {
    addresses = await resolver.resolve4(hostname);
  } catch {
    throw new Error("Physical Tailnet DNS resolution failed.");
  }
  const selected = addresses.find(isTailnetIpv4);
  requireCondition(
    selected !== undefined && addresses.length <= 8,
    "Physical Tailnet DNS response was invalid."
  );
  return selected;
}

function isTailnetIpv4(value: string): boolean {
  const parts = value.split(".").map(Number);
  return (
    parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    parts[0] === 100 &&
    (parts[1] as number) >= 64 &&
    (parts[1] as number) <= 127
  );
}

async function startQrDisplay(dataUrl: string): Promise<QrDisplay> {
  requireCondition(
    /^data:image\/png;base64,[A-Za-z0-9+/=]+$/u.test(dataUrl) &&
      Buffer.byteLength(dataUrl, "utf8") <=
        defaultResourceBudget.cli_response_max_bytes * 4,
    "Physical QR image was invalid."
  );
  let html =
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<title>HostDeck private pairing QR</title>" +
    "<style>body{font-family:system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#fff;color:#111}main{text-align:center}img{width:min(70vw,560px);height:auto;image-rendering:pixelated}p{font-size:20px;max-width:34rem}</style>" +
    `</head><body><main><h1>HostDeck</h1><p id="status">Open Camera on the phone, scan this QR, and tap the private link.</p><img alt="Private HostDeck pairing QR" src="${dataUrl}"></main></body></html>`;
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff"
    });
    response.end(html);
  });
  await listen(server, 0);
  const address = server.address();
  requireCondition(
    address !== null && typeof address !== "string",
    "Physical QR display did not bind loopback."
  );
  return Object.freeze({
    server,
    url: `http://127.0.0.1:${(address as AddressInfo).port}/`,
    clear() {
      html = "<!doctype html><title>HostDeck QR consumed</title>";
    }
  });
}

function requireOneAuthorizedDevice(): void {
  const output = adb(["devices", "-l"]);
  const rows = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  requireCondition(
    rows.length === 2 &&
      rows[0] === "List of devices attached" &&
      /^\S+\s+device(?:\s|$)/u.test(rows[1] ?? ""),
    "Physical pairing requires exactly one authorized ADB device."
  );
}

function adb(args: readonly string[]): string {
  const serialized = args.join("\u0000");
  requireCondition(
    [...deviceForbiddenValues].every((value) => !serialized.includes(value)),
    "A protected pairing value was rejected before ADB dispatch."
  );
  adbCommandCount += 1;
  const output = execFileSync("adb", [...args], commandOptions());
  requireCondition(
    [...deviceForbiddenValues].every((value) => !output.includes(value)),
    "A protected pairing value was rejected in ADB output."
  );
  return output;
}

function openDefaultCamera(): void {
  const action = "android.media.action.STILL_IMAGE_CAMERA";
  const resolution = adb([
    "shell",
    "cmd",
    "package",
    "resolve-activity",
    "--brief",
    "-a",
    action
  ]);
  const component = resolution
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .findLast((line) => /^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/u.test(line));
  requireCondition(
    component !== undefined && component.length <= 256,
    "Physical pairing could not resolve one camera activity."
  );
  adb(["shell", "am", "start", "-n", component, "-a", action]);
}

function openChromeLauncher(): void {
  const resolution = adb([
    "shell",
    "cmd",
    "package",
    "resolve-activity",
    "--brief",
    "-a",
    "android.intent.action.MAIN",
    "-c",
    "android.intent.category.LAUNCHER",
    "-p",
    "com.android.chrome"
  ]);
  const component = resolution
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .findLast((line) => /^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/u.test(line));
  requireCondition(
    component !== undefined && component.length <= 256,
    "Physical pairing could not resolve Android Chrome."
  );
  adb([
    "shell",
    "am",
    "start",
    "-n",
    component,
    "-a",
    "android.intent.action.MAIN",
    "-c",
    "android.intent.category.LAUNCHER"
  ]);
}

function requireChromeRunning(): void {
  const processes = adb(["shell", "pidof", "com.android.chrome"]).trim();
  requireCondition(
    /^\d+(?:\s+\d+)*$/u.test(processes),
    "The scanned pairing link did not open in Android Chrome."
  );
}

async function closeExistingChromeOriginTabs(expectedOrigin: string): Promise<void> {
  let port: number | null = null;
  try {
    openChromeLauncher();
    await waitFor(
      () => {
        requireChromeRunning();
        return true;
      },
      10_000,
      "Android Chrome did not start for targeted tab cleanup."
    );
    port = createChromeForward();
    const initial = await waitForChromeEndpoint(port, 10_000);
    const matching = initial.targets.filter(
      (target) => safeUrlOrigin(target.url) === expectedOrigin
    );
    requireCondition(
      matching.length <= 16 &&
        matching.every((target) => /^[A-Fa-f0-9]{1,64}$/u.test(target.id)),
      "Existing HostDeck Chrome targets exceeded the cleanup boundary."
    );
    for (const target of matching) {
      const response = await fetch(
        `http://127.0.0.1:${port}/json/close/${encodeURIComponent(target.id)}`,
        { signal: AbortSignal.timeout(2_000) }
      );
      requireCondition(response.ok, "Existing HostDeck Chrome target did not close.");
      await response.body?.cancel();
    }
    await waitFor(
      async () => {
        const current = await readChromeTargets(port as number);
        return (
          current.endpointAvailable &&
          current.targets.every(
            (target) => safeUrlOrigin(target.url) !== expectedOrigin
          )
        );
      },
      10_000,
      "Existing HostDeck Chrome targets remained after cleanup."
    );
  } finally {
    if (port !== null) {
      try {
        adb(["forward", "--remove", `tcp:${port}`]);
      } catch {
        // Continue with the targeted Chrome process cleanup.
      }
    }
    adb(["shell", "am", "force-stop", "com.android.chrome"]);
  }
}

async function waitForChromeEndpoint(
  port: number,
  timeoutMs: number
): Promise<ChromeTargetSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await readChromeTargets(port);
    if (snapshot.endpointAvailable) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Android Chrome DevTools endpoint was unavailable.");
}

function safeUrlOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function createChromeForward(): number {
  const port = Number(
    adb(["forward", "tcp:0", "localabstract:chrome_devtools_remote"]).trim()
  );
  requireCondition(
    Number.isInteger(port) && port >= 1 && port <= 65_535,
    "ADB returned an invalid Chrome DevTools forward."
  );
  return port;
}

async function waitForChromeTarget(
  port: number,
  expectedOrigin: string,
  timeoutMs: number
): Promise<ChromeTarget> {
  let selected: ChromeTarget | undefined;
  let endpointObserved = false;
  let pageTargetsObserved = 0;
  let expectedOriginTargetsObserved = 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && selected === undefined) {
    const snapshot = await readChromeTargets(port);
    endpointObserved ||= snapshot.endpointAvailable;
    pageTargetsObserved = Math.max(
      pageTargetsObserved,
      snapshot.targets.filter((target) => target.type === "page").length
    );
    const matching = snapshot.targets.filter((target) => {
      try {
        return new URL(target.url).origin === expectedOrigin;
      } catch {
        return false;
      }
    });
    expectedOriginTargetsObserved = Math.max(
      expectedOriginTargetsObserved,
      matching.length
    );
    requireCondition(
      matching.every((target) => {
        const url = new URL(target.url);
        return url.hash === "" && url.search === "" && url.pathname === "/";
      }),
      "Physical Chrome retained a pairing fragment after claim."
    );
    selected = matching.find((target) => target.type === "page");
    if (selected === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  requireCondition(
    selected !== undefined,
    `Physical Chrome target was unavailable after pairing (endpoint=${endpointObserved};pages=${pageTargetsObserved};origin=${expectedOriginTargetsObserved}).`
  );
  return selected;
}

async function readChromeTargets(port: number): Promise<ChromeTargetSnapshot> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(2_000)
    });
  } catch {
    return Object.freeze({ endpointAvailable: false, targets: [] });
  }
  if (!response.ok) {
    return Object.freeze({ endpointAvailable: false, targets: [] });
  }
  const body = await response.text();
  requireCondition(
    Buffer.byteLength(body, "utf8") <= 256 * 1024 &&
      [...deviceForbiddenValues].every((value) => !body.includes(value)),
    "Chrome DevTools target metadata retained a protected pairing value."
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new Error("Chrome DevTools target metadata was invalid JSON.");
  }
  requireCondition(Array.isArray(parsed), "Chrome DevTools target metadata was invalid.");
  const targets = parsed.map((candidate): ChromeTarget => {
    requireCondition(
      candidate !== null &&
        typeof candidate === "object" &&
        typeof candidate.id === "string" &&
        typeof candidate.title === "string" &&
        typeof candidate.type === "string" &&
        typeof candidate.url === "string" &&
        typeof candidate.webSocketDebuggerUrl === "string",
      "Chrome DevTools returned a malformed target."
    );
    return candidate as ChromeTarget;
  });
  return Object.freeze({ endpointAvailable: true, targets: Object.freeze(targets) });
}

class CdpClient {
  readonly #pending = new Map<
    number,
    {
      readonly reject: (error: Error) => void;
      readonly resolve: (value: unknown) => void;
      readonly timeout: NodeJS.Timeout;
    }
  >();
  readonly #socket: WebSocket;
  readonly #forbidden: ReadonlySet<string>;
  #nextId = 0;

  private constructor(socket: WebSocket, forbidden: ReadonlySet<string>) {
    this.#socket = socket;
    this.#forbidden = forbidden;
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let message: CdpMessage;
      try {
        message = JSON.parse(event.data) as CdpMessage;
      } catch {
        return;
      }
      if (typeof message.id !== "number") return;
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error !== undefined) {
        pending.reject(new Error("Chrome DevTools command failed."));
      } else {
        pending.resolve(message.result);
      }
    });
    socket.addEventListener("close", () => {
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Chrome DevTools connection closed."));
      }
      this.#pending.clear();
    });
  }

  static async connect(
    url: string,
    forbidden: ReadonlySet<string>
  ): Promise<CdpClient> {
    requireCondition(
      [...forbidden].every((value) => !url.includes(value)),
      "Chrome DevTools endpoint retained a protected pairing value."
    );
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Chrome DevTools connection timed out.")),
        5_000
      );
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true }
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          reject(new Error("Chrome DevTools connection failed."));
        },
        { once: true }
      );
    });
    return new CdpClient(socket, forbidden);
  }

  send(
    method: string,
    params: Readonly<Record<string, unknown>> = {}
  ): Promise<unknown> {
    const serialized = JSON.stringify({ method, params });
    requireCondition(
      [...this.#forbidden].every((value) => !serialized.includes(value)),
      "A protected pairing value was rejected before CDP dispatch."
    );
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("Chrome DevTools command timed out."));
      }, 10_000);
      this.#pending.set(id, { reject, resolve, timeout });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const response = (await this.send("Runtime.evaluate", {
      awaitPromise: true,
      expression,
      returnByValue: true
    })) as {
      readonly exceptionDetails?: unknown;
      readonly result?: { readonly value?: unknown };
    };
    if (response.exceptionDetails !== undefined || response.result === undefined) {
      throw new Error("Chrome evaluation failed.");
    }
    return response.result.value as T;
  }

  close(): void {
    if (this.#socket.readyState < WebSocket.CLOSING) this.#socket.close();
  }
}

function readPhoneSnapshot(cdp: CdpClient): Promise<PhoneSnapshot> {
  return cdp.evaluate(`(async()=>{
    const summary=window.__hostDeckPhysicalPairing??{};
    return {
      cacheCount:(await caches.keys()).length,
      cookieLength:document.cookie.length,
      csrfGeneration:Number.isSafeInteger(summary.csrf_generation)?summary.csrf_generation:null,
      domHasPairFragment:document.body.innerText.includes('#pair='),
      hash:location.hash,
      indexedDbCount:(await indexedDB.databases()).length,
      localStorageCount:localStorage.length,
      pathname:location.pathname,
      permission:typeof summary.permission==='string'?summary.permission:null,
      referrerHasPairFragment:document.referrer.includes('#pair='),
      resourceHasPairFragment:performance.getEntriesByType('resource').some((entry)=>entry.name.includes('#pair=')),
      search:location.search,
      serviceWorkerCount:(await navigator.serviceWorker.getRegistrations()).length,
      sessionStorageCount:sessionStorage.length,
      state:typeof summary.state==='string'?summary.state:'missing',
      summaryKeys:Object.keys(summary).sort()
    };
  })()`);
}

function assertPairedPhoneSnapshot(snapshot: PhoneSnapshot): void {
  requireCondition(
    snapshot.state === "paired" &&
      snapshot.permission === "write" &&
      Number.isSafeInteger(snapshot.csrfGeneration) &&
      (snapshot.csrfGeneration as number) > 0 &&
      snapshot.hash === "" &&
      snapshot.pathname === "/" &&
      snapshot.search === "" &&
      snapshot.cookieLength === 0 &&
      snapshot.localStorageCount === 0 &&
      snapshot.sessionStorageCount === 0 &&
      snapshot.indexedDbCount === 0 &&
      snapshot.cacheCount === 0 &&
      snapshot.serviceWorkerCount === 0 &&
      !snapshot.domHasPairFragment &&
      !snapshot.referrerHasPairFragment &&
      !snapshot.resourceHasPairFragment &&
      snapshot.summaryKeys.join(",") === "csrf_generation,permission,state",
    "Physical paired Chrome state violated the fragment/privacy contract."
  );
}

function assertReloadedPhoneSnapshot(snapshot: PhoneSnapshot): void {
  requireCondition(
    snapshot.state === "no_fragment" &&
      snapshot.permission === null &&
      snapshot.csrfGeneration === null &&
      snapshot.hash === "" &&
      snapshot.search === "" &&
      snapshot.cookieLength === 0 &&
      snapshot.localStorageCount === 0 &&
      snapshot.sessionStorageCount === 0 &&
      snapshot.indexedDbCount === 0 &&
      snapshot.cacheCount === 0 &&
      snapshot.serviceWorkerCount === 0 &&
      !snapshot.domHasPairFragment &&
      !snapshot.referrerHasPairFragment &&
      !snapshot.resourceHasPairFragment,
    "Physical Chrome reload violated the no-fragment contract."
  );
}

function assertPairingRuntimeTruth(
  db: ReturnType<typeof openMigratedDatabase>["db"],
  inspection: RequestInspection
): void {
  const devices = countRows(db, "auth_devices");
  const usedCodes = countMatchingRows(db, "pairing_codes", "used_at IS NOT NULL");
  requireCondition(
    devices === 1 &&
      usedCodes === 1 &&
      inspection.claimRequests === 1 &&
      inspection.csrfRequests === 1 &&
      inspection.noReferrerApiRequests === 2 &&
      inspection.fragmentLeaks === 0 &&
      inspection.hardenedCookieObserved,
    "Physical pairing runtime truth was inconsistent " +
      `(devices=${devices};used=${usedCodes};claims=${inspection.claimRequests};` +
      `csrf=${inspection.csrfRequests};no_referrer=${inspection.noReferrerApiRequests};` +
      `fragment_leaks=${inspection.fragmentLeaks};cookie=${inspection.hardenedCookieObserved}).`
  );
}

function firstProxyRejection(app: HostDeckFastifyInstance): string | null {
  const snapshot = tailscaleServeProxyTrustSnapshot(app);
  for (const reason of remoteProxyTrustRejectionReasons) {
    if (snapshot.rejected_requests[reason] > 0) return reason;
  }
  return null;
}

function assertPairingAudit(
  db: ReturnType<typeof openMigratedDatabase>["db"]
): void {
  const rows = db
    .prepare(
      "SELECT action, phase, outcome, COUNT(*) AS count " +
        "FROM selected_audit_events " +
        "WHERE action IN ('pair_request','pair_claim','csrf_bootstrap') " +
        "GROUP BY action, phase, outcome ORDER BY action, phase, outcome"
    )
    .all();
  requireCondition(
    JSON.stringify(rows) ===
      JSON.stringify([
        { action: "csrf_bootstrap", phase: "accepted", outcome: "accepted", count: 1 },
        { action: "csrf_bootstrap", phase: "terminal", outcome: "succeeded", count: 1 },
        { action: "pair_claim", phase: "accepted", outcome: "accepted", count: 1 },
        { action: "pair_claim", phase: "terminal", outcome: "succeeded", count: 1 },
        { action: "pair_request", phase: "accepted", outcome: "accepted", count: 1 },
        { action: "pair_request", phase: "terminal", outcome: "succeeded", count: 1 }
      ]),
    "Physical pairing audit trail was invalid."
  );
}

function assertSecretsAbsentFromDatabase(
  dbPath: string,
  secrets: readonly string[]
): void {
  const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter(existsSync);
  requireCondition(files.length >= 1 && secrets.length >= 4, "Physical privacy scan had no inputs.");
  for (const file of files) {
    const bytes = readFileSync(file);
    requireCondition(
      secrets.every((secret) => !bytes.includes(Buffer.from(secret, "utf8"))),
      "Physical SQLite files retained a raw pairing secret."
    );
  }
}

function countRows(
  db: ReturnType<typeof openMigratedDatabase>["db"],
  table: "auth_devices"
): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
    .count;
}

function countMatchingRows(
  db: ReturnType<typeof openMigratedDatabase>["db"],
  table: "pairing_codes",
  predicate: "used_at IS NOT NULL"
): number {
  return (
    db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${predicate}`).get() as {
      count: number;
    }
  ).count;
}

async function requireConfiguredServeAbsent(
  observer: TailscaleObserver,
  profileKey: string,
  serve: RemoteServeDescriptor
): Promise<void> {
  const snapshot = await observer.observeConfigured({
    expected_profile_key: profileKey,
    expected_serve: serve
  });
  requireCondition(
    snapshot.client === "available" &&
      snapshot.failure === null &&
      snapshot.profile.state === "dedicated" &&
      snapshot.profile.comparison.relation === "match" &&
      snapshot.serve === "absent",
    "Physical pairing cleanup did not prove absent Serve state."
  );
}

async function proveOrRestoreAbsent(
  observer: TailscaleObserver,
  manager: TailscaleServeManager,
  fallback: CleanupTarget
): Promise<void> {
  const current = await observer.observeConfigured({
    expected_profile_key: fallback.expectedProfileKey,
    expected_serve: fallback.expectedServe
  });
  requireCondition(
    current.client === "available" &&
      current.failure === null &&
      current.profile.state === "dedicated" &&
      current.profile.comparison.relation === "match" &&
      (current.serve === "absent" || current.serve === "exact"),
    "Physical pairing cannot prove ownership-safe Serve cleanup."
  );
  if (current.serve === "absent") return;
  const removed = await manager.disable({
    expected_profile_key: fallback.expectedProfileKey,
    expected_serve: fallback.expectedServe
  });
  requireCondition(
    removed.outcome === "succeeded" &&
      removed.after !== null &&
      removed.after.serve === "absent" &&
      removed.after.failure === null,
    "Physical pairing failed to remove its owned Serve state."
  );
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await listen(server, 0);
  const address = server.address();
  requireCondition(
    address !== null && typeof address !== "string",
    "Physical pairing could not reserve a loopback port."
  );
  const port = (address as AddressInfo).port;
  await closeServer(server);
  return port;
}

function listen(server: HttpServer, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: HttpServer): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  message: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch {
      // Browser navigation can transiently replace the execution context.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(message);
}

function commandOptions(): Readonly<{
  encoding: "utf8";
  env: NodeJS.ProcessEnv;
  maxBuffer: number;
  timeout: number;
}> {
  return {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    maxBuffer: 512 * 1024,
    timeout: 15_000
  };
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
