import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page, type Request, test } from "@playwright/test";
import { sessionDetailBrowserSessionId } from "./session-detail-fixture.js";
import { installUsageControlApi } from "./usage-control-fixture.js";

const artifactDirectory = resolve("artifacts/fe-v1-028-read-only-usage-utility");
const detailPath = `/sessions/${sessionDetailBrowserSessionId}`;
const visualReviewTime = new Date("2026-07-27T16:00:00.000Z");

test.beforeAll(async () => {
  await mkdir(artifactDirectory, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(visualReviewTime);
});

test("discovers Usage through More without prefetch and performs one exact read", async ({ page }) => {
  const diagnostics = observePage(page);
  const api = await installUsageControlApi(page);
  await page.goto(detailPath);

  const more = page.getByRole("button", {
    name: "More session utilities for android-release"
  });
  await expect(page.getByRole("button", { name: "/model for android-release" })).toBeVisible();
  await expect(page.getByRole("button", { name: "/goal for android-release" })).toBeVisible();
  await expect(page.getByRole("button", { name: "/plan for android-release" })).toBeVisible();
  await expect(more).toBeVisible();
  expect(api.requests()).toHaveLength(0);
  await expectDockGeometry(page);

  await more.focus();
  await page.keyboard.press("Enter");
  const utilities = page.getByRole("dialog", { name: "Session utilities" });
  await expect(utilities).toBeVisible();
  await expect(utilities.getByText("Target: android-release", { exact: true })).toBeVisible();
  await expect(utilities.getByRole("button", { name: /usage/iu })).toBeVisible();
  await expect(utilities.getByRole("button", { name: /compact/iu })).toBeVisible();
  await expect(utilities.locator(".hostdeck-utility-menu__item strong")).toHaveText([
    "/usage",
    "/compact",
    "/skills"
  ]);
  expect(api.requests()).toHaveLength(0);
  await page.screenshot({
    path: resolve(artifactDirectory, "utility-menu-390x844.png"),
    animations: "disabled"
  });

  await utilities.getByRole("button", { name: /usage/iu }).click();
  const usage = page.getByRole("dialog", { name: "/usage" });
  await expect(usage.getByText("Usage capture current", { exact: true })).toBeVisible();
  await expect(usage.getByRole("heading", { name: "Account" })).toBeVisible();
  await expect(usage.getByRole("heading", { name: "This thread" })).toBeVisible();
  await expect(usage.getByRole("heading", { name: "Rate limits" })).toBeVisible();
  await expect
    .poll(() => usage.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);
  expect(api.requests()).toHaveLength(1);
  expectUsageRequest(requiredRequest(api.requests(), 0));
  expect(requiredRequest(api.requests(), 0).postData()).toBeNull();
  expect(requiredRequest(api.requests(), 0).headers()["x-hostdeck-csrf"]).toBeUndefined();
  expect(requiredRequest(api.requests(), 0).headers()["x-hostdeck-csrf-generation"]).toBeUndefined();
  await expect(page.locator('[role="dialog"]')).toHaveCount(1);
  await page.screenshot({
    path: resolve(artifactDirectory, "content-390x844.png"),
    animations: "disabled"
  });

  await usage.getByRole("button", { name: "Back to session utilities" }).click();
  await expect(utilities).toBeVisible();
  await expect(utilities.getByRole("button", { name: /usage/iu })).toBeFocused();
  expect(api.requests()).toHaveLength(1);
  await page.keyboard.press("Escape");
  await expect(utilities).toBeHidden();
  await expect(more).toBeFocused();

  await more.press("Enter");
  await expect(utilities).toBeVisible();
  await utilities.getByRole("button", { name: "Close session utilities" }).click();
  await expect(utilities).toBeHidden();
  await expect(more).toBeFocused();

  await more.press("Enter");
  await expect(utilities).toBeVisible();
  await page.locator(".hostdeck-sheet-overlay").click({ position: { x: 4, y: 4 } });
  await expect(utilities).toBeHidden();
  await expect(more).toBeFocused();
  expect(api.requests()).toHaveLength(1);
  await expectCleanBrowser(diagnostics);
});

test("owns loading, one in-flight read, stale capture, and explicit refresh", async ({ page }) => {
  const diagnostics = observePage(page);
  const api = await installUsageControlApi(page);
  api.setReadOutcome("pending");
  await page.goto(detailPath);
  await openUsage(page);
  const usage = page.getByRole("dialog", { name: "/usage" });
  await expect(usage.getByText("Loading usage", { exact: true })).toBeVisible();
  await expect.poll(() => api.hasPendingRead()).toBe(true);
  const loadingRefresh = usage.getByRole("button", { name: "Refresh structured usage" });
  await expect(loadingRefresh).toBeDisabled();
  await loadingRefresh.evaluate((button) => (button as HTMLButtonElement).click());
  await page.setViewportSize({ width: 390, height: 843 });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(api.requests()).toHaveLength(1);
  await page.screenshot({
    path: resolve(artifactDirectory, "loading-390x844.png"),
    animations: "disabled"
  });

  api.releaseRead();
  await expect(usage.getByText("Usage capture current", { exact: true })).toBeVisible();
  await page.locator(".hostdeck-detail-context__refresh").evaluate((button) => {
    (button as HTMLButtonElement).click();
  });
  await expect(usage.getByText("Usage capture is stale", { exact: true })).toBeVisible();
  await expect(usage.getByText("1,000", { exact: true }).first()).toBeVisible();
  await page.screenshot({
    path: resolve(artifactDirectory, "stale-390x844.png"),
    animations: "disabled"
  });

  api.setReadOutcome("pending");
  const refresh = usage.getByRole("button", { name: "Refresh structured usage" });
  await refresh.click();
  await expect(usage.getByText("Refreshing usage", { exact: true })).toBeVisible();
  await expect(refresh).toBeDisabled();
  await refresh.evaluate((button) => (button as HTMLButtonElement).click());
  expect(api.requests()).toHaveLength(2);
  api.setSnapshotVariant("reached");
  api.releaseRead();
  await expect(usage.getByText("Usage capture current", { exact: true })).toBeVisible();
  await expect(usage.getByText("Workspace member usage limit reached", { exact: true })).toBeVisible();
  expect(api.requests()).toHaveLength(2);
  await expectCleanBrowser(diagnostics);
});

test("renders the complete empty, null, reset, limit, unsupported, and failure matrix", async ({ page }) => {
  const diagnostics = observePage(page);
  const api = await installUsageControlApi(page, { snapshotVariant: "empty" });
  await page.goto(detailPath);

  await captureUsageState(page, "No usage observations reported", "empty-390x844.png");
  let usage = page.getByRole("dialog", { name: "/usage" });
  await expect(usage.getByText("Daily history not reported.", { exact: true })).toBeVisible();
  await expect(usage.getByText("Thread usage not observed.", { exact: true })).toBeVisible();
  await expect(usage.getByText("Rate limits not observed.", { exact: true })).toBeVisible();

  await closeUsage(page);
  api.setSnapshotVariant("explicit_empty_zero");
  await captureUsageState(page, "Usage capture current", "explicit-empty-zero-390x844.png");
  usage = page.getByRole("dialog", { name: "/usage" });
  await expect(usage.getByText("No daily buckets reported.", { exact: true })).toBeVisible();
  await expect(usage.getByText("0", { exact: true }).first()).toBeVisible();

  await closeUsage(page);
  api.setSnapshotVariant("null_observations");
  await captureUsageState(page, "Usage capture current", "null-observations-390x844.png");
  usage = page.getByRole("dialog", { name: "/usage" });
  await expect(usage.getByRole("heading", { name: "Primary" }).locator("..").getByText("Not reported", { exact: true })).toBeVisible();
  await expect(usage.getByRole("heading", { name: "Secondary" }).locator("..").getByText("Not reported", { exact: true })).toBeVisible();
  await expect(usage).not.toContainText("Unlimited");

  await closeUsage(page);
  api.setSnapshotVariant("compaction");
  await captureUsageState(page, "Usage capture current", "compaction-reset-390x844.png");
  usage = page.getByRole("dialog", { name: "/usage" });
  const cumulative = usage.getByRole("heading", { name: "Cumulative" }).locator("..");
  const last = usage.getByRole("heading", { name: "Last update" }).locator("..");
  await expect(cumulative.getByText("10", { exact: true }).first()).toBeVisible();
  await expect(last.getByText("20", { exact: true }).first()).toBeVisible();
  await expect(usage).not.toContainText("Remaining");

  await closeUsage(page);
  api.setSnapshotVariant("reached");
  await captureUsageState(page, "Workspace member usage limit reached", "limit-reached-390x844.png");
  await expect(page.getByRole("dialog", { name: "/usage" })).not.toContainText(
    "workspace_member_usage_limit_reached"
  );

  await closeUsage(page);
  api.setReadOutcome("unsupported");
  await captureUsageState(page, "Structured usage unsupported", "unsupported-390x844.png");
  await expect(page.getByRole("button", { name: "Refresh structured usage" })).toBeDisabled();

  await closeUsage(page);
  api.setReadOutcome("known_failure");
  await captureUsageState(page, "Usage could not be loaded", "read-failure-390x844.png");
  await expect(page.getByRole("dialog", { name: "/usage" })).not.toContainText(
    "Private Usage fixture detail"
  );

  await closeUsage(page);
  api.setReadOutcome("malformed");
  await captureUsageState(page, "Usage could not be loaded", "malformed-response-390x844.png");
  await expect(page.getByRole("dialog", { name: "/usage" })).not.toContainText("monetary_cost");
  await expectCleanBrowser(diagnostics, [
    /status of 409 \(Conflict\)/u,
    /status of 503 \(Service Unavailable\)/u
  ]);
});

test("removes usage disclosure when current access is lost", async ({ page }) => {
  const diagnostics = observePage(page);
  const api = await installUsageControlApi(page);
  await page.goto(detailPath);
  await openUsage(page);
  await expect(page.getByText("Usage capture current", { exact: true })).toBeVisible();

  api.setSessionVariant("denied");
  await page.locator(".hostdeck-detail-context__refresh").evaluate((button) => {
    (button as HTMLButtonElement).click();
  });
  await expect(page.getByRole("dialog", { name: "/usage" })).toBeHidden();
  await expect(page.getByText("Device access was revoked", { exact: true })).toBeVisible();
  await expect(page.getByText("Lifetime tokens", { exact: true })).toHaveCount(0);
  await expect(page.getByText("1,000", { exact: true })).toHaveCount(0);
  await expectCleanBrowser(diagnostics);
});

test("contains long usage across mobile, desktop, short-height, and 200 percent zoom", async ({ page }) => {
  const diagnostics = observePage(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installUsageControlApi(page, {
    sessionVariant: "writable_long",
    snapshotVariant: "long"
  });
  await page.goto(detailPath);
  const target = "android-release-validation-long-session-name-2026";
  await expect(
    page.getByRole("button", { name: `More session utilities for ${target}` })
  ).toBeVisible();
  const measurements = [];
  const viewports = [
    { width: 320, height: 800 },
    { width: 360, height: 800 },
    { width: 390, height: 844 },
    { width: 412, height: 915 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 }
  ];

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    measurements.push({ viewport, dock: await expectDockGeometry(page) });
  }

  await page.setViewportSize({ width: 320, height: 800 });
  await openUsage(page, target);
  const usage = page.getByRole("dialog", { name: "/usage" });
  const compactAccount = usage.locator('.hostdeck-usage-summary [title="9,000,000,000,000,000"]');
  await expect(compactAccount.locator('[aria-hidden="true"]')).toHaveText("9000T");
  await expect(compactAccount.locator(".hostdeck-visually-hidden")).toHaveText(
    "9,000,000,000,000,000"
  );
  const compactThread = usage.locator('.hostdeck-usage-summary [title="8,000,000,000,000,000"]');
  await expect(compactThread.locator('[aria-hidden="true"]')).toHaveText("8000T");
  await expect(compactThread.locator(".hostdeck-visually-hidden")).toHaveText(
    "8,000,000,000,000,000"
  );
  await expect(usage.locator('time[datetime="2026-07-03"]')).toHaveAttribute(
    "title",
    "2026-07-03"
  );
  await expect(usage.getByText("2 older buckets omitted.", { exact: true })).toBeVisible();
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    measurements.push({ viewport, sheet: await expectUsageGeometry(page) });
    await page.screenshot({
      path: resolve(artifactDirectory, `long-${viewport.width}x${viewport.height}.png`),
      animations: "disabled"
    });
  }

  await page.setViewportSize({ width: 320, height: 800 });
  const scroller = page.locator(".hostdeck-usage-sheet__scroller");
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.getByRole("heading", { name: "Rate limits" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh structured usage" })).toBeVisible();
  await page.screenshot({
    path: resolve(artifactDirectory, "long-scrolled-320x800.png"),
    animations: "disabled"
  });
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
  });

  await page.setViewportSize({ width: 390, height: 420 });
  measurements.push({
    viewport: { width: 390, height: 420 },
    sheet: await expectUsageGeometry(page)
  });
  await page.screenshot({
    path: resolve(artifactDirectory, "keyboard-height-proxy-390x420.png"),
    animations: "disabled"
  });

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 640,
    height: 400,
    screenWidth: 1280,
    screenHeight: 800,
    deviceScaleFactor: 2,
    mobile: false
  });
  measurements.push({
    viewport: { width: 1280, height: 800, effectiveWidth: 640, effectiveHeight: 400, zoom: 2 },
    sheet: await expectUsageGeometry(page)
  });
  const zoomCapture = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false
  });
  await writeFile(
    resolve(artifactDirectory, "zoom-200-1280x800.png"),
    Buffer.from(zoomCapture.data, "base64")
  );
  await writeFile(
    resolve(artifactDirectory, "layout-measurements.json"),
    `${JSON.stringify({ measurements }, null, 2)}\n`,
    "utf8"
  );

  const privacy = await page.evaluate(() => ({
    body: document.body.textContent ?? "",
    usage: document.querySelector(".hostdeck-usage-sheet")?.textContent ?? "",
    historyState: JSON.stringify(history.state),
    localStorage: Object.keys(localStorage),
    sessionStorage: Object.keys(sessionStorage),
    url: window.location.href
  }));
  expect(privacy.body).not.toMatch(/thread-private|turn-private|monetary|billing/iu);
  expect(privacy.usage).not.toMatch(
    /device_detail_phone|D{43}|op_browser|audit-private|\/workspace\/|Prepare the selected mobile prompt workflow/iu
  );
  expect(privacy.historyState).not.toMatch(
    /device_detail_phone|D{43}|thread-private|turn-private|monetary|billing|\/workspace\//iu
  );
  expect(privacy.localStorage).toEqual([]);
  expect(privacy.sessionStorage).toEqual([]);
  expect(privacy.url).toBe(`http://127.0.0.1:4175${detailPath}`);
  await expectCleanBrowser(diagnostics);
});

