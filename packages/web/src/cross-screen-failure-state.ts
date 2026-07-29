import { parseIsoTimestamp } from "@hostdeck/core";
import type {
  BrowserConnectionFailure,
  BrowserConnectionFailureSource,
  BrowserConnectionSnapshot
} from "./connection-state.js";

export type CrossScreenRouteTarget = "mission_control" | "session_detail";
type CrossScreenRecoverableFailureSource = Extract<
  BrowserConnectionFailureSource,
  "access" | "host_status" | "session_list" | "session_detail" | "session_stream"
>;

export interface CrossScreenObservationFact {
  readonly label: string;
  readonly observedAt: string | null;
  readonly display: string | null;
}

export interface CrossScreenRecoveredFailure {
  readonly source: CrossScreenRecoverableFailureSource;
  readonly title: string;
  readonly detail: string;
  readonly observedAt: string | null;
}

const utcTimestampFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  month: "short",
  timeZone: "UTC",
  year: "numeric"
});

export function projectCrossScreenStaleObservations(
  snapshot: BrowserConnectionSnapshot,
  route: CrossScreenRouteTarget
): readonly CrossScreenObservationFact[] {
  const facts: CrossScreenObservationFact[] = [];
  const targetData = snapshot.targetState.data;
  const targetMatches =
    snapshot.target?.kind === route && targetData?.kind === route;

  if (
    targetMatches &&
    targetData !== null &&
    snapshot.targetState.state !== "current"
  ) {
    facts.push(
      observationFact(
        route === "mission_control" ? "Session list" : "Session detail",
        snapshot.targetState.observedAt
      )
    );
  }

  if (snapshot.access.data !== null && snapshot.access.state !== "current") {
    facts.push(observationFact("Access", snapshot.access.observedAt));
  }

  if (
    route === "session_detail" &&
    targetMatches &&
    targetData?.kind === "session_detail" &&
    targetData.response.session.session.freshness !== "current"
  ) {
    facts.push(
      observationFact(
        "Session state",
        targetData.response.session.session.updated_at
      )
    );
  }

  return Object.freeze(facts);
}

export function projectCrossScreenStaleHostObservation(
  snapshot: BrowserConnectionSnapshot
): CrossScreenObservationFact | null {
  return snapshot.host.data !== null && snapshot.host.state !== "current"
    ? observationFact("Host status", snapshot.host.observedAt)
    : null;
}

export function formatCrossScreenObservationFacts(
  facts: readonly CrossScreenObservationFact[]
): string | null {
  if (facts.length === 0) return null;
  return facts
    .map((fact) =>
      fact.display === null
        ? `${fact.label} confirmation time unavailable.`
        : `${fact.label} last confirmed ${fact.display}.`
    )
    .join(" ");
}

export function projectCrossScreenRecoveredFailure(
  snapshot: BrowserConnectionSnapshot
): CrossScreenRecoveredFailure | null {
  const failure = snapshot.lastFailure;
  if (
    failure === null ||
    !isRecoverableFailureSource(failure.source) ||
    !failurePrecedesRecovery(failure, snapshot) ||
    !recoveredSourceIsCurrent(snapshot, failure.source)
  ) {
    return null;
  }

  const copy = recoveredSourceCopy(failure.source);
  const observedAt = normalizedTimestamp(failure.observedAt);
  const observedCopy = observedAt === null
    ? "Issue time unavailable."
    : `Issue observed ${formatUtcTimestamp(observedAt)}.`;
  return Object.freeze({
    source: failure.source,
    title: copy.title,
    detail: `${observedCopy} ${copy.currentLabel} is current again. This prior issue remains visible until the target or access changes.`,
    observedAt
  });
}

function observationFact(
  label: string,
  candidate: string | null
): CrossScreenObservationFact {
  const observedAt = normalizedTimestamp(candidate);
  return Object.freeze({
    label,
    observedAt,
    display: observedAt === null ? null : formatUtcTimestamp(observedAt)
  });
}

function normalizedTimestamp(candidate: unknown): string | null {
  if (typeof candidate !== "string") return null;
  const parsed = parseIsoTimestamp(candidate);
  return parsed.ok ? parsed.value : null;
}

function formatUtcTimestamp(timestamp: string): string {
  return `${utcTimestampFormatter.format(new Date(timestamp))} UTC`;
}

function recoveredSourceIsCurrent(
  snapshot: BrowserConnectionSnapshot,
  source: CrossScreenRecoverableFailureSource
): boolean {
  switch (source) {
    case "access":
      return (
        snapshot.access.state === "current" &&
        snapshot.access.data !== null &&
        snapshot.access.failure === null
      );
    case "host_status":
      return (
        snapshot.host.state === "current" &&
        snapshot.host.data !== null &&
        snapshot.host.failure === null
      );
    case "session_list":
      return (
        snapshot.target?.kind === "mission_control" &&
        snapshot.targetState.state === "current" &&
        snapshot.targetState.data?.kind === "mission_control" &&
        snapshot.targetState.failure === null
      );
    case "session_detail":
      return (
        snapshot.target?.kind === "session_detail" &&
        snapshot.targetState.state === "current" &&
        snapshot.targetState.data?.kind === "session_detail" &&
        snapshot.targetState.failure === null
      );
    case "session_stream":
      return (
        snapshot.target?.kind === "session_detail" &&
        snapshot.stream.state === "connected" &&
        snapshot.stream.snapshot !== null &&
        snapshot.stream.failure === null
      );
  }
}

function failurePrecedesRecovery(
  failure: BrowserConnectionFailure,
  snapshot: BrowserConnectionSnapshot
): boolean {
  // Stream reconnects are ordered within one target epoch; request-backed recovery needs a later load.
  return failure.source === "session_stream"
    ? failure.epoch <= snapshot.epoch
    : failure.epoch < snapshot.epoch;
}

function recoveredSourceCopy(
  source: CrossScreenRecoverableFailureSource
): Readonly<{ title: string; currentLabel: string }> {
  switch (source) {
    case "access":
      return Object.freeze({
        title: "Previous access issue recovered",
        currentLabel: "Access"
      });
    case "host_status":
      return Object.freeze({
        title: "Previous host-status issue recovered",
        currentLabel: "Host status"
      });
    case "session_list":
      return Object.freeze({
        title: "Previous session-list issue recovered",
        currentLabel: "Session list"
      });
    case "session_detail":
      return Object.freeze({
        title: "Previous session-detail issue recovered",
        currentLabel: "Session detail"
      });
    case "session_stream":
      return Object.freeze({
        title: "Previous activity-stream issue recovered",
        currentLabel: "Activity stream"
      });
  }
}

function isRecoverableFailureSource(
  source: BrowserConnectionFailureSource
): source is CrossScreenRecoverableFailureSource {
  return (
    source === "access" ||
    source === "host_status" ||
    source === "session_list" ||
    source === "session_detail" ||
    source === "session_stream"
  );
}
