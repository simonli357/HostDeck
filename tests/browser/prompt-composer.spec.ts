import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page, type Request, test } from "@playwright/test";
import { promptSessionRequestSchema } from "../../packages/contracts/src/index.js";
import {
  installSessionDetailApi,
  promptTurnEvent,
  sessionDetailBrowserSessionId
} from "./session-detail-fixture.js";

const artifactDirectory = resolve("artifacts/fe-v1-020-selected-session-prompt-composer");
const detailPath = `/sessions/${sessionDetailBrowserSessionId}`;
const visualReviewTime = new Date("2026-07-25T20:00:00.000Z");
const firstPrompt = "Review the selected mobile prompt boundary.\nKeep the response structured.";
const followUpPrompt = "Continue with the bounded browser evidence.";

test.beforeAll(async () => {
  await mkdir(artifactDirectory, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(visualReviewTime);
});

test("dispatches exact start and steer requests and advances only from matching events", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const api = await installSessionDetailApi(page, "writable");
  await page.goto(detailPath);

  const textarea = page.getByRole("textbox", { name: "Prompt for android-release" });
  const send = page.getByRole("button", { name: "Send prompt to android-release" });
  await expect(textarea).toBeEditable();
  await expect(send).toBeDisabled();
  await expect(page.getByText("Ready to send", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^\/model for /u })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /^\/goal for /u })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /^\/plan for /u })).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "More session utilities for android-release" })
  ).toBeVisible();
  await expectFooterGeometry(page);
  await page.screenshot({
    path: resolve(artifactDirectory, "ready-390x844.png"),
    animations: "disabled"
  });

  await textarea.fill("  Review the selected mobile prompt boundary.");
  await textarea.press("Enter");
  await textarea.type("Keep the response structured.  ");
  await expect(textarea).toHaveValue(`  ${firstPrompt}  `);
  await expect(send).toBeEnabled();
  await page.screenshot({
    path: resolve(artifactDirectory, "composing-390x844.png"),
    animations: "disabled",
    mask: [textarea],
    maskColor: "#111315"
  });
  const routeBeforeSubmit = page.url();
  await send.click();

  await expect(page.getByText("New turn accepted", { exact: true })).toBeVisible();
  await expect(page.getByText("Turn running", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Turn completed", { exact: true })).toHaveCount(0);
  await expect(textarea).toHaveValue("");
  await expect(textarea).toBeFocused();
  expect(page.url()).toBe(routeBeforeSubmit);

  const firstRequest = requiredPromptRequest(api.promptRequests(), 0);
  const firstBody = promptSessionRequestSchema.parse(firstRequest.postDataJSON());
  expect(firstBody).toEqual({
    operation_id: expect.stringMatching(/^op_browser_prompt_[0-9a-f]{32}$/u),
    kind: "prompt",
    text: firstPrompt
  });
  expect(new URL(firstRequest.url())).toMatchObject({
    origin: "http://127.0.0.1:4175",
    pathname: `/api/v1/sessions/${sessionDetailBrowserSessionId}/prompts`,
    search: "",
    hash: ""
  });
  expect(firstRequest.headers()["x-hostdeck-csrf"]).toBe("D".repeat(43));
  expect(firstRequest.headers()["x-hostdeck-csrf-generation"]).toBe("1");
  await expectPromptAbsentFromBrowserState(page, [firstPrompt]);
  await page.screenshot({
    path: resolve(artifactDirectory, "accepted-start-390x844.png"),
    animations: "disabled"
  });

  await api.pushEvent(promptTurnEvent(4, "completed", "turn-unrelated-browser-prompt"));
  await expect(page.getByText("New turn accepted", { exact: true })).toBeVisible();
  await api.pushEvent(promptTurnEvent(5, "in_progress"));
  await expect(page.getByText("Turn running", { exact: true })).toBeVisible();
  await expect(textarea).toBeEditable();
  await page.screenshot({
    path: resolve(artifactDirectory, "running-390x844.png"),
    animations: "disabled"
  });

  api.setPromptOutcome("accepted_steer");
  await textarea.fill(followUpPrompt);
  await send.click();
  await expect(page.getByText("Follow-up accepted", { exact: true })).toBeVisible();
  await expect(textarea).toHaveValue("");
  const secondRequest = requiredPromptRequest(api.promptRequests(), 1);
  const secondBody = promptSessionRequestSchema.parse(secondRequest.postDataJSON());
  expect(secondBody).toMatchObject({ kind: "prompt", text: followUpPrompt });
  expect(secondBody.operation_id).not.toBe(firstBody.operation_id);
  await expectPromptAbsentFromBrowserState(page, [firstPrompt, followUpPrompt]);
  await page.screenshot({
    path: resolve(artifactDirectory, "accepted-steer-390x844.png"),
    animations: "disabled"
  });

  await api.pushEvent(promptTurnEvent(6, "completed"));
  await expect(page.getByText("Turn completed", { exact: true })).toBeVisible();
  await page.screenshot({
    path: resolve(artifactDirectory, "completed-390x844.png"),
    animations: "disabled"
  });

  expect(api.promptRequests()).toHaveLength(2);
  await expectPromptAbsentFromBrowserState(page, [firstPrompt, followUpPrompt]);
  await expectCleanBrowser(diagnostics);
});

