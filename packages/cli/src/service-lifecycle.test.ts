import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
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
    codex_version: "0.144.0",
    package_version: version,
    manifest_sha256: manifestSha,
    content_sha256: contentSha
  })}\n`);
  writeFileSync(join(root, "dist", "shell.js"), "#!/usr/bin/env node\n", {
    mode: 0o755
  });
  chmodSync(join(root, "dist", "shell.js"), 0o755);
  return Object.freeze({
    codex_version: "0.144.0",
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
    readonly verify?: (root: string) => Promise<HostDeckProductionPackageIdentity>;
  } = {}
) {
  const verify =
    overrides.verify ??
    (async (root: string) => {
      const manifest = JSON.parse(
        readFileSync(join(root, "hostdeck-package.json"), "utf8")
      ) as Record<string, string>;
      return Object.freeze({
        codex_version: manifest.codex_version as string,
        content_sha256: manifest.content_sha256 as string,
        manifest_sha256: manifest.manifest_sha256 as string,
        package_version: manifest.package_version as string
      });
    });
  return createHostDeckServiceLifecycle({
    base_url: new URL("http://127.0.0.1:3777"),
    codex_bin: fixture.codexBin,
    database_path: fixture.databasePath,
    env: fixture.env,
    generate_units: fakeUnitGenerator,
    manager: fixture.manager,
    node_bin: fixture.nodeBin,
    package_root: source.root,
    probe_codex_version: async () => source.codex_version,
    read_host_status: async () =>
      ({
        local: {
          readiness:
            fixture.manager.hostDeck.active_state === "active"
              ? "ready"
              : "not_ready"
        }
      }) as unknown as SelectedHostStatusResponse,
    readiness_timeout_ms: 10,
    sleep: async () => {},
    state_dir: fixture.stateDir,
    verify_package: verify
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
  readonly calls: string[] = [];
  codex = notFound();
  failEnable = false;
  failEnableAfterLink = false;
  failDisable = false;
  failNextRestart = false;
  hostDeck = notFound();
  stopObservationDelay = 0;
  private codexStopObservations = 0;
  private hostDeckStopObservations = 0;
  private nextCodexPid = 20_000;
  private nextHostDeckPid = 10_000;

  constructor(private readonly layout: Fixture["layout"]) {}

  async daemonReload(): Promise<void> {
    this.calls.push("daemon_reload");
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
  }

  async disableHostDeck(): Promise<void> {
    this.calls.push("disable_hostdeck");
    if (this.failDisable) throw new Error("disable failed");
    if (existsNoFollow(this.layout.enablement_link)) {
      unlinkSync(this.layout.enablement_link);
    }
    if (this.hostDeck.load_state === "loaded") {
      this.hostDeck = { ...this.hostDeck, unit_file_state: "disabled" };
    }
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
