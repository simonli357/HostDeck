import { Buffer } from "node:buffer";
import { closeSync, fstatSync, fsyncSync, ftruncateSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import {
  type HostDeckPathModeRepair,
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
  readonly now?: () => Date;
  readonly pid?: number;
}

export interface HostDeckDaemonLease {
  readonly lease_path: string;
  readonly acquired_at: string;
  readonly pid: number;
  readonly mode_repair: HostDeckPathModeRepair | null;
  readonly replaced_stale_metadata: boolean;
  readonly released: boolean;
  readonly release: () => void;
}

type FlockSync = typeof import("fs-ext")["flockSync"];
let cachedFlockSync: FlockSync | undefined;

function flockSync(descriptor: number, operation: "exnb" | "un"): void {
  cachedFlockSync ??= requireFlockSync();
  cachedFlockSync(descriptor, operation);
}

function requireFlockSync(): FlockSync {
  const module = createRequire(import.meta.url)("fs-ext") as { readonly flockSync?: unknown };
  if (typeof module.flockSync !== "function") {
    throw new TypeError("HostDeck daemon lease filesystem locking is unavailable.");
  }
  return module.flockSync as FlockSync;
}

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

  try {
    flockSync(descriptor, "exnb");
  } catch (error) {
    const closeError = closeDescriptor(descriptor);
    const cause = closeError === null ? error : new AggregateError([error, closeError], "Lease acquisition and descriptor close failed.");
    if (isLockContention(error)) {
      throw leaseError("lease_held", "Another HostDeck daemon already owns this state directory.", opened.path, cause);
    }
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
    const cleanupErrors = unlockAndClose(descriptor);
    const cause = cleanupErrors.length === 0 ? error : new AggregateError([error, ...cleanupErrors], "Lease metadata and cleanup failed.");
    throw leaseError("lease_io_failed", "HostDeck daemon lease metadata could not be written.", opened.path, cause);
  }

  let released = false;
  return {
    lease_path: opened.path,
    acquired_at: acquiredAt,
    pid,
    mode_repair: opened.repair,
    replaced_stale_metadata: replacedStaleMetadata,
    get released() {
      return released;
    },
    release() {
      if (released) return;
      released = true;
      const cleanupErrors = unlockAndClose(descriptor);
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

function writeAll(descriptor: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) {
    const written = writeSync(descriptor, data, offset, data.length - offset, offset);
    if (written < 1) throw new Error("HostDeck daemon lease metadata write made no progress.");
    offset += written;
  }
}

function unlockAndClose(descriptor: number): unknown[] {
  const errors: unknown[] = [];
  try {
    flockSync(descriptor, "un");
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

function isLockContention(error: unknown): boolean {
  return error instanceof Error && "code" in error && ["EAGAIN", "EWOULDBLOCK"].includes(String(error.code));
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
