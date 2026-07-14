import { isDeepStrictEqual } from "node:util";
import {
  type RemoteIngressState,
  remoteIngressStateSchema
} from "@hostdeck/contracts";
import type Database from "better-sqlite3";

export const hostDeckRemoteIngressStateId = "hostdeck_remote_ingress";

export type RemoteIngressStateRepositoryErrorCode =
  | "invalid_remote_ingress_state"
  | "invalid_persisted_remote_ingress_state"
  | "remote_ingress_conflict"
  | "remote_ingress_generation_exhausted"
  | "remote_ingress_selection_conflict"
  | "remote_ingress_time_conflict"
  | "remote_ingress_unavailable";

export class HostDeckRemoteIngressStateRepositoryError extends Error {
  constructor(
    readonly code: RemoteIngressStateRepositoryErrorCode,
    message: string
  ) {
    super(message);
    this.name = "HostDeckRemoteIngressStateRepositoryError";
  }
}

export interface CompareAndSetRemoteIngressStateInput {
  readonly expected_generation: number | null;
  readonly state: RemoteIngressState;
}

export interface RemoteIngressStateWriteReceipt {
  readonly before: RemoteIngressState | null;
  readonly after: RemoteIngressState;
}

export interface RemoteIngressStateRepository {
  readonly read: () => RemoteIngressState | null;
  readonly compareAndSet: (
    input: CompareAndSetRemoteIngressStateInput
  ) => RemoteIngressStateWriteReceipt;
}

interface RemoteIngressStateRow {
  readonly id: unknown;
  readonly schema_version: unknown;
  readonly generation: unknown;
  readonly intent: unknown;
  readonly availability: unknown;
  readonly admission: unknown;
  readonly observation: unknown;
  readonly client: unknown;
  readonly profile_state: unknown;
  readonly profile_relation: unknown;
  readonly expected_profile_key: unknown;
  readonly active_profile_key: unknown;
  readonly serve_state: unknown;
  readonly expected_external_origin: unknown;
  readonly expected_https_port: unknown;
  readonly expected_path: unknown;
  readonly expected_proxy_origin: unknown;
  readonly expected_visibility: unknown;
  readonly external_origin: unknown;
  readonly operation_failure: unknown;
  readonly unavailable_reason: unknown;
  readonly observed_at: unknown;
  readonly updated_at: unknown;
}

interface PreparedCompareAndSetInput {
  readonly expectedGeneration: number | null;
  readonly state: RemoteIngressState;
}

const compareAndSetKeys = ["expected_generation", "state"] as const;
const acceptedRepositories = new WeakSet<object>();

const selectedColumns = `
  id, schema_version, generation, intent, availability, admission, observation,
  client, profile_state, profile_relation, expected_profile_key,
  active_profile_key, serve_state, expected_external_origin,
  expected_https_port, expected_path, expected_proxy_origin,
  expected_visibility, external_origin, operation_failure,
  unavailable_reason, observed_at, updated_at
`;

export function createRemoteIngressStateRepository(
  db: Database.Database
): RemoteIngressStateRepository {
  const compareAndSetTransaction = db.transaction(
    (input: PreparedCompareAndSetInput): RemoteIngressStateWriteReceipt => {
      const before = readState(db);
      assertExpectedGeneration(before, input);
      if (before !== null) {
        assertChronology(before, input.state);
        assertSelectionTransition(before, input.state);
      }

      const row = stateToRow(input.state);
      if (before === null) {
        db.prepare(
          `
            INSERT INTO selected_remote_ingress_state (${selectedColumns})
            VALUES (
              @id, @schema_version, @generation, @intent, @availability,
              @admission, @observation, @client, @profile_state,
              @profile_relation, @expected_profile_key, @active_profile_key,
              @serve_state, @expected_external_origin, @expected_https_port,
              @expected_path, @expected_proxy_origin, @expected_visibility,
              @external_origin, @operation_failure, @unavailable_reason,
              @observed_at, @updated_at
            )
          `
        ).run(row);
      } else {
        const result = db
          .prepare(
            `
              UPDATE selected_remote_ingress_state SET
                schema_version = @schema_version,
                generation = @generation,
                intent = @intent,
                availability = @availability,
                admission = @admission,
                observation = @observation,
                client = @client,
                profile_state = @profile_state,
                profile_relation = @profile_relation,
                expected_profile_key = @expected_profile_key,
                active_profile_key = @active_profile_key,
                serve_state = @serve_state,
                expected_external_origin = @expected_external_origin,
                expected_https_port = @expected_https_port,
                expected_path = @expected_path,
                expected_proxy_origin = @expected_proxy_origin,
                expected_visibility = @expected_visibility,
                external_origin = @external_origin,
                operation_failure = @operation_failure,
                unavailable_reason = @unavailable_reason,
                observed_at = @observed_at,
                updated_at = @updated_at
              WHERE id = @id AND generation = @expected_generation
            `
          )
          .run({ ...row, expected_generation: input.expectedGeneration });
        if (result.changes !== 1) throw conflict();
      }

      const after = readState(db);
      if (after === null || !isDeepStrictEqual(after, input.state)) {
        throw new HostDeckRemoteIngressStateRepositoryError(
          "remote_ingress_conflict",
          "Remote ingress state did not commit exactly."
        );
      }
      return deepFreeze({ before, after });
    }
  ).immediate;

  const repository: RemoteIngressStateRepository = Object.freeze({
    read() {
      try {
        return readState(db);
      } catch (error) {
        throw sanitizeError(error);
      }
    },
    compareAndSet(input: CompareAndSetRemoteIngressStateInput) {
      ensureWritable(db);
      try {
        return compareAndSetTransaction(prepareCompareAndSetInput(input));
      } catch (error) {
        throw sanitizeError(error);
      }
    }
  });
  acceptedRepositories.add(repository);
  return repository;
}

