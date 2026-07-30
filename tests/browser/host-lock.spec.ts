import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  hostAccessCloseButton,
  hostAccessScrollOwner,
  openHostAccess
} from "./host-access-navigation.js";
import { installHostLockApi } from "./host-lock-fixture.js";
import { installMissionControlApi } from "./mission-control-fixture.js";
import {
  installPairedDeviceManagementApi,
  pairedDevice,
  pairedDeviceCurrentId
} from "./paired-device-management-fixture.js";
import {
  installSessionDetailApi,
  sessionDetailBrowserSessionId
} from "./session-detail-fixture.js";

const artifactDirectory = resolve("artifacts/fe-v1-033-visible-host-lock-state");
const visualReviewTime = new Date("2026-07-26T14:00:00.000Z");
const layoutMeasurements: Array<Record<string, unknown>> = [];
const responsiveViewports = [
  { width: 320, height: 800 },
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 412, height: 915 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 }
] as const;

test.beforeAll(async () => {
  await mkdir(artifactDirectory, { recursive: true });
});

test.afterAll(async () => {
  if (layoutMeasurements.length === 0) return;
  await writeFile(
    resolve(artifactDirectory, "layout-measurements.json"),
    `${JSON.stringify(layoutMeasurements, null, 2)}\n`,
    "utf8"
  );
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(visualReviewTime);
});

