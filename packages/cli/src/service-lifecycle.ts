import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  cpSync,
  constants as fsConstants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import type { SelectedHostStatusResponse } from "@hostdeck/contracts";
import { probeCodexVersion } from "@hostdeck/server";
import {
  assertHostDeckServiceManifestMatchesLayout,
  createHostDeckServiceInstallManifest,
  type HostDeckServiceEnvironmentDescriptor,
  type HostDeckServiceInstallLayout,
  type HostDeckServiceInstallManifest,
  hostDeckServiceDirectoryMode,
  hostDeckServiceEnvironmentMode,
  hostDeckServiceInstallManifestMode,
  parseHostDeckServiceInstallManifest,
  renderHostDeckServiceEnvironment,
  renderHostDeckServiceInstallManifest,
  resolveHostDeckServiceInstallLayout
} from "./service-install-manifest.js";
import {
  acquireHostDeckServiceLifecycleLock,
  type HostDeckServiceLifecycleLock,
  HostDeckServiceLifecycleLockError
} from "./service-lifecycle-lock.js";
import { runHostDeckServicePackageVerifier } from "./service-package-verifier.js";
import {
  createHostDeckSystemdUserManager,
  HostDeckSystemdManagerError,
  type HostDeckSystemdUnitState,
  type HostDeckSystemdUserManager,
  hostDeckCodexSystemdUnitName,
  hostDeckSystemdUnitName
} from "./systemd-user-manager.js";
import {
  type GenerateHostDeckSystemdUserUnitsForInstallInput,
  generateHostDeckSystemdUserUnitsForInstall,
  type HostDeckSystemdUserUnitBundle
} from "./systemd-user-units.js";

export type HostDeckServiceAction =
  | "install"
  | "restart"
  | "start"
  | "status"
  | "stop"
  | "upgrade";

export type HostDeckServiceInstallState =
  | "coherent"
  | "corrupt"
  | "not_installed"
  | "partial"
  | "recovery_required";

export type HostDeckServiceApiState =
  | "not_probed"
  | "not_ready"
  | "ready"
  | "unreachable";

export interface HostDeckServicePublicUnitState {
  readonly active_state: string;
  readonly load_state: string;
  readonly main_pid: number;
  readonly need_daemon_reload: boolean;
  readonly sub_state: string;
  readonly unit_file_state: string;
}

export interface HostDeckServiceLifecycleResult {
  readonly action: HostDeckServiceAction;
  readonly api_state: HostDeckServiceApiState;
  readonly changed: boolean;
  readonly enabled: boolean;
  readonly install_state: HostDeckServiceInstallState;
  readonly package_version: string | null;
  readonly release_id: string | null;
  readonly rollback: "not_required" | "succeeded";
  readonly units: Readonly<{
    readonly codex: HostDeckServicePublicUnitState;
    readonly hostdeck: HostDeckServicePublicUnitState;
  }>;
}

export interface HostDeckServiceLifecycle {
  readonly execute: (
    action: HostDeckServiceAction
  ) => Promise<HostDeckServiceLifecycleResult>;
}

export interface HostDeckProductionPackageIdentity {
  readonly codex_version: string;
  readonly content_sha256: string;
  readonly manifest_sha256: string;
  readonly package_version: string;
}

export type VerifyHostDeckProductionPackage = (
  root: string
) => Promise<HostDeckProductionPackageIdentity>;

export interface CreateHostDeckServiceLifecycleOptions {
  readonly base_url: URL;
  readonly codex_bin?: string;
  readonly database_path: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly generate_units?: (
    input: GenerateHostDeckSystemdUserUnitsForInstallInput
  ) => HostDeckSystemdUserUnitBundle;
  readonly manager?: HostDeckSystemdUserManager;
  readonly node_bin: string;
  readonly package_root: string;
  readonly probe_codex_version?: (
    executable: string,
    signal: AbortSignal
  ) => Promise<string>;
  readonly read_host_status: () => Promise<SelectedHostStatusResponse>;
  readonly readiness_timeout_ms?: number;
  readonly signal?: AbortSignal;
  readonly sleep?: (duration_ms: number) => Promise<void>;
  readonly state_dir: string;
  readonly verify_package?: VerifyHostDeckProductionPackage;
}

export type HostDeckServiceLifecycleErrorCode =
  | "already_installed"
  | "install_invalid"
  | "lifecycle_failed"
  | "lock_held"
  | "not_installed"
  | "package_invalid"
  | "readiness_failed"
  | "recovery_required"
  | "rollback_failed"
  | "upgrade_invalid";

export type HostDeckServiceLifecycleStage =
  | "install"
  | "lock"
  | "package"
  | "readiness"
  | "recovery"
  | "restart"
  | "start"
  | "status"
  | "stop"
  | "upgrade";

export class HostDeckServiceLifecycleError extends Error {
  readonly rollback: "failed" | "not_required" | "succeeded";

  constructor(
    readonly code: HostDeckServiceLifecycleErrorCode,
    readonly stage: HostDeckServiceLifecycleStage,
    options: ErrorOptions & {
      readonly rollback?: "failed" | "not_required" | "succeeded";
    } = {}
  ) {
    super("HostDeck service lifecycle operation failed.", options);
    this.name = "HostDeckServiceLifecycleError";
    this.rollback = options.rollback ?? "not_required";
  }
}

interface ServiceInstallationInspection {
  readonly enablement: "absent" | "exact" | "invalid";
  readonly manifest: HostDeckServiceInstallManifest | null;
  readonly state: HostDeckServiceInstallState;
}

interface PreparedRelease {
  readonly created: boolean;
  readonly environment: HostDeckServiceEnvironmentDescriptor;
  readonly manifest: HostDeckServiceInstallManifest;
  readonly units: HostDeckSystemdUserUnitBundle;
}

interface LifecycleContext {
  readonly baseUrl: URL;
  readonly codexBin: string | null;
  readonly databasePath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly generateUnits: NonNullable<
    CreateHostDeckServiceLifecycleOptions["generate_units"]
  >;
  readonly layout: HostDeckServiceInstallLayout;
  readonly manager: HostDeckSystemdUserManager;
  readonly nodeBin: string;
  readonly packageRoot: string;
  readonly probeCodexVersion: (
    executable: string,
    signal: AbortSignal
  ) => Promise<string>;
  readonly readHostStatus: () => Promise<SelectedHostStatusResponse>;
  readonly readinessTimeoutMs: number;
  readonly signal: AbortSignal;
  readonly sleep: (durationMs: number) => Promise<void>;
  readonly stateDir: string;
  readonly verifyPackage: VerifyHostDeckProductionPackage;
}

interface LifecycleTransaction {
  readonly name: "hostdeck-service-transaction";
  readonly next_selector: string;
  readonly operation: "install" | "upgrade";
  readonly phase:
    | "preparing"
    | "prepared"
    | "selected"
    | "manager_reloaded";
  readonly previous_selector: string | null;
  readonly schema_version: 1;
  readonly staging_name: string;
  readonly was_active: boolean;
}

const transactionKeys = Object.freeze([
  "name",
  "next_selector",
  "operation",
  "phase",
  "previous_selector",
  "schema_version",
  "staging_name",
  "was_active"
] as const);
const maximumPackageManifestBytes = 65_536;
const maximumTransactionBytes = 16_384;
const maximumPathBytes = 4_096;
const incompleteReleaseMarkerName = ".hostdeck-incomplete";
const sha256Pattern = /^[a-f0-9]{64}$/u;
const maximumVersionBytes = 256;
const versionPattern = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|(?=[0-9A-Za-z-]*[A-Za-z-])[0-9A-Za-z-]+)(?:\.(?:0|[1-9][0-9]*|(?=[0-9A-Za-z-]*[A-Za-z-])[0-9A-Za-z-]+))*)?$/u;
const stagingNamePattern = /^\.hostdeck-release-[a-f0-9]{32}$/u;
let temporaryCounter = 0;

export function createHostDeckServiceLifecycle(
  options: CreateHostDeckServiceLifecycleOptions
): HostDeckServiceLifecycle {
  const context = validateOptions(options);
  return Object.freeze({
    async execute(action: HostDeckServiceAction) {
      try {
        if (
          action !== "install" &&
          action !== "upgrade" &&
          action !== "status" &&
          action !== "start" &&
          action !== "stop" &&
          action !== "restart"
        ) {
          throw new TypeError("HostDeck service lifecycle action is invalid.");
        }
        if (action === "status") {
          return await readLifecycleResult(context, action, false);
        }
        if (action === "install") return await installService(context);
        if (action === "upgrade") return await upgradeService(context);
        return await withLifecycleLock(context, async () => {
          await recoverPendingTransaction(context);
          const inspection = await inspectInstallation(context, true);
          const manifest = requireCoherentInstallation(inspection);
          const [beforeHostDeck, beforeCodex] = await Promise.all([
            context.manager.show(hostDeckSystemdUnitName),
            context.manager.show(hostDeckCodexSystemdUnitName)
          ]);
          requireInstalledManagerIdentity(
            manifest,
            beforeHostDeck,
            beforeCodex,
            action
          );
          let changed: boolean;
          if (action === "start") {
            changed = !isRunning(beforeHostDeck) || !isRunning(beforeCodex);
            if (changed) await context.manager.startHostDeck();
            await requireReady(context, manifest);
          } else if (action === "stop") {
            changed = !isStopped(beforeHostDeck) || !isStopped(beforeCodex);
            if (changed) {
              await context.manager.stopHostDeck();
              await context.manager.stopCodex();
            }
            await requireStopped(context, manifest);
          } else {
            changed = true;
            await context.manager.restartHostDeck();
            await requireReady(context, manifest);
            await requireCodexContinuity(context, beforeCodex, "restart");
          }
          return await readLifecycleResult(
            context,
            action,
            changed,
            manifest,
            "not_required"
          );
        });
      } catch (error) {
        if (
          error instanceof HostDeckServiceLifecycleError ||
          error instanceof HostDeckSystemdManagerError
        ) {
          throw error;
        }
        throw lifecycleError(
          action === "install" || action === "upgrade"
            ? "install_invalid"
            : "lifecycle_failed",
          action,
          error
        );
      }
    }
  });
}

