import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  realpathSync,
  rmSync,
  unlinkSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, win32 } from "node:path";
import Database from "better-sqlite3";
import {
  inspectCurrentMigrations,
  type MigrationResult,
  openCurrentReadOnlyDatabase
} from "./migration-runner.js";
import { defaultMigrations, type StorageMigration } from "./migrations.js";
import {
  nativeWindowsFileSecurityPort,
  type WindowsNativePathInspection
} from "./windows-native-file-security.js";

export type HostDeckDatabaseRecoveryErrorCode =
  | "aborted"
  | "backup_failed"
  | "backup_invalid"
  | "destination_exists"
  | "invalid_input"
  | "restore_failed"
  | "source_closed";

export class HostDeckDatabaseRecoveryError extends Error {
  constructor(
    readonly code: HostDeckDatabaseRecoveryErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostDeckDatabaseRecoveryError";
  }
}

export interface CreateHostDeckDatabaseBackupInput {
  readonly database: Database.Database;
  readonly destination_path: string;
  readonly migrations?: readonly StorageMigration[];
  readonly signal?: AbortSignal;
}

export interface RestoreHostDeckDatabaseBackupInput {
  readonly backup_path: string;
  readonly database_path: string;
  readonly migrations?: readonly StorageMigration[];
  readonly signal?: AbortSignal;
}

export interface HostDeckDatabaseRecoveryResult {
  readonly migration: MigrationResult;
  readonly page_count: number;
}

const sqliteSidecarSuffixes = ["", "-journal", "-shm", "-wal"] as const;

export async function createHostDeckDatabaseBackup(
  input: CreateHostDeckDatabaseBackupInput
): Promise<HostDeckDatabaseRecoveryResult> {
  const database = requireOpenDatabase(input?.database);
  const source = requireCanonicalAbsolutePath(
    database.name,
    "database source"
  );
  const destination = requireCanonicalAbsolutePath(
    input?.destination_path,
    "backup destination"
  );
  const migrations = snapshotMigrations(input?.migrations);
  requireCanonicalExistingRegularFile(source);
  requireDistinctPaths(source, destination);
  requireCanonicalParent(destination);
  requireDestinationAbsent(destination);
  requireNotAborted(input?.signal);
  validateOpenDatabase(database, migrations);

  const partial = join(
    dirname(destination),
    `.${basename(destination)}.partial-${process.pid}-${randomUUID()}`
  );
  try {
    const metadata = await transferDatabase(database, partial, input.signal);
    requireNotAborted(input.signal);
    normalizeStandaloneDatabase(partial);
    chmodSync(partial, 0o600);
    const migration = validateStoredDatabase(partial, migrations);
    const result = freezeResult(metadata.totalPages, migration);
    publishExclusive(partial, destination);
    return result;
  } catch (error) {
    const cleanupErrors = removeSqliteFiles(partial);
    if (error instanceof HostDeckDatabaseRecoveryError) {
      if (cleanupErrors.length === 0) throw error;
      throw new HostDeckDatabaseRecoveryError(
        error.code,
        error.message,
        {
          cause: new AggregateError(
            [error, ...cleanupErrors],
            "Database backup and cleanup failed."
          )
        }
      );
    }
    throw new HostDeckDatabaseRecoveryError(
      "backup_failed",
      "Unable to create the HostDeck database backup.",
      {
        cause:
          cleanupErrors.length === 0
            ? error
            : new AggregateError(
                [error, ...cleanupErrors],
                "Database backup and cleanup failed."
              )
      }
    );
  }
}

