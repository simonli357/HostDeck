import {
  type SharedSessionCatalogEntry,
  type SharedSessionMembershipRecord,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema,
  sharedSessionCatalogEntrySchema,
  sharedSessionMembershipRecordSchema
} from "@hostdeck/contracts";
import type {
  SelectedSessionState,
  SelectedStateRepository
} from "@hostdeck/storage";
import { describe, expect, it } from "vitest";
import {
  createSessionCatalogStateReader,
  HostDeckSessionCatalogStateReaderError,
  type SessionCatalogStateReaderErrorCode
} from "./session-catalog-state-reader.js";

const threadA = "019fc8bd-25ef-74c3-a3bf-c6e59e4122a4";
const threadB = "019fc8bd-25ef-74c3-a3bf-c6e59e4122a5";
const timestamp = "2026-08-15T12:00:00.000Z";

describe("durable session catalog state reader", () => {
  it("sorts eligible shared sessions and omits archived or membership-less legacy state", () => {
    const entryA = catalogEntry({
      internalId: "sess_catalog_reader_a",
      nativeId: threadA,
      createdAt: "2026-08-15T12:01:00.000Z",
      cwd: "/home/simonli/Videos/apps/marketpilot"
    });
    const entryB = catalogEntry({
      internalId: "sess_catalog_reader_b",
      nativeId: threadB,
      createdAt: timestamp,
      cwd: "/home/simonli/Videos/apps/side_cue_app"
    });
    const unmanaged = stateFromEntry(
      catalogEntry({
        internalId: "sess_catalog_reader_unmanaged",
        nativeId: "019fc8bd-25ef-74c3-a3bf-c6e59e4122a6"
      })
    );
    const archived = archive(stateFromEntry(entryA));
    const states = createStates(
      [stateFromEntry(entryA), stateFromEntry(entryB), unmanaged, archived],
      [automaticMembership(entryA), adoptedMembership(entryB)]
    );
    const reader = createSessionCatalogStateReader({
      max_sessions: 4,
      states
    });

    const catalog = reader.read();
    expect(catalog.map((entry) => entry.tracked.internal_session_id)).toEqual([
      "sess_catalog_reader_b",
      "sess_catalog_reader_a"
    ]);
    expect(catalog[0]).toMatchObject({
      tracked: {
        native_thread_id: threadB,
        project_cue: "side_cue_app",
        enrollment_origin: "reconciliation"
      }
    });
    expect(catalog[1]).toMatchObject({
      tracked: {
        native_thread_id: threadA,
        project_cue: "marketpilot",
        enrollment_origin: "loaded_before"
      }
    });
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog[0]?.tracked)).toBe(true);
    expect(reader.readOne("sess_catalog_reader_unmanaged")).toBeNull();
    expect(reader.readOne("sess_missing")).toBeNull();
  });

  it("rejects contradictory membership identity and bounded catalog overflow", () => {
    const entryA = catalogEntry({
      internalId: "sess_catalog_reader_a",
      nativeId: threadA
    });
    const entryB = catalogEntry({
      internalId: "sess_catalog_reader_b",
      nativeId: threadB
    });
    const mismatched = sharedSessionMembershipRecordSchema.parse({
      ...automaticMembership(entryA),
      native_thread_id: threadB
    });
    const contradiction = createSessionCatalogStateReader({
      max_sessions: 2,
      states: createStates([stateFromEntry(entryA)], [mismatched])
    });
    expectReaderError(() => contradiction.read(), "invalid_state");

    const overflow = createSessionCatalogStateReader({
      max_sessions: 1,
      states: createStates(
        [stateFromEntry(entryA), stateFromEntry(entryB)],
        [automaticMembership(entryA), automaticMembership(entryB)]
      )
    });
    expectReaderError(() => overflow.read(), "catalog_overflow");
  });

  it("normalizes storage exceptions and rejects incomplete configuration", () => {
    const states = createStates([], []);
    const failing = createSessionCatalogStateReader({
      max_sessions: 1,
      states: {
        ...states,
        get() {
          throw new Error("sqlite read failed");
        },
        list() {
          throw new Error("sqlite read failed");
        }
      }
    });
    expectReaderError(() => failing.read(), "read_failed");
    expectReaderError(() => failing.readOne("bad id"), "read_failed");

    for (const candidate of [
      null,
      {},
      { max_sessions: 0, states },
      { max_sessions: 1, states: {} },
      { max_sessions: 1, states, extra: true }
    ]) {
      expect(() => createSessionCatalogStateReader(candidate as never)).toThrow(
        TypeError
      );
    }
  });
});

