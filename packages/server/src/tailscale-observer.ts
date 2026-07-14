import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  assertResolvedResourceBudget,
  defaultResourceBudget,
  type RemoteIngressObservationSnapshot,
  type RemoteProfileObservation,
  type RemoteServeDescriptor,
  type ResourceBudget,
  remoteComparisonKeySchema,
  remoteExternalOriginSchema,
  remoteIngressObservationSnapshotSchema,
  remoteServeDescriptorSchema
} from "@hostdeck/contracts";
import { z } from "zod";

export const tailscaleExecutablePath = "/usr/bin/tailscale" as const;
export const supportedTailscaleVersion = Object.freeze({
  short: "1.98.8",
  long: "1.98.8-t1241b225b-g0520dfda5",
  tailscale_commit: "1241b225bc798707d02db3570992625d3a16594f",
  other_commit: "0520dfda5d034816c38a15a8661160eb9a6d5ac4",
  go_version: "go1.26.3 (tailscale/go e877d97384)"
});

export const tailscaleReadCommandNames = [
  "version",
  "status",
  "profile_list",
  "serve_status",
  "funnel_status"
] as const;
export type TailscaleReadCommandName = (typeof tailscaleReadCommandNames)[number];

const tailscaleReadCommandArguments: Readonly<Record<TailscaleReadCommandName, readonly string[]>> = Object.freeze({
  version: Object.freeze(["version"]),
  status: Object.freeze(["status", "--json"]),
  profile_list: Object.freeze(["switch", "--list", "--json"]),
  serve_status: Object.freeze(["serve", "status", "--json"]),
  funnel_status: Object.freeze(["funnel", "status", "--json"])
});

export const tailscaleObserverEnvironment = Object.freeze({
  LANG: "C",
  LC_ALL: "C",
  PATH: "/usr/bin:/bin",
  TERM: "dumb"
});

export type TailscaleReadCommandErrorCode =
  | "not_installed"
  | "aborted"
  | "command_failed"
  | "command_timeout"
  | "output_oversized"
  | "schema_invalid";

export class HostDeckTailscaleReadCommandError extends Error {
  constructor(readonly code: TailscaleReadCommandErrorCode) {
    super(commandErrorMessage(code));
    this.name = "HostDeckTailscaleReadCommandError";
  }
}

export class HostDeckTailscaleObserverError extends Error {
  constructor(readonly code: "aborted" | "observation_busy") {
    super(code === "aborted" ? "Tailscale observation was cancelled." : "A different Tailscale observation is already running.");
    this.name = "HostDeckTailscaleObserverError";
  }
}

export interface TailscaleReadCommandRequest {
  readonly command: TailscaleReadCommandName;
  readonly executable: typeof tailscaleExecutablePath;
  readonly args: readonly string[];
  readonly cwd: "/";
  readonly environment: Readonly<Record<string, string>>;
  readonly timeout_ms: number;
  readonly output_max_bytes: number;
  readonly signal: AbortSignal;
}

export interface TailscaleReadCommandResult {
  readonly stdout: string;
}

export interface TailscaleReadCommandRunner {
  readonly run: (request: TailscaleReadCommandRequest) => Promise<TailscaleReadCommandResult>;
}

export interface TailscaleConfiguredObservationInput {
  readonly expected_profile_key: string;
  readonly expected_serve: RemoteServeDescriptor | null;
}

export interface TailscaleObserver {
  readonly poll_interval_ms: number;
  readonly observeCandidate: () => Promise<RemoteIngressObservationSnapshot>;
  readonly observeConfigured: (
    input: TailscaleConfiguredObservationInput
  ) => Promise<RemoteIngressObservationSnapshot>;
}

export interface CreateTailscaleObserverOptions {
  readonly signal: AbortSignal;
  readonly resourceBudget?: ResourceBudget;
  readonly runner?: TailscaleReadCommandRunner;
  readonly now?: () => Date;
  readonly monotonicNow?: () => number;
}