test("owns one exact confirmation, pending latch, and correlated lock", async ({
  page
}) => {
  const diagnostics = observePage(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installMissionControlApi(page, "long");
  const devices = await installPairedDeviceManagementApi(page, {
    pages: [[
      pairedDevice(pairedDeviceCurrentId, "Xiaomi 15 Pro", "write"),
      pairedDevice("device_office_browser", "Office browser", "read")
    ]]
  });
  const lock = await installHostLockApi(page, "pending");

  await page.goto("/");
  await expect(page.getByRole("link", { name: /^release-approval-with/u })).toBeVisible();
  let sheet = await openHostSheet(page);
  await expect.poll(() => devices.listRequests().length).toBe(1);
  expect(lock.requests).toHaveLength(0);
  await expect(sheet.getByText("Office browser", { exact: true })).toBeVisible();
  const lockSection = sheet.locator(".hostdeck-host-lock");
  await expect(lockSection.getByRole("heading", { name: "Remote writes unlocked" }))
    .toBeVisible();
  const lockButton = lockSection.getByRole("button", { name: "Lock writes" });
  await expectMinimumTarget(lockButton);
  await focusByKeyboard(page, lockButton);
  await expectVisibleFocus(lockButton);
  await page.keyboard.press("Enter");

  const confirmation = page.getByRole("dialog", { name: "Lock remote writes?" });
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expect(confirmation).toContainText("New remote session writes will be blocked.");
  await expect(confirmation).toContainText("Session reads and live updates remain available.");
  await expect(confirmation).toContainText("already sent and Codex work already running");
  await expect(confirmation).toContainText("codexdeck unlock locally on the laptop");

  await captureDialogState(page, confirmation, "confirmation-390x844");
  await page.setViewportSize({ width: 320, height: 800 });
  await confirmation.getByRole("button", { name: "Lock writes" }).scrollIntoViewIfNeeded();
  await captureDialogState(page, confirmation, "confirmation-320x800");
  await page.setViewportSize({ width: 390, height: 420 });
  await confirmation.getByRole("button", { name: "Lock writes" }).scrollIntoViewIfNeeded();
  await expect(confirmation.getByRole("button", { name: "Lock writes" })).toBeVisible();
  await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeVisible();
  await captureDialogState(page, confirmation, "confirmation-short-390x420");
  await page.setViewportSize({ width: 390, height: 844 });

  await confirmation.getByRole("button", { name: "Lock writes" }).click();
  await expect.poll(lock.hasPendingLock).toBe(true);
  await expect(confirmation.getByRole("button", { name: "Locking" })).toBeDisabled();
  await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(confirmation).toBeVisible();
  await expect(page.locator(".hostdeck-lock-rail")).toContainText("Locking remote writes");
  expect(await page.locator(".hostdeck-session-row").count()).toBeGreaterThan(0);
  expect(
    await confirmation
      .getByRole("button", { name: "Locking" })
      .locator("svg")
      .evaluate((element) => getComputedStyle(element).animationName)
  ).toBe("none");
  await captureDialogState(page, confirmation, "locking-busy-390x844");

  expect(lock.lockRequests()).toHaveLength(1);
  const request = lock.lockRequests()[0];
  expect(request?.method()).toBe("POST");
  expect(new URL(request?.url() ?? "http://invalid").pathname).toBe(
    "/api/v1/access/lock"
  );
  expect(request?.headers()["x-hostdeck-csrf"]).toBe("C".repeat(43));
  expect(request?.headers()["x-hostdeck-csrf-generation"]).toBe("1");
  expect(request?.headers()["cache-control"]).toBe("no-store");
  expect(request?.postDataJSON()).toMatchObject({ confirmed: true });
  expect(request?.postDataJSON().operation_id).toMatch(
    /^op_browser_host_lock_[0-9a-f]{32}$/u
  );

  lock.releasePendingLock();
  await expect(confirmation).toBeHidden();
  await expect(lockSection.getByRole("heading", { name: "Remote writes locked" }))
    .toBeVisible();
  await expect(lockSection.getByText("codexdeck unlock", { exact: true })).toBeVisible();
  await expect(lockSection.getByRole("button", { name: /unlock/u })).toHaveCount(0);

  for (const viewport of responsiveViewports) {
    await page.setViewportSize(viewport);
    await lockSection.scrollIntoViewIfNeeded();
    await expect(hostAccessCloseButton(sheet)).toBeVisible();
    await captureDialogState(
      page,
      sheet,
      `locked-recovery-${viewport.width}x${viewport.height}`
    );
  }

  await page.setViewportSize({ width: 390, height: 420 });
  await lockSection.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await captureDialogState(page, sheet, "locked-recovery-short-390x420");
  const closeSheet = hostAccessCloseButton(sheet);
  await closeSheet.scrollIntoViewIfNeeded();
  await expectInsideViewport(page, closeSheet);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  await lockSection.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await captureDialogState(page, sheet, "locked-recovery-reflow-200-1280x800");
  await page.evaluate(() => {
    document.documentElement.style.zoom = "1";
  });
  await page.setViewportSize({ width: 390, height: 844 });

  await hostAccessCloseButton(sheet).click();
  const routeRail = page.locator(".hostdeck-lock-rail");
  await expect(routeRail).toContainText("Remote writes locked");
  await expect(routeRail).toContainText("Current HostDeck access state from the laptop");
  await expect(page.getByRole("link", { name: /^release-approval-with/u })).toBeVisible();
  await expectRailBeforeQueue(page, routeRail);
  await captureRouteState(page, "mission-locked-long-390x844", true);

  sheet = await openHostSheet(page);
  await expect(sheet.getByRole("button", { name: "Revoke Office browser, Device 2" }))
    .toBeEnabled();
  expect(devices.revokeRequests()).toHaveLength(0);
  expect(lock.lockRequests()).toHaveLength(1);
  await expectNoUnlockSurfaceOrRequest(page, diagnostics);
  await expectPrivateFreeSurface(page, request?.postDataJSON().operation_id);
  await expectCleanBrowser(page, diagnostics);
});

test("keeps the Host-lock touch target actionable after revoking another device", async ({
  page
}) => {
  const diagnostics = observePage(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installMissionControlApi(page);
  const devices = await installPairedDeviceManagementApi(page, {
    pages: [[
      pairedDevice(pairedDeviceCurrentId, "Xiaomi 15 Pro", "write"),
      pairedDevice("device_office_browser", "Office browser", "read")
    ]]
  });
  const lock = await installHostLockApi(page);

  await page.goto("/");
  const sheet = await openHostSheet(page);
  await expect(sheet.getByText("Office browser", { exact: true })).toBeVisible();
  await sheet
    .getByRole("button", { name: "Revoke Office browser, Device 2" })
    .click();
  const revokeConfirmation = page.getByRole("dialog", {
    name: "Revoke paired device?"
  });
  await revokeConfirmation.getByRole("button", { name: "Revoke device" }).click();
  await expect(sheet.getByText("Device revoked", { exact: true })).toBeVisible();
  await expect(revokeConfirmation).toBeHidden();
  expect(devices.revokeRequests()).toHaveLength(1);

  const lockButton = sheet
    .locator(".hostdeck-host-lock")
    .getByRole("button", { name: "Lock writes" });
  await lockButton.scrollIntoViewIfNeeded();
  await expect(lockButton).toBeVisible();
  await expect(lockButton).toBeEnabled();
  const center = await lockButton.evaluate((button) => {
    const bounds = button.getBoundingClientRect();
    const x = bounds.left + bounds.width / 2;
    const y = bounds.top + bounds.height / 2;
    const topmost = document.elementFromPoint(x, y);
    return {
      receivesCenter: topmost === button || button.contains(topmost),
      x,
      y
    };
  });
  expect(center.receivesCenter).toBe(true);

  await page.touchscreen.tap(center.x, center.y);
  const lockConfirmation = page.getByRole("dialog", {
    name: "Lock remote writes?"
  });
  await expect(lockConfirmation).toBeVisible();
  expect(lock.lockRequests()).toHaveLength(0);
  await lockConfirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(lockConfirmation).toBeHidden();
  await expect(sheet.getByText("Device revoked", { exact: true })).toBeVisible();

  await expectPrivateFreeSurface(page);
  await expectCleanBrowser(page, diagnostics);
});

test("latches an unconfirmed outcome until a causally later access proof", async ({
  page
}) => {
  const diagnostics = observePage(page);
  await installMissionControlApi(page);
  const devices = await installPairedDeviceManagementApi(page, {
    pages: [[
      pairedDevice(pairedDeviceCurrentId, "Xiaomi 15 Pro", "write"),
      pairedDevice("device_office_browser", "Office browser", "read")
    ]]
  });
  const lock = await installHostLockApi(page, "uncertain");

  await page.goto("/");
  let sheet = await openHostSheet(page);
  await expect.poll(() => devices.listRequests().length).toBe(1);
  expect(lock.requests).toHaveLength(0);
  await expect(sheet.getByText("Office browser", { exact: true })).toBeVisible();
  await sheet.getByRole("button", { name: "Lock writes" }).click();
  const confirmation = page.getByRole("dialog", { name: "Lock remote writes?" });
  await confirmation.getByRole("button", { name: "Lock writes" }).click();

  const lockSection = sheet.locator(".hostdeck-host-lock");
  await expect(lockSection.getByRole("heading", { name: "Lock outcome unconfirmed" }))
    .toBeVisible();
  await expect(lockSection.getByRole("alert")).toContainText(
    "Then refresh HostDeck to read the current lock state."
  );
  await expect(lockSection.getByRole("button", { name: "Lock writes" })).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "Revoke Office browser, Device 2" }))
    .toBeEnabled();
  await captureDialogState(page, sheet, "unconfirmed-sheet-390x844");
  expect(lock.lockRequests()).toHaveLength(1);
  expect(devices.revokeRequests()).toHaveLength(0);

  await hostAccessCloseButton(sheet).click();
  const rail = page.locator(".hostdeck-lock-rail");
  await expect(rail).toHaveAttribute("role", "alert");
  await expect(rail).toContainText("Lock outcome unconfirmed");
  await expect(page.getByRole("link", { name: /^release-approval/u })).toBeVisible();
  await captureRouteState(page, "mission-unconfirmed-390x844");

  await page.getByRole("button", { name: "Refresh sessions" }).click();
  await expect(rail).toHaveCount(0);
  expect(lock.lockRequests()).toHaveLength(1);
  sheet = await openHostSheet(page);
  await expect(sheet.getByRole("heading", { name: "Remote writes unlocked" })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Lock writes" })).toBeEnabled();
  await captureDialogState(page, sheet, "unconfirmed-proved-unlocked-390x844");

  await expectNoUnlockSurfaceOrRequest(page, diagnostics);
  await expectPrivateFreeSurface(page);
  await expectCleanBrowser(page, diagnostics, [503]);
});

