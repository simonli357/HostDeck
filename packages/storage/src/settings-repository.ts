import { isIP } from "node:net";
import { defaultRetentionPolicy, type SettingsRecord, settingsRecordSchema } from "@hostdeck/contracts";
import type Database from "better-sqlite3";

export type SettingsErrorCode = "invalid_settings" | "settings_missing";

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
  readonly setLocked: (locked: boolean, input?: { readonly now?: () => Date }) => SettingsRecord;
  readonly setLanEnabled: (enabled: boolean, input?: { readonly bindHost?: string; readonly now?: () => Date }) => SettingsRecord;
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
    setLocked(locked, input = {}) {
      const current = this.require();
      return this.save({
        ...current,
        locked,
        updated_at: nowIso(input.now)
      });
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
  return (now ?? (() => new Date()))().toISOString();
}
