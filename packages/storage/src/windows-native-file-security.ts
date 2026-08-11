import { win32 } from "node:path";
import koffi from "koffi";

export type WindowsNativeFileSecurityErrorCode =
  | "acl_update_failed"
  | "native_call_failed"
  | "path_unavailable"
  | "unsupported_filesystem"
  | "unsupported_platform"
  | "wrong_owner";

export class WindowsNativeFileSecurityError extends Error {
  constructor(
    readonly code: WindowsNativeFileSecurityErrorCode,
    readonly operation: string,
    readonly native_error: number | null = null
  ) {
    super(`Windows file-security operation ${operation} failed.`);
    this.name = "WindowsNativeFileSecurityError";
  }
}

export interface WindowsKnownFolderRoots {
  readonly local_app_data: string;
  readonly roaming_app_data: string;
}

export interface WindowsFileIdentity {
  readonly file_index: string;
  readonly volume_serial_number: number;
}

export interface WindowsNativePathInspection {
  readonly acl_current_user_only: boolean;
  readonly canonical_path: string;
  readonly file_system: "NTFS";
  readonly has_named_streams: boolean;
  readonly identity: WindowsFileIdentity;
  readonly is_directory: boolean;
  readonly is_reparse_point: boolean;
  readonly link_count: number;
  readonly owner_current_user: boolean;
}

export interface WindowsNativeAclResult {
  readonly inspection: WindowsNativePathInspection;
  readonly repaired: boolean;
}

export interface WindowsNativeFileSecurityPort {
  readonly currentUserRoots: () => WindowsKnownFolderRoots;
  readonly equalOrdinalIgnoreCase: (left: string, right: string) => boolean;
  readonly inspectDescriptor: (
    descriptor: number
  ) => WindowsNativePathInspection;
  readonly inspectPath: (path: string) => WindowsNativePathInspection;
  readonly secureCurrentUserOnly: (
    path: string,
    kind: "directory" | "file"
  ) => WindowsNativeAclResult;
}

const csidlAppData = 0x001a;
const csidlLocalAppData = 0x001c;
const shgfpTypeCurrent = 0;
const maximumWindowsPathCharacters = 32_767;
const maximumKnownFolderCharacters = 260;
const fileAttributeDirectory = 0x0000_0010;
const fileAttributeReparsePoint = 0x0000_0400;
const fileFlagBackupSemantics = 0x0200_0000;
const fileFlagOpenReparsePoint = 0x0020_0000;
const fileReadAttributes = 0x0000_0080;
const openExisting = 3;
const readControl = 0x0002_0000;
const writeDac = 0x0004_0000;
const writeOwner = 0x0008_0000;
const fileShareRead = 0x0000_0001;
const fileShareWrite = 0x0000_0002;
const fileShareDelete = 0x0000_0004;
const tokenQuery = 0x0000_0008;
const tokenUser = 1;
const errorHandleEof = 38;
const errorNoMoreFiles = 18;
const errorInsufficientBuffer = 122;
const ownerSecurityInformation = 0x0000_0001;
const daclSecurityInformation = 0x0000_0004;
const protectedDaclSecurityInformation = 0x8000_0000;
const seFileObject = 1;
const sddlRevision1 = 1;
const driveFixed = 3;
const filePersistentAcls = 0x0000_0008;
const fileNamedStreams = 0x0004_0000;
const cstrEqual = 2;
const streamDataCharacters = 296;
const streamDataNameOffset = 8;
const streamDataBytes = streamDataNameOffset + streamDataCharacters * 2;

let bindingsCache: ReturnType<typeof createWindowsBindings> | null = null;
let currentUserSidCache: string | null = null;
const expectedSddlCache = new Map<"directory" | "file", string>();

export const nativeWindowsFileSecurityPort: WindowsNativeFileSecurityPort =
  Object.freeze({
    currentUserRoots,
    equalOrdinalIgnoreCase,
    inspectDescriptor,
    inspectPath,
    secureCurrentUserOnly
  });

function currentUserRoots(): WindowsKnownFolderRoots {
  const bindings = windowsBindings();
  const roots = {
    local_app_data: knownFolder(bindings, csidlLocalAppData, "local_app_data"),
    roaming_app_data: knownFolder(bindings, csidlAppData, "roaming_app_data")
  };
  return Object.freeze(roots);
}

