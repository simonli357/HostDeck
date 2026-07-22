import {
  type ApiErrorEnvelope,
  clientOperationIdSchema,
  selectedCsrfBootstrapResponseSchema
} from "@hostdeck/contracts";
import {
  type BrowserHttpClient,
  type BrowserHttpRouteResponse,
  type BrowserHttpTransport,
  HostDeckBrowserHttpError,
  isBrowserHttpClient
} from "./http-client.js";
import {
  type BrowserHttpDeviceCsrfRouteId,
  type BrowserHttpRouteRequest,
  browserHttpRouteContracts
} from "./http-route-contracts.js";

export const browserCsrfPhases = Object.freeze([
  "idle",
  "bootstrapping",
  "ready",
  "failed",
  "closed"
] as const);

export const browserCsrfInvalidationReasons = Object.freeze([
  "access_lost",
  "remote_authority_changed",
  "device_revoked",
  "pairing_replaced",
  "caller_reset"
] as const);

export const browserCsrfFailureReasons = Object.freeze([
  "client_contract",
  "not_ready",
  "caller_aborted",
  "authority_changed",
  "bootstrap_unavailable",
  "invalid_response",
  "authority_rejected",
  "stale_generation",
  "api_error",
  "closed"
] as const);

export type BrowserCsrfPhase = (typeof browserCsrfPhases)[number];
export type BrowserCsrfInvalidationReason =
  (typeof browserCsrfInvalidationReasons)[number];
export type BrowserCsrfFailureReason =
  (typeof browserCsrfFailureReasons)[number];
export type BrowserCsrfOperation = "adopt" | "bootstrap" | "lifecycle" | "mutation";

export interface BrowserCsrfSnapshot {
  readonly phase: BrowserCsrfPhase;
  readonly generation: number | null;
  readonly rotatedAt: string | null;
  readonly failure: HostDeckBrowserCsrfError | null;
  readonly invalidationReason:
    | "not_bootstrapped"
    | BrowserCsrfInvalidationReason
    | null;
}

export interface BrowserCsrfRequestOptions {
  readonly signal?: AbortSignal;
}

export interface CreateBrowserCsrfClientOptions {
  readonly httpClient: BrowserHttpClient;
  readonly createOperationId: () => string;
}

export interface BrowserCsrfBootstrapInput {
  readonly csrf_token: string;
  readonly csrf_generation: number;
  readonly rotated_at: string;
}

export interface BrowserCsrfClient {
  readonly snapshot: () => BrowserCsrfSnapshot;
  readonly bootstrap: () => Promise<BrowserCsrfSnapshot>;
  readonly adoptBootstrap: (response: BrowserCsrfBootstrapInput) => BrowserCsrfSnapshot;
  readonly request: <RouteId extends BrowserHttpDeviceCsrfRouteId>(
    routeId: RouteId,
    input: BrowserHttpRouteRequest<RouteId>,
    options?: BrowserCsrfRequestOptions
  ) => Promise<BrowserHttpRouteResponse<RouteId>>;
  readonly invalidate: (reason: BrowserCsrfInvalidationReason) => BrowserCsrfSnapshot;
  readonly close: () => BrowserCsrfSnapshot;
}

export class HostDeckBrowserCsrfError extends Error {
  readonly reason: BrowserCsrfFailureReason;
  readonly operation: BrowserCsrfOperation;
  readonly routeId: BrowserHttpDeviceCsrfRouteId | "csrf_bootstrap" | null;
  readonly transport: BrowserHttpTransport | null;
  readonly status: number | null;
  readonly apiError: ApiErrorEnvelope | null;

  constructor(input: {
    readonly reason: BrowserCsrfFailureReason;
    readonly operation: BrowserCsrfOperation;
    readonly routeId?: BrowserHttpDeviceCsrfRouteId | "csrf_bootstrap" | null;
    readonly transport?: BrowserHttpTransport | null;
    readonly status?: number | null;
    readonly apiError?: ApiErrorEnvelope | null;
  }) {
    super(messageForReason(input.reason));
    this.name = "HostDeckBrowserCsrfError";
    this.reason = input.reason;
    this.operation = input.operation;
    this.routeId = input.routeId ?? null;
    this.transport = input.transport ?? null;
    this.status = input.status ?? null;
    this.apiError = input.apiError ?? null;
    Object.freeze(this);
  }
}

