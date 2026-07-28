import { lstatSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium, firefox } from "@playwright/test";
import { readSupportedBrowserManifest } from "./browser-support-manifest.mjs";

const require = createRequire(import.meta.url);
const playwrightPackage = require("@playwright/test/package.json");

export async function inspectSupportedBrowserRuntime(options = {}) {
  const manifest = options.manifest ?? readSupportedBrowserManifest();
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const playwrightVersion = options.playwrightVersion ?? playwrightPackage.version;
  const browserTypes = options.browserTypes ?? { chromium, firefox };
  const inspectExecutable = options.inspectExecutable ?? defaultInspectExecutable;

  if (platform !== manifest.platform || architecture !== manifest.architecture) {
    throw new TypeError("Supported browser matrix platform identity is invalid.");
  }
  if (playwrightVersion !== manifest.playwright_version) {
    throw new TypeError("Supported browser matrix Playwright identity is invalid.");
  }

  const engines = [];
  for (const expected of manifest.engines) {
    const browserType = browserTypes[expected.browser_name];
    if (browserType === undefined) {
      throw new TypeError(`Supported browser ${expected.browser_name} is unavailable.`);
    }
    const executablePath = browserType.executablePath();
    const executable = inspectExecutable(executablePath);
    if (
      !expected.executable_directory_markers.some((marker) =>
        executable.pathSegments.includes(marker)
      )
    ) {
      throw new TypeError(
        `Supported browser ${expected.browser_name} revision identity is invalid.`
      );
    }
    if (!executable.regularFile || executable.symbolicLink || !executable.executable) {
      throw new TypeError(
        `Supported browser ${expected.browser_name} executable is invalid.`
      );
    }

    let browser;
    try {
      browser = await browserType.launch({ headless: true });
      const observedVersion = browser.version();
      if (observedVersion !== expected.browser_version) {
        throw new TypeError(
          `Supported browser ${expected.browser_name} version identity is invalid.`
        );
      }
      engines.push(Object.freeze({
        browser_name: expected.browser_name,
        browser_version: observedVersion,
        revision: expected.revision
      }));
    } finally {
      await browser?.close();
    }
  }

  return Object.freeze({
    schema_version: 1,
    playwright_version: playwrightVersion,
    platform,
    architecture,
    engines: Object.freeze(engines)
  });
}

function defaultInspectExecutable(path) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    throw new TypeError("Supported browser executable is not installed.");
  }
  return Object.freeze({
    pathSegments: Object.freeze(path.split(/[\\/]/u).filter(Boolean)),
    regularFile: stats.isFile(),
    symbolicLink: stats.isSymbolicLink(),
    executable: (stats.mode & 0o111) !== 0
  });
}
