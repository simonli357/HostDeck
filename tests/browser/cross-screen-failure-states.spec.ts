import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  installMissionControlApi,
  type MissionApiController
} from "./mission-control-fixture.js";
import {
  installRuntimeCompatibilityHost,
  type RuntimeCompatibilityFixtureVariant
} from "./runtime-compatibility-fixture.js";
import {
  installSessionDetailApi,
  type SessionDetailApiController,
  type SessionDetailTurnState,
  sessionDetailBrowserSessionId
} from "./session-detail-fixture.js";

const artifactDirectory = resolve("artifacts/fe-v1-015-cross-screen-failure-states");
const detailPath = `/sessions/${sessionDetailBrowserSessionId}`;
const visualReviewTime = new Date("2026-07-27T18:30:00.000Z");
const layoutMeasurements: Array<Record<string, unknown>> = [];

test.beforeAll(async () => {
  await mkdir(artifactDirectory, { recursive: true });
});

test.afterAll(async () => {
  await writeFile(
    resolve(artifactDirectory, "layout-measurements.json"),
    `${JSON.stringify(layoutMeasurements, null, 2)}\n`,
    "utf8"
  );
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(visualReviewTime);
});

test("keeps Mission Control failure, stale, recovery, purge, and generic network truth distinct", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const api = await installMissionControlApi(page, "failure_matrix");
  await page.goto("/");

  await expectMissionRow(page, "state-unknown", "Unknown");
  await expectMissionRow(page, "state-failed", "Failed");
  await expectMissionRow(page, "state-interrupted", "Interrupted");
  await expectMissionRow(page, "state-incompatible", "Incompatible");
  await expectMissionRow(page, "state-stale", "Stale");
  await expect(page.getByText("Quiet", { exact: true })).toHaveCount(0);
  await capture(page, "mission-failure-family-390x844.png");

  const sessionReadsBeforeFailure = requestCount(api, "/api/v1/sessions");
  api.setVariant("session_unavailable");
  await page.getByRole("button", { name: "Refresh sessions" }).click();
  await expect(page.getByText("Showing stale session state", { exact: true })).toBeVisible();
  await expect(page.getByText(/Session list last confirmed/u)).toBeVisible();
  await expectMissionRow(page, "state-unknown", "Unknown");
  expect(requestCount(api, "/api/v1/sessions")).toBe(sessionReadsBeforeFailure + 1);
  await page.waitForTimeout(200);
  expect(requestCount(api, "/api/v1/sessions")).toBe(sessionReadsBeforeFailure + 1);
  await capture(page, "mission-stale-390x844.png");

  api.setVariant("failure_matrix");
  await page.getByRole("button", { name: "Refresh sessions" }).click();
  await expect(
    page.getByText("Previous session-list issue recovered", { exact: true })
  ).toBeVisible();
  await expect(page.getByText(/Session list is current again/u)).toBeVisible();
  await expect(page.getByText("Current", { exact: true })).toBeVisible();
  await capture(page, "mission-recovered-390x844.png");

  api.setVariant("denied");
  await page.getByRole("button", { name: "Refresh sessions" }).click();
  await expect(page.getByText("Device access is invalid", { exact: true })).toBeVisible();
  await expect(page.getByText("Previous session-list issue recovered", { exact: true }))
    .toHaveCount(0);
  await expect(page.getByRole("link", { name: /^state-/u })).toHaveCount(0);
  await capture(page, "mission-authority-purged-390x844.png");

  api.setVariant("unavailable");
  await page.reload();
  await expect(page.getByText("Host health is degraded", { exact: true })).toBeVisible();
  await expect(page.locator("main")).not.toContainText("Tailscale profile");
  await expect(page.locator("main")).not.toContainText("Serve");
  await expect(page.locator("main")).not.toContainText("certificate");
  await capture(page, "mission-generic-api-failure-390x844.png");

  await expectPrivateFree(page);
  expectCleanDiagnostics(diagnostics, 2);
});

