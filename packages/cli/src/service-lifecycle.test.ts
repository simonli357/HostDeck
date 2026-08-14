import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SelectedHostStatusResponse } from "@hostdeck/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { resolveHostDeckServiceInstallLayout } from "./service-install-manifest.js";
import {
  assertHostDeckServiceLifecycleResult,
  createHostDeckServiceLifecycle,
  type HostDeckProductionPackageIdentity
} from "./service-lifecycle.js";
import { acquireHostDeckServiceLifecycleLock } from "./service-lifecycle-lock.js";
import {
  type HostDeckSystemdUnitName,
  type HostDeckSystemdUnitState,
  type HostDeckSystemdUserManager,
  hostDeckCodexSystemdUnitName,
  hostDeckSystemdUnitName
} from "./systemd-user-manager.js";
import type {
  GenerateHostDeckSystemdUserUnitsForInstallInput,
  HostDeckSystemdUserUnitBundle
} from "./systemd-user-units.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0).reverse()) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("IFC-V1-056 service lifecycle owner", () => {
  it("rejects start before install with lifecycle coordination only", async () => {
    const fixture = createFixture();
    const source = createSourcePackage(fixture, "1.0.0", "0");
    const lifecycle = createLifecycle(fixture, source);

    await expect(lifecycle.execute("start")).rejects.toMatchObject({
      code: "not_installed",
      stage: "status"
    });
    expect(fixture.manager.calls).toEqual([]);
    expect(readdirSync(fixture.layout.data_root)).toEqual(["lifecycle.lock"]);
    expect(mode(fixture.layout.lifecycle_lock)).toBe(0o600);
    expect(existsSync(fixture.layout.releases_dir)).toBe(false);

    await expect(lifecycle.execute("install")).resolves.toMatchObject({
      action: "install",
      install_state: "coherent"
    });
  });

  it("removes immutable staging after package preparation fails", async () => {
    const fixture = createFixture();
    const source = createSourcePackage(fixture, "1.0.0", "f");
    const sourceDist = join(source.root, "dist");
    chmodSync(join(source.root, "hostdeck-package.json"), 0o444);
    chmodSync(join(sourceDist, "shell.js"), 0o555);
    chmodSync(sourceDist, 0o555);
    chmodSync(source.root, 0o555);

    try {
      await expect(
        createLifecycle(fixture, source, {
          generateUnits: () => {
            throw new Error("injected package preparation failure");
          }
        }).execute("install")
      ).rejects.toMatchObject({ code: "install_invalid", stage: "install" });
      expect(existsSync(fixture.layout.transaction_file)).toBe(false);
      expect(readdirSync(fixture.layout.releases_dir)).toEqual([]);
    } finally {
      chmodSync(source.root, 0o755);
      chmodSync(sourceDist, 0o755);
    }
  });

  it("uninstalls an immutable published package tree", async () => {
    const fixture = createFixture();
    const source = createSourcePackage(fixture, "1.0.0", "e");
    const sourceDist = join(source.root, "dist");
    chmodSync(join(source.root, "hostdeck-package.json"), 0o444);
    chmodSync(join(sourceDist, "shell.js"), 0o555);
    chmodSync(sourceDist, 0o555);
    chmodSync(source.root, 0o555);

    try {
      const lifecycle = createLifecycle(fixture, source);
      await expect(lifecycle.execute("install")).resolves.toMatchObject({
        install_state: "coherent"
      });
      await expect(lifecycle.execute("uninstall")).resolves.toMatchObject({
        action: "uninstall",
        changed: true,
        install_state: "not_installed"
      });
      expect(existsSync(fixture.layout.releases_dir)).toBe(false);
      expect(readdirSync(fixture.layout.data_root)).toEqual(["lifecycle.lock"]);
    } finally {
      chmodSync(source.root, 0o755);
      chmodSync(sourceDist, 0o755);
    }
  });

  it("installs without start, stays idempotent, then starts, restarts HostDeck only, reports, and stops both", async () => {
    const fixture = createFixture();
    const source = createSourcePackage(fixture, "1.0.0", "1");
    const lifecycle = createLifecycle(fixture, source);
    const before = snapshotTree(fixture.home);

    const absent = await lifecycle.execute("status");
    expect(absent).toMatchObject({
      action: "status",
      api_state: "not_probed",
      changed: false,
      enabled: false,
      install_state: "not_installed",
      package_version: null,
      release_id: null
    });
    expect(snapshotTree(fixture.home)).toEqual(before);

    const installed = await lifecycle.execute("install");
    expect(installed).toMatchObject({
      action: "install",
      api_state: "not_probed",
      changed: true,
      enabled: true,
      install_state: "coherent",
      package_version: "1.0.0"
    });
    expect(installed.units.hostdeck.active_state).toBe("inactive");
    expect(installed.units.codex.active_state).toBe("inactive");
    const layout = fixture.layout;
    const selector = readlinkSync(layout.current_link);
    const releaseRoot = join(layout.data_root, selector);
    expect(readlinkSync(layout.command_path)).toBe(
      join(layout.current_link, "package", "dist", "shell.js")
    );
    expect(readlinkSync(layout.manifest_link)).toBe("current/install.json");
    expect(readlinkSync(layout.enablement_link)).toBe(
      layout.unit_paths[hostDeckSystemdUnitName]
    );
    expect(mode(layout.environment_file)).toBe(0o600);
    expect(mode(join(releaseRoot, "install.json"))).toBe(0o600);
    expect(mode(join(releaseRoot, "package"))).toBe(0o755);
    expect(mode(join(releaseRoot, "package", "dist"))).toBe(0o755);
    expect(mode(join(releaseRoot, "units", hostDeckSystemdUnitName))).toBe(
      0o644
    );
    const unit = readFileSync(
      join(releaseRoot, "units", hostDeckSystemdUnitName),
      "utf8"
    );
    expect(unit).toContain(join(releaseRoot, "package"));
    expect(unit).not.toContain(".hostdeck-release-");
    expect(fixture.manager.calls).not.toContain("start_hostdeck");

    const treeAfterInstall = snapshotTree(fixture.home);
    const repeated = await lifecycle.execute("install");
    expect(repeated.changed).toBe(false);
    expect(fixture.manager.calls).not.toContain("start_hostdeck");
    expect(
      snapshotTree(fixture.home).filter(
        (line) => !line.includes("lifecycle.lock")
      )
    ).toEqual(
      treeAfterInstall.filter((line) => !line.includes("lifecycle.lock"))
    );

    const started = await lifecycle.execute("start");
    expect(started.api_state).toBe("ready");
    expect(started.units.hostdeck.active_state).toBe("active");
    expect(started.units.codex.active_state).toBe("active");
    const codexPid = started.units.codex.main_pid;
    const hostDeckPid = started.units.hostdeck.main_pid;
    const repeatedStart = await lifecycle.execute("start");
    expect(repeatedStart.changed).toBe(false);
    expect(repeatedStart.units.codex.main_pid).toBe(codexPid);
    expect(repeatedStart.units.hostdeck.main_pid).toBe(hostDeckPid);

    const restarted = await lifecycle.execute("restart");
    expect(restarted.api_state).toBe("ready");
    expect(restarted.units.codex.main_pid).toBe(codexPid);
    expect(restarted.units.hostdeck.main_pid).not.toBe(hostDeckPid);
    expect(fixture.manager.calls.filter((call) => call === "restart_hostdeck")).toHaveLength(1);
    expect(fixture.manager.calls).not.toContain("restart_codex");

    const status = await lifecycle.execute("status");
    expect(status).toMatchObject({
      action: "status",
      api_state: "ready",
      enabled: true,
      install_state: "coherent"
    });

    const stopped = await lifecycle.execute("stop");
    expect(stopped.api_state).toBe("not_probed");
    expect(stopped.units.hostdeck.main_pid).toBe(0);
    expect(stopped.units.codex.main_pid).toBe(0);
    const repeatedStop = await lifecycle.execute("stop");
    expect(repeatedStop.changed).toBe(false);
    expect(
      fixture.manager.calls.filter((call) => call.startsWith("stop_"))
    ).toEqual(["stop_hostdeck", "stop_codex"]);
  });

  it("upgrades inactive and active installs, preserves Codex, retains releases, and rolls back failed readiness", async () => {
    const fixture = createFixture();
    const first = createSourcePackage(fixture, "1.0.0", "1");
    const second = createSourcePackage(fixture, "1.1.0", "2");
    const third = createSourcePackage(fixture, "1.2.0", "3");
    mkdirSync(fixture.stateDir, { mode: 0o700 });
    writeFileSync(fixture.databasePath, "state-sentinel\n", { mode: 0o600 });
    const configSentinel = join(
      fixture.home,
      "config",
      "hostdeck",
      "config.json"
    );
    mkdirSync(join(fixture.home, "config", "hostdeck"), {
      mode: 0o700,
      recursive: true
    });
    writeFileSync(configSentinel, "config-sentinel\n", { mode: 0o600 });
    const stateHash = sha256(readFileSync(fixture.databasePath));
    const configHash = sha256(readFileSync(configSentinel));
    const firstLifecycle = createLifecycle(fixture, first);
    await firstLifecycle.execute("install");
    const firstSelector = readlinkSync(fixture.layout.current_link);

    const secondLifecycle = createLifecycle(fixture, second);
    const inactiveUpgrade = await secondLifecycle.execute("upgrade");
    expect(inactiveUpgrade).toMatchObject({
      action: "upgrade",
      api_state: "not_probed",
      changed: true,
      package_version: "1.1.0"
    });
    expect(fixture.manager.calls).not.toContain("restart_hostdeck");
    const secondSelector = readlinkSync(fixture.layout.current_link);
    expect(secondSelector).not.toBe(firstSelector);
    expect(existsSync(join(fixture.layout.data_root, firstSelector))).toBe(true);

    const started = await secondLifecycle.execute("start");
    const codexPid = started.units.codex.main_pid;
    const thirdLifecycle = createLifecycle(fixture, third);
    const activeUpgrade = await thirdLifecycle.execute("upgrade");
    expect(activeUpgrade.package_version).toBe("1.2.0");
    expect(activeUpgrade.api_state).toBe("ready");
    expect(activeUpgrade.units.codex.main_pid).toBe(codexPid);
    const thirdSelector = readlinkSync(fixture.layout.current_link);
    expect(thirdSelector).not.toBe(secondSelector);

    const failed = createSourcePackage(fixture, "1.3.0", "4");
    fixture.manager.failNextRestart = true;
    await expect(createLifecycle(fixture, failed).execute("upgrade")).rejects.toMatchObject({
      code: "lifecycle_failed",
      rollback: "succeeded",
      stage: "upgrade"
    });
    expect(readlinkSync(fixture.layout.current_link)).toBe(thirdSelector);
    expect(existsSync(fixture.layout.transaction_file)).toBe(false);
    expect(fixture.manager.codex.main_pid).toBe(codexPid);
    expect(sha256(readFileSync(fixture.databasePath))).toBe(stateHash);
    expect(sha256(readFileSync(configSentinel))).toBe(configHash);
  });

  it("preserves independently active Codex during an inactive HostDeck upgrade", async () => {
    const fixture = createFixture();
    const first = createSourcePackage(fixture, "1.0.0", "a");
    const second = createSourcePackage(fixture, "2.0.0", "b");
    const firstLifecycle = createLifecycle(fixture, first);
    await firstLifecycle.execute("install");
    const started = await firstLifecycle.execute("start");
    const codexPid = started.units.codex.main_pid;
    fixture.manager.hostDeck = inactive(fixture.manager.hostDeck);
    const callsBeforeUpgrade = fixture.manager.calls.length;

    const upgraded = await createLifecycle(fixture, second).execute("upgrade");

    expect(upgraded).toMatchObject({
      api_state: "not_probed",
      package_version: "2.0.0"
    });
    expect(upgraded.units.hostdeck.active_state).toBe("inactive");
    expect(upgraded.units.codex.main_pid).toBe(codexPid);
    expect(
      fixture.manager.calls.slice(callsBeforeUpgrade).filter((call) =>
        /^(?:restart|stop)_/u.test(call)
      )
    ).toEqual([]);
  });

  it("stops transient and failed units instead of misclassifying them as stopped", async () => {
    const fixture = createFixture();
    const source = createSourcePackage(fixture, "1.0.0", "c");
    const lifecycle = createLifecycle(fixture, source);
    await lifecycle.execute("install");
    fixture.manager.hostDeck = {
      ...fixture.manager.hostDeck,
      active_state: "deactivating",
      main_pid: 35_735,
      sub_state: "stop-sigterm"
    };
    fixture.manager.codex = {
      ...fixture.manager.codex,
      active_state: "failed",
      main_pid: 0,
      sub_state: "failed"
    };

    const stopped = await lifecycle.execute("stop");

    expect(stopped.changed).toBe(true);
    expect(stopped.units.hostdeck).toMatchObject({
      active_state: "inactive",
      main_pid: 0
    });
    expect(stopped.units.codex).toMatchObject({
      active_state: "inactive",
      main_pid: 0
    });
    expect(
      fixture.manager.calls.filter((call) => call.startsWith("stop_"))
    ).toEqual(["stop_hostdeck", "stop_codex"]);
  });

  it("waits through post-stop deactivation until both units are inactive", async () => {
    const fixture = createFixture();
    const source = createSourcePackage(fixture, "1.0.0", "b");
    const lifecycle = createLifecycle(fixture, source);
    await lifecycle.execute("install");
    await lifecycle.execute("start");
    fixture.manager.stopObservationDelay = 1;

    const stopped = await lifecycle.execute("stop");

    expect(stopped.units.hostdeck).toMatchObject({
      active_state: "inactive",
      main_pid: 0
    });
    expect(stopped.units.codex).toMatchObject({
      active_state: "inactive",
      main_pid: 0
    });
  });

  it("refuses manager identity drift before any lifecycle mutation", async () => {
    const fixture = createFixture();
    const source = createSourcePackage(fixture, "1.0.0", "c");
    const lifecycle = createLifecycle(fixture, source);
    await lifecycle.execute("install");
    fixture.manager.hostDeck = {
      ...fixture.manager.hostDeck,
      fragment_path: "/foreign/hostdeck.service"
    };
    const callsBefore = [...fixture.manager.calls];

    await expect(lifecycle.execute("start")).rejects.toMatchObject({
      code: "lifecycle_failed",
      stage: "start"
    });
    expect(fixture.manager.calls.slice(callsBefore.length)).toEqual([
      "show:hostdeck.service",
      "show:hostdeck-codex.service"
    ]);
    expect(fixture.manager.calls).not.toContain("start_hostdeck");
  });

  it("compensates a failed install, rejects package failure before write, and exposes corrupt/recovery state read-only", async () => {
    const fixture = createFixture();
    const source = createSourcePackage(fixture, "1.0.0", "1");
    fixture.manager.failEnable = true;
    await expect(createLifecycle(fixture, source).execute("install")).rejects.toMatchObject({
      code: "lifecycle_failed",
      rollback: "succeeded",
      stage: "install"
    });
    fixture.manager.failEnable = false;
    expect(existsSync(fixture.layout.current_link)).toBe(false);
    expect(existsSync(fixture.layout.command_path)).toBe(false);
    expect(existsSync(fixture.layout.environment_file)).toBe(false);
    expect(existsSync(fixture.layout.transaction_file)).toBe(false);
    expect((await createLifecycle(fixture, source).execute("status")).install_state).toBe(
      "not_installed"
    );

    const clean = createFixture();
    const cleanSource = createSourcePackage(clean, "1.0.0", "5");
    const noWriteLifecycle = createLifecycle(clean, cleanSource, {
      verify: async () => {
        throw new Error("package invalid");
      }
    });
    await expect(noWriteLifecycle.execute("install")).rejects.toMatchObject({
      code: "package_invalid",
      stage: "package"
    });
    expect(existsSync(clean.layout.data_root)).toBe(false);

    const installed = createFixture();
    const installedSource = createSourcePackage(installed, "1.0.0", "6");
    const lifecycle = createLifecycle(installed, installedSource);
    await lifecycle.execute("install");
    writeFileSync(installed.layout.environment_file, "drifted\n", { mode: 0o600 });
    const corruptBefore = snapshotTree(installed.home);
    expect((await lifecycle.execute("status")).install_state).toBe("corrupt");
    expect(snapshotTree(installed.home)).toEqual(corruptBefore);

    writeFileSync(installed.layout.transaction_file, "{}\n", { mode: 0o600 });
    const recoveryBefore = snapshotTree(installed.home);
    expect((await lifecycle.execute("status")).install_state).toBe(
      "recovery_required"
    );
    expect(snapshotTree(installed.home)).toEqual(recoveryBefore);
    await expect(lifecycle.execute("start")).rejects.toMatchObject({
      code: "recovery_required",
      stage: "recovery"
    });
  });

  it("rolls back before enable when a stable-anchor parent is insecure", async () => {
    const fixture = createFixture();
    const source = createSourcePackage(fixture, "1.0.0", "f");
    const commandParent = join(fixture.home, ".local", "bin");
    mkdirSync(commandParent, { mode: 0o770, recursive: true });
    chmodSync(commandParent, 0o770);

    await expect(createLifecycle(fixture, source).execute("install")).rejects.toMatchObject({
      code: "lifecycle_failed",
      rollback: "succeeded",
      stage: "install"
    });
    expect(fixture.manager.calls).not.toContain("enable_hostdeck");
    expect(fixture.manager.calls).not.toContain("disable_hostdeck");
    expect(existsSync(fixture.layout.current_link)).toBe(false);
    expect(existsSync(fixture.layout.transaction_file)).toBe(false);
  });

  it("rejects a writable ownership ancestor before creating lifecycle state", async () => {
    const fixture = createFixture();
    const source = createSourcePackage(fixture, "1.0.0", "0");
    chmodSync(fixture.root, 0o770);

    await expect(
      createLifecycle(fixture, source).execute("install")
    ).rejects.toMatchObject({ code: "install_invalid", stage: "install" });
    expect(existsSync(fixture.layout.data_root)).toBe(false);
    expect(fixture.manager.calls).toEqual([]);
  });

  it("rejects lifecycle lock contention and same-version drift without manager mutation", async () => {
    const fixture = createFixture();
    const source = createSourcePackage(fixture, "1.0.0", "7");
    const lifecycle = createLifecycle(fixture, source);
    await lifecycle.execute("install");
    const lease = acquireHostDeckServiceLifecycleLock(
      fixture.layout.lifecycle_lock
    );
    try {
      await expect(lifecycle.execute("start")).rejects.toMatchObject({
        code: "lock_held",
        stage: "lock"
      });
    } finally {
      lease.release();
    }

    const drift = createSourcePackage(fixture, "1.0.0", "8");
    const mutations = fixture.manager.calls.filter(
      (call) => !call.startsWith("show:")
    );
    await expect(createLifecycle(fixture, drift).execute("upgrade")).rejects.toMatchObject({
      code: "upgrade_invalid",
      stage: "upgrade"
    });
    expect(
      fixture.manager.calls.filter((call) => !call.startsWith("show:"))
    ).toEqual(mutations);
  });

  it("orders hyphenated and unbounded numeric semantic prereleases exactly", async () => {
    const fixture = createFixture();
    const alpha = createSourcePackage(fixture, "1.0.0-alpha", "1");
    await createLifecycle(fixture, alpha).execute("install");

    const hyphenated = createSourcePackage(
      fixture,
      "1.0.0-alpha-beta",
      "2"
    );
    await expect(
      createLifecycle(fixture, hyphenated).execute("upgrade")
    ).resolves.toMatchObject({ package_version: "1.0.0-alpha-beta" });

    const secondFixture = createFixture();
    const largeNumeric = createSourcePackage(
      secondFixture,
      "1.0.0-999999999999999999999999999999",
      "3"
    );
    const largerNumeric = createSourcePackage(
      secondFixture,
      "1.0.0-1000000000000000000000000000000",
      "4"
    );
    await createLifecycle(secondFixture, largeNumeric).execute("install");
    await expect(
      createLifecycle(secondFixture, largerNumeric).execute("upgrade")
    ).resolves.toMatchObject({
      package_version: "1.0.0-1000000000000000000000000000000"
    });
  });

  it("recovers failed manager compensation and journal-bound prepublication staging", async () => {
    const fixture = createFixture();
    const source = createSourcePackage(fixture, "1.0.0", "9");
    fixture.manager.failEnableAfterLink = true;
    fixture.manager.failDisable = true;
    await expect(createLifecycle(fixture, source).execute("install")).rejects.toMatchObject({
      code: "rollback_failed",
      rollback: "failed"
    });
    expect(existsSync(fixture.layout.transaction_file)).toBe(true);

    fixture.manager.failEnableAfterLink = false;
    fixture.manager.failDisable = false;
    const recovered = await createLifecycle(fixture, source).execute("install");
    expect(recovered.install_state).toBe("coherent");
    expect(existsSync(fixture.layout.transaction_file)).toBe(false);

    const secondFixture = createFixture();
    const secondSource = createSourcePackage(secondFixture, "2.0.0", "a");
    const releaseId = `${secondSource.package_version}-${secondSource.manifest_sha256}`;
    const stagingName = `.hostdeck-release-${"a".repeat(32)}`;
    const stagingRoot = join(secondFixture.layout.releases_dir, stagingName);
    mkdirSync(stagingRoot, { mode: 0o700, recursive: true });
    chmodSync(secondFixture.layout.data_root, 0o700);
    chmodSync(secondFixture.layout.releases_dir, 0o700);
    writeFileSync(
      join(stagingRoot, ".hostdeck-incomplete"),
      "partial staging\n",
      { mode: 0o600 }
    );
    writeFileSync(
      secondFixture.layout.transaction_file,
      `${JSON.stringify({
        name: "hostdeck-service-transaction",
        next_selector: join("releases", releaseId),
        operation: "install",
        phase: "preparing",
        previous_selector: null,
        schema_version: 1,
        staging_name: stagingName,
        was_active: false
      })}\n`,
      { mode: 0o600 }
    );
    const installed = await createLifecycle(secondFixture, secondSource).execute(
      "install"
    );
    expect(installed.package_version).toBe("2.0.0");
    expect(existsSync(stagingRoot)).toBe(false);
    expect(
      existsSync(join(secondFixture.layout.releases_dir, releaseId, "install.json"))
    ).toBe(true);
  });

  it("finishes a late upgrade rollback whose selector was already restored", async () => {
    const fixture = createFixture();
    const first = createSourcePackage(fixture, "1.0.0", "d");
    const second = createSourcePackage(fixture, "2.0.0", "e");
    const firstLifecycle = createLifecycle(fixture, first);
    await firstLifecycle.execute("install");
    const firstSelector = readlinkSync(fixture.layout.current_link);
    await createLifecycle(fixture, second).execute("upgrade");
    const secondSelector = readlinkSync(fixture.layout.current_link);
    unlinkSync(fixture.layout.current_link);
    symlinkSync(firstSelector, fixture.layout.current_link);
    writeFileSync(
      fixture.layout.transaction_file,
      `${JSON.stringify({
        name: "hostdeck-service-transaction",
        next_selector: secondSelector,
        operation: "upgrade",
        phase: "manager_reloaded",
        previous_selector: firstSelector,
        schema_version: 1,
        staging_name: `.hostdeck-release-${"b".repeat(32)}`,
        was_active: false
      })}\n`,
      { mode: 0o600 }
    );
    const reloadsBefore = fixture.manager.calls.filter(
      (call) => call === "daemon_reload"
    ).length;

    const stopped = await firstLifecycle.execute("stop");

    expect(stopped.changed).toBe(false);
    expect(readlinkSync(fixture.layout.current_link)).toBe(firstSelector);
    expect(existsSync(fixture.layout.transaction_file)).toBe(false);
    expect(
      fixture.manager.calls.filter((call) => call === "daemon_reload")
    ).toHaveLength(reloadsBefore + 1);
  });
});