export function assertRemoteIngressStateRepository(
  candidate: unknown
): asserts candidate is RemoteIngressStateRepository {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !acceptedRepositories.has(candidate) ||
    !Object.isFrozen(candidate)
  ) {
    throw new TypeError(
      "Remote ingress state repository must be created by createRemoteIngressStateRepository."
    );
  }
}

function prepareCompareAndSetInput(input: unknown): PreparedCompareAndSetInput {
  const value = readExactDataObject(input, compareAndSetKeys);
  const expectedGeneration = parseExpectedGeneration(value.expected_generation);
  const result = remoteIngressStateSchema.safeParse(value.state);
  if (!result.success) throw invalidInput();

  const state = deepFreeze(result.data);
  if (
    (expectedGeneration === null && state.generation !== 1) ||
    (expectedGeneration !== null &&
      expectedGeneration < Number.MAX_SAFE_INTEGER &&
      state.generation !== expectedGeneration + 1)
  ) {
    throw invalidInput();
  }
  return Object.freeze({ expectedGeneration, state });
}

function parseExpectedGeneration(value: unknown): number | null {
  if (value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    throw invalidInput();
  }
  return value;
}

function assertExpectedGeneration(
  before: RemoteIngressState | null,
  input: PreparedCompareAndSetInput
): void {
  if (input.expectedGeneration === null) {
    if (before !== null) throw conflict();
    return;
  }
  if (before === null || before.generation !== input.expectedGeneration) {
    throw conflict();
  }
  if (before.generation === Number.MAX_SAFE_INTEGER) {
    throw new HostDeckRemoteIngressStateRepositoryError(
      "remote_ingress_generation_exhausted",
      "Remote ingress generation is exhausted."
    );
  }
}

function assertChronology(
  before: RemoteIngressState,
  after: RemoteIngressState
): void {
  const updatedRegressed = Date.parse(after.updated_at) < Date.parse(before.updated_at);
  const observationRegressed =
    before.observed_at !== null &&
    (after.observed_at === null ||
      Date.parse(after.observed_at) < Date.parse(before.observed_at));
  if (updatedRegressed || observationRegressed) {
    throw new HostDeckRemoteIngressStateRepositoryError(
      "remote_ingress_time_conflict",
      "Remote ingress state cannot discard newer durable chronology."
    );
  }
}

function assertSelectionTransition(
  before: RemoteIngressState,
  after: RemoteIngressState
): void {
  const profileChanged =
    before.profile.comparison.expected_profile_key !==
    after.profile.comparison.expected_profile_key;
  const serveChanged = !isDeepStrictEqual(before.expected_serve, after.expected_serve);
  if (!profileChanged && !serveChanged) return;

  const hadSelection =
    before.profile.comparison.expected_profile_key !== null ||
    before.expected_serve !== null;
  const cleanUnconfiguredState =
    !hadSelection &&
    before.intent === "disabled" &&
    before.operation_failure === null &&
    before.serve === null;
  const verifiedDisabledState =
    hadSelection &&
    before.intent === "disabled" &&
    before.observation === "current" &&
    before.client === "available" &&
    before.profile.state === "dedicated" &&
    before.serve === "absent" &&
    before.operation_failure === null;
  const verifiedCleanupCompletion =
    hadSelection &&
    before.intent === "disabled" &&
    before.operation_failure === "cleanup_incomplete" &&
    after.intent === "disabled" &&
    after.observation === "current" &&
    after.client === "available" &&
    after.profile.state === "absent" &&
    after.profile.comparison.relation === "unconfigured" &&
    after.profile.comparison.expected_profile_key === null &&
    after.profile.comparison.active_profile_key === null &&
    after.serve === null &&
    after.expected_serve === null &&
    after.external_origin === null &&
    after.operation_failure === null;
  if (
    !cleanUnconfiguredState &&
    !verifiedDisabledState &&
    !verifiedCleanupCompletion
  ) {
    throw new HostDeckRemoteIngressStateRepositoryError(
      "remote_ingress_selection_conflict",
      "Remote ingress selection can change only after verified disablement."
    );
  }
}