export function assertHostDeckServiceLifecycleResult(
  candidate: unknown
): asserts candidate is HostDeckServiceLifecycleResult {
  const value = exactLifecycleRecord(candidate, [
    "action",
    "api_state",
    "changed",
    "enabled",
    "install_state",
    "package_version",
    "release_id",
    "rollback",
    "units"
  ]);
  if (
    !["install", "upgrade", "status", "start", "stop", "restart"].includes(
      String(value.action)
    ) ||
    !["not_probed", "not_ready", "ready", "unreachable"].includes(
      String(value.api_state)
    ) ||
    ![
      "coherent",
      "corrupt",
      "not_installed",
      "partial",
      "recovery_required"
    ].includes(String(value.install_state)) ||
    typeof value.changed !== "boolean" ||
    typeof value.enabled !== "boolean" ||
    (value.rollback !== "not_required" && value.rollback !== "succeeded")
  ) {
    throw new TypeError("HostDeck service lifecycle result is invalid.");
  }
  const coherent = value.install_state === "coherent";
  if (
    (coherent &&
      (typeof value.package_version !== "string" ||
        !isSupportedVersion(value.package_version) ||
        typeof value.release_id !== "string" ||
        value.release_id !==
          `${value.package_version}-${value.release_id.slice(value.package_version.length + 1)}` ||
        !sha256Pattern.test(
          value.release_id.slice(value.package_version.length + 1)
        ))) ||
    (!coherent &&
      (value.package_version !== null || value.release_id !== null))
  ) {
    throw new TypeError("HostDeck service lifecycle release result is invalid.");
  }
  const units = exactLifecycleRecord(value.units, ["codex", "hostdeck"]);
  const codex = validatePublicUnit(units.codex);
  const hostDeck = validatePublicUnit(units.hostdeck);
  if (
    value.enabled !== (hostDeck.unit_file_state === "enabled") ||
    (value.api_state === "ready" && hostDeck.active_state !== "active") ||
    (value.api_state === "not_probed" && hostDeck.active_state === "active") ||
    (value.action === "stop" &&
      (hostDeck.active_state === "active" || codex.active_state === "active"))
  ) {
    throw new TypeError("HostDeck service lifecycle state is contradictory.");
  }
}

export async function verifyHostDeckProductionPackage(
  root: string,
  options: {
    readonly node_bin?: string;
    readonly signal?: AbortSignal;
  } = {}
): Promise<HostDeckProductionPackageIdentity> {
  const packageRoot = requireCanonicalDirectory(root, "package");
  const nodeBin = requireCanonicalExecutable(
    options.node_bin ?? process.execPath,
    "package"
  );
  const signal = options.signal ?? new AbortController().signal;
  if (!(signal instanceof AbortSignal)) {
    throw lifecycleError("package_invalid", "package");
  }
  const manifest = readProductionPackageManifest(packageRoot);
  try {
    await runHostDeckServicePackageVerifier({
      node_bin: nodeBin,
      package_root: packageRoot,
      signal,
      timeout_ms: 120_000
    });
  } catch (error) {
    throw lifecycleError("package_invalid", "package", error);
  }
  return Object.freeze(manifest);
}

