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

export interface GenerateHostDeckSystemdUserUnitsForInstallInput
  extends GenerateHostDeckSystemdUserUnitsInput {
  readonly verification_package_root: string;
}

export interface HostDeckSystemdUserUnitDescriptor {
  readonly content: string;
  readonly mode: typeof hostDeckSystemdUserUnitMode;
  readonly name: (typeof hostDeckSystemdUserUnitNames)[number];
  readonly sha256: string;
}

export interface HostDeckSystemdUserUnitBundle {
  readonly broker_host_path: string;
  readonly package_version: string;
  readonly schema_version: 2;
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
const installInputKeys = Object.freeze([
  ...inputKeys,
  "verification_package_root"
] as const);
const manifestName = "hostdeck-package.json";
const brokerHostRelativePath = "dist/broker-host.js";
const serviceHostRelativePath = "dist/service-host.js";
const bundledNodeRelativePath = "runtime/bin/node";
const maximumPathBytes = 4096;
const maximumManifestBytes = 65_536;
const maximumServiceHostBytes = 16_777_216;
const maximumBundledNodeBytes = 268_435_456;
const maximumEnvironmentFileBytes = 1_048_576;
const packageFileModes = Object.freeze([0o444, 0o644] as const);
const exactVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const generatedBundles = new WeakSet<HostDeckSystemdUserUnitBundle>();

interface ValidatedInput {
  readonly brokerHostPath: string;
  readonly codexBin: string;
  readonly environmentFile: string | null;
  readonly nodeBin: string;
  readonly packageRoot: string;
  readonly packageVersion: string;
  readonly serviceHostPath: string;
}

interface ProcessHostManifest<Path extends string> {
  readonly lifecycle: "systemd_user";
  readonly package: "@hostdeck/cli";
  readonly path: Path;
  readonly sha256: string;
  readonly size: number;
  readonly version: string;
}

interface PackageRuntimeManifest {
  readonly brokerHost: ProcessHostManifest<typeof brokerHostRelativePath>;
  readonly node: Readonly<{
    readonly path: typeof bundledNodeRelativePath;
    readonly sha256: string;
    readonly size: number;
  }>;
  readonly serviceHost: ProcessHostManifest<typeof serviceHostRelativePath>;
}

export function generateHostDeckSystemdUserUnits(
  candidate: unknown
): HostDeckSystemdUserUnitBundle {
  const input = validateInput(candidate, false);
  return generateBundle(input);
}

export function generateHostDeckSystemdUserUnitsForInstall(
  candidate: unknown
): HostDeckSystemdUserUnitBundle {
  const input = validateInput(candidate, true);
  return generateBundle(input);
}

function generateBundle(input: ValidatedInput): HostDeckSystemdUserUnitBundle {
  const codexContent = renderCodexUnit(input);
  const hostDeckContent = renderHostDeckUnit(input);
  const units = Object.freeze([
    descriptor("hostdeck-codex.service", codexContent),
    descriptor("hostdeck.service", hostDeckContent)
  ]) as HostDeckSystemdUserUnitBundle["units"];
  const bundle = Object.freeze({
    broker_host_path: input.brokerHostPath,
    package_version: input.packageVersion,
    schema_version: 2 as const,
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

function validateInput(
  candidate: unknown,
  forInstall: boolean
): ValidatedInput {
  let values: Readonly<Record<string, unknown>>;
  try {
    values = readExactDataObject(
      candidate,
      forInstall ? installInputKeys : inputKeys
    );
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
  const verificationPackageRoot = forInstall
    ? parsePath(
        values.verification_package_root,
        "package_invalid",
        "package"
      )
    : packageRoot;
  const environmentFile =
    values.environment_file === null
      ? null
      : parsePath(
          values.environment_file,
          "environment_file_invalid",
          "environment_file"
        );

  validateExecutable(codexBin, "codex_invalid", "codex");
  const packageRuntime = validatePackage(
    verificationPackageRoot,
    packageVersion
  );
  if (nodeBin !== join(packageRoot, bundledNodeRelativePath)) {
    fail("node_invalid", "node");
  }
  validateExecutable(
    join(verificationPackageRoot, packageRuntime.node.path),
    "node_invalid",
    "node"
  );
  validateDescriptorFile(
    verificationPackageRoot,
    packageRuntime.node,
    0o755,
    maximumBundledNodeBytes,
    "node_invalid",
    "node"
  );
  validateDescriptorFile(
    verificationPackageRoot,
    packageRuntime.brokerHost,
    packageFileModes,
    maximumServiceHostBytes,
    "package_invalid",
    "package"
  );
  validateDescriptorFile(
    verificationPackageRoot,
    packageRuntime.serviceHost,
    packageFileModes,
    maximumServiceHostBytes,
    "package_invalid",
    "package"
  );
  const brokerHostPath = join(packageRoot, brokerHostRelativePath);
  const serviceHostPath = join(packageRoot, serviceHostRelativePath);
  if (environmentFile !== null) {
    validateEnvironmentFile(environmentFile, forInstall);
  }

  return Object.freeze({
    brokerHostPath,
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

function validatePackage(
  packageRoot: string,
  expectedVersion: string
): PackageRuntimeManifest {
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
      packageFileModes,
      maximumManifestBytes,
      true,
      "package_invalid",
      "package"
    );
    return parsePackageManifest(manifestBytes, expectedVersion);
  } catch (error) {
    if (error instanceof HostDeckSystemdUserUnitError) throw error;
    fail("package_invalid", "package");
  }
}

function parsePackageManifest(
  content: Buffer,
  expectedVersion: string
): PackageRuntimeManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString("utf8"));
  } catch {
    fail("package_invalid", "package");
  }
  if (!isRecord(parsed)) fail("package_invalid", "package");
  const artifact = parsed.artifact;
  const runtime = parsed.runtime;
  const target = parsed.target;
  if (
    parsed.schemaVersion !== 6 ||
    parsed.name !== "hostdeck-production-package" ||
    parsed.packageVersion !== expectedVersion ||
    !isRecord(artifact) ||
    artifact.kind !== "native_tree" ||
    !isRecord(target) ||
    target.id !== "linux-x64" ||
    target.platform !== "linux" ||
    target.architecture !== "x64" ||
    target.lifecycle !== "systemd_user" ||
    !isRecord(runtime) ||
    runtime.platform !== "linux" ||
    runtime.architecture !== "x64" ||
    runtime.delivery !== "bundled" ||
    !isRecord(runtime.bundle)
  ) {
    fail("package_invalid", "package");
  }
  const brokerHost = parseProcessHostManifest(
    parsed.brokerHost,
    brokerHostRelativePath,
    expectedVersion
  );
  const serviceHost = parseProcessHostManifest(
    parsed.serviceHost,
    serviceHostRelativePath,
    expectedVersion
  );
  const node = runtime.bundle;
  requireExactRecord(
    node,
    ["path", "sha256", "size"],
    "package_invalid",
    "package"
  );
  if (
    node.path !== bundledNodeRelativePath ||
    typeof node.sha256 !== "string" ||
    !sha256Pattern.test(node.sha256) ||
    !Number.isSafeInteger(node.size) ||
    (node.size as number) < 1 ||
    (node.size as number) > maximumBundledNodeBytes
  ) {
    fail("package_invalid", "package");
  }
  return Object.freeze({
    brokerHost,
    node: Object.freeze({
      path: bundledNodeRelativePath,
      sha256: node.sha256,
      size: node.size as number
    }),
    serviceHost
  });
}

function parseProcessHostManifest<Path extends string>(
  candidate: unknown,
  path: Path,
  expectedVersion: string
): ProcessHostManifest<Path> {
  if (!isRecord(candidate)) fail("package_invalid", "package");
  requireExactRecord(
    candidate,
    ["lifecycle", "package", "path", "sha256", "size", "version"],
    "package_invalid",
    "package"
  );
  if (
    candidate.lifecycle !== "systemd_user" ||
    candidate.package !== "@hostdeck/cli" ||
    candidate.path !== path ||
    candidate.version !== expectedVersion ||
    typeof candidate.sha256 !== "string" ||
    !sha256Pattern.test(candidate.sha256) ||
    !Number.isSafeInteger(candidate.size) ||
    (candidate.size as number) < 1 ||
    (candidate.size as number) > maximumServiceHostBytes
  ) {
    fail("package_invalid", "package");
  }
  return Object.freeze({
    lifecycle: "systemd_user" as const,
    package: "@hostdeck/cli" as const,
    path,
    sha256: candidate.sha256,
    size: candidate.size as number,
    version: expectedVersion
  });
}

function validateDescriptorFile(
  root: string,
  descriptor: Readonly<{ path: string; sha256: string; size: number }>,
  modes: number | readonly number[],
  maximumBytes: number,
  code: HostDeckSystemdUserUnitErrorCode,
  stage: HostDeckSystemdUserUnitErrorStage
): void {
  const path = resolve(root, descriptor.path);
  assertContained(root, path);
  if (realpathSync.native(path) !== path) fail(code, stage);
  const bytes = readSecureRegularFile(
    path,
    modes,
    Math.min(descriptor.size, maximumBytes),
    true,
    code,
    stage
  );
  if (bytes.length !== descriptor.size || sha256(bytes) !== descriptor.sha256) {
    fail(code, stage);
  }
}

function validateEnvironmentFile(path: string, allowMissingParent: boolean): void {
  try {
    const parent = dirname(path);
    if (parent === path) {
      fail("environment_file_invalid", "environment_file");
    }
    if (!pathExists(parent)) {
      if (!allowMissingParent) {
        fail("environment_file_invalid", "environment_file");
      }
      validateMissingEnvironmentParent(parent);
      return;
    }
    if (realpathSync.native(parent) !== parent) {
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

function validateMissingEnvironmentParent(path: string): void {
  let cursor = path;
  while (!pathExists(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) {
      fail("environment_file_invalid", "environment_file");
    }
    cursor = parent;
  }
  const metadata = lstatSync(cursor);
  const uid = currentUid();
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (metadata.uid !== uid && metadata.uid !== 0) ||
    (metadata.mode & 0o022) !== 0 ||
    realpathSync.native(cursor) !== cursor
  ) {
    fail("environment_file_invalid", "environment_file");
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function readSecureRegularFile(
  path: string,
  modes: number | readonly number[],
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
      !matchesMode(before.mode & 0o7777, modes) ||
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

function matchesMode(actual: number, expected: number | readonly number[]): boolean {
  return typeof expected === "number" ? actual === expected : expected.includes(actual);
}

function renderCodexUnit(input: ValidatedInput): string {
  const lines = [
    generatedHeader(input.packageVersion),
    "[Unit]",
    `Description=HostDeck shared Codex broker (${input.packageVersion})`,
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
    `ExecStart=${encodeSystemdWord(input.nodeBin, false)} ${encodeSystemdWord(input.brokerHostPath, true)}`,
    `ExecStartPost=${encodeSystemdWord(input.nodeBin, false)} ${encodeSystemdWord(input.brokerHostPath, true)} ${brokerCheckArgument}`,
    ...brokerServicePolicy()
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
    'Environment="XDG_RUNTIME_DIR=%t/%N"',
    `Environment=${encodeSystemdWord(`HOSTDECK_CODEX_BIN=${input.codexBin}`, false)}`,
    "UMask=0077",
    "RuntimeDirectory=%N/hostdeck",
    "RuntimeDirectoryMode=0700",
    `ExecStart=${encodeSystemdWord(input.nodeBin, false)} ${encodeSystemdWord(input.serviceHostPath, true)}`,
    ...hostDeckServicePolicy(),
    "",
    "[Install]",
    "WantedBy=default.target"
  );
  return `${lines.join("\n")}\n`;
}

const brokerCheckArgument = "--check-ready";

function brokerServicePolicy(): readonly string[] {
  return [
    "Restart=on-failure",
    "RestartSec=2s",
    "TimeoutStartSec=90s",
    "TimeoutStopSec=30s",
    "KillMode=mixed",
    "StandardOutput=journal",
    "StandardError=journal"
  ];
}

function hostDeckServicePolicy(): readonly string[] {
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