function readState(db: Database.Database): RemoteIngressState | null {
  const row = db
    .prepare(
      `SELECT ${selectedColumns} FROM selected_remote_ingress_state
       WHERE id = 'hostdeck_remote_ingress'`
    )
    .get() as RemoteIngressStateRow | undefined;
  if (row === undefined) return null;

  const expectedServe =
    row.expected_external_origin === null &&
    row.expected_https_port === null &&
    row.expected_path === null &&
    row.expected_proxy_origin === null &&
    row.expected_visibility === null
      ? null
      : {
          external_origin: row.expected_external_origin,
          https_port: row.expected_https_port,
          path: row.expected_path,
          proxy_origin: row.expected_proxy_origin,
          visibility: row.expected_visibility
        };
  const result = remoteIngressStateSchema.safeParse({
    schema_version: row.schema_version,
    generation: row.generation,
    intent: row.intent,
    availability: row.availability,
    admission: row.admission,
    observation: row.observation,
    client: row.client,
    profile: {
      state: row.profile_state,
      comparison: {
        relation: row.profile_relation,
        expected_profile_key: row.expected_profile_key,
        active_profile_key: row.active_profile_key
      }
    },
    serve: row.serve_state,
    expected_serve: expectedServe,
    external_origin: row.external_origin,
    operation_failure: row.operation_failure,
    reason: row.unavailable_reason,
    observed_at: row.observed_at,
    updated_at: row.updated_at
  });
  if (!result.success) throw invalidPersistedState();

  const parsed = deepFreeze(result.data);
  if (!isDeepStrictEqual(row, stateToRow(parsed))) {
    throw invalidPersistedState();
  }
  return parsed;
}

function stateToRow(state: RemoteIngressState): RemoteIngressStateRow {
  return {
    id: hostDeckRemoteIngressStateId,
    schema_version: state.schema_version,
    generation: state.generation,
    intent: state.intent,
    availability: state.availability,
    admission: state.admission,
    observation: state.observation,
    client: state.client,
    profile_state: state.profile.state,
    profile_relation: state.profile.comparison.relation,
    expected_profile_key: state.profile.comparison.expected_profile_key,
    active_profile_key: state.profile.comparison.active_profile_key,
    serve_state: state.serve,
    expected_external_origin: state.expected_serve?.external_origin ?? null,
    expected_https_port: state.expected_serve?.https_port ?? null,
    expected_path: state.expected_serve?.path ?? null,
    expected_proxy_origin: state.expected_serve?.proxy_origin ?? null,
    expected_visibility: state.expected_serve?.visibility ?? null,
    external_origin: state.external_origin,
    operation_failure: state.operation_failure,
    unavailable_reason: state.reason,
    observed_at: state.observed_at,
    updated_at: state.updated_at
  };
}

function readExactDataObject(
  input: unknown,
  expectedKeys: readonly string[]
): Readonly<Record<string, unknown>> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw invalidInput();
  }
  try {
    const prototype: unknown = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) throw invalidInput();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) => {
        if (typeof key !== "string" || !expectedKeys.includes(key)) return true;
        const descriptor = descriptors[key];
        return (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        );
      })
    ) {
      throw invalidInput();
    }
    return Object.freeze(
      Object.fromEntries(
        keys.map((key) => [key, descriptors[key as string]?.value])
      )
    );
  } catch (error) {
    if (error instanceof HostDeckRemoteIngressStateRepositoryError) throw error;
    throw invalidInput();
  }
}

function ensureWritable(db: Database.Database): void {
  if (!db.open || db.readonly) {
    throw new HostDeckRemoteIngressStateRepositoryError(
      "remote_ingress_unavailable",
      "Remote ingress storage is unavailable."
    );
  }
}

function conflict(): HostDeckRemoteIngressStateRepositoryError {
  return new HostDeckRemoteIngressStateRepositoryError(
    "remote_ingress_conflict",
    "Remote ingress state changed before compare-and-set."
  );
}

function invalidInput(): HostDeckRemoteIngressStateRepositoryError {
  return new HostDeckRemoteIngressStateRepositoryError(
    "invalid_remote_ingress_state",
    "Remote ingress state input is invalid."
  );
}

function invalidPersistedState(): HostDeckRemoteIngressStateRepositoryError {
  return new HostDeckRemoteIngressStateRepositoryError(
    "invalid_persisted_remote_ingress_state",
    "Persisted remote ingress state is invalid."
  );
}

function sanitizeError(
  error: unknown
): HostDeckRemoteIngressStateRepositoryError {
  if (error instanceof HostDeckRemoteIngressStateRepositoryError) return error;
  return new HostDeckRemoteIngressStateRepositoryError(
    "remote_ingress_unavailable",
    "Remote ingress storage is unavailable."
  );
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
