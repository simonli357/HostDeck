import assert from "node:assert/strict";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const packageRootArgument = process.argv[2];
if (packageRootArgument === undefined) {
  throw new Error("Usage: node run-production-package-smoke.mjs <package-root> [--read-only]");
}

const packageRoot = realpathSync(resolve(packageRootArgument));
const requireReadOnly = process.argv.includes("--read-only");
const manifest = JSON.parse(readFileSync(join(packageRoot, "hostdeck-package.json"), "utf8"));
const temporaryRoot = mkdtempSync(join(tmpdir(), "hostdeck-package-runtime-"));

try {
  if (requireReadOnly) {
    assert.equal(statSync(packageRoot).mode & 0o222, 0, "relocated package root must be read-only");
  }
  const modules = await importPackageRoots();
  assertSelectedDescriptor(modules.get("@hostdeck/server"));
  assertCodexIdentity(modules.get("@hostdeck/codex-adapter"));
  assertMissingConfig(modules.get("@hostdeck/cli"));
  assertNativeOperations();
  await assertFastifyLifecycle(modules.get("@hostdeck/server"), modules.get("@hostdeck/contracts"));
  console.log("HostDeck relocated package smoke passed: imports, descriptor, config/static failures, native operations, lifecycle restart.");
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}

function assertCodexIdentity(codex) {
  assert.ok(codex !== undefined, "Codex adapter package must import");
  assert.equal(codex.codexBindingManifest.codexVersion, manifest.codex.codexVersion);
  assert.equal(codex.codexBindingManifest.bindingId, manifest.codex.bindingId);
  assert.equal(codex.codexBindingManifest.fileCount, manifest.codex.fileCount);
  assert.equal(codex.codexBindingManifest.treeSha256, manifest.codex.treeSha256);
  assert.equal(codex.codexBindingManifest.experimentalApi, manifest.codex.experimentalApi);
}

