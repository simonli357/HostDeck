import { afterEach, describe, expect, it, vi } from "vitest";
import { createSecureBrowserOperationId } from "./browser-operation-id.js";
import { createProductionBrowserConnectionCoordinator } from "./browser-runtime.js";
import * as csrfClientModule from "./csrf-client.js";
import * as sseClientModule from "./sse-client.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("secure browser runtime composition", () => {
  it("creates selected operation ids only from a secure canonical UUID", () => {
    vi.stubGlobal("crypto", {
      randomUUID: () => "12345678-1234-4abc-8def-1234567890ab"
    });

    expect(createSecureBrowserOperationId("pair_claim")).toBe(
      "op_browser_pair_claim_1234567812344abc8def1234567890ab"
    );
    expect(createSecureBrowserOperationId("csrf_bootstrap")).toBe(
      "op_browser_csrf_bootstrap_1234567812344abc8def1234567890ab"
    );
  });

  it("fails closed for unsupported scope, missing crypto, throw, or malformed UUID", () => {
    vi.stubGlobal("crypto", undefined);
    expect(() => createSecureBrowserOperationId("pair_claim")).toThrow(TypeError);

    vi.stubGlobal("crypto", { randomUUID: () => "not-a-uuid" });
    expect(() => createSecureBrowserOperationId("csrf_bootstrap")).toThrow(TypeError);

    vi.stubGlobal("crypto", {
      randomUUID: () => {
        throw new Error("private crypto failure");
      }
    });
    expect(() => createSecureBrowserOperationId("pair_claim")).toThrow(
      "Secure browser operation-id generation failed."
    );

    vi.stubGlobal("crypto", { randomUUID: () => "12345678-1234-4abc-8def-1234567890ab" });
    expect(() => createSecureBrowserOperationId("unsupported" as never)).toThrow(TypeError);
  });

  it("constructs the production owner inertly at one selected origin", () => {
    const fetch = vi.fn();
    vi.stubGlobal("location", { origin: "http://127.0.0.1:4175" });
    vi.stubGlobal("fetch", fetch);

    const coordinator = createProductionBrowserConnectionCoordinator();

    expect(coordinator.snapshot().phase).toBe("idle");
    expect(fetch).not.toHaveBeenCalled();
    expect(coordinator.close().phase).toBe("closed");
    expect(coordinator.close().phase).toBe("closed");
  });

  it("rejects a non-selected document origin before network activity", () => {
    const fetch = vi.fn();
    vi.stubGlobal("location", { origin: "https://example.com" });
    vi.stubGlobal("fetch", fetch);

    expect(() => createProductionBrowserConnectionCoordinator()).toThrow(TypeError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("closes a partially constructed runtime when a later client fails", () => {
    const closeCsrf = vi.fn();
    vi.stubGlobal("location", { origin: "http://127.0.0.1:4175" });
    vi.spyOn(csrfClientModule, "createBrowserCsrfClient").mockReturnValue({
      close: closeCsrf
    } as never);
    vi.spyOn(sseClientModule, "createBrowserSseClient").mockImplementation(() => {
      throw new Error("private SSE constructor detail");
    });

    expect(() => createProductionBrowserConnectionCoordinator()).toThrow(
      "private SSE constructor detail"
    );
    expect(closeCsrf).toHaveBeenCalledTimes(1);
  });
});
