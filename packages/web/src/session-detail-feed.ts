import {
  type SelectedProjectionEvent,
  selectedEventPageMaxSize,
  selectedProjectionEventSchema,
  sessionIdSchema
} from "@hostdeck/contracts";

export const sessionDetailFeedLimit = selectedEventPageMaxSize;

export type SessionDetailTone =
  | "focus"
  | "connected"
  | "attention"
  | "danger"
  | "muted";

export type SessionDetailTimelineIcon =
  | "user"
  | "agent"
  | "activity"
  | "progress"
  | "approval"
  | "control"
  | "runtime"
  | "boundary"
  | "unknown";

export interface SessionDetailFeedState {
  readonly sessionId: string;
  readonly events: readonly SelectedProjectionEvent[];
  readonly acceptedCount: number;
  readonly lastCursor: number | null;
}

export interface SessionDetailContinuityBoundary {
  readonly after: number | null;
  readonly cursor: number;
  readonly reason: "retention" | "disconnect" | "restart" | "schema_change";
}

export interface SessionDetailTimelineFact {
  readonly label: string;
  readonly value: string;
}

export interface SessionDetailTimelineItem {
  readonly key: string;
  readonly order: number;
  readonly icon: SessionDetailTimelineIcon;
  readonly tone: SessionDetailTone;
  readonly label: string;
  readonly stateLabel: string | null;
  readonly title: string;
  readonly body: string | null;
  readonly facts: readonly SessionDetailTimelineFact[];
  readonly capturedAt: string | null;
  readonly timeLabel: string | null;
  readonly contentNotice: string | null;
  readonly pending: boolean;
}

export type SessionDetailTimestampFormatter = (timestamp: string) => string;

interface WorkingTimelineItem {
  readonly identity: string | null;
  readonly item: SessionDetailTimelineItem;
}

export function createSessionDetailFeed(sessionId: string): SessionDetailFeedState {
  const parsed = sessionIdSchema.safeParse(sessionId);
  if (!parsed.success) {
    throw new TypeError("HostDeck Session Detail feed target is invalid.");
  }
  return Object.freeze({
    sessionId: parsed.data,
    events: Object.freeze([]),
    acceptedCount: 0,
    lastCursor: null
  });
}

export function appendSessionDetailEvent(
  state: SessionDetailFeedState,
  event: SelectedProjectionEvent
): SessionDetailFeedState {
  const parsed = selectedProjectionEventSchema.safeParse(event);
  if (!parsed.success) {
    throw new TypeError("HostDeck Session Detail event is invalid.");
  }
  const acceptedEvent = deepFreeze(parsed.data);
  if (acceptedEvent.session_id !== state.sessionId) {
    throw new TypeError("HostDeck Session Detail event target changed.");
  }

  const existing = state.events.find(
    (candidate) => candidate.cursor === acceptedEvent.cursor
  );
  if (existing !== undefined) {
    if (!equalExactData(existing, acceptedEvent)) {
      throw new TypeError("HostDeck Session Detail received a contradictory cursor.");
    }
    return state;
  }
  if (state.lastCursor !== null && acceptedEvent.cursor <= state.lastCursor) {
    throw new TypeError("HostDeck Session Detail received an out-of-order cursor.");
  }
  if (
    state.lastCursor !== null &&
    acceptedEvent.type !== "replay_boundary" &&
    acceptedEvent.cursor !== state.lastCursor + 1
  ) {
    throw new TypeError("HostDeck Session Detail received a cursor gap.");
  }
  if (
    state.lastCursor !== null &&
    acceptedEvent.type === "replay_boundary" &&
    acceptedEvent.after !== state.lastCursor
  ) {
    throw new TypeError("HostDeck Session Detail received an inconsistent boundary.");
  }
  if (!Number.isSafeInteger(state.acceptedCount + 1)) {
    throw new TypeError("HostDeck Session Detail event count is exhausted.");
  }

  const events = [...state.events, acceptedEvent]
    .sort((left, right) => left.cursor - right.cursor)
    .slice(-sessionDetailFeedLimit);
  return Object.freeze({
    sessionId: state.sessionId,
    events: Object.freeze(events),
    acceptedCount: state.acceptedCount + 1,
    lastCursor: acceptedEvent.cursor
  });
}

