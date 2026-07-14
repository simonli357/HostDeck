import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import {
  assertResolvedResourceBudget,
  defaultResourceBudget,
  hostDeckLoopbackOriginSchema,
  type RemoteIngressObservationSnapshot,
  type RemoteServeDescriptor,
  type ResourceBudget,
  remoteComparisonKeySchema,
  remoteIngressObservationSnapshotSchema,
  remoteServeDescriptorSchema
} from "@hostdeck/contracts";
import type { RemoteIngressUnavailableReason } from "@hostdeck/core";
import {
  HostDeckTailscaleObserverError,
  type TailscaleObserver,
  tailscaleExecutablePath,
  tailscaleObserverEnvironment
} from "./tailscale-observer.js";

export const tailscaleServeMutationCommands = ["enable", "disable"] as const;
export type TailscaleServeMutationCommand = (typeof tailscaleServeMutationCommands)[number];

export const tailscaleServeCommandCompletions = [
  "succeeded",
  "command_failed",
  "command_timeout",
  "output_oversized",
  "not_installed",
  "aborted"
] as const;
export type TailscaleServeCommandCompletion = (typeof tailscaleServeCommandCompletions)[number];

export interface TailscaleServeCommandRequest {
  readonly command: TailscaleServeMutationCommand;
  readonly executable: typeof tailscaleExecutablePath;
  readonly args: readonly string[];
  readonly cwd: "/";
  readonly environment: Readonly<Record<string, string>>;
  readonly timeout_ms: number;
  readonly output_max_bytes: number;
  readonly signal: AbortSignal;
}

export interface TailscaleServeCommandResult {
  readonly completion: TailscaleServeCommandCompletion;
  readonly consent_required: boolean;
  readonly permission_denied: boolean;
}

export interface TailscaleServeCommandRunner {
  readonly run: (request: TailscaleServeCommandRequest) => Promise<TailscaleServeCommandResult>;
}

export interface TailscaleServeMutationInput {
  readonly expected_profile_key: string;
  readonly expected_serve: RemoteServeDescriptor;
}

export type TailscaleServeManagerReason = RemoteIngressUnavailableReason | "operation_aborted";
export type TailscaleServeManagerOutcome = "succeeded" | "failed" | "incomplete" | "rejected";
export type TailscaleServeManagerServeResult =
  | "not_attempted"
  | "unchanged"
  | "applied"
  | "removed"
  | "unknown";

export interface TailscaleServeManagerResult {
  readonly action: TailscaleServeMutationCommand;
  readonly outcome: TailscaleServeManagerOutcome;
  readonly serve_result: TailscaleServeManagerServeResult;
  readonly reason: TailscaleServeManagerReason | null;
  readonly command_attempted: boolean;
  readonly before: RemoteIngressObservationSnapshot;
  readonly after: RemoteIngressObservationSnapshot | null;
}

export interface TailscaleServeManagerSnapshot {
  readonly active: boolean;
  readonly busy_rejections: number;
  readonly command_attempts: number;
  readonly failed_operations: number;
  readonly incomplete_operations: number;
  readonly rejected_operations: number;
  readonly started_operations: number;
  readonly succeeded_operations: number;
}

export interface TailscaleServeManager {
  readonly enable: (input: TailscaleServeMutationInput) => Promise<TailscaleServeManagerResult>;
  readonly disable: (input: TailscaleServeMutationInput) => Promise<TailscaleServeManagerResult>;
  readonly snapshot: () => TailscaleServeManagerSnapshot;
}

export interface CreateTailscaleServeManagerOptions {
  readonly observer: TailscaleObserver;
  readonly signal: AbortSignal;
  readonly resourceBudget?: ResourceBudget;
  readonly runner?: TailscaleServeCommandRunner;
}

export class HostDeckTailscaleServeManagerError extends Error {
  constructor(
    readonly code: "aborted" | "operation_busy" | "preflight_failed",
    readonly mutation_outcome: "not_started"
  ) {
    super(managerErrorMessage(code));
    this.name = "HostDeckTailscaleServeManagerError";
  }
}

interface ParsedMutationInput {
  readonly expected_profile_key: string;
  readonly expected_serve: RemoteServeDescriptor;
}