test("renders unknown, failed, and interrupted detail states with exact control admission", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const api = await installSessionDetailApi(page, "writable", {
    turnState: "unknown"
  });
  const cases = [
    { state: "unknown", label: "Unknown", promptEnabled: false },
    { state: "failed", label: "Failed", promptEnabled: true },
    { state: "interrupted", label: "Interrupted", promptEnabled: true }
  ] as const satisfies ReadonlyArray<{
    state: SessionDetailTurnState;
    label: string;
    promptEnabled: boolean;
  }>;

  for (const [index, selected] of cases.entries()) {
    api.setTurnState(selected.state);
    if (index === 0) await page.goto(detailPath);
    else await page.reload();
    await expect(page.getByText(selected.label, { exact: true }).first()).toBeVisible();
    const prompt = page.getByRole("textbox", { name: "Prompt for android-release" });
    if (selected.promptEnabled) await expect(prompt).toBeEnabled();
    else await expect(prompt).toBeDisabled();
    await expect(page.getByRole("button", { name: "/model for android-release" }))
      .toBeEnabled();
    await expect(page.getByRole("button", { name: "/goal for android-release" }))
      .toBeEnabled();
    await expect(page.getByRole("button", { name: "/plan for android-release" }))
      .toBeEnabled();
    await capture(page, `session-${selected.state}-390x844.png`);
  }

  expect(api.promptRequests()).toHaveLength(0);
  await expectPrivateFree(page);
  expectCleanDiagnostics(diagnostics);
});

test("retains exact stale times and prior access failure until authority or target changes", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const api = await installSessionDetailApi(page, "writable", {
    turnState: "idle"
  });
  await page.goto(detailPath);
  await expect(page.getByRole("textbox", { name: "Prompt for android-release" }))
    .toBeEnabled();

  const accessReadsBeforeFailure = requestCount(api, "/api/v1/access");
  api.holdNextAccess();
  await page.getByRole("button", { name: "Refresh session" }).click();
  await expect.poll(api.hasPendingAccess).toBe(true);
  api.releasePendingAccess("failure");
  await expect(page.getByText("Showing stale session state", { exact: true })).toBeVisible();
  await expect(page.getByText(/Session detail last confirmed/u)).toBeVisible();
  await expect(page.getByText(/Access last confirmed/u)).toBeVisible();
  await expect(page.getByText(/Session state last confirmed/u)).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Prompt for android-release" }))
    .toBeDisabled();
  expect(requestCount(api, "/api/v1/access")).toBe(accessReadsBeforeFailure + 1);
  await page.waitForTimeout(200);
  expect(requestCount(api, "/api/v1/access")).toBe(accessReadsBeforeFailure + 1);
  await capture(page, "session-stale-access-390x844.png");

  await page.getByRole("button", { name: "Refresh session" }).click();
  await expect(
    page.getByText("Previous access issue recovered", { exact: true })
  ).toBeVisible();
  await expect(page.getByText(/Access is current again/u)).toBeVisible();
  await expect(page.getByText("Current", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Prompt for android-release" }))
    .toBeEnabled();
  expect(requestCount(api, "/api/v1/access")).toBe(accessReadsBeforeFailure + 2);
  await capture(page, "session-recovered-access-390x844.png");

  await expectPrivateFree(page);
  expectCleanDiagnostics(diagnostics, 1);
});

test("keeps historical boundary truth while the current activity stream reconnects", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const api = await installSessionDetailApi(page, "boundary");
  await page.goto(detailPath);
  await expect(page.getByText("Earlier activity unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText("History limited", { exact: true }).first()).toBeVisible();

  await api.dropStream();
  await expect(page.getByText("Activity stream reconnecting", { exact: true })).toBeVisible();
  await expect(page.getByText("Reconnecting", { exact: true })).toBeVisible();
  await expect(page.getByText("Earlier activity unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText("History limited", { exact: true }).first()).toBeVisible();
  await capture(page, "session-boundary-reconnecting-390x844.png");

  await expectPrivateFree(page);
  expectCleanDiagnostics(diagnostics);
});

test("keeps retained rows readable under degraded, incompatible, and disconnected runtime truth", async ({
  page
}) => {
  const diagnostics = observePage(page);
  await installMissionControlApi(page, "read_only");
  const host = await installRuntimeCompatibilityHost(
    page,
    "degraded_current",
    "paired_read"
  );
  const cases = [
    ["degraded_current", "Codex compatibility limited", "degraded"],
    ["incompatible", "Codex interface incompatible", "incompatible"],
    ["disconnected", "Codex runtime disconnected", "disconnected"]
  ] as const satisfies ReadonlyArray<
    readonly [RuntimeCompatibilityFixtureVariant, string, string]
  >;

  for (const [index, [variant, title, fileLabel]] of cases.entries()) {
    host.setVariant(variant);
    if (index === 0) await page.goto("/");
    else await page.reload();
    await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /^release-approval/u })).toBeVisible();
    await expect(page.getByText("Current", { exact: true })).toHaveCount(0);
    await capture(page, `mission-runtime-${fileLabel}-390x844.png`);
  }

  await expectPrivateFree(page);
  expectCleanDiagnostics(diagnostics);
});

test("contains the densest stale detail state across selected stress viewports", async ({
  page
}) => {
  const diagnostics = observePage(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const api = await installSessionDetailApi(page, "stale_session", {
    turnState: "idle"
  });
  await page.goto(detailPath);
  await expect(page.getByText("Showing stale session state", { exact: true })).toBeVisible();
  await expect(page.getByText(/Session state last confirmed/u)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Prompt for android-release" }))
    .toBeDisabled();
  await expect(page.getByRole("button", { name: "/model for android-release" }))
    .toBeEnabled();
  await expect(page.getByRole("button", { name: "/goal for android-release" }))
    .toBeEnabled();
  await expect(page.getByRole("button", { name: "/plan for android-release" }))
    .toBeEnabled();

  for (const viewport of [
    { width: 320, height: 480 },
    { width: 390, height: 420 },
    { width: 360, height: 800 },
    { width: 412, height: 915 },
    { width: 768, height: 1024 }
  ] as const) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => window.scrollTo(0, 0));
    await revealNoticeAboveControls(page);
    await expectNoNoticeOcclusion(page);
    await capture(
      page,
      `session-stale-${viewport.width}x${viewport.height}.png`,
      { resetScroll: false }
    );
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.documentElement.style.zoom = "2";
  });
  await expectNoDocumentOverflow(page);
  await revealNoticeAboveControls(page);
  await expectNoNoticeOcclusion(page);
  await page.screenshot({
    path: resolve(artifactDirectory, "session-stale-zoom-200-1280x800.png"),
    animations: "disabled"
  });
  layoutMeasurements.push(await measureLayout(page, "session-stale-zoom-200-1280x800.png"));

  expect(api.promptRequests()).toHaveLength(0);
  await expectPrivateFree(page);
  expectCleanDiagnostics(diagnostics);
});

