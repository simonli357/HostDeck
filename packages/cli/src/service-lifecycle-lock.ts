import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync
} from "node:fs";
import {
  type HostDeckFileLock,
  type HostDeckFileLockPort,
  nativeHostDeckFileLockPort
} from "@hostdeck/storage";

export type HostDeckServiceLifecycleLockErrorCode =
  | "invalid_lock"
  | "lock_held"
  | "lock_io_failed";

export class HostDeckServiceLifecycleLockError extends Error {
  constructor(
    readonly code: HostDeckServiceLifecycleLockErrorCode,
    options?: ErrorOptions
  ) {
    super("HostDeck service lifecycle lock operation failed.", options);
    this.name = "HostDeckServiceLifecycleLockError";
  }
}

export interface HostDeckServiceLifecycleLock {
  readonly released: boolean;
  readonly release: () => void;
}

export function acquireHostDeckServiceLifecycleLock(
  path: string,
  lockPort: HostDeckFileLockPort = nativeHostDeckFileLockPort
): HostDeckServiceLifecycleLock {
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDWR |
        fsConstants.O_CREAT |
        fsConstants.O_NOFOLLOW,
      0o600
    );
    assertDescriptorOwnsExactLock(path, descriptor);
    fsyncSync(descriptor);
  } catch (error) {
    throw lockError("invalid_lock", error);
  }

  let fileLock: HostDeckFileLock | null = null;
  try {
    const acquired = lockPort.tryAcquireExclusive(descriptor);
    if (acquired === null) {
      const closeError = closeDescriptor(descriptor);
      throw lockError("lock_held", closeError ?? undefined);
    }
    fileLock = acquired;
    assertDescriptorOwnsExactLock(path, descriptor);
  } catch (error) {
    if (error instanceof HostDeckServiceLifecycleLockError) throw error;
    const cleanupErrors: unknown[] = [];
    if (fileLock !== null) {
      try {
        fileLock.release();
      } catch (releaseError) {
        cleanupErrors.push(releaseError);
      }
    }
    const closeError = closeDescriptor(descriptor);
    if (closeError !== null) cleanupErrors.push(closeError);
    const cause = cleanupErrors.length === 0
      ? error
      : new AggregateError([error, ...cleanupErrors], "Lock acquisition cleanup failed.");
    throw lockError("lock_io_failed", cause);
  }
  const heldLock = fileLock;

  let released = false;
  return Object.freeze({
    get released() {
      return released;
    },
    release() {
      if (released) return;
      const errors: unknown[] = [];
      try {
        heldLock.release();
      } catch (error) {
        errors.push(error);
      }
      const closeError = closeDescriptor(descriptor);
      if (closeError !== null) errors.push(closeError);
      released = true;
      if (errors.length > 0) {
        throw lockError(
          "lock_io_failed",
          errors.length === 1
            ? errors[0]
            : new AggregateError(errors, "Lock release failed.")
        );
      }
    }
  });
}

function assertDescriptorOwnsExactLock(path: string, descriptor: number): void {
  const descriptorMetadata = fstatSync(descriptor);
  const pathMetadata = lstatSync(path);
  const uid = process.getuid?.();
  if (
    uid === undefined ||
    descriptorMetadata.dev !== pathMetadata.dev ||
    descriptorMetadata.ino !== pathMetadata.ino ||
    !descriptorMetadata.isFile() ||
    pathMetadata.isSymbolicLink() ||
    !pathMetadata.isFile() ||
    descriptorMetadata.uid !== uid ||
    descriptorMetadata.nlink !== 1 ||
    (descriptorMetadata.mode & 0o7777) !== 0o600 ||
    realpathSync.native(path) !== path
  ) {
    throw new TypeError("HostDeck service lifecycle lock is insecure.");
  }
}

function closeDescriptor(descriptor: number): unknown | null {
  try {
    closeSync(descriptor);
    return null;
  } catch (error) {
    return error;
  }
}

function lockError(
  code: HostDeckServiceLifecycleLockErrorCode,
  cause?: unknown
): HostDeckServiceLifecycleLockError {
  return new HostDeckServiceLifecycleLockError(
    code,
    cause === undefined ? undefined : { cause }
  );
}