async function installService(
  context: LifecycleContext
): Promise<HostDeckServiceLifecycleResult> {
  const source = await verifyPackageThroughPort(context, context.packageRoot);
  const environment = createEnvironment(context);
  const codexBin = context.codexBin;
  if (codexBin === null) {
    throw lifecycleError("install_invalid", "install");
  }
  await requireExpectedCodexVersion(
    context,
    codexBin,
    source.codex_version,
    "install"
  );
  return await withLifecycleLock(context, async () => {
    await recoverPendingTransaction(context);
    const existing = await inspectInstallation(context, true);
    if (
      existing.manifest !== null &&
      (existing.state === "coherent" ||
        (existing.state === "partial" && existing.enablement === "absent"))
    ) {
      if (
        existing.manifest.release.package_version !== source.package_version ||
        existing.manifest.release.package_manifest_sha256 !== source.manifest_sha256
      ) {
        throw lifecycleError("already_installed", "install");
      }
      if (existing.manifest.environment.sha256 !== environment.sha256) {
        throw lifecycleError("install_invalid", "install");
      }
      const [hostDeck, codex] = await Promise.all([
        context.manager.show(hostDeckSystemdUnitName),
        context.manager.show(hostDeckCodexSystemdUnitName)
      ]);
      if (existing.enablement === "exact") {
        requireInstalledManagerIdentity(
          existing.manifest,
          hostDeck,
          codex,
          "install"
        );
      } else {
        requireInstallEnablementMissingIdentity(
          existing.manifest,
          hostDeck,
          codex
        );
      }
      const enablementChanged = existing.enablement === "absent";
      if (enablementChanged) {
        await context.manager.daemonReload();
        await context.manager.enableHostDeck();
        canonicalizeManagerEnablement(existing.manifest);
        await requireInstalledStopped(context, existing.manifest, "install");
      }
      return await readLifecycleResult(
        context,
        "install",
        enablementChanged,
        existing.manifest,
        "not_required"
      );
    }
    if (existing.state !== "not_installed") {
      throw lifecycleError("install_invalid", "install");
    }
    requireAbsent(context.layout.enablement_link);
    await assertManagerHasNoHostDeckUnits(context.manager);
    const transaction: LifecycleTransaction = {
      name: "hostdeck-service-transaction",
      next_selector: releaseSelector(source),
      operation: "install",
      phase: "preparing",
      previous_selector: null,
      schema_version: 1,
      staging_name: createStagingName(),
      was_active: false
    };
    writeTransaction(context.layout.transaction_file, transaction);
    let prepared: PreparedRelease;
    try {
      prepared = await prepareRelease(
        context,
        source,
        environment,
        {
          codexBin,
          nodeBin: context.nodeBin
        },
        transaction.staging_name
      );
      updateTransactionPhase(context.layout.transaction_file, "prepared");
    } catch (error) {
      if (
        error instanceof HostDeckServiceLifecycleError &&
        error.code === "recovery_required"
      ) {
        throw error;
      }
      try {
        removeTransactionStaging(context, transaction);
        removeTransaction(context.layout.transaction_file);
      } catch (cleanupError) {
        throw lifecycleError(
          "rollback_failed",
          "install",
          new AggregateError([error, cleanupError]),
          "failed"
        );
      }
      throw error;
    }
    let environmentCreated = false;
    let selectorPublished = false;
    let enableAttempted = false;
    try {
      environmentCreated = publishEnvironment(
        context.layout.environment_file,
        prepared.environment
      );
      publishStableAnchors(context.layout, prepared.manifest);
      publishSelector(
        context.layout.current_link,
        prepared.manifest.release.selector_target
      );
      selectorPublished = true;
      updateTransactionPhase(context.layout.transaction_file, "selected");
      await context.manager.daemonReload();
      updateTransactionPhase(
        context.layout.transaction_file,
        "manager_reloaded"
      );
      enableAttempted = true;
      await context.manager.enableHostDeck();
      canonicalizeManagerEnablement(prepared.manifest);
      await requireInstalledStopped(context, prepared.manifest, "install");
      removeTransaction(context.layout.transaction_file);
      return await readLifecycleResult(
        context,
        "install",
        true,
        prepared.manifest,
        "not_required"
      );
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      try {
        if (
          enableAttempted &&
          existsNoFollow(prepared.manifest.enablement.path)
        ) {
          requireOwnedEnablement(prepared.manifest);
          let disableError: unknown = null;
          try {
            await context.manager.disableHostDeck();
          } catch (managerError) {
            disableError = managerError;
          }
          if (existsNoFollow(prepared.manifest.enablement.path)) {
            throw disableError ?? lifecycleError("lifecycle_failed", "install");
          }
        }
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (selectorPublished) {
        try {
          removeExactSymlink(
            context.layout.current_link,
            prepared.manifest.release.selector_target
          );
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      try {
        removeStableAnchors(context.layout, prepared.manifest);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (environmentCreated) {
        try {
          removeExactRegularFile(
            context.layout.environment_file,
            hostDeckServiceEnvironmentMode,
            prepared.environment.sha256
          );
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      try {
        await context.manager.daemonReload();
        await assertManagerHasNoHostDeckUnits(context.manager);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length === 0) {
        removeTransaction(context.layout.transaction_file);
        throw lifecycleError("lifecycle_failed", "install", error, "succeeded");
      }
      throw lifecycleError(
        "rollback_failed",
        "install",
        new AggregateError([error, ...cleanupErrors]),
        "failed"
      );
    }
  });
}

async function upgradeService(
  context: LifecycleContext
): Promise<HostDeckServiceLifecycleResult> {
  const source = await verifyPackageThroughPort(context, context.packageRoot);
  return await withLifecycleLock(context, async () => {
    await recoverPendingTransaction(context);
    const inspection = await inspectInstallation(context, true);
    const previous = requireCoherentInstallation(inspection);
    const comparison = compareVersions(
      source.package_version,
      previous.release.package_version
    );
    await requireExpectedCodexVersion(
      context,
      previous.runtime.codex_bin,
      source.codex_version,
      "upgrade"
    );
    const beforeHostDeck = await context.manager.show(hostDeckSystemdUnitName);
    const beforeCodex = await context.manager.show(hostDeckCodexSystemdUnitName);
    requireInstalledManagerIdentity(
      previous,
      beforeHostDeck,
      beforeCodex,
      "upgrade"
    );
    if (
      comparison === 0 &&
      source.manifest_sha256 === previous.release.package_manifest_sha256
    ) {
      return await readLifecycleResult(
        context,
        "upgrade",
        false,
        previous,
        "not_required"
      );
    }
    if (comparison <= 0) {
      throw lifecycleError("upgrade_invalid", "upgrade");
    }
    const environment = inspectEnvironment(previous);
    if (
      (!isRunning(beforeHostDeck) && !isStopped(beforeHostDeck)) ||
      (!isRunning(beforeCodex) && !isStopped(beforeCodex)) ||
      (isRunning(beforeHostDeck) && !isRunning(beforeCodex))
    ) {
      throw lifecycleError("upgrade_invalid", "upgrade");
    }
    const wasActive = isRunning(beforeHostDeck);
    if (wasActive) await requireApiReady(context);
    const transaction: LifecycleTransaction = {
      name: "hostdeck-service-transaction",
      next_selector: releaseSelector(source),
      operation: "upgrade",
      phase: "preparing",
      previous_selector: previous.release.selector_target,
      schema_version: 1,
      staging_name: createStagingName(),
      was_active: wasActive
    };
    writeTransaction(context.layout.transaction_file, transaction);
    let prepared: PreparedRelease;
    try {
      prepared = await prepareRelease(
        context,
        source,
        environment,
        {
          codexBin: previous.runtime.codex_bin,
          nodeBin: previous.runtime.node_bin
        },
        transaction.staging_name
      );
      updateTransactionPhase(context.layout.transaction_file, "prepared");
    } catch (error) {
      if (
        error instanceof HostDeckServiceLifecycleError &&
        error.code === "recovery_required"
      ) {
        throw error;
      }
      try {
        removeTransactionStaging(context, transaction);
        removeTransaction(context.layout.transaction_file);
      } catch (cleanupError) {
        throw lifecycleError(
          "rollback_failed",
          "upgrade",
          new AggregateError([error, cleanupError]),
          "failed"
        );
      }
      throw error;
    }
    try {
      replaceExactSelector(
        context.layout.current_link,
        previous.release.selector_target,
        prepared.manifest.release.selector_target
      );
      updateTransactionPhase(context.layout.transaction_file, "selected");
      await context.manager.daemonReload();
      updateTransactionPhase(
        context.layout.transaction_file,
        "manager_reloaded"
      );
      if (wasActive) {
        await context.manager.restartHostDeck();
        await requireReady(context, prepared.manifest);
        await requireCodexContinuity(context, beforeCodex, "upgrade");
      } else {
        await requireInactiveUpgradeState(
          context,
          prepared.manifest,
          beforeCodex
        );
      }
      removeTransaction(context.layout.transaction_file);
      return await readLifecycleResult(
        context,
        "upgrade",
        true,
        prepared.manifest,
        "not_required"
      );
    } catch (error) {
      try {
        restoreSelectorToPrevious(
          context.layout.current_link,
          prepared.manifest.release.selector_target,
          previous.release.selector_target
        );
        await context.manager.daemonReload();
        if (wasActive) {
          await context.manager.restartHostDeck();
          await requireReady(context, previous);
          await requireCodexContinuity(context, beforeCodex, "upgrade");
        } else {
          await requireInactiveUpgradeState(context, previous, beforeCodex);
        }
        removeTransaction(context.layout.transaction_file);
        throw lifecycleError("lifecycle_failed", "upgrade", error, "succeeded");
      } catch (rollbackError) {
        if (
          rollbackError instanceof HostDeckServiceLifecycleError &&
          rollbackError.rollback === "succeeded"
        ) {
          throw rollbackError;
        }
        throw lifecycleError(
          "rollback_failed",
          "upgrade",
          new AggregateError([error, rollbackError]),
          "failed"
        );
      }
    }
  });
}

async function prepareRelease(
  context: LifecycleContext,
  source: HostDeckProductionPackageIdentity,
  environment: HostDeckServiceEnvironmentDescriptor,
  runtime: { readonly codexBin: string; readonly nodeBin: string },
  stagingName: string
): Promise<PreparedRelease> {
  assertExecutable(runtime.nodeBin, "package");
  assertExecutable(runtime.codexBin, "package");
  if (!stagingNamePattern.test(stagingName)) {
    throw lifecycleError("recovery_required", "recovery");
  }
  const releaseId = `${source.package_version}-${source.manifest_sha256}`;
  const releaseRoot = join(context.layout.releases_dir, releaseId);
  if (existsNoFollow(releaseRoot)) {
    const manifest = readReleaseManifest(releaseRoot, context.layout);
    await verifyReleasePackage(context, manifest);
    const units = context.generateUnits({
      codex_bin: runtime.codexBin,
      environment_file: context.layout.environment_file,
      expected_package_version: source.package_version,
      node_bin: runtime.nodeBin,
      package_root: manifest.release.package_root,
      verification_package_root: manifest.release.package_root
    });
    assertUnitFiles(manifest, units);
    return Object.freeze({
      created: false,
      environment,
      manifest,
      units
    });
  }

  ensureOwnedDirectory(context.layout.releases_dir, true);
  const stagingRoot = join(context.layout.releases_dir, stagingName);
  if (existsNoFollow(stagingRoot)) {
    throw lifecycleError("recovery_required", "recovery");
  }
  mkdirSync(stagingRoot, { mode: hostDeckServiceDirectoryMode });
  assertOwnedDirectory(stagingRoot, true);
  fsyncDirectory(context.layout.releases_dir);
  const markerPath = join(stagingRoot, incompleteReleaseMarkerName);
  writeNewRegularFile(
    markerPath,
    incompleteReleaseContent(releaseId),
    0o600
  );
  let releasePublished = false;
  try {
    const stagedPackage = join(stagingRoot, "package");
    cpSync(context.packageRoot, stagedPackage, {
      dereference: false,
      errorOnExist: true,
      force: false,
      recursive: true,
      verbatimSymlinks: true
    });
    restoreCopiedDirectoryModes(context.packageRoot, stagedPackage);
    const stagedIdentity = await verifyPackageThroughPort(context, stagedPackage);
    if (
      stagedIdentity.package_version !== source.package_version ||
      stagedIdentity.manifest_sha256 !== source.manifest_sha256 ||
      stagedIdentity.content_sha256 !== source.content_sha256
    ) {
      throw lifecycleError("package_invalid", "package");
    }
    const packageRoot = join(releaseRoot, "package");
    const units = context.generateUnits({
      codex_bin: runtime.codexBin,
      environment_file: context.layout.environment_file,
      expected_package_version: source.package_version,
      node_bin: runtime.nodeBin,
      package_root: packageRoot,
      verification_package_root: stagedPackage
    });
    if (
      units.package_version !== source.package_version ||
      units.service_host_path !== join(packageRoot, "dist", "service-host.js")
    ) {
      throw lifecycleError("package_invalid", "package");
    }
    const unitsRoot = join(stagingRoot, "units");
    mkdirSync(unitsRoot, { mode: hostDeckServiceDirectoryMode });
    for (const unit of units.units) {
      writeNewRegularFile(join(unitsRoot, unit.name), unit.content, unit.mode);
    }
    const manifest = createHostDeckServiceInstallManifest({
      codex_bin: runtime.codexBin,
      environment_sha256: environment.sha256,
      layout: context.layout,
      node_bin: runtime.nodeBin,
      package_content_sha256: source.content_sha256,
      package_manifest_sha256: source.manifest_sha256,
      package_version: source.package_version,
      units: units.units
    });
    writeNewRegularFile(
      join(stagingRoot, "install.json"),
      renderHostDeckServiceInstallManifest(manifest),
      hostDeckServiceInstallManifestMode
    );
    assertStagedRelease(stagingRoot, manifest, units, context.layout);
    removeExactRegularFile(
      markerPath,
      0o600,
      sha256(incompleteReleaseContent(releaseId))
    );
    fsyncDirectory(stagingRoot);
    renameSync(stagingRoot, releaseRoot);
    releasePublished = true;
    fsyncDirectory(context.layout.releases_dir);
    return Object.freeze({
      created: true,
      environment,
      manifest,
      units
    });
  } catch (error) {
    if (!releasePublished && existsNoFollow(stagingRoot)) {
      assertOwnedDirectory(stagingRoot, true);
      rmSync(stagingRoot, { force: false, recursive: true });
      fsyncDirectory(context.layout.releases_dir);
    }
    if (releasePublished) {
      throw lifecycleError("recovery_required", "recovery", error);
    }
    throw error;
  }
}

function restoreCopiedDirectoryModes(source: string, destination: string): void {
  const sourceMetadata = lstatSync(source);
  const destinationMetadata = lstatSync(destination);
  if (
    sourceMetadata.isSymbolicLink() ||
    destinationMetadata.isSymbolicLink() ||
    !sourceMetadata.isDirectory() ||
    !destinationMetadata.isDirectory()
  ) {
    throw lifecycleError("package_invalid", "package");
  }
  chmodSync(destination, sourceMetadata.mode & 0o7777);

  const sourceEntries = new Map(
    readdirSync(source, { withFileTypes: true }).map((entry) => [
      entry.name,
      entry
    ])
  );
  const destinationEntries = readdirSync(destination, { withFileTypes: true });
  if (sourceEntries.size !== destinationEntries.length) {
    throw lifecycleError("package_invalid", "package");
  }
  for (const entry of destinationEntries) {
    const sourceEntry = sourceEntries.get(entry.name);
    if (sourceEntry === undefined || sourceEntry.isDirectory() !== entry.isDirectory()) {
      throw lifecycleError("package_invalid", "package");
    }
    if (entry.isDirectory()) {
      restoreCopiedDirectoryModes(
        join(source, entry.name),
        join(destination, entry.name)
      );
    }
  }
}

async function inspectInstallation(
  context: LifecycleContext,
  verifyPackage: boolean
): Promise<ServiceInstallationInspection> {
  const layout = context.layout;
  if (existsNoFollow(layout.transaction_file)) {
    return Object.freeze({
      enablement: "invalid" as const,
      manifest: null,
      state: "recovery_required" as const
    });
  }
  const anchorPaths = [
    layout.current_link,
    layout.manifest_link,
    layout.environment_file,
    layout.command_path,
    ...Object.values(layout.unit_paths)
  ];
  const existingCount = anchorPaths.filter(existsNoFollow).length;
  if (existingCount === 0) {
    return Object.freeze({
      enablement: existsNoFollow(layout.enablement_link)
        ? ("invalid" as const)
        : ("absent" as const),
      manifest: null,
      state: existsNoFollow(layout.enablement_link)
        ? ("partial" as const)
        : ("not_installed" as const)
    });
  }
  if (existingCount !== anchorPaths.length) {
    return Object.freeze({
      enablement: existsNoFollow(layout.enablement_link)
        ? ("invalid" as const)
        : ("absent" as const),
      manifest: null,
      state: "partial" as const
    });
  }
  try {
    const selector = requireExactSymlink(layout.current_link);
    if (!isSafeRelativeSelector(selector)) throw new TypeError();
    requireSymlink(layout.manifest_link, "current/install.json");
    const releaseRoot = join(layout.data_root, selector);
    const manifest = readReleaseManifest(releaseRoot, layout);
    if (manifest.release.selector_target !== selector) throw new TypeError();
    assertExecutable(manifest.runtime.node_bin, "status");
    assertExecutable(manifest.runtime.codex_bin, "status");
    inspectEnvironment(manifest);
    requireSymlink(layout.command_path, manifest.command.target);
    for (const unit of manifest.units) requireSymlink(unit.path, unit.target);
    assertUnitFilesFromManifest(manifest);
    if (verifyPackage) await verifyReleasePackage(context, manifest);
    if (!existsNoFollow(layout.enablement_link)) {
      return Object.freeze({
        enablement: "absent" as const,
        manifest,
        state: "partial" as const
      });
    }
    requireSymlink(manifest.enablement.path, manifest.enablement.target);
    return Object.freeze({
      enablement: "exact" as const,
      manifest,
      state: "coherent" as const
    });
  } catch {
    return Object.freeze({
      enablement: "invalid" as const,
      manifest: null,
      state: "corrupt" as const
    });
  }
}

async function readLifecycleResult(
  context: LifecycleContext,
  action: HostDeckServiceAction,
  changed: boolean,
  knownManifest?: HostDeckServiceInstallManifest,
  rollback: "not_required" | "succeeded" = "not_required"
): Promise<HostDeckServiceLifecycleResult> {
  const inspection =
    knownManifest === undefined
      ? await inspectInstallation(context, true)
      : Object.freeze({
          enablement: "exact" as const,
          manifest: knownManifest,
          state: "coherent" as const
        });
  const [hostDeck, codex] = await Promise.all([
    context.manager.show(hostDeckSystemdUnitName),
    context.manager.show(hostDeckCodexSystemdUnitName)
  ]);
  let apiState: HostDeckServiceApiState = "not_probed";
  if (hostDeck.active_state === "active") {
    try {
      const status = await context.readHostStatus();
      apiState = status.local.readiness === "ready" ? "ready" : "not_ready";
    } catch {
      apiState = "unreachable";
    }
  }
  return deepFreeze({
    action,
    api_state: apiState,
    changed,
    enabled: hostDeck.unit_file_state === "enabled",
    install_state: inspection.state,
    package_version:
      inspection.state === "coherent"
        ? (inspection.manifest?.release.package_version ?? null)
        : null,
    release_id:
      inspection.state === "coherent"
        ? (inspection.manifest?.release.id ?? null)
        : null,
    rollback,
    units: {
      codex: publicUnitState(codex),
      hostdeck: publicUnitState(hostDeck)
    }
  });
}

async function requireReady(
  context: LifecycleContext,
  manifest: HostDeckServiceInstallManifest
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started <= context.readinessTimeoutMs) {
    const [hostDeck, codex] = await Promise.all([
      context.manager.show(hostDeckSystemdUnitName),
      context.manager.show(hostDeckCodexSystemdUnitName)
    ]);
    requireInstalledManagerIdentity(
      manifest,
      hostDeck,
      codex,
      "readiness"
    );
    if (
      isRunning(hostDeck) &&
      isRunning(codex)
    ) {
      try {
        const status = await context.readHostStatus();
        if (status.local.readiness === "ready") return;
      } catch {
        // The bounded observation loop retains explicit unreachable truth on timeout.
      }
    }
    if (Date.now() - started >= context.readinessTimeoutMs) break;
    await context.sleep(Math.min(250, context.readinessTimeoutMs));
  }
  throw lifecycleError("readiness_failed", "readiness");
}

async function requireApiReady(context: LifecycleContext): Promise<void> {
  try {
    const status = await context.readHostStatus();
    if (status.local.readiness === "ready") return;
  } catch {
    // A pre-upgrade active process must already have observable API readiness.
  }
  throw lifecycleError("readiness_failed", "readiness");
}

async function requireExpectedCodexVersion(
  context: LifecycleContext,
  executable: string,
  expectedVersion: string,
  stage: "install" | "upgrade"
): Promise<void> {
  try {
    const observed = await context.probeCodexVersion(
      executable,
      context.signal
    );
    if (observed !== expectedVersion) {
      throw new TypeError("Installed Codex version is unsupported.");
    }
  } catch (error) {
    throw lifecycleError("install_invalid", stage, error);
  }
}

async function requireStopped(
  context: LifecycleContext,
  manifest: HostDeckServiceInstallManifest
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started <= context.readinessTimeoutMs) {
    const [hostDeck, codex] = await Promise.all([
      context.manager.show(hostDeckSystemdUnitName),
      context.manager.show(hostDeckCodexSystemdUnitName)
    ]);
    requireInstalledManagerIdentity(manifest, hostDeck, codex, "stop");
    if (isStopped(hostDeck) && isStopped(codex)) return;
    if (Date.now() - started >= context.readinessTimeoutMs) break;
    await context.sleep(Math.min(250, context.readinessTimeoutMs));
  }
  throw lifecycleError("lifecycle_failed", "stop");
}

async function requireInstalledStopped(
  context: LifecycleContext,
  manifest: HostDeckServiceInstallManifest,
  stage: "install" | "upgrade"
): Promise<void> {
  const [hostDeck, codex] = await Promise.all([
    context.manager.show(hostDeckSystemdUnitName),
    context.manager.show(hostDeckCodexSystemdUnitName)
  ]);
  requireInstalledManagerIdentity(manifest, hostDeck, codex, stage);
  if (!isStopped(hostDeck) || !isStopped(codex)) {
    throw lifecycleError("lifecycle_failed", stage);
  }
}

async function requireInactiveUpgradeState(
  context: LifecycleContext,
  manifest: HostDeckServiceInstallManifest,
  beforeCodex: HostDeckSystemdUnitState
): Promise<void> {
  const [hostDeck, codex] = await Promise.all([
    context.manager.show(hostDeckSystemdUnitName),
    context.manager.show(hostDeckCodexSystemdUnitName)
  ]);
  requireInstalledManagerIdentity(manifest, hostDeck, codex, "upgrade");
  const codexPreserved = isRunning(beforeCodex)
    ? isRunning(codex) && codex.main_pid === beforeCodex.main_pid
    : isStopped(codex);
  if (!isStopped(hostDeck) || !codexPreserved) {
    throw lifecycleError("lifecycle_failed", "upgrade");
  }
}

async function requireCodexContinuity(
  context: LifecycleContext,
  before: HostDeckSystemdUnitState,
  stage: "restart" | "upgrade"
): Promise<void> {
  if (!isRunning(before)) return;
  const after = await context.manager.show(hostDeckCodexSystemdUnitName);
  if (!isRunning(after) || after.main_pid !== before.main_pid) {
    throw lifecycleError("lifecycle_failed", stage);
  }
}

function requireInstalledManagerIdentity(
  manifest: HostDeckServiceInstallManifest,
  hostDeck: HostDeckSystemdUnitState,
  codex: HostDeckSystemdUnitState,
  stage: HostDeckServiceLifecycleStage
): void {
  if (
    hostDeck.load_state !== "loaded" ||
    hostDeck.unit_file_state !== "enabled" ||
    hostDeck.need_daemon_reload ||
    hostDeck.fragment_path !== manifest.units[1].path ||
    codex.load_state !== "loaded" ||
    codex.unit_file_state !== "linked" ||
    codex.need_daemon_reload ||
    codex.fragment_path !== manifest.units[0].path ||
    !existsNoFollow(manifest.enablement.path) ||
    requireExactSymlink(manifest.enablement.path) !== manifest.enablement.target
  ) {
    throw lifecycleError("lifecycle_failed", stage);
  }
}

function requireInstallEnablementMissingIdentity(
  manifest: HostDeckServiceInstallManifest,
  hostDeck: HostDeckSystemdUnitState,
  codex: HostDeckSystemdUnitState
): void {
  if (
    hostDeck.load_state !== "loaded" ||
    hostDeck.unit_file_state !== "disabled" ||
    hostDeck.need_daemon_reload ||
    hostDeck.fragment_path !== manifest.units[1].path ||
    codex.load_state !== "loaded" ||
    codex.unit_file_state !== "linked" ||
    codex.need_daemon_reload ||
    codex.fragment_path !== manifest.units[0].path ||
    existsNoFollow(manifest.enablement.path) ||
    !isStopped(hostDeck) ||
    !isStopped(codex)
  ) {
    throw lifecycleError("install_invalid", "install");
  }
}

function isRunning(state: HostDeckSystemdUnitState): boolean {
  return state.active_state === "active" && state.main_pid > 0;
}

function isStopped(state: HostDeckSystemdUnitState): boolean {
  return state.active_state === "inactive" && state.main_pid === 0;
}

async function assertManagerHasNoHostDeckUnits(
  manager: HostDeckSystemdUserManager
): Promise<void> {
  const [hostDeck, codex] = await Promise.all([
    manager.show(hostDeckSystemdUnitName),
    manager.show(hostDeckCodexSystemdUnitName)
  ]);
  if (
    hostDeck.load_state !== "not-found" ||
    codex.load_state !== "not-found" ||
    hostDeck.active_state === "active" ||
    codex.active_state === "active" ||
    hostDeck.fragment_path !== "" ||
    codex.fragment_path !== ""
  ) {
    throw lifecycleError("install_invalid", "install");
  }
}

async function recoverPendingTransaction(
  context: LifecycleContext
): Promise<void> {
  if (!existsNoFollow(context.layout.transaction_file)) return;
  let transaction: LifecycleTransaction;
  try {
    transaction = readTransaction(context.layout.transaction_file);
  } catch (error) {
    throw lifecycleError("recovery_required", "recovery", error);
  }
  try {
    const nextReleaseRoot = join(
      context.layout.data_root,
      transaction.next_selector
    );
    const nextExists = existsNoFollow(nextReleaseRoot);
    const stagingRoot = join(
      context.layout.releases_dir,
      transaction.staging_name
    );
    if (nextExists && existsNoFollow(stagingRoot)) {
      throw new TypeError("HostDeck transaction has two release candidates.");
    }
    const observedSelector = existsNoFollow(context.layout.current_link)
      ? requireExactSymlink(context.layout.current_link)
      : null;

    if (!nextExists) {
      if (transaction.phase !== "preparing") {
        throw new TypeError("HostDeck prepared transaction lost its release.");
      }
      if (transaction.previous_selector === null) {
        if (observedSelector !== null) throw new TypeError();
        assertInitialInstallArtifactsAbsent(context.layout);
      } else {
        if (observedSelector !== transaction.previous_selector) {
          throw new TypeError();
        }
        const previousRoot = join(
          context.layout.data_root,
          transaction.previous_selector
        );
        const previous = readReleaseManifest(previousRoot, context.layout);
        await verifyReleasePackage(context, previous);
        assertInstalledArtifactsExact(context.layout, previous);
      }
      removeTransactionStaging(context, transaction);
      removeTransaction(context.layout.transaction_file);
      return;
    }

    const next = readReleaseManifest(nextReleaseRoot, context.layout);
    await verifyReleasePackage(context, next);
    const managerMayHaveObservedNext =
      transaction.phase === "selected" ||
      transaction.phase === "manager_reloaded";
    if (transaction.previous_selector === null) {
      if (
        observedSelector !== null &&
        observedSelector !== transaction.next_selector
      ) {
        throw new TypeError();
      }
      assertOptionalInitialInstallArtifactsExact(context.layout, next);
      if (existsNoFollow(next.enablement.path)) {
        requireOwnedEnablement(next);
        await context.manager.disableHostDeck();
        requireAbsent(next.enablement.path);
      }
      if (observedSelector === transaction.next_selector) {
        removeExactSymlink(
          context.layout.current_link,
          transaction.next_selector
        );
      }
      removeStableAnchors(context.layout, next);
      removeExactRegularFile(
        context.layout.environment_file,
        next.environment.mode,
        next.environment.sha256
      );
      await context.manager.daemonReload();
    } else {
      const previousRoot = join(
        context.layout.data_root,
        transaction.previous_selector
      );
      const previous = readReleaseManifest(previousRoot, context.layout);
      await verifyReleasePackage(context, previous);
      assertInstalledArtifactsExact(context.layout, previous);
      if (
        observedSelector !== transaction.previous_selector &&
        observedSelector !== transaction.next_selector
      ) {
        throw new TypeError();
      }
      if (observedSelector === transaction.next_selector) {
        replaceExactSelector(
          context.layout.current_link,
          transaction.next_selector,
          transaction.previous_selector
        );
        await context.manager.daemonReload();
        if (transaction.was_active) {
          await context.manager.restartHostDeck();
          await requireReady(context, previous);
        } else {
          await requireRecoveredInactiveState(context, previous);
        }
      } else if (managerMayHaveObservedNext) {
        await context.manager.daemonReload();
        if (transaction.was_active) {
          await context.manager.restartHostDeck();
          await requireReady(context, previous);
        } else {
          await requireRecoveredInactiveState(context, previous);
        }
      }
    }
    removeTransactionStaging(context, transaction);
    removeTransaction(context.layout.transaction_file);
  } catch (error) {
    throw lifecycleError("recovery_required", "recovery", error);
  }
}

async function requireRecoveredInactiveState(
  context: LifecycleContext,
  manifest: HostDeckServiceInstallManifest
): Promise<void> {
  const [hostDeck, codex] = await Promise.all([
    context.manager.show(hostDeckSystemdUnitName),
    context.manager.show(hostDeckCodexSystemdUnitName)
  ]);
  requireInstalledManagerIdentity(manifest, hostDeck, codex, "recovery");
  if (
    !isStopped(hostDeck) ||
    (!isStopped(codex) && !isRunning(codex))
  ) {
    throw lifecycleError("recovery_required", "recovery");
  }
}

async function withLifecycleLock<T>(
  context: LifecycleContext,
  operation: () => Promise<T>
): Promise<T> {
  ensureLifecycleRoots(context.layout);
  let lease: HostDeckServiceLifecycleLock;
  try {
    lease = acquireHostDeckServiceLifecycleLock(context.layout.lifecycle_lock);
  } catch (error) {
    if (
      error instanceof HostDeckServiceLifecycleLockError &&
      error.code === "lock_held"
    ) {
      throw lifecycleError("lock_held", "lock", error);
    }
    throw lifecycleError("install_invalid", "lock", error);
  }
  try {
    const result = await operation();
    try {
      lease.release();
    } catch (error) {
      throw lifecycleError("lifecycle_failed", "lock", error);
    }
    return result;
  } catch (error) {
    if (!lease.released) {
      try {
        lease.release();
      } catch (releaseError) {
        throw lifecycleError(
          "lifecycle_failed",
          "lock",
          new AggregateError([error, releaseError])
        );
      }
    }
    throw error;
  }
}

function validateOptions(
  options: CreateHostDeckServiceLifecycleOptions
): LifecycleContext {
  if (process.platform !== "linux" || process.getuid?.() === 0) {
    throw lifecycleError("install_invalid", "install");
  }
  if (!(options.base_url instanceof URL)) {
    throw new TypeError("HostDeck service base URL is invalid.");
  }
  const baseUrl = new URL(options.base_url.toString());
  if (
    baseUrl.protocol !== "http:" ||
    baseUrl.hostname !== "127.0.0.1" ||
    baseUrl.username !== "" ||
    baseUrl.password !== "" ||
    baseUrl.pathname !== "/" ||
    baseUrl.search !== "" ||
    baseUrl.hash !== ""
  ) {
    throw new TypeError("HostDeck service base URL must be canonical loopback HTTP.");
  }
  const readinessTimeoutMs = options.readiness_timeout_ms ?? 90_000;
  if (
    !Number.isSafeInteger(readinessTimeoutMs) ||
    readinessTimeoutMs < 1 ||
    readinessTimeoutMs > 300_000
  ) {
    throw new TypeError("HostDeck service readiness timeout is invalid.");
  }
  if (typeof options.read_host_status !== "function") {
    throw new TypeError("HostDeck service readiness port is invalid.");
  }
  const sleep = options.sleep ?? defaultSleep;
  if (typeof sleep !== "function") {
    throw new TypeError("HostDeck service sleep port is invalid.");
  }
  const layout = resolveHostDeckServiceInstallLayout(options.env);
  const nodeBin = requireCanonicalExecutable(options.node_bin, "install");
  if (nodeBin !== requireCanonicalExecutable(process.execPath, "install")) {
    throw lifecycleError("install_invalid", "install");
  }
  const codexBin =
    options.codex_bin === undefined
      ? null
      : requireCanonicalExecutable(options.codex_bin, "install");
  const packageRoot = requireCanonicalDirectory(options.package_root, "package");
  const stateDir = parseAbsolutePath(options.state_dir, "state");
  const databasePath = parseAbsolutePath(options.database_path, "database");
  if (!isDescendant(databasePath, stateDir)) {
    throw new TypeError("HostDeck service database path must be inside state.");
  }
  const signal = options.signal ?? new AbortController().signal;
  if (!(signal instanceof AbortSignal)) {
    throw new TypeError("HostDeck service lifecycle signal is invalid.");
  }
  const probeVersion =
    options.probe_codex_version ??
    (async (executable: string, selectedSignal: AbortSignal) =>
      await probeCodexVersion({
        executable,
        signal: selectedSignal,
        timeout_ms: 10_000
      }));
  if (typeof probeVersion !== "function") {
    throw new TypeError("HostDeck Codex version probe is invalid.");
  }
  return Object.freeze({
    baseUrl,
    codexBin,
    databasePath,
    env: options.env,
    generateUnits:
      options.generate_units ?? generateHostDeckSystemdUserUnitsForInstall,
    layout,
    manager:
      options.manager ??
      createHostDeckSystemdUserManager({
        signal
      }),
    nodeBin,
    packageRoot,
    probeCodexVersion: probeVersion,
    readHostStatus: options.read_host_status,
    readinessTimeoutMs,
    signal,
    sleep,
    stateDir,
    verifyPackage:
      options.verify_package ??
      (async (root: string) =>
        await verifyHostDeckProductionPackage(root, {
          node_bin: nodeBin,
          signal
        }))
  });
}

function createEnvironment(
  context: LifecycleContext
): HostDeckServiceEnvironmentDescriptor {
  const port = Number(context.baseUrl.port);
  return renderHostDeckServiceEnvironment({
    database_path: context.databasePath,
    env: context.env,
    home_dir: context.layout.home_dir,
    port,
    state_dir: context.stateDir
  });
}

function ensureLifecycleRoots(layout: HostDeckServiceInstallLayout): void {
  assertOwnedDirectory(layout.home_dir, false);
  ensureOwnedDirectory(dirname(layout.data_root), false);
  ensureOwnedDirectory(layout.data_root, true);
  ensureOwnedDirectory(layout.releases_dir, true);
}

function ensureOwnedDirectory(path: string, exactMode: boolean): void {
  const parsed = parseAbsolutePath(path, "directory");
  const missing: string[] = [];
  let cursor = parsed;
  while (!existsNoFollow(cursor)) {
    missing.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) throw new TypeError("HostDeck service directory root is unavailable.");
    cursor = parent;
  }
  assertSafeAncestor(cursor);
  for (const entry of missing.reverse()) {
    mkdirSync(entry, { mode: hostDeckServiceDirectoryMode });
    assertOwnedDirectory(entry, true);
    fsyncDirectory(dirname(entry));
  }
  assertOwnedDirectory(parsed, exactMode);
}

function assertSafeAncestor(path: string): void {
  const uid = process.getuid?.();
  if (uid === undefined) throw new TypeError();
  let cursor = path;
  for (;;) {
    const metadata = lstatSync(cursor);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      (metadata.uid !== uid && metadata.uid !== 0) ||
      (metadata.mode & 0o022) !== 0 ||
      realpathSync.native(cursor) !== cursor
    ) {
      throw new TypeError("HostDeck service directory ancestor is insecure.");
    }
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

function assertOwnedDirectory(path: string, exactMode: boolean): void {
  assertSafeAncestor(path);
  const metadata = lstatSync(path);
  const uid = process.getuid?.();
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    uid === undefined ||
    metadata.uid !== uid ||
    (metadata.mode & 0o022) !== 0 ||
    (exactMode && (metadata.mode & 0o7777) !== hostDeckServiceDirectoryMode) ||
    realpathSync.native(path) !== path
  ) {
    throw new TypeError("HostDeck service owned directory is insecure.");
  }
}

function publishEnvironment(
  path: string,
  descriptor: HostDeckServiceEnvironmentDescriptor
): boolean {
  ensureOwnedDirectory(dirname(path), true);
  if (existsNoFollow(path)) {
    inspectRegularFile(path, descriptor.mode, descriptor.sha256);
    return false;
  }
  writeNewRegularFile(path, descriptor.content, descriptor.mode);
  return true;
}

function publishStableAnchors(
  layout: HostDeckServiceInstallLayout,
  manifest: HostDeckServiceInstallManifest
): void {
  ensureOwnedDirectory(dirname(layout.command_path), false);
  ensureOwnedDirectory(dirname(layout.environment_file), true);
  ensureOwnedDirectory(layout.systemd_user_dir, false);
  publishSymlink(layout.manifest_link, manifest.manifest_link.target);
  publishSymlink(layout.command_path, manifest.command.target);
  for (const unit of manifest.units) publishSymlink(unit.path, unit.target);
}

function removeStableAnchors(
  layout: HostDeckServiceInstallLayout,
  manifest: HostDeckServiceInstallManifest
): void {
  for (const unit of [...manifest.units].reverse()) {
    removeExactSymlink(unit.path, unit.target);
  }
  removeExactSymlink(layout.command_path, manifest.command.target);
  removeExactSymlink(layout.manifest_link, manifest.manifest_link.target);
}

function assertInitialInstallArtifactsAbsent(
  layout: HostDeckServiceInstallLayout
): void {
  for (const path of [
    layout.current_link,
    layout.manifest_link,
    layout.environment_file,
    layout.command_path,
    layout.enablement_link,
    ...Object.values(layout.unit_paths)
  ]) {
    requireAbsent(path);
  }
}

function assertOptionalInitialInstallArtifactsExact(
  layout: HostDeckServiceInstallLayout,
  manifest: HostDeckServiceInstallManifest
): void {
  for (const [path, target] of [
    [layout.manifest_link, manifest.manifest_link.target],
    [layout.command_path, manifest.command.target],
    ...manifest.units.map((unit) => [unit.path, unit.target] as const)
  ] as const) {
    if (existsNoFollow(path)) requireSymlink(path, target);
  }
  if (existsNoFollow(manifest.enablement.path)) {
    requireOwnedEnablement(manifest);
  }
  if (existsNoFollow(layout.environment_file)) inspectEnvironment(manifest);
}

function assertInstalledArtifactsExact(
  layout: HostDeckServiceInstallLayout,
  manifest: HostDeckServiceInstallManifest
): void {
  requireSymlink(layout.manifest_link, manifest.manifest_link.target);
  requireSymlink(layout.command_path, manifest.command.target);
  for (const unit of manifest.units) requireSymlink(unit.path, unit.target);
  requireSymlink(manifest.enablement.path, manifest.enablement.target);
  inspectEnvironment(manifest);
}

function publishSymlink(path: string, target: string): void {
  if (existsNoFollow(path)) {
    requireSymlink(path, target);
    return;
  }
  symlinkSync(target, path);
  fsyncDirectory(dirname(path));
  requireSymlink(path, target);
}

function canonicalizeManagerEnablement(
  manifest: HostDeckServiceInstallManifest
): void {
  const observed = requireOwnedEnablement(manifest);
  if (observed === manifest.enablement.target) return;
  replaceAbsoluteSymlink(
    manifest.enablement.path,
    observed,
    manifest.enablement.target
  );
}

function requireOwnedEnablement(
  manifest: HostDeckServiceInstallManifest
): string {
  const observed = requireExactSymlink(manifest.enablement.path);
  if (
    observed !== manifest.enablement.target &&
    observed !== managerEnablementTarget(manifest)
  ) {
    throw new TypeError("HostDeck service enablement ownership changed.");
  }
  return observed;
}

function managerEnablementTarget(
  manifest: HostDeckServiceInstallManifest
): string {
  return join(
    manifest.release.root,
    "units",
    hostDeckSystemdUnitName
  );
}

function replaceAbsoluteSymlink(
  path: string,
  previousTarget: string,
  nextTarget: string
): void {
  parseAbsolutePath(nextTarget, "symlink target");
  requireSymlink(path, previousTarget);
  const temporary = temporaryPath(path);
  symlinkSync(nextTarget, temporary);
  try {
    renameSync(temporary, path);
    fsyncDirectory(dirname(path));
  } finally {
    if (existsNoFollow(temporary)) unlinkSync(temporary);
  }
  requireSymlink(path, nextTarget);
}

function requireAbsent(path: string): void {
  if (existsNoFollow(path)) {
    throw new TypeError("HostDeck service path must be absent.");
  }
}

function publishSelector(path: string, target: string): void {
  requireAbsent(path);
  replaceSelector(path, target);
}

function replaceExactSelector(
  path: string,
  previousTarget: string,
  nextTarget: string
): void {
  requireSymlink(path, previousTarget);
  replaceSelector(path, nextTarget);
}

function restoreSelectorToPrevious(
  path: string,
  failedTarget: string,
  previousTarget: string
): void {
  const observed = requireExactSymlink(path);
  if (observed === previousTarget) return;
  if (observed !== failedTarget) {
    throw new TypeError("HostDeck service selector ownership changed.");
  }
  replaceSelector(path, previousTarget);
}

function replaceSelector(path: string, target: string): void {
  if (!isSafeRelativeSelector(target)) throw new TypeError();
  const temporary = temporaryPath(path);
  symlinkSync(target, temporary);
  try {
    renameSync(temporary, path);
    fsyncDirectory(dirname(path));
  } finally {
    if (existsNoFollow(temporary)) unlinkSync(temporary);
  }
  requireSymlink(path, target);
}

function requireSymlink(path: string, target: string): void {
  const observed = requireExactSymlink(path);
  if (observed !== target) throw new TypeError("HostDeck service symlink target is invalid.");
}

function requireExactSymlink(path: string): string {
  const metadata = lstatSync(path);
  if (
    !metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid?.() ||
    metadata.size < 1 ||
    metadata.size > maximumPathBytes
  ) {
    throw new TypeError("HostDeck service symlink is invalid.");
  }
  const target = readlinkSync(path);
  if (target.includes("\0") || Buffer.byteLength(target, "utf8") > maximumPathBytes) {
    throw new TypeError("HostDeck service symlink target is invalid.");
  }
  return target;
}

function removeExactSymlink(path: string, target: string): void {
  if (!existsNoFollow(path)) return;
  requireSymlink(path, target);
  unlinkSync(path);
  fsyncDirectory(dirname(path));
}

function writeNewRegularFile(path: string, content: string, mode: number): void {
  const descriptor = openSync(
    path,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_NOFOLLOW,
    mode
  );
  try {
    writeFileSync(descriptor, content, { encoding: "utf8" });
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, mode);
  fsyncDirectory(dirname(path));
}

function writeAtomicRegularFile(path: string, content: string, mode: number): void {
  const temporary = temporaryPath(path);
  writeNewRegularFile(temporary, content, mode);
  try {
    renameSync(temporary, path);
    fsyncDirectory(dirname(path));
  } finally {
    if (existsNoFollow(temporary)) unlinkSync(temporary);
  }
}

function inspectRegularFile(path: string, mode: number, expectedSha256: string): string {
  const metadata = lstatSync(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.uid !== process.getuid?.() ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o7777) !== mode ||
    realpathSync.native(path) !== path
  ) {
    throw new TypeError("HostDeck service owned file is invalid.");
  }
  const content = readFileSync(path, "utf8");
  if (sha256(content) !== expectedSha256) {
    throw new TypeError("HostDeck service owned file identity is invalid.");
  }
  return content;
}

function removeExactRegularFile(
  path: string,
  mode: number,
  expectedSha256: string
): void {
  if (!existsNoFollow(path)) return;
  inspectRegularFile(path, mode, expectedSha256);
  unlinkSync(path);
  fsyncDirectory(dirname(path));
}

function readReleaseManifest(
  releaseRoot: string,
  layout: HostDeckServiceInstallLayout
): HostDeckServiceInstallManifest {
  assertOwnedDirectory(releaseRoot, true);
  if (existsNoFollow(join(releaseRoot, incompleteReleaseMarkerName))) {
    throw new TypeError("HostDeck service release is incomplete.");
  }
  const path = join(releaseRoot, "install.json");
  const metadata = lstatSync(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.uid !== process.getuid?.() ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o7777) !== hostDeckServiceInstallManifestMode ||
    metadata.size < 1 ||
    metadata.size > 131_072
  ) {
    throw new TypeError("HostDeck service release manifest is invalid.");
  }
  const manifest = parseHostDeckServiceInstallManifest(readFileSync(path, "utf8"));
  assertHostDeckServiceManifestMatchesLayout(manifest, layout);
  if (manifest.release.root !== releaseRoot) throw new TypeError();
  return manifest;
}

function inspectEnvironment(
  manifest: HostDeckServiceInstallManifest
): HostDeckServiceEnvironmentDescriptor {
  const content = inspectRegularFile(
    manifest.environment.path,
    manifest.environment.mode,
    manifest.environment.sha256
  );
  return Object.freeze({
    content,
    mode: hostDeckServiceEnvironmentMode,
    sha256: manifest.environment.sha256
  });
}

function assertUnitFiles(
  manifest: HostDeckServiceInstallManifest,
  bundle: HostDeckSystemdUserUnitBundle
): void {
  for (let index = 0; index < manifest.units.length; index += 1) {
    const installed = manifest.units[index];
    const generated = bundle.units[index];
    if (
      installed === undefined ||
      generated === undefined ||
      installed.name !== generated.name ||
      installed.mode !== generated.mode ||
      installed.sha256 !== generated.sha256
    ) {
      throw new TypeError("HostDeck service generated units do not match release.");
    }
    inspectRegularFile(
      join(manifest.release.root, "units", installed.name),
      installed.mode,
      installed.sha256
    );
  }
}

function assertStagedRelease(
  stagingRoot: string,
  manifest: HostDeckServiceInstallManifest,
  bundle: HostDeckSystemdUserUnitBundle,
  layout: HostDeckServiceInstallLayout
): void {
  assertOwnedDirectory(stagingRoot, true);
  inspectRegularFile(
    join(stagingRoot, incompleteReleaseMarkerName),
    0o600,
    sha256(incompleteReleaseContent(manifest.release.id))
  );
  for (let index = 0; index < manifest.units.length; index += 1) {
    const installed = manifest.units[index];
    const generated = bundle.units[index];
    if (
      installed === undefined ||
      generated === undefined ||
      installed.name !== generated.name ||
      installed.mode !== generated.mode ||
      installed.sha256 !== generated.sha256
    ) {
      throw new TypeError("HostDeck staged service units are inconsistent.");
    }
    inspectRegularFile(
      join(stagingRoot, "units", installed.name),
      installed.mode,
      installed.sha256
    );
  }
  const expectedManifest = renderHostDeckServiceInstallManifest(manifest);
  const observedManifest = inspectRegularFile(
    join(stagingRoot, "install.json"),
    hostDeckServiceInstallManifestMode,
    sha256(expectedManifest)
  );
  const parsed = parseHostDeckServiceInstallManifest(observedManifest);
  assertHostDeckServiceManifestMatchesLayout(parsed, layout);
  if (parsed.manifest_sha256 !== manifest.manifest_sha256) {
    throw new TypeError("HostDeck staged service manifest is inconsistent.");
  }
}

function assertUnitFilesFromManifest(
  manifest: HostDeckServiceInstallManifest
): void {
  for (const unit of manifest.units) {
    inspectRegularFile(
      join(manifest.release.root, "units", unit.name),
      unit.mode,
      unit.sha256
    );
  }
}

async function verifyReleasePackage(
  context: LifecycleContext,
  manifest: HostDeckServiceInstallManifest
): Promise<void> {
  const verified = await verifyPackageThroughPort(
    context,
    manifest.release.package_root
  );
  if (
    verified.package_version !== manifest.release.package_version ||
    verified.manifest_sha256 !== manifest.release.package_manifest_sha256 ||
    verified.content_sha256 !== manifest.release.package_content_sha256
  ) {
    throw lifecycleError("package_invalid", "package");
  }
}

async function verifyPackageThroughPort(
  context: LifecycleContext,
  root: string
): Promise<HostDeckProductionPackageIdentity> {
  try {
    const identity = await context.verifyPackage(root);
    if (
      identity === null ||
      typeof identity !== "object" ||
      typeof identity.codex_version !== "string" ||
      !isSupportedVersion(identity.codex_version) ||
      typeof identity.package_version !== "string" ||
      !isSupportedVersion(identity.package_version) ||
      typeof identity.manifest_sha256 !== "string" ||
      !sha256Pattern.test(identity.manifest_sha256) ||
      typeof identity.content_sha256 !== "string" ||
      !sha256Pattern.test(identity.content_sha256)
    ) {
      throw new TypeError();
    }
    return Object.freeze({ ...identity });
  } catch (error) {
    if (
      error instanceof HostDeckServiceLifecycleError &&
      error.code === "package_invalid"
    ) {
      throw error;
    }
    throw lifecycleError("package_invalid", "package", error);
  }
}

function writeTransaction(path: string, transaction: LifecycleTransaction): void {
  if (existsNoFollow(path)) throw lifecycleError("recovery_required", "recovery");
  writeNewRegularFile(path, renderTransaction(transaction), 0o600);
}

function createStagingName(): string {
  return `.hostdeck-release-${randomBytes(16).toString("hex")}`;
}

function releaseSelector(identity: HostDeckProductionPackageIdentity): string {
  return join(
    "releases",
    `${identity.package_version}-${identity.manifest_sha256}`
  );
}

function removeTransactionStaging(
  context: LifecycleContext,
  transaction: LifecycleTransaction
): void {
  if (!stagingNamePattern.test(transaction.staging_name)) {
    throw lifecycleError("recovery_required", "recovery");
  }
  const stagingRoot = join(
    context.layout.releases_dir,
    transaction.staging_name
  );
  if (!existsNoFollow(stagingRoot)) return;
  assertOwnedDirectory(stagingRoot, true);
  rmSync(stagingRoot, { force: false, recursive: true });
  fsyncDirectory(context.layout.releases_dir);
}

function updateTransactionPhase(
  path: string,
  phase: LifecycleTransaction["phase"]
): void {
  const transaction = readTransaction(path);
  writeAtomicRegularFile(path, renderTransaction({ ...transaction, phase }), 0o600);
}

function readTransaction(path: string): LifecycleTransaction {
  const metadata = lstatSync(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.uid !== process.getuid?.() ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o7777) !== 0o600 ||
    metadata.size < 1 ||
    metadata.size > maximumTransactionBytes
  ) {
    throw new TypeError("HostDeck service transaction is invalid.");
  }
  const content = readFileSync(path, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new TypeError("HostDeck service transaction JSON is invalid.");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join("\0") !==
      [...transactionKeys].sort().join("\0")
  ) {
    throw new TypeError("HostDeck service transaction shape is invalid.");
  }
  const transaction = value as Record<string, unknown>;
  if (
    transaction.schema_version !== 1 ||
    transaction.name !== "hostdeck-service-transaction" ||
    (transaction.operation !== "install" && transaction.operation !== "upgrade") ||
    (transaction.phase !== "preparing" &&
      transaction.phase !== "prepared" &&
      transaction.phase !== "selected" &&
      transaction.phase !== "manager_reloaded") ||
    typeof transaction.was_active !== "boolean" ||
    typeof transaction.staging_name !== "string" ||
    !stagingNamePattern.test(transaction.staging_name) ||
    !isSafeRelativeSelector(transaction.next_selector) ||
    (transaction.previous_selector !== null &&
      !isSafeRelativeSelector(transaction.previous_selector)) ||
    (transaction.operation === "install") !==
      (transaction.previous_selector === null) ||
    (transaction.operation === "install" && transaction.was_active) ||
    transaction.previous_selector === transaction.next_selector
  ) {
    throw new TypeError("HostDeck service transaction identity is invalid.");
  }
  const parsed = deepFreeze({
    name: "hostdeck-service-transaction" as const,
    next_selector: transaction.next_selector,
    operation: transaction.operation,
    phase: transaction.phase,
    previous_selector: transaction.previous_selector,
    schema_version: 1 as const,
    staging_name: transaction.staging_name,
    was_active: transaction.was_active
  }) as LifecycleTransaction;
  if (renderTransaction(parsed) !== content) {
    throw new TypeError("HostDeck service transaction is not canonical.");
  }
  return parsed;
}

