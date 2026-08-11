import { spawn } from "node:child_process";
import {
  type BigIntStats,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync
} from "node:fs";
import { posix, win32 } from "node:path";
import {
  type HostPlatformCapability,
  hostDeckLoopbackOriginSchema,
  parseHostPlatformCapability,
  resolveHostPlatformCapability,
  type SupportedHostTarget
} from "@hostdeck/contracts";

export const tailscalePlatformCommandNames = Object.freeze([
  "version",
  "status",
  "profile_list",
  "serve_status",
  "funnel_status",
  "enable",
  "disable"
] as const);
export type TailscalePlatformCommandName = (typeof tailscalePlatformCommandNames)[number];

export const tailscalePlatformCommandCompletions = Object.freeze([
  "succeeded",
  "not_installed",
  "executable_invalid",
  "aborted",
  "command_failed",
  "command_timeout",
  "output_oversized",
  "output_invalid"
] as const);
export type TailscalePlatformCommandCompletion =
  (typeof tailscalePlatformCommandCompletions)[number];

export interface TailscalePlatformCommandRequest {
  readonly command: TailscalePlatformCommandName;
  readonly proxy_origin: string | null;
  readonly timeout_ms: number;
  readonly output_max_bytes: number;
  readonly signal: AbortSignal;
}

export interface TailscalePlatformCommandResult {
  readonly completion: TailscalePlatformCommandCompletion;
  readonly stdout: string;
  readonly consent_required: boolean;
  readonly permission_denied: boolean;
}

export interface TailscalePlatformCommandAdapter {
  readonly target: SupportedHostTarget;
  readonly run: (
    request: TailscalePlatformCommandRequest
  ) => Promise<TailscalePlatformCommandResult>;
}

export type TailscaleExecutableInspection =
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "invalid" }>
  | Readonly<{
      status: "present";
      canonical_path: string;
      is_file: boolean;
      is_symbolic_link: boolean;
      identity_stable: boolean;
      size_bytes: number;
      link_count: number;
      owner_uid: number | null;
      mode: number | null;
      header: Uint8Array;
    }>;

export interface TailscaleExecutableDiscoveryPort {
  readonly inspect: (
    candidate: string,
    target: SupportedHostTarget
  ) => TailscaleExecutableInspection;
}

export interface TailscaleNativeProcessRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeout_ms: number;
  readonly output_max_bytes: number;
  readonly signal: AbortSignal;
  readonly retain_stdout: boolean;
  readonly scan_mutation_markers: boolean;
}

export interface TailscaleNativeProcessResult {
  readonly completion: Exclude<TailscalePlatformCommandCompletion, "executable_invalid">;
  readonly stdout: string;
  readonly consent_required: boolean;
  readonly permission_denied: boolean;
}

export interface TailscaleNativeProcessPort {
  readonly run: (request: TailscaleNativeProcessRequest) => Promise<unknown>;
}

export type TailscaleExecutableDiscoveryResult =
  | Readonly<{ status: "not_installed"; target: SupportedHostTarget }>
  | Readonly<{ status: "invalid"; target: SupportedHostTarget }>
  | Readonly<{
      status: "available";
      target: SupportedHostTarget;
      executable: string;
      cwd: string;
      environment: Readonly<Record<string, string>>;
    }>;

export interface CreateTailscalePlatformCommandAdapterOptions {
  readonly capability: HostPlatformCapability;
  readonly discovery: TailscaleExecutableDiscoveryPort;
  readonly process: TailscaleNativeProcessPort;
}

interface TailscaleTargetProfile {
  readonly executable: string;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}

const maximumCommandTimeoutMs = 30_000;
const maximumOutputBytes = 8_388_608;
const maximumBinaryBytes = 268_435_456;
const minimumBinaryBytes = 4_096;
const executableHeaderBytes = 4_096;
const maximumPathBytes = 1_024;
const maximumArgumentBytes = 2_048;
const maximumEnvironmentValueBytes = 4_096;
const maximumArguments = 8;
const maximumEnvironmentEntries = 16;
const maxMarkerTailLength = 512;

