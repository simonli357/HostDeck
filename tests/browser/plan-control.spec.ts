import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page, type Request, test } from "@playwright/test";
import { planSelectionRequestSchema } from "../../packages/contracts/src/index.js";
import {
  installPlanControlApi,
  type PlanControlApiController,
  type PlanSnapshotVariant
} from "./plan-control-fixture.js";
import { sessionDetailBrowserSessionId } from "./session-detail-fixture.js";

const artifactDirectory = resolve("artifacts/fe-v1-027-primary-plan-control");
const detailPath = `/sessions/${sessionDetailBrowserSessionId}`;
const visualReviewTime = new Date("2026-07-26T02:00:00.000Z");

test.beforeAll(async () => {
  await mkdir(artifactDirectory, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(visualReviewTime);
});

test("reads exact Plan truth and stages one correlated next-turn selection", async ({ page }) => {
  const diagnostics = observePage(page);
  const api = await installPlanControlApi(page);
  await page.goto(detailPath);

  const trigger = page.getByRole("button", { name: "/plan for android-release" });
  await expect(trigger).toBeVisible();
  await expect(page.getByRole("button", { name: "/model for android-release" })).toBeVisible();
  await expect(page.getByRole("button", { name: "/goal for android-release" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "More session utilities for android-release" })
  ).toBeVisible();
  await expectDockGeometry(page);
  await trigger.click();

  const dialog = page.getByRole("dialog", { name: "/plan" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Target: android-release", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Default", { exact: true }).first()).toBeVisible();
  await expect(dialog.getByText("No pending change", { exact: true })).toBeVisible();
  await expect(dialog.getByText("No observed Plan execution", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Plan control ready", { exact: true })).toBeVisible();
  await expect
    .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);

  const reads = api.planReadRequests();
  expect(reads).toHaveLength(1);
  expectPlanRequest(reads[0], "GET");

  const defaultMode = dialog.getByRole("radio", { name: /Default/u });
  const planMode = dialog.getByRole("radio", { name: /Plan/u });
  for (const radio of [defaultMode, planMode]) {
    const bounds = await radio.boundingBox();
    expect(bounds?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  await defaultMode.focus();
  await page.keyboard.press("ArrowUp");
  await expect(planMode).toBeChecked();
  await expect(dialog.getByRole("form", { name: "Plan selection" })).toBeVisible();
  const submit = dialog.getByRole("button", { name: "Set for next turn" });
  await expect(submit).toBeEnabled();
  await submit.focus();
  await page.keyboard.press("Enter");

  await expect(dialog.getByText("Plan staged for next turn", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Pending next turn: Staged in HostDeck", { exact: true }))
    .toBeVisible();
  await expect(dialog.getByText("Default", { exact: true }).first()).toBeVisible();
  await expect(dialog.getByText("Plan", { exact: true }).first()).toBeVisible();
  await expect(dialog.getByText(/current turn is unchanged/iu).first()).toBeVisible();

  const writes = api.planSelectRequests();
  expect(writes).toHaveLength(1);
  const write = requiredRequest(writes, 0);
  expectPlanRequest(write, "POST");
  const body = planSelectionRequestSchema.parse(write.postDataJSON());
  expect(body).toEqual({
    operation_id: expect.stringMatching(/^op_browser_plan_[0-9a-f]{32}$/u),
    kind: "plan",
    action: "enter",
    expected_pending_revision: null
  });
  expect(JSON.stringify(body)).not.toContain("/plan");
  expect(write.headers()["x-hostdeck-csrf"]).toBe("D".repeat(43));
  expect(write.headers()["x-hostdeck-csrf-generation"]).toBe("1");
  await page.screenshot({
    path: resolve(artifactDirectory, "staged-plan-390x844.png"),
    animations: "disabled"
  });

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expectCleanBrowser(diagnostics);
});

test("owns one in-flight Plan selection and blocks duplicate submit or dismissal", async ({ page }) => {
  const diagnostics = observePage(page);
  const api = await installPlanControlApi(page);
  api.setSelectOutcome("pending");
  await page.goto(detailPath);
  await openPlan(page);

  const dialog = page.getByRole("dialog", { name: "/plan" });
  await dialog.getByRole("radio", { name: /Plan/u }).locator("..").click();
  const submit = dialog.getByRole("button", { name: "Set for next turn" });
  await submit.click();
  await expect(dialog.getByText("Saving next-turn mode", { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const [sheet, status, scroller, footer, viewportHeight] = await Promise.all([
      dialog.boundingBox(),
      dialog.locator(".hostdeck-plan-sheet__status").boundingBox(),
      dialog.locator(".hostdeck-plan-sheet__body").boundingBox(),
      dialog.locator(".hostdeck-plan-sheet__footer").boundingBox(),
      page.evaluate(() => window.innerHeight)
    ]);
    return sheet !== null && status !== null && scroller !== null && footer !== null &&
      status.y >= scroller.y + scroller.height - 1 &&
      status.y + status.height <= footer.y + 1 &&
      footer.y + footer.height <= sheet.y + sheet.height + 1 &&
      sheet.y + sheet.height <= viewportHeight + 1;
  }).toBe(true);
  await expect.poll(() => api.hasPendingPlanSelect()).toBe(true);
  await expect(submit).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Close Plan control" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();

  await submit.evaluate((button) => (button as HTMLButtonElement).click());
  await page.keyboard.press("Enter");
  await page.setViewportSize({ width: 390, height: 843 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  expect(api.planSelectRequests()).toHaveLength(1);
  await page.screenshot({
    path: resolve(artifactDirectory, "submitting-390x844.png"),
    animations: "disabled"
  });

  api.releasePlanSelect();
  await expect(dialog.getByText("Plan staged for next turn", { exact: true })).toBeVisible();
  expect(api.planSelectRequests()).toHaveLength(1);
  await expectCleanBrowser(diagnostics);
});

test("clears current mode and restages conflict with exact observed revisions", async ({ page }) => {
  const diagnostics = observePage(page);
  const api = await installPlanControlApi(page, { snapshotVariant: "pending" });
  await page.goto(detailPath);
  await openPlan(page);
  const dialog = page.getByRole("dialog", { name: "/plan" });

  await expect(dialog.getByRole("button", { name: "Set for next turn" })).toBeDisabled();
  await dialog.getByRole("radio", { name: /Default/u }).locator("..").click();
  const clear = dialog.getByRole("button", { name: "Clear pending change" });
  await expect(clear).toBeEnabled();
  await clear.click();
  await expect(dialog.getByText("Pending Plan change cleared", { exact: true })).toBeVisible();
  expect(planSelectionRequestSchema.parse(requiredRequest(api.planSelectRequests(), 0).postDataJSON()))
    .toEqual({
      operation_id: expect.stringMatching(/^op_browser_plan_[0-9a-f]{32}$/u),
      kind: "plan",
      action: "exit",
      expected_pending_revision: 7
    });
  await page.screenshot({
    path: resolve(artifactDirectory, "cleared-pending-390x844.png"),
    animations: "disabled"
  });

  await closePlan(page);
  api.setSnapshotVariant("conflict");
  await openPlan(page);
  await expect(dialog.getByText("Pending Plan conflict", { exact: true })).toBeVisible();
  const restage = dialog.getByRole("button", { name: "Restage for next turn" });
  await expect(restage).toBeEnabled();
  await restage.click();
  await expect(dialog.getByText("Plan staged for next turn", { exact: true })).toBeVisible();
  expect(planSelectionRequestSchema.parse(requiredRequest(api.planSelectRequests(), 1).postDataJSON()))
    .toEqual({
      operation_id: expect.stringMatching(/^op_browser_plan_[0-9a-f]{32}$/u),
      kind: "plan",
      action: "enter",
      expected_pending_revision: 7
    });
  await page.screenshot({
    path: resolve(artifactDirectory, "restaged-conflict-390x844.png"),
    animations: "disabled"
  });

  await closePlan(page);
  api.setSnapshotVariant("unknown_current");
  api.setSelectOutcome("already_current");
  await openPlan(page);
  await dialog.getByRole("radio", { name: /Plan/u }).locator("..").click();
  await dialog.getByRole("button", { name: "Set for next turn" }).click();
  await expect(dialog.getByText("Plan already confirmed", { exact: true })).toBeVisible();
  await expect(dialog.getByText("No next-turn Plan change is pending.", { exact: true }))
    .toBeVisible();
  await page.screenshot({
    path: resolve(artifactDirectory, "already-confirmed-390x844.png"),
    animations: "disabled"
  });
  await expect(dialog).not.toContainText("op_fixture_plan_pending_001");
  await expect(dialog).not.toContainText("Private Plan fixture detail");
  await expectCleanBrowser(diagnostics);
});

test("renders the deterministic current, pending, execution, and read-authority matrix", async ({ page }) => {
  const diagnostics = observePage(page);
  const api = await installPlanControlApi(page);
  api.setReadOutcome("pending");
  await page.goto(detailPath);
  await page.getByRole("button", { name: "/plan for android-release" }).click();
  const dialog = page.getByRole("dialog", { name: "/plan" });
  await expect(dialog.getByText("Loading Plan state", { exact: true })).toBeVisible();
  await expect.poll(() => api.hasPendingPlanRead()).toBe(true);
  await page.screenshot({
    path: resolve(artifactDirectory, "loading-390x844.png"),
    animations: "disabled"
  });
  api.releasePlanRead();
  await expect(dialog.getByText("Plan control ready", { exact: true })).toBeVisible();
  await page.screenshot({
    path: resolve(artifactDirectory, "ready-current-390x844.png"),
    animations: "disabled"
  });

  for (const state of [
    ["unknown_current", "Current Plan mode unknown", "current-unknown-390x844.png"],
    ["pending", "Plan staged for next turn", "pending-390x844.png"],
    ["dispatching", "Preparing next-turn Plan settings", "dispatching-390x844.png"],
    ["awaiting_confirmation", "Turn accepted; awaiting Plan confirmation", "awaiting-confirmation-390x844.png"],
    ["conflict", "Pending Plan conflict", "conflict-390x844.png"],
    ["pending_unknown", "Plan confirmation unknown", "pending-unknown-390x844.png"],
    ["execution_awaiting", "Awaiting Plan evidence", "execution-awaiting-390x844.png"],
    ["execution_active", "Plan execution active", "execution-active-390x844.png"],
    ["execution_complete", "Plan execution complete", "execution-complete-390x844.png"],
    ["execution_failed", "Plan execution failed", "execution-failed-390x844.png"],
    ["execution_interrupted", "Plan execution interrupted", "execution-interrupted-390x844.png"],
    ["execution_unknown", "Plan execution unknown", "execution-unknown-390x844.png"]
  ] as const) {
    await captureSnapshotState(page, api, state[0], state[1], state[2]);
  }
  await expect(dialog).not.toContainText("turn-fixture-plan-execution-001");
  await expect(dialog).not.toContainText("op_fixture_plan_pending_001");
  await expect(dialog).not.toContainText("Private Plan fixture detail");

  await closePlan(page);
  api.setReadOutcome("unsupported");
  await openPlan(page);
  await expect(dialog.getByText("Plan control unsupported", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Set for next turn" })).toBeDisabled();
  await page.screenshot({
    path: resolve(artifactDirectory, "unsupported-390x844.png"),
    animations: "disabled"
  });

  await closePlan(page);
  api.setReadOutcome("known_failure");
  await openPlan(page);
  await expect(dialog.getByText("Plan state could not be loaded", { exact: true })).toBeVisible();
  await expect(dialog).not.toContainText("Private Plan fixture detail");
  await page.screenshot({
    path: resolve(artifactDirectory, "read-failure-390x844.png"),
    animations: "disabled"
  });

  await closePlan(page);
  api.setReadOutcome("success");
  api.setSnapshotVariant("ready");
  api.setSessionVariant("read_only");
  await page.reload();
  await openPlan(page);
  await expect(dialog.getByText("Read-only access cannot change Plan mode.").first()).toBeVisible();
  await expect(dialog.getByRole("group", { name: "Select next-turn mode" })).toHaveAttribute(
    "disabled",
    ""
  );
  await expect(dialog.getByRole("button", { name: "Set for next turn" })).toBeDisabled();
  await page.screenshot({
    path: resolve(artifactDirectory, "read-only-390x844.png"),
    animations: "disabled"
  });
  expect(api.planSelectRequests()).toHaveLength(0);
  await expectCleanBrowser(diagnostics, [
    /status of 409 \(Conflict\)/u,
    /status of 503 \(Service Unavailable\)/u
  ]);
});

test("distinguishes known rejection, conflict, ambiguous, and uncorrelated outcomes", async ({ page }) => {
  const diagnostics = observePage(page);
  const api = await installPlanControlApi(page);
  await page.goto(detailPath);

  await submitPlanOutcome(page, api, "known_failure", "Plan selection was not saved");
  let dialog = page.getByRole("dialog", { name: "/plan" });
  await expect(dialog.getByText("HostDeck is temporarily too busy to save this Plan selection.", {
    exact: true
  })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Set for next turn" })).toBeEnabled();
  await page.screenshot({
    path: resolve(artifactDirectory, "selection-known-failure-390x844.png"),
    animations: "disabled"
  });
  await closePlan(page);

  await submitPlanOutcome(page, api, "conflict", "Plan selection was not saved");
  dialog = page.getByRole("dialog", { name: "/plan" });
  await expect(dialog.getByText("Pending Plan state changed. Refresh before continuing.", {
    exact: true
  })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Set for next turn" })).toBeDisabled();
  await page.screenshot({
    path: resolve(artifactDirectory, "selection-conflict-390x844.png"),
    animations: "disabled"
  });
  await closePlan(page);

  await submitPlanOutcome(page, api, "ambiguous", "Selection outcome unknown");
  dialog = page.getByRole("dialog", { name: "/plan" });
  await expect(dialog.getByRole("button", { name: "Check Plan state" })).toBeEnabled();
  await expect(dialog).not.toContainText("Private Plan fixture detail");
  await page.screenshot({
    path: resolve(artifactDirectory, "selection-outcome-unknown-390x844.png"),
    animations: "disabled"
  });
  await closePlan(page);

  await submitPlanOutcome(page, api, "correlation_mismatch", "Selection outcome unknown");
  dialog = page.getByRole("dialog", { name: "/plan" });
  await expect(dialog.getByRole("button", { name: "Set for next turn" })).toBeDisabled();
  await page.screenshot({
    path: resolve(artifactDirectory, "selection-correlation-mismatch-390x844.png"),
    animations: "disabled"
  });
  const writesBeforeCheck = api.planSelectRequests().length;
  await dialog.getByRole("button", { name: "Check Plan state" }).click();
  await expect(dialog.getByText("Plan staged for next turn", { exact: true })).toBeVisible();
  expect(api.planSelectRequests()).toHaveLength(writesBeforeCheck);
  await expectCleanBrowser(diagnostics, [
    /status of 503 \(Service Unavailable\)/u,
    /status of 409 \(Conflict\)/u,
    /status of 504 \(Gateway Timeout\)/u
  ]);
});

test("contains long Plan controls across mobile, desktop, short-height, and 200 percent zoom", async ({ page }) => {
  const diagnostics = observePage(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installPlanControlApi(page, {
    sessionVariant: "writable_long",
    snapshotVariant: "long"
  });
  await page.goto(detailPath);
  const target = "android-release-validation-long-session-name-2026";
  await expect(page.getByRole("button", { name: `/plan for ${target}` })).toBeVisible();

  const measurements = [];
  for (const viewport of [
    { width: 320, height: 800 },
    { width: 360, height: 800 },
    { width: 390, height: 844 },
    { width: 412, height: 915 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 }
  ]) {
    await page.setViewportSize(viewport);
    measurements.push({ viewport, dock: await expectDockGeometry(page) });
  }

  await page.setViewportSize({ width: 320, height: 800 });
  await openPlan(page, target);
  for (const viewport of [
    { width: 320, height: 800 },
    { width: 360, height: 800 },
    { width: 390, height: 844 },
    { width: 412, height: 915 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 }
  ]) {
    await page.setViewportSize(viewport);
    measurements.push({ viewport, sheet: await expectPlanGeometry(page) });
    await page.screenshot({
      path: resolve(artifactDirectory, `long-${viewport.width}x${viewport.height}.png`),
      animations: "disabled"
    });
  }

  await page.setViewportSize({ width: 320, height: 800 });
  const body = page.locator(".hostdeck-plan-sheet__body");
  await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.getByRole("group", { name: "Select next-turn mode" })).toBeVisible();
  await page.screenshot({
    path: resolve(artifactDirectory, "long-scrolled-320x800.png"),
    animations: "disabled"
  });
  await body.evaluate((element) => {
    element.scrollTop = 0;
  });

  await page.setViewportSize({ width: 390, height: 420 });
  measurements.push({ viewport: { width: 390, height: 420 }, sheet: await expectPlanGeometry(page) });
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
    sheet: await expectPlanGeometry(page)
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
  await expectCleanBrowser(diagnostics);
});

async function captureSnapshotState(
  page: Page,
  api: PlanControlApiController,
  variant: PlanSnapshotVariant,
  visibleText: string,
  artifact: string
): Promise<void> {
  await closePlan(page);
  api.setSnapshotVariant(variant);
  await openPlan(page);
  const dialog = page.getByRole("dialog", { name: "/plan" });
  await expect(dialog.getByText(visibleText, { exact: true })).toBeVisible();
  await page.screenshot({
    path: resolve(artifactDirectory, artifact),
    animations: "disabled"
  });
}

async function submitPlanOutcome(
  page: Page,
  api: PlanControlApiController,
  outcome: "known_failure" | "conflict" | "ambiguous" | "correlation_mismatch",
  status: string
): Promise<void> {
  api.setSnapshotVariant("ready");
  api.setSelectOutcome(outcome);
  await openPlan(page);
  const dialog = page.getByRole("dialog", { name: "/plan" });
  await dialog.getByRole("radio", { name: /Plan/u }).locator("..").click();
  await dialog.getByRole("button", { name: "Set for next turn" }).click();
  await expect(dialog.getByText(status, { exact: true })).toBeVisible();
}

async function openPlan(page: Page, target = "android-release"): Promise<void> {
  await page.getByRole("button", { name: `/plan for ${target}` }).click();
  await expect(page.getByRole("dialog", { name: "/plan" })).toBeVisible();
}

async function closePlan(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "/plan" });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
}

function requiredRequest(requests: readonly Request[], index: number): Request {
  const request = requests[index];
  if (request === undefined) throw new TypeError("Expected Plan request is missing.");
  return request;
}

function expectPlanRequest(request: Request | undefined, method: "GET" | "POST"): void {
  if (request === undefined) throw new TypeError("Expected Plan request is missing.");
  expect(request.method()).toBe(method);
  expect(new URL(request.url())).toMatchObject({
    origin: "http://127.0.0.1:4175",
    pathname: `/api/v1/sessions/${sessionDetailBrowserSessionId}/plan`,
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
    const model = commands[0];
    const goal = commands[1];
    const plan = commands[2];
    const more = commands[3];
    const composer = document.querySelector(".hostdeck-prompt-composer");
    const target = document.querySelector(".hostdeck-prompt-composer__target");
    if (
      !(controls instanceof HTMLElement) ||
      !(dock instanceof HTMLElement) ||
      !(model instanceof HTMLElement) ||
      !(goal instanceof HTMLElement) ||
      !(plan instanceof HTMLElement) ||
      !(more instanceof HTMLElement) ||
      !(composer instanceof HTMLElement) ||
      !(target instanceof HTMLElement)
    ) {
      throw new TypeError("Session control dock geometry is unavailable.");
    }
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      controls: measure(controls),
      dock: measure(dock),
      commands: [measure(model), measure(goal), measure(plan), measure(more)],
      commandCount: commands.length,
      composer: measure(composer),
      target: measure(target)
    };
  });
  expect(measurement.controls.left).toBeGreaterThanOrEqual(0);
  expect(measurement.controls.right).toBeLessThanOrEqual(measurement.viewport.width + 1);
  expect(measurement.controls.bottom).toBeLessThanOrEqual(measurement.viewport.height + 1);
  expect(measurement.dock.bottom).toBeLessThanOrEqual(measurement.composer.top + 1);
  expect(measurement.commandCount).toBe(4);
  for (const command of measurement.commands) {
    expect(command.width).toBeGreaterThanOrEqual(44);
    expect(command.height).toBeGreaterThanOrEqual(44);
  }
  expect(Math.max(...measurement.commands.map((command) => command.width)) -
    Math.min(...measurement.commands.map((command) => command.width))).toBeLessThanOrEqual(1);
  expect(measurement.target.left).toBeGreaterThanOrEqual(measurement.composer.left);
  expect(measurement.target.right).toBeLessThanOrEqual(measurement.composer.right);
  return measurement;
}

async function expectPlanGeometry(page: Page) {
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
    const dialog = document.querySelector(".hostdeck-plan-sheet");
    const body = document.querySelector(".hostdeck-plan-sheet__body");
    const footer = document.querySelector(".hostdeck-plan-sheet__footer");
    const submit = document.querySelector(".hostdeck-plan-sheet__submit");
    const close = document.querySelector(".hostdeck-plan-sheet__header .hostdeck-icon-button");
    const rails = document.querySelector(".hostdeck-plan-state-rail");
    const options = document.querySelector(".hostdeck-plan-options");
    if (
      !(dialog instanceof HTMLElement) ||
      !(body instanceof HTMLElement) ||
      !(footer instanceof HTMLElement) ||
      !(submit instanceof HTMLElement) ||
      !(close instanceof HTMLElement) ||
      !(rails instanceof HTMLElement) ||
      !(options instanceof HTMLElement)
    ) {
      throw new TypeError("Plan sheet geometry is unavailable.");
    }
    const textOverflow = [...dialog.querySelectorAll("strong, small, legend, label span, p, dt, dd")]
      .filter((element): element is HTMLElement => element instanceof HTMLElement)
      .some((element) => element.scrollWidth > element.clientWidth + 1);
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      dialog: measure(dialog),
      body: { ...measure(body), clientHeight: body.clientHeight, scrollHeight: body.scrollHeight },
      footer: measure(footer),
      submit: measure(submit),
      close: measure(close),
      rails: measure(rails),
      options: measure(options),
      textOverflow
    };
  });
  expect(measurement.dialog.left).toBeGreaterThanOrEqual(0);
  expect(measurement.dialog.right).toBeLessThanOrEqual(measurement.viewport.width + 1);
  expect(measurement.dialog.top).toBeGreaterThanOrEqual(0);
  expect(measurement.dialog.bottom).toBeLessThanOrEqual(measurement.viewport.height + 1);
  expect(measurement.footer.left).toBeGreaterThanOrEqual(measurement.dialog.left);
  expect(measurement.footer.right).toBeLessThanOrEqual(measurement.dialog.right);
  expect(measurement.footer.bottom).toBeLessThanOrEqual(measurement.dialog.bottom);
  expect(measurement.submit.height).toBeGreaterThanOrEqual(48);
  expect(measurement.close.width).toBeGreaterThanOrEqual(44);
  expect(measurement.close.height).toBeGreaterThanOrEqual(44);
  expect(measurement.rails.left).toBeGreaterThanOrEqual(measurement.dialog.left);
  expect(measurement.rails.right).toBeLessThanOrEqual(measurement.dialog.right);
  expect(measurement.options.left).toBeGreaterThanOrEqual(measurement.dialog.left);
  expect(measurement.options.right).toBeLessThanOrEqual(measurement.dialog.right);
  expect(measurement.textOverflow).toBe(false);
  return measurement;
}