describe("IFC-V1-057 safe uninstall and retention", () => {
  it("uninstalls a failed zero-pid service without waiting for systemd reset-failed", async () => {
    const fixture = createFixture();
    const source = createSourcePackage(fixture, "1.0.0", "f1");
    const lifecycle = createLifecycle(fixture, source);
    await lifecycle.execute("install");
    fixture.manager.hostDeck = {
      ...fixture.manager.hostDeck,
      active_state: "failed",
      main_pid: 0,
      sub_state: "failed"
    };

    await expect(lifecycle.execute("uninstall")).resolves.toMatchObject({
      action: "uninstall",
      install_state: "not_installed"
    });
    expect(fixture.manager.calls).not.toContain("stop_hostdeck");
  });

  it("uninstalls an active service, preserves user data, repeats without mutation, and reinstalls", async () => {
    const fixture = createFixture();
    const source = createSourcePackage(fixture, "1.0.0", "1");
    mkdirSync(fixture.stateDir, { mode: 0o700 });
    writeFileSync(fixture.databasePath, "database-sentinel\n", { mode: 0o600 });
    const configRoot = join(fixture.home, "config", "hostdeck");
    mkdirSync(configRoot, { mode: 0o700, recursive: true });
    const configSentinel = join(configRoot, "config.json");
    writeFileSync(configSentinel, "config-sentinel\n", { mode: 0o600 });
    const lifecycle = createLifecycle(fixture, source);
    await lifecycle.execute("install");
    await lifecycle.execute("start");
    const stateHash = sha256(readFileSync(fixture.databasePath));
    const configHash = sha256(readFileSync(configSentinel));
    const callsBefore = fixture.manager.calls.length;

    const uninstalled = await lifecycle.execute("uninstall");

    expect(uninstalled).toMatchObject({
      action: "uninstall",
      api_state: "not_probed",
      changed: true,
      enabled: false,
      install_state: "not_installed",
      package_version: null,
      release_id: null,
      units: {
        codex: { active_state: "inactive", load_state: "not-found", main_pid: 0 },
        hostdeck: { active_state: "inactive", load_state: "not-found", main_pid: 0 }
      }
    });
    expect(readdirSync(fixture.layout.data_root)).toEqual(["lifecycle.lock"]);
    for (const path of [
      fixture.layout.current_link,
      fixture.layout.manifest_link,
      fixture.layout.environment_file,
      fixture.layout.command_path,
      fixture.layout.enablement_link,
      ...Object.values(fixture.layout.unit_paths)
    ]) {
      expect(existsNoFollow(path), path).toBe(false);
    }
    expect(sha256(readFileSync(fixture.databasePath))).toBe(stateHash);
    expect(sha256(readFileSync(configSentinel))).toBe(configHash);
    const uninstallCalls = fixture.manager.calls.slice(callsBefore);
    expect(uninstallCalls.indexOf("stop_hostdeck")).toBeLessThan(
      uninstallCalls.indexOf("stop_codex")
    );
    expect(uninstallCalls.indexOf("stop_codex")).toBeLessThan(
      uninstallCalls.indexOf("disable_hostdeck")
    );
    expect(uninstallCalls.indexOf("disable_hostdeck")).toBeLessThan(
      uninstallCalls.lastIndexOf("daemon_reload")
    );

    const mutationsBeforeRepeat = managerMutations(fixture.manager);
    const repeated = await lifecycle.execute("uninstall");
    expect(repeated).toMatchObject({ action: "uninstall", changed: false });
    expect(managerMutations(fixture.manager)).toEqual(mutationsBeforeRepeat);
    expect(readdirSync(fixture.layout.data_root)).toEqual(["lifecycle.lock"]);

    const reinstalled = await lifecycle.execute("install");
    expect(reinstalled).toMatchObject({
      action: "install",
      changed: true,
      install_state: "coherent"
    });
  });

  it("retains only active and immediately previous releases and removes failed attempts on the next upgrade", async () => {
    const fixture = createFixture();
    const first = createSourcePackage(fixture, "1.0.0", "1");
    const second = createSourcePackage(fixture, "1.1.0", "2");
    const third = createSourcePackage(fixture, "1.2.0", "3");
    const failed = createSourcePackage(fixture, "1.3.0", "4");
    const fifth = createSourcePackage(fixture, "1.4.0", "5");
    await createLifecycle(fixture, first).execute("install");
    await createLifecycle(fixture, second).execute("upgrade");
    await createLifecycle(fixture, third).execute("upgrade");
    expect(readdirSync(fixture.layout.releases_dir).sort()).toEqual([
      releaseId(second),
      releaseId(third)
    ]);

    await createLifecycle(fixture, third).execute("start");
    fixture.manager.failNextRestart = true;
    await expect(
      createLifecycle(fixture, failed).execute("upgrade")
    ).rejects.toMatchObject({ rollback: "succeeded", stage: "upgrade" });
    expect(readdirSync(fixture.layout.releases_dir)).toContain(releaseId(failed));

    await createLifecycle(fixture, fifth).execute("upgrade");
    expect(readdirSync(fixture.layout.releases_dir).sort()).toEqual([
      releaseId(third),
      releaseId(fifth)
    ]);
  });

  it("resumes forward after disable failure and accepts a missing exact anchor", async () => {
    const fixture = createFixture();
    const source = createSourcePackage(fixture, "1.0.0", "6");
    const lifecycle = createLifecycle(fixture, source);
    await lifecycle.execute("install");
    await lifecycle.execute("start");
    unlinkSync(fixture.layout.command_path);
    fixture.manager.failDisable = true;

    await expect(lifecycle.execute("uninstall")).rejects.toMatchObject({
      code: "uninstall_invalid",
      stage: "uninstall"
    });
    const pending = JSON.parse(
      readFileSync(fixture.layout.transaction_file, "utf8")
    ) as Record<string, unknown>;
    expect(pending).toMatchObject({ operation: "uninstall", phase: "stopped" });
    expect(fixture.manager.hostDeck.active_state).toBe("inactive");
    expect(fixture.manager.codex.active_state).toBe("inactive");

    fixture.manager.failDisable = false;
    await expect(lifecycle.execute("uninstall")).resolves.toMatchObject({
      action: "uninstall",
      changed: true,
      install_state: "not_installed"
    });
    expect(existsNoFollow(fixture.layout.transaction_file)).toBe(false);
  });

  it("refuses foreign and modified ownership before manager mutation", async () => {
    const fixture = createFixture();
    const source = createSourcePackage(fixture, "1.0.0", "7");
    const lifecycle = createLifecycle(fixture, source);
    await lifecycle.execute("install");
    const selector = readlinkSync(fixture.layout.current_link);
    const unitPath = join(
      fixture.layout.data_root,
      selector,
      "units",
      hostDeckSystemdUnitName
    );
    writeFileSync(unitPath, "modified unit\n", { mode: 0o644 });
    writeFileSync(join(fixture.layout.data_root, "foreign.txt"), "foreign\n", {
      mode: 0o600
    });
    const mutationsBefore = managerMutations(fixture.manager);

    await expect(lifecycle.execute("uninstall")).rejects.toMatchObject({
      code: "uninstall_invalid",
      stage: "uninstall"
    });
    expect(managerMutations(fixture.manager)).toEqual(mutationsBefore);
    expect(existsNoFollow(fixture.layout.transaction_file)).toBe(false);
    expect(existsNoFollow(fixture.layout.current_link)).toBe(true);
  });

  it("returns unchanged for a genuinely absent installation without creating lifecycle state", async () => {
    const fixture = createFixture();
    const source = createSourcePackage(fixture, "1.0.0", "8");
    const before = snapshotTree(fixture.home);

    const result = await createLifecycle(fixture, source).execute("uninstall");

    expect(result).toMatchObject({
      action: "uninstall",
      changed: false,
      install_state: "not_installed"
    });
    expect(snapshotTree(fixture.home)).toEqual(before);
    expect(managerMutations(fixture.manager)).toEqual([]);
  });

  it("rejects contradictory public uninstall completion truth", async () => {
    const fixture = createFixture();
    const source = createSourcePackage(fixture, "1.0.0", "81");
    const valid = await createLifecycle(fixture, source).execute("uninstall");
    assertHostDeckServiceLifecycleResult(valid);

    for (const mutate of [
      (candidate: Record<string, unknown>) => {
        candidate.rollback = "succeeded";
      },
      (candidate: Record<string, unknown>) => {
        const units = candidate.units as Record<string, Record<string, unknown>>;
        if (units.hostdeck === undefined) throw new TypeError();
        units.hostdeck.need_daemon_reload = true;
      },
      (candidate: Record<string, unknown>) => {
        const units = candidate.units as Record<string, Record<string, unknown>>;
        if (units.codex === undefined) throw new TypeError();
        units.codex.unit_file_state = "disabled";
      }
    ]) {
      const candidate = JSON.parse(JSON.stringify(valid)) as Record<
        string,
        unknown
      >;
      mutate(candidate);
      expect(() => assertHostDeckServiceLifecycleResult(candidate)).toThrow();
    }
  });

  it("does not require the installed Codex executable or probe the HostDeck API", async () => {
    const fixture = createFixture();
    const source = createSourcePackage(fixture, "1.0.0", "9");
    await createLifecycle(fixture, source).execute("install");
    unlinkSync(fixture.codexBin);
    let apiReads = 0;
    const lifecycle = createLifecycle(fixture, source, {
      includeCodex: false,
      readHostStatus: async () => {
        apiReads += 1;
        throw new Error("uninstall must not read the HostDeck API");
      }
    });

    await expect(lifecycle.execute("uninstall")).resolves.toMatchObject({
      action: "uninstall",
      install_state: "not_installed"
    });
    expect(apiReads).toBe(0);
  });

  it("serializes uninstall with every other lifecycle operation", async () => {
    const fixture = createFixture();
    const source = createSourcePackage(fixture, "1.0.0", "a1");
    const lifecycle = createLifecycle(fixture, source);
    await lifecycle.execute("install");
    const lease = acquireHostDeckServiceLifecycleLock(
      fixture.layout.lifecycle_lock
    );
    const mutationsBefore = managerMutations(fixture.manager);
    try {
      await expect(lifecycle.execute("uninstall")).rejects.toMatchObject({
        code: "lock_held",
        stage: "lock"
      });
    } finally {
      lease.release();
    }
    expect(managerMutations(fixture.manager)).toEqual(mutationsBefore);
    expect(existsNoFollow(fixture.layout.transaction_file)).toBe(false);
  });

  it("rejects contradictory or foreign manager identity before destructive work", async () => {
    const scenarios = [
      {
        label: "foreign fragment",
        mutate: (fixture: Fixture) => {
          fixture.manager.hostDeck = {
            ...fixture.manager.hostDeck,
            fragment_path: join(fixture.root, "foreign.service")
          };
        }
      },
      {
        label: "inactive unit with a live pid",
        mutate: (fixture: Fixture) => {
          fixture.manager.hostDeck = {
            ...fixture.manager.hostDeck,
            active_state: "inactive",
            main_pid: 12_345
          };
        }
      },
      {
        label: "unexpected Codex enablement",
        mutate: (fixture: Fixture) => {
          fixture.manager.codex = {
            ...fixture.manager.codex,
            unit_file_state: "enabled"
          };
        }
      },
      {
        label: "unexplained manager reload drift",
        mutate: (fixture: Fixture) => {
          fixture.manager.hostDeck = {
            ...fixture.manager.hostDeck,
            need_daemon_reload: true
          };
        }
      }
    ] as const;

    for (const scenario of scenarios) {
      const fixture = createFixture();
      const source = createSourcePackage(fixture, "1.0.0", sha256(scenario.label)[0] ?? "b");
      const lifecycle = createLifecycle(fixture, source);
      await lifecycle.execute("install");
      scenario.mutate(fixture);
      const mutationsBefore = managerMutations(fixture.manager);

      await expect(
        lifecycle.execute("uninstall"),
        scenario.label
      ).rejects.toMatchObject({
        code: "uninstall_invalid",
        stage: "uninstall"
      });
      expect(managerMutations(fixture.manager), scenario.label).toEqual(
        mutationsBefore
      );
      expect(
        existsNoFollow(fixture.layout.transaction_file),
        scenario.label
      ).toBe(false);
    }
  });

  it("rejects hostile filesystem ownership before manager mutation", async () => {
    const scenarios = [
      {
        label: "foreign data-root entry",
        mutate: (fixture: Fixture) => {
          writeFileSync(join(fixture.layout.data_root, "foreign"), "x\n", {
            mode: 0o600
          });
        }
      },
      {
        label: "selector target drift",
        mutate: (fixture: Fixture) => {
          unlinkSync(fixture.layout.current_link);
          symlinkSync("releases/foreign", fixture.layout.current_link);
        }
      },
      {
        label: "environment hard link",
        mutate: (fixture: Fixture) => {
          linkSync(
            fixture.layout.environment_file,
            join(fixture.layout.config_root, "environment-hardlink")
          );
        }
      },
      {
        label: "modified generated unit",
        mutate: (fixture: Fixture) => {
          const selector = readlinkSync(fixture.layout.current_link);
          writeFileSync(
            join(
              fixture.layout.data_root,
              selector,
              "units",
              hostDeckSystemdUnitName
            ),
            "modified\n",
            { mode: 0o644 }
          );
        }
      },
      {
        label: "foreign release entry",
        mutate: (fixture: Fixture) => {
          const selector = readlinkSync(fixture.layout.current_link);
          writeFileSync(
            join(fixture.layout.data_root, selector, "foreign"),
            "x\n",
            { mode: 0o600 }
          );
        }
      },
      {
        label: "unsafe lifecycle lock mode",
        mutate: (fixture: Fixture) => {
          chmodSync(fixture.layout.lifecycle_lock, 0o644);
        }
      }
    ] as const;

    for (let index = 0; index < scenarios.length; index += 1) {
      const scenario = scenarios[index];
      if (scenario === undefined) throw new TypeError();
      const fixture = createFixture();
      const source = createSourcePackage(fixture, "1.0.0", String(index + 1));
      const lifecycle = createLifecycle(fixture, source);
      await lifecycle.execute("install");
      scenario.mutate(fixture);
      const mutationsBefore = managerMutations(fixture.manager);

      await expect(
        lifecycle.execute("uninstall"),
        scenario.label
      ).rejects.toMatchObject({
        code: "uninstall_invalid"
      });
      expect(managerMutations(fixture.manager), scenario.label).toEqual(
        mutationsBefore
      );
      expect(existsNoFollow(fixture.layout.current_link), scenario.label).toBe(
        true
      );
    }
  });

  it("journals and resumes manager failures at prepared, stopped, and releases-removed boundaries", async () => {
    const scenarios = [
      {
        expectedPhase: "prepared",
        label: "HostDeck stop failure",
        prepare: (manager: FakeManager) => {
          manager.failStopHostDeck = true;
        },
        recover: (manager: FakeManager) => {
          manager.failStopHostDeck = false;
        }
      },
      {
        expectedPhase: "prepared",
        label: "Codex stop failure",
        prepare: (manager: FakeManager) => {
          manager.failStopCodex = true;
        },
        recover: (manager: FakeManager) => {
          manager.failStopCodex = false;
        }
      },
      {
        expectedPhase: "stopped",
        label: "disable failure",
        prepare: (manager: FakeManager) => {
          manager.failDisable = true;
        },
        recover: (manager: FakeManager) => {
          manager.failDisable = false;
        }
      },
      {
        expectedPhase: "stopped",
        label: "disable read-back remains enabled",
        prepare: (manager: FakeManager) => {
          manager.leaveEnabledAfterDisable = true;
        },
        recover: (manager: FakeManager) => {
          manager.leaveEnabledAfterDisable = false;
        }
      },
      {
        expectedPhase: "releases_removed",
        label: "daemon reload failure",
        prepare: (manager: FakeManager) => {
          manager.failNextDaemonReload = true;
        },
        recover: () => undefined
      }
    ] as const;

    for (let index = 0; index < scenarios.length; index += 1) {
      const scenario = scenarios[index];
      if (scenario === undefined) throw new TypeError();
      const fixture = createFixture();
      const source = createSourcePackage(fixture, "1.0.0", String(index + 1));
      const lifecycle = createLifecycle(fixture, source);
      await lifecycle.execute("install");
      await lifecycle.execute("start");
      scenario.prepare(fixture.manager);

      await expect(
        lifecycle.execute("uninstall"),
        scenario.label
      ).rejects.toBeDefined();
      expect(
        readTransactionPhase(fixture),
        scenario.label
      ).toBe(scenario.expectedPhase);

      scenario.recover(fixture.manager);
      await expect(lifecycle.execute("uninstall"), scenario.label).resolves.toMatchObject({
        action: "uninstall",
        install_state: "not_installed"
      });
      expect(existsNoFollow(fixture.layout.transaction_file)).toBe(false);
    }
  });

  it("resumes each forward-only destructive phase after exact remediation", async () => {
    {
      const fixture = createFixture();
      const source = createSourcePackage(fixture, "1.0.0", "c1");
      const lifecycle = createLifecycle(fixture, source);
      await lifecycle.execute("install");
      const expectedTarget = readlinkSync(fixture.layout.command_path);
      fixture.manager.afterDisable = () => {
        unlinkSync(fixture.layout.command_path);
        symlinkSync("foreign", fixture.layout.command_path);
      };
      await expect(lifecycle.execute("uninstall")).rejects.toBeDefined();
      expect(readTransactionPhase(fixture)).toBe("disabled");
      unlinkSync(fixture.layout.command_path);
      symlinkSync(expectedTarget, fixture.layout.command_path);
      await expect(lifecycle.execute("uninstall")).resolves.toMatchObject({
        install_state: "not_installed"
      });
    }

    {
      const fixture = createFixture();
      const source = createSourcePackage(fixture, "1.0.0", "c2");
      await createLifecycle(fixture, source).execute("install");
      let verificationCalls = 0;
      const interrupted = createLifecycle(fixture, source, {
        verify: async (root) => {
          verificationCalls += 1;
          if (verificationCalls === 3) throw new Error("injected removal proof failure");
          return verifyFixturePackage(root);
        }
      });
      await expect(interrupted.execute("uninstall")).rejects.toBeDefined();
      expect(readTransactionPhase(fixture)).toBe("anchors_removed");
      await expect(
        createLifecycle(fixture, source).execute("uninstall")
      ).resolves.toMatchObject({ install_state: "not_installed" });
    }

    {
      const fixture = createFixture();
      const source = createSourcePackage(fixture, "1.0.0", "c3");
      const lifecycle = createLifecycle(fixture, source);
      await lifecycle.execute("install");
      const foreign = join(fixture.layout.data_root, "post-reload-foreign");
      fixture.manager.afterDaemonReload = () => {
        writeFileSync(foreign, "x\n", { mode: 0o600 });
      };
      await expect(lifecycle.execute("uninstall")).rejects.toBeDefined();
      expect(readTransactionPhase(fixture)).toBe("manager_reloaded");
      unlinkSync(foreign);
      await expect(lifecycle.execute("uninstall")).resolves.toMatchObject({
        install_state: "not_installed"
      });
    }
  });

  it("rejects malformed uninstall journals as explicit recovery-required state", async () => {
    const fixture = createFixture();
    const source = createSourcePackage(fixture, "1.0.0", "d1");
    const lifecycle = createLifecycle(fixture, source);
    await lifecycle.execute("install");
    writeFileSync(fixture.layout.transaction_file, "{\"operation\":\"uninstall\"}\n", {
      mode: 0o600
    });
    const mutationsBefore = managerMutations(fixture.manager);

    await expect(lifecycle.execute("uninstall")).rejects.toMatchObject({
      code: "recovery_required",
      stage: "recovery"
    });
    expect(managerMutations(fixture.manager)).toEqual(mutationsBefore);
    expect(existsNoFollow(fixture.layout.current_link)).toBe(true);
  });

  it("preflights retention candidates and leaves same-identity upgrades mutation-free", async () => {
    const fixture = createFixture();
    const first = createSourcePackage(fixture, "1.0.0", "e1");
    const second = createSourcePackage(fixture, "1.1.0", "e2");
    const third = createSourcePackage(fixture, "1.2.0", "e3");
    await createLifecycle(fixture, first).execute("install");
    const secondLifecycle = createLifecycle(fixture, second);
    await secondLifecycle.execute("upgrade");
    const beforeNoOp = snapshotTree(fixture.layout.data_root).filter(
      (line) => !line.includes("lifecycle.lock")
    );
    const mutationsBeforeNoOp = managerMutations(fixture.manager);
    await expect(secondLifecycle.execute("upgrade")).resolves.toMatchObject({
      action: "upgrade",
      changed: false
    });
    expect(
      snapshotTree(fixture.layout.data_root).filter(
        (line) => !line.includes("lifecycle.lock")
      )
    ).toEqual(beforeNoOp);
    expect(managerMutations(fixture.manager)).toEqual(mutationsBeforeNoOp);

    const firstRelease = join(
      fixture.layout.releases_dir,
      releaseId(first)
    );
    writeFileSync(join(firstRelease, "foreign"), "x\n", { mode: 0o600 });
    const selectorBefore = readlinkSync(fixture.layout.current_link);
    const mutationsBeforeFailure = managerMutations(fixture.manager);
    await expect(
      createLifecycle(fixture, third).execute("upgrade")
    ).rejects.toMatchObject({
      code: "install_invalid",
      stage: "retention"
    });
    expect(readlinkSync(fixture.layout.current_link)).toBe(selectorBefore);
    expect(managerMutations(fixture.manager)).toEqual(mutationsBeforeFailure);
  });
});

