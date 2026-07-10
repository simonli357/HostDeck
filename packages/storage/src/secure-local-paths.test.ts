import { once } from "node:events";
import {
  chmodSync,
  chownSync,
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HostDeckLocalPathError,
  openSecureHostDeckRegularFile,
  prepareHostDeckDaemonLeasePath,
  prepareHostDeckLocalPaths,
  prepareHostDeckStatePaths,
  resolveHostDeckLocalPaths,
  secureHostDeckRegularFile,
  secureHostDeckSocket
} from "./secure-local-paths.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0).reverse()) rmSync(path, { force: true, recursive: true });
});

describe("secure HostDeck local paths", () => {
  it("creates canonical owner-only directories and a stable lease path", () => {
    const layout = testLayout();
    const prepared = prepareHostDeckLocalPaths(layout);

    expect(prepared).toMatchObject({
      config_dir: layout.config_dir,
      state_dir: layout.state_dir,
      runtime_dir: layout.runtime_dir,
      database_path: layout.database_path,
      lease_path: join(layout.state_dir, "hostdeck.lock"),
      app_server_socket_path: join(layout.runtime_dir, "app-server.sock")
    });
    expect(mode(layout.config_dir)).toBe(0o700);
    expect(mode(layout.state_dir)).toBe(0o700);
    expect(mode(layout.runtime_dir)).toBe(0o700);
    expect(mode(prepared.lease_path)).toBe(0o600);
    expect(() => lstatSync(layout.database_path)).toThrow();
  });

  it("repairs only owner-owned mode drift and reports every repair", () => {
    const layout = testLayout({ createDirectories: false });
    mkdirSync(layout.state_dir, { mode: 0o755 });
    mkdirSync(layout.config_dir, { mode: 0o750 });
    mkdirSync(layout.runtime_dir, { mode: 0o711 });
    writeFileSync(layout.database_path, "", { mode: 0o644 });
    chmodSync(layout.state_dir, 0o755);
    chmodSync(layout.config_dir, 0o750);
    chmodSync(layout.runtime_dir, 0o711);
    chmodSync(layout.database_path, 0o644);

    const prepared = prepareHostDeckLocalPaths(layout);

    expect(new Set(prepared.repairs.map((repair) => repair.path))).toEqual(
      new Set([layout.state_dir, layout.config_dir, layout.runtime_dir])
    );
    expect(prepared.repairs.every((repair) => [0o700, 0o600].includes(repair.to_mode))).toBe(true);
    expect(mode(layout.state_dir)).toBe(0o700);
    expect(mode(layout.database_path)).toBe(0o644);
  });

  it("rejects final and ancestor symlinks without mutating their targets", () => {
    const finalLink = testLayout();
    const target = join(finalLink.root, "state-target");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, finalLink.state_dir);
    expectPathError(() => prepareHostDeckLocalPaths(finalLink), "symlink_rejected");
    expect(mode(target)).toBe(0o700);

    const ancestorLink = testLayout();
    const configTarget = join(ancestorLink.root, "config-target");
    const configAlias = join(ancestorLink.root, "config-alias");
    mkdirSync(configTarget, { mode: 0o700 });
    symlinkSync(configTarget, configAlias);
    expectPathError(
      () => prepareHostDeckLocalPaths({ ...ancestorLink, config_dir: join(configAlias, "hostdeck") }),
      "symlink_rejected"
    );
    expect(() => lstatSync(join(configTarget, "hostdeck"))).toThrow();
  });

  it("rejects database escape, hard links, wrong path types, and insecure runtime parents", () => {
    const escaped = testLayout();
    expectPathError(
      () => prepareHostDeckLocalPaths({ ...escaped, database_path: join(escaped.root, "outside.sqlite") }),
      "invalid_path"
    );

    const linked = testLayout();
    mkdirSync(linked.state_dir, { mode: 0o700 });
    writeFileSync(linked.database_path, "", { mode: 0o600 });
    linkSync(linked.database_path, join(linked.state_dir, "database-copy"));
    expectPathError(
      () => secureHostDeckRegularFile(linked.database_path, { label: "database", mode: 0o600, repair_mode: true }),
      "hard_link_rejected"
    );

    const wrongType = testLayout();
    writeFileSync(wrongType.state_dir, "not a directory", { mode: 0o600 });
    expectPathError(() => prepareHostDeckLocalPaths(wrongType), "invalid_path");

    const insecureRuntime = testLayout({ createRuntimeParent: false });
    mkdirSync(insecureRuntime.runtime_parent, { mode: 0o755 });
    chmodSync(insecureRuntime.runtime_parent, 0o755);
    expectPathError(() => prepareHostDeckLocalPaths(insecureRuntime), "runtime_parent_insecure");

    const specialModeRuntime = testLayout({ createRuntimeParent: false });
    mkdirSync(specialModeRuntime.runtime_parent, { mode: 0o700 });
    chmodSync(specialModeRuntime.runtime_parent, 0o2700);
    expectPathError(() => prepareHostDeckLocalPaths(specialModeRuntime), "runtime_parent_insecure");
  });

  it("rejects overlapping roots and programmatic relative paths", () => {
    const overlapping = testLayout();
    expectPathError(
      () => prepareHostDeckLocalPaths({ ...overlapping, config_dir: join(overlapping.state_dir, "config") }),
      "invalid_path"
    );
    expectPathError(
      () => prepareHostDeckStatePaths({ state_dir: "relative-state", database_path: "relative-state/hostdeck.sqlite" }),
      "invalid_path"
    );
    expectPathError(
      () => prepareHostDeckStatePaths({ state_dir: "/", database_path: "/hostdeck.sqlite" }),
      "invalid_path"
    );
    expectPathError(
      () => prepareHostDeckStatePaths({ state_dir: "/tmp/hostdeck\0state", database_path: "/tmp/hostdeck\0state/db" }),
      "invalid_path"
    );

    const reserved = testLayout();
    expectPathError(
      () => prepareHostDeckLocalPaths({ ...reserved, database_path: join(reserved.state_dir, "hostdeck.lock") }),
      "invalid_path"
    );
    expect(() => lstatSync(reserved.state_dir)).toThrow();

    const derived = testLayout();
    const resolved = resolveHostDeckLocalPaths(derived);
    expectPathError(
      () => prepareHostDeckDaemonLeasePath({ ...resolved, lease_path: join(derived.state_dir, "substituted.lock") }),
      "invalid_path"
    );
    expect(() => lstatSync(derived.state_dir)).toThrow();
  });

  it("rejects a state directory owned by another uid", () => {
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("Linux uid support is required for this test.");

    if (uid === 0) {
      const root = tempRoot();
      const stateDir = join(root, "foreign-state");
      mkdirSync(stateDir, { mode: 0o700 });
      chownSync(stateDir, 1, 1);
      expectPathError(
        () => prepareHostDeckStatePaths({ state_dir: stateDir, database_path: join(stateDir, "hostdeck.sqlite") }),
        "wrong_owner"
      );
      return;
    }

    expect(lstatSync(tmpdir()).uid).not.toBe(uid);
    expectPathError(
      () => prepareHostDeckStatePaths({ state_dir: tmpdir(), database_path: join(tmpdir(), "hostdeck-owner-check.sqlite") }),
      "wrong_owner"
    );
  });

  it("detects replacement of a validated open file descriptor", () => {
    const root = tempRoot();
    const path = join(root, "hostdeck.lock");
    const movedPath = join(root, "hostdeck.lock.moved");
    writeFileSync(path, "original", { mode: 0o600 });
    const opened = openSecureHostDeckRegularFile(path, {
      label: "daemon lease",
      mode: 0o600,
      repair_mode: true,
      writable: true
    });
    try {
      renameSync(path, movedPath);
      writeFileSync(path, "replacement", { mode: 0o600 });
      expectPathError(opened.verifyPath, "path_substitution");
    } finally {
      closeSync(opened.descriptor);
    }
  });

  it("validates strict key/certificate files and repairs Unix socket mode without accepting the wrong type", async () => {
    const root = tempRoot();
    const keyPath = join(root, "host.key");
    writeFileSync(keyPath, "test-only", { mode: 0o644 });
    chmodSync(keyPath, 0o644);
    expectPathError(
      () => secureHostDeckRegularFile(keyPath, { label: "private key", mode: 0o600, repair_mode: false }),
      "permission_update_failed"
    );
    expect(secureHostDeckRegularFile(keyPath, { label: "private key", mode: 0o600, repair_mode: true })).toMatchObject({
      kind: "file",
      from_mode: 0o644,
      to_mode: 0o600
    });

    const certificatePath = join(root, "host.crt");
    writeFileSync(certificatePath, "test-certificate-only", { mode: 0o600 });
    expect(
      secureHostDeckRegularFile(certificatePath, { label: "certificate", mode: 0o600, repair_mode: false })
    ).toBeNull();
    chmodSync(certificatePath, 0o644);
    expectPathError(
      () => secureHostDeckRegularFile(certificatePath, { label: "certificate", mode: 0o600, repair_mode: false }),
      "permission_update_failed"
    );
    chmodSync(keyPath, 0o000);
    expect(secureHostDeckRegularFile(keyPath, { label: "private key", mode: 0o600, repair_mode: true })).toMatchObject({
      kind: "file",
      from_mode: 0o000,
      to_mode: 0o600
    });

    const socketPath = join(root, "app.sock");
    const server = createServer();
    server.listen(socketPath);
    await once(server, "listening");
    try {
      chmodSync(socketPath, 0o666);
      expect(secureHostDeckSocket(socketPath, { label: "app-server socket", repair_mode: true })).toMatchObject({
        kind: "socket",
        from_mode: 0o666,
        to_mode: 0o600
      });
      expect(mode(socketPath)).toBe(0o600);
      expectPathError(
        () => secureHostDeckRegularFile(socketPath, { label: "private key", mode: 0o600, repair_mode: false }),
        "path_type_mismatch"
      );
      expectPathError(
        () => secureHostDeckSocket(socketPath, { label: "app-server socket", mode: 0o1000, repair_mode: false }),
        "invalid_path"
      );
    } finally {
      server.close();
      await once(server, "close");
    }

    expectPathError(
      () => secureHostDeckSocket(keyPath, { label: "app-server socket", repair_mode: false }),
      "path_type_mismatch"
    );
  });
});