type ObservationFailure = Exclude<TailscaleReadCommandErrorCode, "aborted"> | "unsupported" | "profile_changed";

interface CandidateExpectation {
  readonly kind: "candidate";
  readonly key: "candidate";
  readonly expected_profile_key: null;
  readonly expected_serve: null;
}

interface ConfiguredExpectation {
  readonly kind: "configured";
  readonly key: string;
  readonly expected_profile_key: string;
  readonly expected_serve: RemoteServeDescriptor | null;
}

type ObservationExpectation = CandidateExpectation | ConfiguredExpectation;

interface ActiveObservation {
  readonly key: string;
  readonly promise: Promise<RemoteIngressObservationSnapshot>;
}

interface RawStatus {
  readonly AuthURL: string;
  readonly BackendState: string;
  readonly CertDomains: readonly string[] | null;
  readonly ClientVersion: string | null;
  readonly CurrentTailnet: RawCurrentTailnet | null;
  readonly HaveNodeKey?: boolean | undefined;
  readonly Health: readonly string[];
  readonly MagicDNSSuffix: string;
  readonly Peer: Readonly<Record<string, unknown>> | null;
  readonly Self: Readonly<Record<string, unknown>>;
  readonly TUN: boolean;
  readonly TailscaleIPs: readonly string[] | null;
  readonly User: Readonly<Record<string, unknown>> | null;
  readonly Version: string;
}

interface RawCurrentTailnet {
  readonly MagicDNSEnabled: boolean;
  readonly MagicDNSSuffix: string;
  readonly Name: string;
}

interface RawProfile {
  readonly account: string;
  readonly id: string;
  readonly nickname: string;
  readonly selected: boolean;
  readonly tailnet: string;
}

interface SelectedRawProfile {
  readonly raw: RawProfile;
  readonly comparison_key: string;
}

type RawServeStatus = Readonly<{
  TCP?: Readonly<Record<string, unknown>> | undefined;
  Web?: Readonly<Record<string, unknown>> | undefined;
  AllowFunnel?: unknown;
}>;

const rawIdentityStringSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\p{Cc}]+$/u);
const rawStatusSchema = z
  .object({
    AuthURL: z.string().max(2_048),
    BackendState: z.string().min(1).max(64),
    CertDomains: z.array(z.string().min(1).max(253)).max(8).nullable(),
    ClientVersion: z.string().max(128).nullable(),
    CurrentTailnet: z
      .object({
        MagicDNSEnabled: z.boolean(),
        MagicDNSSuffix: z.string().max(253),
        Name: rawIdentityStringSchema
      })
      .strict()
      .nullable(),
    HaveNodeKey: z.boolean().optional(),
    Health: z.array(z.string().max(1_024)).max(64),
    MagicDNSSuffix: z.string().max(253),
    Peer: z.record(z.string(), z.unknown()).nullable(),
    Self: z.record(z.string(), z.unknown()),
    TUN: z.boolean(),
    TailscaleIPs: z.array(z.string().max(64)).max(64).nullable(),
    User: z.record(z.string(), z.unknown()).nullable(),
    Version: z.string().min(1).max(128)
  })
  .strict();
const rawProfileSchema = z
  .object({
    account: rawIdentityStringSchema,
    id: rawIdentityStringSchema,
    nickname: rawIdentityStringSchema,
    selected: z.boolean(),
    tailnet: rawIdentityStringSchema
  })
  .strict();
const rawProfilesSchema = z.array(rawProfileSchema);
const rawServeStatusSchema = z
  .object({
    TCP: z.record(z.string(), z.unknown()).optional(),
    Web: z.record(z.string(), z.unknown()).optional(),
    AllowFunnel: z.unknown().optional()
  })
  .strict();