interface Fixture {
  readonly codexBin: string;
  readonly databasePath: string;
  readonly env: Readonly<Record<string, string>>;
  readonly home: string;
  readonly layout: ReturnType<typeof resolveHostDeckServiceInstallLayout>;
  readonly manager: FakeManager;
  readonly nodeBin: string;
  readonly root: string;
  readonly stateDir: string;
}

interface SourcePackage extends HostDeckProductionPackageIdentity {
  readonly root: string;
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(homedir(), ".hostdeck-service-lifecycle-"));
  roots.push(root);
  chmodSync(root, 0o700);
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  const bin = join(home, "fixture-bin");
  mkdirSync(bin, { mode: 0o700 });
  const nodeBin = realpathSync.native(process.execPath);
  const codexBin = executable(join(bin, "codex"));
  const env = Object.freeze({
    HOME: home,
    PATH: bin,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_STATE_HOME: join(home, "state-home")
  });
  const layout = resolveHostDeckServiceInstallLayout(env);
  const manager = new FakeManager(layout);
  const stateDir = join(home, "state");
  return {
    codexBin,
    databasePath: join(stateDir, "hostdeck.sqlite"),
    env,
    home,
    layout,
    manager,
    nodeBin,
    root,
    stateDir
  };
}

function createSourcePackage(
  fixture: Fixture,
  version: string,
  seed: string
): SourcePackage {
  const root = join(fixture.root, `source-${version}-${seed}`);
  mkdirSync(join(root, "dist"), { mode: 0o755, recursive: true });
  chmodSync(root, 0o755);
  chmodSync(join(root, "dist"), 0o755);
  const manifestSha = seed.repeat(64).slice(0, 64);
  const contentSha = sha256(`${version}:${seed}`);
  writeFileSync(join(root, "hostdeck-package.json"), `${JSON.stringify({
    codex_version: "0.147.0",
    package_version: version,
    manifest_sha256: manifestSha,
    content_sha256: contentSha
  })}\n`);
  writeFileSync(join(root, "dist", "shell.js"), "#!/usr/bin/env node\n", {
    mode: 0o755
  });
  chmodSync(join(root, "dist", "shell.js"), 0o755);
  return Object.freeze({
    codex_version: "0.147.0",
    content_sha256: contentSha,
    manifest_sha256: manifestSha,
    package_version: version,
    root: realpathSync.native(root)
  });
}

