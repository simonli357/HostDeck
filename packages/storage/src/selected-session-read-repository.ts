import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  compareSelectedSessionListOrder,
  compareSelectedSessionListSortKeys,
  type SelectedSessionListInput,
  type SelectedSessionListOrderEntry,
  type SelectedSessionListPage,
  type SelectedSessionMappingRecord,
  type SelectedSessionReadItem,
  selectedSessionListInputSchema,
  selectedSessionListMaximumActiveSessions,
  selectedSessionListOrderEntrySchema,
  selectedSessionListPageSchema,
  selectedSessionListSortKey,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema,
  selectedSessionReadItemSchema,
  sessionIdSchema
} from "@hostdeck/contracts";
import type Database from "better-sqlite3";

export type SelectedSessionReadRepositoryErrorCode =
  | "invalid_input"
  | "invalid_state"
  | "read_failed"
  | "session_archived"
  | "session_list_changed"
  | "session_list_overflow"
  | "session_recovery_required";

export class HostDeckSelectedSessionReadRepositoryError extends Error {
  constructor(
    readonly code: SelectedSessionReadRepositoryErrorCode,
    message: string
  ) {
    super(message);
    this.name = "HostDeckSelectedSessionReadRepositoryError";
  }
}

export interface SelectedSessionReadRepository {
  readonly get: (sessionId: string) => SelectedSessionReadItem | null;
  readonly list: (input: SelectedSessionListInput) => SelectedSessionListPage;
}

interface OrderingScanRow {
  readonly mapping_id: unknown;
  readonly disposition: unknown;
  readonly projection_session_id: unknown;
  readonly projection_session_state: unknown;
  readonly projection_attention: unknown;
  readonly projection_last_activity_at: unknown;
}

interface SessionReadRow {
  readonly mapping_id: unknown;
  readonly mapping_name: unknown;
  readonly mapping_codex_thread_id: unknown;
  readonly mapping_cwd: unknown;
  readonly mapping_runtime_source: unknown;
  readonly mapping_runtime_version: unknown;
  readonly mapping_disposition: unknown;
  readonly mapping_created_at: unknown;
  readonly mapping_updated_at: unknown;
  readonly mapping_archived_at: unknown;
  readonly projection_session_id: unknown;
  readonly projection_session_state: unknown;
  readonly projection_turn_state: unknown;
  readonly projection_attention: unknown;
  readonly projection_freshness: unknown;
  readonly projection_freshness_reason: unknown;
  readonly projection_updated_at: unknown;
  readonly projection_last_activity_at: unknown;
  readonly projection_branch: unknown;
  readonly projection_model: unknown;
  readonly projection_settings_json: unknown;
  readonly projection_goal_json: unknown;
  readonly projection_recent_summary: unknown;
  readonly projection_last_event_cursor: unknown;
  readonly projection_retained_event_count: unknown;
  readonly projection_retained_event_bytes: unknown;
  readonly projection_earliest_retained_cursor: unknown;
  readonly projection_retention_boundary_cursor: unknown;
  readonly actual_event_count: unknown;
  readonly actual_event_bytes: unknown;
  readonly invalid_event_rows: unknown;
  readonly replay_boundary_count: unknown;
  readonly actual_earliest_cursor: unknown;
  readonly actual_latest_cursor: unknown;
  readonly first_event_type: unknown;
}

interface OrderingScanEntry {
  readonly attention: SelectedSessionListOrderEntry["attention"];
  readonly id: SelectedSessionListOrderEntry["id"];
  readonly last_activity_at: SelectedSessionListOrderEntry["last_activity_at"];
}

const maximumSettingsJsonBytes = 1_024;
const maximumGoalJsonBytes = 4_096;
const orderingSnapshotDomain = "hostdeck:selected-session-order:v1";
const invalidEventRowSql = `
  CASE WHEN
    typeof(e.cursor) <> 'integer' OR
    e.cursor < 0 OR
    e.cursor > 9007199254740991 OR
    typeof(e.byte_length) <> 'integer' OR
    e.byte_length < 1 OR
    e.byte_length > 1000000 OR
    e.normalized_type IS NULL OR
    e.normalized_type NOT IN (
      'message', 'turn', 'activity', 'approval', 'control', 'runtime',
      'replay_boundary', 'unknown_optional'
    ) OR
    e.content_state IS NULL OR
    e.content_state NOT IN (
      'complete', 'redacted', 'truncated', 'redacted_and_truncated'
    )
  THEN 1 ELSE 0 END
`;

