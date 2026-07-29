import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "ui-fidelity-pairing.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: [["line"]],
  outputDir:
    process.env.HOSTDECK_FIDELITY_PLAYWRIGHT_OUTPUT_DIR ??
    "/tmp/hostdeck-playwright-fidelity-pairing",
  expect: { timeout: 5_000 },
  use: {
    baseURL: "http://127.0.0.1:4179",
    browserName: "chromium",
    colorScheme: "dark",
    deviceScaleFactor: 1,
    hasTouch: true,
    headless: true,
    isMobile: true,
    trace: "off",
    viewport: { width: 390, height: 844 }
  },
  webServer: {
    command:
      "pnpm exec vite --config vite.pairing.config.ts --host 127.0.0.1 --port 4179 --strictPort",
    url: "http://127.0.0.1:4179/",
    reuseExistingServer: false,
    timeout: 30_000
  }
});