const permissionMarkers = Object.freeze([
  "access denied:",
  "permission denied",
  "serve config denied",
  "must be root, or be an operator"
] as const);
const consentMarkers = Object.freeze(["https://login.tailscale.com/"] as const);

const targetProfiles: Readonly<Record<SupportedHostTarget, TailscaleTargetProfile>> =
  Object.freeze({
    "linux-x64": Object.freeze({
      executable: "/usr/bin/tailscale",
      cwd: "/",
      environment: Object.freeze({
        LANG: "C",
        LC_ALL: "C",
        PATH: "/usr/bin:/bin",
        TERM: "dumb"
      })
    }),
    "windows-x64": Object.freeze({
      executable: "C:\\Program Files\\Tailscale\\tailscale.exe",
      cwd: "C:\\",
      environment: Object.freeze({
        LANG: "C",
        LC_ALL: "C",
        PATH: "C:\\Program Files\\Tailscale;C:\\Windows\\System32",
        SystemRoot: "C:\\Windows",
        TERM: "dumb",
        WINDIR: "C:\\Windows"
      })
    })
  });

const commandArguments: Readonly<
  Record<Exclude<TailscalePlatformCommandName, "enable">, readonly string[]>
> = Object.freeze({
  version: Object.freeze(["version"]),
  status: Object.freeze(["status", "--json"]),
  profile_list: Object.freeze(["switch", "--list", "--json"]),
  serve_status: Object.freeze(["serve", "status", "--json"]),
  funnel_status: Object.freeze(["funnel", "status", "--json"]),
  disable: Object.freeze(["serve", "--https=443", "--set-path=/", "off"])
});

const adapterOptionKeys = ["capability", "discovery", "process"] as const;
const platformRequestKeys = [
  "command",
  "proxy_origin",
  "timeout_ms",
  "output_max_bytes",
  "signal"
] as const;
const processResultKeys = [
  "completion",
  "stdout",
  "consent_required",
  "permission_denied"
] as const;
const missingInspectionKeys = ["status"] as const;
const presentInspectionKeys = [
  "status",
  "canonical_path",
  "is_file",
  "is_symbolic_link",
  "identity_stable",
  "size_bytes",
  "link_count",
  "owner_uid",
  "mode",
  "header"
] as const;

export function createNativeTailscalePlatformCommandAdapter(): TailscalePlatformCommandAdapter {
  return createTailscalePlatformCommandAdapter({
    capability: resolveHostPlatformCapability({
      platform: process.platform,
      architecture: process.arch,
      node_version: process.versions.node,
      node_abi: process.versions.modules ?? ""
    }),
    discovery: nativeTailscaleExecutableDiscoveryPort,
    process: nativeTailscaleProcessPort
  });
}

export function createTailscalePlatformCommandAdapter(
  rawOptions: CreateTailscalePlatformCommandAdapterOptions
): TailscalePlatformCommandAdapter {
  const options = readExactDataObject(rawOptions, adapterOptionKeys);
  const capability = parseHostPlatformCapability(options.capability);
  const discovery = parseDiscoveryPort(options.discovery);
  const processPort = parseProcessPort(options.process);

  return Object.freeze({
    target: capability.target,
    async run(rawRequest: TailscalePlatformCommandRequest) {
      const request = parsePlatformCommandRequest(rawRequest);
      if (request.signal.aborted) return commandResult("aborted");

      const discovered = discoverTailscaleExecutable(capability, discovery);
      if (discovered.status !== "available") {
        return commandResult(
          discovered.status === "not_installed" ? "not_installed" : "executable_invalid"
        );
      }
      if (request.signal.aborted) return commandResult("aborted");

      const mutation = request.command === "enable" || request.command === "disable";
      const processRequest: TailscaleNativeProcessRequest = Object.freeze({
        executable: discovered.executable,
        args: argumentsFor(request),
        cwd: discovered.cwd,
        environment: discovered.environment,
        timeout_ms: request.timeout_ms,
        output_max_bytes: request.output_max_bytes,
        signal: request.signal,
        retain_stdout: !mutation,
        scan_mutation_markers: mutation
      });

      let rawResult: unknown;
      try {
        rawResult = await processPort.run(processRequest);
      } catch {
        return commandResult(request.signal.aborted ? "aborted" : "command_failed");
      }
      if (request.signal.aborted) return commandResult("aborted");
      return parseProcessResult(rawResult, request, mutation);
    }
  });
}