const attentionRankSql = `
  CASE p.attention
    WHEN 'needs_approval' THEN 60
    WHEN 'needs_input' THEN 50
    WHEN 'failed' THEN 40
    WHEN 'stuck' THEN 30
    WHEN 'unknown' THEN 30
    WHEN 'watch' THEN 20
    WHEN 'none' THEN 0
    ELSE -1
  END
`;

const sessionReadColumnsSql = `
  s.id AS mapping_id,
  s.name AS mapping_name,
  s.codex_thread_id AS mapping_codex_thread_id,
  s.cwd AS mapping_cwd,
  s.runtime_source AS mapping_runtime_source,
  s.runtime_version AS mapping_runtime_version,
  s.disposition AS mapping_disposition,
  s.created_at AS mapping_created_at,
  s.updated_at AS mapping_updated_at,
  s.archived_at AS mapping_archived_at,
  p.session_id AS projection_session_id,
  p.session_state AS projection_session_state,
  p.turn_state AS projection_turn_state,
  p.attention AS projection_attention,
  p.freshness AS projection_freshness,
  p.freshness_reason AS projection_freshness_reason,
  p.updated_at AS projection_updated_at,
  p.last_activity_at AS projection_last_activity_at,
  p.branch AS projection_branch,
  p.model AS projection_model,
  p.settings_json AS projection_settings_json,
  p.goal_json AS projection_goal_json,
  p.recent_summary AS projection_recent_summary,
  p.last_event_cursor AS projection_last_event_cursor,
  p.retained_event_count AS projection_retained_event_count,
  p.retained_event_bytes AS projection_retained_event_bytes,
  p.earliest_retained_cursor AS projection_earliest_retained_cursor,
  p.retention_boundary_cursor AS projection_retention_boundary_cursor
`;

