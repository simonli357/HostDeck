import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep
} from "node:path";

export const hostDeckSystemdUserUnitNames = Object.freeze([
  "hostdeck-codex.service",
  "hostdeck.service"
] as const);

export const hostDeckSystemdUserUnitMode = 0o644;

export type HostDeckSystemdUserUnitErrorCode =
  | "invalid_input"
  | "node_invalid"
  | "codex_invalid"
  | "package_invalid"
  | "environment_file_invalid";

export type HostDeckSystemdUserUnitErrorStage =
  | "input"
  | "node"
  | "codex"
  | "package"
  | "environment_file";

export interface GenerateHostDeckSystemdUserUnitsInput {
  readonly codex_bin: string;
  readonly environment_file: string | null;
  readonly expected_package_version: string;
  readonly node_bin: string;
  readonly package_root: string;
}

export interface HostDeckSystemdUserUnitDescriptor {
  readonly content: string;
  readonly mode: typeof hostDeckSystemdUserUnitMode;
  readonly name: (typeof hostDeckSystemdUserUnitNames)[number];
  readonly sha256: string;
}

export interface HostDeckSystemdUserUnitBundle {
  readonly package_version: string;
  readonly schema_version: 1;
  readonly service_host_path: string;
  readonly units: readonly [
    HostDeckSystemdUserUnitDescriptor,
    HostDeckSystemdUserUnitDescriptor
  ];
}

export class HostDeckSystemdUserUnitError extends Error {
  readonly code: HostDeckSystemdUserUnitErrorCode;
  readonly stage: HostDeckSystemdUserUnitErrorStage;

  constructor(
    code: HostDeckSystemdUserUnitErrorCode,
    stage: HostDeckSystemdUserUnitErrorStage
  ) {
    super("HostDeck systemd user-unit generation failed.");
    this.name = "HostDeckSystemdUserUnitError";
    this.code = code;
    this.stage = stage;
  }
}

const inputKeys = Object.freeze([
  "codex_bin",
  "environment_file",
  "expected_package_version",
  "node_bin",
  "package_root"
] as const);
const manifestName = "hostdeck-package.json";
const serviceHostRelativePath = "dist/service-host.js";
const maximumPathBytes = 4096;
const maximumManifestBytes = 65_536;
const maximumServiceHostBytes = 16_777_216;
const maximumEnvironmentFileBytes = 1_048_576;
const exactVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const generatedBundles = new WeakSet<HostDeckSystemdUserUnitBundle>();

interface ValidatedInput {
  readonly codexBin: string;
  readonly environmentFile: string | null;
  readonly nodeBin: string;
  readonly packageRoot: string;
  readonly packageVersion: string;
  readonly serviceHostPath: string;
}

interface ServiceHostManifest {
  readonly package: "@hostdeck/cli";
  readonly path: typeof serviceHostRelativePath;
  readonly sha256: string;
  readonly size: number;
  readonly version: string;
}

export function generateHostDeckSystemdUserUnits(
  candidate: unknown
): HostDeckSystemdUserUnitBundle {
  const input = validateInput(candidate);
  const codexContent = renderCodexUnit(input);
  const hostDeckContent = renderHostDeckUnit(input);
  const units = Object.freeze([
    descriptor("hostdeck-codex.service", codexContent),
    descriptor("hostdeck.service", hostDeckContent)
  ]) as HostDeckSystemdUserUnitBundle["units"];
  const bundle = Object.freeze({
    package_version: input.packageVersion,
    schema_version: 1 as const,
    service_host_path: input.serviceHostPath,
    units
  });
  generatedBundles.add(bundle);
  return bundle;
}

export function assertHostDeckSystemdUserUnitBundle(
  candidate: unknown
): asserts candidate is HostDeckSystemdUserUnitBundle {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !generatedBundles.has(candidate as HostDeckSystemdUserUnitBundle)
  ) {
    throw new TypeError("HostDeck systemd user-unit bundle is invalid.");
  }
}

