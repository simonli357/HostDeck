export interface StorageMigration {
  readonly version: string;
  readonly sql: string;
}

export const hostDeckBaseSchemaMigration: StorageMigration = {
  version: "202607080001_base_schema",
  sql: `
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      cwd TEXT NOT NULL,
      backend_type TEXT NOT NULL CHECK (backend_type = 'tmux'),
      tmux_session TEXT NOT NULL,
      tmux_window TEXT,
      tmux_pane TEXT,
      lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('starting', 'running', 'stopping', 'stopped', 'crashed', 'stale', 'unknown')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      stale_reason TEXT,
      CHECK ((lifecycle_state = 'stale' AND stale_reason IS NOT NULL) OR (lifecycle_state <> 'stale' AND stale_reason IS NULL))
    );

    CREATE TABLE session_metadata (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      branch TEXT,
      last_activity_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'waiting_for_user', 'waiting_for_approval', 'tests_failed', 'tests_passed', 'compacting', 'disconnected', 'unknown')),
      attention TEXT NOT NULL CHECK (attention IN ('none', 'watch', 'needs_input', 'needs_approval', 'failed', 'stuck', 'unknown')),
      summary TEXT,
      last_output_cursor INTEGER CHECK (last_output_cursor IS NULL OR last_output_cursor >= 0),
      updated_at TEXT NOT NULL
    );

    CREATE TABLE output_events (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      cursor INTEGER NOT NULL CHECK (cursor >= 0),
      event_order INTEGER NOT NULL CHECK (event_order >= 0),
      captured_at TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('output', 'replay_boundary', 'system')),
      payload TEXT,
      truncated_before INTEGER CHECK (truncated_before IS NULL OR truncated_before >= 0),
      PRIMARY KEY (session_id, cursor),
      CHECK ((kind = 'output' AND payload IS NOT NULL) OR kind <> 'output'),
      CHECK ((kind = 'replay_boundary' AND truncated_before IS NOT NULL) OR kind <> 'replay_boundary')
    );

    CREATE INDEX output_events_session_order_idx ON output_events(session_id, event_order);

    CREATE TABLE retention_boundaries (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK (scope IN ('output', 'audit')),
      session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      reason TEXT NOT NULL CHECK (reason IN ('event_limit', 'byte_limit', 'age_limit', 'manual_cleanup')),
      truncated_before_cursor INTEGER CHECK (truncated_before_cursor IS NULL OR truncated_before_cursor >= 0),
      truncated_before_at TEXT,
      retained_record_count INTEGER NOT NULL CHECK (retained_record_count >= 0),
      applied_at TEXT NOT NULL,
      CHECK ((scope = 'output' AND session_id IS NOT NULL AND truncated_before_cursor IS NOT NULL) OR scope <> 'output')
    );

    CREATE INDEX retention_boundaries_scope_applied_idx ON retention_boundaries(scope, applied_at);

    CREATE TABLE auth_devices (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      client_label TEXT,
      permission TEXT NOT NULL CHECK (permission IN ('read', 'write')),
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      expires_at TEXT,
      revoked_at TEXT
    );

    CREATE TABLE pairing_codes (
      id TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL UNIQUE,
      permission TEXT NOT NULL CHECK (permission IN ('read', 'write')),
      client_label TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );

    CREATE TABLE settings (
      id TEXT PRIMARY KEY CHECK (id = 'hostdeck_settings'),
      schema_version INTEGER NOT NULL CHECK (schema_version > 0),
      state_dir TEXT NOT NULL,
      bind_mode TEXT NOT NULL CHECK (bind_mode IN ('localhost', 'lan')),
      bind_host TEXT NOT NULL,
      bind_port INTEGER NOT NULL CHECK (bind_port BETWEEN 1 AND 65535),
      lan_enabled INTEGER NOT NULL CHECK (lan_enabled IN (0, 1)),
      locked INTEGER NOT NULL CHECK (locked IN (0, 1)),
      output_event_limit INTEGER NOT NULL CHECK (output_event_limit > 0),
      output_byte_limit INTEGER NOT NULL CHECK (output_byte_limit > 0),
      audit_event_limit INTEGER NOT NULL CHECK (audit_event_limit > 0),
      audit_retention_days INTEGER NOT NULL CHECK (audit_retention_days > 0),
      updated_at TEXT NOT NULL,
      CHECK ((bind_mode = 'lan' AND lan_enabled = 1) OR (bind_mode = 'localhost' AND lan_enabled = 0))
    );

    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      actor_type TEXT NOT NULL CHECK (actor_type IN ('system', 'cli', 'dashboard')),
      actor_client_id TEXT,
      actor_permission TEXT CHECK (actor_permission IS NULL OR actor_permission IN ('read', 'write')),
      action TEXT NOT NULL CHECK (action IN ('prompt', 'slash', 'stop', 'raw_input', 'lock', 'unlock', 'lan_enable', 'lan_disable', 'pair', 'token_revoke')),
      session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      payload_summary_json TEXT NOT NULL,
      result TEXT NOT NULL CHECK (result IN ('accepted', 'rejected', 'succeeded', 'failed')),
      error_code TEXT,
      CHECK ((actor_type = 'dashboard' AND actor_client_id IS NOT NULL AND actor_permission IS NOT NULL) OR actor_type <> 'dashboard'),
      CHECK ((actor_type = 'system' AND actor_client_id IS NULL AND actor_permission IS NULL) OR actor_type <> 'system'),
      CHECK ((result IN ('rejected', 'failed') AND error_code IS NOT NULL) OR (result IN ('accepted', 'succeeded') AND error_code IS NULL))
    );

    CREATE INDEX audit_events_at_idx ON audit_events(at);
    CREATE INDEX audit_events_session_idx ON audit_events(session_id);
  `
};

