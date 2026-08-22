import { createHash } from "node:crypto";
import { delimiter, isAbsolute, join, normalize, relative, sep } from "node:path";
import { deepFreezeExactData } from "@hostdeck/contracts";
import {
  hostDeckCodexSystemdUnitName,
  hostDeckSystemdUnitName
} from "./systemd-user-manager.js";
import type { HostDeckSystemdUserUnitDescriptor } from "./systemd-user-units.js";

export const hostDeckServiceInstallManifestSchemaVersion = 1;
export const hostDeckServiceEnvironmentMode = 0o600;
export const hostDeckServiceInstallManifestMode = 0o600;
export const hostDeckServiceDirectoryMode = 0o700;

export interface HostDeckServiceInstallLayout {
  readonly command_path: string;
  readonly config_root: string;
  readonly current_link: string;
  readonly data_root: string;
  readonly enablement_link: string;
  readonly environment_file: string;
  readonly home_dir: string;
  readonly lifecycle_lock: string;
  readonly manifest_link: string;
  readonly releases_dir: string;
  readonly systemd_user_dir: string;
  readonly transaction_file: string;
  readonly unit_paths: Readonly<{
    readonly "hostdeck-codex.service": string;
    readonly "hostdeck.service": string;
  }>;
}

export interface RenderHostDeckServiceEnvironmentInput {
  readonly database_path: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home_dir: string;
  readonly port: number;
  readonly state_dir: string;
}

export interface HostDeckServiceEnvironmentDescriptor {
  readonly content: string;
  readonly mode: typeof hostDeckServiceEnvironmentMode;
  readonly sha256: string;
}

export interface HostDeckServiceInstallManifestUnit {
  readonly mode: 420;
  readonly name:
    | typeof hostDeckCodexSystemdUnitName
    | typeof hostDeckSystemdUnitName;
  readonly path: string;
  readonly sha256: string;
  readonly target: string;
}

export interface HostDeckServiceInstallManifest {
  readonly command: Readonly<{
    readonly path: string;
    readonly target: string;
  }>;
  readonly enablement: Readonly<{
    readonly path: string;
    readonly target: string;
    readonly unit: typeof hostDeckSystemdUnitName;
  }>;
  readonly environment: Readonly<{
    readonly mode: typeof hostDeckServiceEnvironmentMode;
    readonly path: string;
    readonly sha256: string;
  }>;
  readonly manifest_link: Readonly<{
    readonly path: string;
    readonly target: "current/install.json";
  }>;
  readonly manifest_sha256: string;
  readonly name: "hostdeck-service-install";
  readonly ownership: Readonly<{
    readonly current_link: string;
    readonly data_root: string;
    readonly lifecycle_lock: string;
    readonly transaction_file: string;
  }>;
  readonly release: Readonly<{
    readonly id: string;
    readonly package_content_sha256: string;
    readonly package_manifest_sha256: string;
    readonly package_root: string;
    readonly package_version: string;
    readonly root: string;
    readonly selector_target: string;
  }>;
  readonly runtime: Readonly<{
    readonly codex_bin: string;
    readonly node_bin: string;
  }>;
  readonly schema_version: typeof hostDeckServiceInstallManifestSchemaVersion;
  readonly units: readonly [
    HostDeckServiceInstallManifestUnit,
    HostDeckServiceInstallManifestUnit
  ];
}

export interface CreateHostDeckServiceInstallManifestInput {
  readonly codex_bin: string;
  readonly environment_sha256: string;
  readonly layout: HostDeckServiceInstallLayout;
  readonly node_bin: string;
  readonly package_content_sha256: string;
  readonly package_manifest_sha256: string;
  readonly package_version: string;
  readonly units: readonly [
    HostDeckSystemdUserUnitDescriptor,
    HostDeckSystemdUserUnitDescriptor
  ];
}

