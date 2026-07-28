import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";
import { readSupportedBrowserManifest } from "./scripts/browser-support-manifest.mjs";

const manifest = readSupportedBrowserManifest();
const packagePort = 4175;
const httpsPort = 4176;
const proxyPort = 4177;

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "supported-browser-matrix.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  maxFailures: 1,
  forbidOnly: true,
  timeout: 45_000,
  reporter: [["line"]],
  outputDir: "/tmp/hostdeck-playwright-e2e",
  expect: {
    timeout: 8_000
  },
  projects: manifest.projects.map((project) => ({
    name: project.id,
    use: {
      baseURL: `http://127.0.0.1:${packagePort}`,
      browserName: project.browser_name,
      colorScheme: "dark",
      deviceScaleFactor: 1,
      hasTouch: project.has_touch,
      headless: true,
      ignoreHTTPSErrors: true,
      isMobile: project.is_mobile,
      locale: "en-US",
      proxy: {
        server: `http://127.0.0.1:${proxyPort}`,
        bypass: "127.0.0.1,localhost"
      },
      reducedMotion: "reduce",
      serviceWorkers: "block",
      timezoneId: "UTC",
      trace: "retain-on-failure",
      viewport: project.viewport
    }
  })) as PlaywrightTestConfig["projects"],
  webServer: [
    {
      command: `node scripts/run-production-browser-server.mjs dist/hostdeck ${packagePort}`,
      gracefulShutdown: {
        signal: "SIGTERM",
        timeout: 10_000
      },
      url: `http://127.0.0.1:${packagePort}/`,
      reuseExistingServer: false,
      timeout: 30_000
    },
    {
      command:
        `node scripts/run-supported-browser-https-proxy.mjs ${httpsPort} ` +
        `http://127.0.0.1:${packagePort} ${proxyPort}`,
      gracefulShutdown: {
        signal: "SIGTERM",
        timeout: 10_000
      },
      ignoreHTTPSErrors: true,
      url: `https://127.0.0.1:${httpsPort}/`,
      reuseExistingServer: false,
      timeout: 30_000
    }
  ]
});