function createStates(
  values: readonly SelectedSessionState[],
  memberships: readonly SharedSessionMembershipRecord[]
): Pick<SelectedStateRepository, "get" | "getSharedMembership" | "list"> {
  const bySession = new Map<string, SelectedSessionState>(
    values.map((state) => [state.mapping.id, state])
  );
  const membershipBySession = new Map<string, SharedSessionMembershipRecord>(
    memberships.map((membership) => [membership.session_id, membership])
  );
  return {
    get: (sessionId) => bySession.get(sessionId) ?? null,
    getSharedMembership: (sessionId) =>
      membershipBySession.get(sessionId) ?? null,
    list: () => [...values]
  };
}

function stateFromEntry(entry: SharedSessionCatalogEntry): SelectedSessionState {
  return {
    mapping: selectedSessionMappingRecordSchema.parse({
      id: entry.tracked.internal_session_id,
      name: entry.tracked.alias,
      codex_thread_id: entry.tracked.native_thread_id,
      cwd: entry.tracked.cwd,
      runtime_source: entry.tracked.runtime_source,
      runtime_version: entry.tracked.runtime_version,
      disposition: "selected",
      created_at: entry.tracked.created_at,
      updated_at: entry.tracked.updated_at,
      archived_at: entry.tracked.archived_at
    }),
    projection: selectedSessionProjectionRecordSchema.parse({
      session: entry.projection,
      retained_event_count: 0,
      retained_event_bytes: 0,
      earliest_retained_cursor: null,
      retention_boundary_cursor: null
    })
  };
}

function archive(state: SelectedSessionState): SelectedSessionState {
  const archivedAt = "2026-08-15T13:00:00.000Z";
  return {
    mapping: selectedSessionMappingRecordSchema.parse({
      ...state.mapping,
      archived_at: archivedAt,
      updated_at: archivedAt
    }),
    projection: selectedSessionProjectionRecordSchema.parse({
      ...state.projection,
      session: {
        ...state.projection.session,
        archived_at: archivedAt,
        session_state: "archived",
        updated_at: archivedAt
      }
    })
  };
}

function automaticMembership(
  entry: SharedSessionCatalogEntry
): SharedSessionMembershipRecord {
  return sharedSessionMembershipRecordSchema.parse({
    session_id: entry.tracked.internal_session_id,
    native_thread_id: entry.tracked.native_thread_id,
    origin: "automatic",
    enrollment_origin: "loaded_before",
    enrolled_at: timestamp
  });
}

function adoptedMembership(
  entry: SharedSessionCatalogEntry
): SharedSessionMembershipRecord {
  return sharedSessionMembershipRecordSchema.parse({
    session_id: entry.tracked.internal_session_id,
    codex_thread_id: entry.tracked.native_thread_id,
    origin: "adopted",
    adopted_at: timestamp,
    handoff_confirmed_at: timestamp
  });
}

function expectReaderError(
  operation: () => unknown,
  code: SessionCatalogStateReaderErrorCode
): void {
  try {
    operation();
    throw new Error("Expected session catalog read to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckSessionCatalogStateReaderError);
    expect((error as HostDeckSessionCatalogStateReaderError).code).toBe(code);
  }
}

function catalogEntry(
  input: {
    readonly createdAt?: string;
    readonly cwd?: string;
    readonly internalId?: string;
    readonly nativeId?: string;
  } = {}
): SharedSessionCatalogEntry {
  const createdAt = input.createdAt ?? timestamp;
  const cwd = input.cwd ?? "/home/simonli/Videos/apps/HostDeck";
  const internalId = input.internalId ?? "sess_catalog_reader_default";
  const nativeId = input.nativeId ?? threadA;
  const alias = internalId.replace(/^sess_/u, "").replaceAll("_", "-");
  return sharedSessionCatalogEntrySchema.parse({
    tracked: {
      native_thread_id: nativeId,
      internal_session_id: internalId,
      alias,
      cwd,
      project_cue: cwd.split("/").at(-1),
      branch: "main",
      runtime_version: "0.148.0",
      runtime_source: "codex_app_server",
      enrollment_origin: "loaded_before",
      archived: false,
      created_at: createdAt,
      updated_at: createdAt,
      archived_at: null
    },
    projection: {
      id: internalId,
      name: alias,
      codex_thread_id: nativeId,
      cwd,
      runtime_source: "codex_app_server",
      runtime_version: "0.148.0",
      created_at: createdAt,
      archived_at: null,
      session_state: "active",
      turn_state: "idle",
      attention: "none",
      freshness: "current",
      freshness_reason: null,
      updated_at: createdAt,
      last_activity_at: null,
      branch: "main",
      model: null,
      settings: null,
      goal: null,
      recent_summary: "Tracked session ready.",
      last_event_cursor: null
    }
  });
}
