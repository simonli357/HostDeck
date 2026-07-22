import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { hostDeckLoopbackOriginSchema } from "@hostdeck/contracts";
import { configFailure } from "./errors.js";

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

export function loadCliConfig(options: LoadCliConfigOptions = {}): CliConfig {
  const flags = options.flags ?? {};
  const env = options.env ?? process.env;
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
      defaultStateDir(env),
    options.cwd,
    "state_dir"
  );
  const databasePath = resolveStoragePath(
    readString(flags.databasePath, "--database") ??
      readString(env.HOSTDECK_DATABASE_PATH, "HOSTDECK_DATABASE_PATH") ??
      readString(configFile.database_path ?? configFile.databasePath, "database_path") ??
      join(stateDir, defaultDatabaseFileName),
    options.cwd,
    "database_path"
  );
  assertDatabaseInsideState(databasePath, stateDir);
  const configDir = defaultConfigDir(env);
  const runtimeDir = defaultRuntimeDir(env);

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

function resolveStoragePath(path: string, cwd = process.cwd(), field: string): string {
  const trimmed = path.trim();

  if (trimmed.length === 0) {
    throw configFailure(`${field} must not be empty.`, field);
  }

  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);
}

function defaultStateDir(env: Readonly<Record<string, string | undefined>>): string {
  const xdgStateHome = readOptionalAbsolutePath(env.XDG_STATE_HOME, "XDG_STATE_HOME");

  if (xdgStateHome !== undefined) {
    return join(xdgStateHome, "hostdeck");
  }

  const home = readOptionalAbsolutePath(env.HOME, "HOME") ?? readOptionalAbsolutePath(homedir(), "home directory");

  if (home === undefined) {
    throw configFailure("HOSTDECK_STATE_DIR is required when no home directory is available.", "state_dir");
  }

  return join(home, ".local", "state", "hostdeck");
}

function assertDatabaseInsideState(databasePath: string, stateDir: string): void {
  const candidate = relative(stateDir, databasePath);
  if (candidate.length === 0 || candidate === ".." || candidate.startsWith(`..${sep}`) || isAbsolute(candidate)) {
    throw configFailure("database_path must be inside state_dir.", "database_path");
  }
}

function defaultConfigDir(env: Readonly<Record<string, string | undefined>>): string {
  const xdgConfigHome = readOptionalAbsolutePath(env.XDG_CONFIG_HOME, "XDG_CONFIG_HOME");
  if (xdgConfigHome !== undefined) return join(xdgConfigHome, "hostdeck");
  const home = readOptionalAbsolutePath(env.HOME, "HOME") ?? readOptionalAbsolutePath(homedir(), "home directory");
  if (home === undefined) throw configFailure("HOME or XDG_CONFIG_HOME is required to resolve HostDeck config.", "config_dir");
  return join(home, ".config", "hostdeck");
}

function defaultRuntimeDir(env: Readonly<Record<string, string | undefined>>): string | null {
  const xdgRuntimeDir = readOptionalAbsolutePath(env.XDG_RUNTIME_DIR, "XDG_RUNTIME_DIR");
  return xdgRuntimeDir === undefined ? null : join(xdgRuntimeDir, "hostdeck");
}

function readOptionalAbsolutePath(value: unknown, source: string): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (!isAbsolute(trimmed)) throw configFailure(`${source} must be an absolute path.`, source);
  return resolve(trimmed);
}

function sourceOf(...candidates: readonly [string, unknown][]): string {
  for (const [source, value] of candidates) {
    if (value !== undefined) {
      return source;
    }
  }

  return "default";
}
