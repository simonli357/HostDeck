import {
  chmodSync,
  closeSync,
  fchmodSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  type Stats
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type HostDeckLocalPathErrorCode =
  | "hard_link_rejected"
  | "invalid_path"
  | "path_not_canonical"
  | "path_substitution"
  | "path_type_mismatch"
  | "permission_update_failed"
  | "runtime_parent_insecure"
  | "symlink_rejected"
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

export interface PrepareHostDeckLocalPathsInput {
  readonly config_dir: string;
  readonly state_dir: string;
  readonly runtime_dir: string;
  readonly database_path: string;
}

export interface ResolvedHostDeckLocalPaths {
  readonly config_dir: string;
  readonly state_dir: string;
  readonly runtime_dir: string;
  readonly database_path: string;
  readonly lease_path: string;
  readonly app_server_socket_path: string;
}

export interface PreparedHostDeckLocalPaths extends ResolvedHostDeckLocalPaths {
  readonly repairs: readonly HostDeckPathModeRepair[];
}

export interface PreparedHostDeckStatePaths {
  readonly state_dir: string;
  readonly database_path: string;
  readonly repairs: readonly HostDeckPathModeRepair[];
}

export interface ExistingHostDeckStatePaths {
  readonly state_dir: string;
  readonly database_path: string;
}

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
  readonly repair: HostDeckPathModeRepair | null;
  readonly verifyPath: () => void;
}

export interface SecureHostDeckSocketOptions {
  readonly label: string;
  readonly mode?: number;
  readonly repair_mode?: boolean;
}

const directoryMode = 0o700;
const sensitiveFileMode = 0o600;

function freezeRepairs(repairs: readonly HostDeckPathModeRepair[]): readonly HostDeckPathModeRepair[] {
  return Object.freeze(repairs.map((repair) => Object.freeze({ ...repair })));
}

export function prepareHostDeckLocalPaths(input: PrepareHostDeckLocalPathsInput): PreparedHostDeckLocalPaths {
  const resolved = resolveHostDeckLocalPaths(input);
  const leaseRepairs = prepareHostDeckDaemonLeasePath(resolved);
  const prepared = prepareHostDeckLocalPathsAfterLease(resolved);
  return Object.freeze({
    ...prepared,
    repairs: freezeRepairs([...leaseRepairs, ...prepared.repairs])
  });
}

export function resolveHostDeckLocalPaths(input: PrepareHostDeckLocalPathsInput): ResolvedHostDeckLocalPaths {
  requireLinuxUid();
  const stateDir = parseAbsolutePath(input.state_dir, "state_dir");
  const configDir = parseAbsolutePath(input.config_dir, "config_dir");
  const runtimeDir = parseAbsolutePath(input.runtime_dir, "runtime_dir");
  const databasePath = parseAbsolutePath(input.database_path, "database_path");
  assertSeparateDirectories(stateDir, configDir, runtimeDir);
  assertDescendant(databasePath, stateDir, "database_path must be inside state_dir.");
  const leasePath = join(stateDir, "hostdeck.lock");
  const appServerSocketPath = join(runtimeDir, "app-server.sock");
  for (const reservedPath of [leasePath, appServerSocketPath]) {
    if (reservedPath === databasePath) {
      throw pathError("invalid_path", "Database path collides with a reserved HostDeck path.", databasePath);
    }
  }

  return Object.freeze({
    config_dir: configDir,
    state_dir: stateDir,
    runtime_dir: runtimeDir,
    database_path: databasePath,
    lease_path: leasePath,
    app_server_socket_path: appServerSocketPath
  });
}

export function prepareHostDeckDaemonLeasePath(
  paths: ResolvedHostDeckLocalPaths
): readonly HostDeckPathModeRepair[] {
  const resolved = validateResolvedHostDeckLocalPaths(paths);
  const uid = requireLinuxUid();
  const repairs: HostDeckPathModeRepair[] = [];
  ensureSecureDirectory(resolved.state_dir, "state_dir", uid, repairs);
  const leaseRepair = secureHostDeckRegularFile(resolved.lease_path, {
    label: "daemon lease",
    mode: sensitiveFileMode,
    create: true,
    repair_mode: true
  });
  if (leaseRepair !== null) repairs.push(leaseRepair);
  return freezeRepairs(repairs);
}