export async function restoreHostDeckDatabaseBackup(
  input: RestoreHostDeckDatabaseBackupInput
): Promise<HostDeckDatabaseRecoveryResult> {
  const backup = requireCanonicalAbsolutePath(input?.backup_path, "backup source");
  const destination = requireCanonicalAbsolutePath(
    input?.database_path,
    "database destination"
  );
  const migrations = snapshotMigrations(input?.migrations);
  requireDistinctPaths(backup, destination);
  requireCanonicalParent(destination);
  requireCanonicalExistingRegularFile(backup);
  requireNotAborted(input?.signal);
  const destinationExisted = existsSync(destination);
  if (destinationExisted) requireCanonicalExistingRegularFile(destination);

  let source: ReturnType<typeof openCurrentReadOnlyDatabase> | null = null;
  try {
    source = openCurrentReadOnlyDatabase(backup, { migrations });
    validateOpenDatabase(source.db, migrations);
  } catch (error) {
    const failures: unknown[] = [error];
    if (source !== null) {
      try {
        source.db.close();
      } catch (closeError) {
        failures.push(closeError);
      }
    }
    throw new HostDeckDatabaseRecoveryError(
      "backup_invalid",
      "The HostDeck database backup is not a valid current snapshot.",
      {
        cause:
          failures.length === 1
            ? error
            : new AggregateError(
                failures,
                "Database backup validation and cleanup failed."
              )
      }
    );
  }
  const currentSource = source;

  try {
    const metadata = await transferDatabase(
      currentSource.db,
      destination,
      input.signal
    );
    normalizeStandaloneDatabase(destination);
    chmodSync(destination, 0o600);
    const migration = validateStoredDatabase(destination, migrations);
    return freezeResult(metadata.totalPages, migration);
  } catch (error) {
    const cleanupErrors = destinationExisted
      ? []
      : removeSqliteFiles(destination);
    if (error instanceof HostDeckDatabaseRecoveryError) {
      if (cleanupErrors.length === 0) throw error;
      throw new HostDeckDatabaseRecoveryError(error.code, error.message, {
        cause: new AggregateError(
          [error, ...cleanupErrors],
          "Database restore and cleanup failed."
        )
      });
    }
    throw new HostDeckDatabaseRecoveryError(
      "restore_failed",
      "Unable to restore the HostDeck database backup.",
      {
        cause:
          cleanupErrors.length === 0
            ? error
            : new AggregateError(
                [error, ...cleanupErrors],
                "Database restore and cleanup failed."
              )
      }
    );
  } finally {
    currentSource.db.close();
  }
}

async function transferDatabase(
  source: Database.Database,
  destination: string,
  signal: AbortSignal | undefined
): Promise<Database.BackupMetadata> {
  requireNotAborted(signal);
  return source.backup(destination, {
    progress(metadata) {
      requireNotAborted(signal);
      return Math.min(256, Math.max(1, metadata.remainingPages));
    }
  });
}

function validateOpenDatabase(
  database: Database.Database,
  migrations: readonly StorageMigration[]
): MigrationResult {
  if (!database.open) {
    throw new HostDeckDatabaseRecoveryError(
      "source_closed",
      "The HostDeck database source is closed."
    );
  }
  if (database.inTransaction) {
    throw new HostDeckDatabaseRecoveryError(
      "invalid_input",
      "Database backup and restore require an outer transaction boundary."
    );
  }
  const migration = inspectCurrentMigrations(database, migrations);
  requireHealthyDatabase(database);
  return migration;
}

function validateStoredDatabase(
  path: string,
  migrations: readonly StorageMigration[]
): MigrationResult {
  let opened: ReturnType<typeof openCurrentReadOnlyDatabase>;
  try {
    opened = openCurrentReadOnlyDatabase(path, { migrations });
  } catch (error) {
    throw new HostDeckDatabaseRecoveryError(
      "backup_invalid",
      "The HostDeck database snapshot failed migration validation.",
      { cause: error }
    );
  }
  try {
    requireHealthyDatabase(opened.db);
    return opened.result;
  } finally {
    opened.db.close();
  }
}

