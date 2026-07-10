import { chmodSync, linkSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireHostDeckDaemonLease, HostDeckDaemonLeaseError } from "./daemon-lease.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0).reverse()) rmSync(path, { force: true, recursive: true });
});

describe("HostDeck daemon lease", () => {
  it("acquires one nonblocking owner, writes bounded metadata, and releases idempotently", () => {
    const leasePath = testLeasePath();
    const lease = acquireHostDeckDaemonLease({
      lease_path: leasePath,
      now: () => new Date("2026-07-09T22:00:00.000Z"),
      pid: 12_345
    });

    try {
      expect(lease).toMatchObject({
        lease_path: leasePath,
        acquired_at: "2026-07-09T22:00:00.000Z",
        pid: 12_345,
        mode_repair: null,
        replaced_stale_metadata: false,
        released: false
      });
      expect(JSON.parse(readFileSync(leasePath, "utf8"))).toEqual({
        pid: 12_345,
        acquired_at: "2026-07-09T22:00:00.000Z"
      });
      expect(lstatSync(leasePath).mode & 0o7777).toBe(0o600);
      expectLeaseError(() => acquireHostDeckDaemonLease({ lease_path: leasePath }), "lease_held");
    } finally {
      lease.release();
      lease.release();
    }
    expect(lease.released).toBe(true);
  });

  it("reacquires an unlocked stale lease file and replaces stale metadata", () => {
    const leasePath = testLeasePath();
    writeFileSync(leasePath, '{"pid":999,"acquired_at":"old"}\n', { mode: 0o666 });
    chmodSync(leasePath, 0o666);

    const lease = acquireHostDeckDaemonLease({
      lease_path: leasePath,
      now: () => new Date("2026-07-09T23:00:00.000Z"),
      pid: 54_321
    });
    try {
      expect(lease.replaced_stale_metadata).toBe(true);
      expect(lease.mode_repair).toMatchObject({ from_mode: 0o666, to_mode: 0o600 });
      expect(lstatSync(leasePath).mode & 0o7777).toBe(0o600);
      expect(JSON.parse(readFileSync(leasePath, "utf8"))).toEqual({
        pid: 54_321,
        acquired_at: "2026-07-09T23:00:00.000Z"
      });
    } finally {
      lease.release();
    }
  });

  it("rejects symlink leases and invalid clock or pid input", () => {
    const leasePath = testLeasePath();
    const target = join(leasePath, "..", "target.lock");
    writeFileSync(target, "", { mode: 0o600 });
    symlinkSync(target, leasePath);
    expectLeaseError(() => acquireHostDeckDaemonLease({ lease_path: leasePath }), "invalid_lease");

    const validPath = testLeasePath();
    expectLeaseError(
      () => acquireHostDeckDaemonLease({ lease_path: validPath, now: () => new Date(Number.NaN) }),
      "invalid_lease"
    );
    expectLeaseError(() => acquireHostDeckDaemonLease({ lease_path: validPath, pid: 0 }), "invalid_lease");
  });

  it("rejects a hard-linked lease inode", () => {
    const leasePath = testLeasePath();
    writeFileSync(leasePath, "", { mode: 0o600 });
    linkSync(leasePath, join(leasePath, "..", "lease-copy.lock"));
    expectLeaseError(() => acquireHostDeckDaemonLease({ lease_path: leasePath }), "invalid_lease");
  });
});

function testLeasePath(): string {
  const root = mkdtempSync(join(tmpdir(), "hostdeck-daemon-lease-"));
  cleanup.push(root);
  return join(root, "hostdeck.lock");
}

function expectLeaseError(work: () => unknown, code: HostDeckDaemonLeaseError["code"]): void {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckDaemonLeaseError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected HostDeckDaemonLeaseError ${code}.`);
}