export function discoverTailscaleExecutable(
  rawCapability: HostPlatformCapability,
  rawPort: TailscaleExecutableDiscoveryPort
): TailscaleExecutableDiscoveryResult {
  const capability = parseHostPlatformCapability(rawCapability);
  const port = parseDiscoveryPort(rawPort);
  const profile = targetProfiles[capability.target];

  let rawInspection: unknown;
  try {
    rawInspection = port.inspect(profile.executable, capability.target);
  } catch {
    return Object.freeze({ status: "invalid", target: capability.target });
  }
  const inspection = parseInspection(rawInspection);
  if (inspection === null || inspection.status === "invalid") {
    return Object.freeze({ status: "invalid", target: capability.target });
  }
  if (inspection.status === "missing") {
    return Object.freeze({ status: "not_installed", target: capability.target });
  }
  if (!isValidExecutableInspection(capability.target, profile.executable, inspection)) {
    return Object.freeze({ status: "invalid", target: capability.target });
  }

  return Object.freeze({
    status: "available",
    target: capability.target,
    executable: profile.executable,
    cwd: profile.cwd,
    environment: profile.environment
  });
}

export const nativeTailscaleExecutableDiscoveryPort: TailscaleExecutableDiscoveryPort =
  Object.freeze({
    inspect(candidate: string, target: SupportedHostTarget): TailscaleExecutableInspection {
      const nativeTarget = currentNativeTarget();
      if (nativeTarget === null || nativeTarget !== target) {
        return Object.freeze({ status: "invalid" });
      }

      let before: BigIntStats;
      try {
        before = lstatSync(candidate, { bigint: true });
      } catch (error) {
        return Object.freeze({ status: isMissingPathError(error) ? "missing" : "invalid" });
      }

      try {
        const canonicalPath = realpathSync.native(candidate);
        if (before.isSymbolicLink() || !before.isFile()) {
          return inspectionFromMetadata(target, canonicalPath, before, new Uint8Array(), true);
        }

        let descriptor: number | null = null;
        try {
          const flags =
            fsConstants.O_RDONLY |
            (target === "linux-x64" ? fsConstants.O_NOFOLLOW : 0);
          descriptor = openSync(candidate, flags);
          const opened = fstatSync(descriptor, { bigint: true });
          const header = Buffer.alloc(executableHeaderBytes);
          const bytesRead = readSync(descriptor, header, 0, executableHeaderBytes, 0);
          const after = lstatSync(candidate, { bigint: true });
          return inspectionFromMetadata(
            target,
            canonicalPath,
            after,
            Uint8Array.from(header.subarray(0, bytesRead)),
            sameNativeFile(before, opened) && sameNativeFile(opened, after)
          );
        } finally {
          if (descriptor !== null) closeSync(descriptor);
        }
      } catch {
        return Object.freeze({ status: "invalid" });
      }
    }
  });

export const nativeTailscaleProcessPort: TailscaleNativeProcessPort = Object.freeze({
  run: runNativeTailscaleProcess
});

