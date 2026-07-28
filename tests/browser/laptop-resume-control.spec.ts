import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Locator, type Page, type Request, test } from "@playwright/test";
import { selectedResumeRemoteMaxLength } from "../../packages/contracts/src/index.js";
import {
  installLaptopResumeApi,
  type LaptopResumeApiOutcome,
  laptopResumeBrowserCommand,
  laptopResumeBrowserLongCommand,
  laptopResumeBrowserLongRemote,
  laptopResumeBrowserLongUnavailableReason,
  laptopResumeBrowserUnavailableReason
} from "./laptop-resume-control-fixture.js";
import {
  installSessionDetailApi,
  promptTurnEvent,
  type SessionDetailApiOptions,
  type SessionDetailApiVariant,
  type SessionDetailTurnState,
  sessionDetailBrowserSessionId
} from "./session-detail-fixture.js";

const artifactDirectory = resolve("artifacts/fe-v1-038-laptop-tui-resume");
const detailPath = `/sessions/${sessionDetailBrowserSessionId}`;
const visualReviewTime = new Date("2026-07-27T23:00:00.000Z");

test.beforeAll(async () => {
  await mkdir(artifactDirectory, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(visualReviewTime);
  await installClipboardFixture(page);
});

test("reads and copies one exact local command only from the shared Session actions sheet", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const fixture = await openReadyResume(page, { outcome: "pending" });
  const trigger = page.getByRole("button", { name: "Open session actions" });
  expect(fixture.resume.requests()).toHaveLength(0);

  await trigger.click();
  let dialog = actionsDialog(page, "Session actions");
  await expect(dialog.locator(".hostdeck-utility-menu__item strong")).toHaveText([
    "Interrupt active turn",
    "Archive session",
    "Resume on laptop",
    "Host & access"
  ]);
  const resume = resumeAction(dialog);
  await expect(resume).toBeEnabled();
  await expect(page.locator(".hostdeck-primary-action-dock")).not.toContainText(
    "Resume on laptop"
  );
  await expect(page.locator('[role="dialog"]')).toHaveCount(1);
  expect(fixture.resume.requests()).toHaveLength(0);
  await capture(page, "menu-ready-390x844.png");

  await resume.click();
  await expect.poll(fixture.resume.hasPendingRequest).toBe(true);
  dialog = actionsDialog(page, "Resume on laptop");
  await expect(dialog.getByText("Laptop terminal only", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Reading laptop command", { exact: true }).first()).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Reading laptop command" })).toBeDisabled();
  await expect(dialog.locator("code")).toHaveCount(0);
  await expect(dialog.locator("input, textarea, [contenteditable='true']")).toHaveCount(0);
  await expect(page.locator('[role="dialog"]')).toHaveCount(1);
  expect(fixture.resume.requests()).toHaveLength(1);
  expectResumeRequest(requiredRequest(fixture.resume.requests(), 0));
  expect(await clipboardState(page)).toEqual({ attempts: [], failuresRemaining: 0, writes: [] });
  await capture(page, "loading-390x844.png");

  fixture.resume.release("available");
  await expect(dialog.getByText("Exact laptop command ready", { exact: true })).toBeVisible();
  const code = dialog.locator("code");
  await expect(code).toHaveText(laptopResumeBrowserCommand);
  await expect(code).toHaveCSS("user-select", "text");
  await expect(code).toHaveCSS("white-space", "pre-wrap");
  await expect(dialog.getByText("Nothing has run from this phone.", { exact: true })).toBeVisible();
  const copy = dialog.getByRole("button", { name: "Copy command" });
  await expect(copy).toBeFocused();
  await expectCommandProjection(page, laptopResumeBrowserCommand);
  await capture(page, "available-390x844.png");

  await copy.click();
  await expect(dialog.getByText("Command copied", { exact: true })).toBeVisible();
  await expect(
    dialog.getByText(
      "Nothing ran here. Use it only in a terminal on the HostDeck laptop.",
      { exact: true }
    )
  ).toBeVisible();
  expect(await clipboardState(page)).toEqual({
    attempts: [laptopResumeBrowserCommand],
    failuresRemaining: 0,
    writes: [laptopResumeBrowserCommand]
  });
  expect(fixture.resume.requests()).toHaveLength(1);
  await capture(page, "copied-390x844.png");

  await dialog.getByRole("button", { name: "Back to session actions" }).click();
  dialog = actionsDialog(page, "Session actions");
  await expect(resumeAction(dialog)).toBeFocused();
  await expect(page.locator("code")).toHaveCount(0);
  await dialog.getByRole("button", { name: /Host & access/iu }).click();
  const host = actionsDialog(page, "Host & access");
  await expect(host.getByRole("heading", { name: "Secure control ready" })).toBeVisible();
  await host.getByRole("button", { name: "Back to session actions" }).click();
  await expect(
    actionsDialog(page, "Session actions").getByRole("button", { name: /Archive session/iu })
  ).toBeFocused();
  await actionsDialog(page, "Session actions")
    .getByRole("button", { name: "Close session actions" })
    .click();
  await expect(trigger).toBeFocused();
  await expectResumePrivacy(page, laptopResumeBrowserCommand, false);
  await expectCleanBrowser(diagnostics);
});