function validateInput(candidate: unknown): ValidatedInput {
  let values: Readonly<Record<(typeof inputKeys)[number], unknown>>;
  try {
    values = readExactDataObject(candidate, inputKeys);
  } catch {
    fail("invalid_input", "input");
  }

  const packageVersion = parseVersion(values.expected_package_version);
  const nodeBin = parsePath(values.node_bin, "node_invalid", "node");
  const codexBin = parsePath(values.codex_bin, "codex_invalid", "codex");
  const packageRoot = parsePath(
    values.package_root,
    "package_invalid",
    "package"
  );
  const environmentFile =
    values.environment_file === null
      ? null
      : parsePath(
          values.environment_file,
          "environment_file_invalid",
          "environment_file"
        );

  validateExecutable(nodeBin, "node_invalid", "node");
  validateExecutable(codexBin, "codex_invalid", "codex");
  const serviceHostPath = validatePackage(packageRoot, packageVersion);
  if (environmentFile !== null) validateEnvironmentFile(environmentFile);

  return Object.freeze({
    codexBin,
    environmentFile,
    nodeBin,
    packageRoot,
    packageVersion,
    serviceHostPath
  });
}

function parseVersion(candidate: unknown): string {
  if (
    typeof candidate !== "string" ||
    candidate.length > 128 ||
    !exactVersionPattern.test(candidate)
  ) {
    fail("invalid_input", "input");
  }
  return candidate;
}

function parsePath(
  candidate: unknown,
  code: HostDeckSystemdUserUnitErrorCode,
  stage: HostDeckSystemdUserUnitErrorStage
): string {
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    Buffer.byteLength(candidate, "utf8") > maximumPathBytes ||
    containsControlCharacter(candidate) ||
    !isAbsolute(candidate) ||
    candidate === sep ||
    normalize(candidate) !== candidate
  ) {
    fail(code, stage);
  }
  return candidate;
}

function validateExecutable(
  path: string,
  code: "node_invalid" | "codex_invalid",
  stage: "node" | "codex"
): void {
  try {
    if (/["'\\]/u.test(path)) fail(code, stage);
    if (realpathSync.native(path) !== path) fail(code, stage);
    const stats = lstatSync(path);
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      (stats.mode & 0o111) === 0 ||
      (stats.mode & 0o022) !== 0
    ) {
      fail(code, stage);
    }
    accessSync(path, constants.R_OK | constants.X_OK);
  } catch (error) {
    if (error instanceof HostDeckSystemdUserUnitError) throw error;
    fail(code, stage);
  }
}

function validatePackage(packageRoot: string, expectedVersion: string): string {
  try {
    if (realpathSync.native(packageRoot) !== packageRoot) {
      fail("package_invalid", "package");
    }
    const rootStats = lstatSync(packageRoot);
    if (
      !rootStats.isDirectory() ||
      rootStats.isSymbolicLink() ||
      rootStats.uid !== currentUid() ||
      (rootStats.mode & 0o022) !== 0
    ) {
      fail("package_invalid", "package");
    }

    const manifestPath = join(packageRoot, manifestName);
    assertContained(packageRoot, manifestPath);
    const manifestBytes = readSecureRegularFile(
      manifestPath,
      0o644,
      maximumManifestBytes,
      true,
      "package_invalid",
      "package"
    );
    const manifest = parsePackageManifest(manifestBytes, expectedVersion);
    const serviceHostPath = resolve(packageRoot, manifest.path);
    assertContained(packageRoot, serviceHostPath);
    if (realpathSync.native(serviceHostPath) !== serviceHostPath) {
      fail("package_invalid", "package");
    }
    const serviceHostBytes = readSecureRegularFile(
      serviceHostPath,
      0o644,
      manifest.size,
      true,
      "package_invalid",
      "package"
    );
    if (
      serviceHostBytes.length !== manifest.size ||
      sha256(serviceHostBytes) !== manifest.sha256
    ) {
      fail("package_invalid", "package");
    }
    return serviceHostPath;
  } catch (error) {
    if (error instanceof HostDeckSystemdUserUnitError) throw error;
    fail("package_invalid", "package");
  }
}

function parsePackageManifest(
  content: Buffer,
  expectedVersion: string
): ServiceHostManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString("utf8"));
  } catch {
    fail("package_invalid", "package");
  }
  if (!isRecord(parsed)) fail("package_invalid", "package");
  if (
    parsed.schemaVersion !== 3 ||
    parsed.name !== "hostdeck-production-package" ||
    parsed.packageVersion !== expectedVersion
  ) {
    fail("package_invalid", "package");
  }
  const serviceHost = parsed.serviceHost;
  if (!isRecord(serviceHost)) fail("package_invalid", "package");
  requireExactRecord(
    serviceHost,
    ["package", "path", "sha256", "size", "version"],
    "package_invalid",
    "package"
  );
  if (
    serviceHost.package !== "@hostdeck/cli" ||
    serviceHost.path !== serviceHostRelativePath ||
    serviceHost.version !== expectedVersion ||
    typeof serviceHost.sha256 !== "string" ||
    !sha256Pattern.test(serviceHost.sha256) ||
    !Number.isSafeInteger(serviceHost.size) ||
    (serviceHost.size as number) < 1 ||
    (serviceHost.size as number) > maximumServiceHostBytes
  ) {
    fail("package_invalid", "package");
  }
  return Object.freeze({
    package: "@hostdeck/cli" as const,
    path: serviceHostRelativePath,
    sha256: serviceHost.sha256,
    size: serviceHost.size as number,
    version: expectedVersion
  });
}

