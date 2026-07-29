import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Locator, type Page, type Request, test } from "@playwright/test";
import { approvalResponseRequestSchema } from "../../packages/contracts/src/index.js";
import {
  type ApprovalDecisionsApiController,
  type ApprovalSnapshotVariant,
  installApprovalDecisionsApi
} from "./approval-decisions-fixture.js";
import { sessionDetailBrowserSessionId } from "./session-detail-fixture.js";

const artifactDirectory = resolve("artifacts/fe-v1-022-inline-approval-decisions");
const detailPath = `/sessions/${sessionDetailBrowserSessionId}`;
const visualReviewTime = new Date("2026-07-22T22:00:00.000Z");

test.beforeAll(async () => {
  await mkdir(artifactDirectory, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(visualReviewTime);
});

test("approves and denies one exact request through the protected production path", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const api = await installApprovalDecisionsApi(page, { snapshotVariant: "elevated" });
  await page.goto(detailPath);

  const item = approvalItem(page, "Install the Android validation package");
  const trigger = item.getByRole("button", { name: "Review & approve" });
  await expect(trigger).toBeVisible();
  await expect(item.getByRole("button", { name: "Deny" })).toBeVisible();
  await expectApprovalTargets(item);
  await captureItem(page, item, "elevated-pending-390x844.png");

  await trigger.focus();
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Approve elevated request?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Target: android-release", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Install the Android validation package", { exact: true }))
    .toBeVisible();
  await expect(dialog.getByText("Connected test phone", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Elevated risk", { exact: true })).toBeVisible();
  await expect(dialog.getByText("One time", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expectSheetGeometry(page, dialog);
  await page.screenshot({
    path: resolve(artifactDirectory, "elevated-confirmation-390x844.png"),
    animations: "disabled"
  });

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(api.approvalRespondRequests()).toHaveLength(0);

  api.setRespondOutcome("pending");
  await trigger.click();
  await dialog.getByRole("button", { name: "Approve once" }).click();
  await expect.poll(api.hasPendingResponse).toBe(true);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Confirming decision", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Approve once" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Close approval confirmation" }))
    .toBeDisabled();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  expect(api.approvalRespondRequests()).toHaveLength(1);
  await page.screenshot({
    path: resolve(artifactDirectory, "responding-390x844.png"),
    animations: "disabled"
  });

  const approveRequest = requiredRequest(api.approvalRespondRequests(), 0);
  expectApprovalRequest(approveRequest, "request-private-browser-detail", "approve");
  api.releaseResponse("terminal");
  await expect(dialog).toBeHidden();
  await expect(item.getByText("Approved once", { exact: true })).toBeVisible();
  await expect(item.getByText("The selected request was approved once.", { exact: true }))
    .toBeVisible();
  await captureItem(page, item, "approved-390x844.png");

  api.setSnapshotVariant("elevated");
  api.setRespondOutcome("terminal");
  await page.reload();
  const resetItem = approvalItem(page, "Install the Android validation package");
  await resetItem.getByRole("button", { name: "Deny" }).click();
  await expect(resetItem.getByText("Request denied", { exact: true })).toBeVisible();
  const denyRequest = requiredRequest(api.approvalRespondRequests(), 1);
  expectApprovalRequest(denyRequest, "request-private-browser-detail", "deny");
  await captureItem(page, resetItem, "denied-390x844.png");

  expect(api.approvalRespondRequests()).toHaveLength(2);
  await expectPrivateDataAbsent(page);
  await expectCleanBrowser(diagnostics);
});

test("renders the complete reconciliation and terminal state matrix", async ({ page }) => {
  const diagnostics = observePage(page);
  const api = await installApprovalDecisionsApi(page, { snapshotVariant: "empty" });
  await page.goto(detailPath);

  await captureState(page, api, "empty", "Approval status checking", "event-only-390x844.png");
  await captureState(page, api, "conflict", "Approval details conflict", "conflict-390x844.png");
  await captureState(page, api, "responding", "Approval response pending", "server-responding-390x844.png");
  await captureState(page, api, "approved", "Approved once", "server-approved-390x844.png");
  await captureState(page, api, "denied", "Request denied", "server-denied-390x844.png");
  await captureState(page, api, "expired", "Approval expired", "expired-390x844.png");
  await captureState(page, api, "superseded", "Approval superseded", "superseded-390x844.png");
  await captureState(page, api, "list_only", "Run the focused Android release validation", "list-only-390x844.png");
  await captureState(page, api, "normal", "Approve once", "normal-pending-390x844.png", "button");
  await captureState(
    page,
    api,
    "broad",
    "Publish the signed Android validation package",
    "broad-pending-390x844.png"
  );
  await captureState(page, api, "session_grant", "Ongoing policy", "ongoing-policy-390x844.png");
  await expect(page.getByText("Ongoing policy grants are not supported in HostDeck V1."))
    .toBeVisible();
  await expect(page.getByRole("button", { name: /Approve|Deny/u })).toHaveCount(0);

  await captureState(
    page,
    api,
    "multiple",
    "Publish the signed Android validation package",
    "multiple-390x844.png"
  );
  await expect(page.locator(".hostdeck-approval-item")).toHaveCount(3);
  await expectPrivateDataAbsent(page);
  await expectCleanBrowser(diagnostics);
});

test("shows list loading, empty, unsupported, read failure, known rejection, and unknown outcome", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const api = await installApprovalDecisionsApi(page, {
    sessionVariant: "writable",
    snapshotVariant: "empty",
    readOutcome: "pending"
  });
  await page.goto(detailPath);

  await expect(page.getByText("Loading approvals", { exact: true })).toBeVisible();
  await captureApprovalStatus(page, "list-loading-390x844.png");
  api.releaseRead("success");
  await expect(page.getByText("Loading approvals", { exact: true })).toBeHidden();
  await expect(page.locator(".hostdeck-approval-item")).toHaveCount(0);
  await page.screenshot({
    path: resolve(artifactDirectory, "list-empty-390x844.png"),
    animations: "disabled"
  });

  api.setReadOutcome("known_failure");
  await page.reload();
  await expect(page.getByText("Approval status unavailable", { exact: true })).toBeVisible();
  await captureApprovalStatus(page, "list-failure-390x844.png");

  api.setReadOutcome("unsupported");
  await page.reload();
  await expect(page.getByText("Approvals unsupported", { exact: true })).toBeVisible();
  await captureApprovalStatus(page, "list-unsupported-390x844.png");

  api.setReadOutcome("success");
  api.setSnapshotVariant("normal");
  api.setRespondOutcome("known_failure");
  await page.reload();
  await page.getByRole("button", { name: "Approve once" }).click();
  await expect(page.getByText("Decision not sent", { exact: true })).toBeVisible();
  await expect(page.getByText("HostDeck is temporarily too busy for this approval."))
    .toBeVisible();
  await captureApprovalStatus(page, "known-decision-failure-390x844.png");
  expect(api.approvalRespondRequests()).toHaveLength(1);

  await page.getByRole("button", { name: "Check status" }).click();
  await expect(page.getByRole("button", { name: "Approve once" })).toBeEnabled();
  api.setRespondOutcome("unsupported");
  await page.getByRole("button", { name: "Approve once" }).click();
  await expect(page.getByText("Approval unsupported", { exact: true })).toBeVisible();
  await expect(page.getByText(
    "The installed Codex runtime does not support approval controls.",
    { exact: true }
  )).toBeVisible();
  await captureApprovalStatus(page, "decision-unsupported-390x844.png");
  expect(api.approvalRespondRequests()).toHaveLength(2);

  await page.getByRole("button", { name: "Check status" }).click();
  await expect(page.getByRole("button", { name: "Approve once" })).toBeEnabled();
  api.setRespondOutcome("ambiguous");
  await page.getByRole("button", { name: "Approve once" }).click();
  await expect(page.getByText("Decision outcome unknown", { exact: true })).toBeVisible();
  await expect(page.getByText(/HostDeck will not retry automatically/u)).toBeVisible();
  await page.waitForTimeout(250);
  expect(api.approvalRespondRequests()).toHaveLength(3);
  await captureApprovalStatus(page, "unknown-decision-outcome-390x844.png");

  await page.getByRole("button", { name: "Check status" }).click();
  await expect(page.getByRole("button", { name: "Approve once" })).toBeEnabled();
  api.setRespondOutcome("correlation_mismatch");
  await page.getByRole("button", { name: "Approve once" }).click();
  await expect(page.getByText("Decision outcome unknown", { exact: true })).toBeVisible();
  await expect(page.getByText("The selected request was approved once.", { exact: true }))
    .toHaveCount(0);
  expect(api.approvalRespondRequests()).toHaveLength(4);
  expect(api.approvalReadRequests()).toHaveLength(7);

  await expectPrivateDataAbsent(page);
  await expectExpectedApiFailures(diagnostics, [
    { method: "GET", route: "approval_list", status: 503 },
    { method: "GET", route: "approval_list", status: 409 },
    { method: "POST", route: "approval_respond", status: 503 },
    { method: "POST", route: "approval_respond", status: 409 },
    { method: "POST", route: "approval_respond", status: 504 }
  ]);
});

test("disables decisions for read-only, locked, reconnecting, and locally due authority", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const api = await installApprovalDecisionsApi(page, {
    sessionVariant: "read_only",
    snapshotVariant: "normal"
  });
  await page.goto(detailPath);

  await expect(page.getByText("Read-only access cannot answer approvals.", { exact: true }))
    .toBeVisible();
  await expect(page.getByRole("button", { name: /Approve|Deny/u })).toHaveCount(0);
  await page.screenshot({
    path: resolve(artifactDirectory, "read-only-390x844.png"),
    animations: "disabled"
  });

  api.setSessionVariant("locked");
  await page.reload();
  await expect(page.getByText("Remote writes are locked on the laptop.", { exact: true }))
    .toBeVisible();
  await expect(page.getByRole("button", { name: /Approve|Deny/u })).toHaveCount(0);
  await page.screenshot({
    path: resolve(artifactDirectory, "host-locked-390x844.png"),
    animations: "disabled"
  });

  expect(api.approvalRespondRequests()).toHaveLength(0);
  await expectCleanBrowser(diagnostics);
});

