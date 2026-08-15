import {
  defaultResourceBudget,
  resolveResourceBudget
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import {
  assertSseSubscriberAdmissionService,
  createSseSubscriberAdmissionService,
  HostDeckSseSubscriberAdmissionError,
  type SseSubscriberAdmissionErrorCode
} from "./sse-subscriber-admission.js";

describe("shared SSE subscriber admission", () => {
  it("accounts global and per-device capacity across independently owned streams", () => {
    const budget = resolveResourceBudget({
      sse_max_subscribers: 2,
      sse_max_subscribers_per_device: 1,
      sse_max_subscribers_per_session: 2
    });
    const admission = createSseSubscriberAdmissionService(budget);
    const device = admission.reserve({
      device_id: "client_catalog_a",
      subscriber_id: "catalog:a"
    });

    expectAdmissionError(
      () =>
        admission.reserve({
          device_id: "client_catalog_a",
          subscriber_id: "projection:a"
        }),
      "device_limit"
    );
    const local = admission.reserve({
      device_id: null,
      subscriber_id: "projection:local"
    });
    expectAdmissionError(
      () =>
        admission.reserve({
          device_id: "client_catalog_b",
          subscriber_id: "catalog:b"
        }),
      "global_limit"
    );
    expect(admission.snapshot()).toEqual({
      active_device_buckets: 1,
      active_subscribers: 2,
      rejected_subscribers: 2
    });

    expect(device.active).toBe(true);
    expect(device.release()).toBe(true);
    expect(device.release()).toBe(false);
    expect(local.release()).toBe(true);
    expect(admission.snapshot()).toEqual({
      active_device_buckets: 0,
      active_subscribers: 0,
      rejected_subscribers: 2
    });
  });

  it("rejects duplicate, malformed, and unbranded admission state without leaking leases", () => {
    const admission = createSseSubscriberAdmissionService(defaultResourceBudget);
    const lease = admission.reserve({
      device_id: null,
      subscriber_id: "catalog:duplicate"
    });
    expectAdmissionError(
      () =>
        admission.reserve({
          device_id: null,
          subscriber_id: "catalog:duplicate"
        }),
      "duplicate_subscriber"
    );

    for (const candidate of [
      null,
      {},
      { device_id: null, subscriber_id: "bad id" },
      { device_id: "bad id", subscriber_id: "catalog:bad-device" },
      { device_id: null, subscriber_id: "catalog:extra", extra: true }
    ]) {
      expectAdmissionError(() => admission.reserve(candidate), "invalid_input");
    }
    expect(() => assertSseSubscriberAdmissionService(admission)).not.toThrow();
    expect(() =>
      assertSseSubscriberAdmissionService(Object.freeze({ ...admission }))
    ).toThrow(HostDeckSseSubscriberAdmissionError);
    expect(() =>
      createSseSubscriberAdmissionService({ ...defaultResourceBudget })
    ).toThrow(HostDeckSseSubscriberAdmissionError);
    expect(admission.snapshot().active_subscribers).toBe(1);
    expect(lease.release()).toBe(true);
  });
});

function expectAdmissionError(
  operation: () => unknown,
  code: SseSubscriberAdmissionErrorCode
): void {
  try {
    operation();
    throw new Error("Expected SSE subscriber admission to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckSseSubscriberAdmissionError);
    expect((error as HostDeckSseSubscriberAdmissionError).code).toBe(code);
  }
}
