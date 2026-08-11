import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync
} from "node:fs";
import { win32 } from "node:path";
import {
  defineHostDeckLocalPathAdapter,
  type ExistingHostDeckStatePaths,
  type HostDeckLocalPathAdapter,
  HostDeckLocalPathError,
  type HostDeckLocalPathErrorCode,
  type HostDeckPathAclRepair,
  type HostDeckPathDialect,
  type HostDeckPathSecurityRepair,
  type HostDeckStatePathsInput,
  hostDeckLocalPathError,
  type OpenedSecureHostDeckRegularFile,
  type OpenSecureHostDeckRegularFileOptions,
  type PreparedHostDeckLocalPaths,
  type PreparedHostDeckStatePaths,
  type PrepareHostDeckLocalPathsInput,
  type ResolvedHostDeckLocalPaths,
  resolveHostDeckAbsolutePath,
  resolveHostDeckPathRoots,
  resolveHostDeckStatePathRoots,
  type SecureHostDeckRegularFileOptions,
  type SecureHostDeckSocketOptions
} from "./secure-local-path-contract.js";
import {
  nativeWindowsFileSecurityPort,
  type WindowsFileIdentity,
  type WindowsKnownFolderRoots,
  WindowsNativeFileSecurityError,
  type WindowsNativeFileSecurityPort,
  type WindowsNativePathInspection
} from "./windows-native-file-security.js";

const windowsPathDialect = Object.freeze({
  family: "windows",
  separator: win32.sep,
  dirname: win32.dirname,
  isAbsolute: win32.isAbsolute,
  relative: win32.relative,
  resolve: win32.resolve,
  root: (path: string) => win32.parse(path).root
}) satisfies HostDeckPathDialect;

const sensitiveFileMode = 0o600;
const maximumWindowsComponentCharacters = 255;
const invalidWindowsComponentPattern = /[<>:"/\\|?*]/u;
const reservedWindowsNamePattern = /^(?:AUX|CLOCK\$|CON|CONIN\$|CONOUT\$|NUL|PRN|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])$/iu;

type WindowsOrdinalComparator = (left: string, right: string) => boolean;

interface WindowsOwnedRoot {
  readonly anchor: string;
  readonly owner_root: string;
}

interface WindowsRootPolicy {
  readonly config: WindowsOwnedRoot;
  readonly runtime: WindowsOwnedRoot;
  readonly state: WindowsOwnedRoot;
}

interface ResolvedWindowsLocalPaths {
  readonly paths: ResolvedHostDeckLocalPaths;
  readonly policy: WindowsRootPolicy;
}

interface NodeFileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

export function resolveWindowsHostDeckDefaultPaths(
  roots: WindowsKnownFolderRoots
): PrepareHostDeckLocalPathsInput {
  const policy = createRootPolicy(roots);
  const configDir = policy.config.owner_root;
  const stateDir = policy.state.owner_root;
  return Object.freeze({
    config_dir: configDir,
    state_dir: stateDir,
    runtime_dir: policy.runtime.owner_root,
    database_path: win32.join(stateDir, "hostdeck.sqlite")
  });
}

export function resolveNativeWindowsHostDeckDefaultPaths(): PrepareHostDeckLocalPathsInput {
  try {
    return resolveWindowsHostDeckDefaultPaths(
      nativeWindowsFileSecurityPort.currentUserRoots()
    );
  } catch (error) {
    throw mapNativeError(error, "Windows known folders", null);
  }
}

export function resolveWindowsHostDeckLocalPathsForRoots(
  input: PrepareHostDeckLocalPathsInput,
  roots: WindowsKnownFolderRoots,
  equalOrdinalIgnoreCase: WindowsOrdinalComparator
): ResolvedHostDeckLocalPaths {
  const policy = createRootPolicy(roots);
  const resolved = resolveHostDeckPathRoots(input, windowsPathDialect);
  assertSafeWindowsPath(resolved.config_dir, "config_dir");
  assertSafeWindowsPath(resolved.state_dir, "state_dir");
  assertSafeWindowsPath(resolved.runtime_dir, "runtime_dir");
  assertSafeWindowsPath(resolved.database_path, "database_path");
  assertSameOrDescendant(
    resolved.config_dir,
    policy.config.owner_root,
    equalOrdinalIgnoreCase,
    "config_dir"
  );
  assertSameOrDescendant(
    resolved.state_dir,
    policy.state.owner_root,
    equalOrdinalIgnoreCase,
    "state_dir"
  );
  assertSameOrDescendant(
    resolved.runtime_dir,
    policy.runtime.owner_root,
    equalOrdinalIgnoreCase,
    "runtime_dir"
  );

  const leasePath = win32.join(resolved.state_dir, "hostdeck.lock");
  const appServerSocketPath = win32.join(
    resolved.runtime_dir,
    "app-server.endpoint"
  );
  for (const reservedPath of [leasePath, appServerSocketPath]) {
    if (equalOrdinalIgnoreCase(reservedPath, resolved.database_path)) {
      throw pathError(
        "invalid_path",
        "Database path collides with a reserved HostDeck path.",
        resolved.database_path
      );
    }
  }
  return Object.freeze({
    ...resolved,
    lease_path: leasePath,
    app_server_socket_path: appServerSocketPath
  });
}