export function createSelectedSessionReadRepository(
  db: Database.Database
): SelectedSessionReadRepository {
  const scanStatement = db.prepare(`
    SELECT
      s.id AS mapping_id,
      s.disposition AS disposition,
      p.session_id AS projection_session_id,
      p.session_state AS projection_session_state,
      p.attention AS projection_attention,
      p.last_activity_at AS projection_last_activity_at
    FROM selected_sessions AS s
    LEFT JOIN selected_session_projections AS p ON p.session_id = s.id
    WHERE s.archived_at IS NULL
    ORDER BY s.id ASC
    LIMIT ?
  `);

  const pageStatement = db.prepare(`
    WITH ordered_active AS (
      SELECT
        s.id AS id,
        ${attentionRankSql} AS attention_rank,
        CASE WHEN p.last_activity_at IS NULL THEN 1 ELSE 0 END AS activity_null_rank,
        p.last_activity_at AS last_activity_at
      FROM selected_sessions AS s
      JOIN selected_session_projections AS p ON p.session_id = s.id
      WHERE s.archived_at IS NULL
    ),
    page_ids AS (
      SELECT id, attention_rank, activity_null_rank, last_activity_at
      FROM ordered_active
      WHERE
        @has_after = 0 OR
        attention_rank < @after_attention_rank OR
        (
          attention_rank = @after_attention_rank AND
          (
            activity_null_rank > @after_activity_null_rank OR
            (
              activity_null_rank = @after_activity_null_rank AND
              (
                (@after_activity_null_rank = 0 AND last_activity_at < @after_last_activity_at) OR
                (
                  (@after_activity_null_rank = 1 OR last_activity_at = @after_last_activity_at) AND
                  id > @after_session_id
                )
              )
            )
          )
        )
      ORDER BY attention_rank DESC, activity_null_rank ASC, last_activity_at DESC, id ASC
      LIMIT @fetch_limit
    ),
    event_aggregates AS (
      SELECT
        e.session_id AS session_id,
        COUNT(*) AS event_count,
        COALESCE(SUM(e.byte_length), 0) AS event_bytes,
        MIN(e.cursor) AS earliest_cursor,
        MAX(e.cursor) AS latest_cursor,
        COALESCE(SUM(${invalidEventRowSql}), 0) AS invalid_event_rows,
        COALESCE(SUM(CASE WHEN e.normalized_type = 'replay_boundary' THEN 1 ELSE 0 END), 0) AS replay_boundary_count
      FROM selected_projected_events AS e
      JOIN page_ids AS page ON page.id = e.session_id
      GROUP BY e.session_id
    )
    SELECT
      ${sessionReadColumnsSql},
      COALESCE(events.event_count, 0) AS actual_event_count,
      COALESCE(events.event_bytes, 0) AS actual_event_bytes,
      events.earliest_cursor AS actual_earliest_cursor,
      events.latest_cursor AS actual_latest_cursor,
      COALESCE(events.invalid_event_rows, 0) AS invalid_event_rows,
      COALESCE(events.replay_boundary_count, 0) AS replay_boundary_count,
      (
        SELECT first.normalized_type
        FROM selected_projected_events AS first
        WHERE first.session_id = s.id
        ORDER BY first.cursor ASC
        LIMIT 1
      ) AS first_event_type
    FROM page_ids AS page
    JOIN selected_sessions AS s ON s.id = page.id
    JOIN selected_session_projections AS p ON p.session_id = s.id
    LEFT JOIN event_aggregates AS events ON events.session_id = s.id
    ORDER BY
      page.attention_rank DESC,
      page.activity_null_rank ASC,
      page.last_activity_at DESC,
      page.id ASC
  `);

  const detailStatement = db.prepare(`
    WITH event_aggregate AS (
      SELECT
        COUNT(*) AS event_count,
        COALESCE(SUM(byte_length), 0) AS event_bytes,
        MIN(cursor) AS earliest_cursor,
        MAX(cursor) AS latest_cursor,
        COALESCE(SUM(${invalidEventRowSql}), 0) AS invalid_event_rows,
        COALESCE(SUM(CASE WHEN e.normalized_type = 'replay_boundary' THEN 1 ELSE 0 END), 0) AS replay_boundary_count
      FROM selected_projected_events AS e
      WHERE session_id = @session_id
    )
    SELECT
      ${sessionReadColumnsSql},
      events.event_count AS actual_event_count,
      events.event_bytes AS actual_event_bytes,
      events.earliest_cursor AS actual_earliest_cursor,
      events.latest_cursor AS actual_latest_cursor,
      events.invalid_event_rows AS invalid_event_rows,
      events.replay_boundary_count AS replay_boundary_count,
      (
        SELECT first.normalized_type
        FROM selected_projected_events AS first
        WHERE first.session_id = s.id
        ORDER BY first.cursor ASC
        LIMIT 1
      ) AS first_event_type
    FROM selected_sessions AS s
    LEFT JOIN selected_session_projections AS p ON p.session_id = s.id
    CROSS JOIN event_aggregate AS events
    WHERE s.id = @session_id
  `);

  const listTransaction = db.transaction(
    (input: SelectedSessionListInput): SelectedSessionListPage => {
      const scanRows = scanStatement.all(selectedSessionListMaximumActiveSessions + 1) as OrderingScanRow[];
      if (scanRows.length > selectedSessionListMaximumActiveSessions) {
        throw repositoryError(
          "session_list_overflow",
          "Managed-session listing exceeds the supported active-session bound."
        );
      }

      const scan = scanRows.map(parseOrderingScanRow);
      const orderSnapshot = createOrderingSnapshot(scan);
      assertContinuationSnapshot(input, scan, orderSnapshot);
      const expectedIds = expectedPageIds(scan, input);
      const pageRows = pageStatement.all(pageParameters(input)) as SessionReadRow[];
      if (
        pageRows.length !== expectedIds.length ||
        pageRows.some((row, index) => row.mapping_id !== expectedIds[index])
      ) {
        throw repositoryError("invalid_state", "Managed-session page ordering is inconsistent.");
      }

      const fetched = pageRows.map((row) => parseSessionReadRow(row));
      assertFetchedPageMatchesScan(fetched, scan, input);
      const hasMore = fetched.length > input.limit;
      const sessions = fetched.slice(0, input.limit);
      const final = sessions.at(-1);
      return parsePage({
        has_more: hasMore,
        next_after: hasMore && final !== undefined ? selectedSessionListSortKey(final.session) : null,
        order_snapshot: orderSnapshot,
        sessions
      });
    }
  );

  const getTransaction = db.transaction((sessionId: string): SelectedSessionReadItem | null => {
    const row = detailStatement.get({ session_id: sessionId }) as SessionReadRow | undefined;
    if (row === undefined) return null;
    const mapping = parseMappingRow(row);
    assertSelectedDisposition(mapping);
    if (mapping.archived_at !== null) {
      throw repositoryError("session_archived", "Archived managed sessions are unavailable.");
    }
    return parseSessionReadRow(row, mapping);
  });

  const list = (input: SelectedSessionListInput): SelectedSessionListPage => {
    const parsed = selectedSessionListInputSchema.safeParse(input);
    if (!parsed.success) {
      throw repositoryError("invalid_input", "Managed-session list input is invalid.");
    }
    try {
      return listTransaction(parsed.data);
    } catch (error) {
      throw sanitizeRepositoryError(error);
    }
  };

  const get = (sessionId: string): SelectedSessionReadItem | null => {
    const parsed = sessionIdSchema.safeParse(sessionId);
    if (!parsed.success) {
      throw repositoryError("invalid_input", "Managed-session detail input is invalid.");
    }
    try {
      return getTransaction(parsed.data);
    } catch (error) {
      throw sanitizeRepositoryError(error);
    }
  };

  return Object.freeze({ get, list });
}