async function expectMissionRow(
  page: Page,
  name: string,
  state: string
): Promise<void> {
  const row = page.getByRole("link", { name: new RegExp(`^${name}`, "u") });
  await expect(row).toBeVisible();
  await expect(row).toContainText(state);
}

function requestCount(
  api: MissionApiController | SessionDetailApiController,
  pathname: string
): number {
  return api.requests.filter((request) => new URL(request.url()).pathname === pathname).length;
}

async function capture(
  page: Page,
  name: string,
  options: Readonly<{ fullPage?: boolean; resetScroll?: boolean }> = {}
): Promise<void> {
  const { fullPage = false, resetScroll = true } = options;
  await page.evaluate((shouldResetScroll) => {
    if (shouldResetScroll) window.scrollTo(0, 0);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }, resetScroll);
  if (resetScroll) await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expectNoHorizontalOverflow(page);
  await expectStableTargets(page);
  await page.screenshot({
    path: resolve(artifactDirectory, name),
    animations: "disabled",
    fullPage
  });
  layoutMeasurements.push(await measureLayout(page, name));
}

async function measureLayout(page: Page, name: string): Promise<Record<string, unknown>> {
  return page.evaluate((captureName) => {
    const route = document.querySelector(".hostdeck-route");
    if (!(route instanceof HTMLElement)) {
      throw new TypeError("Cross-screen route measurement target is missing.");
    }
    const box = route.getBoundingClientRect();
    const controls = document.querySelector(".hostdeck-session-controls");
    const notice = document.querySelector(".hostdeck-detail-notice");
    const controlsBox = controls instanceof HTMLElement ? controls.getBoundingClientRect() : null;
    const noticeBox = notice instanceof HTMLElement ? notice.getBoundingClientRect() : null;
    return {
      name: captureName,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio
      },
      document: {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        scrollY: Math.round(window.scrollY),
        zoom: getComputedStyle(document.documentElement).zoom
      },
      route: {
        left: Math.round(box.left),
        right: Math.round(box.right),
        top: Math.round(box.top),
        bottom: Math.round(box.bottom),
        width: Math.round(box.width),
        height: Math.round(box.height)
      },
      controls:
        controlsBox === null
          ? null
          : {
              top: Math.round(controlsBox.top),
              bottom: Math.round(controlsBox.bottom),
              height: Math.round(controlsBox.height)
            },
      firstNotice:
        noticeBox === null
          ? null
          : {
              top: Math.round(noticeBox.top),
              bottom: Math.round(noticeBox.bottom),
              height: Math.round(noticeBox.height)
            },
      statusCount: document.querySelectorAll('[role="status"]').length,
      alertCount: document.querySelectorAll('[role="alert"]').length,
      disabledControlCount: document.querySelectorAll("button:disabled, textarea:disabled").length,
      visibleControlCount: [...document.querySelectorAll("button, textarea, a")].filter(
        (element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }
      ).length
    };
  }, name);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const geometry = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  expect(geometry.scrollWidth).toBe(geometry.clientWidth);
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  const geometry = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    document: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth
  }));
  expect(geometry.body).toBeLessThanOrEqual(geometry.viewport);
  expect(geometry.document).toBeLessThanOrEqual(geometry.viewport);
}