export function prepareHostDeckLocalPathsAfterLease(
  paths: ResolvedHostDeckLocalPaths
): PreparedHostDeckLocalPaths {
  const resolved = validateResolvedHostDeckLocalPaths(paths);
  const uid = requireLinuxUid();
  const repairs: HostDeckPathModeRepair[] = [];
  ensureSecureDirectory(resolved.config_dir, "config_dir", uid, repairs);
  assertSecureRuntimeParent(dirname(resolved.runtime_dir), uid);
  ensureSecureDirectory(resolved.runtime_dir, "runtime_dir", uid, repairs);
  ensureSecureDirectory(dirname(resolved.database_path), "database parent", uid, repairs);

  return Object.freeze({
    ...resolved,
    repairs: freezeRepairs(repairs)
  });
}

export function prepareHostDeckServiceLocalPathsAfterLease(
  paths: ResolvedHostDeckLocalPaths
): PreparedHostDeckLocalPaths {
  const resolved = validateResolvedHostDeckLocalPaths(paths);
  const uid = requireLinuxUid();
  const repairs: HostDeckPathModeRepair[] = [];
  ensureSecureDirectory(resolved.config_dir, "config_dir", uid, repairs);
  assertSecureRuntimeParent(dirname(resolved.runtime_dir), uid);
  inspectExistingSecureDirectory(resolved.runtime_dir, "runtime_dir", uid);
  ensureSecureDirectory(
    dirname(resolved.database_path),
    "database parent",
    uid,
    repairs
  );

  return Object.freeze({
    ...resolved,
    repairs: freezeRepairs(repairs)
  });
}

function validateResolvedHostDeckLocalPaths(paths: ResolvedHostDeckLocalPaths): ResolvedHostDeckLocalPaths {
  const resolved = resolveHostDeckLocalPaths({
    config_dir: paths.config_dir,
    state_dir: paths.state_dir,
    runtime_dir: paths.runtime_dir,
    database_path: paths.database_path
  });
  if (paths.lease_path !== resolved.lease_path || paths.app_server_socket_path !== resolved.app_server_socket_path) {
    throw pathError("invalid_path", "Derived HostDeck lease or app-server socket path does not match its owner directory.", null);
  }
  return resolved;
}

export function prepareHostDeckStatePaths(input: {
  readonly state_dir: string;
  readonly database_path: string;
}): PreparedHostDeckStatePaths {
  const uid = requireLinuxUid();
  const stateDir = parseAbsolutePath(input.state_dir, "state_dir");
  const databasePath = parseAbsolutePath(input.database_path, "database_path");
  assertDescendant(databasePath, stateDir, "database_path must be inside state_dir.");
  const repairs: HostDeckPathModeRepair[] = [];
  ensureSecureDirectory(stateDir, "state_dir", uid, repairs);
  ensureSecureDirectory(dirname(databasePath), "database parent", uid, repairs);
  const databaseRepair = secureHostDeckRegularFile(databasePath, {
    label: "database",
    mode: sensitiveFileMode,
    create: true,
    repair_mode: true
  });
  if (databaseRepair !== null) repairs.push(databaseRepair);
  return Object.freeze({
    state_dir: stateDir,
    database_path: databasePath,
    repairs: freezeRepairs(repairs)
  });
}

export function inspectExistingHostDeckStatePaths(input: {
  readonly state_dir: string;
  readonly database_path: string;
}): ExistingHostDeckStatePaths {
  const uid = requireLinuxUid();
  const stateDir = parseAbsolutePath(input.state_dir, "state_dir");
  const databasePath = parseAbsolutePath(input.database_path, "database_path");
  assertDescendant(
    databasePath,
    stateDir,
    "database_path must be inside state_dir."
  );

  let directory = stateDir;
  inspectExistingSecureDirectory(directory, "state_dir", uid);
  const databaseParent = dirname(databasePath);
  const descendants = relative(stateDir, databaseParent);
  if (descendants.length > 0) {
    for (const segment of descendants.split(sep)) {
      directory = join(directory, segment);
      inspectExistingSecureDirectory(directory, "database parent", uid);
    }
  }

  return Object.freeze({
    state_dir: stateDir,
    database_path: databasePath
  });
}

