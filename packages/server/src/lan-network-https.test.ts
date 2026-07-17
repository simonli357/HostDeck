import { X509Certificate as NodeX509Certificate } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { get as httpGet } from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultResourceBudget,
  type SelectedRequestAuthenticationContext,
  selectedLanConfigureRequestSchema,
  selectedLanDisableRequestSchema,
  selectedLanEnableRequestSchema
} from "@hostdeck/contracts";
import {
  createHistoricalSelectedNetworkAuditRepository,
  createHostDeckLanConfigurationRepository,
  createSettingsRepository,
  openMigratedDatabase
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import { startHostDeckFastifyLifecycle } from "./fastify-host-lifecycle.js";
import {
  createHostDeckRequestAuthenticationPolicy,
  hostDeckDeviceCookieName
} from "./fastify-request-authentication.js";
import { createHostDeckLanCertificatePolicy } from "./lan-certificate-policy.js";
import { createHostDeckLanNetworkRouteRegistration } from "./lan-network-routes.js";
import { createHostDeckLanNetworkService } from "./lan-network-service.js";
import { createSecurityMutationAuditExecutor } from "./security-mutation-audit-executor.js";

const tempDirectories: string[] = [];
const databases: Array<{ close: () => unknown }> = [];
const rawDeviceToken = "D".repeat(43);
const now = "2026-07-12T20:00:00.000Z";

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("historical LAN network real HTTPS restart", () => {
  it("moves loopback -> paired LAN HTTPS -> local-admin disable -> loopback without remote mutation", async () => {
    const host = requirePrivateIpv4();
    const port = await reservePort(host);
    const root = tempDirectory("hostdeck-lan-network-https-");
    const certificateDirectory = tempDirectory("hostdeck-lan-network-certs-");
    const stateDirectory = tempDirectory("hostdeck-lan-network-state-");
    const open = openMigratedDatabase(join(root, "hostdeck.sqlite"), {
      now: fixedNow
    });
    databases.push(open.db);
    const settings = createSettingsRepository(open.db);
    settings.getOrCreateDefault({
      stateDir: stateDirectory,
      bindPort: port,
      now: fixedNow
    });
    const network = createHostDeckLanConfigurationRepository(open.db);
    const certificates = createHostDeckLanCertificatePolicy({
      assignedAddresses: () => [host],
      certificateDirectory,
      now: fixedNow
    });
    const auditRepository = createHistoricalSelectedNetworkAuditRepository(open.db);
    let auditIndex = 0;
    const audit = createSecurityMutationAuditExecutor({
      repository: auditRepository,
      now: () => new Date(Date.parse(now) + ++auditIndex * 1000).toISOString(),
      create_record_id: () => `audit:lan-https:${auditIndex}`
    });
    const service = createHostDeckLanNetworkService({
      audit,
      certificates,
      network,
      now: () => new Date(Date.parse(now) + 60_000)
    });
    await service.configure(loopbackAdmin(port), selectedLanConfigureRequestSchema.parse({
      operation_id: "op_lan_https_configure_01",
      confirmed: true,
      bind_host: host,
      bind_port: port,
      certificate_action: "issue_leaf"
    }));
    const pending = await service.enable(loopbackAdmin(port), selectedLanEnableRequestSchema.parse({
      operation_id: "op_lan_https_enable_01",
      confirmed: true
    }));
    expect(pending).toMatchObject({
      active_network_mode: "loopback",
      desired_mode: "lan",
      restart_required: true
    });

    const enrollment = certificates.enrollment({ bind_host: host, bind_port: port });
    const ca = new NodeX509Certificate(enrollment.certificate_der).toString();
    const lanLifecycle = await startHostDeckFastifyLifecycle({
      createRequestAuthenticationPolicy: pairedAuthenticationPolicy,
      createRoutePlugins: () => [
        createHostDeckLanNetworkRouteRegistration({ service })
      ],
      observeInternalError: () => undefined,
      resourceBudget: defaultResourceBudget,
      runtime: {
        beginDrain() {},
        closeRuntime() {},
        closeSse() {},
        closeStartup() {},
        start() {
          const durable = network.read();
          if (!durable.settings.lan_enabled) {
            throw new Error("LAN HTTPS startup did not observe enabled durable state.");
          }
          return {
            bind: {
              host: durable.settings.bind_host,
              port: durable.settings.bind_port,
              transport: "https" as const
            },
            context: {},
            tls: certificates.loadTls({
              bind_host: durable.settings.bind_host,
              bind_port: durable.settings.bind_port
            })
          };
        }
      }
    });
    try {
      const read = await tlsRequest({
        ca,
        host,
        method: "GET",
        path: "/api/v1/network",
        port,
        headers: {
          cookie: `${hostDeckDeviceCookieName}=${rawDeviceToken}`
        }
      });
      expect(read.status).toBe(200);
      expect(read.headers["cache-control"]).toBe("no-store");
      expect(read.headers["access-control-allow-origin"]).toBeUndefined();
      expect(JSON.parse(read.body)).toMatchObject({
        active_network_mode: "lan",
        active_transport: "https",
        active_origin: `https://${host}:${port}`,
        desired_mode: "lan",
        lan_enabled: true,
        can_manage_lan: false,
        restart_required: false
      });

      const remoteDisable = await tlsRequest({
        ca,
        host,
        method: "POST",
        path: "/api/v1/network/disable",
        port,
        headers: {
          cookie: `${hostDeckDeviceCookieName}=${rawDeviceToken}`,
          origin: `https://${host}:${port}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          operation_id: "op_lan_https_remote_disable_01",
          confirmed: true
        })
      });
      expect(remoteDisable.status).toBe(403);
      expect(JSON.parse(remoteDisable.body)).toMatchObject({
        error: { code: "permission_denied" }
      });
      expect(auditRepository.get("op_lan_https_remote_disable_01")).toBeNull();
      await expect(plainHttp(host, port)).rejects.toMatchObject({
        code: expect.stringMatching(/ECONNRESET|EPIPE/iu)
      });
    } finally {
      await lanLifecycle.close();
    }

    const disabling = await service.disable(lanAdmin(host, port), selectedLanDisableRequestSchema.parse({
      operation_id: "op_lan_https_local_disable_01",
      confirmed: true
    }));
    expect(disabling).toMatchObject({
      active_network_mode: "lan",
      desired_mode: "loopback",
      can_manage_lan: true,
      restart_required: true
    });
    expect(settings.require()).toMatchObject({
      bind_mode: "localhost",
      bind_host: "127.0.0.1",
      bind_port: port,
      lan_enabled: false
    });

    const loopbackService = createHostDeckLanNetworkService({
      audit,
      certificates,
      network,
      now: () => new Date(Date.parse(now) + 120_000)
    });
    const loopbackLifecycle = await startHostDeckFastifyLifecycle({
      createRequestAuthenticationPolicy: pairedAuthenticationPolicy,
      createRoutePlugins: () => [
        createHostDeckLanNetworkRouteRegistration({ service: loopbackService })
      ],
      observeInternalError: () => undefined,
      resourceBudget: defaultResourceBudget,
      runtime: {
        beginDrain() {},
        closeRuntime() {},
        closeSse() {},
        closeStartup() {},
        start() {
          const durable = network.read();
          return {
            bind: {
              host: durable.settings.bind_host,
              port: durable.settings.bind_port,
              transport: "http" as const
            },
            context: {}
          };
        }
      }
    });
    try {
      const response = await fetch(new URL("/api/v1/network", loopbackLifecycle.baseUrl));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        active_network_mode: "loopback",
        desired_mode: "loopback",
        configured: true,
        restart_required: false
      });
    } finally {
      await loopbackLifecycle.close();
    }
  });
});

interface TlsRequestInput {
  readonly body?: string;
  readonly ca: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly host: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly port: number;
}

function tlsRequest(input: TlsRequestInput): Promise<{
  readonly body: string;
  readonly headers: import("node:http").IncomingHttpHeaders;
  readonly status: number;
}> {
  return new Promise((resolve, reject) => {
    const body = input.body ?? "";
    const request = httpsRequest(
      {
        ca: input.ca,
        headers: {
          ...input.headers,
          ...(body.length === 0
            ? {}
            : { "content-length": Buffer.byteLength(body, "utf8") })
        },
        host: input.host,
        method: input.method,
        path: input.path,
        port: input.port,
        rejectUnauthorized: true
      },
      (response) => {
        let output = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          output += chunk;
          if (output.length > 65_536) {
            request.destroy(new Error("LAN HTTPS response exceeded test bound."));
          }
        });
        response.once("end", () => {
          resolve({
            body: output,
            headers: response.headers,
            status: response.statusCode ?? 0
          });
        });
        response.once("error", reject);
      }
    );
    request.setTimeout(5000, () => request.destroy(new Error("LAN HTTPS request timed out.")));
    request.once("error", reject);
    request.end(body);
  });
}

function plainHttp(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = httpGet({ agent: false, host, path: "/api/v1/network", port }, (response) => {
      response.resume();
      response.once("end", resolve);
    });
    request.setTimeout(3000, () => request.destroy(new Error("Plain HTTP request timed out.")));
    request.once("error", reject);
  });
}

function pairedAuthenticationPolicy() {
  return createHostDeckRequestAuthenticationPolicy({
    authenticateDeviceToken: ({ rawDeviceToken: candidate }) => {
      if (candidate !== rawDeviceToken) throw new Error("Unknown device token.");
      return Object.freeze({
        trusted: true as const,
        readOnly: false,
        device: Object.freeze({
          id: "client_phone",
          token_hash: `sha256:${"a".repeat(64)}`,
          csrf_token_hash: `sha256:${"b".repeat(64)}`,
          csrf_generation: 1,
          csrf_rotated_at: now,
          client_label: "Phone",
          permission: "write" as const,
          created_at: now,
          last_used_at: new Date(Date.parse(now) + 1000).toISOString(),
          expires_at: null,
          revoked_at: null
        })
      });
    },
    now: () => new Date(Date.parse(now) + 1000)
  });
}

function loopbackAdmin(port: number): SelectedRequestAuthenticationContext {
  return {
    state: "local_admin",
    configured_origin: `http://127.0.0.1:${port}`,
    network_mode: "loopback",
    origin_kind: "local_non_browser",
    transport: "http",
    device_id: null,
    permission: "local_admin",
    csrf_generation: null,
    last_used_at: null,
    expires_at: null
  };
}

function lanAdmin(host: string, port: number): SelectedRequestAuthenticationContext {
  return {
    ...loopbackAdmin(port),
    configured_origin: `https://${host}:${port}`,
    network_mode: "lan",
    transport: "https"
  };
}

function fixedNow(): Date {
  return new Date(now);
}

function requirePrivateIpv4(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      const [first, second] = address.address.split(".").map(Number);
      if (
        first === 10 ||
        (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
        (first === 192 && second === 168)
      ) {
        return address.address;
      }
    }
  }
  throw new Error("Supported Linux LAN HTTPS test requires one assigned private IPv4 address.");
}

function reservePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host, port: 0 }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("LAN port reservation did not bind."));
        return;
      }
      server.close((error) => (error === undefined ? resolve(address.port) : reject(error)));
    });
  });
}

function tempDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(directory, 0o700);
  tempDirectories.push(directory);
  return directory;
}
