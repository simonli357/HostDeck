import { describe, expect, it, vi } from "vitest";
import { readSupportedBrowserManifest } from "../scripts/browser-support-manifest.mjs";
import { inspectSupportedBrowserRuntime } from "../scripts/supported-browser-preflight.mjs";

describe("supported browser runtime preflight", () => {
  it("accepts only exact installed executable and launched version identities", async () => {
    const closeChromium = vi.fn(async () => undefined);
    const closeFirefox = vi.fn(async () => undefined);
    const inspection = await inspectSupportedBrowserRuntime({
      browserTypes: {
        chromium: {
          executablePath: () => "/cache/chromium_headless_shell-1228/chrome",
          launch: async () => ({ version: () => "149.0.7827.55", close: closeChromium })
        },
        firefox: {
          executablePath: () => "/cache/firefox-1532/firefox",
          launch: async () => ({ version: () => "151.0", close: closeFirefox })
        }
      },
      inspectExecutable: (path) => ({
        pathSegments: path.split("/").filter(Boolean),
        regularFile: true,
        symbolicLink: false,
        executable: true
      })
    });

    expect(inspection).toEqual({
      schema_version: 1,
      playwright_version: "1.61.1",
      platform: "linux",
      architecture: "x64",
      engines: [
        { browser_name: "chromium", browser_version: "149.0.7827.55", revision: "1228" },
        { browser_name: "firefox", browser_version: "151.0", revision: "1532" }
      ]
    });
    expect(closeChromium).toHaveBeenCalledOnce();
    expect(closeFirefox).toHaveBeenCalledOnce();
    expect(Object.isFrozen(inspection.engines)).toBe(true);
  });

  it("rejects platform, Playwright, revision, executable, and browser-version drift", async () => {
    const manifest = readSupportedBrowserManifest();
    const validTypes = {
      chromium: fakeBrowser("/cache/chromium-1228/chrome", "149.0.7827.55"),
      firefox: fakeBrowser("/cache/firefox-1532/firefox", "151.0")
    };
    const executable = (path: string) => ({
      pathSegments: path.split("/").filter(Boolean),
      regularFile: true,
      symbolicLink: false,
      executable: true
    });
    await expect(inspectSupportedBrowserRuntime({ manifest, platform: "darwin" }))
      .rejects.toThrow(TypeError);
    await expect(inspectSupportedBrowserRuntime({ manifest, playwrightVersion: "1.62.0" }))
      .rejects.toThrow(TypeError);
    await expect(inspectSupportedBrowserRuntime({
      manifest,
      browserTypes: { ...validTypes, firefox: fakeBrowser("/cache/firefox-1531/firefox", "151.0") },
      inspectExecutable: executable
    })).rejects.toThrow(TypeError);
    await expect(inspectSupportedBrowserRuntime({
      manifest,
      browserTypes: validTypes,
      inspectExecutable: (path) => ({ ...executable(path), executable: false })
    })).rejects.toThrow(TypeError);
    await expect(inspectSupportedBrowserRuntime({
      manifest,
      browserTypes: { ...validTypes, chromium: fakeBrowser("/cache/chromium-1228/chrome", "150.0") },
      inspectExecutable: executable
    })).rejects.toThrow(TypeError);
  });
});

function fakeBrowser(path: string, version: string) {
  return {
    executablePath: () => path,
    launch: async () => ({ version: () => version, close: async () => undefined })
  };
}