export function secureHostDeckRegularFile(
  path: string,
  options: SecureHostDeckRegularFileOptions
): HostDeckPathModeRepair | null {
  const opened = openSecureHostDeckRegularFile(path, options);
  try {
    return opened.repair;
  } finally {
    closeSync(opened.descriptor);
  }
}

export function openSecureHostDeckRegularFile(
  path: string,
  options: OpenSecureHostDeckRegularFileOptions
): OpenedSecureHostDeckRegularFile {
  const uid = requireLinuxUid();
  const parsedPath = parseAbsolutePath(path, options.label);
  const mode = parseMode(options.mode ?? sensitiveFileMode, options.label);
  assertCanonicalParent(parsedPath, options.label);
  inspectExistingRegularPath(parsedPath, options.label, uid);
  let preopenRepair: HostDeckPathModeRepair | null = null;
  let descriptor: number;
  try {
    descriptor = openRegularFileForInspection(parsedPath, mode, options.create === true);
  } catch (error) {
    if (isErrno(error, "EACCES") && options.repair_mode === true) {
      preopenRepair = repairInaccessibleRegularFile(parsedPath, options.label, mode, uid);
      try {
        descriptor = openRegularFileForInspection(parsedPath, mode, false);
      } catch (retryError) {
        throw secureOpenError(retryError, parsedPath, options.label);
      }
    } else {
      throw secureOpenError(error, parsedPath, options.label);
    }
  }

  try {
    const metadata = inspectOpenRegularFile(descriptor, parsedPath, options.label, uid);
    const identity = identityOfDescriptor(descriptor);
    const descriptorRepair = enforceFileMode(
      descriptor,
      metadata.mode,
      parsedPath,
      options.label,
      mode,
      options.repair_mode === true
    );

    if (options.writable === true) {
      const writableDescriptor = openWritableValidatedCopy(parsedPath, options.label, uid, mode, identity);
      closeSync(descriptor);
      descriptor = writableDescriptor;
    }

    const verifyPath = () => verifyOpenRegularFile(descriptor, parsedPath, options.label, uid, mode);
    verifyPath();
    return {
      descriptor,
      path: parsedPath,
      repair: preopenRepair ?? descriptorRepair,
      verifyPath
    };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

export function secureHostDeckSocket(path: string, options: SecureHostDeckSocketOptions): HostDeckPathModeRepair | null {
  const uid = requireLinuxUid();
  const parsedPath = parseAbsolutePath(path, options.label);
  const mode = parseMode(options.mode ?? sensitiveFileMode, options.label);
  assertCanonicalParent(parsedPath, options.label);
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(parsedPath);
  } catch (error) {
    throw pathError("invalid_path", `${options.label} could not be inspected.`, parsedPath, error);
  }
  if (metadata.isSymbolicLink()) throw pathError("symlink_rejected", `${options.label} must not be a symlink.`, parsedPath);
  if (!metadata.isSocket()) throw pathError("path_type_mismatch", `${options.label} must be a Unix socket.`, parsedPath);
  if (metadata.uid !== uid) throw pathError("wrong_owner", `${options.label} must be owned by the current user.`, parsedPath);
  if (metadata.nlink !== 1) throw pathError("hard_link_rejected", `${options.label} must have exactly one hard link.`, parsedPath);
  assertCanonical(parsedPath, options.label);
  const identity = identityOfPath(parsedPath, options.label);
  const repair = enforcePathMode(
    parsedPath,
    metadata.mode,
    "socket",
    options.label,
    mode,
    options.repair_mode === true
  );
  assertPathIdentity(parsedPath, identity, options.label);
  return repair;
}

function openRegularFileForInspection(path: string, mode: number, create: boolean): number {
  try {
    return openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    if (!create || !isErrno(error, "ENOENT")) throw error;
  }

  try {
    return openSync(
      path,
      fsConstants.O_RDWR | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | fsConstants.O_CREAT | fsConstants.O_EXCL,
      mode
    );
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
    return openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  }
}

function openWritableValidatedCopy(
  path: string,
  label: string,
  uid: number,
  mode: number,
  expectedIdentity: FileIdentity
): number {
  let descriptor: number;
  try {
    descriptor = openSync(path, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    throw secureOpenError(error, path, label);
  }

  try {
    const metadata = inspectOpenRegularFile(descriptor, path, label, uid);
    assertSameIdentity(identityOfDescriptor(descriptor), expectedIdentity, path, label);
    if ((metadata.mode & 0o7777) !== mode) {
      throw pathError("permission_update_failed", `${label} mode changed during secure open.`, path);
    }
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function inspectExistingRegularPath(path: string, label: string, uid: number): void {
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw pathError("invalid_path", `${label} could not be inspected before secure open.`, path, error);
  }
  if (metadata.isSymbolicLink()) throw pathError("symlink_rejected", `${label} must not be a symlink.`, path);
  if (!metadata.isFile()) throw pathError("path_type_mismatch", `${label} must be a regular file.`, path);
  if (metadata.uid !== uid) throw pathError("wrong_owner", `${label} must be owned by the current user.`, path);
  if (metadata.nlink !== 1) throw pathError("hard_link_rejected", `${label} must have exactly one hard link.`, path);
  assertCanonical(path, label);
}

function inspectOpenRegularFile(
  descriptor: number,
  path: string,
  label: string,
  uid: number
): Stats {
  const metadata = fstatSync(descriptor);
  if (!metadata.isFile()) throw pathError("path_type_mismatch", `${label} must be a regular file.`, path);
  if (metadata.uid !== uid) throw pathError("wrong_owner", `${label} must be owned by the current user.`, path);
  if (metadata.nlink !== 1) throw pathError("hard_link_rejected", `${label} must have exactly one hard link.`, path);
  assertCanonical(path, label);
  assertPathIdentity(path, identityOfDescriptor(descriptor), label);
  return metadata;
}

function verifyOpenRegularFile(descriptor: number, path: string, label: string, uid: number, mode: number): void {
  const metadata = inspectOpenRegularFile(descriptor, path, label, uid);
  if ((metadata.mode & 0o7777) !== mode) {
    throw pathError("permission_update_failed", `${label} mode changed after secure open.`, path);
  }
}

function repairInaccessibleRegularFile(
  path: string,
  label: string,
  mode: number,
  uid: number
): HostDeckPathModeRepair | null {
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    throw pathError("invalid_path", `${label} could not be inspected for permission repair.`, path, error);
  }
  if (metadata.isSymbolicLink()) throw pathError("symlink_rejected", `${label} must not be a symlink.`, path);
  if (!metadata.isFile()) throw pathError("path_type_mismatch", `${label} must be a regular file.`, path);
  if (metadata.uid !== uid) throw pathError("wrong_owner", `${label} must be owned by the current user.`, path);
  if (metadata.nlink !== 1) throw pathError("hard_link_rejected", `${label} must have exactly one hard link.`, path);
  assertCanonical(path, label);
  const identity = identityOfPath(path, label);
  const repair = enforcePathMode(path, metadata.mode, "file", label, mode, true);
  assertPathIdentity(path, identity, label);
  return repair;
}

function secureOpenError(error: unknown, path: string, label: string): HostDeckLocalPathError {
  if (error instanceof HostDeckLocalPathError) return error;
  if (isErrno(error, "ELOOP")) return pathError("symlink_rejected", `${label} must not be a symlink.`, path, error);
  return pathError("invalid_path", `${label} could not be opened securely.`, path, error);
}

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

function identityOfDescriptor(descriptor: number): FileIdentity {
  const metadata = fstatSync(descriptor, { bigint: true });
  return { device: metadata.dev, inode: metadata.ino };
}

function identityOfPath(path: string, label: string): FileIdentity {
  try {
    const metadata = lstatSync(path, { bigint: true });
    if (metadata.isSymbolicLink()) throw pathError("symlink_rejected", `${label} must not be a symlink.`, path);
    return { device: metadata.dev, inode: metadata.ino };
  } catch (error) {
    if (error instanceof HostDeckLocalPathError) throw error;
    throw pathError("path_substitution", `${label} path changed during validation.`, path, error);
  }
}

function assertPathIdentity(path: string, expected: FileIdentity, label: string): void {
  assertSameIdentity(identityOfPath(path, label), expected, path, label);
}

function assertSameIdentity(actual: FileIdentity, expected: FileIdentity, path: string, label: string): void {
  if (actual.device !== expected.device || actual.inode !== expected.inode) {
    throw pathError("path_substitution", `${label} path changed during validation.`, path);
  }
}

function assertCanonicalParent(path: string, label: string): void {
  assertCanonical(dirname(path), `${label} parent`);
}

function assertCanonicalExistingAncestor(path: string, label: string): void {
  let candidate = path;
  while (true) {
    try {
      const metadata = lstatSync(candidate);
      if (metadata.isSymbolicLink()) throw pathError("symlink_rejected", `${label} must not traverse symbolic links.`, candidate);
      assertCanonical(candidate, label);
      return;
    } catch (error) {
      if (error instanceof HostDeckLocalPathError) throw error;
      if (!isErrno(error, "ENOENT")) {
        throw pathError("invalid_path", `${label} ancestor could not be inspected.`, candidate, error);
      }
    }

    const parent = dirname(candidate);
    if (parent === candidate) throw pathError("invalid_path", `${label} has no inspectable ancestor.`, path);
    candidate = parent;
  }
}

function ensureSecureDirectory(
  path: string,
  label: string,
  uid: number,
  repairs: HostDeckPathModeRepair[]
): void {
  assertCanonicalExistingAncestor(path, label);
  try {
    mkdirSync(path, { recursive: true, mode: directoryMode });
  } catch (error) {
    throw pathError("invalid_path", `${label} could not be created.`, path, error);
  }
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    throw pathError("invalid_path", `${label} could not be inspected.`, path, error);
  }
  if (metadata.isSymbolicLink()) throw pathError("symlink_rejected", `${label} must not be a symlink.`, path);
  if (!metadata.isDirectory()) throw pathError("path_type_mismatch", `${label} must be a directory.`, path);
  if (metadata.uid !== uid) throw pathError("wrong_owner", `${label} must be owned by the current user.`, path);
  assertCanonical(path, label);
  const identity = identityOfPath(path, label);
  const repair = enforcePathMode(path, metadata.mode, "directory", label, directoryMode, true);
  assertPathIdentity(path, identity, label);
  if (repair !== null) repairs.push(repair);
}

function inspectExistingSecureDirectory(
  path: string,
  label: string,
  uid: number
): void {
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    throw pathError(
      "invalid_path",
      `${label} could not be inspected.`,
      path,
      error
    );
  }
  if (metadata.isSymbolicLink()) {
    throw pathError(
      "symlink_rejected",
      `${label} must not be a symlink.`,
      path
    );
  }
  if (!metadata.isDirectory()) {
    throw pathError(
      "path_type_mismatch",
      `${label} must be a directory.`,
      path
    );
  }
  if (metadata.uid !== uid) {
    throw pathError(
      "wrong_owner",
      `${label} must be owned by the current user.`,
      path
    );
  }
  if ((metadata.mode & 0o7777) !== directoryMode) {
    throw pathError(
      "permission_update_failed",
      `${label} must have mode ${formatMode(directoryMode)}.`,
      path
    );
  }
  assertCanonical(path, label);
}

