import { isIP } from "node:net";
import { defaultRetentionPolicy, type SettingsRecord, settingsRecordSchema } from "@hostdeck/contracts";
import type Database from "better-sqlite3";

export type SettingsErrorCode =
  | "invalid_lock_transition"
  | "invalid_settings"
  | "settings_lock_conflict"
  | "settings_lock_time_conflict"
  | "settings_missing"
  | "settings_unavailable";

export class HostDeckSettingsError extends Error {
  constructor(
    readonly code: SettingsErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostDeckSettingsError";
  }
}

export interface CreateDefaultSettingsInput {
  readonly stateDir: string;
  readonly bindPort?: number;
  readonly now?: () => Date;
}

export interface SettingsRepository {
  readonly get: () => SettingsRecord | null;
  readonly require: () => SettingsRecord;
  readonly getOrCreateDefault: (input: CreateDefaultSettingsInput) => SettingsRecord;
  readonly save: (settings: unknown) => SettingsRecord;
  readonly transitionHostLock: (
    input: TransitionHostDeckLockInput
  ) => HostDeckLockTransitionReceipt;
  readonly setLocked: (locked: boolean, input?: { readonly now?: () => Date }) => SettingsRecord;
  readonly setLanEnabled: (enabled: boolean, input?: { readonly bindHost?: string; readonly now?: () => Date }) => SettingsRecord;
}

export interface TransitionHostDeckLockInput {
  readonly locked: boolean;
  readonly now: Date;
}

export interface HostDeckLockState {
  readonly locked: boolean;
  readonly settings_updated_at: string;
}

export interface HostDeckLockTransitionReceipt {
  readonly before: HostDeckLockState;
  readonly after: HostDeckLockState;
  readonly changed: boolean;
}

interface SettingsRow {
  readonly id: string;
  readonly schema_version: number;
  readonly state_dir: string;
  readonly bind_mode: "localhost" | "lan";
  readonly bind_host: string;
  readonly bind_port: number;
  readonly lan_enabled: 0 | 1;
  readonly locked: 0 | 1;
  readonly output_event_limit: number;
  readonly output_byte_limit: number;
  readonly audit_event_limit: number;
  readonly audit_retention_days: number;
  readonly updated_at: string;
}

export function createSettingsRepository(db: Database.Database): SettingsRepository {
  const transitionHostLockTransaction = db.transaction(
    (input: PreparedHostLockTransitionInput): HostDeckLockTransitionReceipt => {
      const beforeSettings = requireSettings(db);
      const before = lockState(beforeSettings);
      if (before.locked === input.locked) {
        return lockTransitionReceipt(before, before, false);
      }
      if (input.nowMs < Date.parse(before.settings_updated_at)) {
        throw new HostDeckSettingsError(
          "settings_lock_time_conflict",
          "Host lock transition time conflicts with durable settings chronology."
        );
      }

      const update = db
        .prepare(
          `
            UPDATE settings
            SET locked = @locked,
                updated_at = @updated_at
            WHERE id = 'hostdeck_settings'
              AND locked = @expected_locked
              AND updated_at = @expected_updated_at
          `
        )
        .run({
          locked: input.locked ? 1 : 0,
          updated_at: input.now,
          expected_locked: before.locked ? 1 : 0,
          expected_updated_at: before.settings_updated_at
        });
      if (update.changes !== 1) {
        throw new HostDeckSettingsError(
          "settings_lock_conflict",
          "Host lock state changed before the transition committed."
        );
      }

      const afterSettings = requireSettings(db);
      assertOnlyHostLockChanged(beforeSettings, afterSettings, input);
      return lockTransitionReceipt(before, lockState(afterSettings), true);
    }
  ).immediate;

  return {
    get() {
      const row = db.prepare("SELECT * FROM settings WHERE id = 'hostdeck_settings'").get() as SettingsRow | undefined;
      return row === undefined ? null : parseSettingsRow(row);
    },
    require() {
      const settings = this.get();

      if (settings === null) {
        throw new HostDeckSettingsError("settings_missing", "HostDeck settings have not been initialized.");
      }

      return settings;
    },
    getOrCreateDefault(input) {
      const existing = this.get();

      if (existing !== null) {
        return existing;
      }

      return this.save(createDefaultSettings(input));
    },
    save(settings) {
      const parsed = parseSettings(settings);
      const row = settingsToRow(parsed);

      db.prepare(`
        INSERT INTO settings (
          id,
          schema_version,
          state_dir,
          bind_mode,
          bind_host,
          bind_port,
          lan_enabled,
          locked,
          output_event_limit,
          output_byte_limit,
          audit_event_limit,
          audit_retention_days,
          updated_at
        ) VALUES (
          @id,
          @schema_version,
          @state_dir,
          @bind_mode,
          @bind_host,
          @bind_port,
          @lan_enabled,
          @locked,
          @output_event_limit,
          @output_byte_limit,
          @audit_event_limit,
          @audit_retention_days,
          @updated_at
        )
        ON CONFLICT(id) DO UPDATE SET
          schema_version = excluded.schema_version,
          state_dir = excluded.state_dir,
          bind_mode = excluded.bind_mode,
          bind_host = excluded.bind_host,
          bind_port = excluded.bind_port,
          lan_enabled = excluded.lan_enabled,
          locked = excluded.locked,
          output_event_limit = excluded.output_event_limit,
          output_byte_limit = excluded.output_byte_limit,
          audit_event_limit = excluded.audit_event_limit,
          audit_retention_days = excluded.audit_retention_days,
          updated_at = excluded.updated_at
      `).run(row);

      return parsed;
    },
    transitionHostLock(input) {
      const prepared = prepareHostLockTransitionInput(input);
      if (!db.open || db.readonly) {
        throw new HostDeckSettingsError(
          "settings_unavailable",
          "HostDeck settings are unavailable."
        );
      }
      try {
        return transitionHostLockTransaction(prepared);
      } catch (error) {
        throw sanitizeHostLockTransitionError(error);
      }
    },
    setLocked(locked, input = {}) {
      const now = readNow(input.now);
      this.transitionHostLock({ locked, now });
      return this.require();
    },
    setLanEnabled(enabled, input = {}) {
      const current = this.require();
      return this.save({
        ...current,
        bind_mode: enabled ? "lan" : "localhost",
        bind_host: enabled ? (input.bindHost ?? "0.0.0.0") : "127.0.0.1",
        lan_enabled: enabled,
        updated_at: nowIso(input.now)
      });
    }
  };
}

