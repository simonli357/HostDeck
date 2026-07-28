import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Locator, type Page, type Request, test } from "@playwright/test";
import {
  type InterruptApiOutcome, 
  installInterruptApi,
  interruptBrowserTurnId
} from "./interrupt-control-fixture.js";
import {
  installSessionDetailApi,
  liveActivityEvent,
  promptTurnEvent,
  replayBoundaryEvent,
  type SessionDetailApiOptions,
  type SessionDetailApiVariant,
  type SessionDetailTurnState, 
  sessionDetailBrowserSessionId
} from "./session-detail-fixture.js";

const artifactDirectory = resolve("artifacts/fe-v1-036-active-turn-interrupt");
const detailPath = `/sessions/${sessionDetailBrowserSessionId}`;
const visualReviewTime = new Date("2026-07-27T20:00:00.000Z");

test.beforeAll(async () => {
  await mkdir(artifactDirectory, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(visualReviewTime);
});

test("keeps one mobile Session actions sheet and preserves Host access and routine controls", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const fixture = await openReadySession(page);
  const trigger = page.locator('button[aria-label="Open session actions"]');
  await expect(trigger).toHaveCSS("width", "44px");
  await expect(trigger).toHaveCSS("height", "44px");
  await expect(page.getByRole("button", { name: "Open Host and access" })).toHaveCount(0);

  const dialog = actionsDialog(page, "Session actions");
  await expect(dialog.locator(".hostdeck-utility-menu__item strong")).toHaveText([
    "Interrupt active turn",
    "Archive session",
    "Host & access"
  ]);
  const interrupt = interruptAction(dialog);
  await expect(interrupt).toBeEnabled();
  await expect(interrupt).toBeFocused();
  await expect(dialog.getByText(interruptBrowserTurnId, { exact: false })).toBeVisible();
  await expect(page.locator('[role="dialog"]')).toHaveCount(1);
  await expect(page.locator(".hostdeck-primary-action-dock__command")).toHaveCount(4);
  await expect(page.locator(".hostdeck-primary-action-dock")).not.toContainText("Interrupt");
  expect(fixture.interrupt.requests()).toHaveLength(0);
  await capture(page, "menu-ready-390x844.png");

  await dialog.getByRole("button", { name: /Host & access/iu }).click();
  const hostDialog = actionsDialog(page, "Host & access");
  await expect(hostDialog.getByRole("heading", { name: "Secure control ready" })).toBeVisible();
  await expect(page.locator('[role="dialog"]')).toHaveCount(1);
  const back = hostDialog.getByRole("button", { name: "Back to session actions" });
  await expect(back).toBeFocused();
  await capture(page, "host-access-390x844.png");

  await back.click();
  await expect(interrupt).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(fixture.interrupt.requests()).toHaveLength(0);
  await expectPrivateDataAbsent(page);
  await expectCleanBrowser(page, diagnostics);
});

test("sends one exact interrupt, locks pending dismissal, and renders terminal API proof", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const fixture = await openReadySession(page, { outcome: "pending" });
  const dialog = actionsDialog(page, "Session actions");
  await interruptAction(dialog).click();

  const confirmation = actionsDialog(page, "Interrupt active turn?");
  await expect(confirmation.locator(".hostdeck-interrupt-facts dd")).toHaveText([
    "android-release",
    interruptBrowserTurnId,
    "In progress",
    "Not archived, deleted, or erased"
  ]);
  await expect(confirmation.getByText("Stop only this active turn", { exact: true })).toBeVisible();
  await expect(
    confirmation.getByText("The session and its retained history remain available.", {
      exact: true
    })
  ).toBeVisible();
  await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
  expect(fixture.interrupt.requests()).toHaveLength(0);
  await capture(page, "confirmation-390x844.png");

  await confirmation.getByRole("button", { name: "Interrupt turn" }).click();
  await expect.poll(fixture.interrupt.hasPendingRequest).toBe(true);
  const pending = actionsDialog(page, "Interrupt active turn");
  await expect(pending.getByText("Waiting for terminal proof", { exact: true }).first())
    .toBeVisible();
  await expect(pending).not.toContainText(/accepted|request completed/iu);
  await expect(pending.getByRole("button", { name: "Close session actions" })).toBeDisabled();
  await expect(pending.getByRole("button", { name: "Waiting for terminal proof" })).toBeDisabled();
  expect(fixture.interrupt.requests()).toHaveLength(1);
  expectInterruptRequest(requiredRequest(fixture.interrupt.requests(), 0), interruptBrowserTurnId);
  await capture(page, "pending-390x844.png");

  await page.keyboard.press("Escape");
  await expect(pending).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(pending).toBeVisible();
  fixture.interrupt.release("success");

  const result = actionsDialog(page, "Turn interrupted");
  await expect(result.getByText("HostDeck confirmed this exact turn ended as interrupted."))
    .toBeVisible();
  await expect(result.getByText("Interrupted", { exact: true })).toBeVisible();
  await expect(result.getByRole("button", { name: /retry/iu })).toHaveCount(0);
  await expect(result.getByRole("button", { name: "Done" })).toBeFocused();
  await capture(page, "result-api-confirmed-390x844.png");
  await result.getByRole("button", { name: "Done" }).click();
  await expect(result).toBeHidden();
  expect(fixture.interrupt.requests()).toHaveLength(1);
  await expectPrivateDataAbsent(page);
  await expectCleanBrowser(page, diagnostics);
});

