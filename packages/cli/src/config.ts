import {
  accessSync,
  constants as fsConstants,
  lstatSync,
  readFileSync,
  realpathSync
} from "node:fs";
import { homedir } from "node:os";
import {
  delimiter,
  isAbsolute,
  join,
  normalize,
  posix,
  resolve,
  win32
} from "node:path";
import { hostDeckLoopbackOriginSchema } from "@hostdeck/contracts";
import {
  resolveNativeWindowsHostDeckDefaultPaths,
  resolveWindowsHostDeckDefaultPaths
} from "@hostdeck/storage";
import { configFailure, internalFailure } from "./errors.js";

export interface CliConfigFlags {
  readonly apiUrl?: string;
  readonly port?: string;
  readonly configPath?: string;
  readonly stateDir?: string;
  readonly databasePath?: string;
}

export interface CliConfig {
  readonly baseUrl: URL;
  readonly source: string;
  readonly configDir: string;
  readonly stateDir: string;
  readonly runtimeDir: string | null;
  readonly databasePath: string;
}

export interface LoadCliConfigOptions {
  readonly flags?: CliConfigFlags;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly readFile?: (path: string) => string;
  readonly platform?: NodeJS.Platform;
  readonly windowsUserRoots?: () => Readonly<{
    local_app_data: string;
    roaming_app_data: string;
  }>;
}

type RawConfigFile = {
  readonly api_url?: unknown;
  readonly apiUrl?: unknown;
  readonly port?: unknown;
  readonly state_dir?: unknown;
  readonly stateDir?: unknown;
  readonly database_path?: unknown;
  readonly databasePath?: unknown;
};

const defaultPort = 3777;
const defaultDatabaseFileName = "hostdeck.sqlite";
const rawConfigKeys = [
  "api_url",
  "apiUrl",
  "port",
  "state_dir",
  "stateDir",
  "database_path",
  "databasePath"
] as const;
const maximumExecutablePathBytes = 4_096;
const maximumPathEnvironmentBytes = 32_768;
const maximumPathEntries = 256;
const exactPackageVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const maximumPackageManifestBytes = 65_536;

type StoragePathApi = Pick<
  typeof posix,
  "isAbsolute" | "join" | "relative" | "resolve" | "sep"
>;
type WindowsDefaultPaths = ReturnType<
  typeof resolveWindowsHostDeckDefaultPaths
>;

export function loadCliConfig(options: LoadCliConfigOptions = {}): CliConfig {
  const flags = options.flags ?? {};
  const env = options.env ?? process.env;
  const platform = resolveStoragePlatform(options.platform ?? process.platform);
  const storagePathApi = platform === "win32" ? win32 : posix;
  const windowsDefaults =
    platform === "win32" ? resolveWindowsDefaults(options) : null;
  const configFile = loadConfigFile(flags.configPath, options);
  rejectRetiredHostConfiguration(flags, env);
  const envBaseUrl = readOriginString(
    env.HOSTDECK_API_BASE_URL,
    "HOSTDECK_API_BASE_URL"
  );
  const fileBaseUrl = readOriginString(
    configFile.api_url ?? configFile.apiUrl,
    "api_url"
  );
  const flagBaseUrl = readOriginString(flags.apiUrl, "--api-url");
  const baseUrl = flagBaseUrl ?? envBaseUrl ?? fileBaseUrl;
  const stateDir = resolveStoragePath(
    readString(flags.stateDir, "--state-dir") ??
      readString(env.HOSTDECK_STATE_DIR, "HOSTDECK_STATE_DIR") ??
      readString(configFile.state_dir ?? configFile.stateDir, "state_dir") ??
      defaultStateDir(env, platform, windowsDefaults),
    options.cwd,
    "state_dir",
    storagePathApi
  );
  if (platform === "win32") {
    assertWindowsStateInsideOwner(
      stateDir,
      requireWindowsDefaults(windowsDefaults).state_dir,
      storagePathApi
    );
  }
  const databasePath = resolveStoragePath(
    readString(flags.databasePath, "--database") ??
      readString(env.HOSTDECK_DATABASE_PATH, "HOSTDECK_DATABASE_PATH") ??
      readString(configFile.database_path ?? configFile.databasePath, "database_path") ??
      storagePathApi.join(stateDir, defaultDatabaseFileName),
    options.cwd,
    "database_path",
    storagePathApi
  );
  assertDatabaseInsideState(databasePath, stateDir, storagePathApi);
  const configDir = defaultConfigDir(env, platform, windowsDefaults);
  const runtimeDir = defaultRuntimeDir(env, platform, windowsDefaults);

  if (baseUrl !== undefined) {
    const source = sourceOf(
      ["--api-url", flagBaseUrl],
      ["HOSTDECK_API_BASE_URL", envBaseUrl],
      ["config api_url", fileBaseUrl]
    );
    return {
      baseUrl: parseBaseUrl(baseUrl, source),
      source,
      configDir,
      stateDir,
      runtimeDir,
      databasePath
    };
  }

  const portValue = flags.port ?? env.HOSTDECK_PORT ?? configFile.port ?? defaultPort;
  const port = parsePort(portValue, sourceOf(["--port", flags.port], ["HOSTDECK_PORT", env.HOSTDECK_PORT], ["config port", configFile.port], ["default", String(defaultPort)]));

  return {
    baseUrl: new URL(`http://127.0.0.1:${port}`),
    source: flags.configPath === undefined ? "defaults/env/flags" : resolveConfigPath(flags.configPath, options.cwd),
    configDir,
    stateDir,
    runtimeDir,
    databasePath
  };
}