export function createWindowsHostDeckLocalPathAdapter(
  nativeSecurity: WindowsNativeFileSecurityPort
): HostDeckLocalPathAdapter {
  const resolveLocalPaths = (
    input: PrepareHostDeckLocalPathsInput
  ): ResolvedHostDeckLocalPaths => resolveWithPolicy(input, nativeSecurity).paths;

  const prepareDaemonLeasePath = (
    paths: ResolvedHostDeckLocalPaths
  ): readonly HostDeckPathAclRepair[] => {
    const resolved = validateResolvedPaths(paths, nativeSecurity);
    const repairs: HostDeckPathAclRepair[] = [];
    ensureOwnedDirectory(
      nativeSecurity,
      resolved.policy,
      resolved.paths.state_dir,
      "state_dir",
      true,
      true,
      repairs
    );
    const leaseRepair = secureRegularFile(resolved.paths.lease_path, {
      create: true,
      label: "daemon lease",
      mode: sensitiveFileMode,
      repair_mode: true
    });
    if (leaseRepair !== null) repairs.push(requireAclRepair(leaseRepair));
    return freezeRepairs(repairs);
  };

  const prepareLocalPathsAfterLease = (
    paths: ResolvedHostDeckLocalPaths
  ): PreparedHostDeckLocalPaths => {
    const resolved = validateResolvedPaths(paths, nativeSecurity);
    const repairs: HostDeckPathAclRepair[] = [];
    ensureOwnedDirectory(
      nativeSecurity,
      resolved.policy,
      resolved.paths.config_dir,
      "config_dir",
      true,
      true,
      repairs
    );
    ensureOwnedDirectory(
      nativeSecurity,
      resolved.policy,
      resolved.paths.runtime_dir,
      "runtime_dir",
      true,
      true,
      repairs
    );
    ensureOwnedDirectory(
      nativeSecurity,
      resolved.policy,
      win32.dirname(resolved.paths.database_path),
      "database parent",
      true,
      true,
      repairs
    );
    return Object.freeze({
      ...resolved.paths,
      repairs: freezeRepairs(repairs)
    });
  };

  const prepareServiceLocalPathsAfterLease = (
    paths: ResolvedHostDeckLocalPaths
  ): PreparedHostDeckLocalPaths => {
    const resolved = validateResolvedPaths(paths, nativeSecurity);
    const repairs: HostDeckPathAclRepair[] = [];
    ensureOwnedDirectory(
      nativeSecurity,
      resolved.policy,
      resolved.paths.config_dir,
      "config_dir",
      true,
      true,
      repairs
    );
    ensureOwnedDirectory(
      nativeSecurity,
      resolved.policy,
      resolved.paths.runtime_dir,
      "runtime_dir",
      false,
      false,
      repairs
    );
    ensureOwnedDirectory(
      nativeSecurity,
      resolved.policy,
      win32.dirname(resolved.paths.database_path),
      "database parent",
      true,
      true,
      repairs
    );
    return Object.freeze({
      ...resolved.paths,
      repairs: freezeRepairs(repairs)
    });
  };

  const prepareLocalPaths = (
    input: PrepareHostDeckLocalPathsInput
  ): PreparedHostDeckLocalPaths => {
    const paths = resolveLocalPaths(input);
    const leaseRepairs = prepareDaemonLeasePath(paths);
    const prepared = prepareLocalPathsAfterLease(paths);
    return Object.freeze({
      ...prepared,
      repairs: freezeRepairs([
        ...leaseRepairs.map(requireAclRepair),
        ...prepared.repairs.map(requireAclRepair)
      ])
    });
  };

  const prepareStatePaths = (
    input: HostDeckStatePathsInput
  ): PreparedHostDeckStatePaths => {
    const resolved = resolveStateWithPolicy(input, nativeSecurity);
    const repairs: HostDeckPathAclRepair[] = [];
    ensureOwnedDirectory(
      nativeSecurity,
      resolved.policy,
      resolved.roots.state_dir,
      "state_dir",
      true,
      true,
      repairs
    );
    ensureOwnedDirectory(
      nativeSecurity,
      resolved.policy,
      win32.dirname(resolved.roots.database_path),
      "database parent",
      true,
      true,
      repairs
    );
    const databaseRepair = secureRegularFile(resolved.roots.database_path, {
      create: true,
      label: "database",
      mode: sensitiveFileMode,
      repair_mode: true
    });
    if (databaseRepair !== null) {
      repairs.push(requireAclRepair(databaseRepair));
    }
    return Object.freeze({
      ...resolved.roots,
      repairs: freezeRepairs(repairs)
    });
  };

  const inspectExistingStatePaths = (
    input: HostDeckStatePathsInput
  ): ExistingHostDeckStatePaths => {
    const resolved = resolveStateWithPolicy(input, nativeSecurity);
    const ignoredRepairs: HostDeckPathAclRepair[] = [];
    ensureOwnedDirectory(
      nativeSecurity,
      resolved.policy,
      resolved.roots.state_dir,
      "state_dir",
      false,
      false,
      ignoredRepairs
    );
    ensureOwnedDirectory(
      nativeSecurity,
      resolved.policy,
      win32.dirname(resolved.roots.database_path),
      "database parent",
      false,
      false,
      ignoredRepairs
    );
    return resolved.roots;
  };

  const openSecureRegularFile = (
    path: string,
    options: OpenSecureHostDeckRegularFileOptions
  ): OpenedSecureHostDeckRegularFile => {
    validateWindowsMode(options.mode, options.label);
    const parsedPath = resolveHostDeckAbsolutePath(
      path,
      options.label,
      windowsPathDialect
    );
    assertSafeWindowsPath(parsedPath, options.label);
    const policy = rootPolicyFromNative(nativeSecurity);
    const owner = ownedRootForPath(
      parsedPath,
      policy,
      nativeSecurity.equalOrdinalIgnoreCase,
      true
    );
    const noRepairs: HostDeckPathAclRepair[] = [];
    ensureDirectoryFromRoot(
      nativeSecurity,
      owner,
      win32.dirname(parsedPath),
      `${options.label} parent`,
      false,
      false,
      noRepairs
    );
    const exists = inspectFinalEntryCase(
      nativeSecurity,
      parsedPath,
      options.create === true
    );
    if (exists) {
      assertSafeInspection(
        nativeSecurity,
        inspectPath(nativeSecurity, parsedPath, options.label),
        parsedPath,
        options.label,
        "file",
        false,
        true,
        options.repair_mode !== true
      );
    }
    const descriptor = openRegularFile(
      parsedPath,
      options.label,
      options.create === true,
      options.writable === true
    );
    try {
      inspectFinalEntryCase(nativeSecurity, parsedPath, false);
      const originalNodeIdentity = nodeFileIdentity(descriptor, parsedPath, options.label);
      const originalNativeIdentity = validateOpenFile(
        nativeSecurity,
        descriptor,
        parsedPath,
        options.label,
        false,
        options.repair_mode !== true
      );
      let repair: HostDeckPathAclRepair | null = null;
      const before = inspectDescriptor(nativeSecurity, descriptor, parsedPath, options.label);
      const beforePath = inspectPath(nativeSecurity, parsedPath, options.label);
      if (
        !before.owner_current_user ||
        !beforePath.owner_current_user ||
        !before.acl_current_user_only ||
        !beforePath.acl_current_user_only
      ) {
        if (options.repair_mode !== true) {
          if (!before.owner_current_user || !beforePath.owner_current_user) {
            throw pathError(
              "wrong_owner",
              `${options.label} must be owned by the current Windows user.`,
              parsedPath
            );
          }
          throw pathError(
            "permission_update_failed",
            `${options.label} must have a current-user-only ACL.`,
            parsedPath
          );
        }
        const result = secureCurrentUserOnly(
          nativeSecurity,
          parsedPath,
          "file",
          options.label
        );
        assertSameNativeIdentity(
          result.inspection.identity,
          originalNativeIdentity,
          parsedPath,
          options.label
        );
        if (
          !result.repaired ||
          !result.inspection.owner_current_user ||
          !result.inspection.acl_current_user_only
        ) {
          throw pathError(
            "permission_update_failed",
            `${options.label} ownership or ACL remained insecure after repair.`,
            parsedPath
          );
        }
        repair = freezeAclRepair(parsedPath, "file");
      }

      const verifyPath = (): void => {
        assertSameNodeIdentity(
          nodeFileIdentity(descriptor, parsedPath, options.label),
          originalNodeIdentity,
          parsedPath,
          options.label
        );
        assertSameNativeIdentity(
          validateOpenFile(
            nativeSecurity,
            descriptor,
            parsedPath,
            options.label,
            true
          ),
          originalNativeIdentity,
          parsedPath,
          options.label
        );
      };
      verifyPath();
      return {
        descriptor,
        path: parsedPath,
        repair,
        verifyPath
      };
    } catch (error) {
      closeSync(descriptor);
      throw error;
    }
  };

  const secureRegularFile = (
    path: string,
    options: SecureHostDeckRegularFileOptions
  ): HostDeckPathSecurityRepair | null => {
    const opened = openSecureRegularFile(path, options);
    try {
      return opened.repair;
    } finally {
      closeSync(opened.descriptor);
    }
  };

  const secureSocket = (
    _path: string,
    _options: SecureHostDeckSocketOptions
  ): HostDeckPathSecurityRepair | null => {
    throw pathError(
      "unsupported_platform",
      "Windows HostDeck paths do not support Unix sockets.",
      null
    );
  };

  return defineHostDeckLocalPathAdapter({
    target: "windows-x64",
    path_family: "windows",
    path_security: "current_user_acl",
    resolveLocalPaths,
    prepareLocalPaths,
    prepareDaemonLeasePath,
    prepareLocalPathsAfterLease,
    prepareServiceLocalPathsAfterLease,
    prepareStatePaths,
    inspectExistingStatePaths,
    secureRegularFile,
    openSecureRegularFile,
    secureSocket
  });
}