for (const resultCase of [
  {
    outcome: "success",
    label: "Turn interrupted",
    artifact: "result-confirmed"
  },
  {
    outcome: "blocked",
    label: "Interrupt blocked",
    artifact: "result-blocked"
  },
  {
    outcome: "unknown",
    label: "Outcome not confirmed",
    artifact: "result-unknown"
  },
  {
    outcome: "malformed",
    label: "Outcome not confirmed",
    artifact: "result-malformed"
  },
  {
    outcome: "mismatch",
    label: "Outcome not confirmed",
    artifact: "result-mismatch"
  }
] as const) {
  test(`keeps ${resultCase.outcome} response truth distinct with no resend`, async ({ page }) => {
    const diagnostics = observePage(page);
    const fixture = await openReadySession(page, { outcome: resultCase.outcome });
    await submitInterrupt(page);

    const result = actionsDialog(page, resultCase.label);
    await expect(result).toBeVisible();
    await expect(result.getByRole("button", { name: /retry/iu })).toHaveCount(0);
    await expect(result.getByRole("button", { name: "Done" })).toBeVisible();
    await capture(page, `${resultCase.artifact}-390x844.png`);
    await result.getByRole("button", { name: "Done" }).click();
    expect(fixture.interrupt.requests()).toHaveLength(1);
    await expect(page.getByRole("button", { name: "Open session actions" })).toBeFocused();
    await expectPrivateDataAbsent(page);
    await expectCleanBrowser(page, diagnostics, expectedHttpErrors(resultCase.outcome));
  });
}

for (const terminalCase of [
  {
    state: "interrupted",
    label: "Turn ended as interrupted",
    outcome: "Interrupted",
    artifact: "result-feed-interrupted"
  },
  {
    state: "completed",
    label: "Turn completed",
    outcome: "Completed",
    artifact: "result-feed-completed"
  },
  {
    state: "failed",
    label: "Turn failed",
    outcome: "Failed",
    artifact: "result-feed-failed"
  }
] as const) {
  test(`uses only later exact-turn ${terminalCase.state} evidence after HTTP uncertainty`, async ({
    page
  }) => {
    const diagnostics = observePage(page);
    const fixture = await openReadySession(page, { outcome: "pending" });
    await submitInterrupt(page);
    await expect.poll(fixture.interrupt.hasPendingRequest).toBe(true);

    await fixture.detail.pushEvent(
      promptTurnEvent(2, terminalCase.state, interruptBrowserTurnId)
    );
    fixture.interrupt.release("unknown");

    const result = actionsDialog(page, terminalCase.label);
    await expect(result.getByText(terminalCase.outcome, { exact: true })).toBeVisible();
    await expect(result.getByRole("button", { name: /retry/iu })).toHaveCount(0);
    await capture(page, `${terminalCase.artifact}-390x844.png`);
    expect(fixture.interrupt.requests()).toHaveLength(1);
    await expectPrivateDataAbsent(page);
    await expectCleanBrowser(page, diagnostics, expectedHttpErrors("unknown"));
  });
}

test("fails closed when terminal feed truth contradicts an API success", async ({ page }) => {
  const diagnostics = observePage(page);
  const fixture = await openReadySession(page, { outcome: "pending" });
  await submitInterrupt(page);
  await expect.poll(fixture.interrupt.hasPendingRequest).toBe(true);

  await fixture.detail.pushEvent(promptTurnEvent(2, "completed", interruptBrowserTurnId));
  fixture.interrupt.release("success");

  const result = actionsDialog(page, "Interrupt state inconsistent");
  await expect(result.getByText(/response and retained turn activity do not agree/iu)).toBeVisible();
  await expect(result.getByRole("button", { name: /retry/iu })).toHaveCount(0);
  await capture(page, "result-inconsistent-390x844.png");
  expect(fixture.interrupt.requests()).toHaveLength(1);
  await expectPrivateDataAbsent(page);
  await expectCleanBrowser(page, diagnostics);
});

