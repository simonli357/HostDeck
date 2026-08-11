import { Buffer } from "node:buffer";
import { closeSync, fstatSync, fsyncSync, ftruncateSync, writeSync } from "node:fs";
import {
  type HostDeckFileLock,
  type HostDeckFileLockPort,
  nativeHostDeckFileLockPort
} from "./platform-file-lock.js";
import {
  type HostDeckPathSecurityRepair,
  openSecureHostDeckRegularFile
} from "./secure-local-paths.js";

export type HostDeckDaemonLeaseErrorCode = "invalid_lease" | "lease_held" | "lease_io_failed";

export class HostDeckDaemonLeaseError extends Error {
  constructor(
    readonly code: HostDeckDaemonLeaseErrorCode,
    message: string,
    readonly lease_path: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostDeckDaemonLeaseError";
  }
}

export interface AcquireHostDeckDaemonLeaseInput {
  readonly lease_path: string;
  readonly lock_port?: HostDeckFileLockPort;
  readonly now?: () => Date;
  readonly pid?: number;
}

export interface HostDeckDaemonLease {
  readonly lease_path: string;
  readonly acquired_at: string;
  readonly pid: number;
  readonly security_repair: HostDeckPathSecurityRepair | null;
  readonly replaced_stale_metadata: boolean;
  readonly released: boolean;
  readonly release: () => void;
}

const activeDaemonLeases = new WeakMap<HostDeckDaemonLease, () => void>();

export function acquireHostDeckDaemonLease(input: AcquireHostDeckDaemonLeaseInput): HostDeckDaemonLease {
  const leasePath = typeof input.lease_path === "string" ? input.lease_path : "<unknown>";
  const now = input.now ?? (() => new Date());
  let acquiredAt: string;
  try {
    acquiredAt = parseTimestamp(now(), leasePath);
  } catch (error) {
    if (error instanceof HostDeckDaemonLeaseError) throw error;
    throw leaseError("invalid_lease", "HostDeck daemon lease clock failed.", leasePath, error);
  }
  const pid = parsePid(input.pid ?? process.pid, leasePath);
  let opened: ReturnType<typeof openSecureHostDeckRegularFile>;
  try {
    opened = openSecureHostDeckRegularFile(leasePath, {
      label: "daemon lease",
      mode: 0o600,
      create: true,
      repair_mode: true,
      writable: true
    });
  } catch (error) {
    throw leaseError("invalid_lease", "HostDeck daemon lease file is insecure.", leasePath, error);
  }
  const descriptor = opened.descriptor;
  let fileLock: HostDeckFileLock;

  try {
    const acquired = (input.lock_port ?? nativeHostDeckFileLockPort).tryAcquireExclusive(descriptor);
    if (acquired === null) {
      const closeError = closeDescriptor(descriptor);
      throw leaseError(
        "lease_held",
        "Another HostDeck daemon already owns this state directory.",
        opened.path,
        closeError ?? undefined
      );
    }
    fileLock = acquired;
  } catch (error) {
    if (error instanceof HostDeckDaemonLeaseError) throw error;
    const closeError = closeDescriptor(descriptor);
    const cause = closeError === null ? error : new AggregateError([error, closeError], "Lease acquisition and descriptor close failed.");
    throw leaseError("lease_io_failed", "HostDeck daemon lease could not be acquired.", opened.path, cause);
  }

  let replacedStaleMetadata: boolean;
  try {
    opened.verifyPath();
    replacedStaleMetadata = fstatSync(descriptor).size > 0;
    ftruncateSync(descriptor, 0);
    writeAll(descriptor, Buffer.from(`${JSON.stringify({ pid, acquired_at: acquiredAt })}\n`, "utf8"));
    fsyncSync(descriptor);
    opened.verifyPath();
  } catch (error) {
    const cleanupErrors = unlockAndClose(fileLock, descriptor);
    const cause = cleanupErrors.length === 0 ? error : new AggregateError([error, ...cleanupErrors], "Lease metadata and cleanup failed.");
    throw leaseError("lease_io_failed", "HostDeck daemon lease metadata could not be written.", opened.path, cause);
  }

  let released = false;
  const lease: HostDeckDaemonLease = {
    lease_path: opened.path,
    acquired_at: acquiredAt,
    pid,
      security_repair: opened.repair,
    replaced_stale_metadata: replacedStaleMetadata,
    get released() {
      return released;
    },
    release() {
      if (released) return;
      released = true;
      activeDaemonLeases.delete(lease);
      const cleanupErrors = unlockAndClose(fileLock, descriptor);
      if (cleanupErrors.length > 0) {
        throw leaseError(
          "lease_io_failed",
          "HostDeck daemon lease could not be released cleanly.",
          opened.path,
          cleanupErrors.length === 1 ? cleanupErrors[0] : new AggregateError(cleanupErrors, "Lease unlock and close failed.")
        );
      }
    }
  };
  activeDaemonLeases.set(lease, opened.verifyPath);
  return Object.freeze(lease);
}