function resolveWithPolicy(
  input: PrepareHostDeckLocalPathsInput,
  nativeSecurity: WindowsNativeFileSecurityPort
): ResolvedWindowsLocalPaths {
  const policy = rootPolicyFromNative(nativeSecurity);
  return Object.freeze({
    paths: resolveWindowsHostDeckLocalPathsForRoots(
      input,
      rootsFromPolicy(policy),
      nativeSecurity.equalOrdinalIgnoreCase
    ),
    policy
  });
}

function resolveStateWithPolicy(
  input: HostDeckStatePathsInput,
  nativeSecurity: WindowsNativeFileSecurityPort
): Readonly<{
  policy: WindowsRootPolicy;
  roots: HostDeckStatePathsInput;
}> {
  const policy = rootPolicyFromNative(nativeSecurity);
  const roots = resolveHostDeckStatePathRoots(input, windowsPathDialect);
  assertSafeWindowsPath(roots.state_dir, "state_dir");
  assertSafeWindowsPath(roots.database_path, "database_path");
  assertSameOrDescendant(
    roots.state_dir,
    policy.state.owner_root,
    nativeSecurity.equalOrdinalIgnoreCase,
    "state_dir"
  );
  return Object.freeze({ policy, roots });
}

function validateResolvedPaths(
  paths: ResolvedHostDeckLocalPaths,
  nativeSecurity: WindowsNativeFileSecurityPort
): ResolvedWindowsLocalPaths {
  const resolved = resolveWithPolicy(
    {
      config_dir: paths.config_dir,
      database_path: paths.database_path,
      runtime_dir: paths.runtime_dir,
      state_dir: paths.state_dir
    },
    nativeSecurity
  );
  if (
    !nativeSecurity.equalOrdinalIgnoreCase(
      paths.lease_path,
      resolved.paths.lease_path
    ) ||
    !nativeSecurity.equalOrdinalIgnoreCase(
      paths.app_server_socket_path,
      resolved.paths.app_server_socket_path
    )
  ) {
    throw pathError(
      "invalid_path",
      "Derived HostDeck lease or app-server endpoint path is invalid.",
      null
    );
  }
  return resolved;
}

