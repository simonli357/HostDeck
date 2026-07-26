import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page, type Request, test } from "@playwright/test";
import { goalMutationRequestSchema } from "../../packages/contracts/src/index.js";
import {
  type GoalControlApiController,
  type GoalMutateOutcome,
  type GoalSnapshotVariant,
  installGoalControlApi
} from "./goal-control-fixture.js";
import { sessionDetailBrowserSessionId } from "./session-detail-fixture.js";

const artifactDirectory = resolve("artifacts/fe-v1-026-primary-goal-control");
const detailPath = `/sessions/${sessionDetailBrowserSessionId}`;
const visualReviewTime = new Date("2026-07-25T20:00:00.000Z");
const initialRevision = "a".repeat(64);
const changedRevision = "b".repeat(64);

test.beforeAll(async () => {
  await mkdir(artifactDirectory, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(visualReviewTime);
});

test("reads exact goal truth and creates one paused goal without dispatching a turn", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const api = await installGoalControlApi(page, { snapshotVariant: "no_goal" });
  await page.goto(detailPath);

  const trigger = page.getByRole("button", { name: "/goal for android-release" });
  await expect(trigger).toBeVisible();
  await expect(page.getByRole("button", { name: "/model for android-release" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^\/plan|more/iu })).toHaveCount(0);
  await expectDockGeometry(page);
  await trigger.click();

  const dialog = page.getByRole("dialog", { name: "/goal" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Target: android-release", { exact: true })).toBeVisible();
  await expectGoalStatus(dialog, "No goal set");
  await expect
    .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);

  const reads = api.goalReadRequests();
  expect(reads).toHaveLength(1);
  expectGoalRequest(reads[0], "GET");
  const objective = dialog.getByRole("textbox", { name: "Goal objective" });
  await expect(objective).toHaveAttribute("maxlength", "512");
  const save = dialog.getByRole("button", { name: "Create paused goal" });
  await expect(save).toBeDisabled();
  await objective.fill("Ship the Android goal control with exact runtime truth.");
  await expect(save).toBeEnabled();
  await save.click();

  await expectGoalStatus(dialog, "Paused goal created");
  await expect(dialog.getByText("No turn was started.", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Ship the Android goal control with exact runtime truth.", {
    exact: true
  }).first()).toBeVisible();
  const writes = api.goalMutateRequests();
  expect(writes).toHaveLength(1);
  const write = requiredRequest(writes, 0);
  expectGoalRequest(write, "POST");
  const body = goalMutationRequestSchema.parse(write.postDataJSON());
  expect(body).toEqual({
    operation_id: expect.stringMatching(/^op_browser_goal_[0-9a-f]{32}$/u),
    kind: "goal",
    action: "set",
    objective: "Ship the Android goal control with exact runtime truth.",
    expected_goal_revision: null
  });
  expect(JSON.stringify(body)).not.toContain("/goal");
  expect(write.headers()["x-hostdeck-csrf"]).toBe("D".repeat(43));
  expect(write.headers()["x-hostdeck-csrf-generation"]).toBe("1");
  await page.screenshot({
    path: resolve(artifactDirectory, "created-paused-goal-390x844.png"),
    animations: "disabled"
  });

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expectCleanBrowser(diagnostics);
});