const configuredExpectationKeys = ["expected_profile_key", "expected_serve"] as const;
const expectedVersionOutput = [
  supportedTailscaleVersion.short,
  `  tailscale commit: ${supportedTailscaleVersion.tailscale_commit}`,
  `  long version: ${supportedTailscaleVersion.long}`,
  `  other commit: ${supportedTailscaleVersion.other_commit}`,
  `  go version: ${supportedTailscaleVersion.go_version}`
].join("\n");

export function createRealTailscaleReadCommandRunner(): TailscaleReadCommandRunner {
  return Object.freeze({
    async run(request: TailscaleReadCommandRequest) {
      assertCommandRequest(request);
      return runBoundedCommand(request);
    }
  });
}

export function createTailscaleObserver(options: CreateTailscaleObserverOptions): TailscaleObserver {
  assertAbortSignal(options.signal);
  const budget = options.resourceBudget ?? defaultResourceBudget;
  assertResolvedResourceBudget(budget);
  const runner = options.runner ?? createRealTailscaleReadCommandRunner();
  if (runner === null || typeof runner !== "object" || typeof runner.run !== "function") {
    throw new TypeError("Tailscale observer command runner is invalid.");
  }
  const now = options.now ?? (() => new Date());
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  if (typeof now !== "function" || typeof monotonicNow !== "function") {
    throw new TypeError("Tailscale observer clocks are invalid.");
  }

  let active: ActiveObservation | null = null;

  function observe(expectation: ObservationExpectation): Promise<RemoteIngressObservationSnapshot> {
    if (options.signal.aborted) return Promise.reject(new HostDeckTailscaleObserverError("aborted"));
    if (active !== null) {
      if (active.key === expectation.key) return active.promise;
      return Promise.reject(new HostDeckTailscaleObserverError("observation_busy"));
    }

    const promise = runObservationCycle(expectation, {
      budget,
      monotonicNow,
      now,
      runner,
      signal: options.signal
    });
    active = Object.freeze({ key: expectation.key, promise });
    void promise
      .finally(() => {
        if (active?.promise === promise) active = null;
      })
      .catch(() => undefined);
    return promise;
  }

  return Object.freeze({
    poll_interval_ms: budget.remote_observer_poll_interval_ms,
    observeCandidate() {
      return observe(candidateExpectation());
    },
    observeConfigured(input: TailscaleConfiguredObservationInput) {
      return observe(parseConfiguredExpectation(input));
    }
  });
}