test("disables a current request immediately while the stream reconnects", async ({ page }) => {
  const diagnostics = observePage(page);
  const api = await installApprovalDecisionsApi(page, { snapshotVariant: "elevated" });
  await page.goto(detailPath);
  await expect(page.getByRole("button", { name: "Review & approve" })).toBeVisible();

  await api.session.dropStream();
  await expect(page.getByText("Session activity is reconnecting.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Approve|Deny/u })).toHaveCount(0);
  await page.screenshot({
    path: resolve(artifactDirectory, "stream-reconnecting-390x844.png"),
    animations: "disabled"
  });
  expect(api.approvalRespondRequests()).toHaveLength(0);
  await expectCleanBrowser(diagnostics);
});

test("contains long and multiple approvals across mobile, desktop, short-height, and 200 percent reflow", async ({
  page
}) => {
  const diagnostics = observePage(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const api = await installApprovalDecisionsApi(page, {
    sessionVariant: "writable_long",
    snapshotVariant: "long_multiple"
  });
  await page.goto(detailPath);
  const longItem = approvalItem(page, "Publish the signed Android validation package after");
  await expect(longItem).toBeVisible();
  await expect(page.locator(".hostdeck-approval-item")).toHaveCount(3);

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
    await longItem.scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(page);
    await expectNoClipping(longItem);
    await revealAboveSessionControls(page, longItem.locator(".hostdeck-approval-item__actions"));
    await expectApprovalTargets(longItem);
    measurements.push(await measureApprovalLayout(longItem, viewport));
    await page.screenshot({
      path: resolve(artifactDirectory, `long-multiple-${viewport.width}x${viewport.height}.png`),
      animations: "disabled"
    });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await longItem.getByRole("button", { name: "Review & approve" }).click();
  const dialog = page.getByRole("dialog", { name: "Approve broad request?" });
  await expect(dialog).toBeVisible();
  await expectSheetGeometry(page, dialog);
  await page.screenshot({
    path: resolve(artifactDirectory, "long-confirmation-390x844.png"),
    animations: "disabled"
  });

  await page.setViewportSize({ width: 390, height: 420 });
  await expectSheetGeometry(page, dialog);
  measurements.push(await measureSheetLayout(page, dialog, { width: 390, height: 420 }));
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
  await expectSheetGeometry(page, dialog);
  measurements.push(
    await measureSheetLayout(page, dialog, {
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
    resolve(artifactDirectory, "zoom-200-1280x800.png"),
    Buffer.from(zoomCapture.data, "base64")
  );
  await writeFile(
    resolve(artifactDirectory, "layout-measurements.json"),
    `${JSON.stringify({ measurements }, null, 2)}\n`,
    "utf8"
  );

  expect(api.approvalRespondRequests()).toHaveLength(0);
  await expectPrivateDataAbsent(page);
  await expectCleanBrowser(diagnostics);
});

async function captureState(
  page: Page,
  api: ApprovalDecisionsApiController,
  variant: ApprovalSnapshotVariant,
  visibleText: string,
  artifact: string,
  role: "button" | "text" = "text"
): Promise<void> {
  api.setSnapshotVariant(variant);
  api.setReadOutcome("success");
  await page.reload();
  const target = role === "button"
    ? page.getByRole("button", { name: visibleText })
    : page.getByText(visibleText, { exact: true }).first();
  await expect(target).toBeVisible();
  const ownedItem = target.locator(
    "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' hostdeck-approval-item ')][1]"
  );
  await expect(ownedItem).toHaveCount(1);
  await revealAboveSessionControls(page, ownedItem);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: resolve(artifactDirectory, artifact), animations: "disabled" });
}

function approvalItem(page: Page, text: string): Locator {
  return page.locator(".hostdeck-approval-item").filter({ hasText: text }).first();
}

async function captureItem(page: Page, item: Locator, artifact: string): Promise<void> {
  await revealAboveSessionControls(page, item);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: resolve(artifactDirectory, artifact), animations: "disabled" });
}

async function captureApprovalStatus(page: Page, artifact: string): Promise<void> {
  const status = page.locator(".hostdeck-approval-status-item").last();
  await expect(status).toBeVisible();
  await revealAboveSessionControls(page, status);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: resolve(artifactDirectory, artifact), animations: "disabled" });
}