interface BrowserCsrfCredential {
  readonly rawToken: string;
  readonly generation: number;
  readonly rotatedAt: string;
}

interface PendingBootstrap {
  readonly epoch: number;
  readonly controller: AbortController;
  readonly promise: Promise<BrowserCsrfSnapshot>;
}

interface MutationSignalScope {
  readonly signal: AbortSignal;
  readonly callerAborted: () => boolean;
  readonly close: () => void;
}

type BrowserHttpProtectedRequestPort = <RouteId extends BrowserHttpDeviceCsrfRouteId>(
  routeId: RouteId,
  input: BrowserHttpRouteRequest<RouteId>,
  options: Readonly<{
    readonly signal: AbortSignal;
    readonly csrfToken: string;
    readonly csrfGeneration: string;
  }>
) => Promise<BrowserHttpRouteResponse<RouteId>>;

const createOptionKeys = ["httpClient", "createOperationId"] as const;
const mutationOptionKeys = ["signal"] as const;

export function createBrowserCsrfClient(
  input: CreateBrowserCsrfClientOptions
): BrowserCsrfClient {
  const options = readCreateOptions(input);
  const httpClient = options.httpClient;
  const requestProtected = httpClient.request as unknown as BrowserHttpProtectedRequestPort;
  const createOperationId = options.createOperationId;
  let epoch = 0;
  let credential: BrowserCsrfCredential | null = null;
  let pendingBootstrap: PendingBootstrap | null = null;
  const mutationControllers = new Set<AbortController>();
  let currentSnapshot = idleSnapshot("not_bootstrapped");

  const abortOwnedWork = (): void => {
    const bootstrap = pendingBootstrap;
    pendingBootstrap = null;
    if (bootstrap !== null) safeAbort(bootstrap.controller);
    for (const controller of mutationControllers) safeAbort(controller);
    mutationControllers.clear();
  };

  const releaseBootstrap = (controller: AbortController): void => {
    const current = pendingBootstrap as PendingBootstrap | null;
    if (current?.controller === controller) pendingBootstrap = null;
  };

  const replaceWithFailure = (error: HostDeckBrowserCsrfError): void => {
    epoch += 1;
    credential = null;
    abortOwnedWork();
    currentSnapshot = failedSnapshot(error);
  };

  const authorityChangedFailure = (
    operation: BrowserCsrfOperation,
    routeId: BrowserHttpDeviceCsrfRouteId | "csrf_bootstrap" | null = null
  ): HostDeckBrowserCsrfError =>
    failure({ reason: "authority_changed", operation, routeId });

  const bootstrap = (): Promise<BrowserCsrfSnapshot> => {
    if (currentSnapshot.phase === "closed") {
      return Promise.reject(failure({ reason: "closed", operation: "bootstrap" }));
    }
    if (pendingBootstrap !== null) return pendingBootstrap.promise;

    epoch += 1;
    const bootstrapEpoch = epoch;
    credential = null;
    for (const controller of mutationControllers) safeAbort(controller);
    mutationControllers.clear();
    currentSnapshot = bootstrappingSnapshot();
    const controller = new AbortController();

    const promise = Promise.resolve().then(async (): Promise<BrowserCsrfSnapshot> => {
      try {
        if (bootstrapEpoch !== epoch || currentSnapshot.phase === "closed") {
          throw currentSnapshot.phase === "closed"
            ? failure({ reason: "closed", operation: "bootstrap" })
            : authorityChangedFailure("bootstrap", "csrf_bootstrap");
        }
        const operationId = readOperationId(createOperationId);
        const response = await httpClient.request(
          "csrf_bootstrap",
          { body: { operation_id: operationId } },
          { signal: controller.signal }
        );
        if (bootstrapEpoch !== epoch) {
          throw authorityChangedFailure("bootstrap", "csrf_bootstrap");
        }
        const next = parseBootstrapResponse(response.data);
        if (next === null) {
          throw failure({
            reason: "invalid_response",
            operation: "bootstrap",
            routeId: "csrf_bootstrap"
          });
        }
        credential = next;
        currentSnapshot = readySnapshot(next);
        return currentSnapshot;
      } catch (error) {
        if (bootstrapEpoch !== epoch || currentSnapshot.phase === "closed") {
          throw currentSnapshot.phase === "closed"
            ? failure({ reason: "closed", operation: "bootstrap" })
            : authorityChangedFailure("bootstrap", "csrf_bootstrap");
        }
        const mapped = mapBootstrapFailure(error);
        credential = null;
        currentSnapshot = failedSnapshot(mapped);
        throw mapped;
      } finally {
        releaseBootstrap(controller);
      }
    });

    pendingBootstrap = Object.freeze({
      epoch: bootstrapEpoch,
      controller,
      promise
    });
    return promise;
  };

  const adoptBootstrap = (response: BrowserCsrfBootstrapInput): BrowserCsrfSnapshot => {
    if (currentSnapshot.phase === "closed") {
      throw failure({ reason: "closed", operation: "adopt" });
    }
    const next = parseBootstrapResponse(response);
    if (next === null) {
      const error = failure({ reason: "client_contract", operation: "adopt" });
      replaceWithFailure(error);
      throw error;
    }

    if (credential !== null) {
      if (next.generation < credential.generation) return currentSnapshot;
      if (next.generation === credential.generation) {
        if (
          next.rawToken === credential.rawToken &&
          next.rotatedAt === credential.rotatedAt
        ) {
          return currentSnapshot;
        }
        const error = failure({ reason: "stale_generation", operation: "adopt" });
        replaceWithFailure(error);
        throw error;
      }
      if (Date.parse(next.rotatedAt) < Date.parse(credential.rotatedAt)) {
        const error = failure({ reason: "client_contract", operation: "adopt" });
        replaceWithFailure(error);
        throw error;
      }
    }

    epoch += 1;
    abortOwnedWork();
    credential = next;
    currentSnapshot = readySnapshot(next);
    return currentSnapshot;
  };

  const request = <RouteId extends BrowserHttpDeviceCsrfRouteId>(
    routeId: RouteId,
    requestInput: BrowserHttpRouteRequest<RouteId>,
    requestOptions?: BrowserCsrfRequestOptions
  ): Promise<BrowserHttpRouteResponse<RouteId>> => {
    if (currentSnapshot.phase === "closed") {
      return Promise.reject(
        failure({ reason: "closed", operation: "mutation", routeId: routeIdOrNull(routeId) })
      );
    }
    if (!isProtectedRouteId(routeId)) {
      return Promise.reject(
        failure({ reason: "client_contract", operation: "mutation" })
      );
    }
    const options = readMutationOptions(requestOptions);
    if (options === null) {
      return Promise.reject(
        failure({ reason: "client_contract", operation: "mutation", routeId })
      );
    }
    if (currentSnapshot.phase !== "ready" || credential === null) {
      return Promise.reject(
        failure({ reason: "not_ready", operation: "mutation", routeId })
      );
    }
    const callerSignal = options.signal;
    if (callerSignal !== null && readAbortSignalState(callerSignal)) {
      return Promise.reject(
        failure({ reason: "caller_aborted", operation: "mutation", routeId })
      );
    }

    const requestEpoch = epoch;
    const requestCredential = credential;
    const authorityController = new AbortController();
    const signalScope = createMutationSignalScope(
      callerSignal,
      authorityController.signal
    );
    mutationControllers.add(authorityController);

    return requestProtected(routeId, requestInput, {
        signal: signalScope.signal,
        csrfToken: requestCredential.rawToken,
        csrfGeneration: String(requestCredential.generation)
      })
      .then((response) => {
        if (
          requestEpoch !== epoch ||
          credential !== requestCredential ||
          currentSnapshot.phase !== "ready"
        ) {
          throw authorityChangedFailure("mutation", routeId);
        }
        return response;
      })
      .catch((error: unknown) => {
        if (requestEpoch !== epoch || credential !== requestCredential) {
          throw currentSnapshot.phase === "closed"
            ? failure({ reason: "closed", operation: "mutation", routeId })
            : authorityChangedFailure("mutation", routeId);
        }
        if (signalScope.callerAborted()) {
          throw failure({ reason: "caller_aborted", operation: "mutation", routeId });
        }
        const mapped = mapMutationFailure(error, routeId);
        if (
          mapped.reason === "authority_rejected" ||
          mapped.reason === "stale_generation"
        ) {
          replaceWithFailure(mapped);
        }
        throw mapped;
      })
      .finally(() => {
        mutationControllers.delete(authorityController);
        signalScope.close();
      });
  };

  const invalidate = (reason: BrowserCsrfInvalidationReason): BrowserCsrfSnapshot => {
    if (!browserCsrfInvalidationReasons.includes(reason)) {
      throw failure({ reason: "client_contract", operation: "lifecycle" });
    }
    if (currentSnapshot.phase === "closed") return currentSnapshot;
    epoch += 1;
    credential = null;
    abortOwnedWork();
    currentSnapshot = idleSnapshot(reason);
    return currentSnapshot;
  };

  const close = (): BrowserCsrfSnapshot => {
    if (currentSnapshot.phase === "closed") return currentSnapshot;
    epoch += 1;
    credential = null;
    abortOwnedWork();
    currentSnapshot = closedSnapshot();
    return currentSnapshot;
  };

  return Object.freeze({
    snapshot: () => currentSnapshot,
    bootstrap,
    adoptBootstrap,
    request,
    invalidate,
    close
  });
}