function createLifecycle(
  fixture: Fixture,
  source: SourcePackage,
  overrides: {
    readonly includeCodex?: boolean;
    readonly generateUnits?: typeof fakeUnitGenerator;
    readonly readHostStatus?: () => Promise<SelectedHostStatusResponse>;
    readonly verify?: (root: string) => Promise<HostDeckProductionPackageIdentity>;
  } = {}
) {
  const verify = overrides.verify ?? verifyFixturePackage;
  return createHostDeckServiceLifecycle({
    base_url: new URL("http://127.0.0.1:3777"),
    ...(overrides.includeCodex === false
      ? {}
      : { codex_bin: fixture.codexBin }),
    database_path: fixture.databasePath,
    env: fixture.env,
    generate_units: overrides.generateUnits ?? fakeUnitGenerator,
    manager: fixture.manager,
    node_bin: fixture.nodeBin,
    package_root: source.root,
    probe_codex_version: async () => source.codex_version,
    read_host_status:
      overrides.readHostStatus ??
      (async () =>
        ({
          local: {
            readiness:
              fixture.manager.hostDeck.active_state === "active"
                ? "ready"
                : "not_ready"
          }
        }) as unknown as SelectedHostStatusResponse),
    readiness_timeout_ms: 10,
    sleep: async () => {},
    state_dir: fixture.stateDir,
    verify_package: verify
  });
}

