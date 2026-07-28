import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "accessibility-native-zoom.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  reporter: [["line"]],
  outputDir: "/tmp/hostdeck-playwright-accessibility-zoom",
  expect: {
    timeout: 8_000
  },
  use: {
    baseURL: "http://127.0.0.1:4175",
    browserName: "chromium",
    channel: "chrome",
    colorScheme: "dark",
    headless: false,
    trace: "off",
    viewport: null,
    launchOptions: {
      args: [
        "--disable-features=Translate",
        "--force-device-scale-factor=1",
        "--kiosk",
        "--no-first-run"
      ]
    }
  },
  webServer: {
    command:
      "pnpm --filter @hostdeck/web preview --host 127.0.0.1 --port 4175 --strictPort",
    url: "http://127.0.0.1:4175/",
    reuseExistingServer: false,
    timeout: 30_000
  }
});