export function runNativeTailscaleProcess(
  request: TailscaleNativeProcessRequest
): Promise<TailscaleNativeProcessResult> {
  assertNativeProcessRequest(request);
  return new Promise((resolve) => {
    if (request.signal.aborted) {
      resolve(nativeProcessResult("aborted"));
      return;
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(request.executable, [...request.args], {
        cwd: request.cwd,
        env: request.environment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch {
      resolve(nativeProcessResult("command_failed"));
      return;
    }

    const stdout: Buffer[] = [];
    const markerTails = { stdout: "", stderr: "" };
    let observedBytes = 0;
    let consentRequired = false;
    let permissionDenied = false;
    let pendingCompletion: TailscaleNativeProcessResult["completion"] | null = null;
    let settled = false;
    const timer = setTimeout(() => stop("command_timeout"), request.timeout_ms);
    timer.unref();
    const onAbort = () => stop("aborted");
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) onAbort();

    child.once("error", (error: NodeJS.ErrnoException) => {
      pendingCompletion ??=
        error.code === "ENOENT"
          ? "not_installed"
          : request.signal.aborted
            ? "aborted"
            : "command_failed";
    });
    child.once("close", (code) => {
      cleanup();
      const completion = pendingCompletion ?? (code === 0 ? "succeeded" : "command_failed");
      if (completion !== "succeeded") {
        settle(nativeProcessResult(completion, consentRequired, permissionDenied));
        return;
      }
      if (!request.retain_stdout) {
        settle(nativeProcessResult("succeeded", consentRequired, permissionDenied));
        return;
      }
      try {
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stdout));
        settle(nativeProcessResult("succeeded", false, false, decoded));
      } catch {
        settle(nativeProcessResult("output_invalid"));
      }
    });

    if (child.stdout === null || child.stderr === null) {
      stop("command_failed");
    } else {
      child.stdout.on("data", (chunk: Buffer) => capture(chunk, "stdout"));
      child.stderr.on("data", (chunk: Buffer) => capture(chunk, "stderr"));
    }

    function capture(chunk: Buffer, source: "stdout" | "stderr"): void {
      if (pendingCompletion !== null) return;
      observedBytes += chunk.byteLength;
      if (observedBytes > request.output_max_bytes) {
        stop("output_oversized");
        return;
      }
      if (request.retain_stdout && source === "stdout") stdout.push(Buffer.from(chunk));
      if (request.scan_mutation_markers) {
        const scan = `${markerTails[source]}${chunk.toString("latin1")}`.toLowerCase();
        consentRequired ||= consentMarkers.some((marker) => scan.includes(marker));
        permissionDenied ||= permissionMarkers.some((marker) => scan.includes(marker));
        markerTails[source] = scan.slice(-maxMarkerTailLength);
      }
    }

    function stop(completion: TailscaleNativeProcessResult["completion"]): void {
      if (settled || pendingCompletion !== null) return;
      pendingCompletion = completion;
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          pendingCompletion = request.signal.aborted ? "aborted" : "command_failed";
        }
      }
    }

    function cleanup(): void {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
      markerTails.stdout = "";
      markerTails.stderr = "";
    }

    function settle(result: TailscaleNativeProcessResult): void {
      if (settled) return;
      settled = true;
      resolve(result);
    }
  });
}

function parsePlatformCommandRequest(raw: unknown): TailscalePlatformCommandRequest {
  let value: Readonly<Record<(typeof platformRequestKeys)[number], unknown>>;
  try {
    value = readExactDataObject(raw, platformRequestKeys);
  } catch {
    throw new TypeError("Tailscale platform command request is invalid.");
  }
  if (
    typeof value.command !== "string" ||
    !tailscalePlatformCommandNames.includes(value.command as TailscalePlatformCommandName) ||
    !Number.isSafeInteger(value.timeout_ms) ||
    (value.timeout_ms as number) < 1 ||
    (value.timeout_ms as number) > maximumCommandTimeoutMs ||
    !Number.isSafeInteger(value.output_max_bytes) ||
    (value.output_max_bytes as number) < 1 ||
    (value.output_max_bytes as number) > maximumOutputBytes
  ) {
    throw new TypeError("Tailscale platform command request is invalid.");
  }
  assertAbortSignal(value.signal);
  const command = value.command as TailscalePlatformCommandName;
  const validProxy =
    command === "enable"
      ? hostDeckLoopbackOriginSchema.safeParse(value.proxy_origin).success
      : value.proxy_origin === null;
  if (!validProxy) throw new TypeError("Tailscale platform command request is invalid.");
  return Object.freeze({
    command,
    proxy_origin: value.proxy_origin as string | null,
    timeout_ms: value.timeout_ms as number,
    output_max_bytes: value.output_max_bytes as number,
    signal: value.signal
  });
}

