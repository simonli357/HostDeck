import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Locator, type Page, type Request, test } from "@playwright/test";
import {
  type ArchiveApiOutcome,
  installArchiveApi
} from "./archive-control-fixture.js";
import {
  installSessionDetailApi,
  promptTurnEvent,
  type SessionDetailApiVariant,
  sessionDetailBrowserSessionId
} from "./session-detail-fixture.js";

const artifactDirectory = resolve("artifacts/fe-v1-037-managed-thread-archive");
const detailPath = `/sessions/${sessionDetailBrowserSessionId}`;
const visualReviewTime = new Date("2026-07-27T22:00:00.000Z");

test.beforeAll(async () => {
  await mkdir(artifactDirectory, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(visualReviewTime);
});

test("keeps one ordered mobile Session actions sheet with idle archive and Host access", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const fixture = await openReadyArchive(page);
  const trigger = page.locator('button[aria-label="Open session actions"]');
  await expect(trigger).toHaveCSS("width", "44px");
  await expect(trigger).toHaveCSS("height", "44px");
  await expect(page.getByRole("button", { name: "Open Host and access" })).toHaveCount(0);

  const dialog = actionsDialog(page, "Session actions");
  await expect(dialog.locator(".hostdeck-utility-menu__item strong")).toHaveText([
    "Interrupt active turn",
    "Archive session",
    "Resume on laptop",
    "Host & access"
  ]);
  await expect(interruptAction(dialog)).toBeDisabled();
  await expect(archiveAction(dialog)).toBeEnabled();
  await expect(archiveAction(dialog)).toBeFocused();
  await expect(page.locator('[role="dialog"]')).toHaveCount(1);
  await expect(page.locator(".hostdeck-primary-action-dock__command")).toHaveCount(4);
  expect(fixture.archive.requests()).toHaveLength(0);
  await capture(page, "menu-idle-390x844.png");

  await dialog.getByRole("button", { name: /Host & access/iu }).click();
  const hostDialog = actionsDialog(page, "Host & access");
  await expect(hostDialog.getByRole("heading", { name: "Secure control ready" })).toBeVisible();
  await expect(page.locator('[role="dialog"]')).toHaveCount(1);
  const back = hostDialog.getByRole("button", { name: "Back to session actions" });
  await expect(back).toBeFocused();
  await back.click();
  await expect(archiveAction(dialog)).toBeFocused();
  await capture(page, "menu-returned-390x844.png");
  await expectPrivateDataAbsent(page);
  await expectCleanBrowser(page, diagnostics);
});

test("sends one exact archive, survives subscriber close, and navigates only after success acknowledgement", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const fixture = await openReadyArchive(page, {
    closeStreamBeforeResponse: true,
    outcome: "pending"
  });
  const menu = actionsDialog(page, "Session actions");
  await archiveAction(menu).click();

  const confirmation = actionsDialog(page, "Archive session?");
  await expect(confirmation.locator(".hostdeck-archive-facts dd")).toHaveText([
    "android-release",
    "Idle - no turn will be interrupted",
    "Preserved - not deleted or erased",
    "Not available in HostDeck V1"
  ]);
  await expect(confirmation.getByText("Archive this managed session", { exact: true })).toBeVisible();
  await expect(confirmation.getByText(
    "After laptop confirmation, it leaves active sessions without deleting files or the Codex thread.",
    { exact: true }
  )).toBeVisible();
  await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
  expect(fixture.archive.requests()).toHaveLength(0);
  await capture(page, "confirmation-390x844.png");

  await confirmation.getByRole("button", { name: "Archive session", exact: true }).click();
  await expect.poll(fixture.archive.hasPendingRequest).toBe(true);
  const pending = actionsDialog(page, "Archive session");
  await expect(pending.getByText("Waiting for laptop confirmation", { exact: true }).first())
    .toBeVisible();
  await expect(pending).not.toContainText(/accepted|archived|deleted|retry/iu);
  await expect(pending.getByRole("button", { name: "Close session actions" })).toBeDisabled();
  await expect(pending.getByRole("button", { name: "Waiting for laptop confirmation" }))
    .toBeDisabled();
  expect(fixture.archive.requests()).toHaveLength(1);
  expectArchiveRequest(requiredRequest(fixture.archive.requests(), 0));
  await capture(page, "pending-390x844.png");

  await page.keyboard.press("Escape");
  await expect(pending).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(pending).toBeVisible();
  fixture.archive.release("success");

  const result = actionsDialog(page, "Session archived");
  await expect(result.getByText(
    "The laptop confirmed the Codex thread is archived and HostDeck saved the local archive state.",
    { exact: true }
  )).toBeVisible();
  await expect(result.getByText("Retained conversation history was not deleted.", { exact: true }))
    .toBeVisible();
  await expect(result.getByRole("button", { name: /retry|restore|delete/iu })).toHaveCount(0);
  await expect(result.getByRole("button", { name: "Close session actions" })).toBeDisabled();
  await expect(result.getByRole("button", { name: "Back to sessions" })).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`${detailPath}$`, "u"));
  await capture(page, "result-confirmed-390x844.png");

  const historyLength = await page.evaluate(() => window.history.length);
  fixture.detail.setSessionListEmpty(true);
  await result.getByRole("button", { name: "Back to sessions" }).click();
  await expect(page).toHaveURL(/\/$/u);
  await expect.poll(() => page.evaluate(() => window.history.length)).toBe(historyLength);
  await expect(page.getByRole("heading", { name: "Mission Control" })).toBeVisible();
  await expect(page.getByRole("link", { name: /android-release/iu })).toHaveCount(0);
  await capture(page, "mission-after-confirmed-390x844.png");
  expect(fixture.archive.requests()).toHaveLength(1);
  await expectPrivateDataAbsent(page);
  await expectCleanBrowser(page, diagnostics);
});