function assertSecureRuntimeParent(path: string, uid: number): void {
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    throw pathError("runtime_parent_insecure", "Runtime parent directory is unavailable.", path, error);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || metadata.uid !== uid || (metadata.mode & 0o7777) !== directoryMode) {
    throw pathError(
      "runtime_parent_insecure",
      "Runtime parent directory must be canonical, owner-owned, and mode 0700.",
      path
    );
  }
  assertCanonical(path, "runtime parent");
}

function enforcePathMode(
  path: string,
  actualMode: number,
  kind: HostDeckPathModeRepair["kind"],
  label: string,
  expectedMode: number,
  repair: boolean
): HostDeckPathModeRepair | null {
  const actual = actualMode & 0o7777;
  if (actual === expectedMode) return null;
  if (!repair) throw pathError("permission_update_failed", `${label} must have mode ${formatMode(expectedMode)}.`, path);
  try {
    chmodSync(path, expectedMode);
  } catch (error) {
    throw pathError("permission_update_failed", `${label} permissions could not be repaired.`, path, error);
  }
  let repaired: number;
  try {
    repaired = lstatSync(path).mode & 0o7777;
  } catch (error) {
    throw pathError("path_substitution", `${label} path changed during permission repair.`, path, error);
  }
  if (repaired !== expectedMode) throw pathError("permission_update_failed", `${label} permissions remain insecure.`, path);
  return { path, kind, from_mode: actual, to_mode: expectedMode };
}