function argumentsFor(request: TailscalePlatformCommandRequest): readonly string[] {
  if (request.command === "enable") {
    if (request.proxy_origin === null) throw new TypeError("Tailscale platform command request is invalid.");
    return Object.freeze(["serve", "--bg", request.proxy_origin]);
  }
  return commandArguments[request.command];
}

function parseProcessResult(
  raw: unknown,
  request: TailscalePlatformCommandRequest,
  mutation: boolean
): TailscalePlatformCommandResult {
  let value: Readonly<Record<(typeof processResultKeys)[number], unknown>>;
  try {
    value = readExactDataObject(raw, processResultKeys);
  } catch {
    return commandResult("output_invalid");
  }
  if (
    typeof value.completion !== "string" ||
    !tailscalePlatformCommandCompletions.includes(
      value.completion as TailscalePlatformCommandCompletion
    ) ||
    value.completion === "executable_invalid" ||
    typeof value.stdout !== "string" ||
    typeof value.consent_required !== "boolean" ||
    typeof value.permission_denied !== "boolean" ||
    Buffer.from(value.stdout, "utf8").toString("utf8") !== value.stdout
  ) {
    return commandResult("output_invalid");
  }
  if (Buffer.byteLength(value.stdout, "utf8") > request.output_max_bytes) {
    return commandResult("output_oversized");
  }
  if (
    (mutation && value.stdout !== "") ||
    (!mutation && (value.consent_required || value.permission_denied)) ||
    (value.completion !== "succeeded" && value.stdout !== "")
  ) {
    return commandResult("output_invalid");
  }
  return commandResult(
    value.completion as TailscalePlatformCommandCompletion,
    value.consent_required,
    value.permission_denied,
    value.stdout
  );
}

function parseInspection(raw: unknown): TailscaleExecutableInspection | null {
  let status: unknown;
  try {
    const descriptor = readAllowedDataObject(raw, presentInspectionKeys, ["status"]);
    status = descriptor.status;
    if (status === "missing" || status === "invalid") {
      const exact = readExactDataObject(raw, missingInspectionKeys);
      return Object.freeze({ status: exact.status as "missing" | "invalid" });
    }
    if (status !== "present") return null;
    const value = readExactDataObject(raw, presentInspectionKeys);
    if (
      typeof value.canonical_path !== "string" ||
      typeof value.is_file !== "boolean" ||
      typeof value.is_symbolic_link !== "boolean" ||
      typeof value.identity_stable !== "boolean" ||
      !Number.isSafeInteger(value.size_bytes) ||
      !Number.isSafeInteger(value.link_count) ||
      (value.owner_uid !== null && !Number.isSafeInteger(value.owner_uid)) ||
      (value.mode !== null && !Number.isSafeInteger(value.mode)) ||
      !(value.header instanceof Uint8Array)
    ) {
      return null;
    }
    return {
      status: "present",
      canonical_path: value.canonical_path,
      is_file: value.is_file,
      is_symbolic_link: value.is_symbolic_link,
      identity_stable: value.identity_stable,
      size_bytes: value.size_bytes as number,
      link_count: value.link_count as number,
      owner_uid: value.owner_uid as number | null,
      mode: value.mode as number | null,
      header: Uint8Array.from(value.header)
    };
  } catch {
    return null;
  }
}