for (const resultCase of [
  { outcome: "blocked", label: "Archive blocked", artifact: "blocked" },
  { outcome: "not_completed", label: "Archive not completed", artifact: "not-completed" },
  { outcome: "not_found", label: "Archive not completed", artifact: "not-found" },
  { outcome: "incompatible", label: "Archive not completed", artifact: "incompatible" },
  { outcome: "timeout", label: "Archive outcome not confirmed", artifact: "timeout-unknown" },
  { outcome: "conflict", label: "Archive outcome not confirmed", artifact: "conflict-unknown" },
  { outcome: "storage", label: "Archive outcome not confirmed", artifact: "storage-unknown" },
  { outcome: "malformed", label: "Archive outcome not confirmed", artifact: "malformed-unknown" },
  { outcome: "mismatch", label: "Archive outcome not confirmed", artifact: "mismatch-unknown" }
] as const) {
  test(`keeps ${resultCase.outcome} remote/local truth on Session Detail with no resend`, async ({
    page
  }) => {
    const diagnostics = observePage(page);
    const fixture = await openReadyArchive(page, { outcome: resultCase.outcome });
    await submitArchive(page);

    const result = actionsDialog(page, resultCase.label);
    await expect(result).toBeVisible();
    await expect(result.getByRole("button", { name: /retry|back to sessions/iu })).toHaveCount(0);
    await expect(result.getByRole("button", { name: "Done" })).toBeFocused();
    await expect(page).toHaveURL(new RegExp(`${detailPath}$`, "u"));
    await capture(page, `result-${resultCase.artifact}-390x844.png`);
    await result.getByRole("button", { name: "Done" }).click();
    await expect(page).toHaveURL(new RegExp(`${detailPath}$`, "u"));

    await page.getByRole("button", { name: "Open session actions" }).click();
    const menu = actionsDialog(page, "Session actions");
    await expect(archiveAction(menu)).toBeDisabled();
    await expect(menu.getByText("An archive was already submitted for this session.", {
      exact: true
    })).toBeVisible();
    expect(fixture.archive.requests()).toHaveLength(1);
    await expectPrivateDataAbsent(page);
    await expectCleanBrowser(page, diagnostics, expectedHttpErrors(resultCase.outcome));
  });
}

