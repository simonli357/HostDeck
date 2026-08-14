import assert from "node:assert/strict";
import test from "node:test";

import {
  collectDirectHostApis,
  collectModuleSpecifiers,
  compareExactModuleSet,
  directHostApiOwnerPaths,
  findCliLocalStorageBoundaryViolations,
  findDirectHostApiBoundaryViolations,
  findLegacyInterfaceTokens,
  isExactSelectedCliBin,
  readConstStringArray,
  readInterfacePropertyNames,
  readNamedImportNames
} from "./check-selected-runtime-boundary.mjs";

test("accepts only the selected source CLI command metadata", () => {
  assert.equal(
    isExactSelectedCliBin({ codexdeck: "./src/shell.ts" }),
    true
  );
  assert.equal(
    isExactSelectedCliBin({ codexdeck: "./src/bin.ts" }),
    false
  );
  assert.equal(
    isExactSelectedCliBin({
      codexdeck: "./src/shell.ts",
      unexpected: "./src/index.ts"
    }),
    false
  );
});

test("collects static imports, exports, and import types exactly", () => {
  const source = `
    import { one } from "./one.js";
    export * from "./two.js";
    type Three = import("./three.js").Three;
  `;
  assert.deepEqual(collectModuleSpecifiers(source), ["./one.js", "./three.js", "./two.js"]);
  assert.deepEqual(collectModuleSpecifiers('const blocked = /[#]/u; import value from "./after-regex.js";'), [
    "./after-regex.js"
  ]);
});

test("keeps direct host APIs inside exact reviewed platform adapter and edge owners", () => {
  const source = `
    import { readFile } from "node:fs/promises";
    import type { Socket } from "node:net";
    const platform = process.platform;
    const text = "process.env and node:path are inert fixture text";
  `;
  assert.deepEqual(collectDirectHostApis(source), ["node:fs/promises", "node:net", "process.platform"]);
  assert.deepEqual(
    findDirectHostApiBoundaryViolations("packages/core/src/new-owner.ts", source),
    [
      "packages/core/src/new-owner.ts accesses direct host APIs outside a reviewed platform adapter/edge owner: node:fs/promises, node:net, process.platform"
    ]
  );
  assert.deepEqual(
    findDirectHostApiBoundaryViolations(directHostApiOwnerPaths[0], source),
    []
  );
  assert.equal(
    directHostApiOwnerPaths.includes(
      "packages/codex-adapter/src/transport-endpoint.ts"
    ),
    true
  );
  assert.equal(
    directHostApiOwnerPaths.includes(
      "packages/storage/src/database-recovery.ts"
    ),
    true
  );
  assert.equal(
    directHostApiOwnerPaths.includes(
      "packages/server/src/shared-codex-broker-lifecycle.ts"
    ),
    true
  );
  assert.equal(
    directHostApiOwnerPaths.includes(
      "packages/server/src/shared-codex-broker-node.ts"
    ),
    true
  );
  assert.equal(new Set(directHostApiOwnerPaths).size, directHostApiOwnerPaths.length);
});

test("rejects an unexpected production-root export", () => {
  assert.deepEqual(
    compareExactModuleSet("root", ["./selected.js", "./lan.js"], ["./selected.js"]),
    ["root exposes unexpected root module ./lan.js"]
  );
});

test("rejects legacy tokens outside exact historical owners", () => {
  assert.deepEqual(findLegacyInterfaceTokens("packages/server/src/new-network.ts", 'export const mode = "lan";'), ["lan"]);
  assert.deepEqual(
    findLegacyInterfaceTokens("packages/storage/src/migrations.ts", 'const sql = "bind_mode lan";'),
    []
  );
});

test("reads exact selected arrays through const assertions", () => {
  assert.deepEqual(
    readConstStringArray('export const modes = ["loopback", "remote"] as const;', "modes"),
    ["loopback", "remote"]
  );
  assert.equal(readConstStringArray('const modes = ["loopback", value] as const;', "modes"), null);
});

test("reads interface properties without accepting methods or computed keys", () => {
  assert.deepEqual(
    readInterfacePropertyNames("interface Config { readonly apiUrl?: string; readonly port?: string }", "Config"),
    ["apiUrl", "port"]
  );
  assert.equal(readInterfacePropertyNames("interface Config { load(): void }", "Config"), null);
});

test("allows only the exact local device-list storage owner", () => {
  const source = `
    import { Value } from "@hostdeck/contracts";
    import {
      createDeviceListingRepository,
      HostDeckAuthRepositoryError,
      HostDeckLocalPathError,
      HostDeckMigrationError,
      openExistingHostDeckReadOnlyDatabase
    } from "@hostdeck/storage";
    import { internalFailure } from "./errors.js";
  `;
  assert.deepEqual(
    readNamedImportNames(source, "@hostdeck/storage"),
    [
      "HostDeckAuthRepositoryError",
      "HostDeckLocalPathError",
      "HostDeckMigrationError",
      "createDeviceListingRepository",
      "openExistingHostDeckReadOnlyDatabase"
    ]
  );
  assert.deepEqual(
    findCliLocalStorageBoundaryViolations(
      "packages/cli/src/local-device-list.ts",
      source
    ),
    []
  );
  assert.deepEqual(
    findCliLocalStorageBoundaryViolations(
      "packages/cli/src/unowned-storage.ts",
      source
    ),
    [
      "packages/cli/src/unowned-storage.ts crosses the CLI local-storage administration boundary"
    ]
  );
  assert.deepEqual(
    findCliLocalStorageBoundaryViolations(
      "packages/cli/src/local-device-list.ts",
      source.replace(
        "createDeviceListingRepository,",
        "createDeviceListingRepository, createSettingsRepository,"
      )
    ),
    [
      "packages/cli/src/local-device-list.ts local-storage imports drifted from its exact owner symbols"
    ]
  );
});