export const hostDeckSessionMetadataFailedStatusMigration: StorageMigration = {
  version: "202607080002_session_metadata_failed_status",
  sql: `
    CREATE TABLE session_metadata_next (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      branch TEXT,
      last_activity_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'waiting_for_user', 'waiting_for_approval', 'tests_failed', 'tests_passed', 'compacting', 'disconnected', 'failed', 'unknown')),
      attention TEXT NOT NULL CHECK (attention IN ('none', 'watch', 'needs_input', 'needs_approval', 'failed', 'stuck', 'unknown')),
      summary TEXT,
      last_output_cursor INTEGER CHECK (last_output_cursor IS NULL OR last_output_cursor >= 0),
      updated_at TEXT NOT NULL
    );

    INSERT INTO session_metadata_next (
      session_id,
      branch,
      last_activity_at,
      status,
      attention,
      summary,
      last_output_cursor,
      updated_at
    )
    SELECT
      session_id,
      branch,
      last_activity_at,
      status,
      attention,
      summary,
      last_output_cursor,
      updated_at
    FROM session_metadata;

    DROP TABLE session_metadata;
    ALTER TABLE session_metadata_next RENAME TO session_metadata;
  `
};

export const hostDeckAuthDeviceCsrfHashMigration: StorageMigration = {
  version: "202607080003_auth_device_csrf_hash",
  sql: `
    CREATE TABLE auth_devices_next (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      csrf_token_hash TEXT NOT NULL,
      client_label TEXT,
      permission TEXT NOT NULL CHECK (permission IN ('read', 'write')),
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      expires_at TEXT,
      revoked_at TEXT
    );

    INSERT INTO auth_devices_next (
      id,
      token_hash,
      csrf_token_hash,
      client_label,
      permission,
      created_at,
      last_used_at,
      expires_at,
      revoked_at
    )
    SELECT
      id,
      token_hash,
      'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      client_label,
      permission,
      created_at,
      last_used_at,
      expires_at,
      revoked_at
    FROM auth_devices;

    DROP TABLE auth_devices;
    ALTER TABLE auth_devices_next RENAME TO auth_devices;
  `
};

export const hostDeckRetentionBoundaryScopeChecksMigration: StorageMigration = {
  version: "202607080004_retention_boundary_scope_checks",
  sql: `
    CREATE TABLE retention_boundaries_next (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK (scope IN ('output', 'audit')),
      session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      reason TEXT NOT NULL CHECK (reason IN ('event_limit', 'byte_limit', 'age_limit', 'manual_cleanup')),
      truncated_before_cursor INTEGER CHECK (truncated_before_cursor IS NULL OR truncated_before_cursor >= 0),
      truncated_before_at TEXT,
      retained_record_count INTEGER NOT NULL CHECK (retained_record_count >= 0),
      applied_at TEXT NOT NULL,
      CHECK ((scope = 'output' AND session_id IS NOT NULL AND truncated_before_cursor IS NOT NULL) OR scope <> 'output'),
      CHECK ((scope = 'audit' AND session_id IS NULL AND truncated_before_cursor IS NULL) OR scope <> 'audit')
    );

    INSERT INTO retention_boundaries_next (
      id,
      scope,
      session_id,
      reason,
      truncated_before_cursor,
      truncated_before_at,
      retained_record_count,
      applied_at
    )
    SELECT
      id,
      scope,
      session_id,
      reason,
      truncated_before_cursor,
      truncated_before_at,
      retained_record_count,
      applied_at
    FROM retention_boundaries;

    DROP TABLE retention_boundaries;
    ALTER TABLE retention_boundaries_next RENAME TO retention_boundaries;
    CREATE INDEX retention_boundaries_scope_applied_idx ON retention_boundaries(scope, applied_at);
  `
};

export const defaultMigrations: readonly StorageMigration[] = [
  hostDeckBaseSchemaMigration,
  hostDeckSessionMetadataFailedStatusMigration,
  hostDeckAuthDeviceCsrfHashMigration,
  hostDeckRetentionBoundaryScopeChecksMigration
] as const;