export function projectSessionDetailTimeline(
  feed: SessionDetailFeedState,
  boundary: SessionDetailContinuityBoundary | null,
  formatTimestamp: SessionDetailTimestampFormatter
): readonly SessionDetailTimelineItem[] {
  if (typeof formatTimestamp !== "function") {
    throw new TypeError("HostDeck Session Detail timestamp formatter is invalid.");
  }
  const working: WorkingTimelineItem[] = [];
  const messageIndexes = new Map<string, number>();

  for (const event of feed.events) {
    if (event.type === "message") {
      projectMessageEvent(working, messageIndexes, event, formatTimestamp);
      continue;
    }
    working.push(Object.freeze({
      identity: null,
      item: projectNonMessageEvent(event, formatTimestamp)
    }));
  }

  if (
    boundary !== null &&
    !feed.events.some(
      (event) => event.type === "replay_boundary" && event.cursor === boundary.cursor
    )
  ) {
    working.push(Object.freeze({
      identity: null,
      item: projectBoundary(
        `continuity:${boundary.reason}:${boundary.cursor}`,
        boundary.cursor - 0.5,
        boundary.reason,
        null,
        null,
        null
      )
    }));
  }

  return Object.freeze(
    working
      .map((entry) => entry.item)
      .sort((left, right) => left.order - right.order)
  );
}

function projectMessageEvent(
  working: WorkingTimelineItem[],
  indexes: Map<string, number>,
  event: Extract<SelectedProjectionEvent, { readonly type: "message" }>,
  formatTimestamp: SessionDetailTimestampFormatter
): void {
  const identity = event.item_id === null ? null : `${event.role}:${event.item_id}`;
  const existingIndex = identity === null ? undefined : indexes.get(identity);

  if (event.phase === "delta" && event.text.length === 0 && existingIndex === undefined) {
    return;
  }

  const label = event.role === "user" ? "You" : "Agent";
  const tone: SessionDetailTone = event.role === "user" ? "focus" : "connected";
  const icon: SessionDetailTimelineIcon = event.role === "user" ? "user" : "agent";
  const body = event.text.length === 0 ? "No message text was projected." : event.text;

  if (existingIndex === undefined) {
    const item = freezeTimelineItem({
      key: identity === null ? `message:${event.cursor}` : `message:${identity}`,
      order: event.cursor,
      icon,
      tone,
      label,
      stateLabel: event.phase === "delta" ? "Streaming" : null,
      title: event.phase === "delta" ? "Message in progress" : "Message",
      body,
      facts: [],
      capturedAt: event.captured_at,
      timeLabel: safeFormatTimestamp(event.captured_at, formatTimestamp),
      contentNotice: event.content_notice,
      pending: event.phase === "delta"
    });
    working.push(Object.freeze({ identity, item }));
    if (identity !== null) indexes.set(identity, working.length - 1);
    return;
  }

  const existing = working[existingIndex];
  if (existing === undefined) {
    throw new TypeError("HostDeck Session Detail message index is inconsistent.");
  }
  const prior = existing.item;
  const nextBody = event.phase === "completed"
    ? body
    : `${prior.body === "No message text was projected." ? "" : (prior.body ?? "")}${event.text}`;
  working[existingIndex] = Object.freeze({
    identity,
    item: freezeTimelineItem({
      ...prior,
      stateLabel: event.phase === "delta" ? "Streaming" : null,
      title: event.phase === "delta" ? "Message in progress" : "Message",
      body: nextBody.length === 0 ? "No message text was projected." : nextBody,
      capturedAt: event.captured_at,
      timeLabel: safeFormatTimestamp(event.captured_at, formatTimestamp),
      contentNotice:
        event.content_notice ??
        (event.phase === "delta" ? prior.contentNotice : null),
      pending: event.phase === "delta"
    })
  });
}

function projectNonMessageEvent(
  event: Exclude<SelectedProjectionEvent, { readonly type: "message" }>,
  formatTimestamp: SessionDetailTimestampFormatter
): SessionDetailTimelineItem {
  switch (event.type) {
    case "turn":
      return projectTurn(event, formatTimestamp);
    case "activity":
      return projectActivity(event, formatTimestamp);
    case "approval":
      return projectApproval(event, formatTimestamp);
    case "control":
      return projectControl(event, formatTimestamp);
    case "runtime":
      return projectRuntime(event, formatTimestamp);
    case "replay_boundary":
      return projectBoundary(
        `boundary:${event.cursor}`,
        event.cursor,
        event.reason,
        event.captured_at,
        safeFormatTimestamp(event.captured_at, formatTimestamp),
        event.content_notice
      );
    case "unknown_optional":
      return freezeTimelineItem({
        key: `unknown:${event.cursor}`,
        order: event.cursor,
        icon: "unknown",
        tone: "muted",
        label: "Activity",
        stateLabel: "Unrecognized",
        title: "Unrecognized optional activity",
        body: event.summary,
        facts: [],
        capturedAt: event.captured_at,
        timeLabel: safeFormatTimestamp(event.captured_at, formatTimestamp),
        contentNotice: event.content_notice,
        pending: false
      });
  }
}