for (const disabledCase of [
  {
    name: "completed",
    variant: "writable",
    turnState: "completed",
    events: [promptTurnEvent(1, "completed", interruptBrowserTurnId)],
    retentionBoundaryCursor: undefined,
    reason: "The current turn is already completed."
  },
  {
    name: "unknown",
    variant: "writable",
    turnState: "unknown",
    events: [promptTurnEvent(1, "unknown", interruptBrowserTurnId)],
    retentionBoundaryCursor: undefined,
    reason: "The current turn state is unknown. Refresh before interrupting."
  },
  {
    name: "read-only",
    variant: "read_only",
    turnState: "in_progress",
    events: [promptTurnEvent(1, "in_progress", interruptBrowserTurnId)],
    retentionBoundaryCursor: undefined,
    reason: "Read-only access cannot interrupt a turn."
  },
  {
    name: "host-locked",
    variant: "locked",
    turnState: "in_progress",
    events: [promptTurnEvent(1, "in_progress", interruptBrowserTurnId)],
    retentionBoundaryCursor: undefined,
    reason: "Remote writes are locked on the laptop."
  },
  {
    name: "stale",
    variant: "stale_session",
    turnState: "in_progress",
    events: [promptTurnEvent(1, "in_progress", interruptBrowserTurnId)],
    retentionBoundaryCursor: undefined,
    reason: "Session state is stale. Refresh Session Detail before interrupting."
  },
  {
    name: "missing-evidence",
    variant: "writable",
    turnState: "in_progress",
    events: [liveActivityEvent(1)],
    retentionBoundaryCursor: undefined,
    reason: "Exact active-turn evidence is not retained. Refresh and wait for current activity."
  },
  {
    name: "ambiguous-evidence",
    variant: "writable",
    turnState: "in_progress",
    events: [
      promptTurnEvent(1, "in_progress", interruptBrowserTurnId),
      promptTurnEvent(2, "in_progress", "turn-browser-interrupt-ambiguous")
    ],
    retentionBoundaryCursor: undefined,
    reason: "Retained activity contains more than one active turn. Refresh before interrupting."
  },
] as const) {
  test(`keeps ${disabledCase.name} interrupt truth visible and disabled`, async ({ page }) => {
    const diagnostics = observePage(page);
    const fixture = await openReadySession(page, {
      variant: disabledCase.variant,
      turnState: disabledCase.turnState,
      events: disabledCase.events,
      retentionBoundaryCursor: disabledCase.retentionBoundaryCursor,
      expectEnabled: false
    });
    const dialog = actionsDialog(page, "Session actions");
    const action = interruptAction(dialog);
    await expect(action).toBeDisabled();
    await expect(dialog.getByText(disabledCase.reason, { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Host & access/iu })).toBeFocused();
    expect(fixture.interrupt.requests()).toHaveLength(0);
    await capture(page, `disabled-${disabledCase.name}-390x844.png`);
    await expectPrivateDataAbsent(page);
    await expectCleanBrowser(page, diagnostics);
  });
}

test("keeps a retention boundary without post-boundary turn proof non-actionable", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const fixture = await openReadySession(page, {
    events: [replayBoundaryEvent(1, 0, "retention")],
    expectEnabled: false,
    turnState: "in_progress"
  });

  const dialog = actionsDialog(page, "Session actions");
  await expect(interruptAction(dialog)).toBeDisabled();
  await expect(
    dialog.getByText(
      "Exact active-turn evidence is not retained. Refresh and wait for current activity.",
      { exact: true }
    )
  ).toBeVisible();
  await capture(page, "disabled-boundary-obscured-390x844.png");
  expect(fixture.interrupt.requests()).toHaveLength(0);
  await expectPrivateDataAbsent(page);
  await expectCleanBrowser(page, diagnostics);
});

