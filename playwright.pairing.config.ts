import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "pairing-bootstrap.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: [["line"]],
  use: {
    baseURL: "http://127.0.0.1:4179",
    browserName: "chromium",
    headless: true,
    trace: "off"
  },
  webServer: {
    command: "pnpm exec vite --config vite.pairing.config.ts --host 127.0.0.1 --port 4179 --strictPort",
    url: "http://127.0.0.1:4179/",
    reuseExistingServer: false,
    timeout: 30_000
  }
});
