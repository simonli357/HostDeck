import { linuxHostDeckLocalPathAdapter } from "./linux-secure-local-path-adapter.js";
import type {
  ExistingHostDeckStatePaths,
  HostDeckLocalPathAdapter,
  HostDeckPathModeRepair,
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

export {
  type ExistingHostDeckStatePaths,
  type HostDeckLocalPathAdapter,
  HostDeckLocalPathError,
  type HostDeckLocalPathErrorCode,
  type HostDeckPathModeRepair,
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

export const nativeHostDeckLocalPathAdapter: HostDeckLocalPathAdapter =
  linuxHostDeckLocalPathAdapter;

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
): readonly HostDeckPathModeRepair[] {
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
): HostDeckPathModeRepair | null {
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
): HostDeckPathModeRepair | null {
  return nativeHostDeckLocalPathAdapter.secureSocket(path, options);
}
