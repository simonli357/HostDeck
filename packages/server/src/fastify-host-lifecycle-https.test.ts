import { X509Certificate as NodeX509Certificate } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { defaultResourceBudget } from "@hostdeck/contracts";
import type { FastifyRequest } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  HostDeckFastifyInstance,
  HostDeckRoutePluginRegistration
} from "./fastify-app.js";
import { startHostDeckFastifyLifecycle } from "./fastify-host-lifecycle.js";
import { createHostDeckRequestAuthenticationPolicy } from "./fastify-request-authentication.js";
import { hostDeckRequestTrustContext } from "./fastify-request-trust.js";
import { createHostDeckLanCertificatePolicy } from "./lan-certificate-policy.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("selected Fastify HTTPS lifecycle", () => {
  it("binds one exact assigned private IP from branded TLS input and restarts cleanly", async () => {
    const host = requirePrivateIpv4();
    const port = await reservePort(host);
    const directory = tempDirectory();
    const certificates = createHostDeckLanCertificatePolicy({
      assignedAddresses: () => [host],
      certificateDirectory: directory,
      now: () => new Date("2026-07-12T20:00:00.000Z")
    });
    await certificates.configure({
      bind_host: host,
      bind_port: port,
      certificate_action: "issue_leaf"
    });
    const enrollment = certificates.enrollment({ bind_host: host, bind_port: port });
    const ca = new NodeX509Certificate(enrollment.certificate_der).toString();
    const route: HostDeckRoutePluginRegistration = Object.freeze({
      id: "https-lifecycle-proof",
      surface: "api" as const,
      register(app: HostDeckFastifyInstance) {
        app.get(
          "/probe",
          {
            schema: {
              response: {
                200: z
                  .object({
                    authority: z.string(),
                    configured_origin: z.string(),
                    network_mode: z.literal("lan"),
                    origin_kind: z.string(),
                    transport: z.literal("https")
                  })
                  .strict()
              }
            }
          },
          async (request: FastifyRequest) => hostDeckRequestTrustContext(request)
        );
      }
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const lifecycle = await startHostDeckFastifyLifecycle({
        createRequestAuthenticationPolicy: () =>
          createHostDeckRequestAuthenticationPolicy({
            authenticateDeviceToken: () => {
              throw new Error("HTTPS lifecycle probe does not authenticate a device.");
            },
            now: () => new Date("2026-07-12T20:00:00.000Z")
          }),
        createRoutePlugins: () => [route],
        observeInternalError: () => undefined,
        resourceBudget: defaultResourceBudget,
        runtime: {
          closeSse() {},
          closeStartup() {},
          start() {
            return {
              bind: { host, port, transport: "https" as const },
              context: {},
              tls: certificates.loadTls({ bind_host: host, bind_port: port })
            };
          }
        }
      });
      try {
        expect(await httpsJson(host, port, ca)).toEqual({
          authority: `${host}:${port}`,
          configured_origin: `https://${host}:${port}`,
          network_mode: "lan",
          origin_kind: "safe_no_origin",
          transport: "https"
        });
        expect(lifecycle.baseUrl.origin).toBe(`https://${host}:${port}`);
        expect(lifecycle.snapshot()).toMatchObject({
          bound: { host, port, transport: "https" },
          configured: { host, port, transport: "https" },
          listening: true,
          phase: "ready"
        });
        expect(JSON.stringify(lifecycle.snapshot())).not.toMatch(/PRIVATE KEY|CERTIFICATE/iu);
        await expect(plainHttp(host, port)).rejects.toMatchObject({
          code: expect.stringMatching(/ECONNRESET|EPIPE/iu)
        });
      } finally {
        await lifecycle.close();
      }
      expect(lifecycle.snapshot()).toMatchObject({ listening: false, phase: "closed" });
    }
  });

  it("rejects missing, forged, and bind-mismatched TLS ownership before listen", async () => {
    const host = requirePrivateIpv4();
    const port = await reservePort(host);
    const certificates = createHostDeckLanCertificatePolicy({
      assignedAddresses: () => [host],
      certificateDirectory: tempDirectory(),
      now: () => new Date("2026-07-12T20:00:00.000Z")
    });
    await certificates.configure({
      bind_host: host,
      bind_port: port,
      certificate_action: "issue_leaf"
    });
    const tls = certificates.loadTls({ bind_host: host, bind_port: port });
    const started = [
      { bind: { host, port, transport: "https" as const }, context: {} },
      {
        bind: { host, port, transport: "https" as const },
        context: {},
        tls: { ...tls }
      },
      {
        bind: { host, port: port + 1, transport: "https" as const },
        context: {},
        tls
      }
    ];

    for (const owner of started) {
      await expect(
        startHostDeckFastifyLifecycle({
          createRequestAuthenticationPolicy: () =>
            createHostDeckRequestAuthenticationPolicy({
              authenticateDeviceToken: () => null,
              now: () => new Date("2026-07-12T20:00:00.000Z")
            }),
          createRoutePlugins: () => [],
          observeInternalError: () => undefined,
          resourceBudget: defaultResourceBudget,
          runtime: {
            closeSse() {},
            closeStartup() {},
            start() {
              return owner as never;
            }
          }
        })
      ).rejects.toMatchObject({
        code: "runtime_contract_invalid",
        stage: "runtime_contract"
      });
    }
  });
});

function httpsJson(host: string, port: number, ca: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = httpsGet(
      {
        agent: false,
        ca,
        host,
        path: "/probe",
        port,
        rejectUnauthorized: true
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > 4096) response.destroy(new Error("HTTPS response exceeded test bound."));
        });
        response.once("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
        response.once("error", reject);
      }
    );
    request.setTimeout(3000, () => request.destroy(new Error("HTTPS request timed out.")));
    request.once("error", reject);
  });
}

function plainHttp(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = httpGet({ agent: false, host, path: "/probe", port }, (response) => {
      response.resume();
      response.once("end", resolve);
    });
    request.setTimeout(3000, () => request.destroy(new Error("HTTP request timed out.")));
    request.once("error", reject);
  });
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
  throw new Error("Supported Linux HTTPS lifecycle test requires one assigned private IPv4 address.");
}

function reservePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host, port: 0 }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Port reservation did not bind."));
        return;
      }
      server.close((error) => (error === undefined ? resolve(address.port) : reject(error)));
    });
  });
}

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-fastify-https-"));
  chmodSync(directory, 0o700);
  tempDirectories.push(directory);
  return directory;
}