test("pauses an active goal during a turn without interrupt or duplicate mutation", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const api = await installGoalControlApi(page, {
    sessionVariant: "active",
    snapshotVariant: "active"
  });
  api.setMutateOutcome("pending");
  await page.goto(detailPath);
  await openGoal(page);
  const dialog = page.getByRole("dialog", { name: "/goal" });

  await expectGoalStatus(dialog, "Active");
  await expect(dialog.getByText(/Pause does not interrupt the current turn/u).first()).toBeVisible();
  await expect(dialog.getByRole("button", { name: /interrupt/iu })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "Resume", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Complete", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Clear goal", exact: true })).toBeDisabled();
  await page.screenshot({
    path: resolve(artifactDirectory, "active-during-turn-390x844.png"),
    animations: "disabled"
  });

  const pause = dialog.getByRole("button", { name: "Pause", exact: true });
  await pause.click();
  await expectGoalStatus(dialog, "Pausing goal");
  await expect.poll(() => api.hasPendingGoalMutate()).toBe(true);
  await expect(dialog.getByRole("button", { name: "Close goal control" })).toBeDisabled();
  await pause.evaluate((button) => (button as HTMLButtonElement).click());
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  expect(api.goalMutateRequests()).toHaveLength(1);
  await page.screenshot({
    path: resolve(artifactDirectory, "pause-submitting-390x844.png"),
    animations: "disabled"
  });

  api.releaseGoalMutate();
  await expectGoalStatus(dialog, "Goal paused");
  await expect(dialog.getByText("The current turn was not interrupted.", { exact: true }))
    .toBeVisible();
  const mutation = goalMutationRequestSchema.parse(
    requiredRequest(api.goalMutateRequests(), 0).postDataJSON()
  );
  expect(mutation).toEqual({
    operation_id: expect.stringMatching(/^op_browser_goal_[0-9a-f]{32}$/u),
    kind: "goal",
    action: "pause",
    objective: null,
    expected_goal_revision: initialRevision
  });
  expect(api.goalMutateRequests()).toHaveLength(1);
  await page.screenshot({
    path: resolve(artifactDirectory, "paused-result-390x844.png"),
    animations: "disabled"
  });
  await expectCleanBrowser(diagnostics);
});