test("reports clipboard denial and retries only after a second explicit copy", async ({ page }) => {
  const diagnostics = observePage(page);
  const fixture = await openReadyResume(page);
  await openResume(page);
  const dialog = actionsDialog(page, "Resume on laptop");
  await expect(dialog.locator("code")).toHaveText(laptopResumeBrowserCommand);
  await failNextClipboard(page);

  await dialog.getByRole("button", { name: "Copy command" }).click();
  await expect(dialog.getByText("Copy failed", { exact: true })).toBeVisible();
  await expect(dialog.getByText(
    "The command remains selectable, or you can try copying it again.",
    { exact: true }
  )).toBeVisible();
  await expect(dialog.locator("code")).toHaveText(laptopResumeBrowserCommand);
  expect(await clipboardState(page)).toEqual({
    attempts: [laptopResumeBrowserCommand],
    failuresRemaining: 0,
    writes: []
  });
  await page.waitForTimeout(100);
  expect((await clipboardState(page)).attempts).toHaveLength(1);
  expect(fixture.resume.requests()).toHaveLength(1);
  await capture(page, "copy-failed-390x844.png");

  await dialog.getByRole("button", { name: "Try copy again" }).click();
  await expect(dialog.getByText("Command copied", { exact: true })).toBeVisible();
  expect(await clipboardState(page)).toEqual({
    attempts: [laptopResumeBrowserCommand, laptopResumeBrowserCommand],
    failuresRemaining: 0,
    writes: [laptopResumeBrowserCommand]
  });
  expect(fixture.resume.requests()).toHaveLength(1);
  await expectResumePrivacy(page, laptopResumeBrowserCommand, true);
  await expectCleanBrowser(diagnostics);
});