function isValidExecutableInspection(
  target: SupportedHostTarget,
  candidate: string,
  inspection: Extract<TailscaleExecutableInspection, { status: "present" }>
): boolean {
  if (
    !validPath(inspection.canonical_path) ||
    !canonicalPathMatches(target, candidate, inspection.canonical_path) ||
    !inspection.is_file ||
    inspection.is_symbolic_link ||
    !inspection.identity_stable ||
    inspection.size_bytes < minimumBinaryBytes ||
    inspection.size_bytes > maximumBinaryBytes ||
    inspection.link_count !== 1 ||
    inspection.header.byteLength !== Math.min(inspection.size_bytes, executableHeaderBytes)
  ) {
    return false;
  }

  if (target === "linux-x64") {
    return (
      inspection.owner_uid === 0 &&
      inspection.mode !== null &&
      (inspection.mode & 0o111) !== 0 &&
      (inspection.mode & 0o7022) === 0 &&
      isLinuxX64Elf(inspection.header)
    );
  }
  return (
    inspection.owner_uid === null &&
    inspection.mode === null &&
    isWindowsX64Pe(inspection.header)
  );
}

function isLinuxX64Elf(header: Uint8Array): boolean {
  if (
    header.byteLength < 20 ||
    header[0] !== 0x7f ||
    header[1] !== 0x45 ||
    header[2] !== 0x4c ||
    header[3] !== 0x46 ||
    header[4] !== 2 ||
    header[5] !== 1 ||
    header[6] !== 1
  ) {
    return false;
  }
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const type = view.getUint16(16, true);
  return (type === 2 || type === 3) && view.getUint16(18, true) === 0x3e;
}

function isWindowsX64Pe(header: Uint8Array): boolean {
  if (header.byteLength < 64 || header[0] !== 0x4d || header[1] !== 0x5a) return false;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const peOffset = view.getUint32(0x3c, true);
  if (peOffset > header.byteLength - 26) return false;
  return (
    header[peOffset] === 0x50 &&
    header[peOffset + 1] === 0x45 &&
    header[peOffset + 2] === 0 &&
    header[peOffset + 3] === 0 &&
    view.getUint16(peOffset + 4, true) === 0x8664 &&
    view.getUint16(peOffset + 24, true) === 0x20b
  );
}

function inspectionFromMetadata(
  target: SupportedHostTarget,
  canonicalPath: string,
  metadata: BigIntStats,
  header: Uint8Array,
  identityStable: boolean
): TailscaleExecutableInspection {
  const size = safeBigIntNumber(metadata.size);
  const links = safeBigIntNumber(metadata.nlink);
  const uid = safeBigIntNumber(metadata.uid);
  const mode = safeBigIntNumber(metadata.mode);
  if (size === null || links === null || uid === null || mode === null) {
    return Object.freeze({ status: "invalid" });
  }
  return {
    status: "present",
    canonical_path: canonicalPath,
    is_file: metadata.isFile(),
    is_symbolic_link: metadata.isSymbolicLink(),
    identity_stable: identityStable,
    size_bytes: size,
    link_count: links,
    owner_uid: target === "linux-x64" ? uid : null,
    mode: target === "linux-x64" ? mode : null,
    header
  };
}

function sameNativeFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.nlink === right.nlink &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.isFile() === right.isFile() &&
    left.isSymbolicLink() === right.isSymbolicLink()
  );
}

function safeBigIntNumber(value: bigint): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function currentNativeTarget(): SupportedHostTarget | null {
  if (process.arch !== "x64") return null;
  if (process.platform === "linux") return "linux-x64";
  if (process.platform === "win32") return "windows-x64";
  return null;
}

function canonicalPathMatches(
  target: SupportedHostTarget,
  expected: string,
  actual: string
): boolean {
  if (target === "windows-x64") {
    const expectedPath = normalizedWindowsDrivePath(expected);
    const actualPath = normalizedWindowsDrivePath(actual);
    return expectedPath !== null && actualPath === expectedPath;
  }
  return posix.normalize(actual) === expected;
}

