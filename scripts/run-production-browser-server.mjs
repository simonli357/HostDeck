import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { verifyProductionPackage } from "./verify-production-package.mjs";

const sourceArgument = process.argv[2];
const portArgument = process.argv[3];
if (sourceArgument === undefined || portArgument === undefined) {
  throw new TypeError(
    "Usage: node run-production-browser-server.mjs <package-root> <port>"
  );
}
const port = Number(portArgument);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new TypeError("Production browser server port is invalid.");
}

const sourceRoot = realpathSync(resolve(sourceArgument));
verifyProductionPackage(sourceRoot);
const configuredTemporaryParent = process.env.HOSTDECK_PACKAGE_BROWSER_TEMP_ROOT;
const temporaryParent =
  configuredTemporaryParent === undefined
    ? tmpdir()
    : realpathSync(resolve(configuredTemporaryParent));
const temporaryRoot = mkdtempSync(
  join(
    temporaryParent,
    configuredTemporaryParent === undefined
      ? "hostdeck-package-browser-"
      : "relocated-"
  )
);
const packageRoot = join(temporaryRoot, "relocated-package");
let lifecycle = null;

try {
  cpSync(sourceRoot, packageRoot, {
    dereference: false,
    errorOnExist: true,
    force: false,
    recursive: true,
    verbatimSymlinks: true
  });
  const manifest = JSON.parse(
    readFileSync(join(packageRoot, "hostdeck-package.json"), "utf8")
  );
  makeReadOnly(packageRoot, new Set(manifest.executableFiles));
  verifyProductionPackage(packageRoot);

  const serverDescriptor = manifest.packages.find(
    (descriptor) => descriptor.name === "@hostdeck/server"
  );
  const contractsDescriptor = manifest.packages.find(
    (descriptor) => descriptor.name === "@hostdeck/contracts"
  );
  assert.ok(serverDescriptor !== undefined);
  assert.ok(contractsDescriptor !== undefined);
  const server = await import(
    pathToFileURL(join(packageRoot, serverDescriptor.entrypoint)).href
  );
  const contracts = await import(
    pathToFileURL(join(packageRoot, contractsDescriptor.entrypoint)).href
  );
  const authentication = server.createHostDeckRequestAuthenticationPolicy({
    authenticateDeviceToken() {
      throw new TypeError(
        "Production package browser smoke received unexpected device authentication."
      );
    },
    now: () => new Date("2026-07-28T12:00:00.000Z")
  });

  lifecycle = await server.startHostDeckFastifyLifecycle({
    createRequestAuthenticationPolicy: () => authentication,
    createRoutePlugins: () => [
      server.createHostDeckStaticBoundaryRegistration({
        browserRoutes: manifest.web.browserRoutes,
        buildRoot: join(packageRoot, manifest.web.root),
        id: "production-package-browser-static",
        packageVersion: manifest.packageVersion
      })
    ],
    observeInternalError: () => undefined,
    resourceBudget: contracts.defaultResourceBudget,
    runtime: {
      beginDrain() {},
      closeRuntime() {},
      closeSse() {},
      closeStartup() {},
      start({ deadline }) {
        deadline.throwIfAborted();
        return {
          bind: { host: "127.0.0.1", port, transport: "http" },
          context: Object.freeze({ productionPackageBrowser: true })
        };
      }
    }
  });
  process.stdout.write(`HostDeck packaged browser server ready on ${port}.\n`);
  await waitForTerminationSignal();
} finally {
  try {
    await lifecycle?.close();
  } finally {
    makeWritable(temporaryRoot);
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

function waitForTerminationSignal() {
  return new Promise((resolveSignal) => {
    const finish = () => resolveSignal();
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

function makeReadOnly(root, executables) {
  const directories = [];
  visit(root, (path, stats) => {
    if (stats.isDirectory()) {
      directories.push(path);
    } else if (stats.isFile()) {
      const relativePath = path.slice(root.length + 1).split("\\").join("/");
      chmodSync(path, executables.has(relativePath) ? 0o555 : 0o444);
    }
  });
  directories.sort((left, right) => right.length - left.length);
  for (const path of directories) chmodSync(path, 0o555);
}

function makeWritable(root) {
  let stats;
  try {
    stats = lstatSync(root);
  } catch {
    return;
  }
  if (stats.isSymbolicLink()) return;
  if (stats.isDirectory()) {
    chmodSync(root, 0o755);
    for (const entry of readdirSync(root)) makeWritable(join(root, entry));
  } else if (stats.isFile()) {
    chmodSync(root, stats.mode & 0o111 ? 0o755 : 0o644);
  }
}

function visit(root, inspect) {
  const stats = lstatSync(root);
  if (stats.isSymbolicLink()) return;
  inspect(root, stats);
  if (!stats.isDirectory()) return;
  for (const entry of readdirSync(root)) visit(join(root, entry), inspect);
}
