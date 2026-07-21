import {
  type SelectedHostStatusResponse,
  selectedHostLocalHealthComponents,
  selectedHostStatusResponseSchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import type { HttpFetch, HttpResponse } from "./api-client.js";
import { cliExitCodes } from "./exit-codes.js";
import { createHostDeckHostStatusClient } from "./host-status-client.js";

const origin = "http://127.0.0.1:3777";
const timestamp = "2026-07-20T20:00:00.000Z";
const externalOrigin = "https://private-host-status.fixture-tailnet.ts.net";

describe("selected host-status CLI client", () => {
  it("snapshots one direct-loopback configuration and sends one least-authority GET", async () => {
    const mutableUrl = new URL(origin);
    const requests: Array<{ readonly init: unknown; readonly url: string }> = [];
    let fetchThis: unknown = "not-called";
    const fetch: HttpFetch = function hostStatusFetch(this: void, url, init) {
      fetchThis = this;
      requests.push({ init, url });
      return Promise.resolve(jsonResponse(200, hostStatus()));
    };
    const client = createHostDeckHostStatusClient({
      baseUrl: mutableUrl,
      fetch
    });
    mutableUrl.hostname = "203.0.113.20";

    const response = await client.read();
    expect(requests).toEqual([
      {
        url: `${origin}/api/v1/host/status`,
        init: {
          method: "GET",
          headers: {
            accept: "application/json",
            "cache-control": "no-store"
          }
        }
      }
    ]);
    expect(fetchThis).toBeUndefined();
    expect(Object.isFrozen(client)).toBe(true);
    expect(Object.isFrozen(response)).toBe(true);
    expect(Object.isFrozen(response.local.components)).toBe(true);
    expect(Object.isFrozen(response.access.write_eligibility.causes)).toBe(true);
  });

  it("rejects malformed options and every alternate authority before fetch", () => {
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
      { baseUrl: origin },
      { baseUrl: new URL(origin), fetch: null },
      { baseUrl: new URL(origin), extra: true },
      accessor
    ]) {
      expect(() =>
        createHostDeckHostStatusClient(candidate as never)
      ).toThrow(TypeError);
    }
    expect(accessorCalls).toBe(0);

    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return jsonResponse(200, hostStatus());
    };
    for (const value of [
      "https://127.0.0.1:3777",
      "http://localhost:3777",
      "http://127.0.0.2:3777",
      "http://192.0.2.20:3777",
      "http://user@127.0.0.1:3777",
      "http://127.0.0.1:3777/base",
      "http://127.0.0.1:3777?private=true"
    ]) {
      expect(() =>
        createHostDeckHostStatusClient({ baseUrl: new URL(value), fetch })
      ).toThrowError(
        expect.objectContaining({
          code: "invalid_config",
          exitCode: cliExitCodes.config
        })
      );
    }
    expect(calls).toBe(0);
  });

  it("rejects wrong authority, extra data, hostile data, and wrong success status", async () => {
    const hostile = Object.defineProperty({}, "local", {
      enumerable: true,
      get() {
        throw new Error("private-host-status-getter");
      }
    });
    const candidates: Array<readonly [number, unknown]> = [
      [200, hostStatus("local_admin")],
      [200, { ...hostStatus(), private_profile: "private" }],
      [200, hostile],
      [201, hostStatus()]
    ];
    let calls = 0;
    const client = createHostDeckHostStatusClient({
      baseUrl: new URL(origin),
      fetch: async () => {
        const candidate = candidates[calls];
        calls += 1;
        if (candidate === undefined) throw new Error("unexpected fetch");
        return jsonResponse(candidate[0], candidate[1]);
      }
    });

    for (let index = 0; index < candidates.length; index += 1) {
      await expect(client.read()).rejects.toMatchObject({
        code: "internal_error",
        message: "HostDeck daemon returned invalid or uncorrelated host status."
      });
    }
    expect(calls).toBe(candidates.length);
  });

  it("sanitizes typed failures and never retries or exposes server detail", async () => {
    const cases = [
      [401, "permission_denied", "not permitted"],
      [500, "storage_error", "storage is unavailable"],
      [504, "operation_timeout", "timed out"],
      [503, "service_overloaded", "capacity is exhausted"]
    ] as const;
    let calls = 0;
    const client = createHostDeckHostStatusClient({
      baseUrl: new URL(origin),
      fetch: async () => {
        const current = cases[calls];
        calls += 1;
        if (current === undefined) throw new Error("unexpected fetch");
        return jsonResponse(current[0], {
          error: {
            code: current[1],
            message:
              "private profile, origin, account, node, credential, and path",
            retryable: current[0] >= 503,
            details: { private: "private" }
          }
        });
      }
    });

    for (const [status, code, message] of cases) {
      await expect(client.read()).rejects.toMatchObject({
        kind: "api_error",
        status,
        code,
        message: expect.stringContaining(message)
      });
    }
    expect(calls).toBe(cases.length);
  });
});

function hostStatus(
  mode: "local_admin" | "loopback_read" = "loopback_read"
): SelectedHostStatusResponse {
  const readOnly = mode === "loopback_read";
  return selectedHostStatusResponseSchema.parse({
    local: {
      generation: 7,
      state: "ready",
      readiness: "ready",
      mutation_admission: "open",
      updated_at: timestamp,
      components: selectedHostLocalHealthComponents.map((component) => ({
        component,
        state: "ready",
        checked_at: timestamp,
        causes: []
      }))
    },
    remote: {
      generation: 3,
      state_generation: 3,
      availability: "ready",
      cause: null,
      external_origin: externalOrigin,
      laptop_action_required: false,
      observed_at: timestamp,
      checked_at: timestamp,
      updated_at: timestamp
    },
    access: {
      mode,
      network_mode: "loopback",
      transport: "http",
      write_eligibility: {
        scope: "host_health_and_authority",
        eligible: !readOnly,
        causes: readOnly ? ["read_only_access"] : []
      }
    }
  });
}

function jsonResponse(status: number, body: unknown): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}