test("keeps emergency admission and current-versus-stale truth explicit", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const mission = await installMissionControlApi(page);
  await installHostLockApi(page);

  await page.goto("/");
  await expect(page.getByRole("link", { name: /^release-approval/u })).toBeVisible();
  mission.setVariant("host_unavailable");
  await page.getByRole("button", { name: "Refresh sessions" }).click();
  let sheet = await openHostSheet(page);
  const laptopHost = sheet.locator(".hostdeck-access-fact").filter({ hasText: "Laptop host" });
  await expect(laptopHost.getByText("Stale", { exact: true })).toBeVisible();
  await expect(sheet.getByRole("heading", { name: "Remote writes unlocked" })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Lock writes" })).toBeEnabled();
  await captureDialogState(page, sheet, "degraded-host-lockable-390x844");

  mission.setVariant("read_only");
  await page.reload();
  sheet = await openHostSheet(page);
  await expect(sheet.getByText("This phone has read-only access and cannot lock remote writes."))
    .toBeVisible();
  await expect(sheet.getByRole("button", { name: "Lock writes" })).toHaveCount(0);
  await captureDialogState(page, sheet, "reader-no-lock-command-390x844");

  mission.setVariant("locked");
  await page.reload();
  const currentRail = page.locator(".hostdeck-lock-rail");
  await expect(currentRail).toContainText("Remote writes locked");
  await expect(currentRail).toContainText("Current HostDeck access state from the laptop");
  await captureRouteState(page, "mission-current-locked-390x844");

  mission.setVariant("unavailable");
  await page.getByRole("button", { name: "Refresh sessions" }).click();
  await expect(currentRail).toContainText("Remote writes last known locked");
  await expect(currentRail).toContainText("Last known HostDeck access state from the laptop");
  await expect(page.getByRole("link", { name: /^release-approval/u })).toBeVisible();
  await captureRouteState(page, "mission-stale-locked-390x844");
  sheet = await openHostSheet(page);
  await expect(sheet.getByRole("heading", { name: "Remote writes last known locked" }))
    .toBeVisible();
  await captureDialogState(page, sheet, "stale-locked-recovery-390x844");

  await expectNoUnlockSurfaceOrRequest(page, diagnostics);
  await expectPrivateFreeSurface(page);
  await expectCleanBrowser(page, diagnostics, [503, 503]);
});