export function requireActiveHostDeckDaemonLease(
  candidate: unknown,
  expectedLeasePath: string
): HostDeckDaemonLease {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !activeDaemonLeases.has(candidate as HostDeckDaemonLease) ||
    (candidate as HostDeckDaemonLease).released ||
    !sameNativePath(
      (candidate as HostDeckDaemonLease).lease_path,
      expectedLeasePath
    )
  ) {
    throw leaseError(
      "invalid_lease",
      "HostDeck database recovery requires the active daemon lease for its state directory.",
      expectedLeasePath
    );
  }
  const lease = candidate as HostDeckDaemonLease;
  try {
    activeDaemonLeases.get(lease)?.();
  } catch (error) {
    throw leaseError(
      "invalid_lease",
      "HostDeck database recovery lease identity changed.",
      expectedLeasePath,
      error
    );
  }
  return lease;
}

function parseTimestamp(candidate: Date, leasePath: string): string {
  if (!(candidate instanceof Date) || !Number.isFinite(candidate.getTime())) {
    throw leaseError("invalid_lease", "HostDeck daemon lease clock returned an invalid date.", leasePath);
  }
  return candidate.toISOString();
}

function parsePid(candidate: number, leasePath: string): number {
  if (!Number.isSafeInteger(candidate) || candidate < 1) {
    throw leaseError("invalid_lease", "HostDeck daemon lease pid must be a positive safe integer.", leasePath);
  }
  return candidate;
}

function sameNativePath(left: unknown, right: string): boolean {
  if (typeof left !== "string") return false;
  if (process.platform !== "win32") return left === right;
  return left.replaceAll("/", "\\").toLowerCase() ===
    right.replaceAll("/", "\\").toLowerCase();
}

function writeAll(descriptor: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) {
    const written = writeSync(descriptor, data, offset, data.length - offset, offset);
    if (written < 1) throw new Error("HostDeck daemon lease metadata write made no progress.");
    offset += written;
  }
}

function unlockAndClose(lock: HostDeckFileLock, descriptor: number): unknown[] {
  const errors: unknown[] = [];
  try {
    lock.release();
  } catch (error) {
    errors.push(error);
  }
  const closeError = closeDescriptor(descriptor);
  if (closeError !== null) errors.push(closeError);
  return errors;
}

function closeDescriptor(descriptor: number): unknown | null {
  try {
    closeSync(descriptor);
    return null;
  } catch (error) {
    return error;
  }
}

function leaseError(
  code: HostDeckDaemonLeaseErrorCode,
  message: string,
  leasePath: string,
  cause?: unknown
): HostDeckDaemonLeaseError {
  if (cause instanceof HostDeckDaemonLeaseError) return cause;
  return new HostDeckDaemonLeaseError(code, message, leasePath, { cause });
}
