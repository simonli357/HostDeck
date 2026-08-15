import {
  compareSelectedSessionListOrder,
  type ManagedSessionProjection,
  type SessionCatalogEvent,
  sessionCatalogEventSchema
} from "@hostdeck/contracts";

export type BrowserSessionCatalogPhase =
  | "idle"
  | "resetting"
  | "current"
  | "boundary";

export interface BrowserMissionSessionItem {
  readonly session: ManagedSessionProjection;
}

export interface BrowserSessionCatalogData {
  readonly sessions: readonly BrowserMissionSessionItem[];
  readonly streamId: string;
  readonly cursor: number;
  readonly endpointGeneration: number;
  readonly observedAt: string;
}

export interface BrowserSessionCatalogBoundary {
  readonly streamId: string;
  readonly cursor: number;
  readonly reason: Extract<SessionCatalogEvent, { type: "catalog_boundary" }>["reason"];
  readonly detail: string;
  readonly observedAt: string;
}

interface BrowserSessionCatalogReset {
  readonly streamId: string;
  readonly cursor: number;
  readonly expectedSessionCount: number;
  readonly sessions: readonly BrowserMissionSessionItem[];
  readonly observedAt: string;
}

export interface BrowserSessionCatalogReducerState {
  readonly phase: BrowserSessionCatalogPhase;
  readonly data: BrowserSessionCatalogData | null;
  readonly reset: BrowserSessionCatalogReset | null;
  readonly boundary: BrowserSessionCatalogBoundary | null;
}

export function createBrowserSessionCatalogReducerState(): BrowserSessionCatalogReducerState {
  return freezeState({ phase: "idle", data: null, reset: null, boundary: null });
}

export function reduceBrowserSessionCatalogEvent(
  state: BrowserSessionCatalogReducerState,
  candidate: SessionCatalogEvent
): BrowserSessionCatalogReducerState {
  const parsed = sessionCatalogEventSchema.safeParse(candidate);
  if (!parsed.success) throw invalidCatalogEvent();
  const event = parsed.data;

  switch (event.type) {
    case "catalog_reset":
      return freezeState({
        phase: "resetting",
        data: state.data,
        reset: Object.freeze({
          streamId: event.stream_id,
          cursor: event.cursor,
          expectedSessionCount: event.expected_session_count,
          sessions: Object.freeze([]),
          observedAt: event.emitted_at
        }),
        boundary: null
      });
    case "session_upsert":
      return applyUpsert(state, event);
    case "session_remove":
      return applyRemove(state, event);
    case "catalog_ready":
      return applyReady(state, event);
    case "catalog_boundary":
      return applyBoundary(state, event);
  }
}

function applyUpsert(
  state: BrowserSessionCatalogReducerState,
  event: Extract<SessionCatalogEvent, { type: "session_upsert" }>
): BrowserSessionCatalogReducerState {
  const item = freezeItem(event.session.projection);
  if (state.phase === "resetting" && state.reset !== null) {
    assertNextEvent(state.reset, event);
    if (findIdentityCollision(state.reset.sessions, item) !== null) {
      throw invalidCatalogEvent();
    }
    const sessions = Object.freeze([...state.reset.sessions, item]);
    if (sessions.length > state.reset.expectedSessionCount) {
      throw invalidCatalogEvent();
    }
    return freezeState({
      phase: "resetting",
      data: state.data,
      reset: Object.freeze({
        ...state.reset,
        cursor: event.cursor,
        sessions,
        observedAt: event.emitted_at
      }),
      boundary: null
    });
  }
  if (state.phase !== "current" || state.data === null) {
    throw invalidCatalogEvent();
  }
  assertNextEvent(state.data, event);
  const collision = findIdentityCollision(state.data.sessions, item);
  if (collision !== null && collision.session.id !== item.session.id) {
    throw invalidCatalogEvent();
  }
  const sessions = collision === null
    ? [...state.data.sessions, item]
    : state.data.sessions.map((current) =>
        current.session.id === item.session.id ? item : current
      );
  sessions.sort((left, right) =>
    compareSelectedSessionListOrder(left.session, right.session)
  );
  return currentState({
    ...state.data,
    sessions: Object.freeze(sessions),
    cursor: event.cursor,
    observedAt: event.emitted_at
  });
}

