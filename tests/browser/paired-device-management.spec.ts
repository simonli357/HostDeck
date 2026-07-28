import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  hostAccessCloseButton,
  hostAccessScrollOwner,
  openHostAccess
} from "./host-access-navigation.js";
import {
  installMissionControlApi
} from "./mission-control-fixture.js";
import {
  installPairedDeviceManagementApi,
  pairedDevice,
  pairedDeviceCurrentId
} from "./paired-device-management-fixture.js";
import {
  installSessionDetailApi,
  sessionDetailBrowserSessionId
} from "./session-detail-fixture.js";

const artifactDirectory = resolve("artifacts/fe-v1-032-paired-device-management");
const visualReviewTime = new Date("2026-07-26T12:00:00.000Z");
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
  await writeFile(
    resolve(artifactDirectory, "layout-measurements.json"),
    `${JSON.stringify(layoutMeasurements, null, 2)}\n`,
    "utf8"
  );
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(visualReviewTime);
});

test("renders bounded loading, empty, failure, and external-authority states", async ({
  page
}) => {
  const diagnostics = observePage(page);
  await installMissionControlApi(page);
  const devices = await installPairedDeviceManagementApi(page, {
    pages: [[]],
    listOutcome: "pending"
  });

  await page.goto("/");
  await expect.poll(devices.hasPendingList).toBe(true);
  let sheet = await openDeviceSheet(page);
  await expect(sheet.getByText("Checking paired devices.")).toBeVisible();
  await captureState(page, "loading-390x844");

  devices.releasePendingList();
  await expect(sheet.getByText("No paired devices were returned.")).toBeVisible();
  await captureState(page, "empty-390x844");
  expect(devices.listRequests()).toHaveLength(1);

  devices.setListOutcome("failure");
  await page.reload();
  sheet = await openDeviceSheet(page);
  await expect(sheet.getByText("HostDeck could not confirm the device list.")).toBeVisible();
  await captureState(page, "failure-390x844");
  expect(devices.listRequests()).toHaveLength(2);

  devices.setListOutcome("authority_denied");
  await page.reload();
  sheet = await openDeviceSheet(page);
  await expect(sheet.getByText("Pair this browser to inspect devices.")).toBeVisible();
  await captureState(page, "external-authority-loss-390x844");
  expect(devices.listRequests()).toHaveLength(3);
  await expectCleanBrowser(page, diagnostics, [503, 403]);
});