function rootPolicyFromNative(
  nativeSecurity: WindowsNativeFileSecurityPort
): WindowsRootPolicy {
  try {
    return createRootPolicy(nativeSecurity.currentUserRoots());
  } catch (error) {
    throw mapNativeError(error, "Windows known folders", null);
  }
}

function createRootPolicy(roots: WindowsKnownFolderRoots): WindowsRootPolicy {
  const roaming = resolveHostDeckAbsolutePath(
    roots.roaming_app_data,
    "Roaming AppData",
    windowsPathDialect
  );
  const local = resolveHostDeckAbsolutePath(
    roots.local_app_data,
    "Local AppData",
    windowsPathDialect
  );
  assertSafeWindowsPath(roaming, "Roaming AppData");
  assertSafeWindowsPath(local, "Local AppData");
  return Object.freeze({
    config: Object.freeze({
      anchor: roaming,
      owner_root: win32.join(roaming, "HostDeck")
    }),
    runtime: Object.freeze({
      anchor: local,
      owner_root: win32.join(local, "HostDeck", "Runtime")
    }),
    state: Object.freeze({
      anchor: local,
      owner_root: win32.join(local, "HostDeck", "State")
    })
  });
}

function rootsFromPolicy(policy: WindowsRootPolicy): WindowsKnownFolderRoots {
  return Object.freeze({
    local_app_data: policy.state.anchor,
    roaming_app_data: policy.config.anchor
  });
}

