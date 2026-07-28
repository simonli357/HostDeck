import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "production-package.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: [["line"]],
  outputDir: "/tmp/hostdeck-playwright-package",
  expect: {
    timeout: 5_000
  },
  use: {
    baseURL: "http://127.0.0.1:4183",
    browserName: "chromium",
    colorScheme: "dark",
    deviceScaleFactor: 1,
    hasTouch: true,
    headless: true,
    isMobile: true,
    serviceWorkers: "block",
    trace: "off",
    viewport: {
      width: 390,
      height: 844
    }
  },
  webServer: {
    command:
      "node scripts/run-production-browser-server.mjs dist/hostdeck 4183",
    gracefulShutdown: {
      signal: "SIGTERM",
      timeout: 10_000
    },
    url: "http://127.0.0.1:4183/",
    reuseExistingServer: false,
    timeout: 30_000
  }
});