function validateEnvironmentFile(path: string): void {
  try {
    const parent = dirname(path);
    if (parent === path || realpathSync.native(parent) !== parent) {
      fail("environment_file_invalid", "environment_file");
    }
    const parentStats = lstatSync(parent);
    if (
      !parentStats.isDirectory() ||
      parentStats.isSymbolicLink() ||
      parentStats.uid !== currentUid() ||
      (parentStats.mode & 0o7777) !== 0o700
    ) {
      fail("environment_file_invalid", "environment_file");
    }

    let exists = true;
    try {
      lstatSync(path);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") exists = false;
      else throw error;
    }
    if (!exists) return;
    if (realpathSync.native(path) !== path) {
      fail("environment_file_invalid", "environment_file");
    }
    readSecureRegularFile(
      path,
      0o600,
      maximumEnvironmentFileBytes,
      true,
      "environment_file_invalid",
      "environment_file"
    );
  } catch (error) {
    if (error instanceof HostDeckSystemdUserUnitError) throw error;
    fail("environment_file_invalid", "environment_file");
  }
}

function readSecureRegularFile(
  path: string,
  mode: number,
  maximumBytes: number,
  requireCurrentOwner: boolean,
  code: HostDeckSystemdUserUnitErrorCode,
  stage: HostDeckSystemdUserUnitErrorStage
): Buffer {
  let descriptor: number | undefined;
  try {
    const before = lstatSync(path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      (before.mode & 0o7777) !== mode ||
      (requireCurrentOwner && before.uid !== currentUid()) ||
      before.size > maximumBytes
    ) {
      fail(code, stage);
    }
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.uid !== before.uid ||
      opened.mode !== before.mode ||
      opened.size !== before.size ||
      opened.size > maximumBytes
    ) {
      fail(code, stage);
    }
    const content = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      content.length !== opened.size
    ) {
      fail(code, stage);
    }
    return content;
  } catch (error) {
    if (error instanceof HostDeckSystemdUserUnitError) throw error;
    throw new HostDeckSystemdUserUnitError(code, stage);
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        fail(code, stage);
      }
    }
  }
}

function renderCodexUnit(input: ValidatedInput): string {
  const lines = [
    generatedHeader(input.packageVersion),
    "[Unit]",
    `Description=HostDeck Codex app-server (${input.packageVersion})`,
    "StartLimitIntervalSec=60s",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=exec",
    "WorkingDirectory=%h"
  ];
  if (input.environmentFile !== null) {
    lines.push(`EnvironmentFile=-${encodeSystemdFilePath(input.environmentFile)}`);
  }
  lines.push(
    "UMask=0077",
    "RuntimeDirectory=hostdeck",
    "RuntimeDirectoryMode=0700",
    `ExecStart=${encodeSystemdWord(input.codexBin, false)} app-server --listen unix://%t/hostdeck/app-server.sock`,
    ...servicePolicy()
  );
  return `${lines.join("\n")}\n`;
}

