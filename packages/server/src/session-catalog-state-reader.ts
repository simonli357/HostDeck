import { codexLoadedThreadProjectCue } from "@hostdeck/codex-adapter";
import {
  nativeCodexThreadIdSchema,
  type SharedSessionCatalogEntry,
  sharedSessionCatalogEntrySchema
} from "@hostdeck/contracts";
import type {
  SelectedSessionState,
  SelectedStateRepository
} from "@hostdeck/storage";

export type SessionCatalogStateReaderErrorCode =
  | "catalog_overflow"
  | "invalid_state"
  | "read_failed";

export class HostDeckSessionCatalogStateReaderError extends Error {
  constructor(
    readonly code: SessionCatalogStateReaderErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostDeckSessionCatalogStateReaderError";
  }
}

export interface SessionCatalogStateReader {
  readonly read: () => readonly SharedSessionCatalogEntry[];
  readonly readOne: (sessionId: string) => SharedSessionCatalogEntry | null;
}

export interface CreateSessionCatalogStateReaderInput {
  readonly max_sessions: number;
  readonly states: Pick<
    SelectedStateRepository,
    "get" | "getSharedMembership" | "list"
  >;
}

export function createSessionCatalogStateReader(
  input: CreateSessionCatalogStateReaderInput
): SessionCatalogStateReader {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Reflect.ownKeys(input).length !== 2 ||
    !Object.hasOwn(input, "max_sessions") ||
    !Object.hasOwn(input, "states") ||
    !Number.isSafeInteger(input.max_sessions) ||
    input.max_sessions < 1 ||
    input.states === null ||
    typeof input.states !== "object" ||
    typeof input.states.get !== "function" ||
    typeof input.states.getSharedMembership !== "function" ||
    typeof input.states.list !== "function"
  ) {
    throw new TypeError("Session catalog state-reader configuration is invalid.");
  }

  const states = input.states;
  const maxSessions = input.max_sessions;
  return Object.freeze({
    read(): readonly SharedSessionCatalogEntry[] {
      try {
        const entries = states
          .list()
          .map((state) => entryFromState(states, state))
          .filter((entry): entry is SharedSessionCatalogEntry => entry !== null)
          .sort(compareCatalogEntries);
        if (entries.length > maxSessions) {
          throw new HostDeckSessionCatalogStateReaderError(
            "catalog_overflow",
            "Tracked-session catalog exceeds its configured session bound."
          );
        }
        return Object.freeze(entries);
      } catch (error) {
        throw normalizeReadError(error);
      }
    },
    readOne(sessionId: string): SharedSessionCatalogEntry | null {
      try {
        const state = states.get(sessionId);
        return state === null ? null : entryFromState(states, state);
      } catch (error) {
        throw normalizeReadError(error);
      }
    }
  });
}

function entryFromState(
  states: Pick<SelectedStateRepository, "getSharedMembership">,
  state: SelectedSessionState
): SharedSessionCatalogEntry | null {
  const mapping = state.mapping;
  const projection = state.projection.session;
  if (
    mapping.disposition !== "selected" ||
    mapping.archived_at !== null ||
    projection.session_state === "archived"
  ) {
    return null;
  }

  const nativeId = nativeCodexThreadIdSchema.safeParse(mapping.codex_thread_id);
  if (!nativeId.success) return null;
  const membership = states.getSharedMembership(mapping.id);
  if (membership === null) return null;
  const membershipThreadId =
    membership.origin === "automatic"
      ? membership.native_thread_id
      : membership.codex_thread_id;
  if (
    String(membershipThreadId) !== String(nativeId.data) ||
    membership.session_id !== mapping.id
  ) {
    throw new HostDeckSessionCatalogStateReaderError(
      "invalid_state",
      "Tracked-session membership contradicts its durable mapping."
    );
  }

  const parsed = sharedSessionCatalogEntrySchema.safeParse({
    tracked: {
      native_thread_id: nativeId.data,
      internal_session_id: mapping.id,
      alias: mapping.name,
      cwd: mapping.cwd,
      project_cue: codexLoadedThreadProjectCue(mapping.cwd),
      branch: projection.branch,
      runtime_version: mapping.runtime_version,
      runtime_source: mapping.runtime_source,
      enrollment_origin:
        membership.origin === "automatic"
          ? membership.enrollment_origin
          : "reconciliation",
      archived: false,
      created_at: mapping.created_at,
      updated_at: mapping.updated_at,
      archived_at: null
    },
    projection
  });
  if (!parsed.success) {
    throw new HostDeckSessionCatalogStateReaderError(
      "invalid_state",
      "Tracked-session state cannot form a valid public catalog entry.",
      { cause: parsed.error }
    );
  }
  return deepFreeze(parsed.data);
}

function compareCatalogEntries(
  left: SharedSessionCatalogEntry,
  right: SharedSessionCatalogEntry
): number {
  const created = left.tracked.created_at.localeCompare(right.tracked.created_at);
  return created !== 0
    ? created
    : left.tracked.internal_session_id.localeCompare(
        right.tracked.internal_session_id
      );
}

function normalizeReadError(error: unknown): HostDeckSessionCatalogStateReaderError {
  if (error instanceof HostDeckSessionCatalogStateReaderError) return error;
  return new HostDeckSessionCatalogStateReaderError(
    "read_failed",
    "Tracked-session catalog storage read failed.",
    { cause: error }
  );
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
