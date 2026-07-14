import { readdirSync, readFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { managedSessionProjectionSchema, selectedSessionEventStreamSchema } from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import { selectedStructuredRuntimeFixtures, structuredRuntimeFixtureById } from "./structured-runtime.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const packagesRoot = resolve(repositoryRoot, "packages");
const generatedProtocolImport = /(?:^|\/)(?:generated|protocol-generated)(?:\/|$)|codex.*app-server.*(?:generated|protocol)/iu;
const rawTailscaleImport = /tailscale.*(?:generated|protocol|raw)|(?:generated|protocol|raw).*tailscale/iu;

describe("selected foundation package boundary", () => {
  it("keeps generated Codex protocol imports adapter-private", () => {
    const violations: string[] = [];

    for (const file of typescriptFiles(packagesRoot)) {
      const repositoryPath = relative(repositoryRoot, file);
      if (repositoryPath.startsWith("packages/codex-adapter/")) continue;

      for (const specifier of moduleSpecifiers(readFileSync(file, "utf8"))) {
        if (generatedProtocolImport.test(specifier)) violations.push(`${repositoryPath}: ${specifier}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps raw Tailscale CLI shapes outside normalized foundation consumers", () => {
    const violations: string[] = [];
    const normalizedConsumers = ["packages/contracts/", "packages/core/", "packages/test-fixtures/", "packages/web/"];

    for (const file of typescriptFiles(packagesRoot)) {
      const repositoryPath = relative(repositoryRoot, file);
      if (!normalizedConsumers.some((prefix) => repositoryPath.startsWith(prefix))) continue;

      for (const specifier of moduleSpecifiers(readFileSync(file, "utf8"))) {
        if (rawTailscaleImport.test(specifier)) violations.push(`${repositoryPath}: ${specifier}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("parses selected fixtures repeatedly and concurrently without mutation", async () => {
    const before = JSON.stringify(selectedStructuredRuntimeFixtures);
    const parsed = await Promise.all(
      Array.from({ length: 32 }, async () =>
        selectedStructuredRuntimeFixtures.map((fixture) => ({
          session: managedSessionProjectionSchema.parse(fixture.session),
          stream: selectedSessionEventStreamSchema.parse(fixture.stream)
        }))
      )
    );

    expect(parsed).toHaveLength(32);
    expect(parsed.every((pass) => pass.length === selectedStructuredRuntimeFixtures.length)).toBe(true);
    expect(JSON.stringify(selectedStructuredRuntimeFixtures)).toBe(before);
  });

  it("rejects unknown required fields while preserving explicit unknown-optional events", () => {
    const running = structuredRuntimeFixtureById("running");
    expect(() =>
      managedSessionProjectionSchema.parse({
        ...running.session,
        future_required_state: "unreviewed"
      })
    ).toThrow();

    const optional = structuredRuntimeFixtureById("unknown_optional");
    expect(selectedSessionEventStreamSchema.parse(optional.stream).events[0]).toMatchObject({
      type: "unknown_optional",
      upstream_type: "thread/metadata/extended"
    });
  });
});

function typescriptFiles(directory: string): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...typescriptFiles(path));
    } else if (entry.isFile() && [".ts", ".tsx", ".mts", ".cts"].includes(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

function moduleSpecifiers(source: string): readonly string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^"'`;]*?\s+from\s+)?["']([^"'\r\n]+)["']/gu,
    /\bexport\s+(?:type\s+)?(?:\*|\{)[^"'`;]*?\s+from\s+["']([^"'\r\n]+)["']/gu,
    /\bimport\s*\(\s*["']([^"'\r\n]+)["']\s*\)/gu
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
}
