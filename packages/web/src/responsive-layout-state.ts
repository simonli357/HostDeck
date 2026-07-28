import { parseIsoTimestamp } from "@hostdeck/core";
import type {
  BrowserConnectionSnapshot,
  BrowserMissionControlData
} from "./connection-state.js";

export interface BrowserMissionNavigationContext {
  readonly data: BrowserMissionControlData;
  readonly observedAt: string;
  readonly sourceEpoch: number;
  readonly freshness: "current" | "stale";
}

type ResponsiveMissionContextSource = Pick<
  BrowserConnectionSnapshot,
  "epoch" | "target" | "phase" | "access" | "targetState"
>;

export function synchronizeResponsiveMissionContext(
  current: BrowserMissionNavigationContext | null,
  snapshot: ResponsiveMissionContextSource
): BrowserMissionNavigationContext | null {
  if (!hasReadableSessionAuthority(snapshot)) return null;

  const data = snapshot.targetState.data;
  if (snapshot.target?.kind !== "mission_control" || data?.kind !== "mission_control") {
    return current;
  }
  if (current?.data !== data) assertMissionContextSourceData(data);
  if (!Number.isSafeInteger(snapshot.epoch) || snapshot.epoch < 1) {
    throw new TypeError("HostDeck responsive Mission context has an invalid source epoch.");
  }
  const observedAt = snapshot.targetState.observedAt;
  if (observedAt === null || !parseIsoTimestamp(observedAt).ok) {
    throw new TypeError("HostDeck responsive Mission context has an invalid observation time.");
  }
  const freshness = snapshot.targetState.state === "current" ? "current" : "stale";
  if (
    current !== null &&
    current.data === data &&
    current.observedAt === observedAt &&
    current.sourceEpoch === snapshot.epoch &&
    current.freshness === freshness
  ) {
    return current;
  }
  return Object.freeze({
    data,
    observedAt,
    sourceEpoch: snapshot.epoch,
    freshness
  });
}

function assertMissionContextSourceData(data: BrowserMissionControlData): void {
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(data);
  } catch {
    throw new TypeError("HostDeck responsive Mission context has an invalid list contract.");
  }
  const expectedKeys = [
    "kind",
    "access",
    "sessions",
    "nextCursor",
    "hasMore",
    "pageCount"
  ] as const;
  if (
    !Object.isFrozen(data) ||
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !keys.includes(key)) ||
    typeof data.access !== "object" ||
    data.access === null ||
    !Object.isFrozen(data.access) ||
    !Array.isArray(data.sessions) ||
    !Object.isFrozen(data.sessions) ||
    (data.nextCursor !== null && typeof data.nextCursor !== "string") ||
    typeof data.hasMore !== "boolean" ||
    !Number.isSafeInteger(data.pageCount) ||
    data.pageCount < 1 ||
    (data.hasMore !== (data.nextCursor !== null))
  ) {
    throw new TypeError("HostDeck responsive Mission context has an invalid list contract.");
  }
}

function hasReadableSessionAuthority(snapshot: ResponsiveMissionContextSource): boolean {
  return (
    snapshot.phase !== "access_limited" &&
    snapshot.phase !== "closed" &&
    snapshot.access.state !== "blocked" &&
    snapshot.access.data?.can_read_sessions === true
  );
}