function parseOrderingScanRow(row: OrderingScanRow): OrderingScanEntry {
  if (row.disposition === "recovery_required") {
    throw repositoryError(
      "session_recovery_required",
      "Managed-session state requires recovery."
    );
  }
  if (
    row.disposition !== "selected" ||
    row.projection_session_id !== row.mapping_id ||
    !isActiveProjectionState(row.projection_session_state)
  ) {
    throw repositoryError("invalid_state", "Managed-session ordering state is invalid.");
  }
  const parsed = selectedSessionListOrderEntrySchema.safeParse({
    attention: row.projection_attention,
    id: row.mapping_id,
    last_activity_at: row.projection_last_activity_at
  });
  if (
    !parsed.success ||
    parsed.data.id !== row.mapping_id ||
    parsed.data.last_activity_at !== row.projection_last_activity_at
  ) {
    throw repositoryError("invalid_state", "Managed-session ordering state is invalid.");
  }
  return parsed.data;
}

function isActiveProjectionState(value: unknown): boolean {
  return (
    typeof value === "string" &&
    ["starting", "active", "stale", "incompatible", "unknown"].includes(value)
  );
}

function createOrderingSnapshot(entries: readonly OrderingScanEntry[]): string {
  const hash = createHash("sha256");
  appendHashField(hash, orderingSnapshotDomain);
  appendHashField(hash, String(entries.length));
  for (const entry of entries) {
    appendHashField(hash, entry.id);
    appendHashField(hash, entry.attention);
    appendHashField(hash, entry.last_activity_at);
  }
  return hash.digest("hex");
}

function appendHashField(hash: ReturnType<typeof createHash>, value: string | null): void {
  if (value === null) {
    hash.update(Buffer.from([0xff]));
    return;
  }
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length);
  hash.update(length);
  hash.update(bytes);
}

