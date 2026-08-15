import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultResourceBudget,
  selectedProjectionEventSchema,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "@hostdeck/contracts";
import {
  createSelectedStateRepository,
  deriveAutomaticSessionIdentity,
  openMigratedDatabase,
  selectedProjectedEventByteLength,
  selectedStateRevision
} from "@hostdeck/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCatalogPublishingStateRepository } from "./catalog-publishing-state-repository.js";
import {
  createSessionCatalogHub,
  HostDeckSessionCatalogHubError
} from "./session-catalog-hub.js";
import { createSessionCatalogStateReader } from "./session-catalog-state-reader.js";
import { createSseSubscriberAdmissionService } from "./sse-subscriber-admission.js";

const nativeThreadId = "019fc8bd-25ef-74c3-a3bf-c6e59e4122a4";
const createdAt = "2026-08-15T12:00:00.000Z";
const enrolledAt = "2026-08-15T12:01:00.000Z";
const archivedAt = "2026-08-15T12:02:00.000Z";
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("post-commit session catalog publication", () => {
  it("publishes automatic enrollment and archive only after durable state is readable", async () => {
    const harness = createHarness();
    try {
      const stream = harness.hub.open({
        after: null,
        authorization: "test",
        device_id: null,
        signal: new AbortController().signal,
        subscriber_id: "catalog:repository"
      });
      const iterator = stream[Symbol.asyncIterator]();
      await iterator.next();
      await iterator.next();

      const enrollment = automaticCandidate();
      const committed = harness.repository.enrollAutomatic(enrollment);
      expect(harness.durable.require(committed.state.mapping.id)).toEqual(
        committed.state
      );
      expect(await iterator.next()).toMatchObject({
        done: false,
        value: {
          type: "session_upsert",
          session: {
            tracked: {
              native_thread_id: nativeThreadId,
              internal_session_id: committed.state.mapping.id
            }
          }
        }
      });

      const archived = archive(committed.state);
      const replaced = harness.repository.replace(
        archived,
        selectedStateRevision(committed.state)
      );
      expect(harness.durable.require(replaced.mapping.id)).toEqual(replaced);
      expect(await iterator.next()).toMatchObject({
        done: false,
        value: {
          type: "session_remove",
          internal_session_id: replaced.mapping.id,
          reason: "archived"
        }
      });
      stream.close();
    } finally {
      harness.close();
    }
  });

  it("keeps a committed enrollment visible when publication fails and reports the exact failure", () => {
    let clockFailed = false;
    const observeFailure = vi.fn();
    const harness = createHarness(
      () => (clockFailed ? new Date(Number.NaN) : new Date(enrolledAt)),
      observeFailure
    );
    try {
      clockFailed = true;
      const enrollment = automaticCandidate();
      let thrown: unknown;
      try {
        harness.repository.enrollAutomatic(enrollment);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(HostDeckSessionCatalogHubError);
      expect((thrown as HostDeckSessionCatalogHubError).code).toBe(
        "publication_failed"
      );
      expect(observeFailure).toHaveBeenCalledTimes(1);
      expect(harness.durable.getByThreadId(nativeThreadId)).toEqual(
        enrollment.state
      );
      expect(harness.hub.snapshot()).toMatchObject({
        failure_code: "publication_failed",
        state: "failed"
      });
    } finally {
      harness.close();
    }
  });
});

function createHarness(
  now: () => Date = () => new Date(enrolledAt),
  observeFailure: (error: unknown) => void = () => undefined
) {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-catalog-publish-"));
  tempDirectories.push(directory);
  const opened = openMigratedDatabase(join(directory, "hostdeck.sqlite"), {
    now: () => new Date(enrolledAt)
  });
  const durable = createSelectedStateRepository(opened.db);
  const hub = createSessionCatalogHub({
    admission: createSseSubscriberAdmissionService(defaultResourceBudget),
    authorize: () => ({ ok: true }),
    create_stream_id: () => "catalog_repository_001",
    initial_cursor: 200,
    now,
    reader: createSessionCatalogStateReader({
      max_sessions: defaultResourceBudget.protocol_thread_max_loaded_reads,
      states: durable
    }),
    resource_budget: defaultResourceBudget
  });
  hub.initialize(1);
  const repository = createCatalogPublishingStateRepository({
    catalog: hub,
    observe_failure: observeFailure,
    states: durable
  });
  return {
    durable,
    hub,
    repository,
    close() {
      hub.close();
      opened.db.close();
    }
  };
}

function automaticCandidate() {
  const identity = deriveAutomaticSessionIdentity(
    nativeThreadId,
    "Side Cue App"
  );
  const boundary = selectedProjectionEventSchema.parse({
    session_id: identity.internal_session_id,
    cursor: 1,
    captured_at: enrolledAt,
    upstream_at: null,
    codex_event_id: null,
    codex_event_type: null,
    content_state: "complete",
    content_notice: null,
    type: "replay_boundary",
    after: null,
    next_cursor: 1,
    reason: "enrollment"
  });
  const boundaryRecord = {
    event: boundary,
    byte_length: selectedProjectedEventByteLength(boundary)
  };
  const mapping = selectedSessionMappingRecordSchema.parse({
    id: identity.internal_session_id,
    name: identity.alias,
    codex_thread_id: nativeThreadId,
    cwd: "/home/simonli/Videos/apps/side_cue_app",
    runtime_source: "codex_app_server",
    runtime_version: "0.147.0",
    disposition: "selected",
    created_at: createdAt,
    updated_at: enrolledAt,
    archived_at: null
  });
  const projection = selectedSessionProjectionRecordSchema.parse({
    session: {
      id: mapping.id,
      name: mapping.name,
      codex_thread_id: mapping.codex_thread_id,
      cwd: mapping.cwd,
      runtime_source: mapping.runtime_source,
      runtime_version: mapping.runtime_version,
      created_at: mapping.created_at,
      archived_at: null,
      session_state: "active",
      turn_state: "idle",
      attention: "none",
      freshness: "current",
      freshness_reason: null,
      updated_at: enrolledAt,
      last_activity_at: null,
      branch: "main",
      model: null,
      settings: null,
      goal: null,
      recent_summary: "Native Codex session enrolled.",
      last_event_cursor: 1
    },
    retained_event_count: 1,
    retained_event_bytes: boundaryRecord.byte_length,
    earliest_retained_cursor: 1,
    retention_boundary_cursor: null
  });
  return {
    membership: {
      session_id: mapping.id,
      native_thread_id: nativeThreadId,
      origin: "automatic" as const,
      enrollment_origin: "loaded_before" as const,
      enrolled_at: enrolledAt
    },
    state: { mapping, projection },
    events: [boundaryRecord],
    project_cue: "Side Cue App"
  };
}

function archive(
  state: ReturnType<typeof automaticCandidate>["state"]
): ReturnType<typeof automaticCandidate>["state"] {
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
