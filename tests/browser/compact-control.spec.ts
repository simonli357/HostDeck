import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page, type Request, test } from "@playwright/test";
import { compactStartRequestSchema } from "../../packages/contracts/src/index.js";
import {
  type CompactProgressVariant,
  installCompactControlApi
} from "./compact-control-fixture.js";
import { sessionDetailBrowserSessionId } from "./session-detail-fixture.js";

const artifactDirectory = resolve("artifacts/fe-v1-029-confirmed-compact-utility");
const detailPath = `/sessions/${sessionDetailBrowserSessionId}`;
const visualReviewTime = new Date("2026-07-27T16:00:00.000Z");

test.beforeAll(async () => {
  await mkdir(artifactDirectory, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(visualReviewTime);
});

test("discovers Compact without prefetch and proves its explicit lifecycle", async ({ page }) => {
  const diagnostics = observePage(page);
  const api = await installCompactControlApi(page);
  await page.goto(detailPath);

  const more = page.getByRole("button", {
    name: "More session utilities for android-release"
  });
  await expect(more).toBeVisible();
  await expect(page.getByRole("button", { name: "/model for android-release" })).toBeVisible();
  await expect(page.getByRole("button", { name: "/goal for android-release" })).toBeVisible();
  await expect(page.getByRole("button", { name: "/plan for android-release" })).toBeVisible();
  expect(api.readRequests()).toHaveLength(0);
  expect(api.startRequests()).toHaveLength(0);
  await expectDockGeometry(page);

  await more.click();
  const menu = page.getByRole("dialog", { name: "Session utilities" });
  await expect(menu).toBeVisible();
  await expect(menu.locator(".hostdeck-utility-menu__item strong")).toHaveText([
    "/usage",
    "/compact"
  ]);
  await expect(menu.getByText("/skills", { exact: true })).toHaveCount(0);
  expect(api.readRequests()).toHaveLength(0);
  await page.screenshot({
    path: resolve(artifactDirectory, "utility-menu-390x844.png"),
    animations: "disabled"
  });

  await menu.getByRole("button", { name: /compact/iu }).click();
  const compact = page.getByRole("dialog", { name: "/compact" });
  await expect(compact).toBeVisible();
  await expect(compact.getByText("Target: android-release", { exact: true })).toBeVisible();
  await expect(compact.getByText("No tracked compaction", { exact: true }).first()).toBeVisible();
  await expect(compact.getByText("Confirmation required", { exact: true })).toBeVisible();
  await expect(compact.getByRole("button", { name: "Back to session utilities" })).toBeFocused();
  expect(api.readRequests()).toHaveLength(1);
  expectCompactRequest(requiredRequest(api.readRequests(), 0), "GET");
  expect(requiredRequest(api.readRequests(), 0).postData()).toBeNull();
  expect(requiredRequest(api.readRequests(), 0).headers()["x-hostdeck-csrf"]).toBeUndefined();
  expect(requiredRequest(api.readRequests(), 0).headers()["x-hostdeck-csrf-generation"])
    .toBeUndefined();
  await page.screenshot({
    path: resolve(artifactDirectory, "ready-390x844.png"),
    animations: "disabled"
  });

  await compact.getByRole("button", { name: "Compact context" }).click();
  const confirmation = compact.getByRole("heading", { name: "Confirm context compaction" });
  await expect(confirmation).toBeFocused();
  await expect(compact.getByText(/Acceptance does not prove completion/iu)).toBeVisible();
  await expect(compact.getByText(/does not archive or delete/iu)).toBeVisible();
  expect(api.startRequests()).toHaveLength(0);
  await page.screenshot({
    path: resolve(artifactDirectory, "confirmation-390x844.png"),
    animations: "disabled"
  });

  await compact.getByRole("button", { name: "Confirm compact" }).click();
  await expect(compact.getByText("Compaction accepted", { exact: true })).toBeVisible();
  await expect(compact.getByText("Acceptance only", { exact: true })).toBeVisible();
  await expect(compact.getByText("Compaction completed", { exact: true })).toHaveCount(0);
  expect(api.startRequests()).toHaveLength(1);
  const start = requiredRequest(api.startRequests(), 0);
  expectCompactRequest(start, "POST");
  const body = compactStartRequestSchema.parse(start.postDataJSON());
  expect(body).toEqual({
    operation_id: expect.stringMatching(/^op_browser_compact_[0-9a-f]{32}$/u),
    kind: "compact",
    confirm: true
  });
  expect(Object.keys(body)).toEqual(["operation_id", "kind", "confirm"]);
  expect(start.headers()["x-hostdeck-csrf"]).toBe("D".repeat(43));
  expect(start.headers()["x-hostdeck-csrf-generation"]).toBe("1");
  await page.waitForTimeout(150);
  expect(api.readRequests()).toHaveLength(1);
  expect(api.startRequests()).toHaveLength(1);
  await page.screenshot({
    path: resolve(artifactDirectory, "accepted-390x844.png"),
    animations: "disabled"
  });

  api.setProgressVariant("running");
  await compact.getByRole("button", { name: "Check Compact progress" }).click();
  await expect(compact.getByText("Compacting context", { exact: true })).toBeVisible();
  await expect(compact.getByText("Compaction evidence active", { exact: true })).toBeVisible();
  expect(api.readRequests()).toHaveLength(2);
  await page.screenshot({
    path: resolve(artifactDirectory, "running-390x844.png"),
    animations: "disabled"
  });

  api.setProgressVariant("completed");
  await compact.getByRole("button", { name: "Check Compact progress" }).click();
  await expect(compact.getByText("Compaction completed", { exact: true })).toBeVisible();
  await expect(compact.getByText("Completion proven", { exact: true })).toBeVisible();
  await expect(compact.getByRole("button", { name: "Compact again" })).toBeEnabled();
  expect(api.readRequests()).toHaveLength(3);
  expect(api.startRequests()).toHaveLength(1);
  await page.screenshot({
    path: resolve(artifactDirectory, "completed-390x844.png"),
    animations: "disabled"
  });

  await compact.getByRole("button", { name: "Back to session utilities" }).click();
  await expect(menu.getByRole("button", { name: /compact/iu })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(more).toBeFocused();
  await expectCleanBrowser(diagnostics);
});

test("owns one submitted POST and latches uncertain or conflicting outcomes", async ({ page }) => {
  const diagnostics = observePage(page);
  const api = await installCompactControlApi(page);
  api.setStartOutcome("pending");
  await page.goto(detailPath);
  const compact = await openCompact(page);
  await beginAndConfirm(compact);

  await expect(compact.getByText("Submitting compaction", { exact: true })).toBeVisible();
  await expect.poll(() => api.hasPendingStart()).toBe(true);
  await expect(compact.getByRole("button", { name: "Back to session utilities" })).toBeDisabled();
  await expect(compact.getByRole("button", { name: "Close Compact utility" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(compact).toBeVisible();
  await page.locator(".hostdeck-sheet-overlay").click({ position: { x: 4, y: 4 } });
  await expect(compact).toBeVisible();
  await page.setViewportSize({ width: 390, height: 843 });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(api.startRequests()).toHaveLength(1);
  await page.screenshot({
    path: resolve(artifactDirectory, "submitting-390x844.png"),
    animations: "disabled"
  });

  api.releaseStart("unknown");
  await expect(compact.getByText("Compaction outcome unknown", { exact: true })).toBeVisible();
  await expect(compact.getByText(/will not resend/iu)).toBeVisible();
  await expect(compact.getByRole("button", { name: "Compact context" })).toHaveCount(0);
  await page.waitForTimeout(150);
  expect(api.readRequests()).toHaveLength(1);
  expect(api.startRequests()).toHaveLength(1);
  await page.screenshot({
    path: resolve(artifactDirectory, "outcome-unknown-390x844.png"),
    animations: "disabled"
  });

  api.setProgressVariant("absent");
  await compact.getByRole("button", { name: "Check Compact progress" }).click();
  await expect(compact.getByRole("button", { name: "Compact context" })).toBeEnabled();
  api.setStartOutcome("conflict");
  await beginAndConfirm(compact);
  await expect(compact.getByText("Compaction conflicts with current state", { exact: true }))
    .toBeVisible();
  expect(api.startRequests()).toHaveLength(2);
  await page.screenshot({
    path: resolve(artifactDirectory, "conflict-390x844.png"),
    animations: "disabled"
  });

  await compact.getByRole("button", { name: "Check Compact progress" }).click();
  api.setStartOutcome("known_failure");
  await beginAndConfirm(compact);
  await expect(compact.getByText("Compaction was not started", { exact: true })).toBeVisible();
  expect(api.startRequests()).toHaveLength(3);
  await page.screenshot({
    path: resolve(artifactDirectory, "known-start-failure-390x844.png"),
    animations: "disabled"
  });

  await compact.getByRole("button", { name: "Check Compact progress" }).click();
  api.setStartOutcome("malformed");
  await beginAndConfirm(compact);
  await expect(compact.getByText("Compaction outcome unknown", { exact: true })).toBeVisible();
  expect(api.startRequests()).toHaveLength(4);
  await expect(compact).not.toContainText("Private Compact fixture detail");
  await expectBoundedBrowser(diagnostics, /400|409|504/u);
});

test("renders every process-live, stale, unsupported, and read-failure state", async ({ page }) => {
  const diagnostics = observePage(page);
  const api = await installCompactControlApi(page);
  api.setReadOutcome("pending");
  await page.goto(detailPath);
  let compact = await openCompact(page, false);
  await expect(compact.getByText("Loading Compact progress", { exact: true })).toBeVisible();
  await expect.poll(() => api.hasPendingRead()).toBe(true);
  await page.screenshot({
    path: resolve(artifactDirectory, "loading-390x844.png"),
    animations: "disabled"
  });
  api.releaseRead();
  await expect(compact.getByText("No tracked compaction", { exact: true }).first()).toBeVisible();

  const states: readonly Readonly<{
    artifact: string;
    expected: string;
    restart: "enabled" | "disabled" | "absent";
    variant: CompactProgressVariant;
  }>[] = [
    { variant: "accepted", expected: "Compaction accepted", restart: "absent", artifact: "state-accepted-390x844.png" },
    { variant: "running", expected: "Compacting context", restart: "absent", artifact: "state-running-390x844.png" },
    { variant: "completed", expected: "Compaction completed", restart: "enabled", artifact: "state-completed-390x844.png" },
    { variant: "interrupted", expected: "Compaction interrupted", restart: "enabled", artifact: "state-interrupted-390x844.png" },
    { variant: "failed_retryable", expected: "Compaction failed", restart: "enabled", artifact: "state-failed-retryable-390x844.png" },
    { variant: "failed_terminal", expected: "Compaction failed", restart: "absent", artifact: "state-failed-terminal-390x844.png" },
    { variant: "incomplete", expected: "Compaction outcome incomplete", restart: "absent", artifact: "state-incomplete-390x844.png" }
  ];
  for (const state of states) {
    await closeCompact(page);
    api.setProgressVariant(state.variant);
    compact = await openCompact(page);
    await expect(compact.getByText(state.expected, { exact: true })).toBeVisible();
    const restart = compact.getByRole("button", { name: "Compact again" });
    if (state.restart === "enabled") await expect(restart).toBeEnabled();
    else if (state.restart === "disabled") await expect(restart).toBeDisabled();
    else await expect(restart).toHaveCount(0);
    await page.screenshot({
      path: resolve(artifactDirectory, state.artifact),
      animations: "disabled"
    });
  }

  await page.locator(".hostdeck-detail-context__refresh").evaluate((button) => {
    (button as HTMLButtonElement).click();
  });
  await expect(compact.getByText("Compact progress is stale", { exact: true })).toBeVisible();
  await page.screenshot({
    path: resolve(artifactDirectory, "stale-390x844.png"),
    animations: "disabled"
  });

  await closeCompact(page);
  api.setReadOutcome("unsupported");
  compact = await openCompact(page, false);
  await expect(compact.getByText("Structured Compact unsupported", { exact: true })).toBeVisible();
  await expect(compact.getByRole("button", { name: "Check Compact progress" })).toBeDisabled();
  await page.screenshot({
    path: resolve(artifactDirectory, "unsupported-390x844.png"),
    animations: "disabled"
  });

  await closeCompact(page);
  api.setReadOutcome("malformed");
  compact = await openCompact(page, false);
  await expect(compact.getByText("Compact progress could not be loaded", { exact: true }))
    .toBeVisible();
  await expect(compact).not.toContainText("private_extension");
  await page.screenshot({
    path: resolve(artifactDirectory, "malformed-read-390x844.png"),
    animations: "disabled"
  });
  await expectBoundedBrowser(diagnostics, /409/u);
});

test("separates read visibility from lock, write, and turn authority", async ({ page }) => {
  const diagnostics = observePage(page);
  const api = await installCompactControlApi(page, { sessionVariant: "read_only" });
  await page.goto(detailPath);

  for (const state of [
    {
      variant: "read_only" as const,
      reason: "Read-only access can inspect progress but cannot start compaction.",
      artifact: "read-only-390x844.png"
    },
    {
      variant: "locked" as const,
      reason: "Remote writes are locked on the laptop.",
      artifact: "locked-390x844.png"
    },
    {
      variant: "active" as const,
      reason: "Resolve the pending approval before compacting context.",
      artifact: "active-turn-390x844.png"
    },
    {
      variant: "waiting_input" as const,
      reason: "Respond to the waiting turn before compacting context.",
      artifact: "waiting-input-390x844.png"
    },
    {
      variant: "turn_unknown" as const,
      reason: "Turn state is not proven idle or terminal. Refresh before compacting context.",
      artifact: "unknown-turn-390x844.png"
    }
  ]) {
    api.setSessionVariant(state.variant);
    if (state.variant !== "read_only") await page.reload();
    const compact = await openCompact(page);
    await expect(compact.getByText(state.reason, { exact: true })).toBeVisible();
    await expect(compact.getByRole("button", { name: "Compact context" })).toBeDisabled();
    expect(api.startRequests()).toHaveLength(0);
    await page.screenshot({
      path: resolve(artifactDirectory, state.artifact),
      animations: "disabled"
    });
    await closeCompact(page);
  }

  api.setSessionVariant("stale_session");
  await page.reload();
  await page.getByRole("button", { name: /More session utilities/ }).click();
  const staleRow = page.getByRole("dialog", { name: "Session utilities" })
    .getByRole("button", { name: /compact/iu });
  await expect(staleRow).toBeDisabled();
  await expect(staleRow).toContainText(
    "Session state is stale. Refresh Session Detail before loading Compact progress."
  );
  await page.screenshot({
    path: resolve(artifactDirectory, "stale-session-row-390x844.png"),
    animations: "disabled"
  });
  await page.keyboard.press("Escape");

  api.setSessionVariant("writable");
  await page.reload();
  const compact = await openCompact(page);
  await expect(compact.getByText("No tracked compaction", { exact: true }).first()).toBeVisible();
  api.setSessionVariant("denied");
  await page.locator(".hostdeck-detail-context__refresh").evaluate((button) => {
    (button as HTMLButtonElement).click();
  });
  await expect(compact).toBeHidden();
  await expect(page.getByText("Device access was revoked", { exact: true })).toBeVisible();
  await expect(page.getByText("No tracked compaction", { exact: true })).toHaveCount(0);
  await expectCleanBrowser(diagnostics);
});

test("contains long Compact content across responsive, short, and 200 percent views", async ({ page }) => {
  const diagnostics = observePage(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const api = await installCompactControlApi(page, {
    sessionVariant: "writable_long",
    progressVariant: "failed_retryable"
  });
  await page.goto(detailPath);
  const target = "android-release-validation-long-session-name-2026";
  const compact = await openCompact(page, true, target);
  await expect(compact.getByText("Compaction failed", { exact: true })).toBeVisible();
  await expect(compact.getByRole("button", { name: "Compact again" })).toBeEnabled();

  const measurements = [];
  for (const viewport of [
    { width: 320, height: 800 },
    { width: 360, height: 800 },
    { width: 390, height: 844 },
    { width: 412, height: 915 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 },
    { width: 390, height: 420 }
  ]) {
    await page.setViewportSize(viewport);
    measurements.push({ viewport, sheet: await expectCompactGeometry(page) });
    await page.screenshot({
      path: resolve(artifactDirectory, `responsive-${viewport.width}x${viewport.height}.png`),
      animations: "disabled"
    });
  }

  await page.setViewportSize({ width: 320, height: 800 });
  await compact.getByRole("button", { name: "Compact again" }).click();
  await expect(compact.getByRole("heading", { name: "Confirm context compaction" })).toBeFocused();
  measurements.push({
    viewport: { width: 320, height: 800, state: "confirmation" },
    sheet: await expectCompactGeometry(page)
  });
  await page.screenshot({
    path: resolve(artifactDirectory, "long-confirmation-320x800.png"),
    animations: "disabled"
  });
  await compact.getByRole("button", { name: "Cancel" }).click();

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
    viewport: {
      width: 1280,
      height: 800,
      effectiveWidth: 640,
      effectiveHeight: 400,
      zoom: 2
    },
    sheet: await expectCompactGeometry(page)
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
    compact: document.querySelector(".hostdeck-compact-sheet__body")?.textContent ?? "",
    historyState: JSON.stringify(history.state),
    localStorage: Object.keys(localStorage),
    sessionStorage: Object.keys(sessionStorage),
    url: window.location.href
  }));
  expect(privacy.body).not.toMatch(
    /thread-private|turn-private|op_browser|D{43}|Private Compact|\/workspace\//iu
  );
  expect(privacy.compact).not.toMatch(
    /device|account|cookie|csrf|billing|monetary|prompt|token|runtime_unavailable/iu
  );
  expect(privacy.historyState).not.toMatch(
    /thread-private|turn-private|op_browser|D{43}|\/workspace\//iu
  );
  expect(privacy.localStorage).toEqual([]);
  expect(privacy.sessionStorage).toEqual([]);
  expect(privacy.url).toBe(`http://127.0.0.1:4175${detailPath}`);
  expect(api.startRequests()).toHaveLength(0);
  await expectCleanBrowser(diagnostics);
});

async function openCompact(
  page: Page,
  waitForSettled = true,
  target = "android-release"
) {
  await page.getByRole("button", { name: `More session utilities for ${target}` }).click();
  const menu = page.getByRole("dialog", { name: "Session utilities" });
  await expect(menu).toBeVisible();
  await menu.getByRole("button", { name: /compact/iu }).click();
  const compact = page.getByRole("dialog", { name: "/compact" });
  await expect(compact).toBeVisible();
  if (waitForSettled) {
    await expect(compact.getByText("Loading Compact progress", { exact: true })).toHaveCount(0);
  }
  return compact;
}

async function closeCompact(page: Page): Promise<void> {
  const compact = page.getByRole("dialog", { name: "/compact" });
  await page.keyboard.press("Escape");
  await expect(compact).toBeHidden();
}

async function beginAndConfirm(compact: ReturnType<Page["getByRole"]>): Promise<void> {
  const start = compact.getByRole("button", { name: /Compact (?:context|again)/u });
  await expect(start).toBeEnabled();
  await start.click();
  await compact.getByRole("button", { name: "Confirm compact" }).click();
}

function requiredRequest(requests: readonly Request[], index: number): Request {
  const request = requests[index];
  if (request === undefined) throw new TypeError("Expected Compact request is missing.");
  return request;
}

function expectCompactRequest(request: Request, method: "GET" | "POST"): void {
  expect(request.method()).toBe(method);
  expect(new URL(request.url())).toMatchObject({
    origin: "http://127.0.0.1:4175",
    pathname: `/api/v1/sessions/${sessionDetailBrowserSessionId}/compact`,
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

async function expectCleanBrowser(diagnostics: ReturnType<typeof observePage>): Promise<void> {
  expect(diagnostics.externalRequests).toEqual([]);
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
}

async function expectBoundedBrowser(
  diagnostics: ReturnType<typeof observePage>,
  expectedStatus: RegExp
): Promise<void> {
  expect(diagnostics.externalRequests).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
  expect(diagnostics.consoleErrors.length).toBeGreaterThan(0);
  for (const error of diagnostics.consoleErrors) expect(error).toMatch(expectedStatus);
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
    const dock = document.querySelector(".hostdeck-primary-action-dock");
    const commands = [...document.querySelectorAll(".hostdeck-primary-action-dock__command")];
    if (
      !(dock instanceof HTMLElement) ||
      commands.some((command) => !(command instanceof HTMLElement))
    ) {
      throw new TypeError("Compact dock geometry is unavailable.");
    }
    return {
      dock: dock.getBoundingClientRect().toJSON(),
      commands: commands.map((command) =>
        (command as HTMLElement).getBoundingClientRect().toJSON()
      )
    };
  });
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

async function expectCompactGeometry(page: Page) {
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
    const body = document.querySelector(".hostdeck-compact-sheet__body");
    const scroller = document.querySelector(".hostdeck-compact-sheet__scroller");
    const footer = document.querySelector(".hostdeck-compact-footer");
    const back = document.querySelector('[aria-label="Back to session utilities"]');
    const close = document.querySelector('[aria-label="Close Compact utility"]');
    const check = document.querySelector('[aria-label="Check Compact progress"]');
    if (
      !(dialog instanceof HTMLElement) ||
      !(body instanceof HTMLElement) ||
      !(scroller instanceof HTMLElement) ||
      !(footer instanceof HTMLElement) ||
      !(back instanceof HTMLElement) ||
      !(close instanceof HTMLElement) ||
      !(check instanceof HTMLElement)
    ) {
      throw new TypeError("Compact sheet geometry is unavailable.");
    }
    const textOverflow = [...dialog.querySelectorAll("strong, small, h2, p, span")]
      .filter((element): element is HTMLElement => element instanceof HTMLElement)
      .some((element) => element.scrollWidth > element.clientWidth + 1);
    const scrollOwners = [dialog, body, scroller].filter((element) => {
      const overflow = getComputedStyle(element).overflowY;
      return ["auto", "scroll"].includes(overflow) &&
        element.scrollHeight > element.clientHeight + 1;
    }).length;
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      dialog: measure(dialog),
      body: measure(body),
      scroller: {
        ...measure(scroller),
        clientHeight: scroller.clientHeight,
        scrollHeight: scroller.scrollHeight
      },
      footer: measure(footer),
      back: measure(back),
      close: measure(close),
      check: measure(check),
      textOverflow,
      scrollOwners
    };
  });
  expect(measurement.dialog.left).toBeGreaterThanOrEqual(0);
  expect(measurement.dialog.right).toBeLessThanOrEqual(measurement.viewport.width + 1);
  expect(measurement.dialog.top).toBeGreaterThanOrEqual(0);
  expect(measurement.dialog.bottom).toBeLessThanOrEqual(measurement.viewport.height + 1);
  expect(measurement.scroller.bottom).toBeLessThanOrEqual(measurement.footer.top + 1);
  expect(measurement.footer.bottom).toBeLessThanOrEqual(measurement.body.bottom + 1);
  for (const control of [measurement.back, measurement.close, measurement.check]) {
    expect(control.width).toBeGreaterThanOrEqual(44);
    expect(control.height).toBeGreaterThanOrEqual(44);
  }
  expect(measurement.textOverflow).toBe(false);
  expect(measurement.scrollOwners).toBeLessThanOrEqual(1);
  return measurement;
}