function assertContinuationSnapshot(
  input: SelectedSessionListInput,
  scan: readonly OrderingScanEntry[],
  actualSnapshot: string
): void {
  if (input.expected_order_snapshot === null || input.after === null) return;
  const entry = scan.find(({ id }) => id === input.after?.session_id);
  if (
    input.expected_order_snapshot !== actualSnapshot ||
    entry === undefined ||
    compareSelectedSessionListSortKeys(selectedSessionListSortKey(entry), input.after) !== 0
  ) {
    throw repositoryError(
      "session_list_changed",
      "Managed-session ordering changed after the previous page."
    );
  }
}

function expectedPageIds(
  scan: readonly OrderingScanEntry[],
  input: SelectedSessionListInput
): readonly string[] {
  const ordered = [...scan].sort(compareSelectedSessionListOrder);
  const start =
    input.after === null
      ? 0
      : ordered.findIndex(({ id }) => id === input.after?.session_id) + 1;
  if (start < 0) {
    throw repositoryError(
      "session_list_changed",
      "Managed-session ordering changed after the previous page."
    );
  }
  return Object.freeze(ordered.slice(start, start + input.limit + 1).map(({ id }) => id));
}

function pageParameters(input: SelectedSessionListInput): Readonly<Record<string, string | number>> {
  const after = input.after;
  return Object.freeze({
    after_activity_null_rank: after?.last_activity_at === null ? 1 : 0,
    after_attention_rank: after?.attention_rank ?? 0,
    after_last_activity_at: after?.last_activity_at ?? "",
    after_session_id: after?.session_id ?? "",
    fetch_limit: input.limit + 1,
    has_after: after === null ? 0 : 1
  });
}

function assertFetchedPageMatchesScan(
  fetched: readonly SelectedSessionReadItem[],
  scan: readonly OrderingScanEntry[],
  input: SelectedSessionListInput
): void {
  const scanById = new Map(scan.map((entry) => [entry.id, entry]));
  for (const [index, item] of fetched.entries()) {
    const orderingEntry = scanById.get(item.session.id);
    const previous = fetched[index - 1];
    if (
      orderingEntry === undefined ||
      compareSelectedSessionListOrder(orderingEntry, item.session) !== 0 ||
      (previous !== undefined && compareSelectedSessionListOrder(previous.session, item.session) >= 0) ||
      (input.after !== null &&
        compareSelectedSessionListSortKeys(input.after, selectedSessionListSortKey(item.session)) >= 0)
    ) {
      throw repositoryError("invalid_state", "Managed-session page state is inconsistent.");
    }
  }
}

function parseSessionReadRow(
  row: SessionReadRow,
  preparedMapping?: SelectedSessionMappingRecord
): SelectedSessionReadItem {
  const mapping = preparedMapping ?? parseMappingRow(row);
  assertSelectedDisposition(mapping);
  if (mapping.archived_at !== null) {
    throw repositoryError("session_archived", "Archived managed sessions are unavailable.");
  }
  if (row.projection_session_id !== mapping.id) {
    throw repositoryError("invalid_state", "Managed-session projection identity is invalid.");
  }

  const settings = parseNullableJson(
    row.projection_settings_json,
    maximumSettingsJsonBytes
  );
  const goal = parseNullableJson(row.projection_goal_json, maximumGoalJsonBytes);
  const projectionResult = selectedSessionProjectionRecordSchema.safeParse({
    earliest_retained_cursor: row.projection_earliest_retained_cursor,
    retained_event_bytes: row.projection_retained_event_bytes,
    retained_event_count: row.projection_retained_event_count,
    retention_boundary_cursor: row.projection_retention_boundary_cursor,
    session: {
      archived_at: mapping.archived_at,
      attention: row.projection_attention,
      branch: row.projection_branch,
      codex_thread_id: mapping.codex_thread_id,
      created_at: mapping.created_at,
      cwd: mapping.cwd,
      freshness: row.projection_freshness,
      freshness_reason: row.projection_freshness_reason,
      goal,
      id: mapping.id,
      last_activity_at: row.projection_last_activity_at,
      last_event_cursor: row.projection_last_event_cursor,
      model: row.projection_model,
      name: mapping.name,
      recent_summary: row.projection_recent_summary,
      runtime_source: mapping.runtime_source,
      runtime_version: mapping.runtime_version,
      session_state: row.projection_session_state,
      settings,
      turn_state: row.projection_turn_state,
      updated_at: row.projection_updated_at
    }
  });
  if (!projectionResult.success) {
    throw repositoryError("invalid_state", "Managed-session projection state is invalid.");
  }
  const projection = projectionResult.data;
  assertProjectionRawColumns(row, projection.session);
  assertProjectionChronology(mapping, projection.session);
  assertEventAggregate(row, projection);

  const eventWindow = {
    boundary_cursor: projection.retention_boundary_cursor,
    earliest_retained_cursor: projection.earliest_retained_cursor,
    retained_event_count: projection.retained_event_count,
    state:
      projection.retained_event_count === 0
        ? "empty"
        : projection.retention_boundary_cursor === null
          ? "contiguous"
          : "bounded"
  } as const;
  const item = selectedSessionReadItemSchema.safeParse({
    event_window: eventWindow,
    session: projection.session
  });
  if (!item.success) {
    throw repositoryError("invalid_state", "Managed-session public projection is invalid.");
  }
  return item.data;
}