function renderTransaction(transaction: LifecycleTransaction): string {
  return `${stableJson(transaction)}\n`;
}

function removeTransaction(path: string): void {
  if (!existsNoFollow(path)) return;
  readTransaction(path);
  unlinkSync(path);
  fsyncDirectory(dirname(path));
}

function readProductionPackageManifest(
  packageRoot: string
): HostDeckProductionPackageIdentity {
  const path = join(packageRoot, "hostdeck-package.json");
  const metadata = lstatSync(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    metadata.size < 1 ||
    metadata.size > maximumPackageManifestBytes
  ) {
    throw lifecycleError("package_invalid", "package");
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw lifecycleError("package_invalid", "package", error);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw lifecycleError("package_invalid", "package");
  }
  const manifest = value as Record<string, unknown>;
  const content = manifest.content;
  const codex = manifest.codex;
  if (
    manifest.schemaVersion !== 4 ||
    manifest.name !== "hostdeck-production-package" ||
    typeof manifest.packageVersion !== "string" ||
    !isSupportedVersion(manifest.packageVersion) ||
    typeof manifest.manifestSha256 !== "string" ||
    !sha256Pattern.test(manifest.manifestSha256) ||
    codex === null ||
    typeof codex !== "object" ||
    Array.isArray(codex) ||
    typeof (codex as Record<string, unknown>).codexVersion !== "string" ||
    !isSupportedVersion(
      (codex as Record<string, unknown>).codexVersion as string
    ) ||
    content === null ||
    typeof content !== "object" ||
    Array.isArray(content) ||
    typeof (content as Record<string, unknown>).sha256 !== "string" ||
    !sha256Pattern.test((content as Record<string, unknown>).sha256 as string)
  ) {
    throw lifecycleError("package_invalid", "package");
  }
  const contentSha256 = (content as Record<string, unknown>).sha256;
  if (typeof contentSha256 !== "string") {
    throw lifecycleError("package_invalid", "package");
  }
  return Object.freeze({
    codex_version: (codex as Record<string, unknown>).codexVersion as string,
    content_sha256: contentSha256,
    manifest_sha256: manifest.manifestSha256,
    package_version: manifest.packageVersion
  });
}

