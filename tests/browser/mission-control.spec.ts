import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  installMissionControlApi,
  missionRequestPaths
} from "./mission-control-fixture.js";

const artifactDirectory = resolve("artifacts/fe-v1-011-mission-control");
const viewports = [
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 412, height: 915 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 }
] as const;

test.beforeAll(async () => {
  await mkdir(artifactDirectory, { recursive: true });
});

test("renders the production mixed queue across the approved responsive continuum", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const api = await installMissionControlApi(page);
  await page.goto("/");
  await expect(page.getByRole("link", { name: /^release-approval/u })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "ACT NOW" })).toBeVisible();
  await expect(page.getByText("Laptop", { exact: true })).toBeVisible();
  await expect(page.getByText("Write", { exact: true })).toBeVisible();
  await expect(page.getByText("Current", { exact: true })).toBeVisible();

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await expectNoHorizontalOverflow(page, viewport.width);
    await expectStableTargets(page);
    await page.screenshot({
      path: resolve(
        artifactDirectory,
        `mixed-${viewport.width}x${viewport.height}.png`
      ),
      animations: "disabled"
    });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  const statusBox = await page.getByLabel("Host and access status").boundingBox();
  const secondActNowBox = await page
    .getByRole("region", { name: "ACT NOW" })
    .getByRole("link")
    .nth(1)
    .boundingBox();
  expect(statusBox).not.toBeNull();
  expect(secondActNowBox).not.toBeNull();
  expect((secondActNowBox?.y ?? 844) + (secondActNowBox?.height ?? 1)).toBeLessThanOrEqual(
    844
  );
  expect(await page.getByRole("region", { name: "ACT NOW" }).getByRole("link").count()).toBe(4);
  await writeFile(
    resolve(artifactDirectory, "first-viewport-390x844.json"),
    `${JSON.stringify(
      {
        viewport: { width: 390, height: 844 },
        status_rail: roundedBox(statusBox),
        second_act_now_row: roundedBox(secondActNowBox),
        second_act_now_row_bottom: Math.round(
          (secondActNowBox?.y ?? 0) + (secondActNowBox?.height ?? 0)
        ),
        act_now_row_count: 4
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  expect(missionRequestPaths(api)).toEqual([
    "/api/v1/access",
    expect.stringMatching(/^\/api\/v1\/(?:host\/status|sessions)$/u),
    expect.stringMatching(/^\/api\/v1\/(?:host\/status|sessions)$/u),
    "/api/v1/access/csrf"
  ]);
  await expectCleanBrowser(page, diagnostics);
});

test("preserves stale data, suppresses denied data, and contains long content", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const api = await installMissionControlApi(page);
  await page.goto("/");
  await expect(page.getByRole("link", { name: /^release-approval/u })).toBeVisible();

  api.setVariant("unavailable");
  await page.getByRole("button", { name: "Refresh sessions" }).click();
  await expect(page.getByText("Showing stale session state", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /^release-approval/u })).toBeVisible();
  await page.screenshot({
    path: resolve(artifactDirectory, "stale-390x844.png"),
    animations: "disabled"
  });

  api.setVariant("denied");
  await page.reload();
  await expect(page.getByText("Device access is invalid", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /^release-approval/u })).toHaveCount(0);
  await expect(page.getByText("6 sessions", { exact: true })).toHaveCount(0);
  await expectNoHorizontalOverflow(page, 390);
  await page.screenshot({
    path: resolve(artifactDirectory, "access-limited-390x844.png"),
    animations: "disabled"
  });

  api.setVariant("long");
  await page.reload();
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(
    page.getByRole("link", {
      name: /^release-approval-with-a-long-but-valid-session-name-2026/u
    })
  ).toBeVisible();
  await expectNoHorizontalOverflow(page, 360);
  await expectNoClippedSessionRows(page);
  await page.screenshot({
    path: resolve(artifactDirectory, "long-content-360x800.png"),
    animations: "disabled",
    fullPage: true
  });

  const bodyText = await page.locator("body").innerText();
  expect(bodyText).not.toContain("thread-sess_");
  expect(bodyText).not.toContain("/workspace/");
  expect(bodyText).not.toContain("opaque-selected-cursor");
  await expectCleanBrowser(page, diagnostics, 1);
});

test("passes reflow, keyboard, reduced-motion, and contrast checks", async ({ page }) => {
  const diagnostics = observePage(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 800 });
  await installMissionControlApi(page);
  await page.goto("/");
  await expect(page.getByRole("link", { name: /^release-approval/u })).toBeVisible();

  await expectNoHorizontalOverflow(page, 320);
  await expectStableTargets(page);
  await expectNoClippedText(page.locator(".hostdeck-status-rail dt, .hostdeck-status-rail dd"));

  const quietSummary = page.locator(".hostdeck-queue-disclosure > summary");
  const quietSummaryBox = await quietSummary.boundingBox();
  expect(quietSummaryBox?.height ?? 0).toBeGreaterThanOrEqual(44);

  await expectNextKeyboardFocus(page, page.getByRole("link", { name: "Skip to content" }));
  await expectNextKeyboardFocus(page, page.getByRole("button", { name: "Open Host and access" }));
  await expectNextKeyboardFocus(page, page.getByRole("button", { name: "Refresh sessions" }));
  await expectNextKeyboardFocus(
    page,
    page.getByRole("link", { name: /^release-approval/u })
  );

  await quietSummary.focus();
  await expectVisibleFocus(quietSummary);
  await page.keyboard.press("Enter");
  await expect(page.locator(".hostdeck-queue-disclosure")).toHaveAttribute("open", "");

  const disclosureTransition = await page
    .locator(".hostdeck-queue-disclosure__icon")
    .evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(disclosureTransition).toBe("0s");
  const spinnerAnimation = await page
    .getByRole("button", { name: "Refresh sessions" })
    .locator("svg")
    .evaluate((element) => {
      element.classList.add("hostdeck-spin");
      return getComputedStyle(element).animationName;
  });
  expect(spinnerAnimation).toBe("none");

  await expectTokenContrast(page);
  await page.keyboard.press("Enter");
  await expect(page.locator(".hostdeck-queue-disclosure")).not.toHaveAttribute("open", "");
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({
    path: resolve(artifactDirectory, "reflow-320x800.png"),
    animations: "disabled"
  });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  await expectNoDocumentOverflow(page);
  await expect(page.getByRole("button", { name: "Refresh sessions" })).toBeVisible();
  await page.screenshot({
    path: resolve(artifactDirectory, "zoom-200-1280x800.png"),
    animations: "disabled"
  });

  await expectCleanBrowser(page, diagnostics);
});

function observePage(page: Page) {
  const externalRequests: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== "http://127.0.0.1:4175") externalRequests.push(request.url());
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return { consoleErrors, externalRequests, pageErrors };
}

function roundedBox(
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null
) {
  if (box === null) return null;
  return Object.fromEntries(
    Object.entries(box).map(([key, value]) => [key, Math.round(value)])
  );
}

async function expectNoHorizontalOverflow(page: Page, expectedWidth: number): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth
      }))
    )
    .toEqual({ clientWidth: expectedWidth, scrollWidth: expectedWidth });
}

async function expectStableTargets(page: Page): Promise<void> {
  const iconButtons = page.locator(".hostdeck-icon-button:visible");
  for (let index = 0; index < (await iconButtons.count()); index += 1) {
    const box = await iconButtons.nth(index).boundingBox();
    expect(box?.width).toBe(44);
    expect(box?.height).toBe(44);
  }
  const sessionLinks = page.locator(".hostdeck-session-row__link:visible");
  for (let index = 0; index < (await sessionLinks.count()); index += 1) {
    const box = await sessionLinks.nth(index).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  const actionButtons = page.locator(".hostdeck-action-button:visible");
  for (let index = 0; index < (await actionButtons.count()); index += 1) {
    const box = await actionButtons.nth(index).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
}

async function expectNoClippedSessionRows(page: Page): Promise<void> {
  const rows = page.locator(".hostdeck-session-row:visible");
  for (let index = 0; index < (await rows.count()); index += 1) {
    const clipped = await rows.nth(index).evaluate((element) =>
      element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight
    );
    expect(clipped).toBe(false);
  }
}

async function expectNoClippedText(locator: Locator): Promise<void> {
  for (let index = 0; index < (await locator.count()); index += 1) {
    const clipped = await locator.nth(index).evaluate(
      (element) =>
        element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight
    );
    expect(clipped).toBe(false);
  }
}

async function expectNextKeyboardFocus(page: Page, locator: Locator): Promise<void> {
  await page.keyboard.press("Tab");
  await expect(locator).toBeFocused();
  await expectVisibleFocus(locator);
}

async function expectVisibleFocus(locator: Locator): Promise<void> {
  const focus = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth)
    };
  });
  expect(focus.outlineStyle).toBe("solid");
  expect(focus.outlineWidth).toBeGreaterThanOrEqual(3);
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth
      )
    )
    .toBe(true);
}

async function expectTokenContrast(page: Page): Promise<void> {
  const colors = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return Object.fromEntries(
      [
        "--hostdeck-canvas",
        "--hostdeck-surface",
        "--hostdeck-ink",
        "--hostdeck-muted",
        "--hostdeck-connected",
        "--hostdeck-attention",
        "--hostdeck-danger",
        "--hostdeck-focus"
      ].map((name) => [name, style.getPropertyValue(name).trim()])
    );
  });
  const surface = colors["--hostdeck-surface"] ?? "";
  for (const foreground of [
    "--hostdeck-ink",
    "--hostdeck-muted",
    "--hostdeck-connected",
    "--hostdeck-attention",
    "--hostdeck-danger"
  ]) {
    expect(contrastRatio(colors[foreground] ?? "", surface)).toBeGreaterThanOrEqual(4.5);
  }
  expect(
    contrastRatio(colors["--hostdeck-focus"] ?? "", colors["--hostdeck-canvas"] ?? "")
  ).toBeGreaterThanOrEqual(3);
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
}

function relativeLuminance(color: string): number {
  if (!/^#[0-9a-f]{6}$/iu.test(color)) {
    throw new TypeError(`Expected a six-digit hex color, received ${color}.`);
  }
  const channels = [1, 3, 5].map((offset) =>
    Number.parseInt(color.slice(offset, offset + 2), 16) / 255
  );
  const [red = 0, green = 0, blue = 0] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

async function expectCleanBrowser(
  page: Page,
  diagnostics: ReturnType<typeof observePage>,
  expectedBrowserNetworkErrors = 0
): Promise<void> {
  expect(diagnostics.externalRequests).toEqual([]);
  expect(diagnostics.consoleErrors).toHaveLength(expectedBrowserNetworkErrors);
  for (const error of diagnostics.consoleErrors) {
    expect(error).toMatch(/^Failed to load resource: the server responded with a status of 503/u);
    expect(error).not.toContain("HostDeck is temporarily unavailable");
  }
  expect(diagnostics.pageErrors).toEqual([]);
  await expect
    .poll(() => page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })))
    .toEqual({ local: 0, session: 0 });
}
