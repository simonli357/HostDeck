import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  expectAxeClean,
  expectCoreTargets,
  expectDialogFocusCycle,
  expectFocusInViewport,
  expectNoHorizontalOverflow,
  expectPageSemantics,
  expectThemeContrastContract
} from "./accessibility-assertions.js";
import { installMissionControlApi } from "./mission-control-fixture.js";
import { installModelControlApi } from "./model-control-fixture.js";
import { sessionDetailBrowserSessionId } from "./session-detail-fixture.js";

const artifactDirectory = resolve(
  process.cwd(),
  "artifacts/fe-v1-039-semantic-accessibility-hardening"
);
const detailPath = `/sessions/${sessionDetailBrowserSessionId}`;

test("proves native 200 percent zoom at exact 320 by 400 CSS geometry", async ({ page }) => {
  await mkdir(artifactDirectory, { recursive: true });
  await installModelControlApi(page, { sessionVariant: "writable_long" });
  await installMissionControlApi(page, "responsive", { fallbackUnhandled: true });
  await page.goto("/");
  await expect(page.getByRole("link", { name: /^android-release/u })).toBeVisible();

  const chromeWindow = focusedChromeWindow();
  sendChromeShortcut(chromeWindow, "F11");
  await page.waitForTimeout(300);
  execFileSync("xdotool", ["windowmove", "--sync", chromeWindow, "0", "0"]);
  execFileSync("xdotool", ["windowsize", "--sync", chromeWindow, "640", "800"]);
  sendChromeShortcut(chromeWindow, "ctrl+0");
  await expect.poll(() => viewportGeometry(page)).toMatchObject({
    devicePixelRatio: 1,
    innerHeight: 800,
    innerWidth: 640,
    outerHeight: 800,
    outerWidth: 640,
    screenHeight: 800,
    screenWidth: 640
  });
  const before = await viewportGeometry(page);
  const beforeRootFontSize = await page.evaluate(
    () => getComputedStyle(document.documentElement).fontSize
  );

  for (let increment = 0; increment < 5; increment += 1) {
    sendChromeShortcut(chromeWindow, "ctrl+plus");
    await page.waitForTimeout(120);
  }
  await expect.poll(() => viewportGeometry(page)).toMatchObject({
    devicePixelRatio: 2,
    innerHeight: 400,
    innerWidth: 320,
    outerHeight: 800,
    outerWidth: 640,
    screenHeight: 800,
    screenWidth: 640
  });
  const zoomed = await viewportGeometry(page);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe(
    beforeRootFontSize
  );

  await expectPageSemantics(page, "Mission Control | HostDeck");
  await expectNoHorizontalOverflow(page);
  await expectCoreTargets(page);
  const contrast = await expectThemeContrastContract(page);
  await expectAxeClean(page, "native 200 percent zoom Mission Control");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await skip.focus();
  await expect(skip).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
  await expectFocusInViewport(page);
  capturePhysicalScreen(resolve(artifactDirectory, "mission-native-zoom-200.png"));

  const row = page.getByRole("link", { name: /^android-release/u });
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`${detailPath}$`, "u"));
  await expect(page.getByRole("main")).toBeFocused();
  await expect(page.getByRole("navigation", { name: "Mission Control sessions" })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  const modelTrigger = page.getByRole("button", { name: "/model for android-release" });
  await modelTrigger.focus();
  await expectFocusInViewport(page);
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "/model" });
  await expect(dialog).toBeVisible();
  const dialogGeometry = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth
    };
  });
  expect(dialogGeometry.top).toBeGreaterThanOrEqual(0);
  expect(dialogGeometry.left).toBeGreaterThanOrEqual(0);
  expect(dialogGeometry.right).toBeLessThanOrEqual(dialogGeometry.viewportWidth + 1);
  expect(dialogGeometry.bottom).toBeLessThanOrEqual(dialogGeometry.viewportHeight + 1);
  await expectDialogFocusCycle(page, dialog);
  await expectNoHorizontalOverflow(page);
  await expectCoreTargets(page);
  await expectAxeClean(page, "native 200 percent zoom model sheet");
  capturePhysicalScreen(resolve(artifactDirectory, "model-native-zoom-200.png"));
  await page.keyboard.press("Escape");
  await expect(modelTrigger).toBeFocused();
  await expectFocusInViewport(page);

  const final = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    activeRole: document.activeElement?.getAttribute("role") ?? "button",
    activeName:
      document.activeElement?.getAttribute("aria-label") ??
      document.activeElement?.textContent?.trim() ??
      ""
  }));
  await writeFile(
    resolve(artifactDirectory, "native-zoom-measurements.json"),
    `${JSON.stringify({ before, zoomed, beforeRootFontSize, contrast, dialogGeometry, final }, null, 2)}\n`,
    "utf8"
  );
});

function focusedChromeWindow(): string {
  const output = execFileSync(
    "xdotool",
    ["search", "--onlyvisible", "--name", "HostDeck"],
    { encoding: "utf8" }
  );
  const windows = output.trim().split(/\s+/u).filter(Boolean);
  const windowId = windows.at(-1);
  if (windowId === undefined) throw new TypeError("The headed HostDeck Chrome window is missing.");
  execFileSync("xdotool", ["windowfocus", "--sync", windowId]);
  return windowId;
}

function sendChromeShortcut(windowId: string, shortcut: string): void {
  execFileSync("xdotool", ["key", "--clearmodifiers", "--window", windowId, shortcut]);
}

function capturePhysicalScreen(path: string): void {
  execFileSync("import", ["-window", "root", path]);
}

async function viewportGeometry(page: Page) {
  return page.evaluate(() => ({
    devicePixelRatio: window.devicePixelRatio,
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
    outerHeight: window.outerHeight,
    outerWidth: window.outerWidth,
    screenHeight: window.screen.height,
    screenWidth: window.screen.width,
    visualHeight: window.visualViewport?.height ?? null,
    visualWidth: window.visualViewport?.width ?? null
  }));
}