async function captureUsageState(
  page: Page,
  visibleText: string,
  artifact: string
): Promise<void> {
  await openUsage(page);
  const usage = page.getByRole("dialog", { name: "/usage" });
  await expect(usage.getByText(visibleText, { exact: true })).toBeVisible();
  await page.screenshot({
    path: resolve(artifactDirectory, artifact),
    animations: "disabled"
  });
}

async function openUsage(page: Page, target = "android-release"): Promise<void> {
  await page.getByRole("button", { name: `More session utilities for ${target}` }).click();
  const utilities = page.getByRole("dialog", { name: "Session utilities" });
  await expect(utilities).toBeVisible();
  await utilities.getByRole("button", { name: /usage/iu }).click();
  await expect(page.getByRole("dialog", { name: "/usage" })).toBeVisible();
}

async function closeUsage(page: Page): Promise<void> {
  const usage = page.getByRole("dialog", { name: "/usage" });
  await page.keyboard.press("Escape");
  await expect(usage).toBeHidden();
}

function requiredRequest(requests: readonly Request[], index: number): Request {
  const request = requests[index];
  if (request === undefined) throw new TypeError("Expected Usage request is missing.");
  return request;
}

function expectUsageRequest(request: Request): void {
  expect(request.method()).toBe("GET");
  expect(new URL(request.url())).toMatchObject({
    origin: "http://127.0.0.1:4175",
    pathname: `/api/v1/sessions/${sessionDetailBrowserSessionId}/usage`,
    search: "",
    hash: ""
  });
}

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