async function expectApprovalTargets(item: Locator): Promise<void> {
  const buttons = item.locator("button:visible");
  for (let index = 0; index < (await buttons.count()); index += 1) {
    const box = await buttons.nth(index).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  }
}

async function revealAboveSessionControls(page: Page, target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const requiredScroll = await target.evaluate((element) => {
    const controls = document.querySelector(".hostdeck-session-controls");
    if (!(controls instanceof HTMLElement)) return 0;
    return Math.max(
      0,
      Math.ceil(element.getBoundingClientRect().bottom - controls.getBoundingClientRect().top + 12)
    );
  });
  if (requiredScroll > 0) {
    await page.evaluate((delta) => window.scrollBy(0, delta), requiredScroll);
  }
  const geometry = await target.evaluate((element) => {
    const controls = document.querySelector(".hostdeck-session-controls");
    if (!(controls instanceof HTMLElement)) return null;
    return {
      controlsTop: controls.getBoundingClientRect().top,
      targetBottom: element.getBoundingClientRect().bottom,
      targetTop: element.getBoundingClientRect().top
    };
  });
  expect(geometry).not.toBeNull();
  expect(geometry?.targetTop ?? -1).toBeGreaterThanOrEqual(56);
  expect(geometry?.targetBottom ?? Number.POSITIVE_INFINITY)
    .toBeLessThanOrEqual((geometry?.controlsTop ?? 0) - 8);
}