function ensureOwnedDirectory(
  nativeSecurity: WindowsNativeFileSecurityPort,
  policy: WindowsRootPolicy,
  path: string,
  label: string,
  create: boolean,
  repairAcl: boolean,
  repairs: HostDeckPathAclRepair[]
): void {
  const owner = ownedRootForPath(
    path,
    policy,
    nativeSecurity.equalOrdinalIgnoreCase,
    false
  );
  ensureDirectoryFromRoot(
    nativeSecurity,
    owner,
    path,
    label,
    create,
    repairAcl,
    repairs
  );
}

function ensureDirectoryFromRoot(
  nativeSecurity: WindowsNativeFileSecurityPort,
  owner: WindowsOwnedRoot,
  path: string,
  label: string,
  create: boolean,
  repairAcl: boolean,
  repairs: HostDeckPathAclRepair[]
): void {
  inspectAnchorDirectory(nativeSecurity, owner.anchor, label);
  const relativePath = win32.relative(owner.anchor, path);
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith(`..${win32.sep}`) ||
    win32.isAbsolute(relativePath)
  ) {
    throw pathError(
      "invalid_path",
      `${label} must remain below its Windows known-folder root.`,
      path
    );
  }

  let parent = owner.anchor;
  for (const segment of relativePath.split(win32.sep)) {
    const selected = selectDirectoryEntry(
      nativeSecurity,
      parent,
      segment,
      label
    );
    const candidate = win32.join(parent, segment);
    if (selected === null) {
      if (!create) {
        throw pathError(
          "invalid_path",
          `${label} does not exist.`,
          candidate
        );
      }
      try {
        mkdirSync(candidate);
      } catch (error) {
        if (!isErrno(error, "EEXIST")) {
          throw pathError(
            "invalid_path",
            `${label} could not be created.`,
            candidate,
            error
          );
        }
      }
      if (
        selectDirectoryEntry(nativeSecurity, parent, segment, label) === null
      ) {
        throw pathError(
          "path_substitution",
          `${label} changed during creation.`,
          candidate
        );
      }
    }

    const before = inspectPath(nativeSecurity, candidate, label);
    assertSafeInspection(
      nativeSecurity,
      before,
      candidate,
      label,
      "directory",
      false,
      true,
      false
    );
    if (!before.owner_current_user || !before.acl_current_user_only) {
      if (!repairAcl) {
        if (!before.owner_current_user) {
          throw pathError(
            "wrong_owner",
            `${label} must be owned by the current Windows user.`,
            candidate
          );
        }
        throw pathError(
          "permission_update_failed",
          `${label} must have a current-user-only ACL.`,
          candidate
        );
      }
      const result = secureCurrentUserOnly(
        nativeSecurity,
        candidate,
        "directory",
        label
      );
      assertSameNativeIdentity(
        result.inspection.identity,
        before.identity,
        candidate,
        label
      );
      if (
        !result.repaired ||
        !result.inspection.owner_current_user ||
        !result.inspection.acl_current_user_only
      ) {
        throw pathError(
          "permission_update_failed",
          `${label} ownership or ACL remained insecure after repair.`,
          candidate
        );
      }
      repairs.push(freezeAclRepair(candidate, "directory"));
    }
    const verified = inspectPath(nativeSecurity, candidate, label);
    assertSafeInspection(
      nativeSecurity,
      verified,
      candidate,
      label,
      "directory",
      true
    );
    assertSameNativeIdentity(
      verified.identity,
      before.identity,
      candidate,
      label
    );
    if (
      selectDirectoryEntry(nativeSecurity, parent, segment, label) === null
    ) {
      throw pathError(
        "path_substitution",
        `${label} changed during validation.`,
        candidate
      );
    }
    parent = candidate;
  }
}