test("carries the same current lock before readable Session Detail activity", async ({
  page
}) => {
  const diagnostics = observePage(page);
  await installSessionDetailApi(page, "locked");

  await page.goto(`/sessions/${sessionDetailBrowserSessionId}`);
  const rail = page.locator(".hostdeck-lock-rail");
  await expect(rail).toContainText("Remote writes locked");
  await expect(rail).toContainText("Current HostDeck access state from the laptop");
  await expect(page.getByRole("list", { name: "Session activity" })).toBeVisible();
  await expect(page.locator(".hostdeck-timeline-item").first()).toBeVisible();
  await expect(page.getByText("Remote writes are locked on the laptop.", { exact: true }))
    .toBeVisible();
  await expectRailBeforeTimeline(page, rail);

  await captureRouteState(page, "session-detail-locked-full-390x844", true);
  await page.setViewportSize({ width: 320, height: 800 });
  await captureRouteState(page, "session-detail-locked-full-320x800", true);
  await page.setViewportSize({ width: 390, height: 844 });
  const sheet = await openHostSheet(page);
  await expect(sheet.getByText("codexdeck unlock", { exact: true })).toBeVisible();
  await expect(sheet.getByRole("button", { name: /unlock/u })).toHaveCount(0);
  await captureDialogState(page, sheet, "session-detail-locked-sheet-390x844");

  await expectNoUnlockSurfaceOrRequest(page, diagnostics);
  await expectPrivateFreeSurface(page);
  await expectCleanBrowser(page, diagnostics);
});

async function openHostSheet(page: Page): Promise<Locator> {
  const sheet = await openHostAccess(page);
  await expect(sheet.locator(".hostdeck-host-lock")).toBeVisible();
  await sheet.locator(".hostdeck-host-lock").scrollIntoViewIfNeeded();
  return sheet;
}

async function captureDialogState(
  page: Page,
  dialog: Locator,
  name: string
): Promise<void> {
  await expectNoDocumentOverflow(page);
  expect(
    await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
  ).toBe(true);
  const body = hostAccessScrollOwner(dialog);
  const scrollOwner = (await body.count()) === 0
    ? null
    : await body.evaluate((element) => ({
        clientHeight: element.clientHeight,
        clientWidth: element.clientWidth,
        scrollHeight: element.scrollHeight,
        scrollWidth: element.scrollWidth
      }));
  if (scrollOwner !== null) {
    expect(scrollOwner.scrollWidth).toBeLessThanOrEqual(scrollOwner.clientWidth + 1);
  }
  const lockSection = dialog.locator(".hostdeck-host-lock");
  layoutMeasurements.push({
    state: name,
    viewport: page.viewportSize(),
    zoom: await page.evaluate(() => getComputedStyle(document.documentElement).zoom),
    dialog: roundedBox(await dialog.boundingBox()),
    lockSection: (await lockSection.count()) === 0
      ? null
      : roundedBox(await lockSection.boundingBox()),
    scrollOwner
  });
  await page.screenshot({
    path: resolve(artifactDirectory, `${name}.png`),
    animations: "disabled"
  });
}