function renderHostDeckUnit(input: ValidatedInput): string {
  const lines = [
    generatedHeader(input.packageVersion),
    "[Unit]",
    `Description=HostDeck service (${input.packageVersion})`,
    "Wants=hostdeck-codex.service",
    "After=hostdeck-codex.service",
    "StartLimitIntervalSec=60s",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=exec",
    "WorkingDirectory=%h"
  ];
  if (input.environmentFile !== null) {
    lines.push(`EnvironmentFile=-${encodeSystemdFilePath(input.environmentFile)}`);
  }
  lines.push(
    `Environment=${encodeSystemdWord(`HOSTDECK_CODEX_BIN=${input.codexBin}`, false)}`,
    "UMask=0077",
    `ExecStart=${encodeSystemdWord(input.nodeBin, false)} ${encodeSystemdWord(input.serviceHostPath, true)}`,
    ...servicePolicy(),
    "",
    "[Install]",
    "WantedBy=default.target"
  );
  return `${lines.join("\n")}\n`;
}

function servicePolicy(): readonly string[] {
  return [
    "Restart=always",
    "RestartSec=2s",
    "TimeoutStartSec=90s",
    "TimeoutStopSec=30s",
    "KillMode=control-group",
    "StandardOutput=journal",
    "StandardError=journal"
  ];
}

function generatedHeader(version: string): string {
  return `# Generated by HostDeck ${version}. Do not edit.`;
}

function encodeSystemdWord(value: string, execWord: boolean): string {
  let encoded = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%");
  if (execWord) encoded = encoded.replaceAll("$", () => "$$");
  return `"${encoded}"`;
}

function encodeSystemdFilePath(value: string): string {
  return value
    .replaceAll("\\", "\\x5c")
    .replaceAll('"', "\\x22")
    .replaceAll("'", "\\x27")
    .replaceAll(" ", "\\x20")
    .replaceAll("%", "%%");
}

function descriptor(
  name: HostDeckSystemdUserUnitDescriptor["name"],
  content: string
): HostDeckSystemdUserUnitDescriptor {
  return Object.freeze({
    content,
    mode: hostDeckSystemdUserUnitMode,
    name,
    sha256: sha256(content)
  });
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function readExactDataObject<const Keys extends readonly string[]>(
  candidate: unknown,
  keys: Keys
): Readonly<Record<Keys[number], unknown>> {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Object.getPrototypeOf(candidate) !== Object.prototype
  ) {
    throw new TypeError("invalid object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  const actualKeys = Reflect.ownKeys(candidate);
  if (
    actualKeys.length !== keys.length ||
    actualKeys.some(
      (key) => typeof key !== "string" || !keys.includes(key as Keys[number])
    )
  ) {
    throw new TypeError("invalid keys");
  }
  const values: Partial<Record<Keys[number], unknown>> = {};
  for (const key of keys) {
    const property = descriptors[key];
    if (property === undefined || !("value" in property)) {
      throw new TypeError("invalid property");
    }
    values[key as Keys[number]] = property.value;
  }
  return values as Readonly<Record<Keys[number], unknown>>;
}

function requireExactRecord(
  candidate: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  code: HostDeckSystemdUserUnitErrorCode,
  stage: HostDeckSystemdUserUnitErrorStage
): void {
  const actual = Reflect.ownKeys(candidate);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    fail(code, stage);
  }
}

function assertContained(root: string, candidate: string): void {
  const path = relative(root, candidate);
  if (
    path.length === 0 ||
    path === ".." ||
    path.startsWith(`..${sep}`) ||
    isAbsolute(path)
  ) {
    fail("package_invalid", "package");
  }
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) fail("invalid_input", "input");
  return uid;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function fail(
  code: HostDeckSystemdUserUnitErrorCode,
  stage: HostDeckSystemdUserUnitErrorStage
): never {
  throw new HostDeckSystemdUserUnitError(code, stage);
}