interface MutableCounters {
  busyRejections: number;
  commandAttempts: number;
  failedOperations: number;
  incompleteOperations: number;
  rejectedOperations: number;
  startedOperations: number;
  succeededOperations: number;
}

type InternalCommandCompletion = TailscaleServeCommandCompletion | "schema_invalid";

interface InternalCommandResult {
  readonly completion: InternalCommandCompletion;
  readonly consent_required: boolean;
  readonly permission_denied: boolean;
}

const managerOptionKeys = ["observer", "signal", "resourceBudget", "runner"] as const;
const mutationInputKeys = ["expected_profile_key", "expected_serve"] as const;
const commandResultKeys = ["completion", "consent_required", "permission_denied"] as const;
const permissionMarkers = [
  "access denied:",
  "permission denied",
  "serve config denied",
  "must be root, or be an operator"
] as const;
const consentMarkers = ["https://login.tailscale.com/"] as const;
const maxMarkerTailLength = 512;
const maxCounter = Number.MAX_SAFE_INTEGER;

export function createRealTailscaleServeCommandRunner(): TailscaleServeCommandRunner {
  return Object.freeze({
    async run(request: TailscaleServeCommandRequest) {
      assertCommandRequest(request);
      return runBoundedMutationCommand(request);
    }
  });
}

export function createTailscaleServeManager(
  rawOptions: CreateTailscaleServeManagerOptions
): TailscaleServeManager {
  const options = readAllowedDataObject(rawOptions, managerOptionKeys, ["observer"]);
  const observer = parseObserver(options.observer);
  assertAbortSignal(options.signal);
  const signal = options.signal;
  const resourceBudget = parseResourceBudget(options.resourceBudget);
  const runner = parseRunner(options.runner);

  const counters: MutableCounters = {
    busyRejections: 0,
    commandAttempts: 0,
    failedOperations: 0,
    incompleteOperations: 0,
    rejectedOperations: 0,
    startedOperations: 0,
    succeededOperations: 0
  };
  let active = false;

  async function execute(
    action: TailscaleServeMutationCommand,
    input: ParsedMutationInput
  ): Promise<TailscaleServeManagerResult> {
    if (signal.aborted) throw managerError("aborted");
    if (active) {
      counters.busyRejections = increment(counters.busyRejections);
      throw managerError("operation_busy");
    }
    active = true;
    counters.startedOperations = increment(counters.startedOperations);
    try {
      const result = await executeOperation(action, input, {
        observer,
        resourceBudget,
        runner,
        signal,
        onCommandAttempt() {
          counters.commandAttempts = increment(counters.commandAttempts);
        }
      });
      recordOutcome(counters, result.outcome);
      return result;
    } finally {
      active = false;
    }
  }

  return Object.freeze({
    enable(input: TailscaleServeMutationInput) {
      return execute("enable", parseMutationInput(input));
    },
    disable(input: TailscaleServeMutationInput) {
      return execute("disable", parseMutationInput(input));
    },
    snapshot() {
      return Object.freeze({
        active,
        busy_rejections: counters.busyRejections,
        command_attempts: counters.commandAttempts,
        failed_operations: counters.failedOperations,
        incomplete_operations: counters.incompleteOperations,
        rejected_operations: counters.rejectedOperations,
        started_operations: counters.startedOperations,
        succeeded_operations: counters.succeededOperations
      });
    }
  });
}