function inspectAnchorDirectory(
  nativeSecurity: WindowsNativeFileSecurityPort,
  anchor: string,
  label: string
): void {
  const inspection = inspectPath(nativeSecurity, anchor, label);
  assertSafeInspection(
    nativeSecurity,
    inspection,
    anchor,
    label,
    "directory",
    false,
    true,
    false
  );
}

function selectDirectoryEntry(
  nativeSecurity: WindowsNativeFileSecurityPort,
  parent: string,
  expectedName: string,
  label: string
): string | null {
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch (error) {
    throw pathError(
      "invalid_path",
      `${label} parent could not be enumerated.`,
      parent,
      error
    );
  }
  const matches = entries.filter((entry) =>
    nativeSecurity.equalOrdinalIgnoreCase(entry, expectedName)
  );
  if (matches.length === 0) return null;
  if (matches.length !== 1 || matches[0] !== expectedName) {
    throw pathError(
      "case_collision",
      `${label} contains a noncanonical Windows case collision.`,
      win32.join(parent, expectedName)
    );
  }
  return matches[0];
}

function inspectFinalEntryCase(
  nativeSecurity: WindowsNativeFileSecurityPort,
  path: string,
  allowMissing: boolean
): boolean {
  const selected = selectDirectoryEntry(
    nativeSecurity,
    win32.dirname(path),
    win32.basename(path),
    "file"
  );
  if (selected === null && !allowMissing) {
    throw pathError("invalid_path", "File does not exist.", path);
  }
  return selected !== null;
}

function openRegularFile(
  path: string,
  label: string,
  create: boolean,
  writable: boolean
): number {
  if (create) {
    try {
      const created = openSync(
        path,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR,
        sensitiveFileMode
      );
      closeSync(created);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) {
        throw pathError(
          "invalid_path",
          `${label} could not be created securely.`,
          path,
          error
        );
      }
    }
  }
  try {
    return openSync(path, writable ? fsConstants.O_RDWR : fsConstants.O_RDONLY);
  } catch (error) {
    throw pathError(
      "invalid_path",
      `${label} could not be opened securely.`,
      path,
      error
    );
  }
}

function validateOpenFile(
  nativeSecurity: WindowsNativeFileSecurityPort,
  descriptor: number,
  path: string,
  label: string,
  requireSecureAcl: boolean,
  requireCurrentUserOwner = true
): WindowsFileIdentity {
  const descriptorInspection = inspectDescriptor(
    nativeSecurity,
    descriptor,
    path,
    label
  );
  const pathInspection = inspectPath(nativeSecurity, path, label);
  assertSafeInspection(
    nativeSecurity,
    descriptorInspection,
    path,
    label,
    "file",
    requireSecureAcl,
    false,
    requireCurrentUserOwner
  );
  assertSafeInspection(
    nativeSecurity,
    pathInspection,
    path,
    label,
    "file",
    requireSecureAcl,
    true,
    requireCurrentUserOwner
  );
  assertSameNativeIdentity(
    pathInspection.identity,
    descriptorInspection.identity,
    path,
    label
  );
  assertCanonicalInspection(
    nativeSecurity,
    descriptorInspection,
    path,
    label
  );
  inspectFinalEntryCase(nativeSecurity, path, false);
  return descriptorInspection.identity;
}