function equalOrdinalIgnoreCase(left: string, right: string): boolean {
  const result = windowsBindings().CompareStringOrdinal(
    left,
    left.length,
    right,
    right.length,
    1
  ) as number;
  if (result === 0) throw nativeError("CompareStringOrdinal");
  return result === cstrEqual;
}

function inspectPath(path: string): WindowsNativePathInspection {
  const bindings = windowsBindings();
  const handle = openPathHandle(bindings, path, readControl | fileReadAttributes);
  try {
    return inspectHandle(bindings, handle);
  } finally {
    closeHandle(bindings, handle);
  }
}

function inspectDescriptor(descriptor: number): WindowsNativePathInspection {
  if (!Number.isSafeInteger(descriptor) || descriptor < 0) {
    throw new WindowsNativeFileSecurityError(
      "path_unavailable",
      "descriptor"
    );
  }
  const bindings = windowsBindings();
  const handle = bindings.GetOsFileHandle(descriptor) as bigint;
  if (isInvalidHandle(handle)) {
    throw new WindowsNativeFileSecurityError(
      "path_unavailable",
      "_get_osfhandle",
      lastError(bindings)
    );
  }
  return inspectHandle(bindings, handle);
}

function secureCurrentUserOnly(
  path: string,
  kind: "directory" | "file"
): WindowsNativeAclResult {
  const bindings = windowsBindings();
  const handle = openPathHandle(
    bindings,
    path,
    readControl | writeDac | writeOwner | fileReadAttributes
  );
  try {
    const before = inspectHandle(bindings, handle);
    if (before.is_directory !== (kind === "directory")) {
      throw new WindowsNativeFileSecurityError(
        "path_unavailable",
        "path_type"
      );
    }
    if (before.acl_current_user_only) {
      return Object.freeze({ inspection: before, repaired: false });
    }

    applyCurrentUserSecurity(bindings, handle, kind);
    const afterAcl = inspectCurrentUserAcl(bindings, handle, kind);
    if (!afterAcl.owner_current_user) {
      throw new WindowsNativeFileSecurityError(
        "acl_update_failed",
        "verify_owner"
      );
    }
    if (!afterAcl.current_user_only) {
      throw new WindowsNativeFileSecurityError(
        "acl_update_failed",
        "verify_dacl"
      );
    }
    const after = inspectHandle(bindings, handle);
    assertSameIdentity(before.identity, after.identity);
    return Object.freeze({ inspection: after, repaired: true });
  } finally {
    closeHandle(bindings, handle);
  }
}

function inspectHandle(
  bindings: ReturnType<typeof createWindowsBindings>,
  handle: bigint
): WindowsNativePathInspection {
  const info: Record<string, unknown> = {};
  if (!(bindings.GetFileInformationByHandle(handle, info) as boolean)) {
    throw nativeError("GetFileInformationByHandle");
  }
  const attributes = numberField(info, "dwFileAttributes");
  const linkCount = numberField(info, "nNumberOfLinks");
  const canonicalPath = finalPath(bindings, handle);
  const volume = inspectVolume(bindings, canonicalPath);
  const acl = inspectCurrentUserAcl(
    bindings,
    handle,
    (attributes & fileAttributeDirectory) !== 0 ? "directory" : "file"
  );
  const inspection: WindowsNativePathInspection = {
    acl_current_user_only:
      acl.owner_current_user && acl.current_user_only,
    canonical_path: canonicalPath,
    file_system: volume.file_system,
    has_named_streams: hasNamedStreams(bindings, canonicalPath),
    identity: Object.freeze({
      file_index: combineUnsigned64(
        numberField(info, "nFileIndexHigh"),
        numberField(info, "nFileIndexLow")
      ).toString(16),
      volume_serial_number: numberField(info, "dwVolumeSerialNumber")
    }),
    is_directory: (attributes & fileAttributeDirectory) !== 0,
    is_reparse_point: (attributes & fileAttributeReparsePoint) !== 0,
    link_count: linkCount,
    owner_current_user: acl.owner_current_user
  };
  return deepFreezeInspection(inspection);
}