async function executeOperation(
  action: TailscaleServeMutationCommand,
  input: ParsedMutationInput,
  context: {
    readonly observer: TailscaleObserver;
    readonly resourceBudget: ResourceBudget;
    readonly runner: TailscaleServeCommandRunner;
    readonly signal: AbortSignal;
    readonly onCommandAttempt: () => void;
  }
): Promise<TailscaleServeManagerResult> {
  const before = await observeBefore(input, context.observer);
  const preflightReason = observationReason(before, input, false);
  if (preflightReason !== null) {
    return result(action, "rejected", "not_attempted", preflightReason, false, before, null);
  }

  const serve = before.serve;
  if (action === "enable" && serve === "exact") {
    return result(action, "succeeded", "unchanged", null, false, before, before);
  }
  if (action === "disable" && serve === "absent") {
    return result(action, "succeeded", "unchanged", null, false, before, before);
  }
  if ((action === "enable" && serve !== "absent") || (action === "disable" && serve !== "exact")) {
    return result(
      action,
      "rejected",
      "not_attempted",
      serveReason(serve),
      false,
      before,
      null
    );
  }

  context.onCommandAttempt();
  const command = await runMutation(action, input.expected_serve, context);
  if (context.signal.aborted) {
    return result(action, "incomplete", "unknown", "operation_aborted", true, before, null);
  }

  let after: RemoteIngressObservationSnapshot;
  try {
    after = await observeAfter(input, context.observer);
  } catch (error) {
    const reason =
      context.signal.aborted ||
      (error instanceof HostDeckTailscaleObserverError && error.code === "aborted")
        ? "operation_aborted"
        : "observation_failed";
    return result(action, "incomplete", "unknown", reason, true, before, null);
  }

  if (isDesiredState(action, after, input)) {
    return result(
      action,
      "succeeded",
      action === "enable" ? "applied" : "removed",
      null,
      true,
      before,
      after
    );
  }

  if (isUnchangedPreState(action, after, input)) {
    return result(
      action,
      "failed",
      "unchanged",
      commandFailureReason(action, command),
      true,
      before,
      after
    );
  }

  return result(
    action,
    "incomplete",
    "unknown",
    observationReason(after, input, true) ?? "observation_failed",
    true,
    before,
    after
  );
}

async function observeBefore(
  input: ParsedMutationInput,
  observer: TailscaleObserver
): Promise<RemoteIngressObservationSnapshot> {
  try {
    return await observe(input, observer);
  } catch (error) {
    throw managerError(
      error instanceof HostDeckTailscaleObserverError && error.code === "aborted"
        ? "aborted"
        : "preflight_failed"
    );
  }
}

async function observeAfter(
  input: ParsedMutationInput,
  observer: TailscaleObserver
): Promise<RemoteIngressObservationSnapshot> {
  return observe(input, observer);
}

async function observe(
  input: ParsedMutationInput,
  observer: TailscaleObserver
): Promise<RemoteIngressObservationSnapshot> {
  const raw = await observer.observeConfigured({
    expected_profile_key: input.expected_profile_key,
    expected_serve: input.expected_serve
  });
  const parsed = remoteIngressObservationSnapshotSchema.safeParse(raw);
  if (!parsed.success) throw managerError("preflight_failed");
  return deepFreeze(parsed.data);
}

async function runMutation(
  action: TailscaleServeMutationCommand,
  expectedServe: RemoteServeDescriptor,
  context: {
    readonly resourceBudget: ResourceBudget;
    readonly runner: TailscaleServeCommandRunner;
    readonly signal: AbortSignal;
  }
): Promise<InternalCommandResult> {
  const request: TailscaleServeCommandRequest = Object.freeze({
    command: action,
    executable: tailscaleExecutablePath,
    args:
      action === "enable"
        ? Object.freeze(["serve", "--bg", expectedServe.proxy_origin])
        : Object.freeze(["serve", "--https=443", "--set-path=/", "off"]),
    cwd: "/",
    environment: tailscaleObserverEnvironment,
    timeout_ms: context.resourceBudget.remote_observer_command_timeout_ms,
    output_max_bytes: context.resourceBudget.remote_observer_output_max_bytes,
    signal: context.signal
  });
  let raw: unknown;
  try {
    raw = await context.runner.run(request);
  } catch {
    return Object.freeze({
      completion: context.signal.aborted ? "aborted" : "command_failed",
      consent_required: false,
      permission_denied: false
    });
  }
  return parseCommandResult(raw);
}

function parseCommandResult(raw: unknown): InternalCommandResult {
  let value: Readonly<Record<(typeof commandResultKeys)[number], unknown>>;
  try {
    value = readExactDataObject(raw, commandResultKeys);
  } catch {
    return Object.freeze({
      completion: "schema_invalid",
      consent_required: false,
      permission_denied: false
    });
  }
  if (
    typeof value.completion !== "string" ||
    !tailscaleServeCommandCompletions.includes(value.completion as TailscaleServeCommandCompletion) ||
    typeof value.consent_required !== "boolean" ||
    typeof value.permission_denied !== "boolean"
  ) {
    return Object.freeze({
      completion: "schema_invalid",
      consent_required: false,
      permission_denied: false
    });
  }
  return Object.freeze({
    completion: value.completion as TailscaleServeCommandCompletion,
    consent_required: value.consent_required,
    permission_denied: value.permission_denied
  });
}

