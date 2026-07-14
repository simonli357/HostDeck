import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultResourceBudget,
  type SelectedRequestAuthenticationContext
} from "@hostdeck/contracts";
import {
  createHistoricalSelectedNetworkAuditRepository,
  createHostDeckLanConfigurationRepository,
  createSettingsRepository,
  HostDeckSelectedAuditRepositoryError,
  openMigratedDatabase,
  type SelectedAuditRepository
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import { createHostDeckFastifyApp } from "./fastify-app.js";
import {
  createHostDeckRequestAuthenticationPolicy,
  hostDeckDeviceCookieName
} from "./fastify-request-authentication.js";
import { createHostDeckRequestTrustPolicy } from "./fastify-request-trust.js";
import {
  createHostDeckLanCertificatePolicy
} from "./lan-certificate-policy.js";
import {
  createHostDeckLanNetworkRouteRegistration,
  hostDeckLanNetworkRouteRegistrationId
} from "./lan-network-routes.js";
import {
  assertHostDeckLanNetworkService,
  createHostDeckLanNetworkService
} from "./lan-network-service.js";
import { createSecurityMutationAuditExecutor } from "./security-mutation-audit-executor.js";

const tempDirectories: string[] = [];
const databases: Array<{ close: () => unknown }> = [];
const origin = "http://localhost";
const rawDeviceToken = "D".repeat(43);
const createdAt = "2026-07-12T20:00:00.000Z";
const configuredAt = "2026-07-12T20:05:00.000Z";

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("selected LAN network route boundary", () => {
  it("configures, enables, reads, and disables through one audited local-admin boundary", async () => {
    const harness = fixture();
    const before = await harness.app.inject({ method: "GET", url: "/api/v1/network" });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({
      active_network_mode: "loopback",
      desired_mode: "loopback",
      configured: false,
      certificate_state: "not_configured",
      can_manage_lan: false,
      restart_required: false
    });

    const configured = await harness.app.inject({
      method: "POST",
      url: "/api/v1/network/configure",
      payload: configureRequest("op_lan_configure_01", "issue_leaf")
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.headers["cache-control"]).toBe("no-store");
    expect(configured.headers.pragma).toBe("no-cache");
    expect(configured.headers["access-control-allow-origin"]).toBeUndefined();
    expect(configured.json()).toMatchObject({
      desired_mode: "loopback",
      configured: true,
      bind_host: "192.168.0.29",
      configured_origin: "https://192.168.0.29:3777",
      certificate_state: "valid",
      configuration_changed: true,
      desired_mode_changed: false,
      restart_required: false
    });
    expect(harness.settings.require()).toMatchObject({
      bind_mode: "localhost",
      bind_host: "127.0.0.1",
      lan_enabled: false
    });
    expect(harness.auditRepository.require("op_lan_configure_01").records).toMatchObject([
      { phase: "accepted", action: "lan_configure", outcome: "accepted" },
      { phase: "terminal", action: "lan_configure", outcome: "succeeded" }
    ]);

    const enabled = await harness.app.inject({
      method: "POST",
      url: "/api/v1/network/enable",
      payload: mutationRequest("op_lan_enable_01")
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({
      active_network_mode: "loopback",
      desired_mode: "lan",
      lan_enabled: true,
      configuration_changed: false,
      desired_mode_changed: true,
      restart_required: true
    });
    expect(harness.settings.require()).toMatchObject({
      bind_mode: "lan",
      bind_host: "192.168.0.29",
      lan_enabled: true
    });

    const readEnabled = await harness.app.inject({ method: "GET", url: "/api/v1/network" });
    expect(readEnabled.statusCode).toBe(200);
    expect(readEnabled.json()).toMatchObject({ desired_mode: "lan", restart_required: true });

    const disabled = await harness.app.inject({
      method: "POST",
      url: "/api/v1/network/disable",
      payload: mutationRequest("op_lan_disable_01")
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({
      desired_mode: "loopback",
      lan_enabled: false,
      configured: true,
      configuration_changed: false,
      desired_mode_changed: true,
      restart_required: false
    });
    expect(harness.settings.require()).toMatchObject({
      bind_mode: "localhost",
      bind_host: "127.0.0.1",
      lan_enabled: false
    });
    expect(harness.service.snapshot()).toMatchObject({
      configurations: 1,
      enables: 1,
      disables: 1,
      storage_failures: 0,
      audit_failures: 0
    });
    const privateSecrets = [
      rawDeviceToken,
      readFileSync(
        join(harness.certificateDirectory, "hostdeck-local-ca-key.pem"),
        "utf8"
      ),
      readFileSync(
        join(harness.certificateDirectory, "hostdeck-lan-key.pem"),
        "utf8"
      )
    ];
    expect(configured.body).not.toMatch(/PRIVATE KEY|BEGIN CERTIFICATE/iu);
    expect(JSON.stringify(harness.service.snapshot())).not.toMatch(
      /192\.168|fingerprint|PRIVATE KEY/iu
    );
    assertSecretsAbsentFromSqlite(harness.databasePath, privateSecrets);
  });

  it("validates bodies before authentication side effects or durable work", async () => {
    const harness = fixture({ paired: true });
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/network/configure",
      headers: pairedHeaders(),
      payload: {
        ...configureRequest("op_lan_invalid_01", "issue_leaf"),
        confirmed: false
      }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "validation_error" } });
    expect(harness.authenticationCalls()).toBe(0);
    expect(harness.network.read().configuration).toBeNull();
    expect(harness.auditRepository.get("op_lan_invalid_01")).toBeNull();
    expect(readdirSync(harness.certificateDirectory)).toEqual([]);
  });

  it("allows paired reads but rejects every paired/browser LAN mutation before audit and certificate work", async () => {
    const harness = fixture({ paired: true });
    const read = await harness.app.inject({
      method: "GET",
      url: "/api/v1/network",
      headers: { cookie: `${hostDeckDeviceCookieName}=${rawDeviceToken}` }
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ can_manage_lan: false, configured: false });

    for (const [url, payload, operationId] of [
      [
        "/api/v1/network/configure",
        configureRequest("op_lan_paired_01", "issue_leaf"),
        "op_lan_paired_01"
      ],
      [
        "/api/v1/network/enable",
        mutationRequest("op_lan_paired_02"),
        "op_lan_paired_02"
      ],
      [
        "/api/v1/network/disable",
        mutationRequest("op_lan_paired_03"),
        "op_lan_paired_03"
      ]
    ] as const) {
      const response = await harness.app.inject({
        method: "POST",
        url,
        headers: pairedHeaders(),
        payload
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "permission_denied" } });
      expect(harness.auditRepository.get(operationId)).toBeNull();
    }
    expect(harness.network.read().configuration).toBeNull();
    expect(readdirSync(harness.certificateDirectory)).toEqual([]);
  });

  it("rejects unsupported and unassigned configure identities before audit or files", async () => {
    const harness = fixture();
    for (const [index, bindHost] of [
      "0.0.0.0",
      "127.0.0.1",
      "8.8.8.8",
      "192.168.0.30"
    ].entries()) {
      const operationId = `op_lan_bad_host_0${index}`;
      const response = await harness.app.inject({
        method: "POST",
        url: "/api/v1/network/configure",
        payload: { ...configureRequest(operationId, "issue_leaf"), bind_host: bindHost }
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "validation_error" } });
      expect(harness.auditRepository.get(operationId)).toBeNull();
    }
    expect(readdirSync(harness.certificateDirectory)).toEqual([]);
  });

  it("keeps duplicate operation ids and repeated desired state deterministic", async () => {
    const harness = fixture();
    const request = configureRequest("op_lan_duplicate_01", "issue_leaf");
    const first = await harness.app.inject({
      method: "POST",
      url: "/api/v1/network/configure",
      payload: request
    });
    expect(first.statusCode).toBe(200);
    const hashes = certificateHashes(harness.certificateDirectory);
    const second = await harness.app.inject({
      method: "POST",
      url: "/api/v1/network/configure",
      payload: request
    });
    expect(second.statusCode).toBe(409);
    expect(certificateHashes(harness.certificateDirectory)).toEqual(hashes);
    expect(harness.auditRepository.require(request.operation_id).records).toHaveLength(2);

    const enableFirst = await harness.app.inject({
      method: "POST",
      url: "/api/v1/network/enable",
      payload: mutationRequest("op_lan_enable_once_01")
    });
    const enabledAt = harness.settings.require().updated_at;
    const enableNoOp = await harness.app.inject({
      method: "POST",
      url: "/api/v1/network/enable",
      payload: mutationRequest("op_lan_enable_noop_01")
    });
    expect(enableFirst.json()).toMatchObject({ desired_mode_changed: true });
    expect(enableNoOp.json()).toMatchObject({ desired_mode_changed: false });
    expect(harness.settings.require().updated_at).toBe(enabledAt);
  });

  it("records certificate reuse failure as accepted plus failed without durable configuration", async () => {
    const harness = fixture();
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/network/configure",
      payload: configureRequest("op_lan_reuse_missing_01", "reuse")
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "invalid_config" } });
    expect(harness.network.read().configuration).toBeNull();
    expect(harness.auditRepository.require("op_lan_reuse_missing_01").records).toMatchObject([
      { phase: "accepted", outcome: "accepted" },
      { phase: "terminal", outcome: "failed", error_code: "invalid_config" }
    ]);
  });

  it("re-inspects certificate ownership after accepted audit and refuses a replacement race", async () => {
    const harness = fixture();
    const configured = await harness.app.inject({
      method: "POST",
      url: "/api/v1/network/configure",
      payload: configureRequest("op_lan_race_configure_01", "issue_leaf")
    });
    expect(configured.statusCode).toBe(200);
    harness.afterAccepted(() => {
      writeFileSync(
        join(harness.certificateDirectory, "hostdeck-lan-key.pem"),
        readFileSync(
          join(harness.certificateDirectory, "hostdeck-local-ca-key.pem")
        ),
        { mode: 0o600 }
      );
    });

    const enabled = await harness.app.inject({
      method: "POST",
      url: "/api/v1/network/enable",
      payload: mutationRequest("op_lan_certificate_race_01")
    });
    expect(enabled.statusCode).toBe(409);
    expect(enabled.json()).toMatchObject({ error: { code: "invalid_config" } });
    expect(harness.settings.require().lan_enabled).toBe(false);
    expect(harness.auditRepository.require("op_lan_certificate_race_01").records).toMatchObject([
      { phase: "accepted", outcome: "accepted" },
      { phase: "terminal", outcome: "failed", error_code: "invalid_config" }
    ]);
  });

  it("preserves durable certificate/configuration truth when terminal audit or response send fails", async () => {
    const terminalFailure = fixture({ failTerminalAudit: true });
    const terminalResponse = await terminalFailure.app.inject({
      method: "POST",
      url: "/api/v1/network/configure",
      payload: configureRequest("op_lan_terminal_fail_01", "issue_leaf")
    });
    expect(terminalResponse.statusCode).toBe(503);
    expect(terminalFailure.network.read().configuration).toMatchObject({
      bind_host: "192.168.0.29"
    });
    expect(terminalFailure.auditRepository.require("op_lan_terminal_fail_01").records).toHaveLength(1);

    const sendFailure = fixture({ failOnSend: true });
    const sendResponse = await sendFailure.app.inject({
      method: "POST",
      url: "/api/v1/network/configure",
      payload: configureRequest("op_lan_send_fail_01", "issue_leaf")
    });
    expect(sendResponse.statusCode).toBe(500);
    expect(sendFailure.network.read().configuration).toMatchObject({
      bind_host: "192.168.0.29"
    });
    expect(sendFailure.auditRepository.require("op_lan_send_fail_01").records).toMatchObject([
      { phase: "accepted", outcome: "accepted" },
      { phase: "terminal", outcome: "succeeded" }
    ]);
  });

  it("brands one service and one route registration and rejects forged or duplicate ownership", () => {
    const harness = fixture({ register: false });
    assertHostDeckLanNetworkService(harness.service);
    expect(() => assertHostDeckLanNetworkService({ ...harness.service })).toThrow(TypeError);
    const registration = createHostDeckLanNetworkRouteRegistration({
      service: harness.service
    });
    expect(registration.id).toBe(hostDeckLanNetworkRouteRegistrationId);
    expect(Object.isFrozen(registration)).toBe(true);
    expect(() =>
      createHostDeckLanNetworkRouteRegistration({ service: harness.service })
    ).toThrow("already owns");
  });

  it("rejects unpaired LAN read state at the headless authority boundary", () => {
    const harness = fixture({ register: false });
    expect(() => harness.service.read(unpairedLanContext())).toThrowError(
      expect.objectContaining({ code: "permission_denied" })
    );
  });
});

