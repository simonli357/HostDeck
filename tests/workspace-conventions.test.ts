import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const packages = [
  "core",
  "contracts",
  "test-fixtures",
  "storage",
  "tmux-adapter",
  "server",
  "cli",
  "web"
];

const expectedEntry = "./src/index.ts";

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readPackageManifest(packageName: string) {
  return readJson(join("packages", packageName, "package.json")) as {
    name?: string;
    private?: boolean;
    type?: string;
    types?: string;
    exports?: Record<string, { types?: string; import?: string }>;
    scripts?: Record<string, string>;
  };
}

describe("workspace package conventions", () => {
  it("keeps every planned package present and private", () => {
    expect(packages).toHaveLength(8);

    for (const packageName of packages) {
      const manifest = readPackageManifest(packageName);

      expect(manifest.name).toBe(`@hostdeck/${packageName}`);
      expect(manifest.private).toBe(true);
      expect(manifest.type).toBe("module");
    }
  });

  it("uses the shared source export convention", () => {
    for (const packageName of packages) {
      const manifest = readPackageManifest(packageName);

      expect(manifest.types).toBe(expectedEntry);
      expect(manifest.exports?.["."]?.types).toBe(expectedEntry);
      expect(manifest.exports?.["."]?.import).toBe(expectedEntry);
    }
  });

  it("exposes a consistent package typecheck script", () => {
    for (const packageName of packages) {
      const manifest = readPackageManifest(packageName);

      expect(manifest.scripts?.typecheck).toBe("tsc --noEmit -p tsconfig.json");
    }
  });
});
