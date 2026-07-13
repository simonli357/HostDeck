import {
  canonicalIpHost,
  isoTimestampSchema,
  lanOrigin,
  type SettingsRecord, 
  settingsRecordSchema
} from "@hostdeck/contracts";
import type Database from "better-sqlite3";

export const hostDeckLanConfigurationId = "hostdeck_lan_configuration";

export type HostDeckLanConfigurationErrorCode =
  | "invalid_lan_configuration"
  | "lan_configuration_conflict"
  | "lan_configuration_missing"
  | "lan_configuration_time_conflict"
  | "lan_configuration_unavailable"
  | "settings_missing";

export class HostDeckLanConfigurationError extends Error {
  constructor(
    readonly code: HostDeckLanConfigurationErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostDeckLanConfigurationError";
  }
}

export interface HostDeckLanCertificateDescriptor {
  readonly bind_host: string;
  readonly address_family: "ipv4" | "ipv6";
  readonly bind_port: number;
  readonly configured_origin: string;
  readonly root_fingerprint_sha256: string;
  readonly leaf_fingerprint_sha256: string;
  readonly leaf_valid_from: string;
  readonly leaf_expires_at: string;
}

export interface HostDeckLanConfigurationRecord extends HostDeckLanCertificateDescriptor {
  readonly id: typeof hostDeckLanConfigurationId;
  readonly schema_version: 1;
  readonly updated_at: string;
}

export interface ConfigureHostDeckLanInput extends HostDeckLanCertificateDescriptor {
  readonly now: Date;
}

export type TransitionHostDeckLanModeInput =
  | {
      readonly enabled: true;
      readonly expected_configuration: HostDeckLanCertificateDescriptor;
      readonly now: Date;
    }
  | {
      readonly enabled: false;
      readonly now: Date;
    };

export interface HostDeckLanDesiredState {
  readonly mode: "loopback" | "lan";
  readonly host: string;
  readonly port: number;
  readonly settings_updated_at: string;
}

export interface HostDeckLanConfigurationReceipt {
  readonly before: HostDeckLanConfigurationRecord | null;
  readonly after: HostDeckLanConfigurationRecord;
  readonly changed: boolean;
}

export interface HostDeckLanModeTransitionReceipt {
  readonly before: HostDeckLanDesiredState;
  readonly after: HostDeckLanDesiredState;
  readonly changed: boolean;
}

export interface HostDeckLanStateSnapshot {
  readonly settings: SettingsRecord;
  readonly configuration: HostDeckLanConfigurationRecord | null;
}