function readCreateOptions(input: unknown): {
  readonly httpClient: BrowserHttpClient;
  readonly createOperationId: () => string;
} {
  const values = readExactRecord(input, createOptionKeys, createOptionKeys);
  if (
    values === null ||
    !isBrowserHttpClient(values.httpClient) ||
    typeof values.createOperationId !== "function"
  ) {
    throw new TypeError("HostDeck browser CSRF client options are invalid.");
  }
  return Object.freeze({
    httpClient: values.httpClient,
    createOperationId: values.createOperationId as () => string
  });
}

function readOperationId(createOperationId: () => string): string {
  let candidate: unknown;
  try {
    candidate = Reflect.apply(createOperationId, undefined, []);
  } catch {
    throw failure({ reason: "client_contract", operation: "bootstrap" });
  }
  const parsed = clientOperationIdSchema.safeParse(candidate);
  if (!parsed.success) {
    throw failure({ reason: "client_contract", operation: "bootstrap" });
  }
  return parsed.data;
}

function parseBootstrapResponse(candidate: unknown): BrowserCsrfCredential | null {
  try {
    const snapshot = snapshotBootstrapResponse(candidate);
    if (snapshot === null) return null;
    const parsed = selectedCsrfBootstrapResponseSchema.safeParse(snapshot);
    if (!parsed.success) return null;
    return Object.freeze({
      rawToken: parsed.data.csrf_token,
      generation: parsed.data.csrf_generation,
      rotatedAt: parsed.data.rotated_at
    });
  } catch {
    return null;
  }
}