function inspectVolume(
  bindings: ReturnType<typeof createWindowsBindings>,
  path: string
): Readonly<{ file_system: "NTFS" }> {
  const volumePathBuffer = Buffer.alloc(maximumWindowsPathCharacters * 2);
  if (
    !(bindings.GetVolumePathNameW(
      path,
      volumePathBuffer,
      maximumWindowsPathCharacters
    ) as boolean)
  ) {
    throw nativeError("GetVolumePathNameW");
  }
  const volumePath = decodeNullTerminatedUtf16(volumePathBuffer);
  if ((bindings.GetDriveTypeW(volumePath) as number) !== driveFixed) {
    throw new WindowsNativeFileSecurityError(
      "unsupported_filesystem",
      "drive_type"
    );
  }
  const fileSystemBuffer = Buffer.alloc(64 * 2);
  const flags = [0];
  if (
    !(bindings.GetVolumeInformationW(
      volumePath,
      null,
      0,
      null,
      null,
      flags,
      fileSystemBuffer,
      64
    ) as boolean)
  ) {
    throw nativeError("GetVolumeInformationW");
  }
  const fileSystem = decodeNullTerminatedUtf16(fileSystemBuffer);
  if (
    fileSystem !== "NTFS" ||
    ((flags[0] ?? 0) & filePersistentAcls) === 0 ||
    ((flags[0] ?? 0) & fileNamedStreams) === 0
  ) {
    throw new WindowsNativeFileSecurityError(
      "unsupported_filesystem",
      "volume_capabilities"
    );
  }
  return Object.freeze({ file_system: "NTFS" as const });
}

function hasNamedStreams(
  bindings: ReturnType<typeof createWindowsBindings>,
  path: string
): boolean {
  const streamData = Buffer.alloc(streamDataBytes);
  const search = bindings.FindFirstStreamW(path, 0, streamData, 0) as bigint;
  if (isInvalidHandle(search)) {
    const error = lastError(bindings);
    if (error === errorHandleEof) return false;
    throw nativeError("FindFirstStreamW", error);
  }
  let inspectionFailed = false;
  let inspectionError: unknown;
  let namedStreamFound = false;
  let inspectionComplete = false;
  try {
    namedStreamFound = decodeStreamName(streamData) !== "::$DATA";
    while (!namedStreamFound && !inspectionComplete) {
      streamData.fill(0);
      if (bindings.FindNextStreamW(search, streamData) as boolean) {
        namedStreamFound = decodeStreamName(streamData) !== "::$DATA";
        continue;
      }
      const error = lastError(bindings);
      if (error === errorHandleEof || error === errorNoMoreFiles) {
        inspectionComplete = true;
        continue;
      }
      throw nativeError("FindNextStreamW", error);
    }
  } catch (error) {
    inspectionFailed = true;
    inspectionError = error;
  }
  const closed = bindings.FindClose(search) as boolean;
  if (inspectionFailed) throw inspectionError;
  if (!closed) throw nativeError("FindClose");
  return namedStreamFound;
}

function inspectCurrentUserAcl(
  bindings: ReturnType<typeof createWindowsBindings>,
  handle: bigint,
  kind: "directory" | "file"
): Readonly<{ current_user_only: boolean; owner_current_user: boolean }> {
  const owner = [null];
  const descriptor = [null];
  const result = bindings.GetSecurityInfo(
    handle,
    seFileObject,
    ownerSecurityInformation | daclSecurityInformation,
    owner,
    null,
    null,
    null,
    descriptor
  ) as number;
  if (result !== 0 || descriptor[0] === null || owner[0] === null) {
    throw nativeError("GetSecurityInfo", result);
  }
  try {
    const currentSid = currentUserSid(bindings);
    const ownerSid = sidToString(bindings, owner[0]);
    const actual = securityDescriptorToString(bindings, descriptor[0]);
    const expected = expectedSddl(bindings, kind, currentSid);
    return Object.freeze({
      current_user_only:
        actual === expected ||
        actual === expected.replace("D:P(", "D:PAI("),
      owner_current_user: ownerSid === currentSid
    });
  } finally {
    localFree(bindings, descriptor[0]);
  }
}