test("holds one pending request across duplicate click, key, form, and rerender attempts", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const api = await installSessionDetailApi(page, "writable");
  api.setPromptOutcome("pending");
  await page.goto(detailPath);

  const textarea = page.getByRole("textbox", { name: "Prompt for android-release" });
  const send = page.getByRole("button", { name: "Send prompt to android-release" });
  await textarea.fill(firstPrompt);
  await send.click();
  await expect(page.getByText("Sending prompt", { exact: true })).toBeVisible();
  await expect(textarea).toBeDisabled();
  await expect(send).toBeDisabled();
  await expect.poll(() => api.hasPendingPrompt()).toBe(true);

  await page.locator('form[aria-label="Prompt composer"]').evaluate((form) => {
    (form as HTMLFormElement).requestSubmit();
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await page.keyboard.press("Control+Enter");
  await page.setViewportSize({ width: 390, height: 843 });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => api.promptRequests().length).toBe(1);
  await page.screenshot({
    path: resolve(artifactDirectory, "submitting-390x844.png"),
    animations: "disabled",
    mask: [textarea],
    maskColor: "#111315"
  });

  api.releasePendingPrompt();
  await expect(page.getByText("New turn accepted", { exact: true })).toBeVisible();
  await expect(textarea).toBeFocused();
  expect(api.promptRequests()).toHaveLength(1);
  await expectPromptAbsentFromBrowserState(page, [firstPrompt]);
  await expectCleanBrowser(diagnostics);
});