async function runObservationCycle(
  expectation: ObservationExpectation,
  context: {
    readonly budget: ResourceBudget;
    readonly monotonicNow: () => number;
    readonly now: () => Date;
    readonly runner: TailscaleReadCommandRunner;
    readonly signal: AbortSignal;
  }
): Promise<RemoteIngressObservationSnapshot> {
  const startedAt = readMonotonicClock(context.monotonicNow);
  const deadline = startedAt + context.budget.remote_observer_cycle_timeout_ms;
  const run = (command: TailscaleReadCommandName) => runReadCommand(command, deadline, context);

  try {
    const versionOutput = await run("version");
    if (versionOutput.trimEnd() !== expectedVersionOutput) {
      return failureSnapshot("unsupported", expectation, context.now);
    }

    const statusBefore = parseStatus(await run("status"));
    if (statusBefore.Version !== supportedTailscaleVersion.long) {
      return failureSnapshot("unsupported", expectation, context.now);
    }
    if (statusBefore.BackendState === "NeedsLogin") {
      return snapshot(
        {
          schema_version: 1,
          client: "available",
          profile: unknownProfile("signed_out", expectation.expected_profile_key),
          serve: null,
          external_origin: null,
          failure: null,
          observed_at: observedAt(context.now)
        }
      );
    }
    if (statusBefore.BackendState !== "Running" && statusBefore.BackendState !== "Stopped") {
      return failureSnapshot("schema_invalid", expectation, context.now);
    }

    const selectedBefore = parseSelectedProfile(
      await run("profile_list"),
      context.budget.remote_observer_max_profiles
    );
    assertStatusProfileAgreement(statusBefore, selectedBefore.raw);
    const relation =
      expectation.kind === "candidate" || selectedBefore.comparison_key === expectation.expected_profile_key
        ? "match"
        : "different";

    let serve: RawServeStatus | null = null;
    let funnel: RawServeStatus | null = null;
    if (relation === "match") {
      serve = parseServeStatus(await run("serve_status"));
      funnel = parseServeStatus(await run("funnel_status"));
    }

    const statusAfter = parseStatus(await run("status"));
    if (statusAfter.Version !== supportedTailscaleVersion.long) {
      return failureSnapshot("unsupported", expectation, context.now);
    }
    if (statusAfter.BackendState !== "Running" && statusAfter.BackendState !== "Stopped") {
      return failureSnapshot("profile_changed", expectation, context.now);
    }
    const selectedAfter = parseSelectedProfile(
      await run("profile_list"),
      context.budget.remote_observer_max_profiles
    );
    assertStatusProfileAgreement(statusAfter, selectedAfter.raw);
    if (!sameObservationIdentity(statusBefore, selectedBefore, statusAfter, selectedAfter)) {
      return failureSnapshot("profile_changed", expectation, context.now);
    }

    const expectedProfileKey =
      expectation.kind === "candidate" ? selectedAfter.comparison_key : expectation.expected_profile_key;
    const profileState =
      statusAfter.BackendState === "Stopped" ? "stopped" : relation === "match" ? "dedicated" : "other";
    const profile = remoteProfile(profileState, relation, expectedProfileKey, selectedAfter.comparison_key);
    if (relation === "different") {
      return snapshot({
        schema_version: 1,
        client: "available",
        profile,
        serve: null,
        external_origin: null,
        failure: null,
        observed_at: observedAt(context.now)
      });
    }
    if (serve === null || funnel === null) {
      return failureSnapshot("schema_invalid", expectation, context.now);
    }
    if (!isDeepStrictEqual(serve, funnel)) {
      return failureSnapshot("schema_invalid", expectation, context.now);
    }

    const externalOrigin = deriveExternalOrigin(statusAfter, serve, expectation.expected_serve);
    const serveState = classifyServe(serve, expectation.expected_serve, externalOrigin);
    return snapshot({
      schema_version: 1,
      client: "available",
      profile,
      serve: serveState,
      external_origin: externalOrigin,
      failure: null,
      observed_at: observedAt(context.now)
    });
  } catch (error) {
    const code = readCommandFailure(error);
    if (code === "aborted") throw new HostDeckTailscaleObserverError("aborted");
    return failureSnapshot(code, expectation, context.now);
  }
}

async function runReadCommand(
  command: TailscaleReadCommandName,
  deadline: number,
  context: {
    readonly budget: ResourceBudget;
    readonly monotonicNow: () => number;
    readonly runner: TailscaleReadCommandRunner;
    readonly signal: AbortSignal;
  }
): Promise<string> {
  if (context.signal.aborted) throw new HostDeckTailscaleReadCommandError("aborted");
  const remaining = Math.floor(deadline - readMonotonicClock(context.monotonicNow));
  if (remaining <= 0) throw new HostDeckTailscaleReadCommandError("command_timeout");
  const timeout = Math.min(context.budget.remote_observer_command_timeout_ms, remaining);
  const request: TailscaleReadCommandRequest = Object.freeze({
    command,
    executable: tailscaleExecutablePath,
    args: tailscaleReadCommandArguments[command],
    cwd: "/",
    environment: tailscaleObserverEnvironment,
    timeout_ms: timeout,
    output_max_bytes: context.budget.remote_observer_output_max_bytes,
    signal: context.signal
  });

  let result: unknown;
  try {
    result = await context.runner.run(request);
  } catch (error) {
    if (error instanceof HostDeckTailscaleReadCommandError) throw error;
    throw new HostDeckTailscaleReadCommandError("command_failed");
  }
  if (context.signal.aborted) throw new HostDeckTailscaleReadCommandError("aborted");
  let parsed: Readonly<Record<"stdout", unknown>>;
  try {
    parsed = readExactObject(result, ["stdout"]);
  } catch {
    throw new HostDeckTailscaleReadCommandError("schema_invalid");
  }
  if (typeof parsed.stdout !== "string") throw new HostDeckTailscaleReadCommandError("schema_invalid");
  if (Buffer.byteLength(parsed.stdout, "utf8") > context.budget.remote_observer_output_max_bytes) {
    throw new HostDeckTailscaleReadCommandError("output_oversized");
  }
  return parsed.stdout;
}

