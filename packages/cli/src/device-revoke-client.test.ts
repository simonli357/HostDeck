import {
  clientOperationIdSchema,
  type SelectedDeviceRevokeResponse,
  selectedDeviceRevokeRequestSchema,
  selectedDeviceRevokeResponseSchema
} from "@hostdeck/contracts";
import {
  hostDeckLocalAdminRequestHeaderName,
  hostDeckLocalAdminRequestHeaderValue
} from "@hostdeck/server";
import { describe, expect, it } from "vitest";
import type { HttpFetch, HttpRequestInit, HttpResponse } from "./api-client.js";
import { createHostDeckDeviceRevokeClient } from "./device-revoke-client.js";
import { cliExitCodes } from "./exit-codes.js";

const origin = "http://127.0.0.1:3777";
const deviceId = "client_revoke_cli_001";
const operationId = clientOperationIdSchema.parse(
  "op_device_revoke_cli_001"
);
const revokedAt = "2026-07-20T20:00:00.000Z";

describe("selected device-revoke CLI client", () => {
  it("sends one exact confirmed local-admin mutation and freezes correlated success", async () => {
    const requests: Array<{ readonly init: HttpRequestInit; readonly url: string }> = [];
    const mutableUrl = new URL(origin);
    const client = createHostDeckDeviceRevokeClient({
      baseUrl: mutableUrl,
      fetch: async (url, init) => {
        requests.push({ init, url });
        return jsonResponse(200, revokeResponse());
      }
    });
    mutableUrl.hostname = "203.0.113.22";
    const request = {
      device_id: deviceId,
      ...selectedDeviceRevokeRequestSchema.parse({
        operation_id: operationId,
        confirmed: true
      })
    };

    const response = await client.revoke(request);
    expect(requests).toEqual([
      {
        url: `${origin}/api/v1/access/devices/${deviceId}/revoke`,
        init: {
          method: "POST",
          headers: {
            accept: "application/json",
            "cache-control": "no-store",
            "content-type": "application/json",
            [hostDeckLocalAdminRequestHeaderName]:
              hostDeckLocalAdminRequestHeaderValue
          },
          body: JSON.stringify({ operation_id: operationId, confirmed: true })
        }
      }
    ]);
    expect(Object.isFrozen(requests[0]?.init.headers)).toBe(true);
    expect(Object.isFrozen(client)).toBe(true);
    expect(Object.isFrozen(response)).toBe(true);
  });

  it("rejects malformed options, alternate authority, and hostile input before fetch", async () => {
    let accessorCalls = 0;
    const optionAccessor = Object.defineProperty({}, "baseUrl", {
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
      { baseUrl: new URL(origin), private: true },
      optionAccessor
    ]) {
      expect(() =>
        createHostDeckDeviceRevokeClient(candidate as never)
      ).toThrow(TypeError);
    }
    expect(accessorCalls).toBe(0);

    let calls = 0;
    const fetch: HttpFetch = async () => {
      calls += 1;
      return jsonResponse(200, revokeResponse());
    };
    for (const value of [
      "https://127.0.0.1:3777",
      "http://localhost:3777",
      "http://127.0.0.2:3777",
      "http://192.0.2.22:3777",
      "http://user@127.0.0.1:3777",
      "http://127.0.0.1:3777/base"
    ]) {
      expect(() =>
        createHostDeckDeviceRevokeClient({ baseUrl: new URL(value), fetch })
      ).toThrowError(
        expect.objectContaining({
          code: "invalid_config",
          exitCode: cliExitCodes.config
        })
      );
    }

    const client = createHostDeckDeviceRevokeClient({
      baseUrl: new URL(origin),
      fetch
    });
    const requestAccessor = Object.defineProperties(
      { device_id: deviceId, confirmed: true },
      {
        operation_id: {
          enumerable: true,
          get() {
            accessorCalls += 1;
            return operationId;
          }
        }
      }
    );
    for (const candidate of [
      null,
      {},
      { device_id: "invalid device", operation_id: operationId, confirmed: true },
      { device_id: deviceId, operation_id: "invalid", confirmed: true },
      { device_id: deviceId, operation_id: operationId, confirmed: false },
      {
        device_id: deviceId,
        operation_id: operationId,
        confirmed: true,
        private: true
      },
      requestAccessor
    ]) {
      await expect(client.revoke(candidate as never)).rejects.toMatchObject({
        code: "internal_error",
        message: "HostDeck device-revoke input is invalid."
      });
    }
    expect(accessorCalls).toBe(0);
    expect(calls).toBe(0);
  });

  it("rejects cross-operation, cross-device, self-revoke, extra, and wrong-status success", async () => {
    const candidates: Array<readonly [number, unknown]> = [
      [
        200,
        revokeResponse({
          operation_id: clientOperationIdSchema.parse(
            "op_device_revoke_other_001"
          )
        })
      ],
      [200, revokeResponse({ device_id: "client_revoke_cli_other" })],
      [200, revokeResponse({ self_revoked: true })],
      [200, { ...revokeResponse(), token_hash: "private" }],
      [202, revokeResponse()]
    ];
    let calls = 0;
    const client = createHostDeckDeviceRevokeClient({
      baseUrl: new URL(origin),
      fetch: async () => {
        const candidate = candidates[calls];
        calls += 1;
        if (candidate === undefined) throw new Error("unexpected fetch");
        return jsonResponse(candidate[0], candidate[1]);
      }
    });
    const request = {
      device_id: deviceId,
      operation_id: operationId,
      confirmed: true as const
    };

    for (let index = 0; index < candidates.length; index += 1) {
      await expect(client.revoke(request)).rejects.toMatchObject({
        code: "internal_error",
        message:
          "HostDeck daemon returned invalid or uncorrelated device-revoke data."
      });
    }
    expect(calls).toBe(candidates.length);
  });

  it("sanitizes destructive-operation failures and never retries", async () => {
    const cases = [
      [409, "operation_conflict", "conflicts with current authority"],
      [403, "read_only", "Write permission is required"],
      [401, "permission_denied", "not permitted"],
      [503, "audit_unavailable", "audit is unavailable"],
      [500, "storage_error", "storage is unavailable"],
      [504, "operation_timeout", "reconcile before retrying"],
      [503, "service_overloaded", "capacity is exhausted"]
    ] as const;
    let calls = 0;
    const client = createHostDeckDeviceRevokeClient({
      baseUrl: new URL(origin),
      fetch: async () => {
        const current = cases[calls];
        calls += 1;
        if (current === undefined) throw new Error("unexpected fetch");
        return jsonResponse(current[0], {
          error: {
            code: current[1],
            message:
              "private device token, cookie, authority, audit detail, and path",
            retryable: false,
            details: { private: "private" }
          }
        });
      }
    });
    const request = {
      device_id: deviceId,
      operation_id: operationId,
      confirmed: true as const
    };

    for (const [status, code, message] of cases) {
      await expect(client.revoke(request)).rejects.toMatchObject({
        kind: "api_error",
        status,
        code,
        message: expect.stringContaining(message)
      });
    }
    expect(calls).toBe(cases.length);
  });
});

function revokeResponse(
  overrides: Partial<SelectedDeviceRevokeResponse> = {}
): SelectedDeviceRevokeResponse {
  return selectedDeviceRevokeResponseSchema.parse({
    operation_id: operationId,
    device_id: deviceId,
    revoked_at: revokedAt,
    authority_invalidated: true,
    self_revoked: false,
    ...overrides
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