export function resolveCanonicalRuntimePackageRoot(candidate: string): string {
  try {
    if (
      !isAbsolute(candidate) ||
      candidate === "/" ||
      normalize(candidate) !== candidate ||
      Buffer.byteLength(candidate, "utf8") > maximumExecutablePathBytes ||
      containsControl(candidate)
    ) {
      throw new TypeError();
    }
    const canonical = realpathSync.native(candidate);
    if (canonical !== candidate || !lstatSync(canonical).isDirectory()) {
      throw new TypeError();
    }
    return canonical;
  } catch {
    throw configFailure(
      "HostDeck runtime package root is unavailable or noncanonical.",
      "package_root"
    );
  }
}

export function loadRuntimePackageVersion(packageRoot: string): string {
  try {
    const manifestPath = join(
      resolveCanonicalRuntimePackageRoot(packageRoot),
      "package.json"
    );
    const stats = lstatSync(manifestPath);
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      stats.size < 1 ||
      stats.size > maximumPackageManifestBytes ||
      realpathSync.native(manifestPath) !== manifestPath
    ) {
      throw new TypeError();
    }
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.getPrototypeOf(parsed) !== Object.prototype
    ) {
      throw new TypeError();
    }
    const manifest = parsed as Record<string, unknown>;
    const bin = manifest.bin;
    if (
      manifest.name !== "@hostdeck/cli" ||
      typeof manifest.version !== "string" ||
      !exactPackageVersionPattern.test(manifest.version) ||
      bin === null ||
      typeof bin !== "object" ||
      Array.isArray(bin) ||
      Object.keys(bin).length !== 1 ||
      (bin as Record<string, unknown>).codexdeck !== "./bin/codexdeck"
    ) {
      throw new TypeError();
    }
    return manifest.version;
  } catch (error) {
    throw internalFailure(
      "HostDeck runtime package identity is invalid.",
      error
    );
  }
}

export function resolveHostDeckCodexExecutable(
  env: Readonly<Record<string, string | undefined>>
): string {
  const explicit = env.HOSTDECK_CODEX_BIN;
  if (explicit !== undefined) {
    const canonical = inspectExecutableCandidate(explicit);
    if (canonical === null) {
      throw configFailure(
        "HOSTDECK_CODEX_BIN must name one canonical absolute executable file.",
        "HOSTDECK_CODEX_BIN"
      );
    }
    return canonical;
  }

  const rawPath = env.PATH;
  if (
    typeof rawPath !== "string" ||
    rawPath.length === 0 ||
    Buffer.byteLength(rawPath, "utf8") > maximumPathEnvironmentBytes ||
    containsControl(rawPath)
  ) {
    throw configFailure(
      "PATH must contain bounded absolute entries to resolve Codex.",
      "PATH"
    );
  }
  const entries = rawPath.split(delimiter);
  if (
    entries.length < 1 ||
    entries.length > maximumPathEntries ||
    entries.some(
      (entry) =>
        !isAbsolute(entry) ||
        entry === "/" ||
        normalize(entry) !== entry ||
        Buffer.byteLength(entry, "utf8") > maximumExecutablePathBytes
    )
  ) {
    throw configFailure(
      "PATH must contain only bounded canonical absolute entries.",
      "PATH"
    );
  }
  for (const entry of entries) {
    const canonical = inspectExecutableCandidate(join(entry, "codex"));
    if (canonical !== null) return canonical;
  }
  throw configFailure("Codex executable was not found in PATH.", "PATH");
}