function observationReason(
  snapshot: RemoteIngressObservationSnapshot,
  input: ParsedMutationInput,
  afterMutation: boolean
): TailscaleServeManagerReason | null {
  if (snapshot.failure !== null) return snapshot.failure;
  switch (snapshot.client) {
    case "not_installed":
      return "client_not_installed";
    case "unsupported":
      return "client_unsupported";
    case "error":
      return "client_error";
    case "available":
      break;
  }
  switch (snapshot.profile.state) {
    case "absent":
      return afterMutation ? "profile_changed" : "profile_absent";
    case "stopped":
      return "client_stopped";
    case "signed_out":
      return "client_signed_out";
    case "other":
      return afterMutation ? "profile_changed" : "profile_other";
    case "unknown":
      return afterMutation ? "profile_changed" : "profile_unknown";
    case "dedicated":
      break;
  }
  if (
    snapshot.profile.comparison.relation !== "match" ||
    snapshot.profile.comparison.expected_profile_key !== input.expected_profile_key ||
    snapshot.profile.comparison.active_profile_key !== input.expected_profile_key
  ) {
    return afterMutation ? "profile_changed" : "profile_unknown";
  }
  if (snapshot.external_origin !== input.expected_serve.external_origin) {
    return "external_origin_invalid";
  }
  return serveReason(snapshot.serve);
}

function serveReason(
  serve: RemoteIngressObservationSnapshot["serve"]
): RemoteIngressUnavailableReason | null {
  switch (serve) {
    case "absent":
    case "exact":
      return null;
    case "foreign":
      return "serve_foreign";
    case "colliding":
      return "serve_colliding";
    case "drifted":
      return "serve_drifted";
    case "public":
      return "serve_public";
    case null:
      return "observation_failed";
  }
}

function isDesiredState(
  action: TailscaleServeMutationCommand,
  snapshot: RemoteIngressObservationSnapshot,
  input: ParsedMutationInput
): boolean {
  return (
    observationReason(snapshot, input, true) === null &&
    snapshot.serve === (action === "enable" ? "exact" : "absent")
  );
}

function isUnchangedPreState(
  action: TailscaleServeMutationCommand,
  snapshot: RemoteIngressObservationSnapshot,
  input: ParsedMutationInput
): boolean {
  return (
    observationReason(snapshot, input, true) === null &&
    snapshot.serve === (action === "enable" ? "absent" : "exact")
  );
}

function commandFailureReason(
  action: TailscaleServeMutationCommand,
  command: InternalCommandResult
): TailscaleServeManagerReason {
  if (command.completion === "output_oversized") return "output_oversized";
  if (command.completion === "aborted") return "operation_aborted";
  if (action === "enable" && command.consent_required) return "consent_required";
  if (command.permission_denied) return "permission_denied";
  switch (command.completion) {
    case "command_timeout":
      return "command_timeout";
    case "schema_invalid":
      return "schema_invalid";
    case "succeeded":
    case "command_failed":
    case "not_installed":
      return "command_failed";
  }
}

function result(
  action: TailscaleServeMutationCommand,
  outcome: TailscaleServeManagerOutcome,
  serveResult: TailscaleServeManagerServeResult,
  reason: TailscaleServeManagerReason | null,
  commandAttempted: boolean,
  before: RemoteIngressObservationSnapshot,
  after: RemoteIngressObservationSnapshot | null
): TailscaleServeManagerResult {
  const validShape =
    (outcome === "rejected" &&
      serveResult === "not_attempted" &&
      reason !== null &&
      !commandAttempted &&
      after === null) ||
    (outcome === "failed" &&
      serveResult === "unchanged" &&
      reason !== null &&
      commandAttempted &&
      after !== null) ||
    (outcome === "incomplete" &&
      serveResult === "unknown" &&
      reason !== null &&
      commandAttempted) ||
    (outcome === "succeeded" &&
      reason === null &&
      after !== null &&
      ((serveResult === "unchanged" && !commandAttempted) ||
        (serveResult === "applied" && action === "enable" && commandAttempted) ||
        (serveResult === "removed" && action === "disable" && commandAttempted)));
  if (!validShape) {
    throw new TypeError("Tailscale Serve manager produced an impossible result.");
  }
  return deepFreeze({
    action,
    outcome,
    serve_result: serveResult,
    reason,
    command_attempted: commandAttempted,
    before,
    after
  });
}