function applyRemove(
  state: BrowserSessionCatalogReducerState,
  event: Extract<SessionCatalogEvent, { type: "session_remove" }>
): BrowserSessionCatalogReducerState {
  if (state.phase !== "current" || state.data === null) {
    throw invalidCatalogEvent();
  }
  assertNextEvent(state.data, event);
  const index = state.data.sessions.findIndex(
    (item) => item.session.id === event.internal_session_id
  );
  const item = state.data.sessions[index];
  if (
    index < 0 ||
    item === undefined ||
    String(item.session.codex_thread_id) !== String(event.native_thread_id)
  ) {
    throw invalidCatalogEvent();
  }
  return currentState({
    ...state.data,
    sessions: Object.freeze(state.data.sessions.filter((_, itemIndex) => itemIndex !== index)),
    cursor: event.cursor,
    observedAt: event.emitted_at
  });
}

function applyReady(
  state: BrowserSessionCatalogReducerState,
  event: Extract<SessionCatalogEvent, { type: "catalog_ready" }>
): BrowserSessionCatalogReducerState {
  const reset = state.reset;
  if (state.phase !== "resetting" || reset === null) {
    throw invalidCatalogEvent();
  }
  assertNextEvent(reset, event);
  if (
    reset.sessions.length !== reset.expectedSessionCount ||
    event.session_count !== reset.expectedSessionCount
  ) {
    throw invalidCatalogEvent();
  }
  const sessions = [...reset.sessions].sort((left, right) =>
    compareSelectedSessionListOrder(left.session, right.session)
  );
  assertStrictIdentityAndOrder(sessions);
  return currentState({
    sessions: Object.freeze(sessions),
    streamId: event.stream_id,
    cursor: event.cursor,
    endpointGeneration: event.endpoint_generation,
    observedAt: event.emitted_at
  });
}

function applyBoundary(
  state: BrowserSessionCatalogReducerState,
  event: Extract<SessionCatalogEvent, { type: "catalog_boundary" }>
): BrowserSessionCatalogReducerState {
  const source = state.phase === "resetting" ? state.reset : state.data;
  if (source === null) throw invalidCatalogEvent();
  assertNextEvent(source, event);
  return freezeState({
    phase: "boundary",
    data: state.data,
    reset: null,
    boundary: Object.freeze({
      streamId: event.stream_id,
      cursor: event.cursor,
      reason: event.reason,
      detail: event.detail,
      observedAt: event.emitted_at
    })
  });
}

function currentState(
  input: BrowserSessionCatalogData
): BrowserSessionCatalogReducerState {
  return freezeState({
    phase: "current",
    data: Object.freeze(input),
    reset: null,
    boundary: null
  });
}

function assertNextEvent(
  source: Readonly<{ streamId: string; cursor: number; observedAt: string }>,
  event: SessionCatalogEvent
): void {
  if (
    event.stream_id !== source.streamId ||
    event.cursor !== source.cursor + 1 ||
    event.emitted_at < source.observedAt
  ) {
    throw invalidCatalogEvent();
  }
}

function findIdentityCollision(
  sessions: readonly BrowserMissionSessionItem[],
  candidate: BrowserMissionSessionItem
): BrowserMissionSessionItem | null {
  const byInternal = sessions.find(
    (item) => item.session.id === candidate.session.id
  );
  const byNative = sessions.find(
    (item) => item.session.codex_thread_id === candidate.session.codex_thread_id
  );
  if (
    (byInternal === undefined) !== (byNative === undefined) ||
    (byInternal !== undefined && byNative !== undefined && byInternal !== byNative)
  ) {
    throw invalidCatalogEvent();
  }
  return byInternal ?? byNative ?? null;
}

function assertStrictIdentityAndOrder(
  sessions: readonly BrowserMissionSessionItem[]
): void {
  const internalIds = new Set<string>();
  const nativeIds = new Set<string>();
  for (const [index, item] of sessions.entries()) {
    if (
      internalIds.has(item.session.id) ||
      nativeIds.has(item.session.codex_thread_id)
    ) {
      throw invalidCatalogEvent();
    }
    internalIds.add(item.session.id);
    nativeIds.add(item.session.codex_thread_id);
    const previous = sessions[index - 1];
    if (
      previous !== undefined &&
      compareSelectedSessionListOrder(previous.session, item.session) >= 0
    ) {
      throw invalidCatalogEvent();
    }
  }
}

function freezeItem(session: ManagedSessionProjection): BrowserMissionSessionItem {
  return deepFreeze({ session });
}

function freezeState(
  state: BrowserSessionCatalogReducerState
): BrowserSessionCatalogReducerState {
  return Object.freeze(state);
}

function invalidCatalogEvent(): TypeError {
  return new TypeError("HostDeck browser session catalog event is invalid.");
}

function deepFreeze<Value>(value: Value, seen = new Set<object>()): Value {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