async function verifyFixturePackage(
  root: string
): Promise<HostDeckProductionPackageIdentity> {
  const manifest = JSON.parse(
    readFileSync(join(root, "hostdeck-package.json"), "utf8")
  ) as Record<string, string>;
  return Object.freeze({
    codex_version: manifest.codex_version as string,
    content_sha256: manifest.content_sha256 as string,
    manifest_sha256: manifest.manifest_sha256 as string,
    package_version: manifest.package_version as string
  });
}

function fakeUnitGenerator(
  input: GenerateHostDeckSystemdUserUnitsForInstallInput
): HostDeckSystemdUserUnitBundle {
  const codexContent = `codex=${input.codex_bin}\npackage=${input.package_root}\n`;
  const hostDeckContent = `node=${input.node_bin}\npackage=${input.package_root}\nenv=${input.environment_file}\n`;
  const units = Object.freeze([
    Object.freeze({
      content: codexContent,
      mode: 0o644,
      name: hostDeckCodexSystemdUnitName,
      sha256: sha256(codexContent)
    }),
    Object.freeze({
      content: hostDeckContent,
      mode: 0o644,
      name: hostDeckSystemdUnitName,
      sha256: sha256(hostDeckContent)
    })
  ]) as HostDeckSystemdUserUnitBundle["units"];
  return Object.freeze({
    package_version: input.expected_package_version,
    schema_version: 1,
    service_host_path: join(input.package_root, "dist", "service-host.js"),
    units
  });
}

