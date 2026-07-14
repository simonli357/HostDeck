import {
  selectedCsrfBootstrapRequestSchema,
  selectedPairClaimRequestSchema
} from "@hostdeck/contracts";
import { selectedApiRouteManifest } from "@hostdeck/server";
import { describe, expect, it } from "vitest";
import {
  type BrowserPairingFetchPort,
  type BrowserPairingLocationPort,
  type BrowserPairingOperation,
  type BrowserPairingRequestInit,
  type BrowserPairingResponsePort,
  bootstrapBrowserPairing,
  browserCsrfBootstrapPath,
  browserPairClaimPath,
  browserPairingRequestMaxBytes,
  browserPairingResponseMaxBytes
} from "./pairing-bootstrap.js";

const origin = "https://private-laptop.fixture-tailnet.ts.net";
const code = "AbCdEfGhIjKlMnOpQrSt_1";
const fragment = `#pair=${code}`;
const csrfToken = "C".repeat(43);
const claimResponse = {
  device_id: "client_abcdefghijklmnopqrstuvwx",
  permission: "write",
  client_label: "Android phone",
  created_at: "2026-07-13T22:01:00.000Z",
  expires_at: "2026-10-11T22:01:00.000Z",
  csrf_bootstrap_required: true
} as const;
const csrfResponse = {
  csrf_token: csrfToken,
  csrf_generation: 2,
  rotated_at: "2026-07-13T22:01:01.000Z"
} as const;