const maximumPathBytes = 4_096;
const maximumEnvironmentBytes = 65_536;
const maximumManifestBytes = 131_072;
const maximumVersionBytes = 256;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const versionPattern = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|(?=[0-9A-Za-z-]*[A-Za-z-])[0-9A-Za-z-]+)(?:\.(?:0|[1-9][0-9]*|(?=[0-9A-Za-z-]*[A-Za-z-])[0-9A-Za-z-]+))*)?$/u;
const environmentKeys = Object.freeze([
  "CODEX_HOME",
  "HOME",
  "HOSTDECK_DATABASE_PATH",
  "HOSTDECK_PORT",
  "HOSTDECK_STATE_DIR",
  "PATH",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME"
] as const);

export function resolveHostDeckServiceInstallLayout(
  env: Readonly<Record<string, string | undefined>>
): HostDeckServiceInstallLayout {
  const homeDir = parseAbsolutePath(env.HOME, "HOME");
  const dataHome = parseAbsolutePath(
    env.XDG_DATA_HOME ?? join(homeDir, ".local", "share"),
    "XDG_DATA_HOME"
  );
  const configRoot = parseAbsolutePath(
    env.XDG_CONFIG_HOME ?? join(homeDir, ".config"),
    "XDG_CONFIG_HOME"
  );
  const dataRoot = join(dataHome, "hostdeck");
  const systemdUserDir = join(configRoot, "systemd", "user");
  const configHostRoot = join(configRoot, "hostdeck");
  const commandPath = join(homeDir, ".local", "bin", "codexdeck");
  const currentLink = join(dataRoot, "current");
  const unitPaths = Object.freeze({
    [hostDeckCodexSystemdUnitName]: join(
      systemdUserDir,
      hostDeckCodexSystemdUnitName
    ),
    [hostDeckSystemdUnitName]: join(systemdUserDir, hostDeckSystemdUnitName)
  });
  for (const [left, right] of [
    [dataRoot, configHostRoot],
    [dataRoot, systemdUserDir],
    [dataRoot, commandPath],
    [configHostRoot, commandPath],
    [systemdUserDir, commandPath]
  ] as const) {
    assertSeparatePaths(left, right);
  }
  return deepFreezeExactData({
    command_path: commandPath,
    config_root: configRoot,
    current_link: currentLink,
    data_root: dataRoot,
    enablement_link: join(
      systemdUserDir,
      "default.target.wants",
      hostDeckSystemdUnitName
    ),
    environment_file: join(configHostRoot, "service.env"),
    home_dir: homeDir,
    lifecycle_lock: join(dataRoot, "lifecycle.lock"),
    manifest_link: join(dataRoot, "install.json"),
    releases_dir: join(dataRoot, "releases"),
    systemd_user_dir: systemdUserDir,
    transaction_file: join(dataRoot, "lifecycle-transaction.json"),
    unit_paths: unitPaths
  });
}