function runBoundedCommand(request: TailscaleReadCommandRequest): Promise<TailscaleReadCommandResult> {
  return new Promise((resolve, reject) => {
    if (request.signal.aborted) {
      reject(new HostDeckTailscaleReadCommandError("aborted"));
      return;
    }

    const stdout: Buffer[] = [];
    let observedBytes = 0;
    let pendingFailure: HostDeckTailscaleReadCommandError | null = null;
    let settled = false;
    const child = spawn(request.executable, request.args, {
      cwd: request.cwd,
      env: request.environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    const timer = setTimeout(() => stop(new HostDeckTailscaleReadCommandError("command_timeout")), request.timeout_ms);
    timer.unref();
    const onAbort = () => stop(new HostDeckTailscaleReadCommandError("aborted"));
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) onAbort();

    child.stdout.on("data", (chunk: Buffer) => capture(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => capture(chunk, false));
    child.once("error", (error: NodeJS.ErrnoException) => {
      pendingFailure ??= new HostDeckTailscaleReadCommandError(
        error.code === "ENOENT" ? "not_installed" : request.signal.aborted ? "aborted" : "command_failed"
      );
    });
    child.once("close", (code) => {
      cleanup();
      if (pendingFailure !== null) {
        settleReject(pendingFailure);
        return;
      }
      if (code !== 0) {
        settleReject(new HostDeckTailscaleReadCommandError("command_failed"));
        return;
      }
      try {
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stdout));
        settled = true;
        resolve(Object.freeze({ stdout: decoded }));
      } catch {
        settleReject(new HostDeckTailscaleReadCommandError("schema_invalid"));
      }
    });

    function capture(chunk: Buffer, retain: boolean): void {
      if (pendingFailure !== null) return;
      observedBytes += chunk.byteLength;
      if (observedBytes > request.output_max_bytes) {
        stop(new HostDeckTailscaleReadCommandError("output_oversized"));
        return;
      }
      if (retain) stdout.push(Buffer.from(chunk));
    }

    function stop(error: HostDeckTailscaleReadCommandError): void {
      if (settled || pendingFailure !== null) return;
      pendingFailure = error;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }

    function cleanup(): void {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
    }

    function settleReject(error: HostDeckTailscaleReadCommandError): void {
      if (settled) return;
      settled = true;
      reject(error);
    }
  });
}

function assertCommandRequest(request: TailscaleReadCommandRequest): void {
  if (!tailscaleReadCommandNames.includes(request.command)) {
    throw new HostDeckTailscaleReadCommandError("schema_invalid");
  }
  const expectedArgs = tailscaleReadCommandArguments[request.command];
  if (
    request.executable !== tailscaleExecutablePath ||
    request.cwd !== "/" ||
    !isDeepStrictEqual(request.args, expectedArgs) ||
    !isDeepStrictEqual(request.environment, tailscaleObserverEnvironment) ||
    !Number.isSafeInteger(request.timeout_ms) ||
    request.timeout_ms <= 0 ||
    !Number.isSafeInteger(request.output_max_bytes) ||
    request.output_max_bytes <= 0
  ) {
    throw new HostDeckTailscaleReadCommandError("schema_invalid");
  }
  assertAbortSignal(request.signal);
}

