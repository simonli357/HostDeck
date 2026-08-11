import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  openSync,
  readSync
} from "node:fs";
import Database from "better-sqlite3";
import { defaultMigrations, type StorageMigration } from "./migrations.js";

export type MigrationErrorCode =
  | "corrupt_database"
  | "duplicate_migration"
  | "failed_migration"
  | "invalid_migration_catalog"
  | "invalid_migration_clock"
  | "migration_checksum_mismatch"
  | "migration_sequence_gap"
  | "read_only_sidecars_unavailable"
  | "schema_not_current"
  | "unknown_migration";

export class HostDeckMigrationError extends Error {
  constructor(
    readonly code: MigrationErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostDeckMigrationError";
  }
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly currentVersion: string;
}

export interface RunMigrationsOptions {
  readonly migrations?: readonly StorageMigration[];
  readonly now?: () => Date;
}

export interface OpenMigratedDatabaseOptions extends RunMigrationsOptions {
  readonly readonly?: boolean;
}

export interface OpenCurrentReadOnlyDatabaseOptions {
  readonly migrations?: readonly StorageMigration[];
}

interface AppliedMigrationRecord {
  readonly applied_at: string;
  readonly checksum: string;
  readonly version: string;
}

interface MigrationColumnRecord {
  readonly cid: number;
  readonly dflt_value: unknown;
  readonly name: string;
  readonly not_null: number;
  readonly pk: number;
  readonly type: string;
}

const noVersion = "none";
const maximumMigrationCount = 128;
const maximumMigrationSqlBytes = 1024 * 1024;
const maximumMigrationSqlTotalBytes = 8 * 1024 * 1024;
const migrationVersionPattern = /^\d{12}_[a-z][a-z0-9_]{0,63}$/u;
const migrationChecksumPattern = /^[a-f0-9]{64}$/u;

export function openMigratedDatabase(path: string, options: OpenMigratedDatabaseOptions = {}): { readonly db: Database.Database; readonly result: MigrationResult } {
  const migrations = snapshotStorageMigrations(options?.migrations);
  const now = requireMigrationClock(options?.now);
  let db: Database.Database;

  try {
    db = new Database(path, { readonly: options?.readonly ?? false });
  } catch (error) {
    throw new HostDeckMigrationError(
      "corrupt_database",
      "Unable to open the HostDeck SQLite database.",
      { cause: error }
    );
  }

  try {
    db.pragma("foreign_keys = ON");
    const result = runMigrations(db, { migrations, now });
    return Object.freeze({ db, result });
  } catch (error) {
    db.close();
    throw error;
  }
}

export function openCurrentReadOnlyDatabase(
  path: string,
  options: OpenCurrentReadOnlyDatabaseOptions = {}
): { readonly db: Database.Database; readonly result: MigrationResult } {
  const migrations = snapshotStorageMigrations(options?.migrations);
  requireNonCreatingReadOnlyOpen(path);
  let db: Database.Database;
  try {
    db = new Database(path, { fileMustExist: true, readonly: true });
  } catch (error) {
    throw new HostDeckMigrationError(
      "corrupt_database",
      "Unable to open the existing SQLite database read-only.",
      { cause: error }
    );
  }

  try {
    db.pragma("foreign_keys = ON");
    db.pragma("query_only = ON");
    db.pragma("temp_store = MEMORY");
    db.pragma("trusted_schema = OFF");
    if (
      !db.readonly ||
      db.pragma("query_only", { simple: true }) !== 1 ||
      db.pragma("temp_store", { simple: true }) !== 2 ||
      db.pragma("trusted_schema", { simple: true }) !== 0
    ) {
      throw new HostDeckMigrationError(
        "corrupt_database",
        "SQLite did not retain the required read-only state."
      );
    }
    const result = inspectCurrentMigrations(db, migrations);
    return Object.freeze({ db, result });
  } catch (error) {
    let closeError: unknown;
    try {
      db.close();
    } catch (caught) {
      closeError = caught;
    }
    if (error instanceof HostDeckMigrationError && closeError === undefined) {
      throw error;
    }
    throw new HostDeckMigrationError(
      "corrupt_database",
      "Unable to validate the existing SQLite database read-only.",
      {
        cause:
          closeError === undefined
            ? error
            : new AggregateError(
                [error, closeError],
                "Read-only database validation and cleanup failed."
              )
      }
    );
  }
}