test("retries only an explicit safe rejection and uses a fresh operation id", async ({ page }) => {
  const diagnostics = observePage(page);
  const api = await installSessionDetailApi(page, "writable");
  api.setPromptOutcome("retryable_rejection");
  await page.goto(detailPath);

  const textarea = page.getByRole("textbox", { name: "Prompt for android-release" });
  await textarea.fill(firstPrompt);
  await page.getByRole("button", { name: "Send prompt to android-release" }).click();
  await expect(page.getByText("Prompt was not accepted", { exact: true })).toBeVisible();
  await expect(textarea).toHaveValue(firstPrompt);
  await expect(textarea).toBeFocused();
  const retry = page.getByRole("button", { name: "Retry prompt to android-release" });
  await expect(retry).toBeEnabled();
  await page.screenshot({
    path: resolve(artifactDirectory, "retryable-rejection-390x844.png"),
    animations: "disabled",
    mask: [textarea],
    maskColor: "#111315"
  });

  api.setPromptOutcome("accepted_start");
  await retry.click();
  await expect(page.getByText("New turn accepted", { exact: true })).toBeVisible();
  const requests = api.promptRequests();
  expect(requests).toHaveLength(2);
  const first = promptSessionRequestSchema.parse(requiredPromptRequest(requests, 0).postDataJSON());
  const second = promptSessionRequestSchema.parse(requiredPromptRequest(requests, 1).postDataJSON());
  expect(second.operation_id).not.toBe(first.operation_id);
  expect(second.text).toBe(first.text);
  await expectPromptAbsentFromBrowserState(page, [firstPrompt]);

  api.setPromptOutcome("nonretryable_rejection");
  await textarea.fill(followUpPrompt);
  await page.getByRole("button", { name: "Send prompt to android-release" }).click();
  await expect(page.getByText("Prompt could not be sent", { exact: true })).toBeVisible();
  await expect(textarea).toHaveValue(followUpPrompt);
  await expect(page.getByRole("button", { name: "Send prompt to android-release" }))
    .toBeDisabled();
  await page.screenshot({
    path: resolve(artifactDirectory, "nonretryable-rejection-390x844.png"),
    animations: "disabled",
    mask: [textarea],
    maskColor: "#111315"
  });
  await textarea.fill(`${followUpPrompt} Updated`);
  await expect(page.getByText("Ready to send", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send prompt to android-release" }))
    .toBeEnabled();
  expect(api.promptRequests()).toHaveLength(3);
  await textarea.fill("");
  await expectPromptAbsentFromBrowserState(page, [firstPrompt, followUpPrompt]);
  await expectCleanBrowser(diagnostics, [
    /status of 503 \(Service Unavailable\)/u,
    /status of 409 \(Conflict\)/u
  ]);
});

test("latches a correlation ambiguity until an explicit reload without redispatch", async ({ page }) => {
  const diagnostics = observePage(page);
  const api = await installSessionDetailApi(page, "writable");
  api.setPromptOutcome("correlation_mismatch");
  await page.goto(detailPath);

  const textarea = page.getByRole("textbox", { name: "Prompt for android-release" });
  await textarea.fill(firstPrompt);
  await page.getByRole("button", { name: "Send prompt to android-release" }).click();
  await expect(page.getByText("Prompt outcome unknown", { exact: true })).toBeVisible();
  await expect(textarea).toHaveValue(firstPrompt);
  await expect(textarea).toHaveAttribute("readonly", "");
  await expect(page.getByRole("button", { name: "Send prompt to android-release" }))
    .toBeDisabled();

  await page.locator('form[aria-label="Prompt composer"]').evaluate((form) => {
    (form as HTMLFormElement).requestSubmit();
  });
  await textarea.press("Control+Enter");
  expect(api.promptRequests()).toHaveLength(1);
  await page.screenshot({
    path: resolve(artifactDirectory, "outcome-unknown-390x844.png"),
    animations: "disabled",
    mask: [textarea],
    maskColor: "#111315"
  });

  await Promise.all([
    page.waitForEvent("framenavigated"),
    page.getByRole("button", { name: "Reload to check" }).click()
  ]);
  await expect(textarea).toBeEditable();
  await expect(textarea).toHaveValue("");
  expect(api.promptRequests()).toHaveLength(1);
  await expectPromptAbsentFromBrowserState(page, [firstPrompt]);
  await expectCleanBrowser(diagnostics);
});

test("renders distinct authority, host, CSRF, turn, and freshness disabled families", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const api = await installSessionDetailApi(page, "writable");
  await page.goto(detailPath);

  for (const state of [
    {
      variant: "read_only" as const,
      detail: "Read-only access cannot send prompts.",
      artifact: "disabled-read-only-390x844.png"
    },
    {
      variant: "locked" as const,
      detail: "Remote writes are locked on the laptop.",
      artifact: "disabled-host-locked-390x844.png"
    },
    {
      variant: "csrf_failed" as const,
      detail: "Secure write setup is not ready.",
      artifact: "disabled-csrf-390x844.png"
    },
    {
      variant: "waiting_input" as const,
      detail: "Respond to the pending input request first.",
      artifact: "disabled-needs-input-390x844.png"
    },
    {
      variant: "turn_unknown" as const,
      detail: "Turn state is unknown. Refresh before sending.",
      artifact: "disabled-turn-unknown-390x844.png"
    },
    {
      variant: "stale_session" as const,
      detail: "Session state is stale. Refresh before sending.",
      artifact: "disabled-stale-session-390x844.png"
    }
  ]) {
    api.setVariant(state.variant);
    await page.reload();
    const textarea = page.getByRole("textbox", { name: "Prompt for android-release" });
    await expect(textarea).toBeVisible();
    await expect(textarea).toBeDisabled();
    await expect(page.getByText(state.detail, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send prompt to android-release" }))
      .toBeDisabled();
    await expectFooterGeometry(page);
    await page.screenshot({
      path: resolve(artifactDirectory, state.artifact),
      animations: "disabled"
    });
  }

  expect(api.promptRequests()).toHaveLength(0);
  await expect(page.getByRole("button", { name: /^\/model for /u })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /^\/goal for /u })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /^\/plan for /u })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /More session utilities/iu })).toHaveCount(1);
  await expectCleanBrowser(diagnostics, [/status of 503 \(Service Unavailable\)/u]);
});