function parseMappingRow(row: SessionReadRow): SelectedSessionMappingRecord {
  const result = selectedSessionMappingRecordSchema.safeParse({
    archived_at: row.mapping_archived_at,
    codex_thread_id: row.mapping_codex_thread_id,
    created_at: row.mapping_created_at,
    cwd: row.mapping_cwd,
    disposition: row.mapping_disposition,
    id: row.mapping_id,
    name: row.mapping_name,
    runtime_source: row.mapping_runtime_source,
    runtime_version: row.mapping_runtime_version,
    updated_at: row.mapping_updated_at
  });
  if (!result.success) {
    throw repositoryError("invalid_state", "Managed-session mapping state is invalid.");
  }
  const mapping = result.data;
  if (
    mapping.id !== row.mapping_id ||
    mapping.name !== row.mapping_name ||
    mapping.codex_thread_id !== row.mapping_codex_thread_id ||
    mapping.cwd !== row.mapping_cwd ||
    mapping.runtime_source !== row.mapping_runtime_source ||
    mapping.runtime_version !== row.mapping_runtime_version ||
    mapping.disposition !== row.mapping_disposition ||
    mapping.created_at !== row.mapping_created_at ||
    mapping.updated_at !== row.mapping_updated_at ||
    mapping.archived_at !== row.mapping_archived_at ||
    mapping.updated_at < mapping.created_at ||
    (mapping.archived_at !== null &&
      (mapping.archived_at < mapping.created_at || mapping.archived_at > mapping.updated_at))
  ) {
    throw repositoryError("invalid_state", "Managed-session mapping state is invalid.");
  }
  return mapping;
}

function assertSelectedDisposition(mapping: SelectedSessionMappingRecord): void {
  if (mapping.disposition === "recovery_required") {
    throw repositoryError(
      "session_recovery_required",
      "Managed-session state requires recovery."
    );
  }
}

function assertProjectionRawColumns(
  row: SessionReadRow,
  session: SelectedSessionReadItem["session"]
): void {
  if (
    session.session_state !== row.projection_session_state ||
    session.turn_state !== row.projection_turn_state ||
    session.attention !== row.projection_attention ||
    session.freshness !== row.projection_freshness ||
    session.freshness_reason !== row.projection_freshness_reason ||
    session.updated_at !== row.projection_updated_at ||
    session.last_activity_at !== row.projection_last_activity_at ||
    session.branch !== row.projection_branch ||
    session.model !== row.projection_model ||
    session.recent_summary !== row.projection_recent_summary ||
    session.last_event_cursor !== row.projection_last_event_cursor
  ) {
    throw repositoryError("invalid_state", "Managed-session projection columns are inconsistent.");
  }
}

function assertProjectionChronology(
  mapping: SelectedSessionMappingRecord,
  session: SelectedSessionReadItem["session"]
): void {
  if (
    session.updated_at < session.created_at ||
    (session.last_activity_at !== null &&
      (session.last_activity_at < session.created_at || session.last_activity_at > session.updated_at)) ||
    (mapping.archived_at !== null && mapping.archived_at > session.updated_at)
  ) {
    throw repositoryError("invalid_state", "Managed-session projection chronology is invalid.");
  }
}