class FakeManager implements HostDeckSystemdUserManager {
  afterDaemonReload: (() => void) | null = null;
  afterDisable: (() => void) | null = null;
  readonly calls: string[] = [];
  codex = notFound();
  failEnable = false;
  failEnableAfterLink = false;
  failDisable = false;
  failNextDaemonReload = false;
  failNextRestart = false;
  failStopCodex = false;
  failStopHostDeck = false;
  hostDeck = notFound();
  leaveEnabledAfterDisable = false;
  stopObservationDelay = 0;
  private codexStopObservations = 0;
  private hostDeckStopObservations = 0;
  private nextCodexPid = 20_000;
  private nextHostDeckPid = 10_000;

  constructor(private readonly layout: Fixture["layout"]) {}

  async daemonReload(): Promise<void> {
    this.calls.push("daemon_reload");
    if (this.failNextDaemonReload) {
      this.failNextDaemonReload = false;
      throw new Error("daemon reload failed");
    }
    if (existsSync(this.layout.current_link)) {
      this.hostDeck = {
        ...this.hostDeck,
        active_state:
          this.hostDeck.active_state === "active" ? "active" : "inactive",
        fragment_path: this.layout.unit_paths[hostDeckSystemdUnitName],
        load_state: "loaded",
        main_pid:
          this.hostDeck.active_state === "active" ? this.hostDeck.main_pid : 0,
        sub_state:
          this.hostDeck.active_state === "active" ? "running" : "dead",
        unit_file_state:
          this.hostDeck.unit_file_state === "enabled" ? "enabled" : "disabled"
      };
      this.codex = {
        ...this.codex,
        active_state: this.codex.active_state === "active" ? "active" : "inactive",
        fragment_path: this.layout.unit_paths[hostDeckCodexSystemdUnitName],
        load_state: "loaded",
        main_pid: this.codex.active_state === "active" ? this.codex.main_pid : 0,
        sub_state: this.codex.active_state === "active" ? "running" : "dead",
        unit_file_state: "linked"
      };
    } else {
      this.hostDeck = notFound();
      this.codex = notFound();
    }
    const afterReload = this.afterDaemonReload;
    this.afterDaemonReload = null;
    afterReload?.();
  }