function requireNonCreatingReadOnlyOpen(path: string): void {
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY |
        fsConstants.O_NONBLOCK |
        (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW)
    );
  } catch (error) {
    throw new HostDeckMigrationError(
      "corrupt_database",
      "Unable to inspect the existing SQLite database.",
      { cause: error }
    );
  }
  const header = Buffer.alloc(20);
  let inspectionError: HostDeckMigrationError | undefined;
  try {
    if (readSync(descriptor, header, 0, header.length, 0) !== header.length) {
      throw new HostDeckMigrationError(
        "corrupt_database",
        "SQLite database header is incomplete."
      );
    }
  } catch (error) {
    inspectionError =
      error instanceof HostDeckMigrationError
        ? error
        : new HostDeckMigrationError(
            "corrupt_database",
            "Unable to read the SQLite database header.",
            { cause: error }
          );
  }
  let closeError: unknown;
  try {
    closeSync(descriptor);
  } catch (error) {
    closeError = error;
  }
  if (inspectionError !== undefined) {
    if (closeError === undefined) throw inspectionError;
    throw new HostDeckMigrationError(
      "corrupt_database",
      "Unable to inspect the SQLite database header safely.",
      {
        cause: new AggregateError(
          [inspectionError, closeError],
          "SQLite header inspection and cleanup failed."
        )
      }
    );
  }
  if (closeError !== undefined) {
    throw new HostDeckMigrationError(
      "corrupt_database",
      "Unable to close the SQLite database inspection handle.",
      { cause: closeError }
    );
  }

  const signature = header.subarray(0, 16).toString("binary");
  const writeVersion = header[18];
  const readVersion = header[19];
  if (
    signature !== "SQLite format 3\0" ||
    (writeVersion !== 1 && writeVersion !== 2) ||
    (readVersion !== 1 && readVersion !== 2) ||
    writeVersion !== readVersion
  ) {
    throw new HostDeckMigrationError(
      "corrupt_database",
      "SQLite database header is invalid."
    );
  }
  if (
    writeVersion === 2 &&
    (!existsSync(`${path}-wal`) || !existsSync(`${path}-shm`))
  ) {
    throw new HostDeckMigrationError(
      "read_only_sidecars_unavailable",
      "A WAL database requires existing WAL and shared-memory files for a non-creating read-only open."
    );
  }
}

export function runMigrations(db: Database.Database, options: RunMigrationsOptions = {}): MigrationResult {
  const migrations = snapshotStorageMigrations(options?.migrations);
  const now = requireMigrationClock(options?.now);

  try {
    ensureMigrationTable(db);
    const existing = readAppliedMigrations(db);
    assertNoUntrackedSchema(db, existing);
    const appliedVersions = validateAppliedMigrations(migrations, existing);

    assertContiguousAppliedMigrations(migrations, appliedVersions);

    const pending = migrations.filter((migration) => !appliedVersions.has(migration.version));
    const applied: string[] = [];

    const applyPending = db.transaction(() => {
      for (const migration of pending) {
        db.exec(migration.sql);
        db.prepare("INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)").run(
          migration.version,
          migrationChecksum(migration.sql),
          migrationTimestamp(now)
        );
        applied.push(migration.version);
      }
    });

    try {
      applyPending();
    } catch (error) {
      if (error instanceof HostDeckMigrationError) throw error;
      throw new HostDeckMigrationError("failed_migration", "Failed to apply SQLite migration.", { cause: error });
    }

    return Object.freeze({
      applied: Object.freeze(applied),
      currentVersion: migrations.at(-1)?.version ?? noVersion
    });
  } catch (error) {
    if (error instanceof HostDeckMigrationError) {
      throw error;
    }

    throw new HostDeckMigrationError("corrupt_database", "Unable to read SQLite migration state.", { cause: error });
  }
}

