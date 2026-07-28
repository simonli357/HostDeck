import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { installApprovalDecisionsApi } from "./approval-decisions-fixture.js";
import { installMissionControlApi } from "./mission-control-fixture.js";
import { installModelControlApi } from "./model-control-fixture.js";
import { sessionDetailBrowserSessionId } from "./session-detail-fixture.js";

const artifactDirectory = resolve(
  process.cwd(),
  "artifacts/fe-v1-039-semantic-accessibility-hardening"
);
const detailPath = `/sessions/${sessionDetailBrowserSessionId}`;

test("records sanitized Orca 46.1 reading and focus observations", async ({ context, page }) => {
  await mkdir(artifactDirectory, { recursive: true });
  const rawLog = `/tmp/hostdeck-orca-${process.pid}.log`;
  const preferences = `/tmp/hostdeck-orca-${process.pid}`;
  const orcaVersion = execFileSync("orca", ["--version"], { encoding: "utf8" }).trim();
  expect(orcaVersion).toBe("46.1");

  await installModelControlApi(page, { sessionVariant: "writable" });
  await installMissionControlApi(page, "responsive", { fallbackUnhandled: true });
  await page.goto("/");
  const sourceRow = page.getByRole("link", { name: /^android-release/u });
  await expect(sourceRow).toBeVisible();

  const orca = spawn(
    "orca",
    [
      "--replace",
      "--enable",
      "speech",
      "--user-prefs",
      preferences,
      "--debug-file",
      rawLog
    ],
    { stdio: "ignore" }
  );

  try {
    await expect.poll(async () => {
      try {
        return (await readFile(rawLog, "utf8")).length;
      } catch {
        return 0;
      }
    }).toBeGreaterThan(0);
    await page.waitForTimeout(1_000);
    await page.bringToFront();
    const chromeWindow = focusedChromeWindow();
    sendKey(chromeWindow, "ctrl+Home");
    sendKey(chromeWindow, "h");
    await page.waitForTimeout(500);
    await sourceRow.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`${detailPath}$`, "u"));
    await expect(page.getByRole("main")).toBeFocused();
    sendKey(chromeWindow, "h");
    const prompt = page.getByRole("textbox", { name: "Prompt for android-release" });
    await prompt.focus();
    await page.waitForTimeout(300);

    const modelTrigger = page.getByRole("button", { name: "/model for android-release" });
    await modelTrigger.focus();
    await page.keyboard.press("Enter");
    const modelDialog = page.getByRole("dialog", { name: "/model" });
    await expect(modelDialog).toBeVisible();
    sendKey(chromeWindow, "ctrl+Home");
    sendKey(chromeWindow, "h");
    await page.waitForTimeout(500);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Escape");
    await expect(modelTrigger).toBeFocused();

    await page.goto("/not-a-hostdeck-route");
    await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
    await page.getByRole("main").focus();
    sendKey(chromeWindow, "h");
    await page.waitForTimeout(500);

    const approvalPage = await context.newPage();
    await approvalPage.clock.setFixedTime(new Date("2026-07-22T22:00:00.000Z"));
    await installApprovalDecisionsApi(approvalPage, { snapshotVariant: "elevated" });
    await approvalPage.goto(detailPath);
    const approvalTrigger = approvalPage.getByRole("button", { name: "Review & approve" });
    await expect(approvalTrigger).toBeVisible();
    await approvalPage.bringToFront();
    focusedChromeWindow();
    await approvalTrigger.focus();
    await approvalPage.keyboard.press("Enter");
    await expect(
      approvalPage.getByRole("dialog", { name: "Approve elevated request?" })
    ).toBeVisible();
    sendKey(chromeWindow, "h");
    await approvalPage.waitForTimeout(1_000);

    const log = await readFile(rawLog, "utf8");
    const observations = {
      orcaVersion,
      rawLogRetained: false,
      deterministicFixtureOnly: true,
      missionHeadingObserved: log.includes("Mission Control"),
      missionRowObserved: log.includes("android-release"),
      detailHeadingObserved: log.includes("android-release activity"),
      timelineObserved: /Session activity|android-release activity/iu.test(log),
      formFieldObserved:
        /Prompt for android-release|Write a prompt for this session|TEXT_AREA|text area|ENTRY/iu
          .test(log),
      modelDialogObserved: /\/model|Close model control|Model control ready/iu.test(log),
      approvalObserved: /Review & approve|Approve elevated request/iu.test(log),
      notFoundHeadingObserved: log.includes("Page not found"),
      speechOutputObserved: /SPEECH OUTPUT/iu.test(log),
      protectedMarkerObserved: /csrf|private-secret|request-private|thread-private/iu.test(log)
    };
    expect(observations).toMatchObject({
      missionHeadingObserved: true,
      missionRowObserved: true,
      detailHeadingObserved: true,
      timelineObserved: true,
      formFieldObserved: true,
      modelDialogObserved: true,
      approvalObserved: true,
      notFoundHeadingObserved: true,
      speechOutputObserved: true,
      protectedMarkerObserved: false
    });
    await writeFile(
      resolve(artifactDirectory, "orca-46.1-observations.json"),
      `${JSON.stringify(observations, null, 2)}\n`,
      "utf8"
    );
  } finally {
    orca.kill("SIGTERM");
    await new Promise<void>((resolveExit) => {
      if (orca.exitCode !== null) resolveExit();
      else orca.once("exit", () => resolveExit());
    });
    await rm(rawLog, { force: true });
    await rm(preferences, { force: true, recursive: true });
  }
});

function focusedChromeWindow(): string {
  const output = execFileSync(
    "xdotool",
    ["search", "--onlyvisible", "--name", "HostDeck"],
    { encoding: "utf8" }
  );
  const windowId = output.trim().split(/\s+/u).filter(Boolean).at(-1);
  if (windowId === undefined) throw new TypeError("The headed HostDeck Chrome window is missing.");
  execFileSync("xdotool", ["windowfocus", "--sync", windowId]);
  return windowId;
}

function sendKey(windowId: string, key: string): void {
  execFileSync("xdotool", ["key", "--clearmodifiers", "--window", windowId, key]);
}