async function importPackageRoots() {
  const modules = new Map();
  for (const descriptor of manifest.packages) {
    assert.match(descriptor.entrypoint, /\.js$/u);
    assert.doesNotMatch(descriptor.entrypoint, /(?:^|\/)src\//u);
    const entrypoint = join(packageRoot, descriptor.entrypoint);
    const loaded = await import(pathToFileURL(entrypoint).href);
    assert.equal(typeof loaded, "object");
    modules.set(descriptor.name, loaded);
  }
  assert.equal(modules.size, 6);
  return modules;
}

function assertSelectedDescriptor(server) {
  assert.ok(server !== undefined, "server package must import");
  assert.equal(server.selectedApiRouteManifest.length, 35);
  assert.equal(server.hostDeckSelectedApiRouteCompositionDescriptor.length, 22);
  const describedIds = server.hostDeckSelectedApiRouteCompositionDescriptor.flatMap((entry) => entry.manifestIds);
  assert.equal(describedIds.length, 35);
  assert.equal(new Set(describedIds).size, 35);
  assert.deepEqual(
    [...describedIds].sort(),
    server.selectedApiRouteManifest.map((entry) => entry.id).sort()
  );
}

function assertMissingConfig(cli) {
  assert.ok(cli !== undefined, "CLI package must import");
  let readCalls = 0;
  assert.throws(
    () =>
      cli.loadCliConfig({
        cwd: temporaryRoot,
        env: {
          HOME: temporaryRoot,
          XDG_CONFIG_HOME: join(temporaryRoot, "config"),
          XDG_STATE_HOME: join(temporaryRoot, "state")
        },
        flags: { configPath: "missing-config.json" },
        readFile() {
          readCalls += 1;
          throw new Error("missing");
        }
      }),
    /Unable to read HostDeck config file/u
  );
  assert.equal(readCalls, 1);
}

function assertNativeOperations() {
  const storage = manifest.packages.find((entry) => entry.name === "@hostdeck/storage");
  assert.ok(storage !== undefined, "storage package descriptor must exist");
  const storageManifest = realpathSync(join(packageRoot, storage.root, "package.json"));
  const require = createRequire(storageManifest);
  const Database = require("better-sqlite3");
  const fsExt = require("fs-ext");
  const databasePath = join(temporaryRoot, "native.sqlite");
  const database = new Database(databasePath);
  try {
    database.exec("CREATE TABLE package_probe (value INTEGER NOT NULL); INSERT INTO package_probe VALUES (37);");
    assert.equal(database.prepare("SELECT value FROM package_probe").get().value, 37);
  } finally {
    database.close();
  }

  const lockPath = join(temporaryRoot, "native.lock");
  const descriptor = openSync(lockPath, "w", 0o600);
  try {
    fsExt.flockSync(descriptor, "exnb");
    fsExt.flockSync(descriptor, "un");
  } finally {
    closeSync(descriptor);
  }
}

async function assertFastifyLifecycle(server, contracts) {
  assert.ok(server !== undefined && contracts !== undefined, "server and contracts packages must import");
  const serverDescriptor = manifest.packages.find((entry) => entry.name === "@hostdeck/server");
  assert.ok(serverDescriptor !== undefined, "server package descriptor must exist");
  const require = createRequire(realpathSync(join(packageRoot, serverDescriptor.root, "package.json")));
  const { z } = require("zod");
  const authentication = server.createHostDeckRequestAuthenticationPolicy({
    authenticateDeviceToken() {
      throw new Error("Unexpected device authentication in package smoke.");
    },
    now: () => new Date("2026-07-20T12:00:00.000Z")
  });

  const rejectedPort = await getAvailablePort();
  const missingStatic = join(temporaryRoot, "missing-static");
  await assert.rejects(
    server.startHostDeckFastifyLifecycle({
      createRequestAuthenticationPolicy: () => authentication,
      createRoutePlugins: () => [
        server.createHostDeckStaticBoundaryRegistration({
          browserRoutes: ["/"],
          buildRoot: missingStatic,
          id: "package-missing-static"
        })
      ],
      observeInternalError: () => undefined,
      resourceBudget: contracts.defaultResourceBudget,
      runtime: runtimeOwner(rejectedPort)
    }),
    (error) => error?.code === "app_ready_failed" && error?.stage === "ready"
  );
  const released = await listenOn(rejectedPort);
  await closeServer(released);

  const staticRoot = join(temporaryRoot, "static");
  mkdirSync(join(staticRoot, "assets"), { recursive: true });
  writeFileSync(join(staticRoot, "index.html"), "<!doctype html><p>PACKAGE_STATIC_SHELL</p>", { mode: 0o600 });
  writeFileSync(join(staticRoot, "assets", "app-12345678.js"), "globalThis.hostDeckPackage = true;\n", {
    mode: 0o600
  });
  const port = await getAvailablePort();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const lifecycle = await server.startHostDeckFastifyLifecycle({
      createRequestAuthenticationPolicy: () => authentication,
      createRoutePlugins: () => [
        probeRegistration(z),
        server.createHostDeckStaticBoundaryRegistration({
          browserRoutes: ["/"],
          buildRoot: staticRoot,
          id: "package-static"
        })
      ],
      observeInternalError: () => undefined,
      resourceBudget: contracts.defaultResourceBudget,
      runtime: runtimeOwner(port)
    });
    try {
      assert.equal(lifecycle.snapshot().phase, "ready");
      const response = await fetch(new URL("/api/package-probe", lifecycle.baseUrl), {
        headers: { connection: "close" }
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
      const shell = await fetch(lifecycle.baseUrl, { headers: { connection: "close" } });
      assert.equal(shell.status, 200);
      assert.match(await shell.text(), /PACKAGE_STATIC_SHELL/u);
    } finally {
      await lifecycle.close();
    }
    assert.equal(lifecycle.snapshot().phase, "closed");
  }
}

function runtimeOwner(port) {
  return {
    beginDrain() {},
    closeRuntime() {},
    closeSse() {},
    closeStartup() {},
    start({ deadline }) {
      deadline.throwIfAborted();
      return {
        bind: { host: "127.0.0.1", port, transport: "http" },
        context: Object.freeze({ packageSmoke: true })
      };
    }
  };
}

function probeRegistration(z) {
  return {
    id: "package-probe",
    surface: "api",
    register(app) {
      app.get(
        "/api/package-probe",
        {
          schema: {
            response: { 200: z.strictObject({ ok: z.literal(true) }) }
          }
        },
        async () => ({ ok: true })
      );
    }
  };
}

async function getAvailablePort() {
  const server = await listenOn(0);
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  await closeServer(server);
  return address.port;
}

function listenOn(port) {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ exclusive: true, host: "127.0.0.1", port }, () => resolvePromise(server));
  });
}

function closeServer(server) {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => {
      if (error !== undefined) reject(error);
      else resolvePromise();
    });
  });
}