function enforceFileMode(
  descriptor: number,
  actualMode: number,
  path: string,
  label: string,
  expectedMode: number,
  repair: boolean
): HostDeckPathModeRepair | null {
  const actual = actualMode & 0o7777;
  if (actual === expectedMode) return null;
  if (!repair) throw pathError("permission_update_failed", `${label} must have mode ${formatMode(expectedMode)}.`, path);
  try {
    fchmodSync(descriptor, expectedMode);
  } catch (error) {
    throw pathError("permission_update_failed", `${label} permissions could not be repaired.`, path, error);
  }
  const repaired = fstatSync(descriptor).mode & 0o7777;
  if (repaired !== expectedMode) throw pathError("permission_update_failed", `${label} permissions remain insecure.`, path);
  return { path, kind: "file", from_mode: actual, to_mode: expectedMode };
}

function assertCanonical(path: string, label: string): void {
  let canonical: string;
  try {
    canonical = realpathSync.native(path);
  } catch (error) {
    throw pathError("invalid_path", `${label} could not be canonicalized.`, path, error);
  }
  if (canonical !== path) throw pathError("path_not_canonical", `${label} must not traverse symbolic links.`, path);
}

function assertSeparateDirectories(stateDir: string, configDir: string, runtimeDir: string): void {
  const directories = [stateDir, configDir, runtimeDir];
  for (let leftIndex = 0; leftIndex < directories.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < directories.length; rightIndex += 1) {
      const left = directories[leftIndex];
      const right = directories[rightIndex];
      if (left !== undefined && right !== undefined && (isDescendantOrSame(left, right) || isDescendantOrSame(right, left))) {
        throw pathError("invalid_path", "HostDeck config, state, and runtime directories must not overlap.", null);
      }
    }
  }
}

