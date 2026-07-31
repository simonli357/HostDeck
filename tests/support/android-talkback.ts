export const physicalTalkBackObserverCategories = Object.freeze([
  "approval_result",
  "back_to_mission",
  "chrome_control",
  "known_hostdeck",
  "mission_control",
  "model_close",
  "model_dialog",
  "model_settings",
  "model_state",
  "model_trigger",
  "platform_deny",
  "platform_permission",
  "remote_status",
  "selected_session",
  "session_detail",
  "unknown"
] as const);

export type PhysicalTalkBackObserverCategory =
  (typeof physicalTalkBackObserverCategories)[number];
export type PhysicalTalkBackObserverEventKind = "focus" | "click";
export type PhysicalTalkBackObserverClass =
  | "button"
  | "edit"
  | "other"
  | "text"
  | "view";

export interface PhysicalTalkBackObserverEvent {
  readonly bounds: Readonly<{
    readonly bottom: number;
    readonly left: number;
    readonly right: number;
    readonly top: number;
  }>;
  readonly category: PhysicalTalkBackObserverCategory;
  readonly className: PhysicalTalkBackObserverClass;
  readonly clickable: boolean;
  readonly enabled: boolean;
  readonly focusable: boolean;
  readonly kind: PhysicalTalkBackObserverEventKind;
  readonly sequence: number;
  readonly visible: boolean;
}

export type PhysicalTalkBackObserverRecord =
  | Readonly<{ readonly kind: "ready" }>
  | Readonly<{ readonly kind: "overflow" }>
  | Readonly<{ readonly kind: "error"; readonly stage: string }>
  | Readonly<{
      readonly kind: "event";
      readonly event: PhysicalTalkBackObserverEvent;
    }>;

export interface PhysicalTalkBackTranscriptSummary {
  readonly clickCount: number;
  readonly eventCount: number;
  readonly firstSequence: number;
  readonly focusCount: number;
  readonly lastSequence: number;
  readonly transcript: readonly string[];
}

const observerCategorySet = new Set<string>(physicalTalkBackObserverCategories);
const observerClassSet = new Set<string>([
  "button",
  "edit",
  "other",
  "text",
  "view"
]);
const observerErrorStages = new Set([
  "arguments",
  "disconnect",
  "overflow",
  "runtime",
  "shutdown",
  "timeout"
]);
const modalCategories = new Set<PhysicalTalkBackObserverCategory>([
  "model_close",
  "model_dialog",
  "model_settings",
  "model_state"
]);

export function parsePhysicalTalkBackObserverLine(
  line: string
): PhysicalTalkBackObserverRecord | null {
  const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (normalized === "") return null;
  if (normalized === "HOSTDECK_OBSERVER_READY") {
    return Object.freeze({ kind: "ready" });
  }
  if (normalized === "HOSTDECK_OBSERVER_OVERFLOW") {
    return Object.freeze({ kind: "overflow" });
  }
  const errorMatch = /^HOSTDECK_OBSERVER_ERROR=([a-z_]{1,24})$/u.exec(normalized);
  if (errorMatch !== null) {
    const stage = errorMatch[1];
    if (stage === undefined || !observerErrorStages.has(stage)) {
      throw new TypeError("TalkBack observer error stage was invalid.");
    }
    return Object.freeze({ kind: "error", stage });
  }
  const eventMatch = /^HOSTDECK_EVENT=([1-9][0-9]{0,2})\|(focus|click)\|([a-z_]{1,24})\|(button|edit|other|text|view)\|([01])\|([01])\|([01])\|([01])\|(-?[0-9]{1,5})\|(-?[0-9]{1,5})\|(-?[0-9]{1,5})\|(-?[0-9]{1,5})$/u.exec(
    normalized
  );
  if (eventMatch === null) {
    throw new TypeError("TalkBack observer emitted unrecognized output.");
  }
  const [
    ,
    sequenceValue,
    kind,
    category,
    className,
    clickable,
    enabled,
    focusable,
    visible,
    leftValue,
    topValue,
    rightValue,
    bottomValue
  ] = eventMatch;
  if (
    sequenceValue === undefined ||
    (kind !== "focus" && kind !== "click") ||
    category === undefined ||
    !observerCategorySet.has(category) ||
    className === undefined ||
    !observerClassSet.has(className) ||
    clickable === undefined ||
    enabled === undefined ||
    focusable === undefined ||
    visible === undefined ||
    leftValue === undefined ||
    topValue === undefined ||
    rightValue === undefined ||
    bottomValue === undefined
  ) {
    throw new TypeError("TalkBack observer event fields were invalid.");
  }
  const bounds = Object.freeze({
    bottom: readBoundedCoordinate(bottomValue),
    left: readBoundedCoordinate(leftValue),
    right: readBoundedCoordinate(rightValue),
    top: readBoundedCoordinate(topValue)
  });
  if (bounds.left >= bounds.right || bounds.top >= bounds.bottom) {
    throw new TypeError("TalkBack observer event bounds were invalid.");
  }
  const sequence = Number.parseInt(sequenceValue, 10);
  if (sequence > 128) {
    throw new TypeError("TalkBack observer event sequence was invalid.");
  }
  return Object.freeze({
    kind: "event",
    event: Object.freeze({
      bounds,
      category: category as PhysicalTalkBackObserverCategory,
      className: className as PhysicalTalkBackObserverClass,
      clickable: clickable === "1",
      enabled: enabled === "1",
      focusable: focusable === "1",
      kind,
      sequence,
      visible: visible === "1"
    })
  });
}