test("keeps unavailable, API, and strict-correlation failures distinct without automatic retry", async ({
  page
}) => {
  test.setTimeout(45_000);
  const diagnostics = observePage(page);
  const fixture = await openReadyResume(page, { outcome: "unavailable" });
  await openResume(page);
  const dialog = actionsDialog(page, "Resume on laptop");
  const cases = [
    {
      outcome: "unavailable",
      status: "Laptop resume unavailable",
      detail: laptopResumeBrowserUnavailableReason,
      artifact: "unavailable"
    },
    {
      outcome: "not_found",
      status: "Managed session not found",
      detail: "This managed session no longer exists.",
      artifact: "not-found"
    },
    {
      outcome: "stale_session",
      status: "Session not eligible",
      detail: "This managed session is not current and eligible for laptop resume.",
      artifact: "stale-session"
    },
    {
      outcome: "runtime_unavailable",
      status: "Laptop runtime unavailable",
      detail: "The selected Codex runtime is not available for laptop resume.",
      artifact: "runtime-unavailable"
    },
    {
      outcome: "timeout",
      status: "Laptop command could not be loaded",
      detail: "The laptop resume metadata read timed out.",
      artifact: "timeout"
    },
    {
      outcome: "storage",
      status: "Laptop command could not be loaded",
      detail: "Managed session state is unavailable on the laptop.",
      artifact: "storage"
    },
    {
      outcome: "rate_limited",
      status: "Laptop command could not be loaded",
      detail: "HostDeck is temporarily unable to read laptop resume metadata.",
      artifact: "rate-limited"
    },
    {
      outcome: "malformed",
      status: "Laptop command could not be loaded",
      detail: "Laptop resume metadata failed strict validation.",
      artifact: "malformed"
    },
    {
      outcome: "mismatch",
      status: "Laptop command could not be loaded",
      detail: "Laptop resume metadata failed strict validation.",
      artifact: "mismatch"
    },
    {
      outcome: "wrong_thread",
      status: "Laptop command could not be loaded",
      detail: "Laptop resume metadata failed strict validation.",
      artifact: "wrong-thread"
    },
    {
      outcome: "access_denied",
      status: "Laptop command access blocked",
      detail: "Secure read access to laptop resume metadata was rejected.",
      artifact: "access-denied"
    }
  ] as const satisfies readonly Readonly<{
    outcome: Exclude<LaptopResumeApiOutcome, "available" | "long_command" | "long_reason" | "pending">;
    status: string;
    detail: string;
    artifact: string;
  }>[];

  for (const [index, selectedCase] of cases.entries()) {
    if (index > 0) {
      fixture.resume.setOutcome(selectedCase.outcome);
      await dialog.getByRole("button", { name: "Check again" }).click();
    }
    await expect(dialog.getByText(selectedCase.status, { exact: true })).toBeVisible();
    await expect(dialog.getByText(selectedCase.detail, { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Check again" })).toBeEnabled();
    await expect(dialog.locator("code")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: /copy/iu })).toHaveCount(0);
    expect(fixture.resume.requests()).toHaveLength(index + 1);
    await page.waitForTimeout(40);
    expect(fixture.resume.requests()).toHaveLength(index + 1);
    await capture(page, `state-${selectedCase.artifact}-390x844.png`);
  }

  expect(await clipboardState(page)).toEqual({ attempts: [], failuresRemaining: 0, writes: [] });
  await expect(dialog).not.toContainText(
    /PRIVATE resume|\/workspace\/resume|thread-private-browser-resume-foreign|private_extra/iu
  );
  await expectResumePrivacy(page, laptopResumeBrowserCommand, false);
  await expectCleanBrowser(diagnostics, [
    /status of 403/iu,
    /status of 404/iu,
    /status of 409/iu,
    /status of 429/iu,
    /status of 500/iu,
    /status of 503/iu,
    /status of 504/iu
  ]);
});

for (const independenceCase of [
  {
    name: "active-turn",
    variant: "writable",
    turnState: "in_progress",
    interruptEnabled: true
  },
  {
    name: "read-only",
    variant: "read_only",
    turnState: "idle",
    interruptEnabled: false
  },
  {
    name: "host-locked",
    variant: "locked",
    turnState: "idle",
    interruptEnabled: false
  }
] as const) {
  test(`keeps ${independenceCase.name} laptop resume independent from mutation gates`, async ({
    page
  }) => {
    const diagnostics = observePage(page);
    const fixture = await openReadyResume(page, independenceCase);
    await page.getByRole("button", { name: "Open session actions" }).click();
    const menu = actionsDialog(page, "Session actions");
    await expect(resumeAction(menu)).toBeEnabled();
    if (independenceCase.interruptEnabled) {
      await expect(menu.getByRole("button", { name: /Interrupt active turn/iu })).toBeEnabled();
    } else {
      await expect(menu.getByRole("button", { name: /Interrupt active turn/iu })).toBeDisabled();
    }
    await resumeAction(menu).click();
    const dialog = actionsDialog(page, "Resume on laptop");
    await expect(dialog.locator("code")).toHaveText(laptopResumeBrowserCommand);
    await dialog.getByRole("button", { name: "Copy command" }).click();
    await expect(dialog.getByText("Command copied", { exact: true })).toBeVisible();
    expect(fixture.resume.requests()).toHaveLength(1);
    expect((await clipboardState(page)).writes).toEqual([laptopResumeBrowserCommand]);
    await capture(page, `independent-${independenceCase.name}-390x844.png`);
    await expectCleanBrowser(diagnostics);
  });
}

test("disables stale Session Detail before any resume read or clipboard write", async ({ page }) => {
  const diagnostics = observePage(page);
  const fixture = await openReadyResume(page, { variant: "stale_session" });
  await page.getByRole("button", { name: "Open session actions" }).click();
  const dialog = actionsDialog(page, "Session actions");
  const resume = resumeAction(dialog);
  await expect(resume).toBeDisabled();
  await expect(
    dialog.getByText(
      "Session state is stale. Refresh Session Detail before loading a laptop command.",
      { exact: true }
    )
  ).toBeVisible();
  expect(fixture.resume.requests()).toHaveLength(0);
  expect(await clipboardState(page)).toEqual({ attempts: [], failuresRemaining: 0, writes: [] });
  await capture(page, "disabled-stale-session-390x844.png");
  await expectCleanBrowser(diagnostics);
});

test("contains maximum remote and reason content across mobile, short, desktop, and 200 percent reflow", async ({
  page
}) => {
  test.setTimeout(60_000);
  const diagnostics = observePage(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const fixture = await openReadyResume(page, {
    outcome: "long_command",
    variant: "writable_long"
  });
  await openResume(page);
  let dialog = actionsDialog(page, "Resume on laptop");
  expect(laptopResumeBrowserLongRemote).toHaveLength(selectedResumeRemoteMaxLength);
  await expect(dialog.locator("code")).toHaveText(laptopResumeBrowserLongCommand);
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
      state: "long-command",
      requestedViewport: viewport,
      geometry: await expectResumeGeometry(page)
    });
    await capture(page, `long-command-${viewport.width}x${viewport.height}.png`);
  }

  for (const viewport of [
    { width: 320, height: 480 },
    { width: 390, height: 420 }
  ]) {
    await page.setViewportSize(viewport);
    measurements.push({
      state: "long-command-short",
      requestedViewport: viewport,
      geometry: await expectResumeGeometry(page)
    });
    await page.locator(".hostdeck-session-actions__scroller").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(dialog.getByRole("button", { name: "Copy command" })).toBeVisible();
    await capture(page, `long-command-short-${viewport.width}x${viewport.height}.png`);
  }

  await page.locator(".hostdeck-session-actions__scroller").evaluate((element) => {
    element.scrollTop = 0;
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
    state: "long-command-zoom-200",
    requestedViewport: {
      width: 1280,
      height: 800,
      effectiveWidth: 640,
      effectiveHeight: 400
    },
    geometry: await expectResumeGeometry(page)
  });
  const zoomCapture = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false
  });
  await writeFile(
    resolve(artifactDirectory, "long-command-zoom-200-1280x800.png"),
    Buffer.from(zoomCapture.data, "base64")
  );

  fixture.resume.setOutcome("long_reason");
  await dialog.getByRole("button", { name: "Back to session actions" }).click();
  await resumeAction(actionsDialog(page, "Session actions")).click();
  dialog = actionsDialog(page, "Resume on laptop");
  await expect(dialog.getByText(laptopResumeBrowserLongUnavailableReason, { exact: true }))
    .toBeVisible();
  await expect(dialog.locator("code")).toHaveCount(0);
  measurements.push({
    state: "long-reason-zoom-200",
    requestedViewport: {
      width: 1280,
      height: 800,
      effectiveWidth: 640,
      effectiveHeight: 400
    },
    geometry: await expectResumeGeometry(page)
  });
  await capture(page, "long-reason-zoom-200-1280x800.png");
  await page.locator(".hostdeck-session-actions__scroller").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(dialog.getByRole("button", { name: "Check again" })).toBeVisible();
  await capture(page, "long-reason-scrolled-zoom-200-1280x800.png");
  await writeFile(
    resolve(artifactDirectory, "layout-measurements.json"),
    `${JSON.stringify({ measurements }, null, 2)}\n`,
    "utf8"
  );

  expect(fixture.resume.requests()).toHaveLength(2);
  expect(await clipboardState(page)).toEqual({ attempts: [], failuresRemaining: 0, writes: [] });
  await expectResumePrivacy(page, laptopResumeBrowserLongCommand, false);
  await expectCleanBrowser(diagnostics);
});

