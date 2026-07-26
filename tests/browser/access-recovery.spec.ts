import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page, type Request, test } from "@playwright/test";
import {
  installSessionDetailApi,
  type SessionDetailApiController,
  sessionDetailBrowserSessionId
} from "./session-detail-fixture.js";

const artifactDirectory = resolve("artifacts/fe-v1-031-csrf-reload-recovery");
const detailPath = `/sessions/${sessionDetailBrowserSessionId}`;
const visualReviewTime = new Date("2026-07-26T05:00:00.000Z");
const rawCsrfToken = "D".repeat(43);
const privateDeviceId = "device_detail_phone";

test.beforeAll(async () => {
  await mkdir(artifactDirectory, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(visualReviewTime);
});

test("shows initial checking, automatic bootstrap, failure, direct retry, and recovery", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const api = await installSessionDetailApi(page, "writable");
  api.holdNextAccess();
  await page.goto(detailPath);
  await expect.poll(() => api.hasPendingAccess()).toBe(true);

  await openHostAccess(page);
  const dialog = hostAccessDialog(page);
  await expect(dialog.getByText("Checking page security", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Checking", { exact: true }).last()).toBeVisible();
  await capture(page, "initial-checking-390x844.png");

  api.setCsrfOutcome("pending");
  api.releasePendingAccess();
  await expect.poll(() => api.hasPendingCsrf()).toBe(true);
  await expect(dialog.getByText("Securing this page", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Securing", { exact: true }).last()).toBeVisible();
  await capture(page, "automatic-bootstrap-390x844.png");

  api.releasePendingCsrf("failure");
  const retry = dialog.getByRole("button", { name: "Retry secure setup" });
  await expect(retry).toBeEnabled();
  await expect(dialog.locator('.hostdeck-access-recovery[role="alert"]'))
    .toContainText("Secure setup not confirmed");
  await capture(page, "bootstrap-failed-390x844.png");

  await retry.click();
  await expect.poll(() => api.hasPendingCsrf()).toBe(true);
  await expect(retry).toBeDisabled();
  await expect(retry).toHaveAttribute("aria-busy", "true");
  await expect(dialog.getByText("Securing this page", { exact: true })).toBeVisible();
  await capture(page, "direct-retry-securing-390x844.png");

  api.releasePendingCsrf("success");
  await expect(dialog.getByText("Page security recovered", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Ready", { exact: true }).first()).toBeVisible();
  await expect(retry).toHaveCount(0);
  await capture(page, "direct-retry-recovered-390x844.png");

  const rotations = csrfRequests(api);
  expect(rotations).toHaveLength(2);
  for (const request of rotations) expectBootstrapRequest(request);
  expect(productMutationRequests(api)).toHaveLength(0);
  await expectCredentialPrivacy(page);
  await expectCleanBrowser(diagnostics, [/status of 503 \(Service Unavailable\)/u]);
});

test("bootstraps exactly once per writer reload and never rotates for read-only or denied access", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const api = await installSessionDetailApi(page, "writable");

  await page.goto(detailPath);
  await expect(page.getByText("Ready to send", { exact: true })).toBeVisible();
  expect(csrfRequests(api)).toHaveLength(1);
  await page.reload();
  await expect(page.getByText("Ready to send", { exact: true })).toBeVisible();
  expect(csrfRequests(api)).toHaveLength(2);
  await openHostAccess(page);
  await expect(hostAccessDialog(page).getByText("Page security ready", { exact: true }))
    .toBeVisible();
  await capture(page, "reload-ready-390x844.png");

  api.setVariant("read_only");
  await page.reload();
  await expect(page.getByText("Read-only access cannot send prompts.", { exact: true }))
    .toBeVisible();
  await openHostAccess(page);
  await expect(hostAccessDialog(page).getByText("This device has read-only access.", { exact: true }))
    .toBeVisible();
  await expectNoRecoveryAction(page);
  await capture(page, "read-only-390x844.png");
  expect(csrfRequests(api)).toHaveLength(2);

  api.setVariant("locked");
  await page.reload();
  await openHostAccess(page);
  await expect(hostAccessDialog(page).getByRole("heading", { name: "Remote writes are locked" }))
    .toBeVisible();
  await expect(hostAccessDialog(page).getByText("Page security ready", { exact: true }))
    .toBeVisible();
  await capture(page, "locked-page-security-ready-390x844.png");
  expect(csrfRequests(api)).toHaveLength(3);

  api.setVariant("expired");
  await page.reload();
  await openHostAccess(page);
  await expect(hostAccessDialog(page).getByRole("heading", { name: "Pairing expired" }))
    .toBeVisible();
  await expectNoRecoveryAction(page);
  await capture(page, "expired-390x844.png");
  expect(csrfRequests(api)).toHaveLength(3);

  api.setVariant("denied");
  await page.reload();
  await openHostAccess(page);
  await expect(hostAccessDialog(page).getByRole("heading", { name: "Device access was revoked" }))
    .toBeVisible();
  await expectNoRecoveryAction(page);
  await capture(page, "revoked-390x844.png");
  expect(csrfRequests(api)).toHaveLength(3);
  await expect(page.getByText("android-release", { exact: true })).toHaveCount(0);

  for (const request of csrfRequests(api)) expectBootstrapRequest(request);
  expect(productMutationRequests(api)).toHaveLength(0);
  await expectCredentialPrivacy(page);
  await expectCleanBrowser(diagnostics);
});

test("recovers stale-generation authority through one refresh and one bootstrap without replay", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const api = await installSessionDetailApi(page, "writable");
  api.setPromptOutcome("stale_generation");
  await page.goto(detailPath);
  await expect(page.getByText("Ready to send", { exact: true })).toBeVisible();

  const textarea = page.getByRole("textbox", { name: "Prompt for android-release" });
  await textarea.fill("This failed prompt must not be replayed by access recovery.");
  await page.getByRole("button", { name: "Send prompt to android-release" }).click();
  await expect(page.getByText("Another prompt operation is still being reconciled.", { exact: true }))
    .toBeVisible();
  expect(api.promptRequests()).toHaveLength(1);

  await openHostAccess(page);
  const dialog = hostAccessDialog(page);
  const checkAccess = dialog.getByRole("button", { name: "Check access" });
  await expect(checkAccess).toBeEnabled();
  await expect(dialog.getByText("Current access must be checked", { exact: true })).toBeVisible();
  await capture(page, "stale-generation-check-required-390x844.png", [textarea]);

  api.holdNextAccess();
  api.setCsrfOutcome("pending");
  await checkAccess.click();
  await expect.poll(() => api.hasPendingAccess()).toBe(true);
  await expect(dialog.getByText("Checking current access", { exact: true })).toBeVisible();
  await expect(checkAccess).toBeDisabled();
  await capture(page, "stale-generation-checking-390x844.png", [textarea]);

  api.releasePendingAccess("success");
  await expect.poll(() => api.hasPendingCsrf()).toBe(true);
  await expect(dialog.getByText("Securing this page", { exact: true })).toBeVisible();
  await expect(checkAccess).toBeDisabled();
  await capture(page, "stale-generation-securing-390x844.png", [textarea]);

  api.releasePendingCsrf("success");
  await expect(dialog.getByText("Page security recovered", { exact: true })).toBeVisible();
  await expect(checkAccess).toHaveCount(0);
  await capture(page, "stale-generation-recovered-390x844.png", [textarea]);

  expect(api.promptRequests()).toHaveLength(1);
  expect(csrfRequests(api)).toHaveLength(2);
  expect(accessRequests(api)).toHaveLength(2);
  expect(productMutationRequests(api)).toHaveLength(1);
  expect(new URL(productMutationRequests(api)[0]?.url() ?? "").pathname)
    .toBe(`/api/v1/sessions/${sessionDetailBrowserSessionId}/prompts`);
  await expectCredentialPrivacy(page);
  await expectCleanBrowser(diagnostics, [/status of 409 \(Conflict\)/u]);
});

test("retains stale read-only truth after an explicit offline access check", async ({ page }) => {
  const diagnostics = observePage(page);
  const api = await installSessionDetailApi(page, "writable");
  api.setPromptOutcome("stale_generation");
  await page.goto(detailPath);
  const textarea = page.getByRole("textbox", { name: "Prompt for android-release" });
  await textarea.fill("One request only.");
  await page.getByRole("button", { name: "Send prompt to android-release" }).click();
  await expect(page.getByText("Another prompt operation is still being reconciled.", { exact: true }))
    .toBeVisible();

  await openHostAccess(page);
  const dialog = hostAccessDialog(page);
  api.holdNextAccess();
  await dialog.getByRole("button", { name: "Check access" }).click();
  await expect.poll(() => api.hasPendingAccess()).toBe(true);
  api.releasePendingAccess("failure");

  await expect(dialog.locator('.hostdeck-access-recovery[role="alert"]'))
    .toContainText("Access check not confirmed");
  await expect(dialog.getByRole("button", { name: "Check access" })).toBeEnabled();
  await expect(dialog.getByText("Stale", { exact: true }).first()).toBeVisible();
  await capture(page, "refresh-failed-offline-390x844.png", [textarea]);

  expect(api.promptRequests()).toHaveLength(1);
  expect(csrfRequests(api)).toHaveLength(1);
  expect(accessRequests(api)).toHaveLength(2);
  await expectCredentialPrivacy(page);
  await expectCleanBrowser(diagnostics, [
    /status of 409 \(Conflict\)/u,
    /status of 503 \(Service Unavailable\)/u
  ]);
});

test("suppresses recovered copy for an old target while shared page setup settles", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const api = await installSessionDetailApi(page, "writable");
  api.setPromptOutcome("stale_generation");
  await page.goto(detailPath);
  const textarea = page.getByRole("textbox", { name: "Prompt for android-release" });
  await textarea.fill("Target replacement must not replay this request.");
  await page.getByRole("button", { name: "Send prompt to android-release" }).click();
  await expect(page.getByText("Another prompt operation is still being reconciled.", { exact: true }))
    .toBeVisible();

  await openHostAccess(page);
  const dialog = hostAccessDialog(page);
  api.setCsrfOutcome("pending");
  await dialog.getByRole("button", { name: "Check access" }).click();
  await expect.poll(() => api.hasPendingCsrf()).toBe(true);
  await expect(dialog.getByText("Securing this page", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Close Host and access" }).click();
  await page.getByRole("button", { name: "Back to Mission Control" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Mission Control" })).toBeVisible();

  api.releasePendingCsrf("success");
  await openHostAccess(page);
  await expect(hostAccessDialog(page).getByText("Page security ready", { exact: true }))
    .toBeVisible();
  await expect(hostAccessDialog(page).getByText("Page security recovered", { exact: true }))
    .toHaveCount(0);
  await hostAccessDialog(page).locator(".hostdeck-access-recovery").scrollIntoViewIfNeeded();
  await capture(page, "target-change-current-page-390x844.png");

  expect(api.promptRequests()).toHaveLength(1);
  expect(csrfRequests(api)).toHaveLength(2);
  expect(productMutationRequests(api)).toHaveLength(1);
  await expectCredentialPrivacy(page);
  await expectCleanBrowser(diagnostics, [/status of 409 \(Conflict\)/u]);
});

test("contains the Focus Rail recovery surface across reference, short-height, and 200 percent views", async ({
  page
}) => {
  const diagnostics = observePage(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const api = await installSessionDetailApi(page, "writable_long");
  api.setCsrfOutcome("failure");
  await page.goto(detailPath);
  await openHostAccess(page);
  await expect(hostAccessDialog(page).getByRole("button", { name: "Retry secure setup" }))
    .toBeEnabled();

  const measurements: unknown[] = [];
  for (const viewport of [
    { width: 320, height: 800 },
    { width: 360, height: 800 },
    { width: 390, height: 844 },
    { width: 412, height: 915 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 }
  ]) {
    await page.setViewportSize(viewport);
    measurements.push(await measureRecoveryLayout(page, viewport));
    await capture(page, `recovery-${viewport.width}x${viewport.height}.png`);
  }

  await page.setViewportSize({ width: 390, height: 420 });
  measurements.push(await measureRecoveryLayout(page, { width: 390, height: 420 }));
  await capture(page, "recovery-short-height-390x420.png");

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 640,
    height: 400,
    screenWidth: 1280,
    screenHeight: 800,
    deviceScaleFactor: 2,
    mobile: false
  });
  measurements.push(
    await measureRecoveryLayout(page, {
      width: 1280,
      height: 800,
      effectiveWidth: 640,
      effectiveHeight: 400,
      zoom: 2
    })
  );
  const zoomCapture = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false
  });
  await writeFile(
    resolve(artifactDirectory, "recovery-zoom-200-1280x800.png"),
    Buffer.from(zoomCapture.data, "base64")
  );
  await writeFile(
    resolve(artifactDirectory, "layout-measurements.json"),
    `${JSON.stringify({ measurements }, null, 2)}\n`,
    "utf8"
  );

  expect(productMutationRequests(api)).toHaveLength(0);
  await expectCredentialPrivacy(page);
  await expectCleanBrowser(diagnostics, [/status of 503 \(Service Unavailable\)/u]);
});

async function openHostAccess(page: Page): Promise<void> {
  const dialog = hostAccessDialog(page);
  if (await dialog.isVisible()) return;
  await page.getByRole("button", { name: "Open Host and access" }).click();
  await expect(dialog).toBeVisible();
}

function hostAccessDialog(page: Page) {
  return page.getByRole("dialog", { name: "Host & access" });
}

async function expectNoRecoveryAction(page: Page): Promise<void> {
  const dialog = hostAccessDialog(page);
  await expect(
    dialog.getByRole("button", {
      name: /^(Secure this page|Retry secure setup|Check access)$/u
    })
  ).toHaveCount(0);
}

function csrfRequests(api: SessionDetailApiController): readonly Request[] {
  return api.requests.filter((request) => {
    const url = new URL(request.url());
    return request.method() === "POST" && url.pathname === "/api/v1/access/csrf";
  });
}

function accessRequests(api: SessionDetailApiController): readonly Request[] {
  return api.requests.filter((request) => {
    const url = new URL(request.url());
    return request.method() === "GET" && url.pathname === "/api/v1/access";
  });
}

function productMutationRequests(api: SessionDetailApiController): readonly Request[] {
  return api.requests.filter((request) => {
    const url = new URL(request.url());
    return request.method() !== "GET" && url.pathname !== "/api/v1/access/csrf";
  });
}

function expectBootstrapRequest(request: Request): void {
  expect(request.method()).toBe("POST");
  expect(new URL(request.url())).toMatchObject({
    origin: "http://127.0.0.1:4175",
    pathname: "/api/v1/access/csrf",
    search: "",
    hash: ""
  });
  expect(request.headers()).not.toHaveProperty("x-hostdeck-csrf");
  expect(request.headers()).not.toHaveProperty("x-hostdeck-csrf-generation");
  expect(request.postDataJSON()).toEqual({
    operation_id: expect.stringMatching(/^op_browser_csrf_bootstrap_[0-9a-f]{32}$/u)
  });
}

async function capture(
  page: Page,
  filename: string,
  masks: readonly ReturnType<Page["locator"]>[] = []
): Promise<void> {
  await page.screenshot({
    path: resolve(artifactDirectory, filename),
    animations: "disabled",
    mask: [...masks],
    maskColor: "#111315"
  });
}

async function measureRecoveryLayout(
  page: Page,
  viewport: Readonly<Record<string, number>>
): Promise<unknown> {
  const dialog = hostAccessDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.evaluate((element) => {
    element.scrollTop = 0;
  });
  const close = dialog.getByRole("button", { name: "Close Host and access" });
  await expect(close).toBeVisible();
  const closeAtTop = await close.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
      width: rect.width,
      height: rect.height
    };
  });
  const action = dialog.getByRole("button", { name: "Retry secure setup" });
  await action.scrollIntoViewIfNeeded();
  await expect(action).toBeVisible();
  await expectNoHorizontalOverflow(page);
  const measurement = await page.evaluate(() => {
    const sheet = document.querySelector<HTMLElement>(".hostdeck-sheet");
    const recovery = document.querySelector<HTMLElement>(".hostdeck-access-recovery");
    const action = document.querySelector<HTMLElement>(".hostdeck-access-recovery__action");
    const close = document.querySelector<HTMLElement>(
      'button[aria-label="Close Host and access"]'
    );
    if (sheet === null || recovery === null || action === null || close === null) {
      throw new TypeError("HostDeck recovery layout fixture is incomplete.");
    }
    const rect = (element: HTMLElement) => {
      const value = element.getBoundingClientRect();
      return {
        top: value.top,
        right: value.right,
        bottom: value.bottom,
        left: value.left,
        width: value.width,
        height: value.height
      };
    };
    return {
      document: {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth
      },
      sheet: {
        ...rect(sheet),
        clientHeight: sheet.clientHeight,
        scrollHeight: sheet.scrollHeight,
        overflowY: getComputedStyle(sheet).overflowY
      },
      recovery: rect(recovery),
      action: rect(action),
      closeAfterActionScroll: rect(close),
      viewportHeight: window.innerHeight
    };
  });
  expect(measurement.document.scrollWidth).toBe(measurement.document.clientWidth);
  expect(measurement.sheet.left).toBeGreaterThanOrEqual(0);
  expect(measurement.sheet.right).toBeLessThanOrEqual(measurement.document.clientWidth);
  expect(measurement.action.height).toBeGreaterThanOrEqual(44);
  expect(closeAtTop.height).toBeGreaterThanOrEqual(44);
  expect(closeAtTop.width).toBeGreaterThanOrEqual(44);
  expect(closeAtTop.top).toBeGreaterThanOrEqual(0);
  expect(closeAtTop.bottom).toBeLessThanOrEqual(measurement.viewportHeight);
  expect(measurement.action.left).toBeGreaterThanOrEqual(measurement.sheet.left);
  expect(measurement.action.right).toBeLessThanOrEqual(measurement.sheet.right);
  expect(measurement.action.top).toBeGreaterThanOrEqual(0);
  expect(measurement.action.bottom).toBeLessThanOrEqual(measurement.viewportHeight);
  expect(measurement.sheet.overflowY).toBe("auto");
  return { viewport, closeAtTop, ...measurement };
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  expect(dimensions.scrollWidth).toBe(dimensions.clientWidth);
}

async function expectCredentialPrivacy(page: Page): Promise<void> {
  const state = await page.evaluate(() => ({
    body: document.body.innerText,
    markup: document.body.innerHTML,
    history: JSON.stringify(history.state),
    local: localStorage.length,
    session: sessionStorage.length
  }));
  for (const value of [state.body, state.markup, state.history]) {
    expect(value).not.toContain(rawCsrfToken);
    expect(value).not.toContain(privateDeviceId);
    expect(value).not.toMatch(/x-hostdeck-csrf|csrf_generation|csrf_token/iu);
  }
  expect(state.local).toBe(0);
  expect(state.session).toBe(0);
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
  expect(diagnostics.pageErrors).toEqual([]);
  for (const message of diagnostics.consoleErrors) {
    expect(allowedConsoleErrors.some((pattern) => pattern.test(message)), message).toBe(true);
  }
}