export function validatePhysicalTalkBackTranscript(
  events: readonly PhysicalTalkBackObserverEvent[]
): PhysicalTalkBackTranscriptSummary {
  requireTranscript(events.length >= 16 && events.length <= 128);
  let lastFocus: PhysicalTalkBackObserverEvent | null = null;
  for (const [index, event] of events.entries()) {
    const previous = events[index - 1];
    requireTranscript(
      Number.isSafeInteger(event.sequence) &&
        event.sequence >= 1 &&
        event.sequence <= 128 &&
        (previous === undefined || event.sequence === previous.sequence + 1)
    );
    requireTranscript(
      event.category !== "unknown" &&
        event.category !== "platform_deny" &&
        event.category !== "platform_permission"
    );
    requireTranscript(event.enabled && event.visible);
    requireTranscript(
      Number.isSafeInteger(event.bounds.left) &&
        Number.isSafeInteger(event.bounds.top) &&
        Number.isSafeInteger(event.bounds.right) &&
        Number.isSafeInteger(event.bounds.bottom) &&
        event.bounds.left >= -10_000 &&
        event.bounds.top >= -10_000 &&
        event.bounds.right <= 10_000 &&
        event.bounds.bottom <= 10_000 &&
        event.bounds.left < event.bounds.right &&
        event.bounds.top < event.bounds.bottom
    );
    if (event.kind === "focus") {
      lastFocus = event;
      continue;
    }
    requireTranscript(
      event.clickable &&
        event.focusable &&
        lastFocus !== null &&
        lastFocus.category === event.category &&
        sameBounds(lastFocus, event)
    );
  }

  for (const category of [
    "selected_session",
    "model_trigger",
    "model_close",
    "back_to_mission"
  ] as const) {
    requireTranscript(
      events.filter(
        (event) => event.kind === "click" && event.category === category
      ).length === 1
    );
  }
  requireTranscript(
    events.every(
      (event) =>
        event.kind !== "click" ||
        event.category === "selected_session" ||
        event.category === "model_trigger" ||
        event.category === "model_close" ||
        event.category === "back_to_mission"
    )
  );

  const initialRemoteFocus = findEventIndex(
    events,
    0,
    "focus",
    "remote_status"
  );
  const initialMissionFocus = findEventIndex(
    events,
    initialRemoteFocus + 1,
    "focus",
    "mission_control"
  );
  const selectedSessionFocus = findEventIndex(
    events,
    initialMissionFocus + 1,
    "focus",
    "selected_session"
  );
  const selectedSessionClick = findEventIndex(
    events,
    selectedSessionFocus + 1,
    "click",
    "selected_session"
  );
  const sessionDetailFocus = findEventIndex(
    events,
    selectedSessionClick + 1,
    "focus",
    "session_detail"
  );
  const approvalResultFocus = findEventIndex(
    events,
    sessionDetailFocus + 1,
    "focus",
    "approval_result"
  );
  const modelTriggerFocus = findEventIndex(
    events,
    approvalResultFocus + 1,
    "focus",
    "model_trigger"
  );
  const modelTriggerClick = findEventIndex(
    events,
    modelTriggerFocus + 1,
    "click",
    "model_trigger"
  );
  const firstModalFocus = events.findIndex(
    (event, index) =>
      index > modelTriggerClick &&
      event.kind === "focus" &&
      modalCategories.has(event.category)
  );
  requireTranscript(firstModalFocus > modelTriggerClick);
  const modelCloseClick = findEventIndex(
    events,
    firstModalFocus + 1,
    "click",
    "model_close"
  );
  requireTranscript(
    events
      .slice(modelTriggerClick + 1, firstModalFocus)
      .every(
        (event) =>
          event.kind === "focus" && event.category === "model_trigger"
      )
  );
  requireTranscript(
    events
      .slice(firstModalFocus, modelCloseClick)
      .filter((event) => event.kind === "focus")
      .every((event) => modalCategories.has(event.category))
  );
  const returnedModelTriggerFocus = findEventIndex(
    events,
    modelCloseClick + 1,
    "focus",
    "model_trigger"
  );
  const backToMissionFocus = findEventIndex(
    events,
    returnedModelTriggerFocus + 1,
    "focus",
    "back_to_mission"
  );
  const backToMissionClick = findEventIndex(
    events,
    backToMissionFocus + 1,
    "click",
    "back_to_mission"
  );
  const recoveredMissionFocus = findEventIndex(
    events,
    backToMissionClick + 1,
    "focus",
    "mission_control"
  );
  findEventIndex(
    events,
    recoveredMissionFocus + 1,
    "focus",
    "remote_status"
  );

  const focusCount = events.filter((event) => event.kind === "focus").length;
  const clickCount = events.length - focusCount;
  const first = events[0];
  const last = events.at(-1);
  requireTranscript(first !== undefined && last !== undefined);
  return Object.freeze({
    clickCount,
    eventCount: events.length,
    firstSequence: first.sequence,
    focusCount,
    lastSequence: last.sequence,
    transcript: Object.freeze(
      events.map((event) => `${event.kind}:${event.category}`)
    )
  });
}