export function inspectCurrentMigrations(
  db: Database.Database,
  migrations: readonly StorageMigration[]
): MigrationResult {
  try {
    const catalog = snapshotStorageMigrations(migrations);
    const existing = readAppliedMigrations(db);
    assertNoUntrackedSchema(db, existing);
    const appliedVersions = validateAppliedMigrations(catalog, existing);
    assertContiguousAppliedMigrations(catalog, appliedVersions);
    if (existing.length !== catalog.length) {
      throw new HostDeckMigrationError(
        "schema_not_current",
        "Database schema is not at the current HostDeck migration."
      );
    }
    return Object.freeze({
      applied: Object.freeze([]),
      currentVersion: catalog.at(-1)?.version ?? noVersion
    });
  } catch (error) {
    if (error instanceof HostDeckMigrationError) throw error;
    throw new HostDeckMigrationError(
      "corrupt_database",
      "Unable to read SQLite migration state.",
      { cause: error }
    );
  }
}

function validateAppliedMigrations(
  migrations: readonly StorageMigration[],
  existing: readonly AppliedMigrationRecord[]
): ReadonlySet<string> {
  const knownByVersion = new Map(
    migrations.map((migration) => [migration.version, migration])
  );
  const appliedVersions = new Set(
    existing.map((migration) => migration.version)
  );

  for (const record of existing) {
    const known = knownByVersion.get(record.version);
    if (known === undefined) {
      throw new HostDeckMigrationError(
        "unknown_migration",
        "Database has an unknown migration version."
      );
    }
    if (record.checksum !== migrationChecksum(known.sql)) {
      throw new HostDeckMigrationError(
        "migration_checksum_mismatch",
        "Database migration checksum does not match code."
      );
    }
  }
  return appliedVersions;
}

function ensureMigrationTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

function readAppliedMigrations(db: Database.Database): readonly AppliedMigrationRecord[] {
  const migrationTableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { readonly name: string } | undefined;

  if (migrationTableExists === undefined) {
    return [];
  }
  assertMigrationTableContract(db);

  const records = db
    .prepare(
      "SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version ASC LIMIT ?"
    )
    .all(maximumMigrationCount + 1) as AppliedMigrationRecord[];
  if (records.length > maximumMigrationCount) {
    throw new HostDeckMigrationError(
      "unknown_migration",
      "Database migration history exceeds the supported bound."
    );
  }
  for (const record of records) {
    if (
      record === null ||
      typeof record !== "object" ||
      typeof record.version !== "string" ||
      !migrationVersionPattern.test(record.version) ||
      typeof record.checksum !== "string" ||
      !migrationChecksumPattern.test(record.checksum) ||
      typeof record.applied_at !== "string" ||
      !isCanonicalTimestamp(record.applied_at)
    ) {
      throw new HostDeckMigrationError(
        "unknown_migration",
        "Database migration history is invalid."
      );
    }
  }
  return Object.freeze(
    records.map((record) => Object.freeze({ ...record }))
  );
}

function assertNoUntrackedSchema(db: Database.Database, appliedMigrations: readonly AppliedMigrationRecord[]): void {
  if (appliedMigrations.length > 0) {
    return;
  }

  const nonMigrationTables = db
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' LIMIT 1"
    )
    .get() as { readonly present: 1 } | undefined;

  if (nonMigrationTables !== undefined) {
    throw new HostDeckMigrationError("unknown_migration", "Database has tables but no HostDeck migration history.");
  }
}

function assertMigrationTableContract(db: Database.Database): void {
  const columns = db
    .prepare(
      "SELECT cid, name, type, \"notnull\" AS not_null, dflt_value, pk FROM pragma_table_info('schema_migrations') ORDER BY cid LIMIT 4"
    )
    .all() as MigrationColumnRecord[];
  const expected = [
    { cid: 0, name: "version", type: "TEXT", not_null: 0, dflt_value: null, pk: 1 },
    { cid: 1, name: "checksum", type: "TEXT", not_null: 1, dflt_value: null, pk: 0 },
    { cid: 2, name: "applied_at", type: "TEXT", not_null: 1, dflt_value: null, pk: 0 }
  ];
  const trigger = db
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'schema_migrations' LIMIT 1"
    )
    .get();
  const columnsMatch =
    columns.length === expected.length &&
    columns.every((column, index) => {
      const selected = expected[index];
      return (
        selected !== undefined &&
        column.cid === selected.cid &&
        column.name === selected.name &&
        column.type === selected.type &&
        column.not_null === selected.not_null &&
        column.dflt_value === selected.dflt_value &&
        column.pk === selected.pk
      );
    });
  if (!columnsMatch || trigger !== undefined) {
    throw new HostDeckMigrationError(
      "corrupt_database",
      "Database migration table contract is invalid."
    );
  }
}

