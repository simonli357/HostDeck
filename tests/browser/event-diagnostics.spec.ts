import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Locator, type Page, type Request, test } from "@playwright/test";
import { selectedProjectionEventSchema } from "../../packages/contracts/src/index.js";
import {
  eventDiagnosticsEvent,
  installEventDiagnosticsApi
} from "./event-diagnostics-fixture.js";
import { sessionDetailBrowserSessionId } from "./session-detail-fixture.js";

const artifactDirectory = resolve("artifacts/fe-v1-014-bounded-event-diagnostics");
const detailPath = `/sessions/${sessionDetailBrowserSessionId}`;
const visualReviewTime = new Date("2026-07-27T20:00:00.000Z");

test.beforeAll(async () => {
  await mkdir(artifactDirectory, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(visualReviewTime);
});

test("verifies every normalized event variant and limitation through one exact read", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const api = await installEventDiagnosticsApi(page);
  await page.goto(detailPath);

  const actions = page.getByRole("button", { name: "View event details" });
  await expect(actions).toHaveCount(8);
  expect(api.requests()).toHaveLength(0);

  const states = [
    ["Replay boundary", "Content truncated", "replay-boundary"],
    ["Message event", "Bounded projection", "message"],
    ["Turn event", "Content redacted", "turn"],
    ["Activity event", "Content truncated", "activity"],
    ["Approval event", "Content redacted and truncated", "approval"],
    ["Control event", "Bounded projection", "control"],
    ["Runtime event", "Bounded projection", "runtime"],
    ["Unrecognized optional event", "Unrecognized optional event", "unknown-optional"]
  ] as const;

  for (const [index, [heading, limitation, artifact]] of states.entries()) {
    const action = actions.nth(index);
    await action.scrollIntoViewIfNeeded();
    await action.focus();
    if (index === 0) await page.keyboard.press("Enter");
    else await action.click();

    const dialog = eventDialog(page);
    await expect(dialog.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expect(dialog.getByText("Event verification current", { exact: true })).toBeVisible();
    await expect(
      dialog.locator(".hostdeck-event-limitation").getByText(limitation, { exact: true })
    ).toBeVisible();
    await expect(dialog.getByText("HostDeck projection", { exact: true })).toBeVisible();
    await expect(page.locator('[role="dialog"]')).toHaveCount(1);
    await expect(dialog.getByRole("button", { name: "Close event details" })).toBeFocused();
    expectEventRequest(requiredRequest(api.requests(), index), index + 1, index);
    await capture(page, `variant-${artifact}-390x844.png`);

    if (index % 2 === 0) {
      await dialog.getByRole("button", { name: "Close event details" }).click();
    } else {
      await page.keyboard.press("Escape");
    }
    await expect(dialog).toBeHidden();
    await expect(action).toBeFocused();
  }

  await page.waitForTimeout(100);
  expect(api.requests()).toHaveLength(8);
  await expect(page.getByText("Empty value", { exact: true })).toHaveCount(0);
  await expectPrivateDataAbsent(page);
  await expectCleanBrowser(diagnostics);
});

test("keeps loading, stale, retry, malformed, mismatch, and pruned truth distinct", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const event = eventDiagnosticsEvent("message", 1);
  const api = await installEventDiagnosticsApi(page, { events: [event] });
  api.setReadOutcome("pending");
  await page.goto(detailPath);

  const action = page.getByRole("button", { name: "View event details" });
  await action.click();
  const dialog = eventDialog(page);
  await expect(dialog.getByText("Verifying event", { exact: true })).toBeVisible();
  await expect.poll(api.hasPendingRead).toBe(true);
  await expect(dialog.getByRole("button", { name: "Retry" })).toBeDisabled();
  expect(api.requests()).toHaveLength(1);
  await capture(page, "state-loading-390x844.png");

  api.releaseRead();
  await expect(dialog.getByText("Event verification current", { exact: true })).toBeVisible();
  await capture(page, "state-current-390x844.png");
  await closeEventDialog(page);

  api.detail.setVariant("stale_session");
  await page.reload();
  await action.click();
  await expect(dialog.getByText("Retained event detail", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/Current session-read authority is unavailable/iu)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Retry" })).toBeDisabled();
  expect(api.requests()).toHaveLength(1);
  await capture(page, "state-stale-390x844.png");
  await closeEventDialog(page);

  api.detail.setVariant("active");
  await page.reload();
  api.setReadOutcome("overloaded");
  await action.click();
  await expect(dialog.getByText("Event verification failed", { exact: true })).toBeVisible();
  await expect(dialog.getByText("HostDeck is temporarily too busy to verify this event."))
    .toBeVisible();
  const readsAfterFailure = api.requests().length;
  await page.waitForTimeout(100);
  expect(api.requests()).toHaveLength(readsAfterFailure);
  await capture(page, "state-failure-390x844.png");

  api.setReadOutcome("success");
  await dialog.getByRole("button", { name: "Retry" }).click();
  await expect(dialog.getByText("Event verification current", { exact: true })).toBeVisible();
  await capture(page, "state-retried-current-390x844.png");
  await closeEventDialog(page);

  for (const [outcome, detail, artifact] of [
    ["malformed", "HostDeck could not validate the current event page.", "state-malformed-390x844.png"],
    ["mismatch", "The current event page no longer matches", "state-mismatch-390x844.png"],
    ["pruned", "The retained event is no longer current", "state-pruned-390x844.png"],
    ["empty", "The current event page no longer matches", "state-empty-page-390x844.png"]
  ] as const) {
    api.setReadOutcome(outcome);
    await action.click();
    await expect(dialog.getByText("Event verification failed", { exact: true })).toBeVisible();
    await expect(dialog.getByText(new RegExp(detail, "iu"))).toBeVisible();
    await expect(dialog.getByText("Exact bounded message projection.", { exact: true }))
      .toBeVisible();
    await capture(page, artifact);
    await closeEventDialog(page);
  }

  expect(api.requests()).toHaveLength(7);
  await expectPrivateDataAbsent(page);
  await expectCleanBrowser(diagnostics, [
    /status of 503 \(Service Unavailable\)/u,
    /status of 409 \(Conflict\)/u
  ]);
});

test("verifies a persisted boundary whose prior cursor is not reported", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const nullableBoundary = eventDiagnosticsEvent("replay_boundary", 1, {
    boundaryAfter: null
  });
  const api = await installEventDiagnosticsApi(page, {
    events: [nullableBoundary],
    sessionVariant: "empty",
    streamEvents: [nullableBoundary]
  });
  await page.goto(detailPath);

  const actions = page.getByRole("button", { name: "View event details" });
  await expect(actions).toHaveCount(1);
  await actions.click();
  const dialog = eventDialog(page);
  await expect(dialog.getByText("Event verification current", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Persisted normalized event", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Not reported", { exact: true }).first()).toBeVisible();
  expect(api.requests()).toHaveLength(1);
  expectEventRequest(requiredRequest(api.requests(), 0), 1, null);
  await capture(page, "nullable-boundary-390x844.png");
  await closeEventDialog(page);

  await expectPrivateDataAbsent(page);
  await expectCleanBrowser(diagnostics);
});