function normalizedWindowsDrivePath(value: string): string | null {
  const withoutNativePrefix = value.startsWith("\\\\?\\") ? value.slice(4) : value;
  if (!/^[A-Za-z]:[\\/]/u.test(withoutNativePrefix)) return null;
  const normalized = win32.normalize(withoutNativePrefix);
  return /^[A-Za-z]:\\/u.test(normalized) ? normalized.toLowerCase() : null;
}

function validPath(value: string): boolean {
  return (
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximumPathBytes &&
    !/[\0\r\n]/u.test(value) &&
    (posix.isAbsolute(value) || win32.isAbsolute(value))
  );
}

function assertNativeProcessRequest(request: TailscaleNativeProcessRequest): void {
  if (
    request === null ||
    typeof request !== "object" ||
    !validPath(request.executable) ||
    !validPath(request.cwd) ||
    !Array.isArray(request.args) ||
    request.args.length < 1 ||
    request.args.length > maximumArguments ||
    request.args.some(
      (argument) =>
        typeof argument !== "string" ||
        argument.length < 1 ||
        Buffer.byteLength(argument, "utf8") > maximumArgumentBytes ||
        /[\0\r\n]/u.test(argument)
    ) ||
    !validEnvironment(request.environment) ||
    !Number.isSafeInteger(request.timeout_ms) ||
    request.timeout_ms < 1 ||
    request.timeout_ms > maximumCommandTimeoutMs ||
    !Number.isSafeInteger(request.output_max_bytes) ||
    request.output_max_bytes < 1 ||
    request.output_max_bytes > maximumOutputBytes ||
    typeof request.retain_stdout !== "boolean" ||
    typeof request.scan_mutation_markers !== "boolean" ||
    request.retain_stdout === request.scan_mutation_markers
  ) {
    throw new TypeError("Tailscale native process request is invalid.");
  }
  assertAbortSignal(request.signal);
}

function validEnvironment(value: unknown): value is Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value) as unknown;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.length > maximumEnvironmentEntries
    ) {
      return false;
    }
    return keys.every((key) => {
      if (typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) return false;
      const descriptor = descriptors[key];
      return (
        descriptor?.enumerable === true &&
        "value" in descriptor &&
        typeof descriptor.value === "string" &&
        Buffer.byteLength(descriptor.value, "utf8") <= maximumEnvironmentValueBytes &&
        !/[\0\r\n]/u.test(descriptor.value)
      );
    });
  } catch {
    return false;
  }
}

function nativeProcessResult(
  completion: TailscaleNativeProcessResult["completion"],
  consentRequired = false,
  permissionDenied = false,
  stdout = ""
): TailscaleNativeProcessResult {
  return Object.freeze({
    completion,
    stdout,
    consent_required: consentRequired,
    permission_denied: permissionDenied
  });
}

function commandResult(
  completion: TailscalePlatformCommandCompletion,
  consentRequired = false,
  permissionDenied = false,
  stdout = ""
): TailscalePlatformCommandResult {
  return Object.freeze({
    completion,
    stdout,
    consent_required: consentRequired,
    permission_denied: permissionDenied
  });
}

function parseDiscoveryPort(value: unknown): TailscaleExecutableDiscoveryPort {
  const port = readExactDataObject(value, ["inspect"] as const);
  if (typeof port.inspect !== "function") {
    throw new TypeError("Tailscale executable discovery port is invalid.");
  }
  return Object.freeze({ inspect: port.inspect as TailscaleExecutableDiscoveryPort["inspect"] });
}

function parseProcessPort(value: unknown): TailscaleNativeProcessPort {
  const port = readExactDataObject(value, ["run"] as const);
  if (typeof port.run !== "function") {
    throw new TypeError("Tailscale native process port is invalid.");
  }
  return Object.freeze({ run: port.run as TailscaleNativeProcessPort["run"] });
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
      if (
        typeof key !== "string" ||
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
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
    throw new TypeError("Tailscale platform command requires one AbortSignal.");
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ENOTDIR")
  );
}
