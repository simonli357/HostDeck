import assert from "node:assert/strict";
import test from "node:test";

import {
  collectModuleSpecifiers,
  compareExactModuleSet,
  findLegacyInterfaceTokens,
  readConstStringArray,
  readInterfacePropertyNames
} from "./check-selected-runtime-boundary.mjs";

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