interface PreparedHostLockTransitionInput {
  readonly locked: boolean;
  readonly now: string;
  readonly nowMs: number;
}

function prepareHostLockTransitionInput(
  input: unknown
): PreparedHostLockTransitionInput {
  let values: Readonly<Record<string, unknown>>;
  try {
    values = readExactLockTransitionInput(input);
  } catch {
    throw new HostDeckSettingsError(
      "invalid_lock_transition",
      "Host lock transition input is invalid."
    );
  }
  if (typeof values.locked !== "boolean" || !(values.now instanceof Date)) {
    throw new HostDeckSettingsError(
      "invalid_lock_transition",
      "Host lock transition input is invalid."
    );
  }
  const nowMs = Date.prototype.getTime.call(values.now);
  if (!Number.isFinite(nowMs)) {
    throw new HostDeckSettingsError(
      "invalid_lock_transition",
      "Host lock transition time is invalid."
    );
  }
  return Object.freeze({
    locked: values.locked,
    now: new Date(nowMs).toISOString(),
    nowMs
  });
}

function readExactLockTransitionInput(
  input: unknown
): Readonly<Record<string, unknown>> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError();
  }
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== 2 ||
    keys.some(
      (key) =>
        typeof key !== "string" || (key !== "locked" && key !== "now")
    ) ||
    !Object.hasOwn(descriptors, "locked") ||
    !Object.hasOwn(descriptors, "now")
  ) {
    throw new TypeError();
  }
  const values: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of keys) {
    if (typeof key !== "string") throw new TypeError();
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new TypeError();
    }
    values[key] = descriptor.value;
  }
  return Object.freeze(values);
}

function requireSettings(db: Database.Database): SettingsRecord {
  const row = db
    .prepare("SELECT * FROM settings WHERE id = 'hostdeck_settings'")
    .get() as SettingsRow | undefined;
  if (row === undefined) {
    throw new HostDeckSettingsError(
      "settings_missing",
      "HostDeck settings have not been initialized."
    );
  }
  return parseSettingsRow(row);
}

function lockState(settings: SettingsRecord): HostDeckLockState {
  return Object.freeze({
    locked: settings.locked,
    settings_updated_at: settings.updated_at
  });
}

function lockTransitionReceipt(
  before: HostDeckLockState,
  after: HostDeckLockState,
  changed: boolean
): HostDeckLockTransitionReceipt {
  if (changed) {
    if (
      before.locked === after.locked ||
      Date.parse(after.settings_updated_at) < Date.parse(before.settings_updated_at)
    ) {
      throw new HostDeckSettingsError(
        "settings_lock_conflict",
        "Host lock transition receipt is inconsistent."
      );
    }
  } else if (
    before.locked !== after.locked ||
    before.settings_updated_at !== after.settings_updated_at
  ) {
    throw new HostDeckSettingsError(
      "settings_lock_conflict",
      "Host lock no-op receipt is inconsistent."
    );
  }
  return Object.freeze({ before, after, changed });
}

function assertOnlyHostLockChanged(
  before: SettingsRecord,
  after: SettingsRecord,
  input: PreparedHostLockTransitionInput
): void {
  if (
    after.locked !== input.locked ||
    after.updated_at !== input.now ||
    before.id !== after.id ||
    before.schema_version !== after.schema_version ||
    before.state_dir !== after.state_dir ||
    before.bind_mode !== after.bind_mode ||
    before.bind_host !== after.bind_host ||
    before.bind_port !== after.bind_port ||
    before.lan_enabled !== after.lan_enabled ||
    before.retention.output_event_limit !==
      after.retention.output_event_limit ||
    before.retention.output_byte_limit !== after.retention.output_byte_limit ||
    before.retention.audit_event_limit !== after.retention.audit_event_limit ||
    before.retention.audit_retention_days !==
      after.retention.audit_retention_days
  ) {
    throw new HostDeckSettingsError(
      "settings_lock_conflict",
      "Host lock transition changed unrelated settings state."
    );
  }
}