function loadConfigFile(configPath: string | undefined, options: LoadCliConfigOptions): RawConfigFile {
  if (configPath === undefined) {
    return {};
  }

  const path = resolveConfigPath(configPath, options.cwd);
  const readFile = options.readFile ?? ((target: string) => readFileSync(target, "utf8"));
  let raw: string;

  try {
    raw = readFile(path);
  } catch {
    throw configFailure("Unable to read HostDeck config file.", "--config");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw configFailure("HostDeck config file is not valid JSON.", "--config");
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw configFailure("HostDeck config file must be a JSON object.", "--config");
  }

  const record = parsed as Record<string, unknown>;
  const unknownKey = Object.keys(record).find(
    (key) => !rawConfigKeys.includes(key as (typeof rawConfigKeys)[number])
  );
  if (unknownKey !== undefined) {
    throw configFailure(
      `HostDeck config file contains unsupported field ${unknownKey}.`,
      "--config"
    );
  }
  for (const [snakeCase, camelCase] of [
    ["api_url", "apiUrl"],
    ["state_dir", "stateDir"],
    ["database_path", "databasePath"]
  ] as const) {
    if (Object.hasOwn(record, snakeCase) && Object.hasOwn(record, camelCase)) {
      throw configFailure(
        `HostDeck config file must not define both ${snakeCase} and ${camelCase}.`,
        "--config"
      );
    }
  }
  return record;
}

function parseBaseUrl(value: string, source: string): URL {
  const parsed = hostDeckLoopbackOriginSchema.safeParse(value);
  if (!parsed.success) {
    throw configFailure(
      `${source} must use the direct loopback origin http://127.0.0.1 with an explicit port.`,
      source
    );
  }
  const port = Number(new URL(parsed.data).port);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw configFailure(
      `${source} port must be an integer from 1024 through 65535.`,
      source
    );
  }
  return new URL(parsed.data);
}

function parsePort(value: unknown, source: string): number {
  const raw = typeof value === "number" ? String(value) : readString(value, source);

  if (raw === undefined || !/^\d+$/u.test(raw)) {
    throw configFailure(`${source} must be an integer port from 1024 through 65535.`, source);
  }

  const port = Number(raw);

  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw configFailure(`${source} must be an integer port from 1024 through 65535.`, source);
  }

  return port;
}

function readString(value: unknown, source: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw configFailure(`${source} must be a string.`, source);
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw configFailure(`${source} must not be empty.`, source);
  }

  return trimmed;
}

function readOriginString(value: unknown, source: string): string | undefined {
  const parsed = readString(value, source);
  if (parsed !== undefined && parsed !== value) {
    throw configFailure(`${source} must not contain surrounding whitespace.`, source);
  }
  return parsed;
}

function rejectRetiredHostConfiguration(
  flags: CliConfigFlags,
  env: Readonly<Record<string, string | undefined>>
): void {
  if (Object.hasOwn(flags, "host")) {
    throw configFailure(
      "--host is not supported; HostDeck local control is fixed to 127.0.0.1.",
      "--host"
    );
  }
  if (env.HOSTDECK_HOST !== undefined) {
    throw configFailure(
      "HOSTDECK_HOST is not supported; HostDeck local control is fixed to 127.0.0.1.",
      "HOSTDECK_HOST"
    );
  }
}

function resolveConfigPath(configPath: string, cwd = process.cwd()): string {
  return resolve(cwd, configPath);
}

function resolveStoragePath(
  path: string,
  cwd = process.cwd(),
  field: string,
  pathApi: StoragePathApi
): string {
  const trimmed = path.trim();

  if (trimmed.length === 0) {
    throw configFailure(`${field} must not be empty.`, field);
  }

  return pathApi.isAbsolute(trimmed)
    ? pathApi.resolve(trimmed)
    : pathApi.resolve(cwd, trimmed);
}

function defaultStateDir(
  env: Readonly<Record<string, string | undefined>>,
  platform: "linux" | "win32",
  windowsDefaults: WindowsDefaultPaths | null
): string {
  if (platform === "win32") {
    return requireWindowsDefaults(windowsDefaults).state_dir;
  }
  const xdgStateHome = readOptionalAbsolutePath(
    env.XDG_STATE_HOME,
    "XDG_STATE_HOME",
    posix
  );

  if (xdgStateHome !== undefined) {
    return join(xdgStateHome, "hostdeck");
  }

  const home =
    readOptionalAbsolutePath(env.HOME, "HOME", posix) ??
    readOptionalAbsolutePath(homedir(), "home directory", posix);

  if (home === undefined) {
    throw configFailure("HOSTDECK_STATE_DIR is required when no home directory is available.", "state_dir");
  }

  return join(home, ".local", "state", "hostdeck");
}