export interface HostDeckLanConfigurationRepository {
  readonly read: () => HostDeckLanStateSnapshot;
  readonly configure: (input: ConfigureHostDeckLanInput) => HostDeckLanConfigurationReceipt;
  readonly transitionMode: (input: TransitionHostDeckLanModeInput) => HostDeckLanModeTransitionReceipt;
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

interface LanConfigurationRow {
  readonly id: string;
  readonly schema_version: number;
  readonly bind_host: string;
  readonly address_family: string;
  readonly bind_port: number;
  readonly configured_origin: string;
  readonly root_fingerprint_sha256: string;
  readonly leaf_fingerprint_sha256: string;
  readonly leaf_valid_from: string;
  readonly leaf_expires_at: string;
  readonly updated_at: string;
}

const descriptorKeys = [
  "bind_host",
  "address_family",
  "bind_port",
  "configured_origin",
  "root_fingerprint_sha256",
  "leaf_fingerprint_sha256",
  "leaf_valid_from",
  "leaf_expires_at"
] as const;
const configureKeys = [...descriptorKeys, "now"] as const;
const enableKeys = ["enabled", "expected_configuration", "now"] as const;
const disableKeys = ["enabled", "now"] as const;
const acceptedRepositories = new WeakSet<object>();

export function createHostDeckLanConfigurationRepository(
  db: Database.Database
): HostDeckLanConfigurationRepository {
  const configureTransaction = db.transaction(
    (input: PreparedConfigureInput): HostDeckLanConfigurationReceipt => {
      const settings = requireSettings(db);
      if (settings.lan_enabled) {
        throw new HostDeckLanConfigurationError(
          "lan_configuration_conflict",
          "LAN configuration cannot change while LAN mode is enabled."
        );
      }
      const before = readConfiguration(db);
      if (before !== null && descriptorsEqual(before, input.descriptor)) {
        return configurationReceipt(before, before, false);
      }
      if (before !== null && input.nowMs < Date.parse(before.updated_at)) {
        throw new HostDeckLanConfigurationError(
          "lan_configuration_time_conflict",
          "LAN configuration time conflicts with durable chronology."
        );
      }
      db.prepare(
        `
          INSERT INTO selected_lan_configuration (
            id, schema_version, bind_host, address_family, bind_port,
            configured_origin, root_fingerprint_sha256,
            leaf_fingerprint_sha256, leaf_valid_from, leaf_expires_at, updated_at
          ) VALUES (
            @id, 1, @bind_host, @address_family, @bind_port,
            @configured_origin, @root_fingerprint_sha256,
            @leaf_fingerprint_sha256, @leaf_valid_from, @leaf_expires_at, @updated_at
          )
          ON CONFLICT(id) DO UPDATE SET
            bind_host = excluded.bind_host,
            address_family = excluded.address_family,
            bind_port = excluded.bind_port,
            configured_origin = excluded.configured_origin,
            root_fingerprint_sha256 = excluded.root_fingerprint_sha256,
            leaf_fingerprint_sha256 = excluded.leaf_fingerprint_sha256,
            leaf_valid_from = excluded.leaf_valid_from,
            leaf_expires_at = excluded.leaf_expires_at,
            updated_at = excluded.updated_at
        `
      ).run({
        id: hostDeckLanConfigurationId,
        ...input.descriptor,
        updated_at: input.now
      });
      const after = readConfiguration(db);
      if (
        after === null ||
        !descriptorsEqual(after, input.descriptor) ||
        after.updated_at !== input.now
      ) {
        throw new HostDeckLanConfigurationError(
          "lan_configuration_conflict",
          "LAN configuration did not commit exactly."
        );
      }
      return configurationReceipt(before, after, true);
    }
  ).immediate;

  const transitionTransaction = db.transaction(
    (input: PreparedModeTransitionInput): HostDeckLanModeTransitionReceipt => {
      const beforeSettings = requireSettings(db);
      const before = desiredState(beforeSettings);
      let configuration: HostDeckLanConfigurationRecord | null = null;
      if (input.enabled) {
        configuration = readConfiguration(db);
        if (configuration === null) {
          throw new HostDeckLanConfigurationError(
            "lan_configuration_missing",
            "LAN configuration is required before enablement."
          );
        }
        if (!descriptorsEqual(configuration, input.expectedConfiguration)) {
          throw new HostDeckLanConfigurationError(
            "lan_configuration_conflict",
            "LAN certificate state differs from durable configuration."
          );
        }
        if (beforeSettings.lan_enabled) {
          if (
            beforeSettings.bind_mode !== "lan" ||
            beforeSettings.bind_host !== configuration.bind_host ||
            beforeSettings.bind_port !== configuration.bind_port
          ) {
            throw new HostDeckLanConfigurationError(
              "lan_configuration_conflict",
              "Enabled LAN settings differ from durable configuration."
            );
          }
          return modeReceipt(before, before, false);
        }
      } else if (!beforeSettings.lan_enabled) {
        return modeReceipt(before, before, false);
      }

      if (input.nowMs < Date.parse(beforeSettings.updated_at)) {
        throw new HostDeckLanConfigurationError(
          "lan_configuration_time_conflict",
          "LAN mode transition time conflicts with settings chronology."
        );
      }
      const host = input.enabled ? (configuration as HostDeckLanConfigurationRecord).bind_host : "127.0.0.1";
      const port = input.enabled ? (configuration as HostDeckLanConfigurationRecord).bind_port : beforeSettings.bind_port;
      const update = db
        .prepare(
          `
            UPDATE settings
            SET bind_mode = @bind_mode,
                bind_host = @bind_host,
                bind_port = @bind_port,
                lan_enabled = @lan_enabled,
                updated_at = @updated_at
            WHERE id = 'hostdeck_settings'
              AND bind_mode = @expected_bind_mode
              AND bind_host = @expected_bind_host
              AND bind_port = @expected_bind_port
              AND lan_enabled = @expected_lan_enabled
              AND updated_at = @expected_updated_at
          `
        )
        .run({
          bind_mode: input.enabled ? "lan" : "localhost",
          bind_host: host,
          bind_port: port,
          lan_enabled: input.enabled ? 1 : 0,
          updated_at: input.now,
          expected_bind_mode: beforeSettings.bind_mode,
          expected_bind_host: beforeSettings.bind_host,
          expected_bind_port: beforeSettings.bind_port,
          expected_lan_enabled: beforeSettings.lan_enabled ? 1 : 0,
          expected_updated_at: beforeSettings.updated_at
        });
      if (update.changes !== 1) {
        throw new HostDeckLanConfigurationError(
          "lan_configuration_conflict",
          "LAN settings changed before the transition committed."
        );
      }
      const afterSettings = requireSettings(db);
      assertOnlyNetworkSettingsChanged(beforeSettings, afterSettings, input, host, port);
      return modeReceipt(before, desiredState(afterSettings), true);
    }
  ).immediate;

  const repository: HostDeckLanConfigurationRepository = Object.freeze({
    read() {
      try {
        return Object.freeze({
          settings: requireSettings(db),
          configuration: readConfiguration(db)
        });
      } catch (error) {
        throw sanitizeError(error);
      }
    },
    configure(input: ConfigureHostDeckLanInput) {
      ensureWritable(db);
      try {
        return configureTransaction(prepareConfigureInput(input));
      } catch (error) {
        throw sanitizeError(error);
      }
    },
    transitionMode(input: TransitionHostDeckLanModeInput) {
      ensureWritable(db);
      try {
        return transitionTransaction(prepareModeTransitionInput(input));
      } catch (error) {
        throw sanitizeError(error);
      }
    }
  });
  acceptedRepositories.add(repository);
  return repository;
}

export function assertHostDeckLanConfigurationRepository(
  candidate: unknown
): asserts candidate is HostDeckLanConfigurationRepository {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !acceptedRepositories.has(candidate) ||
    !Object.isFrozen(candidate)
  ) {
    throw new TypeError(
      "HostDeck LAN configuration repository must be created by createHostDeckLanConfigurationRepository."
    );
  }
}