function requireCoherentInstallation(
  inspection: ServiceInstallationInspection
): HostDeckServiceInstallManifest {
  if (inspection.state !== "coherent" || inspection.manifest === null) {
    throw lifecycleError(
      inspection.state === "not_installed" ? "not_installed" : "install_invalid",
      "status"
    );
  }
  return inspection.manifest;
}

function publicUnitState(
  state: HostDeckSystemdUnitState
): HostDeckServicePublicUnitState {
  return Object.freeze({
    active_state: state.active_state,
    load_state: state.load_state,
    main_pid: state.main_pid,
    need_daemon_reload: state.need_daemon_reload,
    sub_state: state.sub_state,
    unit_file_state: state.unit_file_state
  });
}

function validatePublicUnit(candidate: unknown): HostDeckServicePublicUnitState {
  const value = exactLifecycleRecord(candidate, [
    "active_state",
    "load_state",
    "main_pid",
    "need_daemon_reload",
    "sub_state",
    "unit_file_state"
  ]);
  for (const key of [
    "active_state",
    "load_state",
    "sub_state",
    "unit_file_state"
  ] as const) {
    const token = value[key];
    if (
      typeof token !== "string" ||
      token.length > 64 ||
      (token.length > 0 && !/^[a-z0-9_-]+$/u.test(token))
    ) {
      throw new TypeError("HostDeck service lifecycle unit result is invalid.");
    }
  }
  if (
    !Number.isSafeInteger(value.main_pid) ||
    (value.main_pid as number) < 0 ||
    typeof value.need_daemon_reload !== "boolean" ||
    (value.active_state === "active" && (value.main_pid as number) < 1)
  ) {
    throw new TypeError("HostDeck service lifecycle unit result is invalid.");
  }
  return value as unknown as HostDeckServicePublicUnitState;
}