function isDescendantOrSame(path: string, parent: string): boolean {
  const candidate = relative(parent, path);
  return candidate.length === 0 || (candidate !== ".." && !candidate.startsWith(`..${sep}`) && !isAbsolute(candidate));
}

function assertDescendant(path: string, parent: string, message: string): void {
  const candidate = relative(parent, path);
  if (candidate.length === 0 || candidate === ".." || candidate.startsWith(`..${sep}`) || isAbsolute(candidate)) {
    throw pathError("invalid_path", message, path);
  }
}

function parseAbsolutePath(candidate: unknown, label: string): string {
  if (
    typeof candidate !== "string" ||
    candidate.length < 2 ||
    candidate.length > 4_096 ||
    !isAbsolute(candidate) ||
    containsControlCharacter(candidate)
  ) {
    throw pathError("invalid_path", `${label} must be a bounded absolute path.`, null);
  }
  const parsed = resolve(candidate);
  if (parsed === resolve("/")) throw pathError("invalid_path", `${label} must not be the filesystem root.`, parsed);
  return parsed;
}

function parseMode(candidate: number, label: string): number {
  if (!Number.isSafeInteger(candidate) || candidate < 0 || candidate > 0o777) {
    throw pathError("invalid_path", `${label} mode must be between 0000 and 0777.`, null);
  }
  return candidate;
}

function requireLinuxUid(): number {
  if (process.platform !== "linux" || process.getuid === undefined) {
    throw pathError("unsupported_platform", "Secure HostDeck local paths require Linux user ownership semantics.", null);
  }
  return process.getuid();
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function formatMode(mode: number): string {
  return mode.toString(8).padStart(4, "0");
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function pathError(
  code: HostDeckLocalPathErrorCode,
  message: string,
  path: string | null,
  cause?: unknown
): HostDeckLocalPathError {
  return new HostDeckLocalPathError(code, message, path, { cause });
}
