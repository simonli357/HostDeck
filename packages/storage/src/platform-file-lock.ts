// @ts-expect-error The dependency ships no declarations; runtime exports are validated below.
import nativeFileLockBindings from "fs-native-extensions";

export type HostDeckFileLockErrorCode =
  | "invalid_descriptor"
  | "lock_io_failed";

export class HostDeckFileLockError extends Error {
  constructor(
    readonly code: HostDeckFileLockErrorCode,
    options?: ErrorOptions
  ) {
    super("HostDeck file-lock operation failed.", options);
    this.name = "HostDeckFileLockError";
  }
}

export interface HostDeckFileLock {
  readonly released: boolean;
  readonly release: () => void;
}

export interface HostDeckFileLockPort {
  readonly tryAcquireExclusive: (descriptor: number) => HostDeckFileLock | null;
}

export interface HostDeckNativeFileLockBindings {
  readonly tryLock: (descriptor: number) => boolean;
  readonly unlock: (descriptor: number) => void;
}

export function createHostDeckFileLockPort(
  bindings: HostDeckNativeFileLockBindings
): HostDeckFileLockPort {
  if (
    bindings === null ||
    typeof bindings !== "object" ||
    typeof bindings.tryLock !== "function" ||
    typeof bindings.unlock !== "function"
  ) {
    throw lockError("lock_io_failed");
  }
  const tryLock = bindings.tryLock.bind(bindings);
  const unlock = bindings.unlock.bind(bindings);
  const activeDescriptors = new Set<number>();

  return Object.freeze({
    tryAcquireExclusive(descriptor: number): HostDeckFileLock | null {
      if (!Number.isSafeInteger(descriptor) || descriptor < 0) {
        throw lockError("invalid_descriptor");
      }
      if (activeDescriptors.has(descriptor)) return null;

      let acquired: boolean;
      try {
        acquired = tryLock(descriptor);
      } catch (error) {
        throw lockError("lock_io_failed", error);
      }
      if (acquired !== true && acquired !== false) {
        throw lockError("lock_io_failed");
      }
      if (!acquired) return null;

      activeDescriptors.add(descriptor);
      let released = false;
      return Object.freeze({
        get released() {
          return released;
        },
        release() {
          if (released) return;
          released = true;
          activeDescriptors.delete(descriptor);
          try {
            unlock(descriptor);
          } catch (error) {
            throw lockError("lock_io_failed", error);
          }
        }
      });
    }
  });
}

export const nativeHostDeckFileLockPort = createHostDeckFileLockPort(
  loadNativeFileLockBindings()
);

function loadNativeFileLockBindings(): HostDeckNativeFileLockBindings {
  const candidate: unknown = nativeFileLockBindings;
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw lockError("lock_io_failed");
  }
  const tryLock = Object.getOwnPropertyDescriptor(candidate, "tryLock")?.value;
  const unlock = Object.getOwnPropertyDescriptor(candidate, "unlock")?.value;
  if (typeof tryLock !== "function" || typeof unlock !== "function") {
    throw lockError("lock_io_failed");
  }
  return Object.freeze({
    tryLock: (descriptor: number) => tryLock(descriptor),
    unlock: (descriptor: number) => unlock(descriptor)
  });
}

function lockError(
  code: HostDeckFileLockErrorCode,
  cause?: unknown
): HostDeckFileLockError {
  return new HostDeckFileLockError(
    code,
    cause === undefined ? undefined : { cause }
  );
}