function applyCurrentUserSecurity(
  bindings: ReturnType<typeof createWindowsBindings>,
  handle: bigint,
  kind: "directory" | "file"
): void {
  const sid = currentUserSid(bindings);
  const descriptor = stringToSecurityDescriptor(
    bindings,
    `O:${sid}${daclSddl(kind, sid)}`
  );
  try {
    const owner = [null];
    const ownerDefaulted = [0];
    const present = [0];
    const defaulted = [0];
    const dacl = [null];
    if (
      !(bindings.GetSecurityDescriptorOwner(
        descriptor,
        owner,
        ownerDefaulted
      ) as boolean) ||
      owner[0] === null ||
      !(bindings.GetSecurityDescriptorDacl(
        descriptor,
        present,
        dacl,
        defaulted
      ) as boolean) ||
      present[0] !== 1 ||
      dacl[0] === null
    ) {
      throw nativeError("GetSecurityDescriptorOwnerOrDacl");
    }
    const result = bindings.SetSecurityInfo(
      handle,
      seFileObject,
      ownerSecurityInformation |
        daclSecurityInformation |
        protectedDaclSecurityInformation,
      owner[0],
      null,
      dacl[0],
      null
    ) as number;
    if (result !== 0) {
      throw new WindowsNativeFileSecurityError(
        "acl_update_failed",
        "SetSecurityInfo",
        result
      );
    }
  } finally {
    localFree(bindings, descriptor);
  }
}

function currentUserSid(
  bindings: ReturnType<typeof createWindowsBindings>
): string {
  if (currentUserSidCache !== null) return currentUserSidCache;
  const token: unknown[] = [null];
  if (
    !(bindings.OpenProcessToken(
      bindings.GetCurrentProcess(),
      tokenQuery,
      token
    ) as boolean) ||
    typeof token[0] !== "bigint"
  ) {
    throw nativeError("OpenProcessToken");
  }
  const tokenHandle = token[0];
  try {
    const size = [0];
    const first = bindings.GetTokenInformation(
      tokenHandle,
      tokenUser,
      null,
      0,
      size
    ) as boolean;
    if (
      first ||
      lastError(bindings) !== errorInsufficientBuffer ||
      !Number.isSafeInteger(size[0]) ||
      (size[0] ?? 0) < 16 ||
      (size[0] ?? 0) > 65_536
    ) {
      throw nativeError("GetTokenInformation.size");
    }
    const buffer = Buffer.alloc(size[0] ?? 0);
    if (
      !(bindings.GetTokenInformation(
        tokenHandle,
        tokenUser,
        buffer,
        buffer.length,
        size
      ) as boolean)
    ) {
      throw nativeError("GetTokenInformation.data");
    }
    const tokenUserData = koffi.decode(
      buffer,
      bindings.HOSTDECK_TOKEN_USER
    ) as { User?: { Sid?: bigint | null } };
    const sid = tokenUserData.User?.Sid;
    if (sid === null || sid === undefined) {
      throw new WindowsNativeFileSecurityError(
        "native_call_failed",
        "TokenUser.Sid"
      );
    }
    currentUserSidCache = sidToString(bindings, sid);
    return currentUserSidCache;
  } finally {
    closeHandle(bindings, tokenHandle);
  }
}

function sidToString(
  bindings: ReturnType<typeof createWindowsBindings>,
  sid: unknown
): string {
  const output: unknown[] = [null];
  if (
    !(bindings.ConvertSidToStringSidW(sid, output) as boolean) ||
    typeof output[0] !== "bigint" ||
    output[0] === 0n
  ) {
    throw nativeError("ConvertSidToStringSidW");
  }
  try {
    const value = koffi.decode.string16(output[0]);
    if (!/^S-1-(?:[0-9]+-){1,14}[0-9]+$/u.test(value)) {
      throw new WindowsNativeFileSecurityError(
        "native_call_failed",
        "sid_format"
      );
    }
    return value;
  } finally {
    localFree(bindings, output[0]);
  }
}

function expectedSddl(
  bindings: ReturnType<typeof createWindowsBindings>,
  kind: "directory" | "file",
  sid: string
): string {
  const cached = expectedSddlCache.get(kind);
  if (cached !== undefined) return cached;
  const descriptor = stringToSecurityDescriptor(
    bindings,
    `O:${sid}${daclSddl(kind, sid)}`
  );
  try {
    const canonical = securityDescriptorToString(bindings, descriptor);
    expectedSddlCache.set(kind, canonical);
    return canonical;
  } finally {
    localFree(bindings, descriptor);
  }
}

function daclSddl(kind: "directory" | "file", sid: string): string {
  const inheritance = kind === "directory" ? "OICI" : "";
  return `D:P(A;${inheritance};FA;;;${sid})`;
}

