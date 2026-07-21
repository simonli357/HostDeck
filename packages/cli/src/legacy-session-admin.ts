import { closeSync } from "node:fs";
import {
  createLegacySessionRepository,
  HostDeckLocalPathError,
  openMigratedDatabase,
  openSecureHostDeckRegularFile,
  prepareHostDeckStatePaths
} from "@hostdeck/storage";
import { configFailure } from "./errors.js";

export interface LegacySessionSummary {
  readonly disposition: "legacy_unmigrated";
  readonly legacy_session_count: number;
}

export interface LegacySessionResetResult {
  readonly disposition: "legacy_unmigrated";
  readonly removed_session_count: number;
  readonly remaining_session_count: 0;
}

export interface CreateLegacySessionAdminOptions {
  readonly stateDir: string;
  readonly databasePath: string;
  readonly now?: () => Date;
  readonly prepareStatePaths?: typeof prepareHostDeckStatePaths;
}

export interface LegacySessionAdmin {
  readonly getLegacySessions: () => LegacySessionSummary;
  readonly resetLegacySessions: (input: {
    readonly confirmed: true;
  }) => LegacySessionResetResult;
}

export function createLegacySessionAdmin(
  options: CreateLegacySessionAdminOptions
): LegacySessionAdmin {
  const now = options.now ?? (() => new Date());
  return Object.freeze({
    getLegacySessions() {
      return withLegacySessionRepository(options, now, (repository) =>
        repository.summarize()
      );
    },
    resetLegacySessions(input: { readonly confirmed: true }) {
      return withLegacySessionRepository(options, now, (repository) =>
        repository.reset(input)
      );
    }
  });
}

function withLegacySessionRepository<T>(
  options: CreateLegacySessionAdminOptions,
  now: () => Date,
  work: (repository: ReturnType<typeof createLegacySessionRepository>) => T
): T {
  let paths: ReturnType<typeof prepareHostDeckStatePaths>;
  try {
    paths = (options.prepareStatePaths ?? prepareHostDeckStatePaths)({
      state_dir: options.stateDir,
      database_path: options.databasePath
    });
  } catch (error) {
    throw configFailure(
      `HostDeck state directory or database path is not secure: ${options.stateDir}.`,
      "state_dir",
      error
    );
  }

  let databaseGuard: ReturnType<typeof openSecureHostDeckRegularFile>;
  try {
    databaseGuard = openSecureHostDeckRegularFile(paths.database_path, {
      label: "database",
      mode: 0o600,
      repair_mode: true
    });
  } catch (error) {
    throw configFailure(
      "HostDeck database path changed or became insecure before open.",
      "database_path",
      error
    );
  }

  let opened: ReturnType<typeof openMigratedDatabase> | null = null;
  try {
    opened = openMigratedDatabase(paths.database_path, { now });
    databaseGuard.verifyPath();
  } catch (error) {
    const cleanupErrors = closeValidationResources(
      opened,
      databaseGuard.descriptor
    );
    const cause =
      cleanupErrors.length === 0
        ? error
        : new AggregateError(
            [error, ...cleanupErrors],
            "Database open and validation cleanup failed."
          );
    if (error instanceof HostDeckLocalPathError) {
      throw configFailure(
        "HostDeck database path changed or became insecure during open.",
        "database_path",
        cause
      );
    }
    if (cleanupErrors.length > 0) throw cause;
    throw error;
  }

  try {
    closeSync(databaseGuard.descriptor);
  } catch (error) {
    const cleanupErrors = closeValidationResources(opened, null);
    throw configFailure(
      "HostDeck database validation descriptor could not be closed.",
      "database_path",
      cleanupErrors.length === 0
        ? error
        : new AggregateError(
            [error, ...cleanupErrors],
            "Database validation close failed."
          )
    );
  }

  try {
    return work(createLegacySessionRepository(opened.db));
  } finally {
    opened.db.close();
  }
}

function closeValidationResources(
  opened: ReturnType<typeof openMigratedDatabase> | null,
  descriptor: number | null
): unknown[] {
  const errors: unknown[] = [];
  try {
    opened?.db.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    if (descriptor !== null) closeSync(descriptor);
  } catch (error) {
    errors.push(error);
  }
  return errors;
}