function assertContiguousAppliedMigrations(migrations: readonly StorageMigration[], appliedVersions: ReadonlySet<string>): void {
  let missingEarlierVersion: string | null = null;

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) {
      if (missingEarlierVersion !== null) {
        throw new HostDeckMigrationError(
          "migration_sequence_gap",
          "Database migration history contains a sequence gap."
        );
      }
      continue;
    }

    missingEarlierVersion ??= migration.version;
  }
}

function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

export function snapshotStorageMigrations(
  candidate: readonly StorageMigration[] | undefined
): readonly StorageMigration[] {
  const selected = candidate === undefined ? defaultMigrations : candidate;
  if (!Array.isArray(selected) || selected.length > maximumMigrationCount) {
    throw invalidMigrationCatalog();
  }

  const snapshot: StorageMigration[] = [];
  let totalSqlBytes = 0;
  let previousVersion: string | null = null;
  try {
    for (const migration of selected) {
      if (migration === null || typeof migration !== "object") {
        throw invalidMigrationCatalog();
      }
      const version = migration.version;
      const sql = migration.sql;
      const sqlBytes =
        typeof sql === "string" ? Buffer.byteLength(sql, "utf8") : -1;
      if (
        typeof version !== "string" ||
        !migrationVersionPattern.test(version) ||
        typeof sql !== "string" ||
        sql.trim().length === 0 ||
        sqlBytes > maximumMigrationSqlBytes
      ) {
        throw invalidMigrationCatalog();
      }
      if (previousVersion === version) {
        throw new HostDeckMigrationError(
          "duplicate_migration",
          "HostDeck migration catalog contains a duplicate version."
        );
      }
      if (previousVersion !== null && previousVersion > version) {
        throw invalidMigrationCatalog();
      }
      totalSqlBytes += sqlBytes;
      if (totalSqlBytes > maximumMigrationSqlTotalBytes) {
        throw invalidMigrationCatalog();
      }
      snapshot.push(Object.freeze({ version, sql }));
      previousVersion = version;
    }
  } catch (error) {
    if (error instanceof HostDeckMigrationError) throw error;
    throw invalidMigrationCatalog(error);
  }
  return Object.freeze(snapshot);
}

function requireMigrationClock(candidate: (() => Date) | undefined): () => Date {
  if (candidate !== undefined && typeof candidate !== "function") {
    throw new HostDeckMigrationError(
      "invalid_migration_clock",
      "HostDeck migration clock is invalid."
    );
  }
  return candidate ?? (() => new Date());
}

function migrationTimestamp(now: () => Date): string {
  let candidate: Date;
  try {
    candidate = now();
  } catch (error) {
    throw new HostDeckMigrationError(
      "invalid_migration_clock",
      "HostDeck migration clock failed.",
      { cause: error }
    );
  }
  let milliseconds: number;
  try {
    milliseconds = Date.prototype.getTime.call(candidate);
  } catch {
    milliseconds = Number.NaN;
  }
  if (!(candidate instanceof Date) || !Number.isFinite(milliseconds)) {
    throw new HostDeckMigrationError(
      "invalid_migration_clock",
      "HostDeck migration clock returned an invalid instant."
    );
  }
  return new Date(milliseconds).toISOString();
}

function isCanonicalTimestamp(value: string): boolean {
  if (value.length !== 24) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function invalidMigrationCatalog(cause?: unknown): HostDeckMigrationError {
  return new HostDeckMigrationError(
    "invalid_migration_catalog",
    "HostDeck migration catalog is invalid.",
    cause === undefined ? undefined : { cause }
  );
}