function assertSafeInspection(
  nativeSecurity: WindowsNativeFileSecurityPort,
  inspection: WindowsNativePathInspection,
  path: string,
  label: string,
  kind: "directory" | "file",
  requireSecureAcl: boolean,
  requireCanonicalPath = true,
  requireCurrentUserOwner = true
): void {
  if (inspection.is_reparse_point) {
    throw pathError(
      "symlink_rejected",
      `${label} must not be a Windows reparse point.`,
      path
    );
  }
  if (inspection.is_directory !== (kind === "directory")) {
    throw pathError(
      "path_type_mismatch",
      `${label} has the wrong filesystem type.`,
      path
    );
  }
  if (inspection.has_named_streams) {
    throw pathError(
      "alternate_stream_rejected",
      `${label} must not contain alternate data streams.`,
      path
    );
  }
  if (kind === "file" && inspection.link_count !== 1) {
    throw pathError(
      "hard_link_rejected",
      `${label} must have exactly one hard link.`,
      path
    );
  }
  if (requireCanonicalPath) {
    assertCanonicalInspection(nativeSecurity, inspection, path, label);
  }
  if (requireCurrentUserOwner && !inspection.owner_current_user) {
    throw pathError(
      "wrong_owner",
      `${label} must be owned by the current Windows user.`,
      path
    );
  }
  if (requireSecureAcl && !inspection.acl_current_user_only) {
    throw pathError(
      "permission_update_failed",
      `${label} must have a current-user-only ACL.`,
      path
    );
  }
}

function assertCanonicalInspection(
  nativeSecurity: WindowsNativeFileSecurityPort,
  inspection: WindowsNativePathInspection,
  path: string,
  label: string
): void {
  if (
    !nativeSecurity.equalOrdinalIgnoreCase(inspection.canonical_path, path)
  ) {
    throw pathError(
      "path_not_canonical",
      `${label} must resolve to its canonical Windows path.`,
      path
    );
  }
}

function inspectPath(
  nativeSecurity: WindowsNativeFileSecurityPort,
  path: string,
  label: string
): WindowsNativePathInspection {
  try {
    return nativeSecurity.inspectPath(path);
  } catch (error) {
    throw mapNativeError(error, label, path);
  }
}

function inspectDescriptor(
  nativeSecurity: WindowsNativeFileSecurityPort,
  descriptor: number,
  path: string,
  label: string
): WindowsNativePathInspection {
  try {
    return nativeSecurity.inspectDescriptor(descriptor);
  } catch (error) {
    throw mapNativeError(error, label, path);
  }
}

function secureCurrentUserOnly(
  nativeSecurity: WindowsNativeFileSecurityPort,
  path: string,
  kind: "directory" | "file",
  label: string
) {
  try {
    return nativeSecurity.secureCurrentUserOnly(path, kind);
  } catch (error) {
    throw mapNativeError(error, label, path);
  }
}

function mapNativeError(
  error: unknown,
  label: string,
  path: string | null
): HostDeckLocalPathError {
  if (error instanceof HostDeckLocalPathError) return error;
  if (error instanceof WindowsNativeFileSecurityError) {
    const code: HostDeckLocalPathErrorCode =
      error.code === "wrong_owner"
        ? "wrong_owner"
        : error.code === "acl_update_failed"
          ? "permission_update_failed"
          : error.code === "unsupported_filesystem"
            ? "unsupported_filesystem"
            : error.code === "unsupported_platform"
              ? "unsupported_platform"
              : error.operation === "path_substitution"
                ? "path_substitution"
                : "invalid_path";
    return pathError(
      code,
      `${label} failed Windows-native security validation.`,
      path,
      error
    );
  }
  return pathError(
    "invalid_path",
    `${label} failed Windows-native security validation.`,
    path,
    error
  );
}

function nodeFileIdentity(
  descriptor: number,
  path: string,
  label: string
): NodeFileIdentity {
  try {
    const metadata = fstatSync(descriptor, { bigint: true });
    if (!metadata.isFile()) {
      throw pathError(
        "path_type_mismatch",
        `${label} must be a regular file.`,
        path
      );
    }
    if (metadata.nlink !== 1n) {
      throw pathError(
        "hard_link_rejected",
        `${label} must have exactly one hard link.`,
        path
      );
    }
    return Object.freeze({ device: metadata.dev, inode: metadata.ino });
  } catch (error) {
    if (error instanceof HostDeckLocalPathError) throw error;
    throw pathError(
      "invalid_path",
      `${label} descriptor could not be inspected.`,
      path,
      error
    );
  }
}

function assertSameNodeIdentity(
  actual: NodeFileIdentity,
  expected: NodeFileIdentity,
  path: string,
  label: string
): void {
  if (actual.device !== expected.device || actual.inode !== expected.inode) {
    throw pathError(
      "path_substitution",
      `${label} path changed during validation.`,
      path
    );
  }
}