async function expectSheetGeometry(page: Page, dialog: Locator): Promise<void> {
  await expectNoHorizontalOverflow(page);
  const geometry = await dialog.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const body = element.querySelector(".hostdeck-approval-sheet__body");
    const footer = element.querySelector(".hostdeck-approval-sheet__footer");
    const buttons = [...element.querySelectorAll("button")].map((button) => {
      const buttonBox = button.getBoundingClientRect();
      return { height: buttonBox.height, width: buttonBox.width };
    });
    return {
      box: { bottom: box.bottom, height: box.height, left: box.left, right: box.right, top: box.top },
      bodyOverflow: body === null ? null : getComputedStyle(body).overflowY,
      clipped:
        element.scrollWidth > element.clientWidth ||
        (footer !== null && footer.scrollWidth > footer.clientWidth),
      buttons
    };
  });
  expect(geometry.box.left).toBeGreaterThanOrEqual(0);
  expect(geometry.box.right).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
  expect(geometry.box.top).toBeGreaterThanOrEqual(0);
  expect(geometry.box.bottom).toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight));
  expect(geometry.bodyOverflow).toBe("auto");
  expect(geometry.clipped).toBe(false);
  for (const button of geometry.buttons) {
    expect(button.height).toBeGreaterThanOrEqual(44);
    expect(button.width).toBeGreaterThanOrEqual(44);
  }
}