export function renderHostDeckServiceEnvironment(
  input: RenderHostDeckServiceEnvironmentInput
): HostDeckServiceEnvironmentDescriptor {
  const homeDir = parseAbsolutePath(input.home_dir, "HOME");
  const stateDir = parseAbsolutePath(input.state_dir, "HOSTDECK_STATE_DIR");
  const databasePath = parseAbsolutePath(
    input.database_path,
    "HOSTDECK_DATABASE_PATH"
  );
  if (!isDescendant(databasePath, stateDir)) {
    throw new TypeError("HostDeck service database path must be inside state.");
  }
  if (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65_535) {
    throw new TypeError("HostDeck service port is invalid.");
  }
  const path = parseEnvironmentPath(input.env.PATH);
  const values = new Map<string, string>([
    ["HOME", homeDir],
    ["HOSTDECK_DATABASE_PATH", databasePath],
    ["HOSTDECK_PORT", String(input.port)],
    ["HOSTDECK_STATE_DIR", stateDir],
    ["PATH", path]
  ]);
  for (const key of ["CODEX_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const) {
    const value = input.env[key];
    if (value === undefined) continue;
    values.set(key, parseAbsolutePath(value, key));
  }
  const lines = [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${encodeEnvironmentValue(value)}`);
  if (
    lines.some((line) => !environmentKeys.some((key) => line.startsWith(`${key}=`)))
  ) {
    throw new TypeError("HostDeck service environment key is unsupported.");
  }
  const content = `${lines.join("\n")}\n`;
  if (Buffer.byteLength(content, "utf8") > maximumEnvironmentBytes) {
    throw new TypeError("HostDeck service environment is too large.");
  }
  return Object.freeze({
    content,
    mode: hostDeckServiceEnvironmentMode,
    sha256: sha256(content)
  });
}

export function createHostDeckServiceInstallManifest(
  input: CreateHostDeckServiceInstallManifestInput
): HostDeckServiceInstallManifest {
  const packageVersion = parseVersion(input.package_version);
  const packageManifestSha256 = parseSha256(
    input.package_manifest_sha256,
    "package manifest"
  );
  const packageContentSha256 = parseSha256(
    input.package_content_sha256,
    "package content"
  );
  const environmentSha256 = parseSha256(
    input.environment_sha256,
    "environment"
  );
  const nodeBin = parseAbsolutePath(input.node_bin, "Node executable");
  const codexBin = parseAbsolutePath(input.codex_bin, "Codex executable");
  const layout = input.layout;
  const releaseId = `${packageVersion}-${packageManifestSha256}`;
  const releaseRoot = join(layout.releases_dir, releaseId);
  const packageRoot = join(releaseRoot, "package");
  const selectorTarget = join("releases", releaseId);
  const expectedUnits = [
    hostDeckCodexSystemdUnitName,
    hostDeckSystemdUnitName
  ] as const;
  if (
    input.units.length !== expectedUnits.length ||
    input.units.some(
      (unit, index) =>
        unit.name !== expectedUnits[index] ||
        unit.mode !== 0o644 ||
        !sha256Pattern.test(unit.sha256) ||
        sha256(unit.content) !== unit.sha256
    )
  ) {
    throw new TypeError("HostDeck service unit descriptors are invalid.");
  }
  const units = Object.freeze(
    input.units.map((unit) =>
      Object.freeze({
        mode: 0o644 as const,
        name: unit.name,
        path: layout.unit_paths[unit.name],
        sha256: unit.sha256,
        target: join(layout.current_link, "units", unit.name)
      })
    )
  ) as HostDeckServiceInstallManifest["units"];
  const unsigned = {
    command: {
      path: layout.command_path,
      target: join(layout.current_link, "package", "dist", "shell.js")
    },
    enablement: {
      path: layout.enablement_link,
      target: layout.unit_paths[hostDeckSystemdUnitName],
      unit: hostDeckSystemdUnitName
    },
    environment: {
      mode: hostDeckServiceEnvironmentMode,
      path: layout.environment_file,
      sha256: environmentSha256
    },
    manifest_link: {
      path: layout.manifest_link,
      target: "current/install.json" as const
    },
    name: "hostdeck-service-install" as const,
    ownership: {
      current_link: layout.current_link,
      data_root: layout.data_root,
      lifecycle_lock: layout.lifecycle_lock,
      transaction_file: layout.transaction_file
    },
    release: {
      id: releaseId,
      package_content_sha256: packageContentSha256,
      package_manifest_sha256: packageManifestSha256,
      package_root: packageRoot,
      package_version: packageVersion,
      root: releaseRoot,
      selector_target: selectorTarget
    },
    runtime: {
      codex_bin: codexBin,
      node_bin: nodeBin
    },
    schema_version: hostDeckServiceInstallManifestSchemaVersion,
    units
  } as const;
  const manifest = {
    ...unsigned,
    manifest_sha256: sha256(stableJson(unsigned))
  } satisfies HostDeckServiceInstallManifest;
  return validateManifest(manifest);
}

export function renderHostDeckServiceInstallManifest(
  manifest: HostDeckServiceInstallManifest
): string {
  const validated = validateManifest(manifest);
  const content = `${stableJson(validated)}\n`;
  if (Buffer.byteLength(content, "utf8") > maximumManifestBytes) {
    throw new TypeError("HostDeck service install manifest is too large.");
  }
  return content;
}

export function parseHostDeckServiceInstallManifest(
  content: string
): HostDeckServiceInstallManifest {
  if (
    typeof content !== "string" ||
    Buffer.byteLength(content, "utf8") > maximumManifestBytes ||
    !content.endsWith("\n") ||
    content.includes("\0")
  ) {
    throw new TypeError("HostDeck service install manifest encoding is invalid.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new TypeError("HostDeck service install manifest JSON is invalid.");
  }
  const manifest = validateManifest(parsed);
  if (renderHostDeckServiceInstallManifest(manifest) !== content) {
    throw new TypeError("HostDeck service install manifest is not canonical.");
  }
  return manifest;
}

export function assertHostDeckServiceManifestMatchesLayout(
  manifest: HostDeckServiceInstallManifest,
  layout: HostDeckServiceInstallLayout
): void {
  const releaseRoot = join(layout.releases_dir, manifest.release.id);
  const expected = {
    command_path: layout.command_path,
    command_target: join(
      layout.current_link,
      "package",
      "dist",
      "shell.js"
    ),
    current_link: layout.current_link,
    data_root: layout.data_root,
    enablement_path: layout.enablement_link,
    enablement_target: layout.unit_paths[hostDeckSystemdUnitName],
    environment_path: layout.environment_file,
    lifecycle_lock: layout.lifecycle_lock,
    manifest_path: layout.manifest_link,
    manifest_target: "current/install.json",
    package_root: join(releaseRoot, "package"),
    release_root: releaseRoot,
    selector_target: join("releases", manifest.release.id),
    transaction_file: layout.transaction_file,
    units: [
      {
        name: hostDeckCodexSystemdUnitName,
        path: layout.unit_paths[hostDeckCodexSystemdUnitName],
        target: join(
          layout.current_link,
          "units",
          hostDeckCodexSystemdUnitName
        )
      },
      {
        name: hostDeckSystemdUnitName,
        path: layout.unit_paths[hostDeckSystemdUnitName],
        target: join(layout.current_link, "units", hostDeckSystemdUnitName)
      }
    ]
  };
  const actual = {
    command_path: manifest.command.path,
    command_target: manifest.command.target,
    current_link: manifest.ownership.current_link,
    data_root: manifest.ownership.data_root,
    enablement_path: manifest.enablement.path,
    enablement_target: manifest.enablement.target,
    environment_path: manifest.environment.path,
    lifecycle_lock: manifest.ownership.lifecycle_lock,
    manifest_path: manifest.manifest_link.path,
    manifest_target: manifest.manifest_link.target,
    package_root: manifest.release.package_root,
    release_root: manifest.release.root,
    selector_target: manifest.release.selector_target,
    transaction_file: manifest.ownership.transaction_file,
    units: manifest.units.map((unit) => ({
      name: unit.name,
      path: unit.path,
      target: unit.target
    }))
  };
  if (stableJson(expected) !== stableJson(actual)) {
    throw new TypeError("HostDeck service install manifest layout is invalid.");
  }
}

function validateManifest(candidate: unknown): HostDeckServiceInstallManifest {
  const manifest = exactRecord(candidate, [
    "command",
    "enablement",
    "environment",
    "manifest_link",
    "manifest_sha256",
    "name",
    "ownership",
    "release",
    "runtime",
    "schema_version",
    "units"
  ]);
  if (
    manifest.schema_version !== hostDeckServiceInstallManifestSchemaVersion ||
    manifest.name !== "hostdeck-service-install"
  ) {
    throw new TypeError("HostDeck service install manifest schema is unsupported.");
  }
  const command = exactRecord(manifest.command, ["path", "target"]);
  const enablement = exactRecord(manifest.enablement, ["path", "target", "unit"]);
  const environment = exactRecord(manifest.environment, ["mode", "path", "sha256"]);
  const manifestLink = exactRecord(manifest.manifest_link, ["path", "target"]);
  const ownership = exactRecord(manifest.ownership, [
    "current_link",
    "data_root",
    "lifecycle_lock",
    "transaction_file"
  ]);
  const release = exactRecord(manifest.release, [
    "id",
    "package_content_sha256",
    "package_manifest_sha256",
    "package_root",
    "package_version",
    "root",
    "selector_target"
  ]);
  const runtime = exactRecord(manifest.runtime, ["codex_bin", "node_bin"]);
  if (!Array.isArray(manifest.units) || manifest.units.length !== 2) {
    throw new TypeError("HostDeck service install manifest units are invalid.");
  }
  const units = manifest.units.map((unit) =>
    exactRecord(unit, ["mode", "name", "path", "sha256", "target"])
  );
  const packageVersion = parseVersion(release.package_version);
  const packageManifestSha256 = parseSha256(
    release.package_manifest_sha256,
    "package manifest"
  );
  const expectedReleaseId = `${packageVersion}-${packageManifestSha256}`;
  if (
    release.id !== expectedReleaseId ||
    release.selector_target !== join("releases", expectedReleaseId) ||
    release.package_root !== join(parseAbsolutePath(release.root, "release root"), "package") ||
    manifestLink.target !== "current/install.json" ||
    enablement.unit !== hostDeckSystemdUnitName ||
    environment.mode !== hostDeckServiceEnvironmentMode
  ) {
    throw new TypeError("HostDeck service install manifest identity is invalid.");
  }
  const parseUnit = (
    unit: Record<string, unknown>,
    expectedName:
      | typeof hostDeckCodexSystemdUnitName
      | typeof hostDeckSystemdUnitName
  ): HostDeckServiceInstallManifestUnit => {
    if (
      unit.name !== expectedName ||
      unit.mode !== 0o644 ||
      unit.target !==
        join(
          parseAbsolutePath(ownership.current_link, "current link"),
          "units",
          expectedName
        )
    ) {
      throw new TypeError("HostDeck service install manifest unit is invalid.");
    }
    return Object.freeze({
      mode: 0o644 as const,
      name: expectedName,
      path: parseAbsolutePath(unit.path, "unit path"),
      sha256: parseSha256(unit.sha256, "unit"),
      target: parseAbsolutePath(unit.target, "unit target")
    });
  };
  const parsedUnits = Object.freeze([
    parseUnit(units[0] as Record<string, unknown>, hostDeckCodexSystemdUnitName),
    parseUnit(units[1] as Record<string, unknown>, hostDeckSystemdUnitName)
  ]) as HostDeckServiceInstallManifest["units"];
  const unsigned = {
    command: {
      path: parseAbsolutePath(command.path, "command path"),
      target: parseAbsolutePath(command.target, "command target")
    },
    enablement: {
      path: parseAbsolutePath(enablement.path, "enablement path"),
      target: parseAbsolutePath(enablement.target, "enablement target"),
      unit: hostDeckSystemdUnitName
    },
    environment: {
      mode: hostDeckServiceEnvironmentMode,
      path: parseAbsolutePath(environment.path, "environment path"),
      sha256: parseSha256(environment.sha256, "environment")
    },
    manifest_link: {
      path: parseAbsolutePath(manifestLink.path, "manifest link"),
      target: "current/install.json" as const
    },
    name: "hostdeck-service-install" as const,
    ownership: {
      current_link: parseAbsolutePath(ownership.current_link, "current link"),
      data_root: parseAbsolutePath(ownership.data_root, "data root"),
      lifecycle_lock: parseAbsolutePath(ownership.lifecycle_lock, "lifecycle lock"),
      transaction_file: parseAbsolutePath(
        ownership.transaction_file,
        "transaction file"
      )
    },
    release: {
      id: expectedReleaseId,
      package_content_sha256: parseSha256(
        release.package_content_sha256,
        "package content"
      ),
      package_manifest_sha256: packageManifestSha256,
      package_root: parseAbsolutePath(release.package_root, "package root"),
      package_version: packageVersion,
      root: parseAbsolutePath(release.root, "release root"),
      selector_target: release.selector_target
    },
    runtime: {
      codex_bin: parseAbsolutePath(runtime.codex_bin, "Codex executable"),
      node_bin: parseAbsolutePath(runtime.node_bin, "Node executable")
    },
    schema_version: hostDeckServiceInstallManifestSchemaVersion,
    units: parsedUnits
  } as const;
  const manifestSha256 = parseSha256(manifest.manifest_sha256, "manifest");
  if (sha256(stableJson(unsigned)) !== manifestSha256) {
    throw new TypeError("HostDeck service install manifest hash is invalid.");
  }
  return deepFreezeExactData({ ...unsigned, manifest_sha256: manifestSha256 });
}

function exactRecord(
  candidate: unknown,
  keys: readonly string[]
): Record<string, unknown> {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Object.getPrototypeOf(candidate) !== Object.prototype
  ) {
    throw new TypeError("HostDeck service install manifest object is invalid.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  const actual = Reflect.ownKeys(descriptors)
    .filter((key): key is string => typeof key === "string")
    .sort();
  const expected = [...keys].sort();
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index]) ||
    expected.some((key) => {
      const descriptor = descriptors[key];
      return (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      );
    })
  ) {
    throw new TypeError("HostDeck service install manifest keys are invalid.");
  }
  return Object.fromEntries(
    expected.map((key) => [key, descriptors[key]?.value])
  );
}

function parseVersion(candidate: unknown): string {
  if (
    typeof candidate !== "string" ||
    Buffer.byteLength(candidate, "utf8") > maximumVersionBytes ||
    !versionPattern.test(candidate)
  ) {
    throw new TypeError("HostDeck service package version is invalid.");
  }
  return candidate;
}

function parseSha256(candidate: unknown, label: string): string {
  if (typeof candidate !== "string" || !sha256Pattern.test(candidate)) {
    throw new TypeError(`HostDeck service ${label} SHA-256 is invalid.`);
  }
  return candidate;
}

function parseAbsolutePath(candidate: unknown, label: string): string {
  if (
    typeof candidate !== "string" ||
    !isAbsolute(candidate) ||
    candidate === "/" ||
    normalize(candidate) !== candidate ||
    Buffer.byteLength(candidate, "utf8") > maximumPathBytes ||
    /[\0\r\n]/u.test(candidate)
  ) {
    throw new TypeError(`HostDeck service ${label} path is invalid.`);
  }
  return candidate;
}

function parseEnvironmentValue(candidate: unknown, label: string): string {
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    Buffer.byteLength(candidate, "utf8") > maximumEnvironmentBytes ||
    /[\0\r\n]/u.test(candidate)
  ) {
    throw new TypeError(`HostDeck service ${label} value is invalid.`);
  }
  return candidate;
}

function parseEnvironmentPath(candidate: unknown): string {
  const value = parseEnvironmentValue(candidate, "PATH");
  const entries = value.split(delimiter);
  if (
    entries.length < 1 ||
    entries.length > 256 ||
    entries.some(
      (entry) =>
        !isAbsolute(entry) ||
        entry === "/" ||
        normalize(entry) !== entry ||
        Buffer.byteLength(entry, "utf8") > maximumPathBytes
    )
  ) {
    throw new TypeError("HostDeck service PATH value is invalid.");
  }
  return value;
}

function encodeEnvironmentValue(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function assertSeparatePaths(left: string, right: string): void {
  if (left === right || isDescendant(left, right) || isDescendant(right, left)) {
    throw new TypeError("HostDeck service install paths must be separate.");
  }
}

function isDescendant(candidate: string, root: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right)
    );
    return `{${entries
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("HostDeck service manifest value is invalid.");
  }
  return serialized;
}

