import { isDeepStrictEqual } from "node:util";
import {
  type SelectedRuntimeCompatibilityRecord,
  selectedRuntimeCompatibilityRecordSchema
} from "@hostdeck/contracts";
import type Database from "better-sqlite3";

export type RuntimeCompatibilityRepositoryErrorCode =
  | "compatibility_conflict"
  | "invalid_compatibility"
  | "invalid_persisted_compatibility";

export class HostDeckRuntimeCompatibilityRepositoryError extends Error {
  constructor(
    readonly code: RuntimeCompatibilityRepositoryErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostDeckRuntimeCompatibilityRepositoryError";
  }
}

export interface RuntimeCompatibilityRepository {
  readonly get: () => SelectedRuntimeCompatibilityRecord | null;
  readonly put: (record: unknown) => SelectedRuntimeCompatibilityRecord;
}

interface CompatibilityRow {
  readonly id: "hostdeck_runtime";
  readonly state: SelectedRuntimeCompatibilityRecord["compatibility"]["state"];
  readonly mutation_policy: SelectedRuntimeCompatibilityRecord["compatibility"]["mutation_policy"];
  readonly observed_version: string | null;
  readonly binding_id: string | null;
  readonly checked_at: string;
  readonly recorded_at: string;
  readonly reason: string | null;
  readonly compatibility_json: string;
}

export function createRuntimeCompatibilityRepository(db: Database.Database): RuntimeCompatibilityRepository {
  const read = (): SelectedRuntimeCompatibilityRecord | null => {
    const row = db.prepare("SELECT * FROM selected_runtime_compatibility WHERE id = 'hostdeck_runtime'").get() as CompatibilityRow | undefined;
    return row === undefined ? null : parseRow(row);
  };

  const putTransaction = db.transaction((parsed: SelectedRuntimeCompatibilityRecord): SelectedRuntimeCompatibilityRecord => {
    const current = read();
    if (current !== null) {
      if (parsed.recorded_at < current.recorded_at) {
        throw new HostDeckRuntimeCompatibilityRepositoryError(
          "compatibility_conflict",
          "Runtime compatibility cannot overwrite a newer recorded result."
        );
      }
      if (parsed.recorded_at === current.recorded_at) {
        if (isDeepStrictEqual(parsed, current)) return current;
        throw new HostDeckRuntimeCompatibilityRepositoryError(
          "compatibility_conflict",
          "Runtime compatibility results recorded at the same instant must be identical."
        );
      }
    }
    const row = recordToRow(parsed);

    try {
      db.prepare(
        `
          INSERT INTO selected_runtime_compatibility (
            id, state, mutation_policy, observed_version, binding_id,
            checked_at, recorded_at, reason, compatibility_json
          ) VALUES (
            @id, @state, @mutation_policy, @observed_version, @binding_id,
            @checked_at, @recorded_at, @reason, @compatibility_json
          )
          ON CONFLICT(id) DO UPDATE SET
            state = excluded.state,
            mutation_policy = excluded.mutation_policy,
            observed_version = excluded.observed_version,
            binding_id = excluded.binding_id,
            checked_at = excluded.checked_at,
            recorded_at = excluded.recorded_at,
            reason = excluded.reason,
            compatibility_json = excluded.compatibility_json
        `
      ).run(row);
    } catch (error) {
      throw new HostDeckRuntimeCompatibilityRepositoryError(
        "invalid_compatibility",
        "Runtime compatibility violates SQLite constraints.",
        { cause: error }
      );
    }

    return parsed;
  }).immediate;

  return {
    get: read,
    put(record) {
      return putTransaction(parseRecord(record, "invalid_compatibility"));
    }
  };
}

function parseRow(row: CompatibilityRow): SelectedRuntimeCompatibilityRecord {
  let compatibility: unknown;
  try {
    compatibility = JSON.parse(row.compatibility_json) as unknown;
  } catch (error) {
    throw new HostDeckRuntimeCompatibilityRepositoryError(
      "invalid_persisted_compatibility",
      "Stored runtime compatibility JSON is invalid.",
      { cause: error }
    );
  }

  const parsed = parseRecord(
    {
      id: row.id,
      compatibility,
      recorded_at: row.recorded_at
    },
    "invalid_persisted_compatibility"
  );

  if (
    parsed.compatibility.state !== row.state ||
    parsed.compatibility.mutation_policy !== row.mutation_policy ||
    parsed.compatibility.observed_version !== row.observed_version ||
    parsed.compatibility.binding_id !== row.binding_id ||
    parsed.compatibility.checked_at !== row.checked_at ||
    parsed.compatibility.reason !== row.reason
  ) {
    throw new HostDeckRuntimeCompatibilityRepositoryError(
      "invalid_persisted_compatibility",
      "Stored runtime compatibility columns contradict compatibility JSON."
    );
  }

  return parsed;
}

function parseRecord(
  candidate: unknown,
  code: RuntimeCompatibilityRepositoryErrorCode
): SelectedRuntimeCompatibilityRecord {
  const result = selectedRuntimeCompatibilityRecordSchema.safeParse(candidate);
  if (!result.success) {
    throw new HostDeckRuntimeCompatibilityRepositoryError(code, "Runtime compatibility record is invalid.", { cause: result.error });
  }
  if (result.data.recorded_at < result.data.compatibility.checked_at) {
    throw new HostDeckRuntimeCompatibilityRepositoryError(code, "Runtime compatibility cannot be recorded before its check completed.");
  }
  return result.data;
}

function recordToRow(record: SelectedRuntimeCompatibilityRecord): CompatibilityRow {
  return {
    id: record.id,
    state: record.compatibility.state,
    mutation_policy: record.compatibility.mutation_policy,
    observed_version: record.compatibility.observed_version,
    binding_id: record.compatibility.binding_id,
    checked_at: record.compatibility.checked_at,
    recorded_at: record.recorded_at,
    reason: record.compatibility.reason,
    compatibility_json: JSON.stringify(record.compatibility)
  };
}