function stringToSecurityDescriptor(
  bindings: ReturnType<typeof createWindowsBindings>,
  sddl: string
): unknown {
  const descriptor = [null];
  if (
    !(bindings.ConvertStringSecurityDescriptorToSecurityDescriptorW(
      sddl,
      sddlRevision1,
      descriptor,
      null
    ) as boolean) ||
    descriptor[0] === null
  ) {
    throw nativeError("ConvertStringSecurityDescriptorToSecurityDescriptorW");
  }
  return descriptor[0];
}

function securityDescriptorToString(
  bindings: ReturnType<typeof createWindowsBindings>,
  descriptor: unknown
): string {
  const output: unknown[] = [null];
  const length = [0];
  if (
    !(bindings.ConvertSecurityDescriptorToStringSecurityDescriptorW(
      descriptor,
      sddlRevision1,
      ownerSecurityInformation | daclSecurityInformation,
      output,
      length
    ) as boolean) ||
    typeof output[0] !== "bigint" ||
    output[0] === 0n ||
    !Number.isSafeInteger(length[0]) ||
    (length[0] ?? 0) < 2 ||
    (length[0] ?? 0) > 16_384
  ) {
    throw nativeError("ConvertSecurityDescriptorToStringSecurityDescriptorW");
  }
  try {
    const value = koffi.decode.string16(output[0]);
    if (value.length < 10 || value.length > 16_384) {
      throw new WindowsNativeFileSecurityError(
        "native_call_failed",
        "security_descriptor_size"
      );
    }
    return value;
  } finally {
    localFree(bindings, output[0]);
  }
}

function knownFolder(
  bindings: ReturnType<typeof createWindowsBindings>,
  csidl: number,
  operation: string
): string {
  const output = Buffer.alloc(maximumKnownFolderCharacters * 2);
  const result = bindings.SHGetFolderPathW(
    null,
    csidl,
    null,
    shgfpTypeCurrent,
    output
  ) as number;
  if (result !== 0) throw nativeError(`SHGetFolderPathW.${operation}`, result);
  const value = normalizeDrivePath(decodeNullTerminatedUtf16(output));
  if (!/^[A-Z]:\\/u.test(value) || win32.dirname(value) === value) {
    throw new WindowsNativeFileSecurityError(
      "path_unavailable",
      `known_folder.${operation}`
    );
  }
  return value;
}

function openPathHandle(
  bindings: ReturnType<typeof createWindowsBindings>,
  path: string,
  desiredAccess: number
): bigint {
  const handle = bindings.CreateFileW(
    path,
    desiredAccess,
    fileShareRead | fileShareWrite | fileShareDelete,
    null,
    openExisting,
    fileFlagBackupSemantics | fileFlagOpenReparsePoint,
    null
  ) as bigint;
  if (isInvalidHandle(handle)) {
    throw new WindowsNativeFileSecurityError(
      "path_unavailable",
      "CreateFileW",
      lastError(bindings)
    );
  }
  return handle;
}

function finalPath(
  bindings: ReturnType<typeof createWindowsBindings>,
  handle: bigint
): string {
  const output = Buffer.alloc(maximumWindowsPathCharacters * 2);
  const length = bindings.GetFinalPathNameByHandleW(
    handle,
    output,
    maximumWindowsPathCharacters,
    0
  ) as number;
  if (length < 3 || length >= maximumWindowsPathCharacters) {
    throw nativeError("GetFinalPathNameByHandleW");
  }
  return normalizeDrivePath(output.toString("utf16le", 0, length * 2));
}

function normalizeDrivePath(path: string): string {
  const withoutNamespace = path.startsWith("\\\\?\\") ? path.slice(4) : path;
  const normalized = win32.normalize(withoutNamespace);
  if (!/^[A-Za-z]:\\/u.test(normalized)) {
    throw new WindowsNativeFileSecurityError(
      "unsupported_filesystem",
      "path_namespace"
    );
  }
  return `${normalized[0]?.toUpperCase()}${normalized.slice(1)}`;
}

function closeHandle(
  bindings: ReturnType<typeof createWindowsBindings>,
  handle: bigint
): void {
  if (!(bindings.CloseHandle(handle) as boolean)) {
    throw nativeError("CloseHandle");
  }
}

function localFree(
  bindings: ReturnType<typeof createWindowsBindings>,
  pointer: unknown
): void {
  if (typeof pointer !== "bigint" || pointer === 0n) {
    throw new WindowsNativeFileSecurityError(
      "native_call_failed",
      "LocalFree.pointer"
    );
  }
  const result = bindings.LocalFree(pointer) as bigint | null;
  if (result !== null && result !== 0n) throw nativeError("LocalFree");
}