interface OpenReadyResumeOptions {
  readonly interruptEnabled?: boolean;
  readonly outcome?: LaptopResumeApiOutcome;
  readonly turnState?: SessionDetailTurnState;
  readonly variant?: SessionDetailApiVariant;
}

async function openReadyResume(page: Page, options: OpenReadyResumeOptions = {}) {
  const turnState = options.turnState ?? "idle";
  const events = turnState === "idle" ? [] : [promptTurnEvent(1, turnState)];
  const detailOptions: SessionDetailApiOptions = {
    initialEvents: events,
    streamEvents: events,
    turnState
  };
  const detail = await installSessionDetailApi(
    page,
    options.variant ?? "writable",
    detailOptions
  );
  const resume = await installLaptopResumeApi(page);
  resume.setOutcome(options.outcome ?? "available");
  await page.goto(detailPath);
  await expect(page.getByRole("button", { name: "Open session actions" })).toBeVisible();
  return Object.freeze({ detail, resume });
}

async function openResume(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open session actions" }).click();
  await resumeAction(actionsDialog(page, "Session actions")).click();
  await expect(actionsDialog(page, "Resume on laptop").getByText(
    "Laptop terminal only",
    { exact: true }
  )).toBeVisible();
}

function actionsDialog(page: Page, name: string): Locator {
  return page.getByRole("dialog", { name, exact: true });
}