function parseConfiguredExpectation(input: TailscaleConfiguredObservationInput): ConfiguredExpectation {
  let value: Readonly<Record<(typeof configuredExpectationKeys)[number], unknown>>;
  try {
    value = readExactObject(input, configuredExpectationKeys);
  } catch {
    throw new TypeError("Tailscale configured observation input is invalid.");
  }
  const profileResult = remoteComparisonKeySchema.safeParse(value.expected_profile_key);
  const serveResult = value.expected_serve === null ? null : remoteServeDescriptorSchema.safeParse(value.expected_serve);
  if (!profileResult.success || (serveResult !== null && !serveResult.success)) {
    throw new TypeError("Tailscale configured observation input is invalid.");
  }
  const expectedServe = serveResult === null ? null : deepFreeze(serveResult.data);
  return Object.freeze({
    kind: "configured",
    key: `configured:${profileResult.data}:${JSON.stringify(expectedServe)}`,
    expected_profile_key: profileResult.data,
    expected_serve: expectedServe
  });
}

function candidateExpectation(): CandidateExpectation {
  return Object.freeze({
    kind: "candidate",
    key: "candidate",
    expected_profile_key: null,
    expected_serve: null
  });
}

function parseStatus(output: string): RawStatus {
  const parsed = parseJson(output);
  const result = rawStatusSchema.safeParse(parsed);
  if (!result.success) throw new HostDeckTailscaleReadCommandError("schema_invalid");
  return result.data;
}

function parseSelectedProfile(output: string, maxProfiles: number): SelectedRawProfile {
  const parsed = parseJson(output);
  const result = rawProfilesSchema.safeParse(parsed);
  if (!result.success) throw new HostDeckTailscaleReadCommandError("schema_invalid");
  if (result.data.length > maxProfiles) {
    throw new HostDeckTailscaleReadCommandError("output_oversized");
  }
  const keyed = result.data.map((raw) => ({ raw, comparison_key: profileComparisonKey(raw) }));
  if (new Set(keyed.map((profile) => profile.comparison_key)).size !== keyed.length) {
    throw new HostDeckTailscaleReadCommandError("schema_invalid");
  }
  const selected = keyed.filter((profile) => profile.raw.selected);
  if (selected.length !== 1) throw new HostDeckTailscaleReadCommandError("schema_invalid");
  return selected[0] as SelectedRawProfile;
}

function parseServeStatus(output: string): RawServeStatus {
  const parsed = parseJson(output);
  const result = rawServeStatusSchema.safeParse(parsed);
  if (!result.success) throw new HostDeckTailscaleReadCommandError("schema_invalid");
  return result.data;
}

function parseJson(output: string): unknown {
  try {
    return JSON.parse(output) as unknown;
  } catch {
    throw new HostDeckTailscaleReadCommandError("schema_invalid");
  }
}

function profileComparisonKey(profile: RawProfile): string {
  const identity = JSON.stringify(["hostdeck-tailscale-profile-v1", profile.id, profile.account, profile.tailnet]);
  return `sha256:${createHash("sha256").update(identity, "utf8").digest("hex")}`;
}

function assertStatusProfileAgreement(status: RawStatus, profile: RawProfile): void {
  const tailnet = status.CurrentTailnet;
  const selfUserId = status.Self.UserID;
  const user =
    status.User !== null && typeof selfUserId === "number" && Number.isSafeInteger(selfUserId)
      ? plainRecord(status.User[String(selfUserId)])
      : null;
  if (status.BackendState === "Stopped" && tailnet === null && status.User === null) return;
  if (
    tailnet === null ||
    tailnet.Name !== profile.tailnet ||
    tailnet.MagicDNSSuffix !== status.MagicDNSSuffix ||
    user === null ||
    user.LoginName !== profile.account
  ) {
    throw new HostDeckTailscaleReadCommandError("schema_invalid");
  }
}