function lastError(bindings: ReturnType<typeof createWindowsBindings>): number {
  return bindings.GetLastError() as number;
}

function nativeError(
  operation: string,
  nativeErrorCode?: number
): WindowsNativeFileSecurityError {
  const error =
    nativeErrorCode ??
    (process.platform === "win32" && bindingsCache !== null
      ? lastError(bindingsCache)
      : null);
  return new WindowsNativeFileSecurityError(
    "native_call_failed",
    operation,
    error
  );
}

function assertSameIdentity(
  left: WindowsFileIdentity,
  right: WindowsFileIdentity
): void {
  if (
    left.file_index !== right.file_index ||
    left.volume_serial_number !== right.volume_serial_number
  ) {
    throw new WindowsNativeFileSecurityError(
      "path_unavailable",
      "path_substitution"
    );
  }
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new WindowsNativeFileSecurityError(
      "native_call_failed",
      `file_information.${key}`
    );
  }
  return value as number;
}

function combineUnsigned64(high: number, low: number): bigint {
  return (BigInt(high) << 32n) | BigInt(low);
}

function decodeNullTerminatedUtf16(buffer: Buffer): string {
  let end = 0;
  while (end + 1 < buffer.length && buffer.readUInt16LE(end) !== 0) end += 2;
  if (end === 0 || end + 1 >= buffer.length) {
    throw new WindowsNativeFileSecurityError(
      "native_call_failed",
      "utf16_output"
    );
  }
  return buffer.toString("utf16le", 0, end);
}

function decodeStreamName(buffer: Buffer): string {
  let end = streamDataNameOffset;
  while (
    end + 1 < buffer.length &&
    buffer.readUInt16LE(end) !== 0
  ) {
    end += 2;
  }
  if (end + 1 >= buffer.length) {
    throw new WindowsNativeFileSecurityError(
      "native_call_failed",
      "stream_name"
    );
  }
  return buffer.toString("utf16le", streamDataNameOffset, end);
}

function isInvalidHandle(handle: unknown): boolean {
  if (handle === null || handle === undefined) return true;
  if (typeof handle !== "bigint") return true;
  return BigInt.asUintN(64, handle) === 0xffff_ffff_ffff_ffffn;
}

function deepFreezeInspection(
  inspection: WindowsNativePathInspection
): WindowsNativePathInspection {
  return Object.freeze({
    ...inspection,
    identity: Object.freeze({ ...inspection.identity })
  });
}

function windowsBindings() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new WindowsNativeFileSecurityError(
      "unsupported_platform",
      "load_bindings"
    );
  }
  bindingsCache ??= createWindowsBindings();
  return bindingsCache;
}

