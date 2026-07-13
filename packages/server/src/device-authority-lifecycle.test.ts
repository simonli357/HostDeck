import { describe, expect, it } from "vitest";
import {
  assertHostDeckActiveDeviceAuthorityPolicy,
  createHostDeckActiveDeviceAuthorityPolicy,
  HostDeckDeviceAuthorityError
} from "./device-authority-lifecycle.js";

describe("active paired-device authority lifecycle", () => {
  it("closes every target lease, isolates other devices, and rejects late acquisition", () => {
    const policy = createHostDeckActiveDeviceAuthorityPolicy();
    const first = policy.acquire("client_authority_alpha");
    const second = policy.acquire("client_authority_alpha");
    const other = policy.acquire("client_authority_bravo");
    const observed: unknown[] = [];
    first.signal.addEventListener("abort", () => observed.push(first.signal.reason), {
      once: true
    });

    expect(policy.invalidate("client_authority_alpha")).toEqual({
      alreadyInvalidated: false,
      closedLeases: 2
    });
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toBeInstanceOf(HostDeckDeviceAuthorityError);
    expect(observed[0]).toMatchObject({ code: "device_revoked" });
    expect(String((observed[0] as Error).message)).not.toContain("alpha");
    expect(() => policy.assertActive(first)).toThrowError(
      expect.objectContaining({ code: "device_revoked" })
    );
    expect(() => policy.acquire("client_authority_alpha")).toThrowError(
      expect.objectContaining({ code: "device_revoked" })
    );
    expect(() => policy.assertActive(other)).not.toThrow();
    expect(policy.invalidate("client_authority_alpha")).toEqual({
      alreadyInvalidated: true,
      closedLeases: 0
    });
    expect(policy.snapshot()).toEqual({
      acquired_leases: 3,
      active_leases: 1,
      invalidations: 2,
      rejected_acquisitions: 1,
      released_leases: 0,
      signaled_leases: 2,
      tracked_revocations: 1
    });
  });

  it("releases live leases idempotently and rejects foreign or closed leases", () => {
    const policy = createHostDeckActiveDeviceAuthorityPolicy();
    const foreignPolicy = createHostDeckActiveDeviceAuthorityPolicy();
    const lease = policy.acquire("client_authority_release");

    policy.release(lease);
    policy.release(lease);
    expect(() => policy.assertActive(lease)).toThrowError(
      expect.objectContaining({ code: "lease_closed" })
    );
    expect(() => foreignPolicy.assertActive(lease)).toThrowError(
      expect.objectContaining({ code: "invalid_lease" })
    );
    expect(policy.snapshot()).toMatchObject({
      active_leases: 0,
      released_leases: 1
    });
  });

  it("requires factory identity and bounded selected device ids", () => {
    const policy = createHostDeckActiveDeviceAuthorityPolicy();
    expect(Object.isFrozen(policy)).toBe(true);
    expect(() => assertHostDeckActiveDeviceAuthorityPolicy(policy)).not.toThrow();
    expect(() =>
      assertHostDeckActiveDeviceAuthorityPolicy(Object.freeze({ ...policy }))
    ).toThrow();

    for (const invalid of ["", "client authority", "x".repeat(121), "client/authority"]) {
      expect(() => policy.acquire(invalid)).toThrowError(
        expect.objectContaining({ code: "invalid_device_id" })
      );
      expect(() => policy.invalidate(invalid)).toThrowError(
        expect.objectContaining({ code: "invalid_device_id" })
      );
    }
    expect(policy.snapshot()).toMatchObject({
      acquired_leases: 0,
      invalidations: 0,
      tracked_revocations: 0
    });
  });
});