for (const disabledCase of [
  {
    name: "active-turn",
    variant: "writable",
    turnState: "in_progress",
    reason: "Finish or interrupt the active turn before archiving."
  },
  {
    name: "read-only",
    variant: "read_only",
    turnState: "idle",
    reason: "Read-only access cannot archive a session."
  },
  {
    name: "locked",
    variant: "locked",
    turnState: "idle",
    reason: "Remote writes are locked on the laptop."
  },
  {
    name: "stale",
    variant: "stale_session",
    turnState: "idle",
    reason: "Session state is stale. Refresh Session Detail before archiving."
  }
] as const) {
  test(`keeps ${disabledCase.name} archive truth visible and disabled`, async ({ page }) => {
    const diagnostics = observePage(page);
    const events = disabledCase.turnState === "idle"
      ? []
      : [promptTurnEvent(1, disabledCase.turnState)];
    const fixture = await openReadyArchive(page, {
      events,
      expectEnabled: false,
      turnState: disabledCase.turnState,
      variant: disabledCase.variant
    });
    const dialog = actionsDialog(page, "Session actions");
    await expect(archiveAction(dialog)).toBeDisabled();
    await expect(dialog.getByText(disabledCase.reason, { exact: true })).toBeVisible();
    if (disabledCase.name === "active-turn") {
      await expect(interruptAction(dialog)).toBeEnabled();
      await expect(interruptAction(dialog)).toBeFocused();
    } else if (disabledCase.name === "stale") {
      await expect(dialog.getByRole("button", { name: /Host & access/iu })).toBeFocused();
    } else {
      await expect(dialog.getByRole("button", { name: /Resume on laptop/iu })).toBeFocused();
    }
    expect(fixture.archive.requests()).toHaveLength(0);
    await capture(page, `disabled-${disabledCase.name}-390x844.png`);
    await expectPrivateDataAbsent(page);
    await expectCleanBrowser(page, diagnostics);
  });
}

test("disables archive while the selected session stream is reconnecting", async ({ page }) => {
  const diagnostics = observePage(page);
  const fixture = await openReadyArchive(page, { openMenu: false });
  await fixture.detail.dropStream();
  await expect(page.getByText("Activity stream reconnecting", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open session actions" }).click();

  const dialog = actionsDialog(page, "Session actions");
  await expect(archiveAction(dialog)).toBeDisabled();
  await expect(dialog.getByText(
    "Live session state is reconnecting. Wait before archiving.",
    { exact: true }
  )).toBeVisible();
  await capture(page, "disabled-reconnecting-390x844.png");
  expect(fixture.archive.requests()).toHaveLength(0);
  await expectPrivateDataAbsent(page);
  await expectCleanBrowser(page, diagnostics);
});

test("contains long archive menu and confirmation across responsive, short, and zoom states", async ({
  page
}) => {
  test.setTimeout(45_000);
  const diagnostics = observePage(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openReadyArchive(page, { variant: "writable_long" });
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
    measurements.push({
      state: "menu",
      requestedViewport: viewport,
      geometry: await expectSheetGeometry(page, false)
    });
    await capture(page, `responsive-menu-${viewport.width}x${viewport.height}.png`);
  }

  await archiveAction(actionsDialog(page, "Session actions")).click();
  const confirmation = actionsDialog(page, "Archive session?");
  await expect(confirmation.getByText("android-release-validation-long-session-name-2026", {
    exact: true
  })).toBeVisible();
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    measurements.push({
      state: "confirmation",
      requestedViewport: viewport,
      geometry: await expectSheetGeometry(page, true)
    });
    await capture(page, `responsive-confirmation-${viewport.width}x${viewport.height}.png`);
  }

  await page.setViewportSize({ width: 390, height: 420 });
  measurements.push({
    state: "confirmation-short",
    requestedViewport: { width: 390, height: 420 },
    geometry: await expectSheetGeometry(page, true)
  });
  await capture(page, "short-height-confirmation-390x420.png");
  await scrollConfirmationToEnd(page);
  await capture(page, "short-height-confirmation-scrolled-390x420.png");
  await page.locator(".hostdeck-session-actions__scroller").evaluate((node) => {
    node.scrollTop = 0;
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
    state: "confirmation-zoom-200",
    requestedViewport: {
      width: 1280,
      height: 800,
      effectiveWidth: 640,
      effectiveHeight: 400
    },
    geometry: await expectSheetGeometry(page, true)
  });
  const zoomCapture = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false
  });
  await writeFile(
    resolve(artifactDirectory, "zoom-200-confirmation-1280x800.png"),
    Buffer.from(zoomCapture.data, "base64")
  );
  await scrollConfirmationToEnd(page);
  const zoomScrolledCapture = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false
  });
  await writeFile(
    resolve(artifactDirectory, "zoom-200-confirmation-scrolled-1280x800.png"),
    Buffer.from(zoomScrolledCapture.data, "base64")
  );
  await writeFile(
    resolve(artifactDirectory, "layout-measurements.json"),
    `${JSON.stringify({ measurements }, null, 2)}\n`,
    "utf8"
  );

  await expectPrivateDataAbsent(page);
  await expectCleanBrowser(page, diagnostics);
});