test("contains the composer at reflow, desktop, zoom, long-target, and keyboard-height bounds", async ({
  page
}) => {
  const diagnostics = observePage(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const api = await installSessionDetailApi(page, "writable_long");
  await page.goto(detailPath);
  const textarea = page.getByRole("textbox", {
    name: "Prompt for android-release-validation-long-session-name-2026"
  });
  await expect(textarea).toBeEditable();

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
    measurements.push(await expectFooterGeometry(page));
  }

  await page.setViewportSize({ width: 320, height: 480 });
  await textarea.focus();
  await expectFooterGeometry(page);
  await page.screenshot({
    path: resolve(artifactDirectory, "short-height-long-target-320x480.png"),
    animations: "disabled"
  });

  await textarea.fill("one\ntwo\nthree\nfour\nfive\nsix\nseven\neight");
  const textareaBounds = await textarea.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight
  }));
  expect(textareaBounds.clientHeight).toBeGreaterThan(56);
  expect(textareaBounds.clientHeight).toBeLessThanOrEqual(112);
  expect(textareaBounds.scrollHeight).toBeGreaterThan(textareaBounds.clientHeight);
  await textarea.fill("");

  await page.setViewportSize({ width: 390, height: 420 });
  await textarea.focus();
  await expectFooterGeometry(page);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expectLastTimelineItemAboveComposer(page);
  await page.screenshot({
    path: resolve(artifactDirectory, "keyboard-height-proxy-390x420.png"),
    animations: "disabled"
  });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
    window.scrollTo(0, 0);
  });
  await expectNoHorizontalOverflow(page);
  await expectFooterGeometry(page, 1280);
  await page.screenshot({
    path: resolve(artifactDirectory, "zoom-200-1280x800.png"),
    animations: "disabled"
  });
  await writeFile(
    resolve(artifactDirectory, "layout-measurements.json"),
    `${JSON.stringify({ measurements }, null, 2)}\n`,
    "utf8"
  );

  expect(api.promptRequests()).toHaveLength(0);
  await expectCleanBrowser(diagnostics);
});

function requiredPromptRequest(requests: readonly Request[], index: number): Request {
  const request = requests[index];
  if (request === undefined) throw new TypeError("Expected prompt request is missing.");
  return request;
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

async function expectPromptAbsentFromBrowserState(
  page: Page,
  promptTexts: readonly string[]
): Promise<void> {
  const state = await page.evaluate(() => ({
    body: document.body.innerText,
    href: window.location.href,
    historyState: JSON.stringify(window.history.state),
    local: JSON.stringify({ ...window.localStorage }),
    session: JSON.stringify({ ...window.sessionStorage })
  }));
  for (const promptText of promptTexts) {
    expect(JSON.stringify(state)).not.toContain(promptText);
  }
  expect(new URL(state.href).hash).toBe("");
  expect(new URL(state.href).search).toBe("");
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth
      }))
    )
    .toEqual(await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.clientWidth
    })));
}

async function expectFooterGeometry(page: Page, maximumWidth = 820) {
  await expectNoHorizontalOverflow(page);
  const measurement = await page.evaluate(() => {
    const footer = document.querySelector(".hostdeck-prompt-composer");
    const target = document.querySelector(".hostdeck-prompt-composer__target");
    const form = document.querySelector(".hostdeck-prompt-composer__form");
    const send = document.querySelector(".hostdeck-prompt-composer__send");
    const status = document.querySelector(".hostdeck-prompt-composer__status");
    if (
      !(footer instanceof HTMLElement) ||
      !(target instanceof HTMLElement) ||
      !(form instanceof HTMLElement) ||
      !(send instanceof HTMLElement) ||
      !(status instanceof HTMLElement)
    ) {
      throw new TypeError("Prompt composer geometry is unavailable.");
    }
    const box = (element: HTMLElement) => {
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
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      footer: box(footer),
      target: box(target),
      form: box(form),
      send: box(send),
      status: box(status)
    };
  });
  expect(measurement.footer.left).toBeGreaterThanOrEqual(0);
  expect(measurement.footer.right).toBeLessThanOrEqual(measurement.viewport.width + 1);
  expect(measurement.footer.top).toBeGreaterThanOrEqual(55);
  expect(measurement.footer.bottom).toBeLessThanOrEqual(measurement.viewport.height + 1);
  expect(measurement.footer.width).toBeLessThanOrEqual(maximumWidth);
  expect(measurement.send.width).toBeGreaterThanOrEqual(44);
  expect(measurement.send.height).toBeGreaterThanOrEqual(44);
  for (const child of [measurement.target, measurement.form, measurement.status]) {
    expect(child.left).toBeGreaterThanOrEqual(measurement.footer.left);
    expect(child.right).toBeLessThanOrEqual(measurement.footer.right);
    expect(child.top).toBeGreaterThanOrEqual(measurement.footer.top);
    expect(child.bottom).toBeLessThanOrEqual(measurement.footer.bottom);
  }
  return measurement;
}

async function expectLastTimelineItemAboveComposer(page: Page): Promise<void> {
  const positions = await page.evaluate(() => {
    const item = document.querySelector(".hostdeck-timeline-item:last-of-type");
    const footer = document.querySelector(".hostdeck-prompt-composer");
    if (!(item instanceof HTMLElement) || !(footer instanceof HTMLElement)) {
      throw new TypeError("Prompt composer overlap check is unavailable.");
    }
    return {
      itemBottom: item.getBoundingClientRect().bottom,
      footerTop: footer.getBoundingClientRect().top
    };
  });
  expect(positions.itemBottom).toBeLessThanOrEqual(positions.footerTop);
}