function runBoundedMutationCommand(
  request: TailscaleServeCommandRequest
): Promise<TailscaleServeCommandResult> {
  return new Promise((resolve) => {
    if (request.signal.aborted) {
      resolve(commandResult("aborted", false, false));
      return;
    }

    let observedBytes = 0;
    let markerTail = "";
    let consentRequired = false;
    let permissionDenied = false;
    let pendingCompletion: TailscaleServeCommandCompletion | null = null;
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(request.executable, request.args, {
        cwd: request.cwd,
        env: request.environment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch {
      resolve(commandResult("command_failed", false, false));
      return;
    }

    const timer = setTimeout(() => stop("command_timeout"), request.timeout_ms);
    timer.unref();
    const onAbort = () => stop("aborted");
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) onAbort();

    child.once("error", (error: NodeJS.ErrnoException) => {
      pendingCompletion ??= error.code === "ENOENT" ? "not_installed" : "command_failed";
    });
    child.once("close", (code) => {
      cleanup();
      const completion = pendingCompletion ?? (code === 0 ? "succeeded" : "command_failed");
      settled = true;
      resolve(commandResult(completion, consentRequired, permissionDenied));
    });
    if (child.stdout === null || child.stderr === null) {
      stop("command_failed");
    } else {
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
    }

    function capture(chunk: Buffer): void {
      if (pendingCompletion !== null) return;
      observedBytes += chunk.byteLength;
      if (observedBytes > request.output_max_bytes) {
        stop("output_oversized");
        return;
      }
      const scan = `${markerTail}${chunk.toString("latin1")}`.toLowerCase();
      consentRequired ||= consentMarkers.some((marker) => scan.includes(marker));
      permissionDenied ||= permissionMarkers.some((marker) => scan.includes(marker));
      markerTail = scan.slice(-maxMarkerTailLength);
    }

    function stop(completion: TailscaleServeCommandCompletion): void {
      if (settled || pendingCompletion !== null) return;
      pendingCompletion = completion;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }

    function cleanup(): void {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
      markerTail = "";
    }
  });
}

function commandResult(
  completion: TailscaleServeCommandCompletion,
  consentRequired: boolean,
  permissionDenied: boolean
): TailscaleServeCommandResult {
  return Object.freeze({
    completion,
    consent_required: consentRequired,
    permission_denied: permissionDenied
  });
}

function assertCommandRequest(request: TailscaleServeCommandRequest): void {
  const validArgs =
    request.command === "enable"
      ? request.args.length === 3 &&
        request.args[0] === "serve" &&
        request.args[1] === "--bg" &&
        hostDeckLoopbackOriginSchema.safeParse(request.args[2]).success
      : request.command === "disable" &&
        isDeepStrictEqual(request.args, ["serve", "--https=443", "--set-path=/", "off"]);
  if (
    !tailscaleServeMutationCommands.includes(request.command) ||
    request.executable !== tailscaleExecutablePath ||
    request.cwd !== "/" ||
    !validArgs ||
    !isDeepStrictEqual(request.environment, tailscaleObserverEnvironment) ||
    !Number.isSafeInteger(request.timeout_ms) ||
    request.timeout_ms <= 0 ||
    !Number.isSafeInteger(request.output_max_bytes) ||
    request.output_max_bytes <= 0
  ) {
    throw new TypeError("Tailscale Serve command request is invalid.");
  }
  assertAbortSignal(request.signal);
}

function parseMutationInput(input: TailscaleServeMutationInput): ParsedMutationInput {
  let value: Readonly<Record<(typeof mutationInputKeys)[number], unknown>>;
  try {
    value = readExactDataObject(input, mutationInputKeys);
  } catch {
    throw new TypeError("Tailscale Serve mutation input is invalid.");
  }
  const profile = remoteComparisonKeySchema.safeParse(value.expected_profile_key);
  const serve = remoteServeDescriptorSchema.safeParse(value.expected_serve);
  if (!profile.success || !serve.success) {
    throw new TypeError("Tailscale Serve mutation input is invalid.");
  }
  return Object.freeze({
    expected_profile_key: profile.data,
    expected_serve: deepFreeze(serve.data)
  });
}

function parseObserver(value: unknown): TailscaleObserver {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as TailscaleObserver).observeConfigured !== "function"
  ) {
    throw new TypeError("Tailscale Serve manager observer is invalid.");
  }
  return value as TailscaleObserver;
}