  async disableHostDeck(): Promise<void> {
    this.calls.push("disable_hostdeck");
    if (this.failDisable) throw new Error("disable failed");
    if (existsNoFollow(this.layout.enablement_link)) {
      unlinkSync(this.layout.enablement_link);
    }
    if (
      this.hostDeck.load_state === "loaded" &&
      !this.leaveEnabledAfterDisable
    ) {
      this.hostDeck = { ...this.hostDeck, unit_file_state: "disabled" };
    }
    const afterDisable = this.afterDisable;
    this.afterDisable = null;
    afterDisable?.();
  }

  async enableHostDeck(): Promise<void> {
    this.calls.push("enable_hostdeck");
    if (this.failEnable) throw new Error("enable failed");
    if (this.hostDeck.load_state !== "loaded") throw new Error("not loaded");
    mkdirSync(join(this.layout.systemd_user_dir, "default.target.wants"), {
      mode: 0o700,
      recursive: true
    });
    if (!existsNoFollow(this.layout.enablement_link)) {
      symlinkSync(
        realpathSync.native(this.layout.unit_paths[hostDeckSystemdUnitName]),
        this.layout.enablement_link
      );
    }
    if (this.failEnableAfterLink) throw new Error("enable failed after link");
    this.hostDeck = { ...this.hostDeck, unit_file_state: "enabled" };
  }

