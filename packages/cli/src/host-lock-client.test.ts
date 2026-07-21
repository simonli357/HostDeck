import {
  selectedHostLockRequestSchema,
  selectedHostUnlockRequestSchema
} from "@hostdeck/contracts";
import {
  hostDeckLocalAdminRequestHeaderName,
  hostDeckLocalAdminRequestHeaderValue
} from "@hostdeck/server";
import { describe, expect, it } from "vitest";
import type { HttpRequestInit, HttpResponse } from "./api-client.js";
import { cliExitCodes } from "./exit-codes.js";
import { createHostDeckHostLockClient } from "./host-lock-client.js";

const origin = "http://127.0.0.1:3777";

describe("selected host-lock CLI client", () => {
  it("sends exact local-admin lock and unlock requests", async () => {
    const requests: Array<{ readonly init: HttpRequestInit; readonly url: string }> = [];
    const client = createHostDeckHostLockClient({
      baseUrl: new URL(origin),
      fetch: async (url, init) => {
        requests.push({ init, url });
        return jsonResponse(200, lockState(url.endsWith("/lock")));
      }
    });
    const lock = selectedHostLockRequestSchema.parse({
      operation_id: "op_host_lock_client_001",
      confirmed: true
    });
    const unlock = selectedHostUnlockRequestSchema.parse({
      operation_id: "op_host_unlock_client_001",
      confirmed: true
    });

    await expect(client.lock(lock)).resolves.toEqual(lockState(true));
    await expect(client.unlock(unlock)).resolves.toEqual(lockState(false));
    expect(requests).toEqual([
      {
        url: `${origin}/api/v1/access/lock`,
        init: mutationInit(lock)
      },
      {
        url: `${origin}/api/v1/access/unlock`,
        init: mutationInit(unlock)
      }
    ]);
    expect(Object.isFrozen(requests[0]?.init.headers)).toBe(true);
  });

  it("snapshots one exact loopback origin and rejects alternate authorities", async () => {
    const baseUrl = new URL(origin);
    const observed: string[] = [];
    const client = createHostDeckHostLockClient({
      baseUrl,
      fetch: async (url) => {
        observed.push(url);
        return jsonResponse(200, lockState(true));
      }
    });
    baseUrl.hostname = "203.0.113.8";
    await client.lock(
      selectedHostLockRequestSchema.parse({
        operation_id: "op_host_lock_snapshot_001",
        confirmed: true
      })
    );
    expect(observed).toEqual([`${origin}/api/v1/access/lock`]);

    for (const value of [
      "http://localhost:3777",
      "http://127.0.0.2:3777",
      "http://127.9.8.7:3777",
      "http://[::1]:3777",
      "http://0.0.0.0:3777",
      "http://127.0.0.1:1023",
      "https://127.0.0.1:3777",
      "http://127.0.0.1:3777/base",
      "http://user@127.0.0.1:3777"
    ]) {
      expect(
        () => createHostDeckHostLockClient({ baseUrl: new URL(value) }),
        value
      ).toThrowError(
        expect.objectContaining({
          code: "invalid_config",
          exitCode: cliExitCodes.config
        })
      );
    }
  });

  it("rejects invalid options and request input before transport", async () => {
    let accessorCalls = 0;
    const accessor = Object.defineProperty({}, "baseUrl", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return new URL(origin);
      }
    });
    for (const candidate of [
      null,
      [],
      {},
      { baseUrl: new URL(origin), extra: true },
      { baseUrl: origin },
      { baseUrl: new URL(origin), fetch: true },
      accessor
    ]) {
      expect(() => createHostDeckHostLockClient(candidate as never)).toThrow(
        TypeError
      );
    }
    expect(accessorCalls).toBe(0);

    let calls = 0;
    const client = createHostDeckHostLockClient({
      baseUrl: new URL(origin),
      fetch: async () => {
        calls += 1;
        return jsonResponse(200, lockState(true));
      }
    });
    await expect(
      client.lock({ operation_id: "bad", confirmed: true } as never)
    ).rejects.toMatchObject({ code: "internal_error" });
    expect(calls).toBe(0);
  });

  it("rejects uncorrelated success and sanitizes typed failures without retry", async () => {
    const request = selectedHostLockRequestSchema.parse({
      operation_id: "op_host_lock_response_001",
      confirmed: true
    });
    let calls = 0;
    const uncorrelated = createHostDeckHostLockClient({
      baseUrl: new URL(origin),
      fetch: async () => {
        calls += 1;
        return jsonResponse(200, lockState(false));
      }
    });
    await expect(uncorrelated.lock(request)).rejects.toMatchObject({
      code: "internal_error",
      message: "HostDeck daemon returned an invalid or uncorrelated host-lock response."
    });
    expect(calls).toBe(1);

    calls = 0;
    const denied = createHostDeckHostLockClient({
      baseUrl: new URL(origin),
      fetch: async () => {
        calls += 1;
        return jsonResponse(403, {
          error: {
            code: "permission_denied",
            message: "private authority detail",
            retryable: false,
            details: { request_id: "req_private_host_lock" }
          }
        });
      }
    });
    await expect(denied.lock(request)).rejects.toMatchObject({
      code: "permission_denied",
      message: "Host lock request is not permitted.",
      status: 403
    });
    expect(calls).toBe(1);
  });

  it("maps malformed and unavailable responses without retry", async () => {
    const request = selectedHostUnlockRequestSchema.parse({
      operation_id: "op_host_unlock_failure_001",
      confirmed: true
    });
    let calls = 0;
    const malformed = createHostDeckHostLockClient({
      baseUrl: new URL(origin),
      fetch: async () => {
        calls += 1;
        return jsonResponse(200, { ...lockState(false), private: true });
      }
    });
    await expect(malformed.unlock(request)).rejects.toMatchObject({
      code: "internal_error"
    });
    expect(calls).toBe(1);

    calls = 0;
    const unavailable = createHostDeckHostLockClient({
      baseUrl: new URL(origin),
      fetch: async () => {
        calls += 1;
        throw new Error("private socket failure");
      }
    });
    await expect(unavailable.unlock(request)).rejects.toMatchObject({
      code: "daemon_unavailable",
      exitCode: cliExitCodes.daemonUnavailable
    });
    expect(calls).toBe(1);
  });
});

function mutationInit(
  request: Readonly<{ readonly operation_id: string; readonly confirmed: true }>
): HttpRequestInit {
  return {
    method: "POST",
    headers: {
      accept: "application/json",
      "cache-control": "no-store",
      "content-type": "application/json",
      [hostDeckLocalAdminRequestHeaderName]:
        hostDeckLocalAdminRequestHeaderValue
    },
    body: JSON.stringify(request)
  };
}

function lockState(locked: boolean) {
  return {
    authentication_state: "local_admin" as const,
    device_id: null,
    permission: "local_admin" as const,
    device_expires_at: null,
    configured_origin: origin,
    network_mode: "loopback" as const,
    transport: "http" as const,
    locked,
    can_read_sessions: true,
    can_write_sessions: !locked,
    can_lock: true,
    can_unlock: true
  };
}

function jsonResponse(status: number, body: unknown): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}