function projectTurn(
  event: Extract<SelectedProjectionEvent, { readonly type: "turn" }>,
  formatTimestamp: SessionDetailTimestampFormatter
): SessionDetailTimelineItem {
  const state = turnState(event.state);
  return freezeTimelineItem({
    key: `turn:${event.cursor}`,
    order: event.cursor,
    icon: event.state === "failed" || event.state === "interrupted" ? "boundary" : "progress",
    tone: state.tone,
    label: "Progress",
    stateLabel: state.label,
    title: state.title,
    body: event.error?.message ?? null,
    facts: [],
    capturedAt: event.captured_at,
    timeLabel: safeFormatTimestamp(event.captured_at, formatTimestamp),
    contentNotice: event.content_notice,
    pending: event.state === "in_progress"
  });
}

function projectActivity(
  event: Extract<SelectedProjectionEvent, { readonly type: "activity" }>,
  formatTimestamp: SessionDetailTimestampFormatter
): SessionDetailTimelineItem {
  const failed = event.state === "failed";
  const pending = event.state === "started" || event.state === "updated";
  const label = activityLabel(event.activity);
  return freezeTimelineItem({
    key: `activity:${event.cursor}`,
    order: event.cursor,
    icon: pending ? "progress" : "activity",
    tone: failed ? "danger" : pending ? "attention" : "connected",
    label,
    stateLabel: activityStateLabel(event.state),
    title: event.title,
    body: event.detail,
    facts: [],
    capturedAt: event.captured_at,
    timeLabel: safeFormatTimestamp(event.captured_at, formatTimestamp),
    contentNotice: event.content_notice,
    pending
  });
}

function projectApproval(
  event: Extract<SelectedProjectionEvent, { readonly type: "approval" }>,
  formatTimestamp: SessionDetailTimestampFormatter
): SessionDetailTimelineItem {
  const pending = event.state === "pending";
  const tone: SessionDetailTone = event.state === "approved"
    ? "connected"
    : event.state === "denied"
      ? "danger"
      : event.state === "pending"
        ? "attention"
        : "muted";
  const facts: SessionDetailTimelineFact[] = [
    { label: "Action", value: event.action },
    { label: "Scope", value: event.scope },
    { label: "Risk", value: titleCase(event.risk) }
  ];
  if (event.reason !== null) facts.push({ label: "Reason", value: event.reason });
  return freezeTimelineItem({
    key: `approval:${event.cursor}`,
    order: event.cursor,
    icon: "approval",
    tone,
    label: "Approval",
    stateLabel: titleCase(event.state),
    title: pending ? "Approval required" : `Approval ${approvalResult(event.state)}`,
    body: pending
      ? "A response is required before this work can continue."
      : approvalResolution(event.state),
    facts,
    capturedAt: event.captured_at,
    timeLabel: safeFormatTimestamp(event.captured_at, formatTimestamp),
    contentNotice: event.content_notice,
    pending
  });
}

function projectControl(
  event: Extract<SelectedProjectionEvent, { readonly type: "control" }>,
  formatTimestamp: SessionDetailTimestampFormatter
): SessionDetailTimelineItem {
  const failed = event.state === "failed" || event.state === "unsupported";
  const pending = event.state === "updating";
  return freezeTimelineItem({
    key: `control:${event.cursor}`,
    order: event.cursor,
    icon: "control",
    tone: failed ? "danger" : pending ? "attention" : "connected",
    label: "Control",
    stateLabel: titleCase(event.state),
    title: `/${event.control}`,
    body: event.value_summary,
    facts: [],
    capturedAt: event.captured_at,
    timeLabel: safeFormatTimestamp(event.captured_at, formatTimestamp),
    contentNotice: event.content_notice,
    pending
  });
}

function projectRuntime(
  event: Extract<SelectedProjectionEvent, { readonly type: "runtime" }>,
  formatTimestamp: SessionDetailTimestampFormatter
): SessionDetailTimelineItem {
  const tone: SessionDetailTone = event.state === "ready"
    ? "connected"
    : event.state === "degraded"
      ? "attention"
      : "danger";
  return freezeTimelineItem({
    key: `runtime:${event.cursor}`,
    order: event.cursor,
    icon: "runtime",
    tone,
    label: "Runtime",
    stateLabel: titleCase(event.state),
    title: event.state === "ready" ? "Runtime connected" : "Runtime unavailable",
    body: event.message,
    facts: [],
    capturedAt: event.captured_at,
    timeLabel: safeFormatTimestamp(event.captured_at, formatTimestamp),
    contentNotice: event.content_notice,
    pending: false
  });
}