interface FixtureOptions {
  readonly failOnSend?: boolean;
  readonly failTerminalAudit?: boolean;
  readonly paired?: boolean;
  readonly register?: boolean;
}

function fixture(options: FixtureOptions = {}) {
  const directory = tempDirectory("hostdeck-lan-route-");
  const certificateDirectory = join(directory, "certificates");
  const stateDirectory = join(directory, "state");
  const databasePath = join(directory, "hostdeck.sqlite");
  mkdirSync(certificateDirectory, { mode: 0o700 });
  mkdirSync(stateDirectory, { mode: 0o700 });
  const open = openMigratedDatabase(databasePath, {
    now: () => new Date(createdAt)
  });
  databases.push(open.db);
  const settings = createSettingsRepository(open.db);
  settings.getOrCreateDefault({
    stateDir: stateDirectory,
    now: () => new Date(createdAt)
  });
  const network = createHostDeckLanConfigurationRepository(open.db);
  const certificates = createHostDeckLanCertificatePolicy({
    assignedAddresses: () => ["192.168.0.29"],
    certificateDirectory,
    now: () => new Date(configuredAt)
  });
  const auditRepository = createHistoricalSelectedNetworkAuditRepository(open.db);
  let afterAccepted: (() => void) | null = null;
  const auditPort: SelectedAuditRepository = {
    ...auditRepository,
    recordAccepted(record) {
      const trail = auditRepository.recordAccepted(record);
      const callback = afterAccepted;
      afterAccepted = null;
      callback?.();
      return trail;
    },
    ...(options.failTerminalAudit
      ? {
          recordTerminal() {
          throw new HostDeckSelectedAuditRepositoryError(
            "audit_write_failed",
            "Terminal audit unavailable."
          );
          }
        }
      : {})
  };
  let auditIndex = 0;
  const audit = createSecurityMutationAuditExecutor({
    repository: auditPort,
    now: () =>
      new Date(Date.parse(configuredAt) + ++auditIndex * 1000).toISOString(),
    create_record_id: () => `audit:lan-route:${auditIndex}`
  });
  const service = createHostDeckLanNetworkService({
    audit,
    certificates,
    network,
    now: () => new Date(Date.parse(configuredAt) + 60_000)
  });
  let authenticationCalls = 0;
  const authentication = createHostDeckRequestAuthenticationPolicy({
    authenticateDeviceToken: ({ rawDeviceToken: candidate }) => {
      authenticationCalls += 1;
      if (options.paired && candidate === rawDeviceToken) {
        return frozenAuthentication();
      }
      throw new Error("Device unavailable.");
    },
    now: () => new Date(configuredAt)
  });
  const registration =
    options.register === false
      ? null
      : createHostDeckLanNetworkRouteRegistration({ service });
  const app = createHostDeckFastifyApp({
    observeInternalError: () => undefined,
    requestAuthenticationPolicy: authentication,
    requestTrustPolicy: createHostDeckRequestTrustPolicy({
      allowedOrigins: [origin],
      mode: "loopback",
      transport: "http"
    }),
    resourceBudget: defaultResourceBudget,
    routePlugins: registration === null ? [] : [registration]
  });
  if (options.failOnSend) {
    app.addHook("onSend", async (request, reply, payload) => {
      if (
        request.url === "/api/v1/network/configure" &&
        reply.statusCode >= 200 &&
        reply.statusCode < 300
      ) {
        throw new Error("private LAN response send failure");
      }
      return payload;
    });
  }
  return {
    app,
    afterAccepted(callback: () => void) {
      afterAccepted = callback;
    },
    auditRepository,
    authenticationCalls: () => authenticationCalls,
    certificateDirectory,
    databasePath,
    certificates,
    network,
    registration,
    service,
    settings
  };
}