function assertEventAggregate(
  row: SessionReadRow,
  projection: ReturnType<typeof selectedSessionProjectionRecordSchema.parse>
): void {
  const count = nonNegativeSafeInteger(row.actual_event_count);
  const bytes = nonNegativeSafeInteger(row.actual_event_bytes);
  const earliest = nullableSafeInteger(row.actual_earliest_cursor);
  const latest = nullableSafeInteger(row.actual_latest_cursor);
  const invalidRows = nonNegativeSafeInteger(row.invalid_event_rows);
  const replayBoundaryCount = nonNegativeSafeInteger(row.replay_boundary_count);
  const firstType = row.first_event_type;
  if (
    (firstType !== null && typeof firstType !== "string") ||
    invalidRows !== 0 ||
    count !== projection.retained_event_count ||
    bytes !== projection.retained_event_bytes ||
    earliest !== projection.earliest_retained_cursor ||
    latest !== projection.session.last_event_cursor
  ) {
    throw repositoryError("invalid_state", "Managed-session retained event state is inconsistent.");
  }
  if (count === 0) {
    if (
      bytes !== 0 ||
      earliest !== null ||
      latest !== null ||
      firstType !== null ||
      replayBoundaryCount !== 0 ||
      projection.retention_boundary_cursor !== null
    ) {
      throw repositoryError("invalid_state", "Managed-session retained event state is inconsistent.");
    }
    return;
  }
  if (
    bytes < 1 ||
    earliest === null ||
    latest === null ||
    earliest > latest ||
    latest - earliest + 1 !== count ||
    (projection.retention_boundary_cursor === null
      ? earliest !== 1 || replayBoundaryCount !== 0
      : projection.retention_boundary_cursor + 1 !== earliest ||
        firstType !== "replay_boundary" ||
        replayBoundaryCount !== 1 ||
        count < 2)
  ) {
    throw repositoryError("invalid_state", "Managed-session retained event state is inconsistent.");
  }
}

function parseNullableJson(value: unknown, maximumBytes: number): unknown {
  if (value === null) return null;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw repositoryError("invalid_state", "Managed-session structured projection state is invalid.");
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw repositoryError("invalid_state", "Managed-session structured projection state is invalid.");
  }
}

function nonNegativeSafeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw repositoryError("invalid_state", "Managed-session retained event state is invalid.");
  }
  return value as number;
}

function nullableSafeInteger(value: unknown): number | null {
  return value === null ? null : nonNegativeSafeInteger(value);
}

function parsePage(candidate: unknown): SelectedSessionListPage {
  const result = selectedSessionListPageSchema.safeParse(candidate);
  if (!result.success) {
    throw repositoryError("invalid_state", "Managed-session list result is invalid.");
  }
  return result.data;
}

function repositoryError(
  code: SelectedSessionReadRepositoryErrorCode,
  message: string
): HostDeckSelectedSessionReadRepositoryError {
  return new HostDeckSelectedSessionReadRepositoryError(code, message);
}

function sanitizeRepositoryError(error: unknown): HostDeckSelectedSessionReadRepositoryError {
  if (error instanceof HostDeckSelectedSessionReadRepositoryError) {
    const messages: Readonly<Record<SelectedSessionReadRepositoryErrorCode, string>> = {
      invalid_input: "Managed-session read input is invalid.",
      invalid_state: "Managed-session storage is inconsistent.",
      read_failed: "Managed-session storage read failed.",
      session_archived: "Archived managed sessions are unavailable.",
      session_list_changed: "Managed-session ordering changed after the previous page.",
      session_list_overflow: "Managed-session listing exceeds the supported active-session bound.",
      session_recovery_required: "Managed-session state requires recovery."
    };
    return repositoryError(error.code, messages[error.code]);
  }
  return repositoryError("read_failed", "Managed-session storage read failed.");
}
