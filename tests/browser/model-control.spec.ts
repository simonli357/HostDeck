import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page, type Request, test } from "@playwright/test";
import { modelSelectionRequestSchema } from "../../packages/contracts/src/index.js";
import {
  installModelControlApi,
  type ModelControlApiController,
  type ModelSnapshotVariant
} from "./model-control-fixture.js";
import { sessionDetailBrowserSessionId } from "./session-detail-fixture.js";

const artifactDirectory = resolve("artifacts/fe-v1-021-primary-model-control");
const detailPath = `/sessions/${sessionDetailBrowserSessionId}`;
const visualReviewTime = new Date("2026-07-25T20:00:00.000Z");

test.beforeAll(async () => {
  await mkdir(artifactDirectory, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(visualReviewTime);
});

test("reads exact model truth and stages one correlated next-turn selection", async ({ page }) => {
  const diagnostics = observePage(page);
  const api = await installModelControlApi(page);
  await page.goto(detailPath);

  const trigger = page.getByRole("button", { name: "/model for android-release" });
  await expect(trigger).toBeVisible();
  await expect(page.getByRole("button", { name: "/goal for android-release" })).toBeVisible();
  await expect(page.getByRole("button", { name: "/plan for android-release" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "More session utilities for android-release" })
  ).toBeVisible();
  await expectDockGeometry(page);
  await trigger.click();

  const dialog = page.getByRole("dialog", { name: "/model" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Target: android-release", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Codex Alpha", { exact: true }).first()).toBeVisible();
  await expect(dialog.getByText("No pending change", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Model control ready", { exact: true })).toBeVisible();
  await expect
    .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);

  const reads = api.modelReadRequests();
  expect(reads).toHaveLength(1);
  expectModelRequest(reads[0], "GET");
  const alpha = dialog.getByRole("radio", { name: /Codex Alpha/u });
  const beta = dialog.getByRole("radio", { name: /Codex Beta/u });
  for (const radio of [alpha, beta]) {
    const bounds = await radio.boundingBox();
    expect(bounds?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  await alpha.focus();
  await page.keyboard.press("ArrowDown");
  await expect(beta).toBeChecked();
  await expect(dialog.getByRole("radio", { name: "Medium" })).toBeChecked();
  await dialog.getByText("Low", { exact: true }).click();

  const submit = dialog.getByRole("button", { name: "Set for next turn" });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(dialog.getByText("Model staged for next turn", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Pending next turn: Staged in HostDeck", { exact: true }))
    .toBeVisible();
  await expect(dialog.getByText("Codex Alpha", { exact: true }).first()).toBeVisible();
  await expect(dialog.getByText("Codex Beta", { exact: true }).first()).toBeVisible();

  const writes = api.modelSelectRequests();
  expect(writes).toHaveLength(1);
  const write = requiredRequest(writes, 0);
  expectModelRequest(write, "POST");
  const body = modelSelectionRequestSchema.parse(write.postDataJSON());
  expect(body).toEqual({
    operation_id: expect.stringMatching(/^op_browser_model_[0-9a-f]{32}$/u),
    kind: "model",
    model_id: "model-b",
    reasoning_effort: "low",
    expected_pending_revision: null
  });
  expect(JSON.stringify(body)).not.toContain("/model");
  expect(write.headers()["x-hostdeck-csrf"]).toBe("D".repeat(43));
  expect(write.headers()["x-hostdeck-csrf-generation"]).toBe("1");
  await page.screenshot({
    path: resolve(artifactDirectory, "staged-selection-390x844.png"),
    animations: "disabled"
  });

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expectCleanBrowser(diagnostics);
});

test("owns one in-flight selection and blocks duplicate submit or dismissal", async ({ page }) => {
  const diagnostics = observePage(page);
  const api = await installModelControlApi(page);
  api.setSelectOutcome("pending");
  await page.goto(detailPath);
  await openModel(page);

  const dialog = page.getByRole("dialog", { name: "/model" });
  await dialog.getByText("Codex Beta", { exact: true }).click();
  const submit = dialog.getByRole("button", { name: "Set for next turn" });
  await submit.click();
  await expect(dialog.getByText("Saving next-turn model", { exact: true })).toBeVisible();
  await expect.poll(() => api.hasPendingModelSelect()).toBe(true);
  await expect(submit).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Close model control" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();

  await submit.evaluate((button) => (button as HTMLButtonElement).click());
  await page.keyboard.press("Enter");
  await page.setViewportSize({ width: 390, height: 843 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  expect(api.modelSelectRequests()).toHaveLength(1);
  await page.screenshot({
    path: resolve(artifactDirectory, "submitting-390x844.png"),
    animations: "disabled"
  });

  api.releaseModelSelect();
  await expect(dialog.getByText("Model staged for next turn", { exact: true })).toBeVisible();
  expect(api.modelSelectRequests()).toHaveLength(1);
  await expectCleanBrowser(diagnostics);
});

test("renders the complete deterministic model state and failure matrix", async ({ page }) => {
  const diagnostics = observePage(page);
  const api = await installModelControlApi(page);
  api.setReadOutcome("pending");
  await page.goto(detailPath);
  await page.getByRole("button", { name: "/model for android-release" }).click();
  const dialog = page.getByRole("dialog", { name: "/model" });
  await expect(dialog.getByText("Loading models", { exact: true })).toBeVisible();
  await expect.poll(() => api.hasPendingModelRead()).toBe(true);
  await page.screenshot({
    path: resolve(artifactDirectory, "loading-390x844.png"),
    animations: "disabled"
  });
  api.releaseModelRead();
  await expect(dialog.getByText("Model control ready", { exact: true })).toBeVisible();
  await page.screenshot({
    path: resolve(artifactDirectory, "ready-current-390x844.png"),
    animations: "disabled"
  });

  await captureSnapshotState(page, api, "pending", "Model staged for next turn", "pending-390x844.png");
  await captureSnapshotState(
    page,
    api,
    "dispatching",
    "Preparing next-turn settings",
    "dispatching-390x844.png"
  );
  await captureSnapshotState(
    page,
    api,
    "awaiting_confirmation",
    "Turn accepted; awaiting model confirmation",
    "awaiting-confirmation-390x844.png"
  );
  await captureSnapshotState(page, api, "conflict", "Pending model conflict", "conflict-390x844.png");
  await captureSnapshotState(
    page,
    api,
    "unknown",
    "Model confirmation unknown",
    "pending-unknown-390x844.png"
  );

  await closeModel(page);
  api.setReadOutcome("unsupported");
  await openModel(page);
  await expect(dialog.getByText("Model control unsupported", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Set for next turn" })).toBeDisabled();
  await page.screenshot({
    path: resolve(artifactDirectory, "unsupported-390x844.png"),
    animations: "disabled"
  });

  await closeModel(page);
  api.setReadOutcome("success");
  api.setSnapshotVariant("ready");
  api.setSelectOutcome("known_failure");
  await openModel(page);
  await dialog.getByText("Codex Beta", { exact: true }).click();
  await dialog.getByRole("button", { name: "Set for next turn" }).click();
  await expect(dialog.getByText("Model selection was not saved", { exact: true })).toBeVisible();
  await expect(dialog.getByText("HostDeck is temporarily too busy to save this selection.", {
    exact: true
  })).toBeVisible();
  await expect(dialog).not.toContainText("Private model fixture detail");
  await page.screenshot({
    path: resolve(artifactDirectory, "known-failure-390x844.png"),
    animations: "disabled"
  });

  await closeModel(page);
  api.setSessionVariant("read_only");
  api.setSelectOutcome("staged");
  await page.reload();
  await openModel(page);
  await expect(dialog.getByText("Read-only access cannot change models.").first()).toBeVisible();
  await expect(dialog.getByRole("group", { name: "Select model" })).toHaveAttribute(
    "disabled",
    ""
  );
  await expect(dialog.getByRole("button", { name: "Set for next turn" })).toBeDisabled();
  await page.screenshot({
    path: resolve(artifactDirectory, "read-only-390x844.png"),
    animations: "disabled"
  });
  expect(api.modelSelectRequests()).toHaveLength(1);

  await closeModel(page);
  api.setSessionVariant("writable");
  api.setSnapshotVariant("ready");
  api.setSelectOutcome("correlation_mismatch");
  await page.reload();
  await openModel(page);
  await dialog.getByText("Codex Beta", { exact: true }).click();
  await dialog.getByRole("button", { name: "Set for next turn" }).click();
  await expect(dialog.getByText("Selection outcome unknown", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("group", { name: "Select model" })).toHaveAttribute(
    "disabled",
    ""
  );
  await expect(dialog).not.toContainText("Private model fixture detail");
  await page.screenshot({
    path: resolve(artifactDirectory, "outcome-unknown-390x844.png"),
    animations: "disabled"
  });
  expect(api.modelSelectRequests()).toHaveLength(2);

  await dialog.getByRole("button", { name: "Check model state" }).click();
  await expect(dialog.getByText("Model staged for next turn", { exact: true })).toBeVisible();
  expect(api.modelSelectRequests()).toHaveLength(2);
  await expectCleanBrowser(diagnostics, [
    /status of 409 \(Conflict\)/u,
    /status of 503 \(Service Unavailable\)/u
  ]);
});

test("contains long model controls across mobile, desktop, short-height, and 200 percent zoom", async ({
  page
}) => {
  const diagnostics = observePage(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installModelControlApi(page, {
    sessionVariant: "writable_long",
    snapshotVariant: "long"
  });
  await page.goto(detailPath);
  await expect(
    page.getByRole("button", {
      name: "/model for android-release-validation-long-session-name-2026"
    })
  ).toBeVisible();

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
  await openModel(page, "android-release-validation-long-session-name-2026");
  for (const viewport of [
    { width: 320, height: 800 },
    { width: 360, height: 800 },
    { width: 390, height: 844 },
    { width: 412, height: 915 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 }
  ]) {
    await page.setViewportSize(viewport);
    measurements.push({ viewport, sheet: await expectModelGeometry(page) });
    await page.screenshot({
      path: resolve(artifactDirectory, `long-${viewport.width}x${viewport.height}.png`),
      animations: "disabled"
    });
  }

  await page.setViewportSize({ width: 320, height: 800 });
  const body = page.locator(".hostdeck-model-sheet__body");
  await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.getByText("Effort level", { exact: true })).toBeVisible();
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
    sheet: await expectModelGeometry(page)
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
    sheet: await expectModelGeometry(page)
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
  api: ModelControlApiController,
  variant: ModelSnapshotVariant,
  status: string,
  artifact: string
): Promise<void> {
  await closeModel(page);
  api.setSnapshotVariant(variant);
  await openModel(page);
  const dialog = page.getByRole("dialog", { name: "/model" });
  await expect(dialog.getByText(status, { exact: true })).toBeVisible();
  await page.screenshot({
    path: resolve(artifactDirectory, artifact),
    animations: "disabled"
  });
}

async function openModel(page: Page, target = "android-release"): Promise<void> {
  await page.getByRole("button", { name: `/model for ${target}` }).click();
  await expect(page.getByRole("dialog", { name: "/model" })).toBeVisible();
}

async function closeModel(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "/model" });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
}

function requiredRequest(requests: readonly Request[], index: number): Request {
  const request = requests[index];
  if (request === undefined) throw new TypeError("Expected model request is missing.");
  return request;
}

function expectModelRequest(request: Request | undefined, method: "GET" | "POST"): void {
  if (request === undefined) throw new TypeError("Expected model request is missing.");
  expect(request.method()).toBe(method);
  expect(new URL(request.url())).toMatchObject({
    origin: "http://127.0.0.1:4175",
    pathname: `/api/v1/sessions/${sessionDetailBrowserSessionId}/model`,
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

async function expectModelGeometry(page: Page) {
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
    const dialog = document.querySelector(".hostdeck-model-sheet");
    const body = document.querySelector(".hostdeck-model-sheet__body");
    const footer = document.querySelector(".hostdeck-model-sheet__footer");
    const submit = document.querySelector(".hostdeck-model-sheet__submit");
    const close = document.querySelector(".hostdeck-model-sheet__header .hostdeck-icon-button");
    const rails = document.querySelector(".hostdeck-model-state-rail");
    const options = document.querySelector(".hostdeck-model-options");
    if (
      !(dialog instanceof HTMLElement) ||
      !(body instanceof HTMLElement) ||
      !(footer instanceof HTMLElement) ||
      !(submit instanceof HTMLElement) ||
      !(close instanceof HTMLElement) ||
      !(rails instanceof HTMLElement) ||
      !(options instanceof HTMLElement)
    ) {
      throw new TypeError("Model sheet geometry is unavailable.");
    }
    const textOverflow = [...dialog.querySelectorAll("strong, small, legend, label span")]
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