test("owns resume, complete, and clear confirmations with exact consequences", async ({ page }) => {
  const diagnostics = observePage(page);
  const api = await installGoalControlApi(page, { snapshotVariant: "paused" });
  await page.goto(detailPath);
  await openGoal(page);
  const dialog = page.getByRole("dialog", { name: "/goal" });

  await dialog.getByRole("button", { name: "Resume" }).click();
  const resumeConfirmation = dialog.getByRole("alert", { name: "Resume agentic goal?" });
  await expect(resumeConfirmation).toBeVisible();
  await expect(resumeConfirmation.getByText(/may continue work and start a turn/u)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  expect(api.goalMutateRequests()).toHaveLength(0);
  await page.screenshot({
    path: resolve(artifactDirectory, "resume-confirmation-390x844.png"),
    animations: "disabled"
  });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(resumeConfirmation).toBeHidden();
  expect(api.goalMutateRequests()).toHaveLength(0);

  await dialog.getByRole("button", { name: "Resume" }).click();
  await dialog.getByRole("button", { name: "Resume goal" }).click();
  await expectGoalStatus(dialog, "Goal resume accepted");
  await expect(dialog.getByText(/Turn start and progress remain authoritative/u)).toBeVisible();
  await expect(dialog.getByText(/goal running/iu)).toHaveCount(0);
  await page.screenshot({
    path: resolve(artifactDirectory, "resume-accepted-390x844.png"),
    animations: "disabled"
  });

  await dialog.getByRole("button", { name: "Pause", exact: true }).click();
  await expectGoalStatus(dialog, "Goal paused");
  await dialog.getByRole("button", { name: "Complete" }).click();
  const completeConfirmation = dialog.getByRole("alert", { name: "Mark goal complete?" });
  await expect(completeConfirmation).toContainText("does not interrupt, archive, or delete");
  await page.screenshot({
    path: resolve(artifactDirectory, "complete-confirmation-390x844.png"),
    animations: "disabled"
  });
  await dialog.getByRole("button", { name: "Mark complete" }).click();
  await expectGoalStatus(dialog, "Goal marked complete");
  await page.screenshot({
    path: resolve(artifactDirectory, "complete-result-390x844.png"),
    animations: "disabled"
  });

  await dialog.getByRole("button", { name: "Clear goal" }).click();
  const clearConfirmation = dialog.getByRole("alert", { name: "Clear this goal?" });
  await expect(clearConfirmation).toContainText("Thread history remains unchanged");
  await page.screenshot({
    path: resolve(artifactDirectory, "clear-confirmation-390x844.png"),
    animations: "disabled"
  });
  await dialog.getByRole("button", { name: "Clear goal" }).last().click();
  await expectGoalStatus(dialog, "Goal cleared");
  await expect(dialog.getByText("Thread history remains unchanged.", { exact: true }))
    .toBeVisible();
  await page.screenshot({
    path: resolve(artifactDirectory, "clear-result-390x844.png"),
    animations: "disabled"
  });

  const mutations = api.goalMutateRequests().map((request) =>
    goalMutationRequestSchema.parse(request.postDataJSON())
  );
  expect(mutations.map((mutation) => mutation.action)).toEqual([
    "resume",
    "pause",
    "complete",
    "clear"
  ]);
  expect(mutations.map((mutation) => mutation.expected_goal_revision)).toEqual([
    initialRevision,
    changedRevision,
    "c".repeat(64),
    changedRevision
  ]);
  expect(new Set(mutations.map((mutation) => mutation.operation_id)).size).toBe(4);
  for (const mutation of mutations) {
    expect(mutation.objective).toBeNull();
    expect(JSON.stringify(mutation)).not.toContain("/goal");
  }
  await expect(dialog).not.toContainText("Private goal fixture detail");
  await expectCleanBrowser(diagnostics);
});

test("renders the complete deterministic goal state and read-authority matrix", async ({ page }) => {
  const diagnostics = observePage(page);
  const api = await installGoalControlApi(page, { snapshotVariant: "no_goal" });
  api.setReadOutcome("pending");
  await page.goto(detailPath);
  await page.getByRole("button", { name: "/goal for android-release" }).click();
  const dialog = page.getByRole("dialog", { name: "/goal" });
  await expectGoalStatus(dialog, "Loading goal");
  await expect.poll(() => api.hasPendingGoalRead()).toBe(true);
  await page.screenshot({
    path: resolve(artifactDirectory, "loading-390x844.png"),
    animations: "disabled"
  });
  api.releaseGoalRead();
  await expectGoalStatus(dialog, "No goal set");
  await page.screenshot({
    path: resolve(artifactDirectory, "no-goal-create-390x844.png"),
    animations: "disabled"
  });

  for (const state of [
    { variant: "active", status: "Active", artifact: "active-390x844.png" },
    { variant: "paused", status: "Paused", artifact: "paused-390x844.png" },
    { variant: "blocked", status: "Blocked", artifact: "blocked-390x844.png" },
    {
      variant: "usage_limited",
      status: "Usage limited",
      artifact: "usage-limited-390x844.png"
    },
    {
      variant: "budget_limited",
      status: "Budget limited",
      artifact: "budget-limited-390x844.png"
    },
    { variant: "complete", status: "Complete", artifact: "complete-390x844.png" },
    {
      variant: "uncertain_unknown",
      status: "Prior goal outcome unknown",
      artifact: "uncertain-unknown-390x844.png"
    },
    {
      variant: "uncertain_conflict",
      status: "Goal reconciliation conflict",
      artifact: "uncertain-conflict-390x844.png"
    }
  ] as const) {
    await captureSnapshotState(page, api, state.variant, state.status, state.artifact);
  }
  await expect(dialog).not.toContainText(initialRevision);
  await expect(dialog).not.toContainText("Private goal fixture detail");

  await closeGoal(page);
  api.setReadOutcome("unsupported");
  await openGoal(page);
  await expectGoalStatus(dialog, "Goal control unsupported");
  await expect(dialog.locator(".hostdeck-goal-sheet__save")).toBeDisabled();
  await page.screenshot({
    path: resolve(artifactDirectory, "unsupported-390x844.png"),
    animations: "disabled"
  });

  await closeGoal(page);
  api.setReadOutcome("known_failure");
  await openGoal(page);
  await expectGoalStatus(dialog, "Goal could not be loaded");
  await expect(dialog).not.toContainText("Private goal fixture detail");
  await page.screenshot({
    path: resolve(artifactDirectory, "read-failure-390x844.png"),
    animations: "disabled"
  });

  await closeGoal(page);
  api.setReadOutcome("success");
  api.setSnapshotVariant("paused");
  api.setSessionVariant("read_only");
  await page.reload();
  await openGoal(page);
  await expect(dialog.getByText("Read-only access cannot change the goal.").first()).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Goal objective" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Pause", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Resume", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Complete", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Clear goal", exact: true })).toBeDisabled();
  await page.screenshot({
    path: resolve(artifactDirectory, "read-only-390x844.png"),
    animations: "disabled"
  });
  expect(api.goalMutateRequests()).toHaveLength(0);
  await expectCleanBrowser(diagnostics, [/status of 409/iu, /status of 503/iu]);
});

test("distinguishes known conflict, known failure, and unknown mutation outcomes", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const api = await installGoalControlApi(page, { snapshotVariant: "no_goal" });
  await page.goto(detailPath);

  await submitCreateOutcome(page, api, "known_failure", "Goal action was not verified");
  await page.screenshot({
    path: resolve(artifactDirectory, "mutation-known-failure-390x844.png"),
    animations: "disabled"
  });
  await closeGoal(page);

  await submitCreateOutcome(page, api, "conflict", "Goal action was not verified");
  const dialog = page.getByRole("dialog", { name: "/goal" });
  await expect(dialog.locator(".hostdeck-goal-sheet__status small"))
    .toContainText("conflicts with current execution");
  await expect(dialog.getByRole("button", { name: "Create paused goal" })).toBeDisabled();
  await page.screenshot({
    path: resolve(artifactDirectory, "mutation-conflict-390x844.png"),
    animations: "disabled"
  });
  await closeGoal(page);

  await submitCreateOutcome(page, api, "ambiguous", "Goal outcome unknown");
  await expect(dialog.getByRole("button", { name: "Check goal state" })).toBeEnabled();
  await expect(dialog).not.toContainText("Private goal fixture detail");
  const writesBeforeCheck = api.goalMutateRequests().length;
  await page.screenshot({
    path: resolve(artifactDirectory, "mutation-outcome-unknown-390x844.png"),
    animations: "disabled"
  });
  await dialog.getByRole("button", { name: "Check goal state" }).click();
  await expectGoalStatus(dialog, "No goal set");
  expect(api.goalMutateRequests()).toHaveLength(writesBeforeCheck);
  await closeGoal(page);

  await submitCreateOutcome(page, api, "correlation_mismatch", "Goal outcome unknown");
  await expect(dialog.getByRole("button", { name: "Check goal state" })).toBeEnabled();
  await page.screenshot({
    path: resolve(artifactDirectory, "mutation-correlation-mismatch-390x844.png"),
    animations: "disabled"
  });
  expect(api.goalMutateRequests()).toHaveLength(4);
  await expect(dialog).not.toContainText("Private goal fixture detail");
  await expectCleanBrowser(diagnostics, [
    /status of 409/iu,
    /status of 503/iu,
    /status of 504/iu
  ]);
});

