import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: [
    "access-recovery.spec.ts",
    "app-shell.spec.ts",
    "approval-decisions.spec.ts",
    "compact-control.spec.ts",
    "event-diagnostics.spec.ts",
    "mission-control.spec.ts",
    "goal-control.spec.ts",
    "host-lock.spec.ts",
    "model-control.spec.ts",
    "paired-device-management.spec.ts",
    "plan-control.spec.ts",
    "prompt-composer.spec.ts",
    "remote-connection-recovery.spec.ts",
    "session-detail.spec.ts",
    "skills-control.spec.ts",
    "usage-control.spec.ts"
  ],
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: [["line"]],
  outputDir: "/tmp/hostdeck-playwright-shell",
  expect: {
    timeout: 5_000
  },
  use: {
    baseURL: "http://127.0.0.1:4175",
    browserName: "chromium",
    colorScheme: "dark",
    deviceScaleFactor: 1,
    hasTouch: true,
    headless: true,
    isMobile: true,
    trace: "off",
    viewport: {
      width: 390,
      height: 844
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