function assertDatabaseInsideState(
  databasePath: string,
  stateDir: string,
  pathApi: StoragePathApi
): void {
  const candidate = pathApi.relative(stateDir, databasePath);
  if (
    candidate.length === 0 ||
    candidate === ".." ||
    candidate.startsWith(`..${pathApi.sep}`) ||
    pathApi.isAbsolute(candidate)
  ) {
    throw configFailure("database_path must be inside state_dir.", "database_path");
  }
}

function assertWindowsStateInsideOwner(
  stateDir: string,
  ownerRoot: string,
  pathApi: StoragePathApi
): void {
  const candidate = pathApi.relative(ownerRoot, stateDir);
  if (
    candidate === ".." ||
    candidate.startsWith(`..${pathApi.sep}`) ||
    pathApi.isAbsolute(candidate)
  ) {
    throw configFailure(
      "state_dir must remain inside the current-user HostDeck state root.",
      "state_dir"
    );
  }
}

function defaultConfigDir(
  env: Readonly<Record<string, string | undefined>>,
  platform: "linux" | "win32",
  windowsDefaults: WindowsDefaultPaths | null
): string {
  if (platform === "win32") {
    return requireWindowsDefaults(windowsDefaults).config_dir;
  }
  const xdgConfigHome = readOptionalAbsolutePath(
    env.XDG_CONFIG_HOME,
    "XDG_CONFIG_HOME",
    posix
  );
  if (xdgConfigHome !== undefined) return join(xdgConfigHome, "hostdeck");
  const home =
    readOptionalAbsolutePath(env.HOME, "HOME", posix) ??
    readOptionalAbsolutePath(homedir(), "home directory", posix);
  if (home === undefined) throw configFailure("HOME or XDG_CONFIG_HOME is required to resolve HostDeck config.", "config_dir");
  return join(home, ".config", "hostdeck");
}

function defaultRuntimeDir(
  env: Readonly<Record<string, string | undefined>>,
  platform: "linux" | "win32",
  windowsDefaults: WindowsDefaultPaths | null
): string | null {
  if (platform === "win32") {
    return requireWindowsDefaults(windowsDefaults).runtime_dir;
  }
  const xdgRuntimeDir = readOptionalAbsolutePath(
    env.XDG_RUNTIME_DIR,
    "XDG_RUNTIME_DIR",
    posix
  );
  return xdgRuntimeDir === undefined ? null : join(xdgRuntimeDir, "hostdeck");
}

function readOptionalAbsolutePath(
  value: unknown,
  source: string,
  pathApi: StoragePathApi
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (!pathApi.isAbsolute(trimmed)) {
    throw configFailure(`${source} must be an absolute path.`, source);
  }
  return pathApi.resolve(trimmed);
}

function resolveStoragePlatform(
  platform: NodeJS.Platform
): "linux" | "win32" {
  if (platform === "linux" || platform === "win32") return platform;
  throw configFailure(
    "HostDeck storage paths require a supported Linux or Windows host.",
    "platform"
  );
}

function resolveWindowsDefaults(
  options: LoadCliConfigOptions
): WindowsDefaultPaths {
  try {
    return options.windowsUserRoots === undefined
      ? resolveNativeWindowsHostDeckDefaultPaths()
      : resolveWindowsHostDeckDefaultPaths(options.windowsUserRoots());
  } catch (error) {
    throw configFailure(
      "Windows current-user AppData folders are unavailable or unsafe.",
      "platform_paths",
      error
    );
  }
}

function requireWindowsDefaults(
  defaults: WindowsDefaultPaths | null
): WindowsDefaultPaths {
  if (defaults === null) {
    throw configFailure(
      "Windows current-user AppData folders were not resolved.",
      "platform_paths"
    );
  }
  return defaults;
}

function sourceOf(...candidates: readonly [string, unknown][]): string {
  for (const [source, value] of candidates) {
    if (value !== undefined) {
      return source;
    }
  }

  return "default";
}

function inspectExecutableCandidate(candidate: string): string | null {
  try {
    if (
      !isAbsolute(candidate) ||
      candidate === "/" ||
      normalize(candidate) !== candidate ||
      Buffer.byteLength(candidate, "utf8") > maximumExecutablePathBytes ||
      containsControl(candidate)
    ) {
      return null;
    }
    const canonical = realpathSync.native(candidate);
    const stats = lstatSync(canonical);
    if (!stats.isFile() || stats.isSymbolicLink()) return null;
    accessSync(canonical, fsConstants.X_OK);
    return canonical;
  } catch {
    return null;
  }
}

function containsControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