function snapshotBootstrapResponse(candidate: unknown): unknown {
  const values = readExactRecord(
    candidate,
    ["csrf_token", "csrf_generation", "rotated_at"],
    ["csrf_token", "csrf_generation", "rotated_at"]
  );
  if (values === null) return null;
  return Object.freeze({
    csrf_token: values.csrf_token,
    csrf_generation: values.csrf_generation,
    rotated_at: values.rotated_at
  });
}

function readMutationOptions(
  candidate: unknown
): { readonly signal: AbortSignal | null } | null {
  if (candidate === undefined) return Object.freeze({ signal: null });
  const values = readExactRecord(candidate, [], mutationOptionKeys);
  if (values === null) return null;
  if (values.signal !== undefined && !isAbortSignal(values.signal)) return null;
  return Object.freeze({ signal: (values.signal as AbortSignal | undefined) ?? null });
}

function isProtectedRouteId(candidate: unknown): candidate is BrowserHttpDeviceCsrfRouteId {
  if (typeof candidate !== "string" || !Object.hasOwn(browserHttpRouteContracts, candidate)) {
    return false;
  }
  return (
    browserHttpRouteContracts[candidate as keyof typeof browserHttpRouteContracts].csrf ===
    "required_for_device"
  );
}

function routeIdOrNull(candidate: unknown): BrowserHttpDeviceCsrfRouteId | null {
  return isProtectedRouteId(candidate) ? candidate : null;
}

