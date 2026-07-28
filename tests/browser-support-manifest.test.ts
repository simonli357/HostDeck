import { describe, expect, it } from "vitest";
import {
  parseSupportedBrowserManifest,
  readSupportedBrowserManifest
} from "../scripts/browser-support-manifest.mjs";

describe("supported browser manifest", () => {
  it("pins the exact four-project Chromium and Firefox identity", () => {
    const manifest = readSupportedBrowserManifest();
    expect(manifest).toMatchObject({
      schema_version: 1,
      name: "hostdeck-supported-browser-matrix",
      task_id: "FE-V1-040",
      playwright_version: "1.61.1",
      platform: "linux",
      architecture: "x64",
      evidence_schema_version: 1
    });
    expect(manifest.engines.map(({ browser_name, browser_version, revision }) => ({
      browser_name,
      browser_version,
      revision
    }))).toEqual([
      { browser_name: "chromium", browser_version: "149.0.7827.55", revision: "1228" },
      { browser_name: "firefox", browser_version: "151.0", revision: "1532" }
    ]);
    expect(manifest.projects.map(({ id }) => id)).toEqual([
      "chromium-phone",
      "chromium-desktop",
      "firefox-phone",
      "firefox-desktop"
    ]);
    expect(manifest.projects.map(({ viewport }) => viewport)).toEqual([
      { width: 390, height: 844 },
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
      { width: 1280, height: 800 }
    ]);
    expect(manifest.projects.find(({ id }) => id === "firefox-phone")?.is_mobile)
      .toBe(false);
    expect(manifest.package).toMatchObject({
      package_version: "0.0.0",
      content_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      web_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    expect(manifest.scenarios).toHaveLength(19);
    expect(manifest.automated_interaction_ids).toHaveLength(34);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.projects[0]?.viewport)).toBe(true);
  });

  it("rejects schema, engine, project, option, and extra-key drift", () => {
    const valid = structuredClone(readSupportedBrowserManifest());
    const mutations: unknown[] = [
      { ...valid, schema_version: 2 },
      { ...valid, unexpected: true },
      { ...valid, package: { ...valid.package, web_sha256: "0".repeat(63) } },
      { ...valid, scenarios: valid.scenarios.slice(1) },
      {
        ...valid,
        scenarios: valid.scenarios.map((scenario, index) =>
          index === 0
            ? { ...scenario, interaction_ids: scenario.interaction_ids.slice(1) }
            : scenario
        )
      },
      {
        ...valid,
        automated_interaction_ids: [
          ...valid.automated_interaction_ids.slice(0, -1),
          valid.automated_interaction_ids[0]
        ]
      },
      { ...valid, engines: valid.engines.slice(0, 1) },
      {
        ...valid,
        engines: valid.engines.map((engine, index) =>
          index === 0 ? { ...engine, browser_version: "150.0" } : engine
        )
      },
      { ...valid, projects: [...valid.projects].reverse() },
      {
        ...valid,
        projects: valid.projects.map((project, index) =>
          index === 0 ? { ...project, viewport: { width: 391, height: 844 } } : project
        )
      },
      {
        ...valid,
        projects: valid.projects.map((project, index) =>
          index === 2 ? { ...project, is_mobile: true } : project
        )
      }
    ];
    for (const mutation of mutations) {
      expect(() => parseSupportedBrowserManifest(mutation)).toThrow(TypeError);
    }
  });
});