function configureRequest(
  operationId: string,
  certificateAction: "reuse" | "issue_leaf"
) {
  return {
    operation_id: operationId,
    confirmed: true,
    bind_host: "192.168.0.29",
    bind_port: 3777,
    certificate_action: certificateAction
  } as const;
}

function mutationRequest(operationId: string) {
  return { operation_id: operationId, confirmed: true } as const;
}

function pairedHeaders() {
  return {
    origin,
    cookie: `${hostDeckDeviceCookieName}=${rawDeviceToken}`
  };
}

function frozenAuthentication() {
  return Object.freeze({
    trusted: true as const,
    readOnly: false,
    device: Object.freeze({
      id: "client_phone",
      token_hash: `sha256:${"a".repeat(64)}`,
      csrf_token_hash: `sha256:${"b".repeat(64)}`,
      csrf_generation: 1,
      csrf_rotated_at: createdAt,
      client_label: "Phone",
      permission: "write" as const,
      created_at: createdAt,
      last_used_at: configuredAt,
      expires_at: null,
      revoked_at: null
    })
  });
}

function unpairedLanContext(): SelectedRequestAuthenticationContext {
  return {
    state: "unpaired",
    configured_origin: "https://192.168.0.29:3777",
    network_mode: "lan",
    origin_kind: "safe_no_origin",
    transport: "https",
    device_id: null,
    permission: null,
    csrf_generation: null,
    last_used_at: null,
    expires_at: null
  };
}

function certificateHashes(directory: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(directory).map((file) => [
      file,
      createHash("sha256").update(readFileSync(join(directory, file))).digest("hex")
    ])
  );
}

function assertSecretsAbsentFromSqlite(
  databasePath: string,
  secrets: readonly string[]
): void {
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    for (const secret of secrets) {
      expect(bytes.includes(Buffer.from(secret, "utf8"))).toBe(false);
    }
  }
}

function tempDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(directory, 0o700);
  tempDirectories.push(directory);
  return directory;
}