test("shows continuity-only evidence and preserves read authority through read-only and lock states", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const retained = eventDiagnosticsEvent("message", 2);
  const api = await installEventDiagnosticsApi(page, {
    events: [retained],
    retentionBoundaryCursor: 1,
    sessionVariant: "read_only",
    streamEvents: []
  });
  await page.goto(detailPath);

  const action = page.getByRole("button", { name: "View event details" });
  await action.click();
  let dialog = eventDialog(page);
  await expect(dialog.getByRole("heading", { name: "Replay boundary" })).toBeVisible();
  await expect(dialog.getByText("Stream continuity evidence", { exact: true })).toBeVisible();
  await expect(
    dialog.getByText("Stream continuity evidence; not a persisted event", { exact: true })
  ).toBeVisible();
  await expect(dialog.getByText("Local evidence only", { exact: true })).toBeVisible();
  expect(api.requests()).toHaveLength(0);
  await capture(page, "continuity-only-read-only-390x844.png");
  await closeEventDialog(page);

  api.detail.setVariant("locked");
  await refreshSessionDetail(page);
  await action.click();
  dialog = eventDialog(page);
  await expect(dialog.getByText("Local evidence only", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Target: android-release", { exact: false })).toBeVisible();
  expect(api.requests()).toHaveLength(0);
  await capture(page, "continuity-only-host-locked-390x844.png");
  await closeEventDialog(page);

  await expectPrivateDataAbsent(page);
  await expectCleanBrowser(diagnostics);
});

test("targets the latest event behind consolidated message and approval rows", async ({ page }) => {
  const diagnostics = observePage(page);
  const sharedMessage = "item-browser-consolidated";
  const sharedApproval = "request-browser-consolidated";
  const events = [
    eventDiagnosticsEvent("message", 1, {
      itemId: sharedMessage,
      phase: "delta",
      text: "First projected segment. "
    }),
    eventDiagnosticsEvent("message", 2, {
      itemId: sharedMessage,
      text: "Final consolidated message projection."
    }),
    eventDiagnosticsEvent("approval", 3, {
      action: "Approve exact consolidated validation",
      requestId: sharedApproval
    }),
    eventDiagnosticsEvent("approval", 4, {
      action: "Approve exact consolidated validation",
      requestId: sharedApproval
    })
  ];
  const api = await installEventDiagnosticsApi(page, { events });
  await page.goto(detailPath);

  const actions = page.getByRole("button", { name: "View event details" });
  await expect(actions).toHaveCount(2);
  await actions.nth(0).click();
  let dialog = eventDialog(page);
  await expect(dialog.getByRole("heading", { name: "Message event" })).toBeVisible();
  await expect(dialog.getByText("Final consolidated message projection.", { exact: true }))
    .toBeVisible();
  expectEventRequest(requiredRequest(api.requests(), 0), 2, 1);
  await capture(page, "consolidated-message-390x844.png");
  await closeEventDialog(page);

  await actions.nth(1).click();
  dialog = eventDialog(page);
  await expect(dialog.getByRole("heading", { name: "Approval event" })).toBeVisible();
  await expect(dialog.getByText("Approve exact consolidated validation", { exact: true }))
    .toBeVisible();
  expectEventRequest(requiredRequest(api.requests(), 1), 4, 3);
  await capture(page, "event-backed-approval-390x844.png");
  await closeEventDialog(page);

  expect(api.requests()).toHaveLength(2);
  await expectPrivateDataAbsent(page);
  await expectCleanBrowser(diagnostics);
});

test("contains maximum payload across responsive, short-height, scrolled, and zoom states", async ({
  page
}) => {
  test.setTimeout(45_000);
  const diagnostics = observePage(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const suffix = "\n<script>window.hostdeckPrivate=true</script>\nhttps://example.invalid/private\n\u6570\u636e";
  const text = `${"x".repeat(12_000 - suffix.length)}${suffix}`;
  const baseEvent = eventDiagnosticsEvent("message", 1, { itemId: null, text });
  const event = selectedProjectionEventSchema.parse({
    ...baseEvent,
    codex_event_id: "i".repeat(160),
    codex_event_type: "t".repeat(160)
  });
  const api = await installEventDiagnosticsApi(page, {
    events: [event],
    sessionVariant: "writable_long"
  });
  await page.goto(detailPath);
  await page.getByRole("button", { name: "View event details" }).click();

  const dialog = eventDialog(page);
  await expect(dialog.getByText("Event verification current", { exact: true })).toBeVisible();
  const textValue = dialog.locator(".hostdeck-event-field").filter({ hasText: "Text" }).locator("dd");
  await expect(textValue).toHaveText(text);
  await expect(dialog.locator("script, a")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /copy|download/iu })).toHaveCount(0);
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
    measurements.push({ viewport, sheet: await expectEventSheetGeometry(page) });
    await capture(page, `responsive-${viewport.width}x${viewport.height}.png`);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.getByRole("button", { name: "Expand field" }).click();
  await expect(dialog.getByRole("button", { name: "Collapse field" })).toBeVisible();
  measurements.push({
    viewport: { width: 390, height: 844, expanded: true },
    sheet: await expectEventSheetGeometry(page)
  });
  await capture(page, "long-expanded-390x844.png");

  const scroller = dialog.locator(".hostdeck-event-sheet__scroller");
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(dialog.getByRole("button", { name: "Retry" })).toBeVisible();
  measurements.push({
    viewport: { width: 390, height: 844, expanded: true, scrolled: true },
    sheet: await expectEventSheetGeometry(page)
  });
  await capture(page, "long-expanded-scrolled-390x844.png");

  await page.setViewportSize({ width: 390, height: 420 });
  measurements.push({
    viewport: { width: 390, height: 420, expanded: true },
    sheet: await expectEventSheetGeometry(page)
  });
  await capture(page, "short-height-390x420.png");

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
    sheet: await expectEventSheetGeometry(page)
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

  expect(text).toHaveLength(12_000);
  expect(api.requests()).toHaveLength(1);
  await expectPrivateDataAbsent(page, ["https://example.invalid/private"]);
  await expectCleanBrowser(diagnostics);
});

function eventDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: "Event details" });
}

async function closeEventDialog(page: Page): Promise<void> {
  const dialog = eventDialog(page);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
}

async function capture(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: resolve(artifactDirectory, name),
    animations: "disabled"
  });
}

function requiredRequest(requests: readonly Request[], index: number): Request {
  const request = requests[index];
  if (request === undefined) throw new TypeError("Expected event diagnostics request is missing.");
  return request;
}

function expectEventRequest(
  request: Request,
  cursor: number,
  after: number | null
): void {
  const url = new URL(request.url());
  expect(request.method()).toBe("GET");
  expect(url).toMatchObject({
    origin: "http://127.0.0.1:4175",
    pathname: `/api/v1/sessions/${sessionDetailBrowserSessionId}/events`,
    hash: ""
  });
  expect([...url.searchParams.entries()]).toEqual(
    after === null
      ? [["limit", "1"]]
      : [["after", String(after)], ["limit", "1"]]
  );
  expect(cursor).toBe(after === null ? 1 : after + 1);
  expect(request.postData()).toBeNull();
  expect(request.headers()["x-hostdeck-csrf"]).toBeUndefined();
  expect(request.headers()["x-hostdeck-csrf-generation"]).toBeUndefined();
}

async function refreshSessionDetail(page: Page): Promise<void> {
  const refresh = page.locator(".hostdeck-detail-context__refresh");
  await refresh.evaluate((button) => (button as HTMLButtonElement).click());
  await expect.poll(async () => {
    if (await refresh.count() === 0) return true;
    return !(await refresh.isVisible()) || await refresh.isEnabled();
  }).toBe(true);
}