async function expectCleanBrowser(
  diagnostics: ReturnType<typeof observePage>,
  expectedConsoleErrors: readonly RegExp[] = []
): Promise<void> {
  expect(diagnostics.externalRequests).toEqual([]);
  expect(diagnostics.consoleErrors).toHaveLength(expectedConsoleErrors.length);
  for (const [index, pattern] of expectedConsoleErrors.entries()) {
    expect(diagnostics.consoleErrors[index]).toMatch(pattern);
  }
  expect(diagnostics.pageErrors).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  expect(dimensions.scrollWidth).toBe(dimensions.clientWidth);
}

async function expectDockGeometry(page: Page) {
  await expectNoHorizontalOverflow(page);
  const measurement = await page.evaluate(() => {
    const measure = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        height: rect.height
      };
    };
    const controls = document.querySelector(".hostdeck-session-controls");
    const dock = document.querySelector(".hostdeck-primary-action-dock");
    const commands = [...document.querySelectorAll(".hostdeck-primary-action-dock__command")];
    const composer = document.querySelector(".hostdeck-prompt-composer");
    if (
      !(controls instanceof HTMLElement) ||
      !(dock instanceof HTMLElement) ||
      !(composer instanceof HTMLElement) ||
      commands.some((command) => !(command instanceof HTMLElement))
    ) {
      throw new TypeError("Session utility dock geometry is unavailable.");
    }
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      controls: measure(controls),
      dock: measure(dock),
      commands: commands.map((command) => measure(command as HTMLElement)),
      composer: measure(composer)
    };
  });
  expect(measurement.controls.left).toBeGreaterThanOrEqual(0);
  expect(measurement.controls.right).toBeLessThanOrEqual(measurement.viewport.width + 1);
  expect(measurement.controls.bottom).toBeLessThanOrEqual(measurement.viewport.height + 1);
  expect(measurement.dock.bottom).toBeLessThanOrEqual(measurement.composer.top + 1);
  expect(measurement.commands).toHaveLength(4);
  for (const command of measurement.commands) {
    expect(command.width).toBeGreaterThanOrEqual(44);
    expect(command.height).toBeGreaterThanOrEqual(44);
  }
  expect(
    Math.max(...measurement.commands.map((command) => command.width)) -
      Math.min(...measurement.commands.map((command) => command.width))
  ).toBeLessThanOrEqual(1);
  return measurement;
}