function resumeAction(dialog: Locator): Locator {
  return dialog.getByRole("button", { name: /Resume on laptop/iu });
}

function requiredRequest(requests: readonly Request[], index: number): Request {
  const request = requests[index];
  if (request === undefined) throw new TypeError("Expected laptop-resume request is missing.");
  return request;
}

function expectResumeRequest(request: Request): void {
  const url = new URL(request.url());
  expect(request.method()).toBe("GET");
  expect(url).toMatchObject({
    origin: "http://127.0.0.1:4175",
    pathname: `/api/v1/sessions/${sessionDetailBrowserSessionId}/resume`,
    search: "",
    hash: ""
  });
  expect(request.postData()).toBeNull();
  expect(request.headers()["x-hostdeck-csrf"]).toBeUndefined();
  expect(request.headers()["x-hostdeck-csrf-generation"]).toBeUndefined();
}

async function installClipboardFixture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let failuresRemaining = 0;
    const attempts: string[] = [];
    const writes: string[] = [];
    const clipboard = Object.freeze({
      async writeText(this: unknown, text: unknown): Promise<void> {
        if (this !== clipboard) throw new TypeError("Clipboard receiver is invalid.");
        if (typeof text !== "string") throw new TypeError("Clipboard text is invalid.");
        attempts.push(text);
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          throw new DOMException("Clipboard fixture denied.", "NotAllowedError");
        }
        writes.push(text);
      }
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      enumerable: true,
      value: clipboard
    });
    Object.defineProperty(window, "__hostdeckClipboardFixture", {
      configurable: false,
      enumerable: false,
      value: Object.freeze({
        failNext(count = 1) {
          if (!Number.isSafeInteger(count) || count < 0) {
            throw new TypeError("Clipboard failure count is invalid.");
          }
          failuresRemaining = count;
        },
        snapshot() {
          return Object.freeze({
            attempts: Object.freeze([...attempts]),
            failuresRemaining,
            writes: Object.freeze([...writes])
          });
        }
      })
    });
  });
}

interface ClipboardFixtureRuntime {
  readonly failNext: (count?: number) => void;
  readonly snapshot: () => Readonly<{
    attempts: readonly string[];
    failuresRemaining: number;
    writes: readonly string[];
  }>;
}

async function clipboardState(page: Page) {
  return page.evaluate(() =>
    (
      window as typeof window & {
        readonly __hostdeckClipboardFixture: ClipboardFixtureRuntime;
      }
    ).__hostdeckClipboardFixture.snapshot()
  );
}

async function failNextClipboard(page: Page): Promise<void> {
  await page.evaluate(() =>
    (
      window as typeof window & {
        readonly __hostdeckClipboardFixture: ClipboardFixtureRuntime;
      }
    ).__hostdeckClipboardFixture.failNext()
  );
}