async function expectEventSheetGeometry(page: Page) {
  const geometry = await page.evaluate(() => {
    const sheet = document.querySelector<HTMLElement>(".hostdeck-event-sheet");
    const scroller = document.querySelector<HTMLElement>(
      ".hostdeck-event-sheet__scroller"
    );
    const footer = document.querySelector<HTMLElement>(".hostdeck-event-footer");
    if (sheet === null || scroller === null || footer === null) {
      throw new TypeError("Event diagnostics geometry is unavailable.");
    }
    const sheetRect = sheet.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    const buttons = [...sheet.querySelectorAll<HTMLElement>("button")]
      .filter((button) => getComputedStyle(button).display !== "none")
      .map((button) => {
        const rect = button.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      });
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      document: {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth
      },
      sheet: {
        left: sheetRect.left,
        right: sheetRect.right,
        top: sheetRect.top,
        bottom: sheetRect.bottom,
        width: sheetRect.width,
        height: sheetRect.height
      },
      scroller: {
        clientWidth: scroller.clientWidth,
        scrollWidth: scroller.scrollWidth,
        clientHeight: scroller.clientHeight,
        scrollHeight: scroller.scrollHeight,
        top: scrollerRect.top,
        bottom: scrollerRect.bottom
      },
      footer: { top: footerRect.top, bottom: footerRect.bottom },
      buttons,
      dialogs: document.querySelectorAll('[role="dialog"]').length
    };
  });

  expect(geometry.document.scrollWidth).toBe(geometry.document.clientWidth);
  expect(geometry.sheet.left).toBeGreaterThanOrEqual(0);
  expect(geometry.sheet.right).toBeLessThanOrEqual(geometry.viewport.width + 1);
  expect(geometry.sheet.top).toBeGreaterThanOrEqual(0);
  expect(geometry.sheet.bottom).toBeLessThanOrEqual(geometry.viewport.height + 1);
  expect(geometry.scroller.scrollWidth).toBeLessThanOrEqual(geometry.scroller.clientWidth + 1);
  expect(geometry.scroller.bottom).toBeLessThanOrEqual(geometry.footer.top + 1);
  expect(geometry.footer.bottom).toBeLessThanOrEqual(geometry.sheet.bottom + 1);
  expect(geometry.dialogs).toBe(1);
  expect(geometry.buttons.length).toBeGreaterThan(0);
  for (const button of geometry.buttons) {
    expect(button.width).toBeGreaterThanOrEqual(44);
    expect(button.height).toBeGreaterThanOrEqual(44);
  }
  return geometry;
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
  allowedConsoleErrors: readonly RegExp[] = []
): Promise<void> {
  expect(diagnostics.externalRequests).toEqual([]);
  for (const message of diagnostics.consoleErrors) {
    expect(allowedConsoleErrors.some((pattern) => pattern.test(message))).toBe(true);
  }
  expect(diagnostics.pageErrors).toEqual([]);
}

async function expectPrivateDataAbsent(
  page: Page,
  allowedBodyValues: readonly string[] = []
): Promise<void> {
  const privacy = await page.evaluate(() => ({
    body: document.body.textContent ?? "",
    historyState: JSON.stringify(history.state),
    localStorage: Object.keys(localStorage),
    sessionStorage: Object.keys(sessionStorage),
    url: window.location.href
  }));
  let body = privacy.body;
  for (const value of allowedBodyValues) body = body.replaceAll(value, "");
  expect(body).not.toMatch(/thread-private|device_detail_phone|connection_generation/iu);
  expect(body).not.toMatch(/\/home\/private|event-store\.sqlite|\/workspace\//iu);
  expect(privacy.historyState).not.toMatch(/thread-private|\/home\/private|\/workspace\//iu);
  expect(privacy.localStorage).toEqual([]);
  expect(privacy.sessionStorage).toEqual([]);
  expect(privacy.url).toBe(`http://127.0.0.1:4175${detailPath}`);
}