async function expectNoClipping(locator: Locator): Promise<void> {
  expect(
    await locator.evaluate(
      (element) =>
        element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight
    )
  ).toBe(true);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  expect(dimensions.scrollWidth).toBe(dimensions.clientWidth);
}

async function measureApprovalLayout(
  item: Locator,
  viewport: Readonly<{ width: number; height: number }>
) {
  return {
    viewport,
    item: await item.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const buttons = [...element.querySelectorAll("button")].map((button) => {
        const buttonBox = button.getBoundingClientRect();
        return { height: Math.round(buttonBox.height), width: Math.round(buttonBox.width) };
      });
      return {
        height: Math.round(box.height),
        width: Math.round(box.width),
        scrollHeight: element.scrollHeight,
        scrollWidth: element.scrollWidth,
        buttons
      };
    })
  };
}

async function measureSheetLayout(page: Page, dialog: Locator, viewport: object) {
  return {
    viewport,
    sheet: await dialog.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const body = element.querySelector(".hostdeck-approval-sheet__body");
      return {
        height: Math.round(box.height),
        width: Math.round(box.width),
        bodyClientHeight: body?.clientHeight ?? null,
        bodyScrollHeight: body?.scrollHeight ?? null
      };
    }),
    window: await page.evaluate(() => ({ height: window.innerHeight, width: window.innerWidth }))
  };
}

function requiredRequest(requests: readonly Request[], index: number): Request {
  const request = requests[index];
  if (request === undefined) throw new TypeError("Expected approval request is missing.");
  return request;
}

function expectApprovalRequest(
  request: Request,
  requestId: string,
  decision: "approve" | "deny"
): void {
  const url = new URL(request.url());
  expect(request.method()).toBe("POST");
  expect(url).toMatchObject({
    origin: "http://127.0.0.1:4175",
    pathname: `/api/v1/sessions/${sessionDetailBrowserSessionId}/approvals/${requestId}/respond`,
    search: "",
    hash: ""
  });
  const body = approvalResponseRequestSchema.parse(request.postDataJSON());
  expect(body).toEqual({
    operation_id: expect.stringMatching(/^op_browser_approval_[0-9a-f]{32}$/u),
    kind: "approval_response",
    decision,
    confirm: true
  });
  expect(Object.keys(body).sort()).toEqual(["confirm", "decision", "kind", "operation_id"]);
  expect(request.headers()["x-hostdeck-csrf"]).toBe("D".repeat(43));
  expect(request.headers()["x-hostdeck-csrf-generation"]).toBe("1");
}

async function expectPrivateDataAbsent(page: Page): Promise<void> {
  const html = await page.locator("body").evaluate((element) => element.outerHTML);
  expect(html).not.toContain(sessionDetailBrowserSessionId);
  expect(html).not.toContain("thread-private-browser-detail");
  expect(html).not.toContain("request-private-browser-detail");
  expect(html).not.toContain("string:approval-browser");
  expect(html).not.toContain("op_browser_approval_");
  expect(html).not.toContain("Private approval fixture detail");
}

function observePage(page: Page) {
  const externalRequests: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedResponses: Array<Readonly<{
    method: string;
    route: "approval_list" | "approval_respond" | "other";
    status: number;
  }>> = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== "http://127.0.0.1:4175") externalRequests.push(request.url());
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const pathname = new URL(response.url()).pathname;
    failedResponses.push({
      method: response.request().method(),
      route: pathname.endsWith("/respond")
        ? "approval_respond"
        : pathname.endsWith("/approvals")
          ? "approval_list"
          : "other",
      status: response.status()
    });
  });
  return { consoleErrors, externalRequests, failedResponses, pageErrors };
}

async function expectCleanBrowser(diagnostics: ReturnType<typeof observePage>): Promise<void> {
  expect(diagnostics.externalRequests).toEqual([]);
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
}

async function expectExpectedApiFailures(
  diagnostics: ReturnType<typeof observePage>,
  expected: readonly Readonly<{
    method: string;
    route: "approval_list" | "approval_respond";
    status: number;
  }>[]
): Promise<void> {
  expect(diagnostics.externalRequests).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
  expect(diagnostics.failedResponses).toEqual(expected);
  expect(diagnostics.consoleErrors).toHaveLength(expected.length);
  for (const [index, message] of diagnostics.consoleErrors.entries()) {
    expect(message).toContain(`status of ${expected[index]?.status}`);
  }
}
