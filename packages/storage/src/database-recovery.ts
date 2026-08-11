import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  linkSync,
  rmSync,
  unlinkSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import Database from "better-sqlite3";
import {
  type HostDeckDaemonLease,
  requireActiveHostDeckDaemonLease
} from "./daemon-lease.js";
import {
  inspectCurrentMigrations,
  type MigrationResult,
  openCurrentReadOnlyDatabase,
  snapshotStorageMigrations
} from "./migration-runner.js";
import type { StorageMigration } from "./migrations.js";
import {
  inspectExistingHostDeckStatePaths,
  type OpenedSecureHostDeckRegularFile,
  openSecureHostDeckRegularFile
} from "./secure-local-paths.js";

export type HostDeckDatabaseRecoveryErrorCode =
  | "aborted"
  | "authority_invalid"
  | "backup_failed"
  | "backup_invalid"
  | "destination_exists"
  | "invalid_input"
  | "restore_failed"
  | "source_closed"
  | "state_insecure";

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
  readonly lease: HostDeckDaemonLease;
  readonly migrations?: readonly StorageMigration[];
  readonly signal?: AbortSignal;
  readonly state_dir: string;
}

export interface RestoreHostDeckDatabaseBackupInput {
  readonly backup_path: string;
  readonly database_path: string;
  readonly lease: HostDeckDaemonLease;
  readonly migrations?: readonly StorageMigration[];
  readonly signal?: AbortSignal;
  readonly state_dir: string;
}

export interface HostDeckDatabaseRecoveryResult {
  readonly migration: MigrationResult;
  readonly page_count: number;
}

const sqliteSidecarSuffixes = ["", "-journal", "-shm", "-wal"] as const;

