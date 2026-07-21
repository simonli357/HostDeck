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
  readonly version: string;
  readonly checksum: string;
}

const noVersion = "none";

export function openMigratedDatabase(path: string, options: OpenMigratedDatabaseOptions = {}): { readonly db: Database.Database; readonly result: MigrationResult } {
  let db: Database.Database;

  try {
    db = new Database(path, { readonly: options.readonly ?? false });
  } catch (error) {
    throw new HostDeckMigrationError("corrupt_database", `Unable to open SQLite database at ${path}.`, { cause: error });
  }

  try {
    db.pragma("foreign_keys = ON");
    const result = runMigrations(db, options);
    return { db, result };
  } catch (error) {
    db.close();
    throw error;
  }
}

export function openCurrentReadOnlyDatabase(
  path: string,
  options: OpenCurrentReadOnlyDatabaseOptions = {}
): { readonly db: Database.Database; readonly result: MigrationResult } {
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
    const result = inspectCurrentMigrations(
      db,
      options.migrations ?? defaultMigrations
    );
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
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
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
  const migrations = options.migrations ?? defaultMigrations;
  const now = options.now ?? (() => new Date());
  assertUniqueMigrations(migrations);

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
          now().toISOString()
        );
        applied.push(migration.version);
      }
    });

    try {
      applyPending();
    } catch (error) {
      throw new HostDeckMigrationError("failed_migration", "Failed to apply SQLite migration.", { cause: error });
    }

    return {
      applied,
      currentVersion: migrations.at(-1)?.version ?? noVersion
    };
  } catch (error) {
    if (error instanceof HostDeckMigrationError) {
      throw error;
    }

    throw new HostDeckMigrationError("corrupt_database", "Unable to read SQLite migration state.", { cause: error });
  }
}

function inspectCurrentMigrations(
  db: Database.Database,
  migrations: readonly StorageMigration[]
): MigrationResult {
  try {
    assertUniqueMigrations(migrations);
    const existing = readAppliedMigrations(db);
    assertNoUntrackedSchema(db, existing);
    const appliedVersions = validateAppliedMigrations(migrations, existing);
    assertContiguousAppliedMigrations(migrations, appliedVersions);
    if (existing.length !== migrations.length) {
      throw new HostDeckMigrationError(
        "schema_not_current",
        "Database schema is not at the current HostDeck migration."
      );
    }
    return Object.freeze({
      applied: Object.freeze([]),
      currentVersion: migrations.at(-1)?.version ?? noVersion
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
        `Database has unknown migration version ${record.version}.`
      );
    }
    if (record.checksum !== migrationChecksum(known.sql)) {
      throw new HostDeckMigrationError(
        "migration_checksum_mismatch",
        `Database migration ${record.version} checksum does not match code.`
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

  return db
    .prepare("SELECT version, checksum FROM schema_migrations ORDER BY version ASC")
    .all() as AppliedMigrationRecord[];
}

function assertNoUntrackedSchema(db: Database.Database, appliedMigrations: readonly AppliedMigrationRecord[]): void {
  if (appliedMigrations.length > 0) {
    return;
  }

  const nonMigrationTables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'")
    .all() as Array<{ readonly name: string }>;

  if (nonMigrationTables.length > 0) {
    throw new HostDeckMigrationError("unknown_migration", "Database has tables but no HostDeck migration history.");
  }
}

function assertUniqueMigrations(migrations: readonly StorageMigration[]): void {
  const seen = new Set<string>();

  for (const migration of migrations) {
    if (seen.has(migration.version)) {
      throw new HostDeckMigrationError("duplicate_migration", `Duplicate migration version ${migration.version}.`);
    }
    seen.add(migration.version);
  }
}

function assertContiguousAppliedMigrations(migrations: readonly StorageMigration[], appliedVersions: ReadonlySet<string>): void {
  let missingEarlierVersion: string | null = null;

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) {
      if (missingEarlierVersion !== null) {
        throw new HostDeckMigrationError(
          "migration_sequence_gap",
          `Database has migration ${migration.version} but is missing earlier migration ${missingEarlierVersion}.`
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
