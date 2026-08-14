import { readdirSync, readFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadedThreadCandidateSchema,
  managedSessionProjectionSchema,
  pendingEnrollmentSnapshotSchema,
  selectedSessionEventStreamSchema,
  sessionCatalogBootstrapSchema,
  sharedCodexEndpointLocationSchema,
  sharedCodexEndpointSchema,
  sharedSessionCatalogEntrySchema,
  sharedSessionEnrollmentSchema,
  sharedSessionMembershipRecordSchema,
  trackedSessionSchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import {
  automaticSharedSessionMembership,
  eligibleLoadedThreadCandidate,
  enrolledSharedSession,
  historicalAdoptedSessionMembership,
  pendingMaterializationEnrollment,
  readySharedCodexEndpoint,
  sharedCodexEndpointLocationFixture,
  sharedRuntimeBoundaryEnrollment,
  sharedSessionCatalogBootstrapFixture,
  sharedSessionCatalogEntryFixture,
  trackedSharedSession
} from "./shared-codex-runtime.js";
import { selectedStructuredRuntimeFixtures, structuredRuntimeFixtureById } from "./structured-runtime.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const packagesRoot = resolve(repositoryRoot, "packages");
const generatedProtocolImport = /(?:^|\/)(?:generated|protocol-generated)(?:\/|$)|codex.*app-server.*(?:generated|protocol)/iu;
const tailscaleSpecificImport = /tailscale/iu;

describe("selected foundation package boundary", () => {
  it("keeps generated Codex protocol imports adapter-private", () => {
    const violations: string[] = [];

    for (const file of typescriptFiles(packagesRoot)) {
      const repositoryPath = repositoryRelativePath(file);
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
      const repositoryPath = repositoryRelativePath(file);
      if (!normalizedConsumers.some((prefix) => repositoryPath.startsWith(prefix))) continue;

      for (const specifier of moduleSpecifiers(readFileSync(file, "utf8"))) {
        if (tailscaleSpecificImport.test(specifier)) violations.push(`${repositoryPath}: ${specifier}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("recognizes Tailscale adapter, CLI, generated, and relative-module import drift", () => {
    for (const specifier of ["@hostdeck/tailscale-adapter", "tailscale", "./generated-tailscale-status.js", "../../server/src/tailscale-observer.js"]) {
      expect(tailscaleSpecificImport.test(specifier), specifier).toBe(true);
    }
    for (const specifier of ["@hostdeck/contracts", "./remote-ingress.js", "@hostdeck/core"]) {
      expect(tailscaleSpecificImport.test(specifier), specifier).toBe(false);
    }
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

  it("parses shared-runtime fixtures repeatedly and concurrently without mutation", async () => {
    const fixtures = {
      eligibleLoadedThreadCandidate,
      pendingMaterializationEnrollment,
      sharedCodexEndpointLocationFixture,
      readySharedCodexEndpoint,
      trackedSharedSession,
      sharedSessionCatalogEntryFixture,
      enrolledSharedSession,
      automaticSharedSessionMembership,
      historicalAdoptedSessionMembership,
      sharedSessionCatalogBootstrapFixture,
      sharedRuntimeBoundaryEnrollment
    };
    const before = JSON.stringify(fixtures);
    const parsed = await Promise.all(
      Array.from({ length: 32 }, async () => ({
        candidate: loadedThreadCandidateSchema.parse(fixtures.eligibleLoadedThreadCandidate),
        pending: pendingEnrollmentSnapshotSchema.parse(fixtures.pendingMaterializationEnrollment),
        location: sharedCodexEndpointLocationSchema.parse(fixtures.sharedCodexEndpointLocationFixture),
        endpoint: sharedCodexEndpointSchema.parse(fixtures.readySharedCodexEndpoint),
        tracked: trackedSessionSchema.parse(fixtures.trackedSharedSession),
        catalogEntry: sharedSessionCatalogEntrySchema.parse(fixtures.sharedSessionCatalogEntryFixture),
        enrolled: sharedSessionEnrollmentSchema.parse(fixtures.enrolledSharedSession),
        automaticMembership: sharedSessionMembershipRecordSchema.parse(fixtures.automaticSharedSessionMembership),
        historicalMembership: sharedSessionMembershipRecordSchema.parse(fixtures.historicalAdoptedSessionMembership),
        catalog: sessionCatalogBootstrapSchema.parse(fixtures.sharedSessionCatalogBootstrapFixture),
        boundary: sharedSessionEnrollmentSchema.parse(fixtures.sharedRuntimeBoundaryEnrollment)
      }))
    );

    expect(parsed).toHaveLength(32);
    expect(parsed.every((pass) => pass.catalog.length === 3)).toBe(true);
    expect(JSON.stringify(fixtures)).toBe(before);
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

    expect(
      sharedCodexEndpointSchema.safeParse({
        ...readySharedCodexEndpoint,
        socket_path: sharedCodexEndpointLocationFixture.socket_path
      }).success
    ).toBe(false);
    expect(loadedThreadCandidateSchema.safeParse({ ...eligibleLoadedThreadCandidate, turns: [] }).success).toBe(false);
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

function repositoryRelativePath(file: string): string {
  return relative(repositoryRoot, file).replaceAll("\\", "/");
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