function requireHealthyDatabase(database: Database.Database): void {
  const quickCheck = database.pragma("quick_check") as Array<{
    readonly quick_check: string;
  }>;
  const foreignKeyCheck = database.pragma("foreign_key_check") as unknown[];
  if (
    quickCheck.length !== 1 ||
    quickCheck[0]?.quick_check !== "ok" ||
    foreignKeyCheck.length !== 0
  ) {
    throw new HostDeckDatabaseRecoveryError(
      "backup_invalid",
      "The HostDeck database snapshot failed SQLite integrity validation."
    );
  }
}

function normalizeStandaloneDatabase(path: string): void {
  const database = new Database(path, { fileMustExist: true });
  try {
    const mode = database.pragma("journal_mode = DELETE", { simple: true });
    if (mode !== "delete") {
      throw new HostDeckDatabaseRecoveryError(
        "backup_invalid",
        "The HostDeck database snapshot is not standalone."
      );
    }
  } finally {
    database.close();
  }
}

function requireOpenDatabase(candidate: unknown): Database.Database {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    typeof (candidate as Database.Database).backup !== "function" ||
    typeof (candidate as Database.Database).name !== "string"
  ) {
    throw new HostDeckDatabaseRecoveryError(
      "invalid_input",
      "Database backup input is invalid."
    );
  }
  return candidate as Database.Database;
}

function requireCanonicalAbsolutePath(candidate: unknown, label: string): string {
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.includes("\0") ||
    !isAbsolute(candidate) ||
    resolve(candidate) !== candidate ||
    basename(candidate).length === 0
  ) {
    throw new HostDeckDatabaseRecoveryError(
      "invalid_input",
      `HostDeck ${label} is invalid.`
    );
  }
  return candidate;
}

function requireCanonicalParent(path: string): void {
  const parent = dirname(path);
  if (process.platform === "win32") {
    requireSafeWindowsDirectoryTree(parent);
    return;
  }
  let metadata: ReturnType<typeof lstatSync>;
  let actual: string;
  try {
    metadata = lstatSync(parent);
    actual = realpathSync.native(parent);
  } catch (error) {
    throw new HostDeckDatabaseRecoveryError(
      "invalid_input",
      "HostDeck database parent directory is unavailable.",
      { cause: error }
    );
  }
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !sameNativePath(actual, parent)
  ) {
    throw new HostDeckDatabaseRecoveryError(
      "invalid_input",
      "HostDeck database parent directory is not canonical."
    );
  }
}

function requireCanonicalExistingRegularFile(path: string): void {
  if (process.platform === "win32") {
    requireSafeWindowsDirectoryTree(dirname(path));
    const inspection = inspectWindowsPath(path, "database file");
    if (
      inspection.is_directory ||
      inspection.is_reparse_point ||
      inspection.has_named_streams ||
      inspection.link_count !== 1
    ) {
      throw new HostDeckDatabaseRecoveryError(
        "invalid_input",
        "HostDeck database file identity is invalid."
      );
    }
    return;
  }
  let metadata: ReturnType<typeof lstatSync>;
  let actual: string;
  try {
    metadata = lstatSync(path);
    actual = realpathSync.native(path);
  } catch (error) {
    throw new HostDeckDatabaseRecoveryError(
      "invalid_input",
      "HostDeck database file is unavailable.",
      { cause: error }
    );
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    !sameNativePath(actual, path)
  ) {
    throw new HostDeckDatabaseRecoveryError(
      "invalid_input",
      "HostDeck database file identity is invalid."
    );
  }
}

function requireSafeWindowsDirectoryTree(path: string): void {
  const root = win32.parse(path).root;
  let cursor = path;
  for (;;) {
    const inspection = inspectWindowsPath(cursor, "database parent directory");
    if (
      !inspection.is_directory ||
      inspection.is_reparse_point ||
      inspection.has_named_streams
    ) {
      throw new HostDeckDatabaseRecoveryError(
        "invalid_input",
        "HostDeck database parent directory is not canonical."
      );
    }
    if (sameNativePath(cursor, root)) return;
    const parent = win32.dirname(cursor);
    if (sameNativePath(parent, cursor)) {
      throw new HostDeckDatabaseRecoveryError(
        "invalid_input",
        "HostDeck database parent directory is not canonical."
      );
    }
    cursor = parent;
  }
}