test("contains long goal truth across mobile, desktop, short-height, and 200 percent zoom", async ({
  page
}) => {
  const diagnostics = observePage(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installGoalControlApi(page, {
    sessionVariant: "writable_long",
    snapshotVariant: "long"
  });
  await page.goto(detailPath);
  const target = "android-release-validation-long-session-name-2026";
  await expect(page.getByRole("button", { name: `/goal for ${target}` })).toBeVisible();

  const measurements = [];
  for (const viewport of supportedViewports()) {
    await page.setViewportSize(viewport);
    measurements.push({ viewport, dock: await expectDockGeometry(page) });
  }

  await page.setViewportSize({ width: 320, height: 800 });
  await openGoal(page, target);
  const dialog = page.getByRole("dialog", { name: "/goal" });
  await expect(dialog.getByText(/exceeds the phone edit limit/u)).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Goal objective" })).toHaveValue("");
  const observedObjectiveLength = await dialog.locator(".hostdeck-goal-state__objective")
    .evaluate((element) => element.textContent?.length ?? 0);
  expect(observedObjectiveLength).toBeGreaterThan(3_000);

  for (const viewport of supportedViewports()) {
    await page.setViewportSize(viewport);
    measurements.push({ viewport, sheet: await expectGoalGeometry(page) });
    await page.screenshot({
      path: resolve(artifactDirectory, `long-${viewport.width}x${viewport.height}.png`),
      animations: "disabled"
    });
  }

  await page.setViewportSize({ width: 320, height: 800 });
  const body = page.locator(".hostdeck-goal-sheet__body");
  await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(dialog.getByRole("button", { name: "Save paused goal" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Resume" })).toBeVisible();
  await page.screenshot({
    path: resolve(artifactDirectory, "long-scrolled-320x800.png"),
    animations: "disabled"
  });
  await body.evaluate((element) => {
    element.scrollTop = 0;
  });

  await page.setViewportSize({ width: 390, height: 420 });
  measurements.push({
    viewport: { width: 390, height: 420 },
    sheet: await expectGoalGeometry(page)
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
    sheet: await expectGoalGeometry(page)
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
  api: GoalControlApiController,
  variant: GoalSnapshotVariant,
  status: string,
  artifact: string
): Promise<void> {
  await closeGoal(page);
  api.setReadOutcome("success");
  api.setSnapshotVariant(variant);
  await openGoal(page);
  const dialog = page.getByRole("dialog", { name: "/goal" });
  await expectGoalStatus(dialog, status);
  await page.screenshot({
    path: resolve(artifactDirectory, artifact),
    animations: "disabled"
  });
}

async function submitCreateOutcome(
  page: Page,
  api: GoalControlApiController,
  outcome: Exclude<GoalMutateOutcome, "pending" | "verified">,
  status: string
): Promise<void> {
  api.setSnapshotVariant("no_goal");
  api.setReadOutcome("success");
  api.setMutateOutcome(outcome);
  await openGoal(page);
  const dialog = page.getByRole("dialog", { name: "/goal" });
  await dialog.getByRole("textbox", { name: "Goal objective" }).fill(
    `Exercise ${outcome.replaceAll("_", " ")} handling.`
  );
  await dialog.getByRole("button", { name: "Create paused goal" }).click();
  await expectGoalStatus(dialog, status);
}

async function openGoal(page: Page, target = "android-release"): Promise<void> {
  await page.getByRole("button", { name: `/goal for ${target}` }).click();
  await expect(page.getByRole("dialog", { name: "/goal" })).toBeVisible();
}

async function closeGoal(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "/goal" });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
}

async function expectGoalStatus(
  dialog: ReturnType<Page["getByRole"]>,
  status: string
): Promise<void> {
  await expect(dialog.locator(".hostdeck-goal-sheet__status strong")).toHaveText(status);
}

function requiredRequest(requests: readonly Request[], index: number): Request {
  const request = requests[index];
  if (request === undefined) throw new TypeError("Expected goal request is missing.");
  return request;
}

function expectGoalRequest(request: Request | undefined, method: "GET" | "POST"): void {
  if (request === undefined) throw new TypeError("Expected goal request is missing.");
  expect(request.method()).toBe(method);
  expect(new URL(request.url())).toMatchObject({
    origin: "http://127.0.0.1:4175",
    pathname: `/api/v1/sessions/${sessionDetailBrowserSessionId}/goal`,
    search: "",
    hash: ""
  });
}

function supportedViewports(): ReadonlyArray<Readonly<{ width: number; height: number }>> {
  return [
    { width: 320, height: 800 },
    { width: 360, height: 800 },
    { width: 390, height: 844 },
    { width: 412, height: 915 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 }
  ];
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
    const composer = document.querySelector(".hostdeck-prompt-composer");
    const target = document.querySelector(".hostdeck-prompt-composer__target");
    if (
      !(controls instanceof HTMLElement) ||
      !(dock instanceof HTMLElement) ||
      !(model instanceof HTMLElement) ||
      !(goal instanceof HTMLElement) ||
      !(composer instanceof HTMLElement) ||
      !(target instanceof HTMLElement)
    ) {
      throw new TypeError("Session control dock geometry is unavailable.");
    }
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      controls: measure(controls),
      dock: measure(dock),
      model: measure(model),
      goal: measure(goal),
      composer: measure(composer),
      target: measure(target),
      commandCount: commands.length
    };
  });
  expect(measurement.controls.left).toBeGreaterThanOrEqual(0);
  expect(measurement.controls.right).toBeLessThanOrEqual(measurement.viewport.width + 1);
  expect(measurement.controls.bottom).toBeLessThanOrEqual(measurement.viewport.height + 1);
  expect(measurement.dock.bottom).toBeLessThanOrEqual(measurement.composer.top + 1);
  expect(measurement.commandCount).toBe(2);
  expect(measurement.model.height).toBeGreaterThanOrEqual(44);
  expect(measurement.goal.height).toBeGreaterThanOrEqual(44);
  expect(Math.abs(measurement.model.width - measurement.goal.width)).toBeLessThanOrEqual(1);
  expect(measurement.target.left).toBeGreaterThanOrEqual(measurement.composer.left);
  expect(measurement.target.right).toBeLessThanOrEqual(measurement.composer.right);
  return measurement;
}

async function expectGoalGeometry(page: Page) {
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
    const dialog = document.querySelector(".hostdeck-goal-sheet");
    const body = document.querySelector(".hostdeck-goal-sheet__body");
    const footer = document.querySelector(".hostdeck-goal-sheet__footer");
    const save = document.querySelector(".hostdeck-goal-sheet__save");
    const close = document.querySelector(".hostdeck-goal-sheet__header .hostdeck-icon-button");
    const rails = document.querySelector(".hostdeck-goal-state-rail");
    const objective = document.querySelector(".hostdeck-goal-objective");
    const actions = document.querySelector(".hostdeck-goal-actions");
    if (
      !(dialog instanceof HTMLElement) ||
      !(body instanceof HTMLElement) ||
      !(footer instanceof HTMLElement) ||
      !(save instanceof HTMLElement) ||
      !(close instanceof HTMLElement) ||
      !(rails instanceof HTMLElement) ||
      !(objective instanceof HTMLElement) ||
      !(actions instanceof HTMLElement)
    ) {
      throw new TypeError("Goal sheet geometry is unavailable.");
    }
    const textOverflow = [
      ...dialog.querySelectorAll("strong, small, legend, button, h2, p, dt, dd")
    ]
      .filter((element): element is HTMLElement => element instanceof HTMLElement)
      .some((element) => element.scrollWidth > element.clientWidth + 1);
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      dialog: measure(dialog),
      body: { ...measure(body), clientHeight: body.clientHeight, scrollHeight: body.scrollHeight },
      footer: measure(footer),
      save: measure(save),
      close: measure(close),
      rails: measure(rails),
      objective: measure(objective),
      actions: measure(actions),
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
  expect(measurement.save.height).toBeGreaterThanOrEqual(48);
  expect(measurement.close.width).toBeGreaterThanOrEqual(44);
  expect(measurement.close.height).toBeGreaterThanOrEqual(44);
  expect(measurement.rails.left).toBeGreaterThanOrEqual(measurement.dialog.left);
  expect(measurement.rails.right).toBeLessThanOrEqual(measurement.dialog.right);
  expect(measurement.objective.left).toBeGreaterThanOrEqual(measurement.dialog.left);
  expect(measurement.objective.right).toBeLessThanOrEqual(measurement.dialog.right);
  expect(measurement.actions.left).toBeGreaterThanOrEqual(measurement.dialog.left);
  expect(measurement.actions.right).toBeLessThanOrEqual(measurement.dialog.right);
  expect(measurement.textOverflow).toBe(false);
  return measurement;
}