function mapBootstrapFailure(error: unknown): HostDeckBrowserCsrfError {
  if (error instanceof HostDeckBrowserCsrfError) return error;
  if (!(error instanceof HostDeckBrowserHttpError)) {
    return failure({
      reason: "bootstrap_unavailable",
      operation: "bootstrap",
      routeId: "csrf_bootstrap"
    });
  }
  const common = {
    operation: "bootstrap" as const,
    routeId: "csrf_bootstrap" as const,
    transport: error.transport,
    status: error.status,
    apiError: sanitizeApiError(error.apiError)
  };
  if (error.reason === "request_contract" || error.reason === "request_too_large") {
    return failure({ ...common, reason: "client_contract" });
  }
  if (error.reason === "invalid_response" || error.reason === "response_too_large") {
    return failure({ ...common, reason: "invalid_response" });
  }
  if (error.reason === "api_error") {
    if (error.apiError?.code === "operation_conflict") {
      return failure({ ...common, reason: "stale_generation" });
    }
    if (
      error.apiError?.code === "permission_denied" ||
      error.apiError?.code === "read_only"
    ) {
      return failure({ ...common, reason: "authority_rejected" });
    }
    return failure({ ...common, reason: "api_error" });
  }
  return failure({ ...common, reason: "bootstrap_unavailable" });
}

function mapMutationFailure(
  error: unknown,
  routeId: BrowserHttpDeviceCsrfRouteId
): HostDeckBrowserCsrfError {
  if (error instanceof HostDeckBrowserCsrfError) return error;
  if (!(error instanceof HostDeckBrowserHttpError)) {
    return failure({ reason: "api_error", operation: "mutation", routeId });
  }
  const common = {
    operation: "mutation" as const,
    routeId,
    transport: error.transport,
    status: error.status,
    apiError: sanitizeApiError(error.apiError)
  };
  if (error.reason === "caller_aborted") {
    return failure({ ...common, reason: "caller_aborted" });
  }
  if (error.reason === "request_contract" || error.reason === "request_too_large") {
    return failure({ ...common, reason: "client_contract" });
  }
  if (error.reason === "invalid_response" || error.reason === "response_too_large") {
    return failure({ ...common, reason: "invalid_response" });
  }
  if (error.reason === "api_error") {
    if (error.apiError?.code === "operation_conflict") {
      return failure({ ...common, reason: "stale_generation" });
    }
    if (
      error.apiError?.code === "permission_denied" ||
      error.apiError?.code === "read_only"
    ) {
      return failure({ ...common, reason: "authority_rejected" });
    }
  }
  return failure({ ...common, reason: "api_error" });
}

function createMutationSignalScope(
  callerSignal: AbortSignal | null,
  authoritySignal: AbortSignal
): MutationSignalScope {
  const controller = new AbortController();
  let callerWasAborted = false;
  const abortFromCaller = (): void => {
    callerWasAborted = true;
    safeAbort(controller);
  };
  const abortFromAuthority = (): void => safeAbort(controller);

  if (callerSignal !== null) addAbortSignalListener(callerSignal, abortFromCaller);
  addAbortSignalListener(authoritySignal, abortFromAuthority);
  if (callerSignal !== null && readAbortSignalState(callerSignal)) abortFromCaller();
  if (readAbortSignalState(authoritySignal)) abortFromAuthority();

  let closed = false;
  return Object.freeze({
    signal: controller.signal,
    callerAborted: () => callerWasAborted,
    close: () => {
      if (closed) return;
      closed = true;
      if (callerSignal !== null) {
        removeAbortSignalListener(callerSignal, abortFromCaller);
      }
      removeAbortSignalListener(authoritySignal, abortFromAuthority);
    }
  });
}

function idleSnapshot(
  reason: "not_bootstrapped" | BrowserCsrfInvalidationReason
): BrowserCsrfSnapshot {
  return Object.freeze({
    phase: "idle",
    generation: null,
    rotatedAt: null,
    failure: null,
    invalidationReason: reason
  });
}

function bootstrappingSnapshot(): BrowserCsrfSnapshot {
  return Object.freeze({
    phase: "bootstrapping",
    generation: null,
    rotatedAt: null,
    failure: null,
    invalidationReason: null
  });
}