interface TestLayout extends ReturnType<typeof rawTestLayout> {
  readonly root: string;
}

function testLayout(options: { readonly createDirectories?: boolean; readonly createRuntimeParent?: boolean } = {}): TestLayout {
  const root = tempRoot();
  const layout = rawTestLayout(root);
  if (options.createRuntimeParent !== false) mkdirSync(layout.runtime_parent, { mode: 0o700 });
  if (options.createDirectories === true) {
    mkdirSync(layout.state_dir, { mode: 0o700 });
    mkdirSync(layout.config_dir, { mode: 0o700 });
    mkdirSync(layout.runtime_dir, { mode: 0o700 });
  }
  return { root, ...layout };
}

function rawTestLayout(root: string) {
  const runtimeParent = join(root, "user-runtime");
  return {
    config_dir: join(root, "config"),
    state_dir: join(root, "state"),
    runtime_parent: runtimeParent,
    runtime_dir: join(runtimeParent, "hostdeck"),
    database_path: join(root, "state", "hostdeck.sqlite")
  };
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hostdeck-secure-paths-"));
  cleanup.push(root);
  return root;
}

function mode(path: string): number {
  return lstatSync(path).mode & 0o7777;
}

function expectPathError(work: () => unknown, code: HostDeckLocalPathError["code"]): void {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckLocalPathError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected HostDeckLocalPathError ${code}.`);
}