function exactLifecycleRecord(
  candidate: unknown,
  keys: readonly string[]
): Record<string, unknown> {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Object.getPrototypeOf(candidate) !== Object.prototype
  ) {
    throw new TypeError("HostDeck service lifecycle result is invalid.");
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
    throw new TypeError("HostDeck service lifecycle result keys are invalid.");
  }
  return Object.fromEntries(
    expected.map((key) => [key, descriptors[key]?.value])
  );
}

function requireCanonicalExecutable(
  candidate: string,
  stage: HostDeckServiceLifecycleStage
): string {
  const path = parseAbsolutePath(candidate, "executable");
  try {
    const canonical = realpathSync.native(path);
    const metadata = lstatSync(canonical);
    if (
      canonical !== path ||
      metadata.isSymbolicLink() ||
      !metadata.isFile()
    ) {
      throw new TypeError();
    }
    accessExecutable(canonical);
    return canonical;
  } catch (error) {
    throw lifecycleError("install_invalid", stage, error);
  }
}

function assertExecutable(
  candidate: string,
  stage: HostDeckServiceLifecycleStage
): void {
  requireCanonicalExecutable(candidate, stage);
}

function accessExecutable(path: string): void {
  const descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  closeSync(descriptor);
  try {
    const mode = lstatSync(path).mode;
    if ((mode & 0o111) === 0) throw new TypeError();
  } catch (error) {
    throw new TypeError("HostDeck service executable is inaccessible.", {
      cause: error
    });
  }
}