async function expectNoNoticeOcclusion(page: Page): Promise<void> {
  const geometry = await page.evaluate(() => {
    const appBar = document.querySelector(".hostdeck-app-bar");
    const controls = document.querySelector(".hostdeck-session-controls");
    const notices = [...document.querySelectorAll(".hostdeck-detail-notice")];
    if (!(appBar instanceof HTMLElement) || !(controls instanceof HTMLElement)) {
      throw new TypeError("Session chrome is unavailable for occlusion inspection.");
    }
    const appBarBox = appBar.getBoundingClientRect();
    const controlsBox = controls.getBoundingClientRect();
    return notices.map((notice) => {
      const box = notice.getBoundingClientRect();
      return {
        top: box.top,
        bottom: box.bottom,
        appBarBottom: appBarBox.bottom,
        controlsTop: controlsBox.top
      };
    });
  });
  for (const notice of geometry) {
    const intersectsControls = notice.bottom > notice.controlsTop;
    expect(intersectsControls, JSON.stringify(notice)).toBe(false);
    expect(notice.top, JSON.stringify(notice)).toBeGreaterThanOrEqual(notice.appBarBottom);
  }
}

async function revealNoticeAboveControls(page: Page): Promise<void> {
  const moved = await page.evaluate(() => {
    const appBar = document.querySelector(".hostdeck-app-bar");
    const controls = document.querySelector(".hostdeck-session-controls");
    const notice = document.querySelector(".hostdeck-detail-notice");
    if (
      !(appBar instanceof HTMLElement) ||
      !(controls instanceof HTMLElement) ||
      !(notice instanceof HTMLElement)
    ) {
      throw new TypeError("Session notice reveal geometry is unavailable.");
    }
    const noticeBox = notice.getBoundingClientRect();
    const controlsBox = controls.getBoundingClientRect();
    if (noticeBox.bottom <= controlsBox.top) return false;
    const appBarBox = appBar.getBoundingClientRect();
    window.scrollBy(0, noticeBox.top - appBarBox.bottom - 8);
    return true;
  });
  if (moved) await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
}

async function expectStableTargets(page: Page): Promise<void> {
  const targets = page.locator(
    ".hostdeck-icon-button:visible, .hostdeck-action-button:visible, .hostdeck-primary-action-dock__command:visible"
  );
  for (let index = 0; index < (await targets.count()); index += 1) {
    const box = await targets.nth(index).boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
}

async function expectPrivateFree(page: Page): Promise<void> {
  const body = await page.locator("body").innerText();
  expect(body).not.toContain("thread-private");
  expect(body).not.toContain("/workspace/");
  expect(body).not.toContain("csrf_token");
  expect(body).not.toContain("opaque-selected-cursor");
}

function observePage(page: Page) {
  const consoleErrors: string[] = [];
  const externalRequests: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== "http://127.0.0.1:4175") externalRequests.push(request.url());
  });
  return { consoleErrors, externalRequests, pageErrors };
}

function expectCleanDiagnostics(
  diagnostics: ReturnType<typeof observePage>,
  expectedServiceUnavailableErrors = 0
): void {
  expect(diagnostics.consoleErrors).toHaveLength(expectedServiceUnavailableErrors);
  for (const message of diagnostics.consoleErrors) {
    expect(message).toBe(
      "Failed to load resource: the server responded with a status of 503 (Service Unavailable)"
    );
  }
  expect(diagnostics.externalRequests).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
}
