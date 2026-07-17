import { describe, expect, it, vi } from "vitest";
import {
  assertHostDeckRemoteIngressRequestAuthorityPolicy,
  createHostDeckRemoteIngressRequestAuthorityPolicy,
  HostDeckRemoteIngressRequestAuthorityError
} from "./remote-ingress-request-authority.js";

const origin = "https://hostdeck-control.fixture-tailnet.ts.net";
const otherOrigin = "https://hostdeck-other.fixture-tailnet.ts.net";

describe("remote ingress request authority", () => {
  it("starts closed and rejects malformed admissions, acquisitions, and foreign leases", () => {
    const authority = createHostDeckRemoteIngressRequestAuthorityPolicy();
    assertHostDeckRemoteIngressRequestAuthorityPolicy(authority);
    expect(() =>
      assertHostDeckRemoteIngressRequestAuthorityPolicy({ ...authority })
    ).toThrow(TypeError);
    expect(authority.snapshot()).toEqual({
      acquired_leases: 0,
      active_leases: 0,
      admission_failures: 0,
      generation: 0,
      invalidations: 0,
      phase: "closed",
      refreshes: 0,
      rejected_acquisitions: 0,
      released_leases: 0,
      signaled_leases: 0
    });

    for (const malformed of [
      null,
      {},
      { admission: "open", external_origin: origin, generation: 0 },
      { admission: "closed", external_origin: origin, generation: 1 },
      { admission: "open", external_origin: "http://127.0.0.1", generation: 1 },
      { admission: "open", external_origin: origin, generation: 1, extra: true },
      Object.create({ admission: "open", external_origin: origin, generation: 1 }),
      Object.defineProperty({}, "admission", { enumerable: true, get: vi.fn() })
    ]) {
      expect(authority.synchronize(malformed)).toEqual(closed(0));
    }
    expect(() => authority.acquire(open(1))).toThrowError(
      new HostDeckRemoteIngressRequestAuthorityError("generation_stale")
    );
    expect(() =>
      authority.acquire({ external_origin: origin, generation: 0 })
    ).toThrowError(
      new HostDeckRemoteIngressRequestAuthorityError("invalid_admission")
    );
    expect(() =>
      authority.assertActive(
        Object.freeze({ generation: 1, signal: new AbortController().signal })
      )
    ).toThrowError(
      new HostDeckRemoteIngressRequestAuthorityError("invalid_lease")
    );
    expect(authority.snapshot()).toMatchObject({
      admission_failures: 8,
      phase: "closed",
      refreshes: 8,
      rejected_acquisitions: 1
    });
  });

  it("preserves leases across exact renewal and invalidates every lease once on closure", () => {
    const authority = createHostDeckRemoteIngressRequestAuthorityPolicy();
    expect(authority.synchronize(admissionOpen(4))).toEqual(admissionOpen(4));
    const first = authority.acquire(open(4));
    const second = authority.acquire(open(4));
    const firstAbort = vi.fn();
    const secondAbort = vi.fn();
    first.signal.addEventListener("abort", firstAbort);
    second.signal.addEventListener("abort", secondAbort);

    expect(authority.synchronize(admissionOpen(4))).toEqual(admissionOpen(4));
    authority.assertActive(first);
    authority.assertActive(second);
    expect(first.signal.aborted).toBe(false);

    expect(authority.synchronize(closed(4))).toEqual(closed(4));
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(firstAbort).toHaveBeenCalledOnce();
    expect(secondAbort).toHaveBeenCalledOnce();
    expect(() => authority.assertActive(first)).toThrowError(
      new HostDeckRemoteIngressRequestAuthorityError("generation_stale")
    );
    authority.release(first);
    authority.release(second);
    expect(authority.synchronize(closed(4))).toEqual(closed(4));
    expect(authority.snapshot()).toMatchObject({
      acquired_leases: 2,
      active_leases: 0,
      generation: 4,
      invalidations: 1,
      released_leases: 0,
      signaled_leases: 2
    });
  });

  it("releases one request without affecting siblings and replaces a changed generation", () => {
    const authority = createHostDeckRemoteIngressRequestAuthorityPolicy();
    authority.synchronize(admissionOpen(7));
    const released = authority.acquire(open(7));
    const retained = authority.acquire(open(7));

    authority.release(released);
    expect(released.signal.aborted).toBe(false);
    expect(() => authority.assertActive(released)).toThrowError(
      new HostDeckRemoteIngressRequestAuthorityError("lease_closed")
    );
    authority.assertActive(retained);

    authority.synchronize({
      admission: "open",
      external_origin: otherOrigin,
      generation: 8
    });
    expect(retained.signal.aborted).toBe(true);
    const replacement = authority.acquire({
      external_origin: otherOrigin,
      generation: 8
    });
    authority.assertActive(replacement);
    expect(authority.snapshot()).toMatchObject({
      acquired_leases: 3,
      active_leases: 1,
      generation: 8,
      invalidations: 1,
      released_leases: 1,
      signaled_leases: 1
    });
  });

  it("fails closed on regression or same-generation origin conflict and can recover exactly", () => {
    const authority = createHostDeckRemoteIngressRequestAuthorityPolicy();
    authority.synchronize(admissionOpen(10));
    const regressed = authority.acquire(open(10));
    expect(authority.synchronize(admissionOpen(9))).toEqual(closed(10));
    expect(regressed.signal.aborted).toBe(true);

    expect(authority.synchronize(admissionOpen(10))).toEqual(admissionOpen(10));
    const conflicted = authority.acquire(open(10));
    expect(
      authority.synchronize({
        admission: "open",
        external_origin: otherOrigin,
        generation: 10
      })
    ).toEqual(closed(10));
    expect(conflicted.signal.aborted).toBe(true);

    expect(authority.synchronize(admissionOpen(10))).toEqual(admissionOpen(10));
    const recovered = authority.acquire(open(10));
    authority.assertActive(recovered);
    const serialized = JSON.stringify(authority.snapshot());
    expect(serialized).not.toContain(origin);
    expect(serialized).not.toContain(otherOrigin);
  });

  it("retains the generation-to-origin binding while admission is temporarily closed", () => {
    const authority = createHostDeckRemoteIngressRequestAuthorityPolicy();
    authority.synchronize(admissionOpen(11));
    expect(authority.synchronize(closed(11))).toEqual(closed(11));

    expect(
      authority.synchronize({
        admission: "open",
        external_origin: otherOrigin,
        generation: 11
      })
    ).toEqual(closed(11));
    expect(authority.snapshot()).toMatchObject({
      admission_failures: 1,
      phase: "closed"
    });

    expect(authority.synchronize(admissionOpen(11))).toEqual(
      admissionOpen(11)
    );
    const recovered = authority.acquire(open(11));
    authority.assertActive(recovered);
  });

  it("closes permanently and never reopens or re-signals", () => {
    const authority = createHostDeckRemoteIngressRequestAuthorityPolicy();
    authority.synchronize(admissionOpen(12));
    const lease = authority.acquire(open(12));

    authority.close();
    authority.close();
    expect(lease.signal.aborted).toBe(true);
    expect(authority.synchronize(admissionOpen(13))).toEqual(closed(12));
    expect(() => authority.acquire(open(12))).toThrowError(
      new HostDeckRemoteIngressRequestAuthorityError("authority_closed")
    );
    expect(authority.snapshot()).toMatchObject({
      active_leases: 0,
      generation: 12,
      invalidations: 1,
      phase: "closed",
      signaled_leases: 1
    });
  });
});

function admissionOpen(generation: number) {
  return Object.freeze({
    admission: "open" as const,
    external_origin: origin,
    generation
  });
}

function open(generation: number) {
  return Object.freeze({ external_origin: origin, generation });
}

function closed(generation: number) {
  return Object.freeze({
    admission: "closed" as const,
    external_origin: null,
    generation
  });
}
