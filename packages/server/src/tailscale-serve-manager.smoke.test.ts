import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type RemoteIngressObservationSnapshot,
  type RemoteServeDescriptor,
  remoteServeDescriptorSchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import { createTailscaleObserver } from "./tailscale-observer.js";
import { createTailscaleServeManager } from "./tailscale-serve-manager.js";

const requireSmoke = process.env.HOSTDECK_REQUIRE_TAILSCALE_SERVE_MANAGER_SMOKE === "1";
const describeSmoke = requireSmoke ? describe : describe.skip;
const responseBody = "hostdeck-tailscale-serve-manager-smoke";

describeSmoke("real ownership-safe Tailscale Serve manager", () => {
  it("enables, reads back, proxies, repeats, removes only root, and leaves no active command", async () => {
    const controller = new AbortController();
    let expectedHost: string | null = null;
    let requestCount = 0;
    let sawExpectedHost = false;
    let sawLoopbackSource = false;
    const server = createServer((request, response) => {
      requestCount += 1;
      sawExpectedHost ||= request.headers.host === expectedHost;
      sawLoopbackSource ||= isLoopbackRequest(request);
      writeResponse(response);
    });
    await listenLoopback(server);

    const observer = createTailscaleObserver({ signal: controller.signal });
    const manager = createTailscaleServeManager({ observer, signal: controller.signal });
    let descriptor: RemoteServeDescriptor | null = null;
    let expectedProfileKey: string | null = null;

    try {
      const candidate = await observer.observeCandidate();
      expect(candidate).toMatchObject({
        client: "available",
        failure: null,
        profile: { state: "dedicated", comparison: { relation: "match" } },
        serve: "absent"
      });
      expect(candidate.external_origin).not.toBeNull();
      expect(candidate.profile.comparison.active_profile_key).not.toBeNull();

      expectedProfileKey = candidate.profile.comparison.active_profile_key;
      expectedHost = new URL(candidate.external_origin as string).host;
      descriptor = remoteServeDescriptorSchema.parse({
        external_origin: candidate.external_origin,
        https_port: 443,
        path: "/",
        proxy_origin: `http://127.0.0.1:${listeningPort(server)}`,
        visibility: "private"
      });

      const enabled = await manager.enable({
        expected_profile_key: expectedProfileKey as string,
        expected_serve: descriptor
      });
      expect(enabled).toMatchObject({
        outcome: "succeeded",
        serve_result: "applied",
        reason: null,
        command_attempted: true,
        after: { serve: "exact", failure: null }
      });

      const repeatedEnable = await manager.enable({
        expected_profile_key: expectedProfileKey as string,
        expected_serve: descriptor
      });
      expect(repeatedEnable).toMatchObject({
        outcome: "succeeded",
        serve_result: "unchanged",
        reason: null,
        command_attempted: false,
        before: { serve: "exact" }
      });

      const proxied = await fetch(descriptor.external_origin, {
        cache: "no-store",
        headers: { connection: "close" },
        redirect: "error",
        signal: AbortSignal.timeout(10_000)
      });
      expect(proxied.status).toBe(200);
      expect(await proxied.text()).toBe(responseBody);
      expect(requestCount).toBe(1);
      expect(sawExpectedHost).toBe(true);
      expect(sawLoopbackSource).toBe(true);

      const disabled = await manager.disable({
        expected_profile_key: expectedProfileKey as string,
        expected_serve: descriptor
      });
      expect(disabled).toMatchObject({
        outcome: "succeeded",
        serve_result: "removed",
        reason: null,
        command_attempted: true,
        after: { serve: "absent", failure: null }
      });

      const repeatedDisable = await manager.disable({
        expected_profile_key: expectedProfileKey as string,
        expected_serve: descriptor
      });
      expect(repeatedDisable).toMatchObject({
        outcome: "succeeded",
        serve_result: "unchanged",
        reason: null,
        command_attempted: false,
        before: { serve: "absent" }
      });
      expect(manager.snapshot()).toMatchObject({
        active: false,
        command_attempts: 2,
        started_operations: 4,
        succeeded_operations: 4
      });
    } finally {
      try {
        if (descriptor !== null && expectedProfileKey !== null) {
          await proveOrRestoreAbsent(observer, manager, expectedProfileKey, descriptor);
        }
      } finally {
        controller.abort();
        await closeServer(server);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(process.getActiveResourcesInfo()).not.toContain("ChildProcess");
      }
    }
  });
});

async function proveOrRestoreAbsent(
  observer: ReturnType<typeof createTailscaleObserver>,
  manager: ReturnType<typeof createTailscaleServeManager>,
  expectedProfileKey: string,
  descriptor: RemoteServeDescriptor
): Promise<void> {
  const current = await observer.observeConfigured({
    expected_profile_key: expectedProfileKey,
    expected_serve: descriptor
  });
  assertOwnedCleanupState(current);
  if (current.serve === "exact") {
    const cleanup = await manager.disable({
      expected_profile_key: expectedProfileKey,
      expected_serve: descriptor
    });
    expect(cleanup).toMatchObject({
      outcome: "succeeded",
      serve_result: "removed",
      after: { serve: "absent", failure: null }
    });
    return;
  }
  expect(current.serve).toBe("absent");
}

function assertOwnedCleanupState(snapshot: RemoteIngressObservationSnapshot): void {
  expect(snapshot).toMatchObject({
    client: "available",
    failure: null,
    profile: { state: "dedicated", comparison: { relation: "match" } }
  });
  expect(["absent", "exact"]).toContain(snapshot.serve);
}

function writeResponse(response: ServerResponse): void {
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(responseBody),
    "content-type": "text/plain; charset=utf-8"
  });
  response.end(responseBody);
}

function isLoopbackRequest(request: IncomingMessage): boolean {
  return request.socket.remoteAddress === "127.0.0.1" || request.socket.remoteAddress === "::ffff:127.0.0.1";
}

function listenLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function listeningPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new TypeError("Tailscale Serve smoke loopback listener has no TCP address.");
  }
  return (address as AddressInfo).port;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}
