import { linuxHostDeckLocalPathAdapter } from "./linux-secure-local-path-adapter.js";
import type {
  ExistingHostDeckStatePaths,
  HostDeckLocalPathAdapter,
  HostDeckPathSecurityRepair,
  HostDeckStatePathsInput,
  OpenedSecureHostDeckRegularFile,
  OpenSecureHostDeckRegularFileOptions,
  PreparedHostDeckLocalPaths,
  PreparedHostDeckStatePaths,
  PrepareHostDeckLocalPathsInput,
  ResolvedHostDeckLocalPaths,
  SecureHostDeckRegularFileOptions,
  SecureHostDeckSocketOptions
} from "./secure-local-path-contract.js";
import { hostDeckLocalPathError } from "./secure-local-path-contract.js";
import { windowsHostDeckLocalPathAdapter } from "./windows-secure-local-path-adapter.js";

export {
  type ExistingHostDeckStatePaths,
  type HostDeckLocalPathAdapter,
  HostDeckLocalPathError,
  type HostDeckLocalPathErrorCode,
  type HostDeckPathAclRepair,
  type HostDeckPathModeRepair,
  type HostDeckPathSecurityRepair,
  type HostDeckStatePathsInput,
  type OpenedSecureHostDeckRegularFile,
  type OpenSecureHostDeckRegularFileOptions,
  type PreparedHostDeckLocalPaths,
  type PreparedHostDeckStatePaths,
  type PrepareHostDeckLocalPathsInput,
  type ResolvedHostDeckLocalPaths,
  type SecureHostDeckRegularFileOptions,
  type SecureHostDeckSocketOptions
} from "./secure-local-path-contract.js";
export {
  createWindowsHostDeckLocalPathAdapter,
  resolveNativeWindowsHostDeckDefaultPaths,
  resolveWindowsHostDeckDefaultPaths,
  resolveWindowsHostDeckLocalPathsForRoots
} from "./windows-secure-local-path-adapter.js";

export const nativeHostDeckLocalPathAdapter: HostDeckLocalPathAdapter =
  selectNativeHostDeckLocalPathAdapter();

function selectNativeHostDeckLocalPathAdapter(): HostDeckLocalPathAdapter {
  if (process.platform === "linux" && process.arch === "x64") {
    return linuxHostDeckLocalPathAdapter;
  }
  if (process.platform === "win32" && process.arch === "x64") {
    return windowsHostDeckLocalPathAdapter;
  }
  throw hostDeckLocalPathError(
    "unsupported_platform",
    "HostDeck secure local paths require a supported native x64 host.",
    null
  );
}

export function resolveHostDeckLocalPaths(
  input: PrepareHostDeckLocalPathsInput
): ResolvedHostDeckLocalPaths {
  return nativeHostDeckLocalPathAdapter.resolveLocalPaths(input);
}

export function prepareHostDeckLocalPaths(
  input: PrepareHostDeckLocalPathsInput
): PreparedHostDeckLocalPaths {
  return nativeHostDeckLocalPathAdapter.prepareLocalPaths(input);
}

export function prepareHostDeckDaemonLeasePath(
  paths: ResolvedHostDeckLocalPaths
): readonly HostDeckPathSecurityRepair[] {
  return nativeHostDeckLocalPathAdapter.prepareDaemonLeasePath(paths);
}

export function prepareHostDeckLocalPathsAfterLease(
  paths: ResolvedHostDeckLocalPaths
): PreparedHostDeckLocalPaths {
  return nativeHostDeckLocalPathAdapter.prepareLocalPathsAfterLease(paths);
}

export function prepareHostDeckServiceLocalPathsAfterLease(
  paths: ResolvedHostDeckLocalPaths
): PreparedHostDeckLocalPaths {
  return nativeHostDeckLocalPathAdapter.prepareServiceLocalPathsAfterLease(paths);
}

export function prepareHostDeckStatePaths(
  input: HostDeckStatePathsInput
): PreparedHostDeckStatePaths {
  return nativeHostDeckLocalPathAdapter.prepareStatePaths(input);
}

export function inspectExistingHostDeckStatePaths(
  input: HostDeckStatePathsInput
): ExistingHostDeckStatePaths {
  return nativeHostDeckLocalPathAdapter.inspectExistingStatePaths(input);
}

export function secureHostDeckRegularFile(
  path: string,
  options: SecureHostDeckRegularFileOptions
): HostDeckPathSecurityRepair | null {
  return nativeHostDeckLocalPathAdapter.secureRegularFile(path, options);
}

export function openSecureHostDeckRegularFile(
  path: string,
  options: OpenSecureHostDeckRegularFileOptions
): OpenedSecureHostDeckRegularFile {
  return nativeHostDeckLocalPathAdapter.openSecureRegularFile(path, options);
}

export function secureHostDeckSocket(
  path: string,
  options: SecureHostDeckSocketOptions
): HostDeckPathSecurityRepair | null {
  return nativeHostDeckLocalPathAdapter.secureSocket(path, options);
}
