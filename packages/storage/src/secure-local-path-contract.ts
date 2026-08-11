import type {
  HostPlatformCapability,
  SupportedHostTarget
} from "@hostdeck/contracts";

export type HostDeckLocalPathErrorCode =
  | "alternate_stream_rejected"
  | "case_collision"
  | "hard_link_rejected"
  | "invalid_path"
  | "path_not_canonical"
  | "path_substitution"
  | "path_type_mismatch"
  | "permission_update_failed"
  | "runtime_parent_insecure"
  | "reserved_name_rejected"
  | "symlink_rejected"
  | "unsupported_filesystem"
  | "unsupported_platform"
  | "wrong_owner";

export class HostDeckLocalPathError extends Error {
  constructor(
    readonly code: HostDeckLocalPathErrorCode,
    message: string,
    readonly path: string | null,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostDeckLocalPathError";
  }
}

export interface HostDeckPathModeRepair {
  readonly path: string;
  readonly kind: "directory" | "file" | "socket";
  readonly from_mode: number;
  readonly to_mode: number;
}

export interface HostDeckPathAclRepair {
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly from_acl: "not_current_user_only";
  readonly to_acl: "current_user_only";
}

export type HostDeckPathSecurityRepair =
  | HostDeckPathModeRepair
  | HostDeckPathAclRepair;

export interface PrepareHostDeckLocalPathsInput {
  readonly config_dir: string;
  readonly state_dir: string;
  readonly runtime_dir: string;
  readonly database_path: string;
}

export interface ResolvedHostDeckPathRoots {
  readonly config_dir: string;
  readonly state_dir: string;
  readonly runtime_dir: string;
  readonly database_path: string;
}

export interface ResolvedHostDeckLocalPaths extends ResolvedHostDeckPathRoots {
  readonly lease_path: string;
  readonly app_server_socket_path: string;
}

export interface PreparedHostDeckLocalPaths extends ResolvedHostDeckLocalPaths {
  readonly repairs: readonly HostDeckPathSecurityRepair[];
}

export interface HostDeckStatePathsInput {
  readonly state_dir: string;
  readonly database_path: string;
}

export interface PreparedHostDeckStatePaths extends HostDeckStatePathsInput {
  readonly repairs: readonly HostDeckPathSecurityRepair[];
}

export type ExistingHostDeckStatePaths = HostDeckStatePathsInput;

export interface SecureHostDeckRegularFileOptions {
  readonly label: string;
  readonly mode?: number;
  readonly create?: boolean;
  readonly repair_mode?: boolean;
}

export interface OpenSecureHostDeckRegularFileOptions extends SecureHostDeckRegularFileOptions {
  readonly writable?: boolean;
}

export interface OpenedSecureHostDeckRegularFile {
  readonly descriptor: number;
  readonly path: string;
  readonly repair: HostDeckPathSecurityRepair | null;
  readonly verifyPath: () => void;
}

export interface SecureHostDeckSocketOptions {
  readonly label: string;
  readonly mode?: number;
  readonly repair_mode?: boolean;
}

export interface HostDeckPathDialect {
  readonly family: "posix" | "windows";
  readonly separator: "/" | "\\";
  readonly dirname: (path: string) => string;
  readonly isAbsolute: (path: string) => boolean;
  readonly relative: (from: string, to: string) => string;
  readonly resolve: (path: string) => string;
  readonly root: (path: string) => string;
}

export interface HostDeckLocalPathAdapter {
  readonly target: SupportedHostTarget;
  readonly path_family: HostPlatformCapability["path_family"];
  readonly path_security: HostPlatformCapability["path_security"];
  readonly resolveLocalPaths: (
    input: PrepareHostDeckLocalPathsInput
  ) => ResolvedHostDeckLocalPaths;
  readonly prepareLocalPaths: (
    input: PrepareHostDeckLocalPathsInput
  ) => PreparedHostDeckLocalPaths;
  readonly prepareDaemonLeasePath: (
    paths: ResolvedHostDeckLocalPaths
  ) => readonly HostDeckPathSecurityRepair[];
  readonly prepareLocalPathsAfterLease: (
    paths: ResolvedHostDeckLocalPaths
  ) => PreparedHostDeckLocalPaths;
  readonly prepareServiceLocalPathsAfterLease: (
    paths: ResolvedHostDeckLocalPaths
  ) => PreparedHostDeckLocalPaths;
  readonly prepareStatePaths: (
    input: HostDeckStatePathsInput
  ) => PreparedHostDeckStatePaths;
  readonly inspectExistingStatePaths: (
    input: HostDeckStatePathsInput
  ) => ExistingHostDeckStatePaths;
  readonly secureRegularFile: (
    path: string,
    options: SecureHostDeckRegularFileOptions
  ) => HostDeckPathSecurityRepair | null;
  readonly openSecureRegularFile: (
    path: string,
    options: OpenSecureHostDeckRegularFileOptions
  ) => OpenedSecureHostDeckRegularFile;
  readonly secureSocket: (
    path: string,
    options: SecureHostDeckSocketOptions
  ) => HostDeckPathSecurityRepair | null;
}