export async function runPhysicalTalkBackCleanupPlan(
  actions: readonly (() => void | Promise<void>)[]
): Promise<readonly unknown[]> {
  const failures: unknown[] = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      failures.push(error);
    }
  }
  return Object.freeze(failures);
}

function readBoundedCoordinate(value: string): number {
  const coordinate = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(coordinate) || coordinate < -10_000 || coordinate > 10_000) {
    throw new TypeError("TalkBack observer coordinate was invalid.");
  }
  return coordinate;
}

function sameBounds(
  left: PhysicalTalkBackObserverEvent,
  right: PhysicalTalkBackObserverEvent
): boolean {
  return (
    left.bounds.left === right.bounds.left &&
    left.bounds.top === right.bounds.top &&
    left.bounds.right === right.bounds.right &&
    left.bounds.bottom === right.bounds.bottom
  );
}

function findEventIndex(
  events: readonly PhysicalTalkBackObserverEvent[],
  start: number,
  kind: PhysicalTalkBackObserverEventKind,
  category: PhysicalTalkBackObserverCategory
): number {
  const index = events.findIndex(
    (event, candidate) =>
      candidate >= start && event.kind === kind && event.category === category
  );
  requireTranscript(index >= start);
  return index;
}

function requireTranscript(condition: boolean): asserts condition {
  if (!condition) {
    throw new TypeError("TalkBack transcript violated its ordered acceptance contract.");
  }
}