function requireCanonicalDirectory(
  candidate: string,
  stage: HostDeckServiceLifecycleStage
): string {
  const path = parseAbsolutePath(candidate, "directory");
  try {
    const canonical = realpathSync.native(path);
    const metadata = lstatSync(canonical);
    if (
      canonical !== path ||
      metadata.isSymbolicLink() ||
      !metadata.isDirectory()
    ) {
      throw new TypeError();
    }
    return canonical;
  } catch (error) {
    throw lifecycleError("package_invalid", stage, error);
  }
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

function isDescendant(candidate: string, root: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function isSafeRelativeSelector(candidate: unknown): candidate is string {
  return (
    typeof candidate === "string" &&
    candidate.startsWith(`releases${sep}`) &&
    !isAbsolute(candidate) &&
    normalize(candidate) === candidate &&
    !candidate.includes("..") &&
    Buffer.byteLength(candidate, "utf8") <= maximumPathBytes &&
    !/[\0\r\n]/u.test(candidate)
  );
}

function existsNoFollow(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function temporaryPath(path: string): string {
  temporaryCounter += 1;
  return join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${temporaryCounter}.tmp`
  );
}

function incompleteReleaseContent(releaseId: string): string {
  return `HostDeck incomplete release ${releaseId}\n`;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError();
  return serialized;
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    if (!isSupportedVersion(value)) {
      throw lifecycleError("upgrade_invalid", "upgrade");
    }
    const separator = value.indexOf("-");
    const core = separator === -1 ? value : value.slice(0, separator);
    const prerelease = separator === -1 ? null : value.slice(separator + 1);
    const numbers = core.split(".");
    return { numbers, prerelease: prerelease?.split(".") ?? null };
  };
  const leftVersion = parse(left);
  const rightVersion = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const comparison = compareNumericIdentifiers(
      leftVersion.numbers[index] as string,
      rightVersion.numbers[index] as string
    );
    if (comparison !== 0) return comparison;
  }
  if (leftVersion.prerelease === null) {
    return rightVersion.prerelease === null ? 0 : 1;
  }
  if (rightVersion.prerelease === null) return -1;
  const length = Math.max(
    leftVersion.prerelease.length,
    rightVersion.prerelease.length
  );
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftVersion.prerelease[index];
    const rightPart = rightVersion.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^[0-9]+$/u.test(leftPart);
    const rightNumeric = /^[0-9]+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return compareNumericIdentifiers(leftPart, rightPart);
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function compareNumericIdentifiers(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function isSupportedVersion(candidate: unknown): candidate is string {
  return (
    typeof candidate === "string" &&
    Buffer.byteLength(candidate, "utf8") <= maximumVersionBytes &&
    versionPattern.test(candidate)
  );
}

function defaultSleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function lifecycleError(
  code: HostDeckServiceLifecycleErrorCode,
  stage: HostDeckServiceLifecycleStage,
  cause?: unknown,
  rollback: "failed" | "not_required" | "succeeded" = "not_required"
): HostDeckServiceLifecycleError {
  return new HostDeckServiceLifecycleError(code, stage, {
    rollback,
    ...(cause === undefined ? {} : { cause })
  });
}
