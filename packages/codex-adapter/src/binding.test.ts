import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { codexBindingDescriptor, codexBindingManifest } from "./binding.js";

describe("Codex generated binding ownership", () => {
  it("exposes one immutable reviewed identity and selected protocol surface", () => {
    expect(codexBindingManifest).toMatchObject({
      codexVersion: "0.144.0",
      experimentalApi: true,
      fileCount: 671,
      treeSha256: "e1a1a5cff3ab91862f9215dd06538eae1ea0b00bae48cbb7d87061faaee27e24"
    });
    expect(codexBindingDescriptor.binding_id).toBe(
      `codex-app-server-0.144.0-experimental:sha256:${codexBindingManifest.treeSha256}`
    );
    expect(Object.isFrozen(codexBindingManifest)).toBe(true);
    expect(Object.isFrozen(codexBindingManifest.generationArgs)).toBe(true);
    expect(Object.isFrozen(codexBindingDescriptor)).toBe(true);
    expect(Object.isFrozen(codexBindingDescriptor.surface)).toBe(true);
    for (const entries of Object.values(codexBindingDescriptor.surface)) {
      expect(Object.isFrozen(entries)).toBe(true);
      expect(new Set(entries).size).toBe(entries.length);
    }
  });

  it("does not re-export raw generated protocol types from the package entry", () => {
    const packageEntry = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(packageEntry).not.toMatch(/generated/iu);
    expect(packageEntry).not.toMatch(/ClientRequest|ServerRequest|ServerNotification|TurnStartParams/u);
  });
});