export function defineHostDeckLocalPathAdapter(
  adapter: HostDeckLocalPathAdapter
): HostDeckLocalPathAdapter {
  const expected =
    adapter.target === "linux-x64"
      ? { path_family: "posix", path_security: "uid_mode" }
      : adapter.target === "windows-x64"
        ? { path_family: "windows", path_security: "current_user_acl" }
        : null;
  if (
    expected === null ||
    adapter.path_family !== expected.path_family ||
    adapter.path_security !== expected.path_security
  ) {
    throw new TypeError("HostDeck local-path adapter identity is inconsistent.");
  }
  return Object.freeze({ ...adapter });
}

export function resolveHostDeckPathRoots(
  input: PrepareHostDeckLocalPathsInput,
  dialect: HostDeckPathDialect
): ResolvedHostDeckPathRoots {
  const stateDir = resolveHostDeckAbsolutePath(input.state_dir, "state_dir", dialect);
  const configDir = resolveHostDeckAbsolutePath(input.config_dir, "config_dir", dialect);
  const runtimeDir = resolveHostDeckAbsolutePath(input.runtime_dir, "runtime_dir", dialect);
  const databasePath = resolveHostDeckAbsolutePath(
    input.database_path,
    "database_path",
    dialect
  );
  assertSeparateDirectories(stateDir, configDir, runtimeDir, dialect);
  assertDescendant(
    databasePath,
    stateDir,
    "database_path must be inside state_dir.",
    dialect
  );
  return Object.freeze({
    config_dir: configDir,
    state_dir: stateDir,
    runtime_dir: runtimeDir,
    database_path: databasePath
  });
}

export function resolveHostDeckStatePathRoots(
  input: HostDeckStatePathsInput,
  dialect: HostDeckPathDialect
): HostDeckStatePathsInput {
  const stateDir = resolveHostDeckAbsolutePath(input.state_dir, "state_dir", dialect);
  const databasePath = resolveHostDeckAbsolutePath(
    input.database_path,
    "database_path",
    dialect
  );
  assertDescendant(
    databasePath,
    stateDir,
    "database_path must be inside state_dir.",
    dialect
  );
  return Object.freeze({ state_dir: stateDir, database_path: databasePath });
}

export function hostDeckLocalPathError(
  code: HostDeckLocalPathErrorCode,
  message: string,
  path: string | null,
  cause?: unknown
): HostDeckLocalPathError {
  return new HostDeckLocalPathError(code, message, path, { cause });
}

function assertSeparateDirectories(
  stateDir: string,
  configDir: string,
  runtimeDir: string,
  dialect: HostDeckPathDialect
): void {
  const directories = [stateDir, configDir, runtimeDir];
  for (let leftIndex = 0; leftIndex < directories.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < directories.length;
      rightIndex += 1
    ) {
      const left = directories[leftIndex];
      const right = directories[rightIndex];
      if (
        left !== undefined &&
        right !== undefined &&
        (isDescendantOrSame(left, right, dialect) ||
          isDescendantOrSame(right, left, dialect))
      ) {
        throw hostDeckLocalPathError(
          "invalid_path",
          "HostDeck config, state, and runtime directories must not overlap.",
          null
        );
      }
    }
  }
}

function isDescendantOrSame(
  path: string,
  parent: string,
  dialect: HostDeckPathDialect
): boolean {
  const candidate = dialect.relative(parent, path);
  return (
    candidate.length === 0 ||
    (candidate !== ".." &&
      !candidate.startsWith(`..${dialect.separator}`) &&
      !dialect.isAbsolute(candidate))
  );
}

function assertDescendant(
  path: string,
  parent: string,
  message: string,
  dialect: HostDeckPathDialect
): void {
  const candidate = dialect.relative(parent, path);
  if (
    candidate.length === 0 ||
    candidate === ".." ||
    candidate.startsWith(`..${dialect.separator}`) ||
    dialect.isAbsolute(candidate)
  ) {
    throw hostDeckLocalPathError("invalid_path", message, path);
  }
}

export function resolveHostDeckAbsolutePath(
  candidate: unknown,
  label: string,
  dialect: HostDeckPathDialect
): string {
  if (
    typeof candidate !== "string" ||
    candidate.length < 2 ||
    candidate.length > 4_096 ||
    !dialect.isAbsolute(candidate) ||
    (dialect.family === "windows" && dialect.root(candidate).length === 1) ||
    containsControlCharacter(candidate)
  ) {
    throw hostDeckLocalPathError(
      "invalid_path",
      `${label} must be a bounded absolute path.`,
      null
    );
  }
  const parsed = dialect.resolve(candidate);
  if (dialect.dirname(parsed) === parsed) {
    throw hostDeckLocalPathError(
      "invalid_path",
      `${label} must not be the filesystem root.`,
      parsed
    );
  }
  return parsed;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