interface PreparedConfigureInput {
  readonly descriptor: HostDeckLanCertificateDescriptor;
  readonly now: string;
  readonly nowMs: number;
}

type PreparedModeTransitionInput =
  | {
      readonly enabled: true;
      readonly expectedConfiguration: HostDeckLanCertificateDescriptor;
      readonly now: string;
      readonly nowMs: number;
    }
  | {
      readonly enabled: false;
      readonly now: string;
      readonly nowMs: number;
    };

function prepareConfigureInput(input: unknown): PreparedConfigureInput {
  const values = readExactDataObject(input, configureKeys);
  const descriptor = parseDescriptor(descriptorFrom(values));
  const now = parseDate(values.now);
  return Object.freeze({ descriptor, now: now.toISOString(), nowMs: now.getTime() });
}

function prepareModeTransitionInput(input: unknown): PreparedModeTransitionInput {
  const probe = readExactDataObject(input, undefined);
  if (probe.enabled === true) {
    const values = readExactDataObject(input, enableKeys);
    const now = parseDate(values.now);
    return Object.freeze({
      enabled: true,
      expectedConfiguration: parseDescriptor(values.expected_configuration),
      now: now.toISOString(),
      nowMs: now.getTime()
    });
  }
  if (probe.enabled === false) {
    const values = readExactDataObject(input, disableKeys);
    const now = parseDate(values.now);
    return Object.freeze({ enabled: false, now: now.toISOString(), nowMs: now.getTime() });
  }
  throw invalidInput();
}

function parseDescriptor(input: unknown): HostDeckLanCertificateDescriptor {
  const value = readExactDataObject(input, descriptorKeys);
  const bindHost = typeof value.bind_host === "string" ? canonicalIpHost(value.bind_host) : null;
  const family = bindHost?.includes(":") ? "ipv6" : "ipv4";
  const port = value.bind_port;
  if (
    bindHost === null ||
    value.address_family !== family ||
    typeof port !== "number" ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    value.configured_origin !== lanOrigin(bindHost, port) ||
    !isFingerprint(value.root_fingerprint_sha256) ||
    !isFingerprint(value.leaf_fingerprint_sha256) ||
    !isoTimestampSchema.safeParse(value.leaf_valid_from).success ||
    !isoTimestampSchema.safeParse(value.leaf_expires_at).success ||
    Date.parse(value.leaf_expires_at as string) <= Date.parse(value.leaf_valid_from as string)
  ) {
    throw invalidInput();
  }
  return Object.freeze({
    bind_host: bindHost,
    address_family: family,
    bind_port: port,
    configured_origin: value.configured_origin as string,
    root_fingerprint_sha256: value.root_fingerprint_sha256 as string,
    leaf_fingerprint_sha256: value.leaf_fingerprint_sha256 as string,
    leaf_valid_from: value.leaf_valid_from as string,
    leaf_expires_at: value.leaf_expires_at as string
  });
}

function descriptorFrom(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(descriptorKeys.map((key) => [key, value[key]]));
}

