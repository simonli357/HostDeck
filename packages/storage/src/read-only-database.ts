import { closeSync, readSync } from "node:fs";
import type Database from "better-sqlite3";
import {
  type MigrationResult,
  openCurrentReadOnlyDatabase
} from "./migration-runner.js";
import {
  inspectExistingHostDeckStatePaths,
  openSecureHostDeckRegularFile
} from "./secure-local-paths.js";

export interface OpenExistingHostDeckReadOnlyDatabaseInput {
  readonly state_dir: string;
  readonly database_path: string;
}

export interface ExistingHostDeckReadOnlyDatabase {
  readonly db: Database.Database;
  readonly migration: MigrationResult;
  readonly verifyPath: () => void;
  readonly close: () => void;
}

const inputKeys = ["state_dir", "database_path"] as const;

export function openExistingHostDeckReadOnlyDatabase(
  input: OpenExistingHostDeckReadOnlyDatabaseInput
): ExistingHostDeckReadOnlyDatabase {
  const values = readExactInput(input);
  const paths = inspectExistingHostDeckStatePaths({
    state_dir: requirePath(values.state_dir),
    database_path: requirePath(values.database_path)
  });
  const guard = openSecureHostDeckRegularFile(paths.database_path, {
    label: "database",
    mode: 0o600,
    repair_mode: false
  });
  const guards = [guard];
  let opened: ReturnType<typeof openCurrentReadOnlyDatabase> | null = null;
  try {
    if (usesWriteAheadLog(guard.descriptor)) {
      for (const suffix of ["-wal", "-shm"] as const) {
        guards.push(
          openSecureHostDeckRegularFile(`${paths.database_path}${suffix}`, {
            label: `database ${suffix.slice(1)}`,
            mode: 0o600,
            repair_mode: false
          })
        );
      }
    }
    opened = openCurrentReadOnlyDatabase(paths.database_path);
    verifyGuards(guards);
  } catch (error) {
    const cleanupErrors = closeResources(
      opened?.db ?? null,
      guards.map(({ descriptor }) => descriptor)
    );
    if (cleanupErrors.length === 0) throw error;
    throw new AggregateError(
      [error, ...cleanupErrors],
      "Read-only database open and cleanup failed."
    );
  }

  if (opened === null) {
    const error = new TypeError(
      "Read-only database open completed without a handle."
    );
    const cleanupErrors = closeResources(
      null,
      guards.map(({ descriptor }) => descriptor)
    );
    if (cleanupErrors.length === 0) throw error;
    throw new AggregateError(
      [error, ...cleanupErrors],
      "Read-only database invariant and cleanup failed."
    );
  }
  const current = opened;

  let closed = false;
  const verifyPath = () => {
    if (closed) throw new TypeError("Read-only database handle is closed.");
    verifyGuards(guards);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    const errors: unknown[] = [];
    try {
      verifyGuards(guards);
    } catch (error) {
      errors.push(error);
    }
    errors.push(
      ...closeResources(
        current.db,
        guards.map(({ descriptor }) => descriptor)
      )
    );
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "Read-only database cleanup failed.");
    }
  };

  return Object.freeze({
    db: current.db,
    migration: current.result,
    verifyPath,
    close
  });
}

function closeResources(
  db: Database.Database | null,
  descriptors: readonly number[]
): unknown[] {
  const errors: unknown[] = [];
  try {
    db?.close();
  } catch (error) {
    errors.push(error);
  }
  for (const descriptor of [...descriptors].reverse()) {
    try {
      closeSync(descriptor);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function usesWriteAheadLog(descriptor: number): boolean {
  const header = Buffer.alloc(20);
  if (readSync(descriptor, header, 0, header.length, 0) !== header.length) {
    return false;
  }
  return header[18] === 2 || header[19] === 2;
}

function verifyGuards(
  guards: readonly ReturnType<typeof openSecureHostDeckRegularFile>[]
): void {
  for (const current of guards) current.verifyPath();
}

function readExactInput(
  candidate: unknown
): Readonly<Record<(typeof inputKeys)[number], unknown>> {
  const message = "Read-only HostDeck database input is invalid.";
  try {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate) ||
      Object.getPrototypeOf(candidate) !== Object.prototype
    ) {
      throw new TypeError();
    }
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== inputKeys.length ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          !inputKeys.includes(key as (typeof inputKeys)[number])
      )
    ) {
      throw new TypeError();
    }
    const values: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of inputKeys) {
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
    return Object.freeze(values) as Readonly<
      Record<(typeof inputKeys)[number], unknown>
    >;
  } catch {
    throw new TypeError(message);
  }
}

function requirePath(candidate: unknown): string {
  if (typeof candidate !== "string") {
    throw new TypeError("Read-only HostDeck database input is invalid.");
  }
  return candidate;
}