function readySnapshot(credential: BrowserCsrfCredential): BrowserCsrfSnapshot {
  return Object.freeze({
    phase: "ready",
    generation: credential.generation,
    rotatedAt: credential.rotatedAt,
    failure: null,
    invalidationReason: null
  });
}

function failedSnapshot(error: HostDeckBrowserCsrfError): BrowserCsrfSnapshot {
  return Object.freeze({
    phase: "failed",
    generation: null,
    rotatedAt: null,
    failure: error,
    invalidationReason: null
  });
}

function closedSnapshot(): BrowserCsrfSnapshot {
  return Object.freeze({
    phase: "closed",
    generation: null,
    rotatedAt: null,
    failure: null,
    invalidationReason: null
  });
}

function failure(input: {
  readonly reason: BrowserCsrfFailureReason;
  readonly operation: BrowserCsrfOperation;
  readonly routeId?: BrowserHttpDeviceCsrfRouteId | "csrf_bootstrap" | null;
  readonly transport?: BrowserHttpTransport | null;
  readonly status?: number | null;
  readonly apiError?: ApiErrorEnvelope | null;
}): HostDeckBrowserCsrfError {
  return new HostDeckBrowserCsrfError(input);
}

function messageForReason(reason: BrowserCsrfFailureReason): string {
  switch (reason) {
    case "client_contract":
      return "The browser CSRF client contract is invalid.";
    case "not_ready":
      return "Current browser write authority is unavailable.";
    case "caller_aborted":
      return "The browser write was cancelled.";
    case "authority_changed":
      return "Browser write authority changed before completion.";
    case "bootstrap_unavailable":
      return "Browser write authority could not be bootstrapped.";
    case "invalid_response":
      return "The browser authority response is invalid.";
    case "authority_rejected":
      return "Browser write authority was rejected.";
    case "stale_generation":
      return "Browser write authority is stale.";
    case "api_error":
      return "The browser authority operation failed.";
    case "closed":
      return "The browser CSRF client is closed.";
  }
}

function readExactRecord(
  candidate: unknown,
  requiredKeys: readonly string[],
  allowedKeys: readonly string[]
): Readonly<Record<string, unknown>> | null {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  try {
    const prototype = Object.getPrototypeOf(candidate);
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          !allowedKeys.includes(key) ||
          descriptors[key] === undefined ||
          !descriptors[key].enumerable ||
          !("value" in descriptors[key])
      ) ||
      requiredKeys.some((key) => !Object.hasOwn(descriptors, key))
    ) {
      return null;
    }
    return Object.freeze(
      Object.fromEntries(
        keys.map((key) => [key, descriptors[key as string]?.value])
      )
    );
  } catch {
    return null;
  }
}

function isAbortSignal(candidate: unknown): candidate is AbortSignal {
  if (candidate === null || typeof candidate !== "object") return false;
  try {
    readAbortSignalState(candidate as AbortSignal);
    return true;
  } catch {
    return false;
  }
}

function readAbortSignalState(signal: AbortSignal): boolean {
  const getter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
  if (typeof getter !== "function") {
    throw new TypeError("AbortSignal state is unavailable.");
  }
  const aborted = Reflect.apply(getter, signal, []) as unknown;
  if (typeof aborted !== "boolean") {
    throw new TypeError("AbortSignal state is invalid.");
  }
  return aborted;
}

function addAbortSignalListener(signal: AbortSignal, listener: () => void): void {
  Reflect.apply(EventTarget.prototype.addEventListener, signal, [
    "abort",
    listener,
    { once: true }
  ]);
}

function removeAbortSignalListener(signal: AbortSignal, listener: () => void): void {
  Reflect.apply(EventTarget.prototype.removeEventListener, signal, ["abort", listener]);
}

function safeAbort(controller: AbortController): void {
  Reflect.apply(AbortController.prototype.abort, controller, []);
}

function sanitizeApiError(error: ApiErrorEnvelope | null): ApiErrorEnvelope | null {
  if (error === null) return null;
  return Object.freeze({
    code: error.code,
    message: "The HostDeck API request failed.",
    retryable: error.retryable
  });
}
