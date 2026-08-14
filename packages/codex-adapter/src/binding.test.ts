import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { codexBindingDescriptor, codexBindingManifest } from "./binding.js";
import {
  generatedClientNotificationMethods,
  generatedClientRequestMethods,
  generatedServerNotificationMethods,
  generatedServerRequestMethods
} from "./protocol-methods.generated.js";

describe("Codex generated binding ownership", () => {
  it("exposes one immutable reviewed identity and selected protocol surface", () => {
    expect(codexBindingManifest).toMatchObject({
      codexVersion: "0.147.0",
      experimentalApi: true,
      fileCount: 723,
      treeSha256: "673c02b5a758e082cb02c15f36bf4f37e88501470fd430ad232bebd754e8689c"
    });
    expect(codexBindingDescriptor.binding_id).toBe(
      `codex-app-server-0.147.0-experimental:sha256:${codexBindingManifest.treeSha256}`
    );
    expect(Object.isFrozen(codexBindingManifest)).toBe(true);
    expect(Object.isFrozen(codexBindingManifest.generationArgs)).toBe(true);
    expect(Object.isFrozen(codexBindingDescriptor)).toBe(true);
    expect(Object.isFrozen(codexBindingDescriptor.surface)).toBe(true);
    for (const entries of Object.values(codexBindingDescriptor.surface)) {
      expect(Object.isFrozen(entries)).toBe(true);
      expect(new Set(entries).size).toBe(entries.length);
    }
    expect(codexBindingDescriptor.surface.server_notifications).toEqual(
      expect.arrayContaining([
        "item/agentMessage/delta",
        "item/completed",
        "item/started",
        "serverRequest/resolved",
        "thread/settings/updated"
      ])
    );
    expect(codexBindingDescriptor.surface.server_notifications).not.toContain("thread/compacted");
    expect(codexBindingDescriptor.surface.policy_evidence).toContain("context_compaction_item_type");
  });

  it("does not re-export raw generated protocol types from the package entry", () => {
    const packageEntry = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(packageEntry).not.toMatch(/generated/iu);
    expect(packageEntry).not.toMatch(/\b(?:ClientRequest|ServerRequest|ServerNotification|TurnStartParams)\b/u);
  });

  it("derives immutable complete method catalogs from each generated discriminated union", () => {
    const catalogs = [
      [generatedClientRequestMethods, 136],
      [generatedClientNotificationMethods, 1],
      [generatedServerNotificationMethods, 72],
      [generatedServerRequestMethods, 11]
    ] as const;
    for (const [catalog, expectedCount] of catalogs) {
      expect(catalog).toHaveLength(expectedCount);
      expect(new Set(catalog).size).toBe(expectedCount);
      expect(Object.isFrozen(catalog)).toBe(true);
    }
    expect(generatedClientRequestMethods).toEqual(expect.arrayContaining(["initialize", "collaborationMode/list", "turn/start"]));
    expect(generatedClientNotificationMethods).toEqual(["initialized"]);
    expect(generatedServerRequestMethods).toEqual(
      expect.arrayContaining(["item/commandExecution/requestApproval", "item/fileChange/requestApproval"])
    );
  });
});