interface HostDeckDatabaseRecoveryAuthority {
  readonly verify: () => void;
}

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
  const stateDir = requireCanonicalAbsolutePath(input?.state_dir, "state directory");
  const migrations = requireMigrationCatalog(input?.migrations);
  requireDistinctPaths(source, destination);
  const authority = requireRecoveryState(
    stateDir,
    [source, destination],
    input?.lease
  );
  requireDestinationAbsent(destination);
  requireNotAborted(input?.signal);

  const partial = join(
    dirname(destination),
    `.${basename(destination)}.partial-${process.pid}-${randomUUID()}`
  );
  let published = false;
  try {
    const metadata = await withSecureRecoveryFile(
      source,
      "database source",
      false,
      async () => {
        authority.verify();
        validateOpenDatabase(database, migrations);
        const metadata = await transferDatabase(database, partial, input.signal);
        authority.verify();
        return metadata;
      }
    );
    requireNotAborted(input.signal);
    const result = await withSecureRecoveryFile(
      partial,
      "database backup partial",
      true,
      () => {
        normalizeStandaloneDatabase(partial);
        const migration = validateStoredDatabase(partial, migrations);
        requireStandaloneDatabase(partial);
        return freezeResult(metadata.totalPages, migration);
      }
    );
    requireDestinationAbsent(destination);
    authority.verify();
    publishExclusive(partial, destination);
    published = true;
    await withSecureRecoveryFile(
      destination,
      "database backup",
      false,
      () => {
        requireStandaloneDatabase(destination);
      }
    );
    authority.verify();
    return result;
  } catch (error) {
    const cleanupErrors = [
      ...removeSqliteFiles(partial),
      ...(published ? removeSqliteFiles(destination) : [])
    ];
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
  const stateDir = requireCanonicalAbsolutePath(input?.state_dir, "state directory");
  const migrations = requireMigrationCatalog(input?.migrations);
  requireDistinctPaths(backup, destination);
  const authority = requireRecoveryState(
    stateDir,
    [backup, destination],
    input?.lease
  );
  requireNotAborted(input?.signal);
  const destinationExisted = existsSync(destination);

  try {
    const result = await withSecureRecoveryFile(
      backup,
      "database backup",
      false,
      async () => {
        authority.verify();
        const source = openValidatedBackup(backup, migrations);
        try {
          const restore = async (): Promise<HostDeckDatabaseRecoveryResult> => {
            const metadata = await transferDatabase(
              source.db,
              destination,
              input.signal
            );
            authority.verify();
            requireNotAborted(input.signal);
            normalizeStandaloneDatabase(destination);
            const migration = validateStoredDatabase(destination, migrations);
            requireStandaloneDatabase(destination);
            return freezeResult(metadata.totalPages, migration);
          };
          if (destinationExisted) {
            return await withSecureRecoveryFile(
              destination,
              "database destination",
              false,
              restore
            );
          }
          const metadata = await transferDatabase(
            source.db,
            destination,
            input.signal
          );
          authority.verify();
          requireNotAborted(input.signal);
          return await withSecureRecoveryFile(
            destination,
            "database destination",
            true,
            () => {
              normalizeStandaloneDatabase(destination);
              const migration = validateStoredDatabase(destination, migrations);
              requireStandaloneDatabase(destination);
              return freezeResult(metadata.totalPages, migration);
            }
          );
        } finally {
          source.db.close();
        }
      }
    );
    authority.verify();
    return result;
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

function openValidatedBackup(
  path: string,
  migrations: readonly StorageMigration[]
): ReturnType<typeof openCurrentReadOnlyDatabase> {
  let source: ReturnType<typeof openCurrentReadOnlyDatabase> | null = null;
  try {
    source = openCurrentReadOnlyDatabase(path, { migrations });
    validateOpenDatabase(source.db, migrations);
    return source;
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
}

function requireHealthyDatabase(database: Database.Database): void {
  const quickCheck = database.pragma("quick_check(1)", { simple: true });
  const foreignKeyFailure = database
    .prepare("PRAGMA foreign_key_check")
    .get();
  if (quickCheck !== "ok" || foreignKeyFailure !== undefined) {
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

function requireStandaloneDatabase(path: string): void {
  if (sqliteSidecarSuffixes.slice(1).some((suffix) => existsSync(`${path}${suffix}`))) {
    throw new HostDeckDatabaseRecoveryError(
      "backup_invalid",
      "The HostDeck database snapshot retained SQLite sidecars."
    );
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
    candidate.length > 4_096 ||
    containsControlCharacter(candidate) ||
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

function requireRecoveryState(
  stateDir: string,
  databasePaths: readonly string[],
  lease: unknown
): HostDeckDatabaseRecoveryAuthority {
  try {
    for (const databasePath of databasePaths) {
      inspectExistingHostDeckStatePaths({
        state_dir: stateDir,
        database_path: databasePath
      });
    }
  } catch (error) {
    throw new HostDeckDatabaseRecoveryError(
      "state_insecure",
      "HostDeck database recovery state paths are insecure.",
      { cause: error }
    );
  }
  const expectedLeasePath = join(stateDir, "hostdeck.lock");
  const verify = (): void => {
    try {
      requireActiveHostDeckDaemonLease(lease, expectedLeasePath);
    } catch (error) {
      throw new HostDeckDatabaseRecoveryError(
        "authority_invalid",
        "HostDeck database recovery authority is invalid.",
        { cause: error }
      );
    }
  };
  verify();
  return Object.freeze({ verify });
}

async function withSecureRecoveryFile<T>(
  path: string,
  label: string,
  repairMode: boolean,
  operation: () => T | Promise<T>
): Promise<T> {
  let opened: OpenedSecureHostDeckRegularFile;
  try {
    opened = openSecureHostDeckRegularFile(path, {
      label,
      mode: 0o600,
      repair_mode: repairMode
    });
  } catch (error) {
    throw new HostDeckDatabaseRecoveryError(
      "state_insecure",
      "HostDeck database recovery file security is invalid.",
      { cause: error }
    );
  }

  let result: T | undefined;
  let operationError: unknown;
  let operationFailed = false;
  try {
    verifyRecoveryFile(opened);
    result = await operation();
    verifyRecoveryFile(opened);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  let closeError: unknown;
  try {
    closeSync(opened.descriptor);
  } catch (error) {
    closeError = error;
  }
  if (operationFailed) {
    if (closeError === undefined) throw operationError;
    if (operationError instanceof HostDeckDatabaseRecoveryError) {
      throw new HostDeckDatabaseRecoveryError(
        operationError.code,
        operationError.message,
        {
          cause: new AggregateError(
            [operationError, closeError],
            "Database recovery operation and secure descriptor cleanup failed."
          )
        }
      );
    }
    throw new AggregateError(
      [operationError, closeError],
      "Database recovery operation and secure descriptor cleanup failed."
    );
  }
  if (closeError !== undefined) {
    throw new HostDeckDatabaseRecoveryError(
      "state_insecure",
      "HostDeck database recovery file could not be closed securely.",
      { cause: closeError }
    );
  }
  return result as T;
}

function verifyRecoveryFile(opened: OpenedSecureHostDeckRegularFile): void {
  try {
    opened.verifyPath();
  } catch (error) {
    throw new HostDeckDatabaseRecoveryError(
      "state_insecure",
      "HostDeck database recovery file identity changed.",
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

function requireMigrationCatalog(
  migrations: readonly StorageMigration[] | undefined
): readonly StorageMigration[] {
  try {
    return snapshotStorageMigrations(migrations);
  } catch (error) {
    throw new HostDeckDatabaseRecoveryError(
      "invalid_input",
      "HostDeck database migrations are invalid.",
      { cause: error }
    );
  }
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
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