function sanitizeHostLockTransitionError(
  error: unknown
): HostDeckSettingsError {
  if (error instanceof HostDeckSettingsError) {
    const messages: Partial<Record<SettingsErrorCode, string>> = {
      invalid_lock_transition: "Host lock transition input is invalid.",
      invalid_settings: "Stored HostDeck settings are invalid.",
      settings_lock_conflict: "Host lock transition conflicts with durable settings state.",
      settings_lock_time_conflict:
        "Host lock transition time conflicts with durable settings chronology.",
      settings_missing: "HostDeck settings have not been initialized.",
      settings_unavailable: "HostDeck settings are unavailable."
    };
    return new HostDeckSettingsError(error.code, messages[error.code] ?? "HostDeck settings are unavailable.");
  }
  return new HostDeckSettingsError(
    "settings_unavailable",
    "HostDeck settings are unavailable."
  );
}

export function createDefaultSettings(input: CreateDefaultSettingsInput): SettingsRecord {
  return parseSettings({
    id: "hostdeck_settings",
    schema_version: 1,
    state_dir: input.stateDir,
    bind_mode: "localhost",
    bind_host: "127.0.0.1",
    bind_port: input.bindPort ?? 3777,
    lan_enabled: false,
    locked: false,
    retention: defaultRetentionPolicy,
    updated_at: nowIso(input.now)
  });
}

function parseSettingsRow(row: SettingsRow): SettingsRecord {
  return parseSettings({
    id: row.id,
    schema_version: row.schema_version,
    state_dir: row.state_dir,
    bind_mode: row.bind_mode,
    bind_host: row.bind_host,
    bind_port: row.bind_port,
    lan_enabled: row.lan_enabled === 1,
    locked: row.locked === 1,
    retention: {
      output_event_limit: row.output_event_limit,
      output_byte_limit: row.output_byte_limit,
      audit_event_limit: row.audit_event_limit,
      audit_retention_days: row.audit_retention_days
    },
    updated_at: row.updated_at
  });
}

function parseSettings(candidate: unknown): SettingsRecord {
  const result = settingsRecordSchema.safeParse(candidate);

  if (!result.success) {
    throw new HostDeckSettingsError("invalid_settings", "HostDeck settings are invalid.", { cause: result.error });
  }

  assertBindableHost(result.data);

  return result.data;
}

function assertBindableHost(settings: SettingsRecord): void {
  if (!isValidBindHost(settings.bind_host)) {
    throw new HostDeckSettingsError("invalid_settings", `HostDeck bind host "${settings.bind_host}" is not a valid IP bind address.`);
  }

  const isLoopback = isLoopbackBindHost(settings.bind_host);

  if (settings.bind_mode === "localhost" && !isLoopback) {
    throw new HostDeckSettingsError("invalid_settings", "Localhost mode must bind to a loopback address.");
  }

  if (settings.bind_mode === "lan" && isLoopback) {
    throw new HostDeckSettingsError("invalid_settings", "LAN mode must not bind to a loopback address.");
  }
}

function isValidBindHost(host: string): boolean {
  return host === "localhost" || isIP(host) !== 0;
}

function isLoopbackBindHost(host: string): boolean {
  if (host === "localhost" || host === "::1") {
    return true;
  }

  if (isIP(host) !== 4) {
    return false;
  }

  const [firstOctet] = host.split(".");
  return firstOctet === "127";
}

function settingsToRow(settings: SettingsRecord): SettingsRow {
  return {
    id: settings.id,
    schema_version: settings.schema_version,
    state_dir: settings.state_dir,
    bind_mode: settings.bind_mode,
    bind_host: settings.bind_host,
    bind_port: settings.bind_port,
    lan_enabled: settings.lan_enabled ? 1 : 0,
    locked: settings.locked ? 1 : 0,
    output_event_limit: settings.retention.output_event_limit,
    output_byte_limit: settings.retention.output_byte_limit,
    audit_event_limit: settings.retention.audit_event_limit,
    audit_retention_days: settings.retention.audit_retention_days,
    updated_at: settings.updated_at
  };
}

function nowIso(now?: () => Date): string {
  return readNow(now).toISOString();
}

function readNow(now?: () => Date): Date {
  const value = (now ?? (() => new Date()))();
  if (!(value instanceof Date)) {
    throw new HostDeckSettingsError(
      "invalid_settings",
      "HostDeck settings time is invalid."
    );
  }
  const time = Date.prototype.getTime.call(value);
  if (!Number.isFinite(time)) {
    throw new HostDeckSettingsError(
      "invalid_settings",
      "HostDeck settings time is invalid."
    );
  }
  return new Date(time);
}
