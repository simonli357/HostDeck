import type { BrowserConnectionWriteBlockCause } from "./connection-state.js";

export type HostLockWriteBlockCause = Extract<
  BrowserConnectionWriteBlockCause,
  "host_lock_pending" | "host_lock_unconfirmed" | "host_locked"
>;

export const hostLockWriteReasons = Object.freeze({
  host_lock_pending: "A remote-write lock request is being confirmed.",
  host_lock_unconfirmed:
    "The last remote-write lock outcome is unconfirmed. Refresh HostDeck.",
  host_locked: "Remote writes are locked on the laptop."
} as const satisfies Readonly<Record<HostLockWriteBlockCause, string>>);

export function isHostLockWriteBlockCause(
  cause: BrowserConnectionWriteBlockCause
): cause is HostLockWriteBlockCause {
  return Object.hasOwn(hostLockWriteReasons, cause);
}

export function hostLockWriteReason(cause: HostLockWriteBlockCause): string {
  return hostLockWriteReasons[cause];
}