describe("browser pairing bootstrap", () => {
  it("scrubs history before IDs or network, claims once, and bootstraps in-memory CSRF", async () => {
    const harness = createHarness(fragment, (path) =>
      jsonResponse(path === browserPairClaimPath ? claimResponse : csrfResponse)
    );

    const result = await bootstrapBrowserPairing(harness.options);

    expect(result).toEqual({
      state: "paired",
      device_id: claimResponse.device_id,
      permission: "write",
      client_label: "Android phone",
      device_expires_at: claimResponse.expires_at,
      csrf_token: csrfToken,
      csrf_generation: 2,
      csrf_rotated_at: csrfResponse.rotated_at
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(harness.order).toEqual([
      "history:/",
      "id:pair_claim",
      `fetch:${browserPairClaimPath}`,
      "id:csrf_bootstrap",
      `fetch:${browserCsrfBootstrapPath}`
    ]);
    expect(harness.location.hash).toBe("");
    expect(harness.historyStates).toEqual([{ retained: true }]);
    expect(harness.requests).toHaveLength(2);
    expect(harness.requests[0]).toEqual({
      path: browserPairClaimPath,
      init: expectedRequestInit(
        JSON.stringify({
          operation_id: "op_browser_pair_claim_test_0001",
          code
        })
      )
    });
    expect(harness.requests[1]).toEqual({
      path: browserCsrfBootstrapPath,
      init: expectedRequestInit(
        JSON.stringify({
          operation_id: "op_browser_csrf_bootstrap_test_0002"
        })
      )
    });
    expect(harness.requests.every(({ path }) => !path.includes(code))).toBe(true);
    expect(harness.requests.every(({ init }) => init.referrerPolicy === "no-referrer")).toBe(true);
    expect(
      harness.requests.every(
        ({ init }) =>
          new TextEncoder().encode(init.body).byteLength <= browserPairingRequestMaxBytes
      )
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain(code);
  });

  it("reads the fragment exactly once", async () => {
    let hashReads = 0;
    let backingHash = fragment;
    const base = createHarness("", (path) =>
      jsonResponse(path === browserPairClaimPath ? claimResponse : csrfResponse)
    );
    const location = Object.defineProperties(
      {
        origin,
        pathname: "/",
        search: ""
      },
      {
        hash: {
          enumerable: true,
          get() {
            hashReads += 1;
            return backingHash;
          }
        }
      }
    ) as BrowserPairingLocationPort;
    const result = await bootstrapBrowserPairing({
      ...base.options,
      location,
      history: {
        state: null,
        replaceState() {
          backingHash = "";
        }
      }
    });

    expect(result.state).toBe("paired");
    expect(hashReads).toBe(1);
    expect(backingHash).toBe("");
  });

  it("does nothing when startup has no fragment, including reload and back", async () => {
    const harness = createHarness("", () => {
      throw new Error("fetch must not run");
    });

    const first = await bootstrapBrowserPairing(harness.options);
    const reload = await bootstrapBrowserPairing(harness.options);
    harness.location.hash = "";
    const back = await bootstrapBrowserPairing(harness.options);

    expect([first, reload, back]).toEqual([
      { state: "no_fragment" },
      { state: "no_fragment" },
      { state: "no_fragment" }
    ]);
    expect(harness.order).toEqual([]);
    expect(harness.requests).toEqual([]);
  });

  it("scrubs every nonempty invalid entry before rejecting without network", async () => {
    const cases: ReadonlyArray<{
      readonly hash: string;
      readonly reason: "invalid_fragment" | "invalid_origin" | "invalid_route";
      readonly pathname?: string;
      readonly search?: string;
      readonly origin?: string;
    }> = [
      { hash: "#pair=short", reason: "invalid_fragment" },
      { hash: `#pair=${code}%20`, reason: "invalid_fragment" },
      { hash: `#code=${code}`, reason: "invalid_fragment" },
      { hash: `#pair=${"x".repeat(10_000)}`, reason: "invalid_fragment" },
      { hash: fragment, pathname: "/dashboard", reason: "invalid_route" },
      { hash: fragment, search: "?next=/", reason: "invalid_route" },
      { hash: fragment, origin: "https://private-laptop.example.com", reason: "invalid_origin" },
      { hash: fragment, origin: "http://private-laptop.fixture-tailnet.ts.net", reason: "invalid_origin" }
    ] as const;
    for (const scenario of cases) {
      const harness = createHarness(scenario.hash, () => {
        throw new Error("fetch must not run");
      });
      if (scenario.pathname !== undefined) harness.location.pathname = scenario.pathname;
      if (scenario.search !== undefined) harness.location.search = scenario.search;
      if (scenario.origin !== undefined) harness.location.origin = scenario.origin;

      const result = await bootstrapBrowserPairing(harness.options);

      expect(result, scenario.reason).toEqual({
        state: "entry_rejected",
        reason: scenario.reason
      });
      expect(harness.location.hash, scenario.reason).toBe("");
      expect(harness.order, scenario.reason).toEqual(["history:/"]);
      expect(harness.requests, scenario.reason).toEqual([]);
    }
  });

  it("fails closed when history replacement cannot remove the fragment", async () => {
    const harness = createHarness(fragment, () => {
      throw new Error("fetch must not run");
    });
    harness.options.history.replaceState = () => {
      harness.order.push("history:failed");
      throw new Error(code);
    };

    const result = await bootstrapBrowserPairing(harness.options);

    expect(result).toEqual({ state: "entry_rejected", reason: "history_unavailable" });
    expect(harness.order).toEqual(["history:failed"]);
    expect(harness.requests).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(code);
  });

  it("rejects operation-id failure after scrubbing and before dispatch", async () => {
    for (const createOperationId of [
      () => "invalid",
      () => {
        throw new Error(code);
      }
    ]) {
      const harness = createHarness(fragment, () => {
        throw new Error("fetch must not run");
      });
      harness.options.createOperationId = createOperationId;

      const result = await bootstrapBrowserPairing(harness.options);

      expect(result).toEqual({ state: "claim_unavailable" });
      expect(harness.location.hash).toBe("");
      expect(harness.requests).toEqual([]);
      expect(JSON.stringify(result)).not.toContain(code);
    }
  });

  it("scrubs before rejecting a missing fetch port", async () => {
    const harness = createHarness(fragment, () => {
      throw new Error("fetch must not run");
    });
    harness.options.fetch = null as never;

    const result = await bootstrapBrowserPairing(harness.options);

    expect(result).toEqual({ state: "claim_unavailable" });
    expect(harness.location.hash).toBe("");
    expect(harness.order).toEqual(["history:/"]);
  });

  it("still scrubs when prior history state cannot be read", async () => {
    const harness = createHarness(fragment, (path) =>
      jsonResponse(path === browserPairClaimPath ? claimResponse : csrfResponse)
    );
    let replacedState: unknown = "not-called";
    harness.options.history = {
      get state(): unknown {
        throw new Error(code);
      },
      replaceState(data, _unused, _url) {
        replacedState = data;
        harness.location.hash = "";
      }
    };

    const result = await bootstrapBrowserPairing(harness.options);

    expect(result.state).toBe("paired");
    expect(replacedState).toBeNull();
    expect(harness.location.hash).toBe("");
  });

  it("clears the mutable claim body immediately after fetch accepts it", async () => {
    const deferred = createDeferred<BrowserPairingResponsePort>();
    let retainedInit: BrowserPairingRequestInit | null = null;
    const harness = createHarness(fragment, (path, init) => {
      if (path === browserPairClaimPath) {
        retainedInit = init;
        return deferred.promise;
      }
      return jsonResponse(csrfResponse);
    });

    const pending = bootstrapBrowserPairing(harness.options);
    expect(harness.location.hash).toBe("");
    expect(retainedInit).not.toBeNull();
    expect((retainedInit as unknown as BrowserPairingRequestInit).body).toBe("");
    deferred.resolve(jsonResponse(claimResponse));

    await expect(pending).resolves.toMatchObject({ state: "paired" });
  });

  it("treats synchronous or asynchronous claim transport failure as unknown with no retry", async () => {
    for (const mode of ["throw", "reject"] as const) {
      let calls = 0;
      const harness = createHarness(fragment, () => {
        calls += 1;
        if (mode === "throw") throw new Error(code);
        return Promise.reject(new Error(code));
      });

      const result = await bootstrapBrowserPairing(harness.options);

      expect(result).toEqual({ state: "claim_unknown" });
      expect(calls).toBe(1);
      expect(harness.location.hash).toBe("");
      expect(JSON.stringify(result)).not.toContain(code);
    }
  });

  it("maps typed claim rejections without retaining server text", async () => {
    const cases = [
      { code: "permission_denied", status: 401, expected: { state: "claim_rejected", reason: "not_accepted" } },
      { code: "invalid_origin", status: 403, expected: { state: "claim_rejected", reason: "origin_rejected" } },
      { code: "rate_limited", status: 429, expected: { state: "claim_rate_limited" } },
      { code: "service_overloaded", status: 503, expected: { state: "claim_unavailable" } },
      { code: "storage_error", status: 500, expected: { state: "claim_unknown" } }
    ] as const;
    for (const scenario of cases) {
      const harness = createHarness(fragment, () =>
        jsonResponse(
          {
            error: {
              code: scenario.code,
              message: `private server detail ${code}`,
              retryable: scenario.code === "rate_limited"
            }
          },
          scenario.status
        )
      );

      const result = await bootstrapBrowserPairing(harness.options);

      expect(result).toEqual(scenario.expected);
      expect(harness.requests).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain(code);
      expect(JSON.stringify(result)).not.toContain("private server detail");
    }
  });

  it("bounds and validates claim response framing without a second request", async () => {
    const cases = [
      rawResponse("not json"),
      rawResponse(JSON.stringify(claimResponse), 200, { contentType: "text/plain" }),
      rawResponse(JSON.stringify(claimResponse), 200, {
        declaredLength: String(browserPairingResponseMaxBytes + 1)
      }),
      rawResponse("x".repeat(browserPairingResponseMaxBytes + 1)),
      jsonResponse({ ...claimResponse, extra: code }),
      jsonResponse({ ...claimResponse, device_id: "invalid" })
    ];
    for (const response of cases) {
      let calls = 0;
      const harness = createHarness(fragment, () => {
        calls += 1;
        return response;
      });

      const result = await bootstrapBrowserPairing(harness.options);

      expect(result).toEqual({ state: "claim_unknown" });
      expect(calls).toBe(1);
      expect(JSON.stringify(result)).not.toContain(code);
    }
  });

  it("snapshots response properties once and contains hostile accessors", async () => {
    const source = jsonResponse(claimResponse);
    const reads = { status: 0, ok: 0, headers: 0, body: 0 };
    const singleReadResponse = Object.defineProperties({}, {
      status: responseGetter(reads, "status", source.status),
      ok: responseGetter(reads, "ok", source.ok),
      headers: responseGetter(reads, "headers", source.headers),
      body: responseGetter(reads, "body", source.body)
    }) as BrowserPairingResponsePort;
    const accepted = createHarness(fragment, (path) =>
      path === browserPairClaimPath ? singleReadResponse : jsonResponse(csrfResponse)
    );

    await expect(bootstrapBrowserPairing(accepted.options)).resolves.toMatchObject({
      state: "paired"
    });
    expect(reads).toEqual({ status: 1, ok: 1, headers: 1, body: 1 });

    let calls = 0;
    const rejected = createHarness(fragment, () => {
      calls += 1;
      return Object.defineProperty({}, "status", {
        get() {
          throw new Error(code);
        }
      }) as BrowserPairingResponsePort;
    });
    const result = await bootstrapBrowserPairing(rejected.options);

    expect(result).toEqual({ state: "claim_unknown" });
    expect(calls).toBe(1);
    expect(JSON.stringify(result)).not.toContain(code);
  });

  it("never retries a successful claim when CSRF bootstrap fails", async () => {
    const csrfCases = [
      {
        response: jsonResponse(
          { error: { code: "permission_denied", message: "revoked", retryable: false } },
          401
        ),
        reason: "bootstrap_rejected"
      },
      { response: rawResponse("broken"), reason: "bootstrap_unknown" },
      { response: Promise.reject(new Error(code)), reason: "bootstrap_unknown" }
    ] as const;
    for (const scenario of csrfCases) {
      let claimCalls = 0;
      const harness = createHarness(fragment, (path) => {
        if (path === browserPairClaimPath) {
          claimCalls += 1;
          return jsonResponse(claimResponse);
        }
        return scenario.response;
      });

      const result = await bootstrapBrowserPairing(harness.options);

      expect(result).toMatchObject({
        state: "paired_csrf_unavailable",
        reason: scenario.reason,
        device_id: claimResponse.device_id
      });
      expect(result).not.toHaveProperty("csrf_token");
      expect(claimCalls).toBe(1);
      expect(harness.requests.filter(({ path }) => path === browserPairClaimPath)).toHaveLength(1);
    }
  });

  it("allows two tabs to race while the shared one-time claim creates at most one device", async () => {
    let consumed = false;
    let devicesCreated = 0;
    const sharedFetch = (tab: string): BrowserPairingFetchPort => async (path, init) => {
      const body = init.body;
      if (path === browserCsrfBootstrapPath) return jsonResponse(csrfResponse);
      selectedPairClaimRequestSchema.parse(JSON.parse(body));
      if (consumed) {
        return jsonResponse(
          { error: { code: "permission_denied", message: "not accepted", retryable: false } },
          401
        );
      }
      consumed = true;
      devicesCreated += 1;
      await Promise.resolve(tab);
      return jsonResponse(claimResponse);
    };
    const first = createHarness(fragment, sharedFetch("first"));
    const second = createHarness(fragment, sharedFetch("second"));

    const results = await Promise.all([
      bootstrapBrowserPairing(first.options),
      bootstrapBrowserPairing(second.options)
    ]);

    expect(results.map((result) => result.state).sort()).toEqual(["claim_rejected", "paired"]);
    expect(devicesCreated).toBe(1);
    expect(first.location.hash).toBe("");
    expect(second.location.hash).toBe("");
  });

  it("matches the exact selected route manifest", () => {
    const routes = selectedApiRouteManifest.filter((entry) =>
      ["pair_claim", "csrf_bootstrap"].includes(entry.id)
    );
    expect(routes.map(({ id, method, path }) => ({ id, method, path }))).toEqual([
      { id: "pair_claim", method: "POST", path: browserPairClaimPath },
      { id: "csrf_bootstrap", method: "POST", path: browserCsrfBootstrapPath }
    ]);
  });

  it("validates operation request contracts used by the browser", () => {
    expect(
      selectedPairClaimRequestSchema.parse(JSON.parse(
        expectedRequestInit(
          JSON.stringify({ operation_id: "op_browser_pair_claim_test_0001", code })
        ).body
      ))
    ).toMatchObject({ code });
    expect(
      selectedCsrfBootstrapRequestSchema.parse({
        operation_id: "op_browser_csrf_bootstrap_test_0002"
      })
    ).toBeDefined();
  });
});

interface MutableLocation {
  origin: string;
  pathname: string;
  search: string;
  hash: string;
}

interface CapturedRequest {
  readonly path: string;
  readonly init: BrowserPairingRequestInit;
}

function createHarness(
  hash: string,
  responder: BrowserPairingResponder
): {
  readonly location: MutableLocation;
  readonly order: string[];
  readonly requests: CapturedRequest[];
  readonly historyStates: unknown[];
  readonly options: {
    location: MutableLocation;
    history: { state: unknown; replaceState(data: unknown, unused: string, url: string): void };
    fetch: BrowserPairingFetchPort;
    createOperationId(operation: BrowserPairingOperation): string;
  };
} {
  const location: MutableLocation = { origin, pathname: "/", search: "", hash };
  const order: string[] = [];
  const requests: CapturedRequest[] = [];
  const historyStates: unknown[] = [];
  let operationIndex = 0;
  const options = {
    location,
    history: {
      state: { retained: true },
      replaceState(data: unknown, _unused: string, url: string) {
        order.push(`history:${url}`);
        historyStates.push(data);
        location.hash = "";
      }
    },
    fetch: (async (path, init) => {
      order.push(`fetch:${path}`);
      requests.push({ path, init: cloneInit(init) });
      expect(location.hash).toBe("");
      return await responder(path, init);
    }) as BrowserPairingFetchPort,
    createOperationId(operation: BrowserPairingOperation) {
      operationIndex += 1;
      order.push(`id:${operation}`);
      return `op_browser_${operation}_test_${String(operationIndex).padStart(4, "0")}`;
    }
  };
  return { location, order, requests, historyStates, options };
}

type BrowserPairingResponder = (
  path: Parameters<BrowserPairingFetchPort>[0],
  init: BrowserPairingRequestInit
) => BrowserPairingResponsePort | Promise<BrowserPairingResponsePort>;

function expectedRequestInit(body: string): BrowserPairingRequestInit {
  return {
    method: "POST",
    headers: {
      accept: "application/json",
      "cache-control": "no-store",
      "content-type": "application/json"
    },
    body,
    cache: "no-store",
    credentials: "include",
    mode: "same-origin",
    redirect: "error",
    referrerPolicy: "no-referrer"
  };
}

function cloneInit(init: BrowserPairingRequestInit): BrowserPairingRequestInit {
  return { ...init, headers: { ...init.headers } };
}

function jsonResponse(body: unknown, status = 200): BrowserPairingResponsePort {
  return rawResponse(JSON.stringify(body), status);
}

function rawResponse(
  body: string,
  status = 200,
  options: { readonly contentType?: string; readonly declaredLength?: string } = {}
): BrowserPairingResponsePort {
  const encoded = new TextEncoder().encode(body);
  let read = false;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        if (name.toLowerCase() === "content-type") {
          return options.contentType ?? "application/json; charset=utf-8";
        }
        if (name.toLowerCase() === "content-length") {
          return options.declaredLength ?? String(encoded.byteLength);
        }
        return null;
      }
    },
    body: {
      getReader() {
        return {
          async read() {
            if (read) return { done: true };
            read = true;
            return { done: false, value: encoded };
          },
          async cancel() {},
          releaseLock() {}
        };
      }
    }
  };
}

function responseGetter<T>(
  reads: Record<"status" | "ok" | "headers" | "body", number>,
  key: "status" | "ok" | "headers" | "body",
  value: T
): PropertyDescriptor {
  return {
    enumerable: true,
    get() {
      reads[key] = reads[key] + 1;
      if (reads[key] > 1) throw new Error(`${key} read more than once`);
      return value;
    }
  };
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