function requireSettings(db: Database.Database): SettingsRecord {
  const row = db.prepare("SELECT * FROM settings WHERE id = 'hostdeck_settings'").get() as SettingsRow | undefined;
  if (row === undefined) {
    throw new HostDeckLanConfigurationError("settings_missing", "HostDeck settings are unavailable.");
  }
  const result = settingsRecordSchema.safeParse({
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
  if (!result.success) throw invalidInput();
  return Object.freeze({ ...result.data, retention: Object.freeze({ ...result.data.retention }) });
}

function readConfiguration(db: Database.Database): HostDeckLanConfigurationRecord | null {
  const row = db.prepare("SELECT * FROM selected_lan_configuration WHERE id = ?").get(hostDeckLanConfigurationId) as LanConfigurationRow | undefined;
  if (row === undefined) return null;
  const descriptor = parseDescriptor(descriptorFrom(row as unknown as Readonly<Record<string, unknown>>));
  if (
    row.id !== hostDeckLanConfigurationId ||
    row.schema_version !== 1 ||
    !isoTimestampSchema.safeParse(row.updated_at).success
  ) {
    throw invalidInput();
  }
  return Object.freeze({
    id: hostDeckLanConfigurationId,
    schema_version: 1,
    ...descriptor,
    updated_at: row.updated_at
  });
}

function desiredState(settings: SettingsRecord): HostDeckLanDesiredState {
  return Object.freeze({
    mode: settings.lan_enabled ? "lan" : "loopback",
    host: settings.bind_host,
    port: settings.bind_port,
    settings_updated_at: settings.updated_at
  });
}

function configurationReceipt(
  before: HostDeckLanConfigurationRecord | null,
  after: HostDeckLanConfigurationRecord,
  changed: boolean
): HostDeckLanConfigurationReceipt {
  return Object.freeze({ before, after, changed });
}

function modeReceipt(
  before: HostDeckLanDesiredState,
  after: HostDeckLanDesiredState,
  changed: boolean
): HostDeckLanModeTransitionReceipt {
  const same =
    before.mode === after.mode &&
    before.host === after.host &&
    before.port === after.port &&
    before.settings_updated_at === after.settings_updated_at;
  if (changed === same) {
    throw new HostDeckLanConfigurationError(
      "lan_configuration_conflict",
      "LAN transition receipt is inconsistent."
    );
  }
  return Object.freeze({ before, after, changed });
}

function assertOnlyNetworkSettingsChanged(
  before: SettingsRecord,
  after: SettingsRecord,
  input: PreparedModeTransitionInput,
  host: string,
  port: number
): void {
  if (
    after.bind_mode !== (input.enabled ? "lan" : "localhost") ||
    after.bind_host !== host ||
    after.bind_port !== port ||
    after.lan_enabled !== input.enabled ||
    after.updated_at !== input.now ||
    before.id !== after.id ||
    before.schema_version !== after.schema_version ||
    before.state_dir !== after.state_dir ||
    before.locked !== after.locked ||
    JSON.stringify(before.retention) !== JSON.stringify(after.retention)
  ) {
    throw new HostDeckLanConfigurationError(
      "lan_configuration_conflict",
      "LAN transition changed unrelated settings state."
    );
  }
}

function descriptorsEqual(
  left: HostDeckLanCertificateDescriptor,
  right: HostDeckLanCertificateDescriptor
): boolean {
  return descriptorKeys.every((key) => left[key] === right[key]);
}

function readExactDataObject(
  input: unknown,
  expectedKeys: readonly string[] | undefined
): Readonly<Record<string, unknown>> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw invalidInput();
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw invalidInput();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some((key) => {
      if (typeof key !== "string") return true;
      const descriptor = descriptors[key];
      return descriptor === undefined || !descriptor.enumerable || !("value" in descriptor);
    }) ||
    (expectedKeys !== undefined &&
      (keys.length !== expectedKeys.length ||
        keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))))
  ) {
    throw invalidInput();
  }
  return Object.freeze(
    Object.fromEntries(keys.map((key) => [key, descriptors[key as string]?.value]))
  );
}

function parseDate(input: unknown): Date {
  if (!(input instanceof Date)) throw invalidInput();
  const time = Date.prototype.getTime.call(input);
  if (!Number.isFinite(time)) throw invalidInput();
  return new Date(time);
}

function isFingerprint(input: unknown): input is string {
  return typeof input === "string" && /^[a-f0-9]{64}$/u.test(input);
}

function ensureWritable(db: Database.Database): void {
  if (!db.open || db.readonly) {
    throw new HostDeckLanConfigurationError(
      "lan_configuration_unavailable",
      "LAN configuration storage is unavailable."
    );
  }
}

function invalidInput(): HostDeckLanConfigurationError {
  return new HostDeckLanConfigurationError(
    "invalid_lan_configuration",
    "LAN configuration state is invalid."
  );
}

function sanitizeError(error: unknown): HostDeckLanConfigurationError {
  if (error instanceof HostDeckLanConfigurationError) return error;
  return new HostDeckLanConfigurationError(
    "lan_configuration_unavailable",
    "LAN configuration storage is unavailable."
  );
}