function parseResourceBudget(value: unknown): ResourceBudget {
  if (value === undefined) return defaultResourceBudget;
  assertResolvedResourceBudget(value);
  return value;
}

function parseRunner(value: unknown): TailscaleServeCommandRunner {
  if (value === undefined) return createRealTailscaleServeCommandRunner();
  if (value === null || typeof value !== "object" || typeof (value as TailscaleServeCommandRunner).run !== "function") {
    throw new TypeError("Tailscale Serve command runner is invalid.");
  }
  return value as TailscaleServeCommandRunner;
}

function readAllowedDataObject<const Key extends string, const Required extends Key>(
  input: unknown,
  allowedKeys: readonly Key[],
  requiredKeys: readonly Required[]
): Readonly<Partial<Record<Key, unknown>> & Record<Required, unknown>> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Expected one data object.");
  }
  try {
    const prototype = Object.getPrototypeOf(input) as unknown;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key as Key)) ||
      requiredKeys.some((key) => !Object.hasOwn(descriptors, key))
    ) {
      throw new TypeError("Expected one data object.");
    }
    const output = Object.create(null) as Partial<Record<Key, unknown>> & Record<Required, unknown>;
    for (const key of keys) {
      const descriptor = descriptors[key as keyof typeof descriptors];
      if (typeof key !== "string" || descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError("Expected one data object.");
      }
      output[key as Key] = descriptor.value;
    }
    return output;
  } catch (error) {
    if (error instanceof TypeError && error.message === "Expected one data object.") throw error;
    throw new TypeError("Expected one data object.");
  }
}

function readExactDataObject<const Key extends string>(
  input: unknown,
  expectedKeys: readonly Key[]
): Readonly<Record<Key, unknown>> {
  const value = readAllowedDataObject(input, expectedKeys, expectedKeys);
  if (Object.keys(value).length !== expectedKeys.length) {
    throw new TypeError("Expected one exact data object.");
  }
  return value;
}

function assertAbortSignal(signal: unknown): asserts signal is AbortSignal {
  if (
    signal === null ||
    typeof signal !== "object" ||
    typeof (signal as AbortSignal).aborted !== "boolean" ||
    typeof (signal as AbortSignal).addEventListener !== "function" ||
    typeof (signal as AbortSignal).removeEventListener !== "function"
  ) {
    throw new TypeError("Tailscale Serve manager requires one AbortSignal.");
  }
}

function recordOutcome(counters: MutableCounters, outcome: TailscaleServeManagerOutcome): void {
  switch (outcome) {
    case "succeeded":
      counters.succeededOperations = increment(counters.succeededOperations);
      break;
    case "failed":
      counters.failedOperations = increment(counters.failedOperations);
      break;
    case "incomplete":
      counters.incompleteOperations = increment(counters.incompleteOperations);
      break;
    case "rejected":
      counters.rejectedOperations = increment(counters.rejectedOperations);
      break;
  }
}

function increment(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= maxCounter) {
    throw new TypeError("Tailscale Serve manager counter is invalid.");
  }
  return value + 1;
}

function managerError(
  code: "aborted" | "operation_busy" | "preflight_failed"
): HostDeckTailscaleServeManagerError {
  return new HostDeckTailscaleServeManagerError(code, "not_started");
}

function managerErrorMessage(code: HostDeckTailscaleServeManagerError["code"]): string {
  switch (code) {
    case "aborted":
      return "Tailscale Serve operation was cancelled before mutation.";
    case "operation_busy":
      return "Another Tailscale Serve operation is already active.";
    case "preflight_failed":
      return "Tailscale Serve preflight could not produce a supported observation.";
  }
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
