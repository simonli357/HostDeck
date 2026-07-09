import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { configFailure } from "./errors.js";

export interface CliConfigFlags {
  readonly apiUrl?: string;
  readonly host?: string;
  readonly port?: string;
  readonly configPath?: string;
  readonly stateDir?: string;
  readonly databasePath?: string;
}

export interface CliConfig {
  readonly baseUrl: URL;
  readonly source: string;
  readonly stateDir: string;
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
  readonly host?: unknown;
  readonly port?: unknown;
  readonly state_dir?: unknown;
  readonly stateDir?: unknown;
  readonly database_path?: unknown;
  readonly databasePath?: unknown;
};

const defaultHost = "127.0.0.1";
const defaultPort = 3777;
const defaultDatabaseFileName = "hostdeck.sqlite";

export function loadCliConfig(options: LoadCliConfigOptions = {}): CliConfig {
  const flags = options.flags ?? {};
  const env = options.env ?? process.env;
  const configFile = loadConfigFile(flags.configPath, options);
  const envBaseUrl = readString(env.HOSTDECK_API_BASE_URL, "HOSTDECK_API_BASE_URL");
  const fileBaseUrl = readString(configFile.api_url ?? configFile.apiUrl, "api_url");
  const flagBaseUrl = readString(flags.apiUrl, "--api-url");
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

  if (baseUrl !== undefined) {
    return {
      baseUrl: normalizeBaseUrl(parseBaseUrl(baseUrl, sourceOf(["--api-url", flagBaseUrl], ["HOSTDECK_API_BASE_URL", envBaseUrl], ["config api_url", fileBaseUrl]))),
      source: sourceOf(["--api-url", flagBaseUrl], ["HOSTDECK_API_BASE_URL", envBaseUrl], ["config api_url", fileBaseUrl]),
      stateDir,
      databasePath
    };
  }

  const host = readString(flags.host, "--host") ?? readString(env.HOSTDECK_HOST, "HOSTDECK_HOST") ?? readString(configFile.host, "host") ?? defaultHost;
  const portValue = flags.port ?? env.HOSTDECK_PORT ?? configFile.port ?? defaultPort;
  const port = parsePort(portValue, sourceOf(["--port", flags.port], ["HOSTDECK_PORT", env.HOSTDECK_PORT], ["config port", configFile.port], ["default", String(defaultPort)]));

  validateHost(host, sourceOf(["--host", flags.host], ["HOSTDECK_HOST", env.HOSTDECK_HOST], ["config host", configFile.host], ["default", host]));

  return {
    baseUrl: new URL(`http://${host}:${port}`),
    source: flags.configPath === undefined ? "defaults/env/flags" : resolveConfigPath(flags.configPath, options.cwd),
    stateDir,
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
    throw configFailure(`Unable to read HostDeck config file ${path}.`, "--config");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw configFailure(`HostDeck config file ${path} is not valid JSON.`, "--config");
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw configFailure(`HostDeck config file ${path} must be a JSON object.`, "--config");
  }

  return parsed as RawConfigFile;
}

function parseBaseUrl(value: string, source: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw configFailure(`${source} must be an absolute http(s) URL.`, source);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw configFailure(`${source} must use http or https.`, source);
  }

  if (url.hostname.length === 0) {
    throw configFailure(`${source} must include a host.`, source);
  }

  if (url.username.length > 0 || url.password.length > 0) {
    throw configFailure(`${source} must not include credentials.`, source);
  }

  if (url.search.length > 0 || url.hash.length > 0) {
    throw configFailure(`${source} must not include query or fragment components.`, source);
  }

  if (url.pathname !== "/" && url.pathname !== "") {
    throw configFailure(`${source} must not include a path.`, source);
  }

  return url;
}

function normalizeBaseUrl(url: URL): URL {
  const normalized = new URL(url.toString());
  normalized.pathname = normalized.pathname.replace(/\/+$/u, "");
  return normalized;
}

function parsePort(value: unknown, source: string): number {
  const raw = typeof value === "number" ? String(value) : readString(value, source);

  if (raw === undefined || !/^\d+$/u.test(raw)) {
    throw configFailure(`${source} must be an integer port from 1 to 65535.`, source);
  }

  const port = Number(raw);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw configFailure(`${source} must be an integer port from 1 to 65535.`, source);
  }

  return port;
}

function validateHost(host: string, source: string): void {
  if (host.trim().length === 0 || /[\s/?#@]/u.test(host)) {
    throw configFailure(`${source} must be a host name or IP address without spaces, path, credentials, query, or fragment.`, source);
  }
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
  const xdgStateHome = readOptionalPath(env.XDG_STATE_HOME);

  if (xdgStateHome !== undefined) {
    return join(xdgStateHome, "hostdeck");
  }

  const home = readOptionalPath(env.HOME) ?? readOptionalPath(homedir());

  if (home === undefined) {
    throw configFailure("HOSTDECK_STATE_DIR is required when no home directory is available.", "state_dir");
  }

  return join(home, ".local", "state", "hostdeck");
}

function readOptionalPath(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function sourceOf(...candidates: readonly [string, unknown][]): string {
  for (const [source, value] of candidates) {
    if (value !== undefined) {
      return source;
    }
  }

  return "default";
}