test("contains writer, reader, locked, long, responsive, short-height, and reflow views", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const mission = await installMissionControlApi(page);
  const devices = await installPairedDeviceManagementApi(page, {
    pages: [writerRows()]
  });

  await page.goto("/");
  let sheet = await openDeviceSheet(page);
  await expect(sheet.getByText("Device 1 · This phone", { exact: true })).toBeVisible();
  await expect(sheet.getByText("Expired", { exact: true })).toBeVisible();
  await expect(sheet.getByText("Revoked", { exact: true })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Revoke Expired tablet, Device 3" }))
    .toBeEnabled();

  for (const viewport of responsiveViewports) {
    await page.setViewportSize(viewport);
    const close = hostAccessCloseButton(sheet);
    await close.scrollIntoViewIfNeeded();
    await expect(close).toBeVisible();
    await captureState(page, `writer-${viewport.width}x${viewport.height}`);
  }
  await page.setViewportSize({ width: 390, height: 420 });
  await hostAccessCloseButton(sheet).scrollIntoViewIfNeeded();
  await expect(hostAccessCloseButton(sheet)).toBeVisible();
  await captureState(page, "writer-short-390x420");

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  await hostAccessCloseButton(sheet).scrollIntoViewIfNeeded();
  await expect(hostAccessCloseButton(sheet)).toBeVisible();
  await captureState(page, "writer-reflow-200-1280x800");
  await page.evaluate(() => {
    document.documentElement.style.zoom = "1";
  });

  devices.setPages([longRows()]);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.reload();
  sheet = await openDeviceSheet(page);
  await expect(sheet.getByText("Duplicate phone", { exact: true }).first()).toBeVisible();
  expect(await sheet.getByText("Duplicate phone", { exact: true }).count()).toBe(2);
  await sheet.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(sheet.getByText("Field operations phone ".repeat(6).slice(0, 120)))
    .toBeVisible();
  await captureState(page, "long-duplicate-20-rows-320x800");

  mission.setVariant("read_only");
  devices.setPages([readerRows()]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  sheet = await openDeviceSheet(page);
  await expect(sheet.getByText("Read-only access can inspect devices but cannot revoke them."))
    .toBeVisible();
  await expect(sheet.getByRole("button", { name: /^Revoke /u })).toHaveCount(0);
  await captureState(page, "reader-390x844");

  mission.setVariant("locked");
  devices.setPages([writerRows()]);
  await page.reload();
  sheet = await openDeviceSheet(page);
  await expect(sheet.getByRole("button", { name: "Revoke Office browser, Device 2" }))
    .toBeEnabled();
  await expect(sheet.getByText("Locked", { exact: true }).first()).toBeVisible();
  await captureState(page, "locked-writer-390x844");

  expect(devices.listRequests()).toHaveLength(4);
  await expectPrivateFreeSurface(page);
  await expectCleanBrowser(page, diagnostics);
});

test("replaces pages and latches stale state until one explicit proof", async ({ page }) => {
  const diagnostics = observePage(page);
  await installMissionControlApi(page);
  const devices = await installPairedDeviceManagementApi(page, {
    pages: paginationRows()
  });
  await page.goto("/");
  const sheet = await openDeviceSheet(page);

  await expect(sheet.getByText("Page 1", { exact: true })).toHaveAttribute(
    "aria-current",
    "page"
  );
  await sheet.getByRole("button", { name: "Next" }).click();
  await expect(sheet.getByText("Page 2 device 1", { exact: true })).toBeVisible();
  await expect(sheet.getByText("Page 1 device 1", { exact: true })).toHaveCount(0);
  await expect(sheet.getByText("Page 2", { exact: true })).toHaveAttribute(
    "aria-current",
    "page"
  );
  await captureState(page, "pagination-page-2-390x844");
  await page.setViewportSize({ width: 320, height: 800 });
  await sheet.getByRole("navigation", { name: "Device pages" }).scrollIntoViewIfNeeded();
  await captureState(page, "pagination-controls-page-2-320x800");
  await page.setViewportSize({ width: 390, height: 844 });

  devices.setListOutcome("failure");
  await sheet.getByRole("button", { name: "Refresh devices" }).click();
  await expect(sheet.getByText("This device page is stale. Reload it before revoking another device."))
    .toBeVisible();
  await expect(sheet.getByRole("button", { name: /^Revoke /u }).first()).toBeDisabled();
  await captureState(page, "stale-page-390x844");
  expect(devices.listRequests()).toHaveLength(3);

  devices.setListOutcome("success");
  await sheet.getByRole("button", { name: "Reload devices" }).click();
  await expect(sheet.getByText("Showing device page 2.")).toBeVisible();
  await sheet.getByRole("button", { name: "Start over" }).click();
  await expect(sheet.getByText("Page 1 device 1", { exact: true })).toBeVisible();
  expect(devices.listRequests()).toHaveLength(5);
  await expectCleanBrowser(page, diagnostics, [503]);
});

test("owns exact other-device confirmation, busy, success, conflict, and uncertain outcomes", async ({
  page
}) => {
  const diagnostics = observePage(page);
  await installMissionControlApi(page);
  const devices = await installPairedDeviceManagementApi(page, {
    pages: [revokeRows()],
    revokeOutcome: "pending"
  });
  await page.goto("/");
  let sheet = await openDeviceSheet(page);

  await sheet.getByRole("button", { name: "Revoke Office browser, Device 2" }).click();
  let confirmation = page.getByRole("dialog", { name: "Revoke paired device?" });
  await expect(confirmation.getByText("Office browser (Device 2)")).toBeVisible();
  await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
  await captureState(page, "confirmation-other-390x844", false);
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(confirmation.getByRole("button", { name: "Revoke device" })).toBeVisible();
  expect(
    await confirmation.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
  ).toBe(true);
  await captureState(page, "confirmation-other-320x800", false);
  await page.setViewportSize({ width: 390, height: 844 });

  await confirmation.getByRole("button", { name: "Revoke device" }).click();
  await expect.poll(devices.hasPendingRevoke).toBe(true);
  await expect(confirmation.getByRole("button", { name: "Revoking" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(confirmation).toBeVisible();
  await captureState(page, "revoking-busy-390x844", false);
  expect(devices.revokeRequests()).toHaveLength(1);

  devices.releasePendingRevoke();
  await expect(sheet.getByText("Device revoked", { exact: true })).toBeVisible();
  await expect(sheet.getByText("Revoked", { exact: true })).toBeVisible();
  await expect(sheet.locator(".hostdeck-device-row").nth(1)).toBeFocused();
  await captureState(page, "revoke-success-390x844");
  const successRequest = devices.revokeRequests()[0];
  expect(successRequest?.headers()["x-hostdeck-csrf"]).toBe("C".repeat(43));
  expect(successRequest?.headers()["x-hostdeck-csrf-generation"]).toBe("1");
  expect(successRequest?.postDataJSON()).toMatchObject({ confirmed: true });

  devices.setRevokeOutcome("conflict");
  await page.reload();
  sheet = await openDeviceSheet(page);
  await sheet.getByRole("button", { name: "Revoke Office browser, Device 2" }).click();
  confirmation = page.getByRole("dialog", { name: "Revoke paired device?" });
  await confirmation.getByRole("button", { name: "Revoke device" }).click();
  await expect(sheet.getByText("Device changed before revocation")).toBeVisible();
  await expect(sheet.getByText("This device page is stale. Reload it before revoking another device."))
    .toBeVisible();
  await captureState(page, "revoke-conflict-390x844");

  devices.setRevokeOutcome("uncertain");
  await page.reload();
  sheet = await openDeviceSheet(page);
  await sheet.getByRole("button", { name: "Revoke Office browser, Device 2" }).click();
  confirmation = page.getByRole("dialog", { name: "Revoke paired device?" });
  await confirmation.getByRole("button", { name: "Revoke device" }).click();
  await expect(sheet.getByText("Revocation outcome is unconfirmed")).toBeVisible();
  await captureState(page, "revoke-uncertain-390x844");

  expect(devices.revokeRequests()).toHaveLength(3);
  await expectPrivateFreeSurface(page);
  await expectCleanBrowser(page, diagnostics, [409, 503]);
});

test("explains final self-revoke and adopts loss before restoring outer-sheet focus", async ({
  page
}) => {
  const diagnostics = observePage(page);
  await installMissionControlApi(page);
  const devices = await installPairedDeviceManagementApi(page, {
    pages: [[pairedDevice(pairedDeviceCurrentId, "Xiaomi 15 Pro", "write")]]
  });
  await page.goto("/");
  const sheet = await openDeviceSheet(page);

  await sheet.getByRole("button", { name: "Revoke Xiaomi 15 Pro, Device 1" }).click();
  const confirmation = page.getByRole("dialog", { name: "Revoke this phone?" });
  await expect(confirmation.getByText("This phone", { exact: true })).toBeVisible();
  await expect(confirmation.getByRole("alert")).toContainText("last active paired device");
  await captureState(page, "confirmation-self-final-390x844", false);
  await confirmation.getByRole("button", { name: "Revoke this phone" }).click();

  await expect(sheet.getByText("This phone was revoked", { exact: true })).toBeVisible();
  await expect(sheet.getByRole("list", { name: "Paired devices" })).toHaveCount(0);
  await expect(hostAccessCloseButton(sheet)).toBeFocused();
  await captureState(page, "self-revoked-390x844");
  expect(devices.revokeRequests()).toHaveLength(1);
  await expectPrivateFreeSurface(page);
  await expectCleanBrowser(page, diagnostics);
});

test("keeps the same flat device rail inside production Session Detail", async ({ page }) => {
  const diagnostics = observePage(page);
  await installSessionDetailApi(page, "writable");
  const devices = await installPairedDeviceManagementApi(page, {
    pages: [[
      pairedDevice("device_detail_phone", "Session phone", "write"),
      pairedDevice("device_detail_tablet", "Session tablet", "read")
    ]]
  });
  await page.goto(`/sessions/${sessionDetailBrowserSessionId}`);
  const sheet = await openDeviceSheet(page);
  await expect(sheet.getByText("Session phone", { exact: true })).toBeVisible();
  await expect(sheet.getByText("Device 1 · This phone", { exact: true })).toBeVisible();
  await captureState(page, "session-detail-writer-390x844");
  expect(devices.listRequests()).toHaveLength(1);
  await expectCleanBrowser(page, diagnostics);
});

function writerRows() {
  return [
    pairedDevice(pairedDeviceCurrentId, "Xiaomi 15 Pro", "write"),
    pairedDevice("device_office_browser", "Office browser", "read", {
      lastUsedAt: null,
      expiresAt: null
    }),
    pairedDevice("device_old_tablet", "Expired tablet", "read", {
      expiresAt: "2026-07-20T12:00:00.000Z"
    }),
    pairedDevice("device_revoked_terminal", "Revoked workstation", "write", {
      expiresAt: "2026-07-20T12:00:00.000Z",
      revokedAt: "2026-07-24T12:00:00.000Z"
    })
  ];
}

function readerRows() {
  return [
    pairedDevice(pairedDeviceCurrentId, "Xiaomi 15 Pro", "read"),
    pairedDevice("device_office_browser", "Office browser", "write")
  ];
}

function revokeRows() {
  return [
    pairedDevice(pairedDeviceCurrentId, "Xiaomi 15 Pro", "write"),
    pairedDevice("device_office_browser", "Office browser", "read")
  ];
}

function longRows() {
  const longLabel = "Field operations phone ".repeat(6).slice(0, 120);
  return [
    pairedDevice(pairedDeviceCurrentId, "Duplicate phone", "write"),
    ...Array.from({ length: 19 }, (_, index) => {
      const ordinal = index + 1;
      const label = ordinal === 1
        ? "Duplicate phone"
        : ordinal === 2
          ? null
          : ordinal === 19
            ? longLabel
            : `Field phone ${String(ordinal).padStart(2, "0")}`;
      return pairedDevice(
        `device_visual_${String(ordinal).padStart(3, "0")}`,
        label,
        ordinal % 2 === 0 ? "write" : "read"
      );
    })
  ];
}

function paginationRows() {
  const first = [
    pairedDevice(pairedDeviceCurrentId, "Page 1 device 1", "write"),
    ...Array.from({ length: 19 }, (_, index) =>
      pairedDevice(
        `device_page_${String(index + 1).padStart(3, "0")}`,
        `Page 1 device ${String(index + 2)}`,
        "read"
      )
    )
  ];
  const second = Array.from({ length: 3 }, (_, index) =>
    pairedDevice(
      `device_page_${String(index + 20).padStart(3, "0")}`,
      `Page 2 device ${String(index + 1)}`,
      index === 0 ? "write" : "read"
    )
  );
  return [first, second];
}

async function openDeviceSheet(page: Page): Promise<Locator> {
  const sheet = await openHostAccess(page);
  const region = sheet.getByRole("region", { name: "Paired devices" });
  await expect(region).toBeVisible();
  await region.scrollIntoViewIfNeeded();
  return sheet;
}

async function captureState(
  page: Page,
  name: string,
  scrollToDevices = true
): Promise<void> {
  const sheet = page.getByRole("dialog", { name: "Host & access" });
  const region = sheet.getByRole("region", { name: "Paired devices" });
  if (scrollToDevices) await region.scrollIntoViewIfNeeded();
  await expectNoHorizontalOverflow(page, sheet);
  const viewport = page.viewportSize();
  layoutMeasurements.push({
    state: name,
    viewport,
    zoom: await page.evaluate(() => getComputedStyle(document.documentElement).zoom),
    document: await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    })),
    sheet: roundedBox(await sheet.boundingBox()),
    deviceRegion: roundedBox(await region.boundingBox()),
    scrollOwners: await hostAccessScrollOwner(sheet).evaluate((element) => ({
      clientHeight: element.clientHeight,
      clientWidth: element.clientWidth,
      scrollHeight: element.scrollHeight,
      scrollWidth: element.scrollWidth
    }))
  });
  await page.screenshot({
    path: resolve(artifactDirectory, `${name}.png`),
    animations: "disabled"
  });
}

async function expectNoHorizontalOverflow(page: Page, sheet: Locator): Promise<void> {
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
  expect(
    await hostAccessScrollOwner(sheet).evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1
    )
  ).toBe(true);
}

async function expectPrivateFreeSurface(page: Page): Promise<void> {
  const body = await page.locator("body").innerHTML();
  for (const privateValue of [
    pairedDeviceCurrentId,
    "device_office_browser",
    "device_old_tablet",
    "device_revoked_terminal"
  ]) {
    expect(body).not.toContain(privateValue);
    expect(page.url()).not.toContain(privateValue);
  }
  await expect
    .poll(() => page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })))
    .toEqual({ local: 0, session: 0 });
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
    if (new URL(request.url()).origin !== "http://127.0.0.1:4175") {
      externalRequests.push(request.url());
    }
  });
  return { consoleErrors, externalRequests, pageErrors };
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
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null
) {
  if (box === null) return null;
  return Object.fromEntries(
    Object.entries(box).map(([key, value]) => [key, Math.round(value)])
  );
}