function sameObservationIdentity(
  statusBefore: RawStatus,
  profileBefore: SelectedRawProfile,
  statusAfter: RawStatus,
  profileAfter: SelectedRawProfile
): boolean {
  return (
    statusBefore.BackendState === statusAfter.BackendState &&
    statusBefore.Version === statusAfter.Version &&
    statusBefore.MagicDNSSuffix === statusAfter.MagicDNSSuffix &&
    isDeepStrictEqual(statusBefore.CertDomains, statusAfter.CertDomains) &&
    profileBefore.comparison_key === profileAfter.comparison_key
  );
}

function deriveExternalOrigin(
  status: RawStatus,
  serve: RawServeStatus,
  expected: RemoteServeDescriptor | null
): string | null {
  let statusOrigin: string | null = null;
  if (status.CertDomains !== null && status.CertDomains.length > 0) {
    if (status.CertDomains.length !== 1) throw new HostDeckTailscaleReadCommandError("schema_invalid");
    const domain = status.CertDomains[0] as string;
    if (!domain.endsWith(`.${status.MagicDNSSuffix}`)) {
      throw new HostDeckTailscaleReadCommandError("schema_invalid");
    }
    const result = remoteExternalOriginSchema.safeParse(`https://${domain}`);
    if (!result.success) throw new HostDeckTailscaleReadCommandError("schema_invalid");
    statusOrigin = result.data;
  }

  if (expected === null) return statusOrigin;
  const expectedAuthority = `${new URL(expected.external_origin).hostname}:443`;
  const serveOrigin = Object.hasOwn(serve.Web ?? {}, expectedAuthority) ? expected.external_origin : null;
  if (statusOrigin !== null && serveOrigin !== null && statusOrigin !== serveOrigin) {
    throw new HostDeckTailscaleReadCommandError("schema_invalid");
  }
  return statusOrigin ?? serveOrigin;
}

function classifyServe(
  serve: RawServeStatus,
  expected: RemoteServeDescriptor | null,
  externalOrigin: string | null
): RemoteIngressObservationSnapshot["serve"] {
  if (Object.hasOwn(serve, "AllowFunnel")) return "public";
  if (!hasServeConfiguration(serve)) return "absent";
  if (expected === null) return "foreign";

  const expectedAuthority = `${new URL(expected.external_origin).hostname}:443`;
  const expectedRaw = {
    TCP: { "443": { HTTPS: true } },
    Web: {
      [expectedAuthority]: {
        Handlers: { "/": { Proxy: expected.proxy_origin } }
      }
    }
  };
  if (externalOrigin === expected.external_origin && isDeepStrictEqual(serve, expectedRaw)) return "exact";

  const tcp443 = plainRecord(serve.TCP?.["443"]);
  const authority = plainRecord(serve.Web?.[expectedAuthority]);
  const handlers = plainRecord(authority?.Handlers);
  const root = plainRecord(handlers?.["/"]);
  const exactRoot = tcp443?.HTTPS === true && root?.Proxy === expected.proxy_origin;
  if (exactRoot) {
    return externalOrigin === expected.external_origin ? "colliding" : "drifted";
  }
  if (tcp443 !== null || authority !== null) return "drifted";
  return "foreign";
}

function hasServeConfiguration(serve: RawServeStatus): boolean {
  return (
    (serve.TCP !== undefined && Object.keys(serve.TCP).length > 0) ||
    (serve.Web !== undefined && Object.keys(serve.Web).length > 0) ||
    Object.hasOwn(serve, "AllowFunnel")
  );
}