interface OpenReadyArchiveOptions {
  readonly closeStreamBeforeResponse?: boolean;
  readonly events?: readonly ReturnType<typeof promptTurnEvent>[];
  readonly expectEnabled?: boolean;
  readonly openMenu?: boolean;
  readonly outcome?: ArchiveApiOutcome;
  readonly turnState?: "idle" | "in_progress";
  readonly variant?: SessionDetailApiVariant;
}

async function openReadyArchive(
  page: Page,
  options: OpenReadyArchiveOptions = {}
) {
  const turnState = options.turnState ?? "idle";
  const events = options.events ?? (
    turnState === "idle" ? [] : [promptTurnEvent(1, turnState)]
  );
  const detail = await installSessionDetailApi(page, options.variant ?? "writable", {
    initialEvents: events,
    streamEvents: events,
    turnState
  });
  const archive = await installArchiveApi(page);
  archive.setOutcome(options.outcome ?? "success");
  archive.setCloseStreamBeforeResponse(options.closeStreamBeforeResponse === true);
  await page.goto(detailPath);
  const trigger = page.getByRole("button", { name: "Open session actions" });
  await expect(trigger).toBeVisible();
  if (options.openMenu !== false) {
    await trigger.click();
    const action = archiveAction(actionsDialog(page, "Session actions"));
    if (options.expectEnabled === false) await expect(action).toBeDisabled();
    else await expect(action).toBeEnabled();
  }
  return Object.freeze({ archive, detail });
}

async function submitArchive(page: Page): Promise<void> {
  await archiveAction(actionsDialog(page, "Session actions")).click();
  const confirmation = actionsDialog(page, "Archive session?");
  await confirmation.getByRole("button", { name: "Archive session", exact: true }).click();
}

function actionsDialog(page: Page, name: string): Locator {
  return page.getByRole("dialog", { name, exact: true });
}

function archiveAction(dialog: Locator): Locator {
  return dialog.getByRole("button", { name: /Archive session/iu });
}

function interruptAction(dialog: Locator): Locator {
  return dialog.getByRole("button", { name: /Interrupt active turn/iu });
}

function requiredRequest(requests: readonly Request[], index: number): Request {
  const request = requests[index];
  if (request === undefined) throw new TypeError("Expected archive request is missing.");
  return request;
}

function expectArchiveRequest(request: Request): void {
  const url = new URL(request.url());
  expect(request.method()).toBe("POST");
  expect(url).toMatchObject({
    origin: "http://127.0.0.1:4175",
    pathname: `/api/v1/sessions/${sessionDetailBrowserSessionId}/archive`,
    search: "",
    hash: ""
  });
  const body = request.postDataJSON() as Record<string, unknown>;
  expect(Object.keys(body)).toEqual(["operation_id", "kind", "confirm"]);
  expect(body).toEqual({
    operation_id: expect.stringMatching(/^op_browser_archive_[0-9a-f]{32}$/u),
    kind: "archive",
    confirm: true
  });
  expect(JSON.stringify(body)).not.toMatch(/thread|delete|interrupt|force/iu);
  expect(request.headers()["x-hostdeck-csrf"]).toBe("D".repeat(43));
  expect(request.headers()["x-hostdeck-csrf-generation"]).toBe("1");
}