function createWindowsBindings() {
  const kernel32 = koffi.load("kernel32.dll");
  const advapi32 = koffi.load("advapi32.dll");
  const msvcrt = koffi.load("msvcrt.dll");
  const shell32 = koffi.load("shell32.dll");
  const handleValue = koffi.opaque("HOSTDECK_WIN_HANDLE_VALUE");
  const _HOSTDECK_WIN_HANDLE = koffi.pointer(
    "HOSTDECK_WIN_HANDLE",
    handleValue
  );
  const securityAttributesValue = koffi.opaque(
    "HOSTDECK_WIN_SECURITY_ATTRIBUTES_VALUE"
  );
  koffi.pointer(
    "HOSTDECK_WIN_PSECURITY_ATTRIBUTES",
    securityAttributesValue
  );
  const sidValue = koffi.opaque("HOSTDECK_WIN_SID_VALUE");
  const HOSTDECK_WIN_PSID = koffi.pointer("HOSTDECK_WIN_PSID", sidValue);
  const aclValue = koffi.opaque("HOSTDECK_WIN_ACL_VALUE");
  koffi.pointer("HOSTDECK_WIN_PACL", aclValue);
  const securityDescriptorValue = koffi.opaque(
    "HOSTDECK_WIN_SECURITY_DESCRIPTOR_VALUE"
  );
  koffi.pointer(
    "HOSTDECK_WIN_PSECURITY_DESCRIPTOR",
    securityDescriptorValue
  );
  const HOSTDECK_FILETIME = koffi.struct("HOSTDECK_FILETIME", {
    dwHighDateTime: "uint32_t",
    dwLowDateTime: "uint32_t"
  });
  const _HOSTDECK_BY_HANDLE_FILE_INFORMATION = koffi.struct(
    "HOSTDECK_BY_HANDLE_FILE_INFORMATION",
    {
      dwFileAttributes: "uint32_t",
      ftCreationTime: HOSTDECK_FILETIME,
      ftLastAccessTime: HOSTDECK_FILETIME,
      ftLastWriteTime: HOSTDECK_FILETIME,
      dwVolumeSerialNumber: "uint32_t",
      nFileSizeHigh: "uint32_t",
      nFileSizeLow: "uint32_t",
      nNumberOfLinks: "uint32_t",
      nFileIndexHigh: "uint32_t",
      nFileIndexLow: "uint32_t"
    }
  );
  const HOSTDECK_SID_AND_ATTRIBUTES = koffi.struct(
    "HOSTDECK_SID_AND_ATTRIBUTES",
    {
      Sid: HOSTDECK_WIN_PSID,
      Attributes: "uint32_t"
    }
  );
  const HOSTDECK_TOKEN_USER = koffi.struct("HOSTDECK_TOKEN_USER", {
    User: HOSTDECK_SID_AND_ATTRIBUTES
  });

  return Object.freeze({
    HOSTDECK_TOKEN_USER,
    CloseHandle: kernel32.func(
      "int32_t __stdcall CloseHandle(HOSTDECK_WIN_HANDLE hObject)"
    ),
    CompareStringOrdinal: kernel32.func(
      "int32_t __stdcall CompareStringOrdinal(const char16_t *lpString1, int32_t cchCount1, const char16_t *lpString2, int32_t cchCount2, int32_t bIgnoreCase)"
    ),
    ConvertSecurityDescriptorToStringSecurityDescriptorW: advapi32.func(
      "int32_t __stdcall ConvertSecurityDescriptorToStringSecurityDescriptorW(HOSTDECK_WIN_PSECURITY_DESCRIPTOR SecurityDescriptor, uint32_t RequestedStringSDRevision, uint32_t SecurityInformation, _Out_ void **StringSecurityDescriptor, _Out_ uint32_t *StringSecurityDescriptorLen)"
    ),
    ConvertSidToStringSidW: advapi32.func(
      "int32_t __stdcall ConvertSidToStringSidW(HOSTDECK_WIN_PSID Sid, _Out_ void **StringSid)"
    ),
    ConvertStringSecurityDescriptorToSecurityDescriptorW: advapi32.func(
      "int32_t __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(const char16_t *StringSecurityDescriptor, uint32_t StringSDRevision, _Out_ HOSTDECK_WIN_PSECURITY_DESCRIPTOR *SecurityDescriptor, _Out_ uint32_t *SecurityDescriptorSize)"
    ),
    CreateFileW: kernel32.func(
      "HOSTDECK_WIN_HANDLE __stdcall CreateFileW(const char16_t *lpFileName, uint32_t dwDesiredAccess, uint32_t dwShareMode, HOSTDECK_WIN_PSECURITY_ATTRIBUTES lpSecurityAttributes, uint32_t dwCreationDisposition, uint32_t dwFlagsAndAttributes, HOSTDECK_WIN_HANDLE hTemplateFile)"
    ),
    FindClose: kernel32.func(
      "int32_t __stdcall FindClose(HOSTDECK_WIN_HANDLE hFindFile)"
    ),
    FindFirstStreamW: kernel32.func(
      "HOSTDECK_WIN_HANDLE __stdcall FindFirstStreamW(const char16_t *lpFileName, int32_t InfoLevel, _Out_ uint8_t *lpFindStreamData, uint32_t dwFlags)"
    ),
    FindNextStreamW: kernel32.func(
      "int32_t __stdcall FindNextStreamW(HOSTDECK_WIN_HANDLE hFindStream, _Out_ uint8_t *lpFindStreamData)"
    ),
    GetCurrentProcess: kernel32.func(
      "HOSTDECK_WIN_HANDLE __stdcall GetCurrentProcess(void)"
    ),
    GetFileInformationByHandle: kernel32.func(
      "int32_t __stdcall GetFileInformationByHandle(HOSTDECK_WIN_HANDLE hFile, _Out_ HOSTDECK_BY_HANDLE_FILE_INFORMATION *lpFileInformation)"
    ),
    GetFinalPathNameByHandleW: kernel32.func(
      "uint32_t __stdcall GetFinalPathNameByHandleW(HOSTDECK_WIN_HANDLE hFile, _Out_ char16_t *lpszFilePath, uint32_t cchFilePath, uint32_t dwFlags)"
    ),
    GetLastError: kernel32.func("uint32_t __stdcall GetLastError(void)"),
    GetOsFileHandle: msvcrt.func(
      "HOSTDECK_WIN_HANDLE __cdecl _get_osfhandle(int32_t fd)"
    ),
    GetSecurityDescriptorDacl: advapi32.func(
      "int32_t __stdcall GetSecurityDescriptorDacl(HOSTDECK_WIN_PSECURITY_DESCRIPTOR pSecurityDescriptor, _Out_ int32_t *lpbDaclPresent, _Out_ HOSTDECK_WIN_PACL *pDacl, _Out_ int32_t *lpbDaclDefaulted)"
    ),
    GetSecurityDescriptorOwner: advapi32.func(
      "int32_t __stdcall GetSecurityDescriptorOwner(HOSTDECK_WIN_PSECURITY_DESCRIPTOR pSecurityDescriptor, _Out_ HOSTDECK_WIN_PSID *pOwner, _Out_ int32_t *lpbOwnerDefaulted)"
    ),
    GetSecurityInfo: advapi32.func(
      "uint32_t __stdcall GetSecurityInfo(HOSTDECK_WIN_HANDLE handle, int32_t ObjectType, uint32_t SecurityInfo, _Out_ HOSTDECK_WIN_PSID *ppsidOwner, _Out_ HOSTDECK_WIN_PSID *ppsidGroup, _Out_ HOSTDECK_WIN_PACL *ppDacl, _Out_ HOSTDECK_WIN_PACL *ppSacl, _Out_ HOSTDECK_WIN_PSECURITY_DESCRIPTOR *ppSecurityDescriptor)"
    ),
    GetTokenInformation: advapi32.func(
      "int32_t __stdcall GetTokenInformation(HOSTDECK_WIN_HANDLE TokenHandle, int32_t TokenInformationClass, _Out_ uint8_t *TokenInformation, uint32_t TokenInformationLength, _Out_ uint32_t *ReturnLength)"
    ),
    GetDriveTypeW: kernel32.func(
      "uint32_t __stdcall GetDriveTypeW(const char16_t *lpRootPathName)"
    ),
    GetVolumeInformationW: kernel32.func(
      "int32_t __stdcall GetVolumeInformationW(const char16_t *lpRootPathName, _Out_ char16_t *lpVolumeNameBuffer, uint32_t nVolumeNameSize, _Out_ uint32_t *lpVolumeSerialNumber, _Out_ uint32_t *lpMaximumComponentLength, _Out_ uint32_t *lpFileSystemFlags, _Out_ char16_t *lpFileSystemNameBuffer, uint32_t nFileSystemNameSize)"
    ),
    GetVolumePathNameW: kernel32.func(
      "int32_t __stdcall GetVolumePathNameW(const char16_t *lpszFileName, _Out_ char16_t *lpszVolumePathName, uint32_t cchBufferLength)"
    ),
    LocalFree: kernel32.func(
      "void * __stdcall LocalFree(void *hMem)"
    ),
    OpenProcessToken: advapi32.func(
      "int32_t __stdcall OpenProcessToken(HOSTDECK_WIN_HANDLE ProcessHandle, uint32_t DesiredAccess, _Out_ HOSTDECK_WIN_HANDLE *TokenHandle)"
    ),
    SetSecurityInfo: advapi32.func(
      "uint32_t __stdcall SetSecurityInfo(HOSTDECK_WIN_HANDLE handle, int32_t ObjectType, uint32_t SecurityInfo, HOSTDECK_WIN_PSID psidOwner, HOSTDECK_WIN_PSID psidGroup, HOSTDECK_WIN_PACL pDacl, HOSTDECK_WIN_PACL pSacl)"
    ),
    SHGetFolderPathW: shell32.func(
      "int32_t __stdcall SHGetFolderPathW(HOSTDECK_WIN_HANDLE hwnd, int32_t csidl, HOSTDECK_WIN_HANDLE hToken, uint32_t dwFlags, _Out_ char16_t *pszPath)"
    )
  });
}