function assertSameNativeIdentity(
  actual: WindowsFileIdentity,
  expected: WindowsFileIdentity,
  path: string,
  label: string
): void {
  if (
    actual.file_index !== expected.file_index ||
    actual.volume_serial_number !== expected.volume_serial_number
  ) {
    throw pathError(
      "path_substitution",
      `${label} path changed during validation.`,
      path
    );
  }
}

function ownedRootForPath(
  path: string,
  policy: WindowsRootPolicy,
  equalOrdinalIgnoreCase: WindowsOrdinalComparator,
  requireDescendant: boolean
): WindowsOwnedRoot {
  for (const candidate of [policy.config, policy.state, policy.runtime]) {
    if (
      isSameOrDescendant(
        path,
        candidate.owner_root,
        equalOrdinalIgnoreCase,
        requireDescendant
      )
    ) {
      return candidate;
    }
  }
  throw pathError(
    "invalid_path",
    "Path must remain inside its current-user HostDeck root.",
    path
  );
}

function assertSameOrDescendant(
  path: string,
  parent: string,
  equalOrdinalIgnoreCase: WindowsOrdinalComparator,
  label: string
): void {
  if (!isSameOrDescendant(path, parent, equalOrdinalIgnoreCase, false)) {
    throw pathError(
      "invalid_path",
      `${label} must remain inside its current-user HostDeck root.`,
      path
    );
  }
}

function isSameOrDescendant(
  path: string,
  parent: string,
  equalOrdinalIgnoreCase: WindowsOrdinalComparator,
  requireDescendant: boolean
): boolean {
  const pathParts = windowsPathParts(path);
  const parentParts = windowsPathParts(parent);
  if (
    pathParts.length < parentParts.length + (requireDescendant ? 1 : 0)
  ) {
    return false;
  }
  return parentParts.every((part, index) =>
    equalOrdinalIgnoreCase(part, pathParts[index] ?? "")
  );
}

function windowsPathParts(path: string): readonly string[] {
  return Object.freeze([
    path.slice(0, 2),
    ...path.slice(3).split(win32.sep).filter((segment) => segment.length > 0)
  ]);
}

function assertSafeWindowsPath(path: string, label: string): void {
  if (
    !/^[A-Za-z]:\\/u.test(path) ||
    path.startsWith("\\\\") ||
    path.slice(2).includes(":")
  ) {
    throw pathError(
      "invalid_path",
      `${label} must use one local Windows drive with no device namespace or stream.`,
      path
    );
  }
  for (const segment of path.slice(3).split(win32.sep)) {
    if (
      segment.length === 0 ||
      segment.length > maximumWindowsComponentCharacters ||
      segment.endsWith(".") ||
      segment.endsWith(" ") ||
      invalidWindowsComponentPattern.test(segment)
    ) {
      throw pathError(
        "invalid_path",
        `${label} contains an invalid Windows path component.`,
        path
      );
    }
    const deviceStem = segment.split(".", 1)[0] ?? "";
    if (reservedWindowsNamePattern.test(deviceStem)) {
      throw pathError(
        "reserved_name_rejected",
        `${label} contains a reserved Windows device name.`,
        path
      );
    }
  }
}

function validateWindowsMode(mode: number | undefined, label: string): void {
  if (mode !== undefined && mode !== sensitiveFileMode) {
    throw pathError(
      "invalid_path",
      `${label} must use the HostDeck sensitive-file policy on Windows.`,
      null
    );
  }
}

function freezeAclRepair(
  path: string,
  kind: HostDeckPathAclRepair["kind"]
): HostDeckPathAclRepair {
  return Object.freeze({
    path,
    kind,
    from_acl: "not_current_user_only",
    to_acl: "current_user_only"
  });
}

function freezeRepairs(
  repairs: readonly HostDeckPathAclRepair[]
): readonly HostDeckPathAclRepair[] {
  return Object.freeze(repairs.map((repair) => Object.freeze({ ...repair })));
}

function requireAclRepair(
  repair: HostDeckPathSecurityRepair
): HostDeckPathAclRepair {
  if (!("from_acl" in repair)) {
    throw new TypeError("Windows path adapter produced a non-ACL repair.");
  }
  return repair;
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
  return hostDeckLocalPathError(code, message, path, cause);
}

export const windowsHostDeckLocalPathAdapter: HostDeckLocalPathAdapter =
  createWindowsHostDeckLocalPathAdapter(nativeWindowsFileSecurityPort);