function failureSnapshot(
  failure: ObservationFailure,
  expectation: ObservationExpectation,
  now: () => Date
): RemoteIngressObservationSnapshot {
  const expected = expectation.expected_profile_key;
  if (failure === "not_installed") {
    return snapshot({
      schema_version: 1,
      client: "not_installed",
      profile: remoteProfile(
        "absent",
        expected === null ? "unconfigured" : "missing",
        expected,
        null
      ),
      serve: null,
      external_origin: null,
      failure: null,
      observed_at: observedAt(now)
    });
  }
  if (failure === "unsupported") {
    return snapshot({
      schema_version: 1,
      client: "unsupported",
      profile: unknownProfile("unknown", expected),
      serve: null,
      external_origin: null,
      failure: null,
      observed_at: observedAt(now)
    });
  }
  if (failure === "profile_changed") {
    return snapshot({
      schema_version: 1,
      client: "available",
      profile: unknownProfile("unknown", expected),
      serve: null,
      external_origin: null,
      failure,
      observed_at: observedAt(now)
    });
  }
  return snapshot({
    schema_version: 1,
    client: "error",
    profile: unknownProfile("unknown", expected),
    serve: null,
    external_origin: null,
    failure,
    observed_at: observedAt(now)
  });
}

function remoteProfile(
  state: RemoteProfileObservation["state"],
  relation: RemoteProfileObservation["comparison"]["relation"],
  expected: string | null,
  active: string | null
): RemoteProfileObservation {
  return {
    state,
    comparison: {
      relation,
      expected_profile_key: expected,
      active_profile_key: active
    }
  };
}

function unknownProfile(
  state: "signed_out" | "unknown",
  expected: string | null
): RemoteProfileObservation {
  return remoteProfile(state, "unknown", expected, null);
}

function snapshot(input: unknown): RemoteIngressObservationSnapshot {
  const result = remoteIngressObservationSnapshotSchema.safeParse(input);
  if (!result.success) throw new HostDeckTailscaleReadCommandError("schema_invalid");
  return deepFreeze(result.data);
}

function observedAt(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("Tailscale observer wall clock is invalid.");
  }
  return value.toISOString();
}

function readMonotonicClock(monotonicNow: () => number): number {
  const value = monotonicNow();
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError("Tailscale observer monotonic clock is invalid.");
  }
  return value;
}

function readCommandFailure(error: unknown): ObservationFailure | "aborted" {
  if (!(error instanceof HostDeckTailscaleReadCommandError)) throw error;
  return error.code;
}

function assertAbortSignal(signal: unknown): asserts signal is AbortSignal {
  if (
    signal === null ||
    typeof signal !== "object" ||
    typeof (signal as AbortSignal).aborted !== "boolean" ||
    typeof (signal as AbortSignal).addEventListener !== "function" ||
    typeof (signal as AbortSignal).removeEventListener !== "function"
  ) {
    throw new TypeError("Tailscale observer requires one AbortSignal.");
  }
}

function readExactObject<const Key extends string>(
  input: unknown,
  expectedKeys: readonly Key[]
): Readonly<Record<Key, unknown>> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Expected one exact data object.");
  }
  try {
    const prototype = Object.getPrototypeOf(input) as unknown;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.length !== expectedKeys.length ||
      expectedKeys.some((key) => !Object.hasOwn(descriptors, key))
    ) {
      throw new TypeError("Expected one exact data object.");
    }
    const output = Object.create(null) as Record<Key, unknown>;
    for (const key of keys) {
      const descriptor = descriptors[key as keyof typeof descriptors];
      if (typeof key !== "string" || descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError("Expected one exact data object.");
      }
      output[key as Key] = descriptor.value;
    }
    return output;
  } catch (error) {
    if (error instanceof TypeError && error.message === "Expected one exact data object.") throw error;
    throw new TypeError("Expected one exact data object.");
  }
}

function plainRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function commandErrorMessage(code: TailscaleReadCommandErrorCode): string {
  switch (code) {
    case "not_installed":
      return "The supported Tailscale client is not installed.";
    case "aborted":
      return "The Tailscale read was cancelled.";
    case "command_failed":
      return "A bounded Tailscale read failed.";
    case "command_timeout":
      return "A bounded Tailscale read timed out.";
    case "output_oversized":
      return "Tailscale read output exceeded its configured bound.";
    case "schema_invalid":
      return "Tailscale read output did not match the supported schema.";
  }
}