async function captureRouteState(
  page: Page,
  name: string,
  fullPage = false
): Promise<void> {
  await expectNoDocumentOverflow(page);
  const rail = page.locator(".hostdeck-lock-rail");
  expect(
    await rail.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
  ).toBe(true);
  layoutMeasurements.push({
    state: name,
    viewport: page.viewportSize(),
    zoom: await page.evaluate(() => getComputedStyle(document.documentElement).zoom),
    routeRail: roundedBox(await rail.boundingBox()),
    document: await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }))
  });
  await page.screenshot({
    path: resolve(artifactDirectory, `${name}.png`),
    animations: "disabled",
    fullPage
  });
}

async function expectRailBeforeQueue(page: Page, rail: Locator): Promise<void> {
  const railBox = await rail.boundingBox();
  const queueBox = await page.locator(".hostdeck-queue-group").first().boundingBox();
  expect(railBox).not.toBeNull();
  expect(queueBox).not.toBeNull();
  expect((railBox?.y ?? 0) + (railBox?.height ?? 0)).toBeLessThanOrEqual(queueBox?.y ?? 0);
}

async function expectRailBeforeTimeline(page: Page, rail: Locator): Promise<void> {
  const railBox = await rail.boundingBox();
  const firstItemBox = await page.locator(".hostdeck-timeline-item").first().boundingBox();
  expect(railBox).not.toBeNull();
  expect(firstItemBox).not.toBeNull();
  expect((railBox?.y ?? 0) + (railBox?.height ?? 0)).toBeLessThanOrEqual(
    firstItemBox?.y ?? 0
  );
}

async function expectMinimumTarget(locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
}

async function expectInsideViewport(page: Page, locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport?.width ?? 0);
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(viewport?.height ?? 0);
}

async function expectVisibleFocus(locator: Locator): Promise<void> {
  const focus = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth)
    };
  });
  expect(focus.outlineStyle).toBe("solid");
  expect(focus.outlineWidth).toBeGreaterThanOrEqual(3);
}

async function focusByKeyboard(page: Page, target: Locator): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await target.evaluate((element) => document.activeElement === element)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
      )
    )
    .toBe(true);
}

async function expectNoUnlockSurfaceOrRequest(
  page: Page,
  diagnostics: ReturnType<typeof observePage>
): Promise<void> {
  await expect(page.getByRole("button", { name: /unlock/u })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /unlock/u })).toHaveCount(0);
  expect(
    diagnostics.requestPaths.filter((path) => path === "/api/v1/access/unlock")
  ).toEqual([]);
}

async function expectPrivateFreeSurface(
  page: Page,
  operationId?: unknown
): Promise<void> {
  const body = await page.locator("body").innerHTML();
  for (const privateValue of [
    pairedDeviceCurrentId,
    "device_office_browser",
    "C".repeat(43),
    typeof operationId === "string" ? operationId : null
  ]) {
    if (privateValue !== null) expect(body).not.toContain(privateValue);
  }
  await expect
    .poll(() => page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })))
    .toEqual({ local: 0, session: 0 });
}

function observePage(page: Page) {
  const consoleErrors: string[] = [];
  const externalRequests: string[] = [];
  const pageErrors: string[] = [];
  const requestPaths: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    requestPaths.push(url.pathname);
    if (url.origin !== "http://127.0.0.1:4175") externalRequests.push(request.url());
  });
  return { consoleErrors, externalRequests, pageErrors, requestPaths };
}

async function expectCleanBrowser(
  page: Page,
  diagnostics: ReturnType<typeof observePage>,
  expectedNetworkStatuses: readonly number[] = []
): Promise<void> {
  expect(diagnostics.externalRequests).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
  expect(diagnostics.consoleErrors).toHaveLength(expectedNetworkStatuses.length);
  for (const [index, status] of expectedNetworkStatuses.entries()) {
    expect(diagnostics.consoleErrors[index]).toContain(`status of ${String(status)}`);
  }
  await expect
    .poll(() => page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })))
    .toEqual({ local: 0, session: 0 });
}

function roundedBox(
  box: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } | null
) {
  if (box === null) return null;
  return Object.fromEntries(
    Object.entries(box).map(([key, value]) => [key, Math.round(value)])
  );
}