async function expectCommandProjection(page: Page, command: string): Promise<void> {
  const projection = await page.evaluate((exactCommand) => {
    const body = document.body.innerText;
    const sheet = document.querySelector(".hostdeck-session-actions-sheet");
    const code = document.querySelector(".hostdeck-laptop-resume-command code");
    const commandOccurrences = body.split(exactCommand).length - 1;
    const socket = exactCommand.match(/unix:\/\/[^'\s]+/u)?.[0] ?? "";
    const thread = exactCommand.match(/thread-[^'\s]+/u)?.[0] ?? "";
    return {
      commandOccurrences,
      codeText: code?.textContent ?? null,
      dialogCount: document.querySelectorAll('[role="dialog"]').length,
      inputCount:
        sheet?.querySelectorAll("input, textarea, [contenteditable='true']").length ?? -1,
      socketOccurrences: socket === "" ? 0 : body.split(socket).length - 1,
      threadOccurrences: thread === "" ? 0 : body.split(thread).length - 1
    };
  }, command);
  expect(projection).toEqual({
    commandOccurrences: 1,
    codeText: command,
    dialogCount: 1,
    inputCount: 0,
    socketOccurrences: 1,
    threadOccurrences: 1
  });
}

async function expectResumeGeometry(page: Page) {
  const geometry = await page.evaluate(() => {
    const sheet = document.querySelector<HTMLElement>(".hostdeck-session-actions-sheet");
    const body = document.querySelector<HTMLElement>(".hostdeck-session-actions__body");
    const scroller = document.querySelector<HTMLElement>(
      ".hostdeck-session-actions__scroller"
    );
    const footer = document.querySelector<HTMLElement>(".hostdeck-session-actions__footer");
    const command = document.querySelector<HTMLElement>(".hostdeck-laptop-resume-command code");
    if (sheet === null || body === null || scroller === null || footer === null) {
      throw new TypeError("Laptop-resume geometry is unavailable.");
    }
    const sheetRect = sheet.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
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
        clientWidth: sheet.clientWidth,
        left: sheetRect.left,
        right: sheetRect.right,
        scrollWidth: sheet.scrollWidth,
        top: sheetRect.top
      },
      body: {
        clientWidth: body.clientWidth,
        overflow: getComputedStyle(body).overflow,
        scrollWidth: body.scrollWidth
      },
      scroller: {
        clientWidth: scroller.clientWidth,
        overflowY: getComputedStyle(scroller).overflowY,
        scrollWidth: scroller.scrollWidth
      },
      footer: {
        bottom: footerRect.bottom,
        top: footerRect.top
      },
      command: command === null
        ? null
        : {
            borderRadius: Number.parseFloat(getComputedStyle(command).borderRadius),
            clientWidth: command.clientWidth,
            scrollWidth: command.scrollWidth
          },
      targets
    };
  });
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
  expect(geometry.footer.bottom).toBeLessThanOrEqual(geometry.sheet.bottom + 0.5);
  for (const target of geometry.targets) {
    expect(target.height).toBeGreaterThanOrEqual(44);
    expect(target.width).toBeGreaterThanOrEqual(44);
  }
  if (geometry.command !== null) {
    expect(geometry.command.scrollWidth).toBeLessThanOrEqual(geometry.command.clientWidth);
    expect(geometry.command.borderRadius).toBeLessThanOrEqual(6);
  }
  return geometry;
}

async function expectResumePrivacy(
  page: Page,
  command: string,
  commandVisible: boolean
): Promise<void> {
  const privacy = await page.evaluate((exactCommand) => ({
    bodyOccurrences: document.body.innerText.split(exactCommand).length - 1,
    historyState: JSON.stringify(history.state),
    localStorage: Object.keys(localStorage),
    sessionStorage: Object.keys(sessionStorage),
    url: window.location.href
  }), command);
  expect(privacy.bodyOccurrences).toBe(commandVisible ? 1 : 0);
  expect(privacy.historyState).not.toContain(command);
  expect(privacy.localStorage).toEqual([]);
  expect(privacy.sessionStorage).toEqual([]);
  expect(privacy.url).toBe(`http://127.0.0.1:4175${detailPath}`);
  expect(privacy.url).not.toMatch(/resume|thread-private|unix%3A|app-server/iu);
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

async function expectCleanBrowser(
  diagnostics: ReturnType<typeof observePage>,
  allowedConsoleErrors: readonly RegExp[] = []
): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  expect(diagnostics.externalRequests).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
  expect(
    diagnostics.consoleErrors.filter(
      (message) => !allowedConsoleErrors.some((pattern) => pattern.test(message))
    )
  ).toEqual([]);
}

async function capture(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: resolve(artifactDirectory, name),
    animations: "disabled"
  });
}