test("disables interrupt during reconnect without discarding the exact session menu", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const fixture = await openReadySession(page, { openMenu: false });
  await fixture.detail.dropStream();
  await expect(page.getByText("Activity stream reconnecting", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open session actions" }).click();

  const dialog = actionsDialog(page, "Session actions");
  await expect(interruptAction(dialog)).toBeDisabled();
  await expect(
    dialog.getByText(
      "Live session activity is reconnecting. Wait for current activity before interrupting.",
      { exact: true }
    )
  ).toBeVisible();
  await capture(page, "disabled-reconnecting-390x844.png");
  expect(fixture.interrupt.requests()).toHaveLength(0);
  await expectPrivateDataAbsent(page);
  await expectCleanBrowser(page, diagnostics);
});

test("contains long menu and confirmation content across responsive, short, and zoom states", async ({
  page
}) => {
  test.setTimeout(45_000);
  const diagnostics = observePage(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const longTurnId = `turn-${"x".repeat(123)}`;
  await openReadySession(page, {
    variant: "writable_long",
    turnId: longTurnId
  });
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

  await interruptAction(actionsDialog(page, "Session actions")).click();
  const confirmation = actionsDialog(page, "Interrupt active turn?");
  await expect(confirmation.getByText(longTurnId, { exact: true })).toBeVisible();
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
  await writeFile(
    resolve(artifactDirectory, "layout-measurements.json"),
    `${JSON.stringify({ measurements }, null, 2)}\n`,
    "utf8"
  );

  await expectPrivateDataAbsent(page);
  await expectCleanBrowser(page, diagnostics);
});

interface OpenReadySessionOptions {
  readonly events?: readonly ReturnType<typeof promptTurnEvent>[] | readonly ReturnType<typeof liveActivityEvent>[];
  readonly expectEnabled?: boolean;
  readonly openMenu?: boolean;
  readonly outcome?: InterruptApiOutcome;
  readonly retentionBoundaryCursor?: number | undefined;
  readonly turnId?: string;
  readonly turnState?: SessionDetailTurnState;
  readonly variant?: SessionDetailApiVariant;
}

async function openReadySession(
  page: Page,
  options: OpenReadySessionOptions = {}
) {
  const turnId = options.turnId ?? interruptBrowserTurnId;
  const turnState = options.turnState ?? "in_progress";
  const events = options.events ?? [promptTurnEvent(1, turnState, turnId)];
  const detailOptions: SessionDetailApiOptions = {
    initialEvents: events,
    streamEvents: events,
    turnState
  };
  if (options.retentionBoundaryCursor !== undefined) {
    Object.assign(detailOptions, {
      retentionBoundaryCursor: options.retentionBoundaryCursor
    });
  }
  const detail = await installSessionDetailApi(
    page,
    options.variant ?? "writable",
    detailOptions
  );
  const interrupt = await installInterruptApi(page, turnId);
  interrupt.setOutcome(options.outcome ?? "success");
  await page.goto(detailPath);
  const trigger = page.getByRole("button", { name: "Open session actions" });
  await expect(trigger).toBeVisible();
  if (options.openMenu !== false) {
    await trigger.click();
    const action = interruptAction(actionsDialog(page, "Session actions"));
    if (options.expectEnabled === false) await expect(action).toBeDisabled();
    else await expect(action).toBeEnabled();
  }
  return Object.freeze({ detail, interrupt });
}

async function submitInterrupt(page: Page): Promise<void> {
  const menu = actionsDialog(page, "Session actions");
  await interruptAction(menu).click();
  const confirmation = actionsDialog(page, "Interrupt active turn?");
  await confirmation.getByRole("button", { name: "Interrupt turn" }).click();
}

function actionsDialog(page: Page, name: string): Locator {
  return page.getByRole("dialog", { name, exact: true });
}

function interruptAction(dialog: Locator): Locator {
  return dialog.getByRole("button", { name: /Interrupt active turn/iu });
}

function requiredRequest(requests: readonly Request[], index: number): Request {
  const request = requests[index];
  if (request === undefined) throw new TypeError("Expected interrupt request is missing.");
  return request;
}

function expectInterruptRequest(request: Request, turnId: string): void {
  const url = new URL(request.url());
  expect(request.method()).toBe("POST");
  expect(url).toMatchObject({
    origin: "http://127.0.0.1:4175",
    pathname: `/api/v1/sessions/${sessionDetailBrowserSessionId}/turns/${turnId}/interrupt`,
    search: "",
    hash: ""
  });
  const body = request.postDataJSON() as Record<string, unknown>;
  expect(Object.keys(body)).toEqual(["operation_id", "kind", "confirm"]);
  expect(body).toEqual({
    operation_id: expect.stringMatching(/^op_browser_interrupt_[0-9a-f]{32}$/u),
    kind: "interrupt",
    confirm: true
  });
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
      throw new TypeError("Session actions geometry is unavailable.");
    }
    if (requiresFooter && footer === null) {
      throw new TypeError("Session actions footer geometry is unavailable.");
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
      footer: footerRect === null
        ? null
        : { bottom: footerRect.bottom, top: footerRect.top },
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
    /thread-private|device_detail_phone|PRIVATE fixture|PRIVATE timeout|\/workspace\/hostdeck|op_browser_interrupt_/iu
  );
  expect(page.url()).not.toMatch(/turn-browser|op_browser|thread-private/iu);
  await expect
    .poll(() => page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })))
    .toEqual({ local: 0, session: 0 });
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

function expectedHttpErrors(outcome: InterruptApiOutcome): readonly RegExp[] {
  if (outcome === "blocked") return [/status of 423/iu];
  if (outcome === "unknown") return [/status of 504/iu];
  return [];
}

async function capture(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: resolve(artifactDirectory, name),
    animations: "disabled"
  });
}