  async restartHostDeck(): Promise<void> {
    this.calls.push("restart_hostdeck");
    if (this.failNextRestart) {
      this.failNextRestart = false;
      throw new Error("restart failed");
    }
    this.startUnits(true);
  }

  async show(unit: HostDeckSystemdUnitName): Promise<HostDeckSystemdUnitState> {
    this.calls.push(`show:${unit}`);
    const selected =
      unit === hostDeckSystemdUnitName ? this.hostDeck : this.codex;
    const snapshot = Object.freeze({ ...selected });
    if (
      unit === hostDeckSystemdUnitName &&
      this.hostDeckStopObservations > 0
    ) {
      this.hostDeckStopObservations -= 1;
      if (this.hostDeckStopObservations === 0) {
        this.hostDeck = inactive(this.hostDeck);
      }
    } else if (
      unit === hostDeckCodexSystemdUnitName &&
      this.codexStopObservations > 0
    ) {
      this.codexStopObservations -= 1;
      if (this.codexStopObservations === 0) this.codex = inactive(this.codex);
    }
    return snapshot;
  }

  async startHostDeck(): Promise<void> {
    this.calls.push("start_hostdeck");
    this.startUnits(false);
  }

  async stopCodex(): Promise<void> {
    this.calls.push("stop_codex");
    if (this.failStopCodex) throw new Error("Codex stop failed");
    if (this.stopObservationDelay > 0) {
      this.codex = {
        ...this.codex,
        active_state: "deactivating",
        sub_state: "stop-sigterm"
      };
      this.codexStopObservations = this.stopObservationDelay;
    } else {
      this.codex = inactive(this.codex);
    }
  }

  async stopHostDeck(): Promise<void> {
    this.calls.push("stop_hostdeck");
    if (this.failStopHostDeck) throw new Error("HostDeck stop failed");
    if (this.stopObservationDelay > 0) {
      this.hostDeck = {
        ...this.hostDeck,
        active_state: "deactivating",
        sub_state: "stop-sigterm"
      };
      this.hostDeckStopObservations = this.stopObservationDelay;
    } else {
      this.hostDeck = inactive(this.hostDeck);
    }
  }

  private startUnits(restartHostDeck: boolean): void {
    if (this.hostDeck.load_state !== "loaded") throw new Error("not loaded");
    if (this.codex.active_state !== "active") {
      this.nextCodexPid += 1;
      this.codex = active(this.codex, this.nextCodexPid);
    }
    if (restartHostDeck || this.hostDeck.active_state !== "active") {
      this.nextHostDeckPid += 1;
      this.hostDeck = active(this.hostDeck, this.nextHostDeckPid);
    }
  }
}

function notFound(): HostDeckSystemdUnitState {
  return {
    active_state: "inactive",
    fragment_path: "",
    load_state: "not-found",
    main_pid: 0,
    need_daemon_reload: false,
    sub_state: "dead",
    unit_file_state: ""
  };
}

function inactive(state: HostDeckSystemdUnitState): HostDeckSystemdUnitState {
  return { ...state, active_state: "inactive", main_pid: 0, sub_state: "dead" };
}

function active(
  state: HostDeckSystemdUnitState,
  mainPid: number
): HostDeckSystemdUnitState {
  return {
    ...state,
    active_state: "active",
    main_pid: mainPid,
    sub_state: "running"
  };
}

function executable(path: string): string {
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(path, 0o755);
  return realpathSync.native(path);
}

function managerMutations(manager: FakeManager): string[] {
  return manager.calls.filter((call) => !call.startsWith("show:"));
}

function releaseId(source: SourcePackage): string {
  return `${source.package_version}-${source.manifest_sha256}`;
}

function readTransactionPhase(fixture: Fixture): string {
  const transaction = JSON.parse(
    readFileSync(fixture.layout.transaction_file, "utf8")
  ) as Record<string, unknown>;
  return String(transaction.phase);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function mode(path: string): number {
  return lstatSync(path).mode & 0o7777;
}

function existsNoFollow(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function snapshotTree(root: string): string[] {
  const output: string[] = [];
  const visit = (path: string, relativePath: string) => {
    const metadata = lstatSync(path);
    const label = relativePath === "" ? "." : relativePath;
    if (metadata.isSymbolicLink()) {
      output.push(`${label}:link:${readlinkSync(path)}`);
      return;
    }
    if (metadata.isDirectory()) {
      output.push(`${label}:dir:${metadata.mode & 0o7777}`);
      for (const child of readdirSync(path).sort()) {
        visit(join(path, child), relativePath === "" ? child : join(relativePath, child));
      }
      return;
    }
    const content = readFileSync(path);
    output.push(
      `${label}:file:${metadata.mode & 0o7777}:${sha256(content)}`
    );
  };
  visit(root, "");
  return output;
}
