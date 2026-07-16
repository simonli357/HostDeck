import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve
} from "node:path";
import {
  readCodexSmokePrivateJson,
  writeCodexSmokePrivateJson
} from "./codex-hostdeck-restart-smoke-support.js";

export const lifecycleScenarioReportNames = Object.freeze([
  "integration-report.json",
  "supervisor-report.json",
  "restart-report.json",
  "coexistence-report.json"
] as const);

export type LifecycleScenarioReportName =
  (typeof lifecycleScenarioReportNames)[number];

const maximumScenarioReportBytes = 128 * 1_024;

export function requirePrivateLifecycleReportPath(
  candidate: string,
  expectedName: LifecycleScenarioReportName,
  expectedTemporaryRoot = tmpdir()
): string {
  if (!isAbsolute(candidate)) {
    throw new TypeError("Lifecycle scenario report path must be absolute.");
  }
  const path = resolve(candidate);
  const root = resolve(expectedTemporaryRoot);
  if (
    basename(path) !== expectedName ||
    dirname(path) !== root ||
    existsSync(path)
  ) {
    throw new TypeError("Lifecycle scenario report path is invalid.");
  }
  assertPrivateLifecycleDirectory(root);
  return path;
}

export function assertPrivateLifecycleDirectory(path: string): void {
  if (!isAbsolute(path)) {
    throw new TypeError("Lifecycle directory must be absolute.");
  }
  const normalized = resolve(path);
  let metadata: ReturnType<typeof lstatSync>;
  let canonical: string;
  try {
    metadata = lstatSync(normalized);
    canonical = realpathSync(normalized);
  } catch {
    throw new TypeError("Lifecycle directory is unavailable.");
  }
  if (
    canonical !== normalized ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    (process.getuid !== undefined && metadata.uid !== process.getuid())
  ) {
    throw new TypeError("Lifecycle directory is insecure.");
  }
}

export function assertLifecycleScenarioInventory(
  root: string,
  expectedNames: readonly LifecycleScenarioReportName[]
): void {
  assertPrivateLifecycleDirectory(root);
  const expected = [...expectedNames].sort();
  if (
    expected.length !== 1 ||
    new Set(expected).size !== expected.length ||
    expected.some((name) => !lifecycleScenarioReportNames.includes(name))
  ) {
    throw new TypeError("Lifecycle scenario inventory expectation is invalid.");
  }
  const entries = readdirSync(root, { withFileTypes: true });
  const observed = entries.map((entry) => entry.name).sort();
  if (
    observed.length !== expected.length ||
    observed.some((name, index) => name !== expected[index])
  ) {
    throw new TypeError("Lifecycle scenario contains unexpected entries.");
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new TypeError("Lifecycle scenario contains a special entry.");
    }
    assertPrivateLifecycleJsonFile(resolve(root, entry.name));
  }
}

export function assertLifecycleDirectoryEmpty(root: string): void {
  assertPrivateLifecycleDirectory(root);
  if (readdirSync(root).length !== 0) {
    throw new TypeError("Lifecycle directory is not empty.");
  }
}

export function countCurrentUserProcessReferences(needle: string): number {
  if (
    process.platform !== "linux" ||
    !isAbsolute(needle) ||
    Buffer.byteLength(needle, "utf8") > 4_096
  ) {
    throw new TypeError("Lifecycle process reference query is invalid.");
  }
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new TypeError("Lifecycle process ownership is unavailable.");
  }
  const encodedNeedle = Buffer.from(needle, "utf8");
  let matches = 0;
  for (const entry of readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    const processRoot = `/proc/${entry.name}`;
    try {
      if (lstatSync(processRoot).uid !== uid) continue;
      const command = readBoundedProcessFile(`${processRoot}/cmdline`);
      let referencesRoot = command.includes(encodedNeedle);
      if (!referencesRoot) {
        try {
          referencesRoot = readBoundedProcessFile(
            `${processRoot}/environ`
          ).includes(encodedNeedle);
        } catch (error) {
          if (!isErrno(error, "EACCES") && !isErrno(error, "ENOENT")) {
            throw error;
          }
        }
      }
      if (referencesRoot) matches += 1;
    } catch (error) {
      if (isErrno(error, "EACCES") || isErrno(error, "ENOENT")) continue;
      throw error;
    }
  }
  return matches;
}

export function readPrivateLifecycleJson(path: string): unknown {
  assertPrivateLifecycleJsonFile(path);
  let decoded: unknown;
  try {
    decoded = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new TypeError("Lifecycle scenario report is not valid JSON.", {
      cause: error
    });
  }
  return decoded;
}

export function requireLifecycleEvidencePath(
  candidate: string,
  repositoryRoot: string
): string {
  if (!isAbsolute(candidate) || !isAbsolute(repositoryRoot)) {
    throw new TypeError("Lifecycle evidence paths must be absolute.");
  }
  const path = resolve(candidate);
  const artifacts = resolve(repositoryRoot, "artifacts");
  let canonicalArtifacts: string;
  let canonicalParent: string;
  try {
    canonicalArtifacts = realpathSync(artifacts);
    canonicalParent = realpathSync(dirname(path));
  } catch {
    throw new TypeError("Lifecycle evidence parent is unavailable.");
  }
  const lexicalRelationship = relative(artifacts, path);
  const canonicalRelationship = relative(canonicalArtifacts, canonicalParent);
  if (
    lexicalRelationship === "" ||
    lexicalRelationship === ".." ||
    lexicalRelationship.startsWith("../") ||
    isAbsolute(lexicalRelationship) ||
    canonicalRelationship === ".." ||
    canonicalRelationship.startsWith("../") ||
    isAbsolute(canonicalRelationship) ||
    !/^[a-z0-9][a-z0-9._-]*\.json$/u.test(basename(path))
  ) {
    throw new TypeError("Lifecycle evidence path must be under artifacts.");
  }
  if (existsSync(path)) assertPrivateLifecycleJsonFile(path);
  return path;
}

export function publishPrivateLifecycleJson(
  path: string,
  value: unknown
): unknown {
  if (!isAbsolute(path)) {
    throw new TypeError("Lifecycle evidence path must be absolute.");
  }
  if (existsSync(path)) assertPrivateLifecycleJsonFile(path);
  const stagingPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.publish`
  );
  if (existsSync(stagingPath)) {
    throw new TypeError("Lifecycle evidence staging path already exists.");
  }
  try {
    writeCodexSmokePrivateJson(stagingPath, value);
    readCodexSmokePrivateJson(stagingPath);
    renameSync(stagingPath, path);
    fsyncDirectory(dirname(path));
    return readCodexSmokePrivateJson(path);
  } finally {
    rmSync(stagingPath, { force: true });
  }
}

function assertPrivateLifecycleJsonFile(path: string): void {
  if (!isAbsolute(path)) {
    throw new TypeError("Lifecycle scenario report must be absolute.");
  }
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(path);
  } catch {
    throw new TypeError("Lifecycle scenario report is unavailable.");
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o077) !== 0 ||
    metadata.size < 2 ||
    metadata.size > maximumScenarioReportBytes ||
    (process.getuid !== undefined && metadata.uid !== process.getuid())
  ) {
    throw new TypeError("Lifecycle scenario report is insecure or invalid.");
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readBoundedProcessFile(path: string): Buffer {
  const data = readFileSync(path);
  if (data.byteLength > 1024 * 1_024) {
    throw new TypeError("Lifecycle process metadata exceeds its bound.");
  }
  return data;
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