async function expectSheetGeometry(page: Page, footerRequired: boolean) {
  const geometry = await page.evaluate((requiresFooter) => {
    const sheet = document.querySelector<HTMLElement>(".hostdeck-session-actions-sheet");
    const body = document.querySelector<HTMLElement>(".hostdeck-session-actions__body");
    const scroller = document.querySelector<HTMLElement>(
      ".hostdeck-session-actions__scroller, .hostdeck-session-actions__menu"
    );
    const footer = document.querySelector<HTMLElement>(".hostdeck-session-actions__footer");
    if (sheet === null || body === null || scroller === null) {
      throw new TypeError("Archive Session actions geometry is unavailable.");
    }
    if (requiresFooter && footer === null) {
      throw new TypeError("Archive Session actions footer geometry is unavailable.");
    }
    const sheetRect = sheet.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const footerRect = footer?.getBoundingClientRect() ?? null;
    const targets = [...sheet.querySelectorAll<HTMLElement>("button")]
      .filter((button) => getComputedStyle(button).display !== "none")
      .map((button) => {
        const rect = button.getBoundingClientRect();
        return { height: rect.height, width: rect.width };
      });
    return {
      viewport: { height: window.innerHeight, width: window.innerWidth },
      document: {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth
      },
      sheet: {
        bottom: sheetRect.bottom,
        height: sheetRect.height,
        left: sheetRect.left,
        right: sheetRect.right,
        scrollWidth: sheet.scrollWidth,
        clientWidth: sheet.clientWidth,
        top: sheetRect.top
      },
      body: {
        overflow: getComputedStyle(body).overflow,
        scrollWidth: body.scrollWidth,
        clientWidth: body.clientWidth
      },
      scroller: {
        bottom: scrollerRect.bottom,
        overflowY: getComputedStyle(scroller).overflowY,
        scrollWidth: scroller.scrollWidth,
        clientWidth: scroller.clientWidth,
        top: scrollerRect.top
      },
      footer: footerRect === null ? null : { bottom: footerRect.bottom, top: footerRect.top },
      targets
    };
  }, footerRequired);

  expect(geometry.document.scrollWidth).toBe(geometry.document.clientWidth);
  expect(geometry.sheet.left).toBeGreaterThanOrEqual(0);
  expect(geometry.sheet.right).toBeLessThanOrEqual(geometry.viewport.width + 0.5);
  expect(geometry.sheet.top).toBeGreaterThanOrEqual(0);
  expect(geometry.sheet.bottom).toBeLessThanOrEqual(geometry.viewport.height + 0.5);
  expect(geometry.sheet.scrollWidth).toBeLessThanOrEqual(geometry.sheet.clientWidth);
  expect(geometry.body.scrollWidth).toBeLessThanOrEqual(geometry.body.clientWidth);
  expect(geometry.scroller.scrollWidth).toBeLessThanOrEqual(geometry.scroller.clientWidth);
  expect(geometry.body.overflow).toBe("hidden");
  expect(["auto", "scroll"]).toContain(geometry.scroller.overflowY);
  for (const target of geometry.targets) {
    expect(target.height).toBeGreaterThanOrEqual(44);
    expect(target.width).toBeGreaterThanOrEqual(44);
  }
  if (footerRequired) {
    expect(geometry.footer).not.toBeNull();
    expect(geometry.scroller.bottom).toBeLessThanOrEqual((geometry.footer?.top ?? 0) + 0.5);
    expect(geometry.footer?.bottom ?? Number.POSITIVE_INFINITY)
      .toBeLessThanOrEqual(geometry.sheet.bottom + 0.5);
  }
  return geometry;
}

function observePage(page: Page) {
  const consoleErrors: string[] = [];
  const externalRequests: string[] = [];
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

async function expectPrivateDataAbsent(page: Page): Promise<void> {
  const body = await page.locator("body").innerText();
  expect(body).not.toMatch(
    /thread-private|audit-private|device_detail_phone|PRIVATE archive|\/workspace\/archive|op_browser_archive_/iu
  );
  expect(page.url()).not.toMatch(/op_browser|thread-private|audit-private/iu);
  await expect
    .poll(() => page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })))
    .toEqual({ local: 0, session: 0 });
}

async function scrollConfirmationToEnd(page: Page): Promise<void> {
  await page.locator(".hostdeck-session-actions__scroller").evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(page.getByText("Confirmation required", { exact: true })).toBeVisible();
}

async function expectCleanBrowser(
  page: Page,
  diagnostics: ReturnType<typeof observePage>,
  allowedConsoleErrors: readonly RegExp[] = []
): Promise<void> {
  await page.waitForTimeout(50);
  expect(diagnostics.externalRequests).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
  expect(
    diagnostics.consoleErrors.filter(
      (message) => !allowedConsoleErrors.some((pattern) => pattern.test(message))
    )
  ).toEqual([]);
}

function expectedHttpErrors(outcome: ArchiveApiOutcome): readonly RegExp[] {
  switch (outcome) {
    case "blocked": return [/status of 423/iu];
    case "not_completed":
    case "incompatible":
    case "conflict": return [/status of 409/iu];
    case "not_found": return [/status of 404/iu];
    case "timeout": return [/status of 504/iu];
    case "storage": return [/status of 500/iu];
    default: return [];
  }
}

async function capture(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: resolve(artifactDirectory, name),
    animations: "disabled"
  });
}