async function expectUsageGeometry(page: Page) {
  await expectNoHorizontalOverflow(page);
  const measurement = await page.evaluate(() => {
    const measure = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        height: rect.height
      };
    };
    const dialog = document.querySelector(".hostdeck-usage-sheet");
    const body = document.querySelector(".hostdeck-usage-sheet__body");
    const scroller = document.querySelector(".hostdeck-usage-sheet__scroller");
    const status = document.querySelector(".hostdeck-usage-status");
    const back = document.querySelector('[aria-label="Back to session utilities"]');
    const close = document.querySelector('[aria-label="Close Usage utility"]');
    const refresh = document.querySelector('[aria-label="Refresh structured usage"]');
    const summary = document.querySelector(".hostdeck-usage-summary");
    if (
      !(dialog instanceof HTMLElement) ||
      !(body instanceof HTMLElement) ||
      !(scroller instanceof HTMLElement) ||
      !(status instanceof HTMLElement) ||
      !(back instanceof HTMLElement) ||
      !(close instanceof HTMLElement) ||
      !(refresh instanceof HTMLElement) ||
      !(summary instanceof HTMLElement)
    ) {
      throw new TypeError("Usage sheet geometry is unavailable.");
    }
    const textOverflow = [
      ...dialog.querySelectorAll("strong, small, h2, h3, p, dt, dd, span")
    ]
      .filter((element): element is HTMLElement => element instanceof HTMLElement)
      .filter((element) => !element.classList.contains("hostdeck-visually-hidden"))
      .some((element) => element.scrollWidth > element.clientWidth + 1);
    const scrollOwners = [dialog, body, scroller].filter((element) => {
      const overflow = getComputedStyle(element).overflowY;
      return ["auto", "scroll"].includes(overflow) && element.scrollHeight > element.clientHeight + 1;
    }).length;
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      dialog: measure(dialog),
      body: { ...measure(body), clientHeight: body.clientHeight, scrollHeight: body.scrollHeight },
      scroller: {
        ...measure(scroller),
        clientHeight: scroller.clientHeight,
        scrollHeight: scroller.scrollHeight
      },
      status: measure(status),
      back: measure(back),
      close: measure(close),
      refresh: measure(refresh),
      summary: measure(summary),
      textOverflow,
      scrollOwners
    };
  });
  expect(measurement.dialog.left).toBeGreaterThanOrEqual(0);
  expect(measurement.dialog.right).toBeLessThanOrEqual(measurement.viewport.width + 1);
  expect(measurement.dialog.top).toBeGreaterThanOrEqual(0);
  expect(measurement.dialog.bottom).toBeLessThanOrEqual(measurement.viewport.height + 1);
  for (const control of [measurement.back, measurement.close, measurement.refresh]) {
    expect(control.width).toBeGreaterThanOrEqual(44);
    expect(control.height).toBeGreaterThanOrEqual(44);
  }
  expect(measurement.summary.left).toBeGreaterThanOrEqual(measurement.dialog.left);
  expect(measurement.summary.right).toBeLessThanOrEqual(measurement.dialog.right);
  expect(measurement.scroller.bottom).toBeLessThanOrEqual(measurement.status.top + 1);
  expect(measurement.status.bottom).toBeLessThanOrEqual(measurement.body.bottom + 1);
  expect(measurement.textOverflow).toBe(false);
  expect(measurement.scrollOwners).toBeLessThanOrEqual(1);
  return measurement;
}