function inspectWindowsPath(
  path: string,
  label: string
): WindowsNativePathInspection {
  try {
    return nativeWindowsFileSecurityPort.inspectPath(path);
  } catch (error) {
    throw new HostDeckDatabaseRecoveryError(
      "invalid_input",
      `HostDeck ${label} is unavailable.`,
      { cause: error }
    );
  }
}

function publishExclusive(partial: string, destination: string): void {
  try {
    linkSync(partial, destination);
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      throw new HostDeckDatabaseRecoveryError(
        "destination_exists",
        "HostDeck database backup destination already exists.",
        { cause: error }
      );
    }
    throw error;
  }
  try {
    unlinkSync(partial);
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      rmSync(destination, { force: true });
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    throw new AggregateError(failures, "Database backup publication failed.");
  }
}

function snapshotMigrations(
  migrations: readonly StorageMigration[] | undefined
): readonly StorageMigration[] {
  const selected = migrations ?? defaultMigrations;
  if (!Array.isArray(selected)) {
    throw new HostDeckDatabaseRecoveryError(
      "invalid_input",
      "HostDeck database migrations are invalid."
    );
  }
  return Object.freeze(
    selected.map((migration) => {
      if (
        migration === null ||
        typeof migration !== "object" ||
        typeof migration.version !== "string" ||
        typeof migration.sql !== "string"
      ) {
        throw new HostDeckDatabaseRecoveryError(
          "invalid_input",
          "HostDeck database migrations are invalid."
        );
      }
      return Object.freeze({ version: migration.version, sql: migration.sql });
    })
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function requireDestinationAbsent(path: string): void {
  if (sqliteSidecarSuffixes.some((suffix) => existsSync(`${path}${suffix}`))) {
    throw new HostDeckDatabaseRecoveryError(
      "destination_exists",
      "HostDeck database backup destination already exists."
    );
  }
}

function requireDistinctPaths(left: string, right: string): void {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  if (sameNativePath(resolvedLeft, resolvedRight)) {
    throw new HostDeckDatabaseRecoveryError(
      "invalid_input",
      "HostDeck database source and destination must differ."
    );
  }
}

function sameNativePath(left: string, right: string): boolean {
  if (process.platform !== "win32") return left === right;
  return normalizeWindowsPath(left) === normalizeWindowsPath(right);
}

function normalizeWindowsPath(path: string): string {
  const separators = path.replaceAll("/", "\\");
  const withoutNamespace = separators.startsWith("\\\\?\\UNC\\")
    ? `\\\\${separators.slice(8)}`
    : separators.startsWith("\\\\?\\")
      ? separators.slice(4)
      : separators;
  return withoutNamespace.toLowerCase();
}

function requireNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new HostDeckDatabaseRecoveryError(
      "aborted",
      "HostDeck database recovery was aborted."
    );
  }
}

function removeSqliteFiles(path: string): unknown[] {
  const errors: unknown[] = [];
  for (const suffix of sqliteSidecarSuffixes) {
    try {
      rmSync(`${path}${suffix}`, { force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function freezeResult(
  pageCount: number,
  migration: MigrationResult
): HostDeckDatabaseRecoveryResult {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
    throw new HostDeckDatabaseRecoveryError(
      "backup_invalid",
      "SQLite returned invalid database backup metadata."
    );
  }
  return Object.freeze({
    migration: Object.freeze({
      applied: Object.freeze([...migration.applied]),
      currentVersion: migration.currentVersion
    }),
    page_count: pageCount
  });
}
