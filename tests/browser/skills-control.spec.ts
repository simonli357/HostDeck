import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page, type Request, test } from "@playwright/test";
import { sessionDetailBrowserSessionId } from "./session-detail-fixture.js";
import { installSkillsControlApi } from "./skills-control-fixture.js";

const artifactDirectory = resolve("artifacts/fe-v1-030-read-only-skills-utility");
const detailPath = `/sessions/${sessionDetailBrowserSessionId}`;
const visualReviewTime = new Date("2026-07-27T16:00:00.000Z");

test.beforeAll(async () => {
  await mkdir(artifactDirectory, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(visualReviewTime);
});

test("discovers Skills without prefetch and performs one exact selected-session read", async ({ page }) => {
  const diagnostics = observePage(page);
  const api = await installSkillsControlApi(page);
  await page.goto(detailPath);

  const more = page.getByRole("button", {
    name: "More session utilities for android-release"
  });
  await expect(page.getByRole("button", { name: "/model for android-release" })).toBeVisible();
  await expect(page.getByRole("button", { name: "/goal for android-release" })).toBeVisible();
  await expect(page.getByRole("button", { name: "/plan for android-release" })).toBeVisible();
  await expect(more).toBeVisible();
  await expectDockGeometry(page);
  expect(api.requests()).toHaveLength(0);

  await more.focus();
  await page.keyboard.press("Enter");
  const utilities = page.getByRole("dialog", { name: "Session utilities" });
  await expect(utilities).toBeVisible();
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

  await utilities.getByRole("button", { name: /skills/iu }).click();
  const skills = page.getByRole("dialog", { name: "/skills" });
  await expect(skills.getByText("Skills capture current", { exact: true })).toBeVisible();
  await expect(skills.getByText("Target: android-release", { exact: true })).toBeVisible();
  await expect(skills.getByText("Description not reported", { exact: true })).toBeVisible();
  await expect(skills.getByText("No description provided", { exact: true })).toBeVisible();
  await expect(skills.locator(".hostdeck-skill-row__state")).toHaveText([
    "Enabled",
    "Disabled",
    "Enabled",
    "Enabled"
  ]);
  await expect(skills.getByRole("button", { name: "Back to session utilities" })).toBeFocused();
  await expect(page.locator('[role="dialog"]')).toHaveCount(1);
  expect(api.requests()).toHaveLength(1);
  const request = requiredRequest(api.requests(), 0);
  expectSkillsRequest(request);
  expect(request.postData()).toBeNull();
  expect(request.headers()["x-hostdeck-csrf"]).toBeUndefined();
  expect(request.headers()["x-hostdeck-csrf-generation"]).toBeUndefined();
  await page.screenshot({
    path: resolve(artifactDirectory, "content-390x844.png"),
    animations: "disabled"
  });

  await skills.getByRole("button", { name: "Back to session utilities" }).click();
  await expect(utilities.getByRole("button", { name: /skills/iu })).toBeFocused();
  expect(api.requests()).toHaveLength(1);
  await page.keyboard.press("Escape");
  await expect(utilities).toBeHidden();
  await expect(more).toBeFocused();

  const privacy = await browserPrivacy(page);
  expect(privacy.body).not.toMatch(/thread-private|connection_generation|device_detail_phone/iu);
  expect(privacy.body).not.toMatch(/\/home\/private|\.codex\/skills/iu);
  expect(privacy.historyState).not.toMatch(/thread-private|\.codex\/skills/iu);
  expect(privacy.localStorage).toEqual([]);
  expect(privacy.sessionStorage).toEqual([]);
  expect(privacy.url).toBe(`http://127.0.0.1:4175${detailPath}`);
  await expectCleanBrowser(diagnostics);
});

test("owns loading, stale retention, one explicit refresh, and failed-refresh truth", async ({ page }) => {
  const diagnostics = observePage(page);
  const api = await installSkillsControlApi(page);
  api.setReadOutcome("pending");
  await page.goto(detailPath);
  const skills = await openSkills(page, false);

  await expect(skills.getByText("Loading Skills", { exact: true })).toBeVisible();
  await expect.poll(() => api.hasPendingRead()).toBe(true);
  const refresh = skills.getByRole("button", { name: "Refresh Skills" });
  await expect(refresh).toBeDisabled();
  await refresh.evaluate((button) => (button as HTMLButtonElement).click());
  await page.setViewportSize({ width: 390, height: 843 });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(api.requests()).toHaveLength(1);
  await page.screenshot({
    path: resolve(artifactDirectory, "loading-390x844.png"),
    animations: "disabled"
  });

  api.releaseRead();
  await expect(skills.getByText("Skills capture current", { exact: true })).toBeVisible();
  await refreshSessionDetail(page);
  await expect(skills.getByText("Skills capture stale", { exact: true })).toBeVisible();
  await expect(skills.getByText("alpha", { exact: true })).toBeVisible();
  await page.screenshot({
    path: resolve(artifactDirectory, "stale-390x844.png"),
    animations: "disabled"
  });

  api.setReadOutcome("pending");
  await refresh.click();
  await expect(skills.getByText("Refreshing Skills", { exact: true })).toBeVisible();
  await expect(refresh).toBeDisabled();
  await refresh.evaluate((button) => (button as HTMLButtonElement).click());
  expect(api.requests()).toHaveLength(2);
  api.setSnapshotVariant("partial");
  api.releaseRead();
  await expect(skills.getByText("Skills capture partial", { exact: true })).toBeVisible();
  await expect(skills.getByText("Partial snapshot", { exact: true })).toBeVisible();

  await refreshSessionDetail(page);
  await expect(skills.getByText("Skills capture stale", { exact: true })).toBeVisible();
  api.setReadOutcome("known_failure");
  await refresh.click();
  await expect(skills.getByText("Skills refresh failed", { exact: true })).toBeVisible();
  await expect(skills.getByText("alpha", { exact: true })).toBeVisible();
  expect(api.requests()).toHaveLength(3);
  await page.screenshot({
    path: resolve(artifactDirectory, "refresh-failure-retained-390x844.png"),
    animations: "disabled"
  });
  await expectCleanBrowser(diagnostics, [/status of 503 \(Service Unavailable\)/u]);
});

test("renders empty, partial, error, unsupported, malformed, foreign, and failure states distinctly", async ({ page }) => {
  const diagnostics = observePage(page);
  const api = await installSkillsControlApi(page, { snapshotVariant: "empty" });
  await page.goto(detailPath);

  await captureSkillsState(page, "No skills reported", "empty-390x844.png");
  await expect(page.getByText("Empty snapshot", { exact: true })).toBeVisible();
  await expect(page.locator(".hostdeck-skill-row")).toHaveCount(0);

  await closeSkills(page);
  api.setSnapshotVariant("partial");
  await captureSkillsState(page, "Skills capture partial", "partial-390x844.png");
  await expect(page.getByText("Partial snapshot", { exact: true })).toBeVisible();
  await expect(page.locator(".hostdeck-skill-row")).toHaveCount(4);

  await closeSkills(page);
  api.setSnapshotVariant("error");
  await captureSkillsState(page, "Skills snapshot reported errors", "snapshot-error-390x844.png");
  await expect(page.getByText("Snapshot error", { exact: true })).toBeVisible();
  await expect(page.getByText("Skills could not be loaded", { exact: true })).toHaveCount(0);

  await closeSkills(page);
  api.setReadOutcome("unsupported");
  await captureSkillsState(page, "Structured Skills unsupported", "unsupported-390x844.png");
  await expect(page.getByRole("button", { name: "Refresh Skills" })).toBeDisabled();

  await closeSkills(page);
  api.setReadOutcome("known_failure");
  await captureSkillsState(page, "Skills could not be loaded", "read-failure-390x844.png");
  await expect(page.getByRole("dialog", { name: "/skills" })).not.toContainText(
    "Private Skills fixture detail"
  );

  await closeSkills(page);
  api.setReadOutcome("malformed");
  await captureSkillsState(page, "Skills could not be loaded", "malformed-response-390x844.png");
  await expect(page.getByRole("dialog", { name: "/skills" })).not.toContainText("private_path");

  await closeSkills(page);
  api.setReadOutcome("foreign");
  await captureSkillsState(page, "Skills could not be loaded", "foreign-target-390x844.png");
  await expect(page.getByRole("dialog", { name: "/skills" })).not.toContainText(
    "thread-foreign-private"
  );

  expect(api.requests()).toHaveLength(7);
  await expectCleanBrowser(diagnostics, [
    /status of 409 \(Conflict\)/u,
    /status of 503 \(Service Unavailable\)/u
  ]);
});

test("keeps search local and makes 25 and 1,024 ordered rows progressively reachable", async ({ page }) => {
  const diagnostics = observePage(page);
  const api = await installSkillsControlApi(page, { snapshotVariant: "long" });
  await page.goto(detailPath);
  let skills = await openSkills(page);
  await expect(skills.getByText("Skills capture current", { exact: true })).toBeVisible();
  await expect(skills.locator(".hostdeck-skill-row")).toHaveCount(24);
  await expect(skills.getByRole("button", { name: "Show 1 more" })).toBeVisible();

  const search = skills.getByRole("searchbox", { name: "Search skills" });
  await search.fill("null-description");
  await expect(skills.locator(".hostdeck-skill-row")).toHaveCount(1);
  await expect(skills.getByText("Description not reported", { exact: true })).toBeVisible();
  expect(api.requests()).toHaveLength(1);
  await skills.getByRole("button", { name: "Clear Skills search" }).click();
  await expect(skills.locator(".hostdeck-skill-row")).toHaveCount(24);

  const disclosure = skills.locator(".hostdeck-skill-row__disclosure");
  await expect(disclosure).toHaveAccessibleName("Expand description");
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await disclosure.click();
  await expect(disclosure).toHaveAccessibleName("Collapse description");
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await page.screenshot({
    path: resolve(artifactDirectory, "long-expanded-390x844.png"),
    animations: "disabled"
  });

  await search.fill("no-match-value");
  await expect(skills.getByText("No skills match this search", { exact: true })).toBeVisible();
  await expect(skills.getByText("Empty snapshot", { exact: true })).toHaveCount(0);
  await page.screenshot({
    path: resolve(artifactDirectory, "search-no-match-390x844.png"),
    animations: "disabled"
  });
  await search.fill("x".repeat(200));
  await expect(search).toHaveValue("x".repeat(160));
  await skills.getByRole("button", { name: "Clear Skills search" }).click();
  await skills.getByRole("button", { name: "Show 1 more" }).click();
  await expect(skills.locator(".hostdeck-skill-row")).toHaveCount(25);
  expect(api.requests()).toHaveLength(1);

  await closeSkills(page);
  api.setSnapshotVariant("ceiling");
  skills = await openSkills(page);
  await expect(skills.getByText("1,024 reported", { exact: true })).toBeVisible();
  await expect(skills.locator(".hostdeck-skills-summary")).toContainText("1,024");
  await expect(skills.locator(".hostdeck-skill-row")).toHaveCount(24);
  await skills.getByRole("button", { name: "Show 24 more" }).click();
  await expect(skills.locator(".hostdeck-skill-row")).toHaveCount(48);
  const ceilingSearch = skills.getByRole("searchbox", { name: "Search skills" });
  await ceilingSearch.fill("bounded-1024");
  await expect(skills.locator(".hostdeck-skill-row")).toHaveCount(1);
  await expect(skills.getByText("bounded-1024", { exact: true })).toBeVisible();
  await skills.getByRole("button", { name: "Clear Skills search" }).click();
  await expect(skills.locator(".hostdeck-skill-row")).toHaveCount(24);
  await page.screenshot({
    path: resolve(artifactDirectory, "ceiling-bounded-390x844.png"),
    animations: "disabled"
  });
  expect(api.requests()).toHaveLength(2);

  const privacy = await browserPrivacy(page);
  expect(privacy.localStorage).toEqual([]);
  expect(privacy.sessionStorage).toEqual([]);
  expect(privacy.url).toBe(`http://127.0.0.1:4175${detailPath}`);
  await expectCleanBrowser(diagnostics);
});

test("keeps read authority independent from write, lock, and turn state", async ({ page }) => {
  const diagnostics = observePage(page);
  const api = await installSkillsControlApi(page, { sessionVariant: "read_only" });
  await page.goto(detailPath);

  for (const state of ["read_only", "locked", "waiting_input", "turn_unknown"] as const) {
    api.setSessionVariant(state);
    if (state !== "read_only") await refreshSessionDetail(page);
    const skills = await openSkills(page);
    await expect(skills.getByText("Skills capture current", { exact: true })).toBeVisible();
    await page.screenshot({
      path: resolve(artifactDirectory, `${state}-390x844.png`),
      animations: "disabled"
    });
    await closeSkills(page);
  }
  expect(api.requests()).toHaveLength(4);

  api.setSessionVariant("stale_session");
  await refreshSessionDetail(page);
  await page.getByRole("button", { name: /More session utilities/ }).click();
  const staleRow = page.getByRole("dialog", { name: "Session utilities" })
    .getByRole("button", { name: /skills/iu });
  await expect(staleRow).toBeDisabled();
  await expect(staleRow).toContainText(
    "Session state is stale. Refresh Session Detail before loading Skills."
  );
  await page.screenshot({
    path: resolve(artifactDirectory, "stale-session-row-390x844.png"),
    animations: "disabled"
  });
  await page.keyboard.press("Escape");
  expect(api.requests()).toHaveLength(4);

  api.setSessionVariant("writable");
  await refreshSessionDetail(page);
  await openSkills(page);
  await expect(page.getByText("Skills capture current", { exact: true })).toBeVisible();
  api.setSessionVariant("denied");
  await refreshSessionDetail(page);
  await expect(page.getByRole("dialog", { name: "/skills" })).toBeHidden();
  await expect(page.getByText("Device access was revoked", { exact: true })).toBeVisible();
  await expect(page.getByText("alpha", { exact: true })).toHaveCount(0);
  expect(api.requests()).toHaveLength(5);
  await expectCleanBrowser(diagnostics);
});

test("contains long Skills data across phone, desktop, short-height, and 200 percent reflow", async ({ page }) => {
  const diagnostics = observePage(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installSkillsControlApi(page, {
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
  const skills = await openSkills(page, true, target);
  await expect(skills.locator(".hostdeck-skill-row")).toHaveCount(24);
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    measurements.push({ viewport, sheet: await expectSkillsGeometry(page) });
    await page.screenshot({
      path: resolve(artifactDirectory, `long-${viewport.width}x${viewport.height}.png`),
      animations: "disabled"
    });
  }

  await page.setViewportSize({ width: 320, height: 800 });
  const scroller = page.locator(".hostdeck-skills-sheet__scroller");
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(skills.getByRole("button", { name: "Show 1 more" })).toBeVisible();
  await expect(skills.getByRole("button", { name: "Refresh Skills" })).toBeVisible();
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
    sheet: await expectSkillsGeometry(page)
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
    sheet: await expectSkillsGeometry(page)
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

  const privacy = await browserPrivacy(page);
  expect(privacy.body).not.toMatch(/thread-private|connection_generation|device_detail_phone/iu);
  expect(privacy.body).not.toMatch(/\/workspace\/|\/home\/private|\.codex\/skills/iu);
  expect(privacy.historyState).not.toMatch(/thread-private|\/workspace\/|\.codex\/skills/iu);
  expect(privacy.localStorage).toEqual([]);
  expect(privacy.sessionStorage).toEqual([]);
  expect(privacy.url).toBe(`http://127.0.0.1:4175${detailPath}`);
  await expectCleanBrowser(diagnostics);
});

async function openSkills(
  page: Page,
  waitForSettled = true,
  target = "android-release"
) {
  await page.getByRole("button", { name: `More session utilities for ${target}` }).click();
  const utilities = page.getByRole("dialog", { name: "Session utilities" });
  await expect(utilities).toBeVisible();
  await utilities.getByRole("button", { name: /skills/iu }).click();
  const skills = page.getByRole("dialog", { name: "/skills" });
  await expect(skills).toBeVisible();
  if (waitForSettled) {
    await expect(skills.getByText("Loading Skills", { exact: true })).toHaveCount(0);
  }
  return skills;
}

async function closeSkills(page: Page): Promise<void> {
  const skills = page.getByRole("dialog", { name: "/skills" });
  await page.keyboard.press("Escape");
  await expect(skills).toBeHidden();
}

async function captureSkillsState(
  page: Page,
  visibleText: string,
  artifact: string
): Promise<void> {
  const skills = await openSkills(page);
  await expect(skills.getByText(visibleText, { exact: true })).toBeVisible();
  await page.screenshot({
    path: resolve(artifactDirectory, artifact),
    animations: "disabled"
  });
}

async function refreshSessionDetail(page: Page): Promise<void> {
  const refresh = page.locator(".hostdeck-detail-context__refresh");
  await refresh.evaluate((button) => (button as HTMLButtonElement).click());
  await expect.poll(async () => {
    if (await refresh.count() === 0) return true;
    return !(await refresh.isVisible()) || await refresh.isEnabled();
  }).toBe(true);
}

function requiredRequest(requests: readonly Request[], index: number): Request {
  const request = requests[index];
  if (request === undefined) throw new TypeError("Expected Skills request is missing.");
  return request;
}

function expectSkillsRequest(request: Request): void {
  expect(request.method()).toBe("GET");
  expect(new URL(request.url())).toMatchObject({
    origin: "http://127.0.0.1:4175",
    pathname: `/api/v1/sessions/${sessionDetailBrowserSessionId}/skills`,
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

async function browserPrivacy(page: Page) {
  return page.evaluate(() => ({
    body: document.body.textContent ?? "",
    historyState: JSON.stringify(history.state),
    localStorage: Object.keys(localStorage),
    sessionStorage: Object.keys(sessionStorage),
    url: window.location.href
  }));
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

async function expectSkillsGeometry(page: Page) {
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
    const body = document.querySelector(".hostdeck-skills-sheet__body");
    const scroller = document.querySelector(".hostdeck-skills-sheet__scroller");
    const status = document.querySelector(".hostdeck-skills-status");
    const summary = document.querySelector(".hostdeck-skills-summary");
    const search = document.querySelector(".hostdeck-skills-search");
    const searchInput = document.querySelector('.hostdeck-skills-search input[type="search"]');
    const back = document.querySelector('[aria-label="Back to session utilities"]');
    const close = document.querySelector('[aria-label="Close Skills utility"]');
    const refresh = document.querySelector('[aria-label="Refresh Skills"]');
    const disclosure = document.querySelector(".hostdeck-skill-row__disclosure");
    const showMore = document.querySelector(".hostdeck-skills-show-more");
    if (
      !(dialog instanceof HTMLElement) ||
      !(body instanceof HTMLElement) ||
      !(scroller instanceof HTMLElement) ||
      !(status instanceof HTMLElement) ||
      !(summary instanceof HTMLElement) ||
      !(search instanceof HTMLElement) ||
      !(searchInput instanceof HTMLElement) ||
      !(back instanceof HTMLElement) ||
      !(close instanceof HTMLElement) ||
      !(refresh instanceof HTMLElement) ||
      !(disclosure instanceof HTMLElement) ||
      !(showMore instanceof HTMLElement)
    ) {
      throw new TypeError("Skills sheet geometry is unavailable.");
    }
    const textOverflow = [...dialog.querySelectorAll("strong, small, h2, p, span")]
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
      summary: measure(summary),
      search: measure(search),
      searchInput: measure(searchInput),
      back: measure(back),
      close: measure(close),
      refresh: measure(refresh),
      disclosure: measure(disclosure),
      showMore: measure(showMore),
      rowCount: dialog.querySelectorAll(".hostdeck-skill-row").length,
      textOverflow,
      scrollOwners
    };
  });
  expect(measurement.dialog.left).toBeGreaterThanOrEqual(0);
  expect(measurement.dialog.right).toBeLessThanOrEqual(measurement.viewport.width + 1);
  expect(measurement.dialog.top).toBeGreaterThanOrEqual(0);
  expect(measurement.dialog.bottom).toBeLessThanOrEqual(measurement.viewport.height + 1);
  for (const control of [
    measurement.back,
    measurement.close,
    measurement.refresh,
    measurement.searchInput,
    measurement.disclosure,
    measurement.showMore
  ]) {
    expect(control.width).toBeGreaterThanOrEqual(44);
    expect(control.height).toBeGreaterThanOrEqual(44);
  }
  expect(measurement.summary.left).toBeGreaterThanOrEqual(measurement.dialog.left);
  expect(measurement.summary.right).toBeLessThanOrEqual(measurement.dialog.right);
  expect(measurement.scroller.bottom).toBeLessThanOrEqual(measurement.status.top + 1);
  expect(measurement.status.bottom).toBeLessThanOrEqual(measurement.body.bottom + 1);
  expect(measurement.rowCount).toBeLessThanOrEqual(24);
  expect(measurement.textOverflow).toBe(false);
  expect(measurement.scrollOwners).toBeLessThanOrEqual(1);
  return measurement;
}