function projectBoundary(
  key: string,
  order: number,
  reason: SessionDetailContinuityBoundary["reason"],
  capturedAt: string | null,
  timeLabel: string | null,
  contentNotice: string | null
): SessionDetailTimelineItem {
  const copy = boundaryCopy(reason);
  return freezeTimelineItem({
    key,
    order,
    icon: "boundary",
    tone: "danger",
    label: "Boundary",
    stateLabel: copy.state,
    title: copy.title,
    body: copy.body,
    facts: [],
    capturedAt,
    timeLabel,
    contentNotice,
    pending: false
  });
}

function turnState(state: Extract<SelectedProjectionEvent, { type: "turn" }>["state"]): {
  readonly label: string;
  readonly title: string;
  readonly tone: SessionDetailTone;
} {
  switch (state) {
    case "idle":
      return { label: "Idle", title: "Turn is idle", tone: "muted" };
    case "in_progress":
      return { label: "Running", title: "Work in progress", tone: "connected" };
    case "waiting_for_input":
      return { label: "Needs input", title: "Input required", tone: "attention" };
    case "waiting_for_approval":
      return { label: "Needs approval", title: "Approval required", tone: "attention" };
    case "completed":
      return { label: "Completed", title: "Work completed", tone: "connected" };
    case "interrupted":
      return { label: "Interrupted", title: "Work interrupted", tone: "danger" };
    case "failed":
      return { label: "Failed", title: "Work failed", tone: "danger" };
    case "unknown":
      return { label: "Unknown", title: "Turn state is unknown", tone: "attention" };
  }
}

function activityLabel(
  activity: Extract<SelectedProjectionEvent, { type: "activity" }>["activity"]
): string {
  switch (activity) {
    case "command":
      return "Command";
    case "tool":
      return "Tool";
    case "file_change":
      return "File change";
    case "reasoning":
      return "Progress";
    case "compaction":
      return "Compaction";
    case "rate_limit":
      return "Rate limit";
    case "thread":
      return "Session";
    case "settings":
      return "Settings";
    case "usage":
      return "Usage";
    case "approval":
      return "Approval";
  }
}

function activityStateLabel(
  state: Extract<SelectedProjectionEvent, { type: "activity" }>["state"]
): string {
  switch (state) {
    case "started":
      return "Started";
    case "updated":
      return "In progress";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
  }
}

function approvalResult(
  state: Extract<SelectedProjectionEvent, { type: "approval" }>["state"]
): string {
  switch (state) {
    case "pending":
      return "required";
    case "approved":
      return "approved";
    case "denied":
      return "denied";
    case "expired":
      return "expired";
    case "superseded":
      return "superseded";
  }
}

function approvalResolution(
  state: Extract<SelectedProjectionEvent, { type: "approval" }>["state"]
): string {
  switch (state) {
    case "pending":
      return "A response is required before this work can continue.";
    case "approved":
      return "The request was approved.";
    case "denied":
      return "The request was denied.";
    case "expired":
      return "The request expired without a decision.";
    case "superseded":
      return "A newer request replaced this approval.";
  }
}

function boundaryCopy(reason: SessionDetailContinuityBoundary["reason"]): {
  readonly state: string;
  readonly title: string;
  readonly body: string;
} {
  switch (reason) {
    case "retention":
      return {
        state: "History limited",
        title: "Earlier activity unavailable",
        body: "Only retained activity after this boundary is available."
      };
    case "disconnect":
      return {
        state: "Disconnected",
        title: "Activity continuity interrupted",
        body: "The runtime disconnected before activity resumed."
      };
    case "restart":
      return {
        state: "Restarted",
        title: "Runtime restarted",
        body: "Activity after this point follows a runtime restart."
      };
    case "schema_change":
      return {
        state: "Compatibility change",
        title: "Activity format changed",
        body: "Earlier activity cannot be joined to the current format."
      };
  }
}

function freezeTimelineItem(
  input: Omit<SessionDetailTimelineItem, "facts"> & {
    readonly facts: readonly SessionDetailTimelineFact[];
  }
): SessionDetailTimelineItem {
  return Object.freeze({
    ...input,
    facts: Object.freeze(input.facts.map((fact) => Object.freeze({ ...fact })))
  });
}

function safeFormatTimestamp(
  timestamp: string,
  formatTimestamp: SessionDetailTimestampFormatter
): string {
  try {
    const value = Reflect.apply(formatTimestamp, undefined, [timestamp]) as unknown;
    return typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : "Time unavailable";
  } catch {
    return "Time unavailable";
  }
}

function titleCase(value: string): string {
  return value
    .split("_")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function equalExactData(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== typeof right) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => equalExactData(value, right[index]));
  }
  if (typeof left !== "object" || typeof right !== "object") return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) => Object.hasOwn(rightRecord, key) && equalExactData(leftRecord[key], rightRecord[key])
  );
}

function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
