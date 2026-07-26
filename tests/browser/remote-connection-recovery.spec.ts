import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { remoteIngressUnavailableReasons } from "../../packages/core/src/index.js";
import {
  installRemoteHostOverlay,
  installRemoteRecoveryApi,
  type RemoteRecoveryState,
  remoteRecoveryPrivateOrigin
} from "./remote-connection-recovery-fixture.js";
import { installSessionDetailApi, sessionDetailBrowserSessionId } from "./session-detail-fixture.js";

const artifactDirectory = resolve("artifacts/fe-v1-034-remote-connection-recovery");
const visualReviewTime = new Date("2026-07-26T16:00:00.000Z");
const layoutMeasurements: Array<Record<string, unknown>> = [];
const causeCases = [
  ["remote_disabled", "Remote access disabled"],
  ["client_not_installed", "Tailscale is not installed"],
  ["client_unsupported", "Tailscale client unsupported"],
  ["client_error", "Tailscale status unavailable"],
  ["client_stopped", "Tailscale is stopped"],
  ["client_signed_out", "Tailscale is signed out"],
  ["profile_absent", "HostDeck profile unavailable"],
  ["profile_other", "HostDeck profile is not active"],
  ["profile_unknown", "Tailscale profile not verified"],
  ["serve_absent", "Private HTTPS mapping missing"],
  ["serve_foreign", "Private HTTPS path has another owner"],
  ["serve_colliding", "Private HTTPS mapping conflict"],
  ["serve_drifted", "Private HTTPS mapping changed"],
  ["serve_public", "Public exposure conflicts with HostDeck"],
  ["external_origin_invalid", "Private HostDeck address invalid"],
  ["observation_stale", "Remote status is stale"],
  ["observation_failed", "Remote status check failed"],
  ["consent_required", "Tailscale approval required"],
  ["permission_denied", "Laptop permission denied"],
  ["command_failed", "Remote setup command failed"],
  ["command_timeout", "Remote setup timed out"],
  ["output_oversized", "Tailscale response exceeded the safety limit"],
  ["schema_invalid", "Tailscale status format unsupported"],
  ["profile_changed", "Tailscale profile changed during the check"],
  ["cleanup_incomplete", "Remote cleanup incomplete"]
] as const satisfies readonly [RemoteRecoveryState, string][];

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

test("renders every bounded current laptop reason through one shared Focus Rail surface", async ({
  page
}) => {
  test.setTimeout(120_000);
  expect(causeCases.map(([cause]) => cause)).toEqual([
    "remote_disabled",
    ...remoteIngressUnavailableReasons
  ]);
  const diagnostics = observePage(page);
  const api = await installRemoteRecoveryApi(page, "loopback", causeCases[0][0]);

  for (const [index, [cause, title]] of causeCases.entries()) {
    api.setRemoteState(cause);
    if (index === 0) {
      await page.goto("/");
    } else {
      await page.reload();
    }
    await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
    const sheet = await openHostSheet(page);
    const recovery = sheet.locator(".hostdeck-remote-recovery");
    await expect(recovery.getByText("LOCAL LAPTOP", { exact: true })).toBeVisible();
    await expect(recovery.getByText("Current laptop status", { exact: true })).toBeVisible();
    await expect(recovery.getByRole("heading", { name: title })).toBeVisible();
    await expect(recovery.getByRole("button", { name: "Check remote access" })).toBeEnabled();
    await recovery.scrollIntoViewIfNeeded();
    await capture(page, `reason-${cause}-390x844.png`);
    await sheet.getByRole("button", { name: "Close Host and access" }).click();
  }

  expect(api.remoteStatusRequests()).toHaveLength(0);
  expect(unsafeRemoteRequests(api.requests)).toEqual([]);
  await expectPrivateFreeBrowser(page);
  expect(diagnostics.pageErrors).toEqual([]);
});

test("coalesces one paired private status read, persists through sheet closure, and refreshes once", async ({
  page
}) => {
  const diagnostics = observePage(page, remoteRecoveryPrivateOrigin);
  const api = await installRemoteRecoveryApi(page, "remote", "ready");
  api.setRemoteStatusOutcome("pending");
  await page.goto(`${remoteRecoveryPrivateOrigin}/`);
  await expect(page.getByRole("heading", { level: 1, name: "Mission Control" })).toBeVisible();

  let sheet = await openHostSheet(page);
  const recovery = sheet.locator(".hostdeck-remote-recovery");
  await expect(recovery.getByRole("heading", { name: "Remote access ready" })).toBeVisible();
  expect(await recovery.getByText(remoteRecoveryPrivateOrigin, { exact: true }).count()).toBe(1);
  await expect(recovery.getByRole("link", { name: remoteRecoveryPrivateOrigin })).toHaveCount(0);
  const requestStart = api.requests.length;
  const check = recovery.getByRole("button", { name: "Check again" });
  await check.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(api.hasPendingRemoteStatus).toBe(true);
  expect(api.remoteStatusRequests()).toHaveLength(1);
  await expect(recovery.getByRole("heading", { name: "Checking remote access" })).toBeVisible();
  await expect(recovery).toContainText("No Tailscale profile or private mapping is being changed.");
  await expect(recovery.getByRole("button", { name: "Check remote access" })).toBeDisabled();
  await recovery.scrollIntoViewIfNeeded();
  await capture(page, "paired-checking-390x844.png");

  await sheet.getByRole("button", { name: "Close Host and access" }).click();
  sheet = await openHostSheet(page);
  await expect(sheet.getByRole("heading", { name: "Checking remote access" })).toBeVisible();
  expect(api.remoteStatusRequests()).toHaveLength(1);

  api.releaseRemoteStatus();
  await expect.poll(() => api.hostRequests().length).toBe(2);
  await expect(sheet.getByRole("heading", { name: "Remote access ready" })).toBeVisible();
  expect(api.remoteStatusRequests()).toHaveLength(1);
  await sheet.locator(".hostdeck-remote-recovery").scrollIntoViewIfNeeded();
  await capture(page, "paired-check-recovered-390x844.png");

  const checkRequests = api.requests.slice(requestStart);
  expect(new URL(checkRequests[0]?.url() ?? "http://invalid").pathname)
    .toBe("/api/v1/remote/status");
  const statusRequest = api.remoteStatusRequests()[0];
  expect(statusRequest?.method()).toBe("GET");
  expect(statusRequest?.postData()).toBeNull();
  expect(statusRequest?.headers()["x-hostdeck-csrf"]).toBeUndefined();
  expect(statusRequest?.headers()["x-hostdeck-csrf-generation"]).toBeUndefined();
  expect(statusRequest?.headers()["x-hostdeck-local-admin"]).toBeUndefined();
  expect(pathCount(checkRequests, "/api/v1/access")).toBe(1);
  expect(pathCount(checkRequests, "/api/v1/host/status")).toBe(1);
  expect(pathCount(checkRequests, "/api/v1/sessions")).toBe(1);
  expect(unsafeRemoteRequests(api.requests)).toEqual([]);
  await expectPrivateFreeBrowser(page);
  expect(diagnostics.pageErrors).toEqual([]);
});

test("latches one failed check until an explicit retry succeeds without mutation or automatic retry", async ({
  page
}) => {
  const diagnostics = observePage(page, remoteRecoveryPrivateOrigin);
  const api = await installRemoteRecoveryApi(page, "remote", "ready");
  api.setRemoteStatusOutcome("failure");
  await page.goto(`${remoteRecoveryPrivateOrigin}/`);
  const sheet = await openHostSheet(page);
  const recovery = sheet.locator(".hostdeck-remote-recovery");
  const hostsBefore = api.hostRequests().length;

  await recovery.getByRole("button", { name: "Check again" }).click();
  await expect(recovery.getByRole("alert")).toContainText("Remote check not confirmed");
  await expect(recovery.getByRole("button", { name: "Check remote access" })).toBeEnabled();
  expect(api.remoteStatusRequests()).toHaveLength(1);
  expect(api.hostRequests()).toHaveLength(hostsBefore);
  await page.waitForTimeout(250);
  expect(api.remoteStatusRequests()).toHaveLength(1);
  await recovery.scrollIntoViewIfNeeded();
  await capture(page, "paired-check-failed-390x844.png");

  api.setRemoteStatusOutcome("success");
  await recovery.getByRole("button", { name: "Check remote access" }).click();
  await expect(recovery.getByRole("heading", { name: "Remote access ready" })).toBeVisible();
  expect(api.remoteStatusRequests()).toHaveLength(2);
  expect(api.hostRequests()).toHaveLength(hostsBefore + 1);
  expect(unsafeRemoteRequests(api.requests)).toEqual([]);
  await expectPrivateFreeBrowser(page);
  expect(diagnostics.pageErrors).toEqual([]);
});

test("shows only generic browser truth during loaded reconnect and recovers by observation", async ({
  page
}) => {
  const diagnostics = observePage(page, remoteRecoveryPrivateOrigin);
  const api = await installRemoteRecoveryApi(page, "remote", "ready");
  await page.goto(`${remoteRecoveryPrivateOrigin}/`);
  await expect(page.getByRole("heading", { name: "No active sessions" })).toBeVisible();

  api.setAvailable(false);
  await page.getByRole("button", { name: "Refresh sessions" }).click();
  await expect(page.getByText("Showing stale session state", { exact: true })).toBeVisible();
  let sheet = await openHostSheet(page);
  const recovery = sheet.locator(".hostdeck-remote-recovery");
  await expect(recovery.getByRole("heading", { name: "Private connection is reconnecting" }))
    .toBeVisible();
  await expect(recovery).not.toContainText(/profile|serve|certificate/iu);
  await expect(recovery.getByRole("button")).toHaveCount(0);
  await recovery.scrollIntoViewIfNeeded();
  await capture(page, "loaded-private-origin-reconnecting-390x844.png");

  await sheet.getByRole("button", { name: "Close Host and access" }).click();
  api.setAvailable(true);
  await page.getByRole("button", { name: "Refresh sessions" }).click();
  await expect(page.getByRole("heading", { name: "No active sessions" })).toBeVisible();
  sheet = await openHostSheet(page);
  await expect(sheet.getByRole("heading", { name: "Remote access ready" })).toBeVisible();
  await sheet.locator(".hostdeck-remote-recovery").scrollIntoViewIfNeeded();
  await capture(page, "loaded-private-origin-observed-recovery-390x844.png");

  expect(api.remoteStatusRequests()).toHaveLength(0);
  expect(api.requests.filter((request) => new URL(request.url()).pathname.includes("pair")))
    .toEqual([]);
  expect(unsafeRemoteRequests(api.requests)).toEqual([]);
  await expectPrivateFreeBrowser(page);
  expect(diagnostics.pageErrors).toEqual([]);
});

test("uses the same current laptop recovery copy on Session Detail", async ({ page }) => {
  const diagnostics = observePage(page);
  await installSessionDetailApi(page, "read_only");
  const overlay = await installRemoteHostOverlay(page, "profile_other");
  await page.goto(`/sessions/${sessionDetailBrowserSessionId}`);

  await expect(page.getByRole("heading", { level: 1, name: "Session Detail" })).toBeVisible();
  await expect(page.getByText("HostDeck profile is not active", { exact: true }).first())
    .toBeVisible();
  await expect(page.getByRole("list", { name: "Session activity" })).toBeVisible();
  const sheet = await openHostSheet(page);
  await expect(sheet.getByRole("heading", { name: "HostDeck profile is not active" }))
    .toBeVisible();
  await capture(page, "session-detail-profile-recovery-390x844.png");

  expect(overlay.requests.length).toBeGreaterThan(0);
  await expectPrivateFreeBrowser(page);
  expect(diagnostics.pageErrors).toEqual([]);
});

test("contains the remote rail at reference, short-height, and 200 percent reflow", async ({
  page
}) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const api = await installRemoteRecoveryApi(page, "loopback", "serve_public");
  await page.goto("/");
  const sheet = await openHostSheet(page);
  const recovery = sheet.locator(".hostdeck-remote-recovery");
  await expect(recovery.getByRole("heading", { name: "Public exposure conflicts with HostDeck" }))
    .toBeVisible();

  for (const viewport of [
    { width: 320, height: 800 },
    { width: 360, height: 800 },
    { width: 390, height: 844 },
    { width: 412, height: 915 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 }
  ]) {
    await page.setViewportSize(viewport);
    await expectSheetCloseReachable(sheet);
    await recovery.scrollIntoViewIfNeeded();
    layoutMeasurements.push(await measureRemoteLayout(page, sheet, recovery, viewport));
    await capture(page, `responsive-${viewport.width}x${viewport.height}.png`);
  }

  await page.setViewportSize({ width: 390, height: 420 });
  await expectSheetCloseReachable(sheet);
  await recovery.scrollIntoViewIfNeeded();
  layoutMeasurements.push(
    await measureRemoteLayout(page, sheet, recovery, { width: 390, height: 420 })
  );
  await capture(page, "responsive-short-390x420.png");

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  await expectSheetCloseReachable(sheet);
  await recovery.scrollIntoViewIfNeeded();
  layoutMeasurements.push(
    await measureRemoteLayout(page, sheet, recovery, {
      width: 1280,
      height: 800,
      zoom: 2
    })
  );
  await capture(page, "responsive-reflow-200-1280x800.png");
  await page.evaluate(() => {
    document.documentElement.style.zoom = "1";
  });

  expect(api.remoteStatusRequests()).toHaveLength(0);
  expect(unsafeRemoteRequests(api.requests)).toEqual([]);
  await expectPrivateFreeBrowser(page);
});

test("keeps a fresh unreachable private origin outside HostDeck diagnosis", async ({ page }) => {
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests.push(request.url());
  });
  await page.route("https://hostdeck-offline.fixture-tailnet.ts.net/**", (route) =>
    route.abort("internetdisconnected")
  );

  await expect(
    page.goto("https://hostdeck-offline.fixture-tailnet.ts.net/")
  ).rejects.toThrow(/ERR_INTERNET_DISCONNECTED/iu);
  expect(apiRequests).toEqual([]);
  expect(await page.locator("body").innerText()).not.toMatch(/profile|serve|runtime|pair/iu);
});

async function openHostSheet(page: Page): Promise<Locator> {
  const sheet = page.getByRole("dialog", { name: "Host & access" });
  if (!(await sheet.isVisible())) {
    await page.getByRole("button", { name: "Open Host and access" }).click();
  }
  await expect(sheet).toBeVisible();
  return sheet;
}

async function capture(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: resolve(artifactDirectory, name),
    animations: "disabled",
    fullPage: false
  });
}

async function expectSheetCloseReachable(sheet: Locator): Promise<void> {
  const close = sheet.getByRole("button", { name: "Close Host and access" });
  await close.scrollIntoViewIfNeeded();
  await expect(close).toBeVisible();
  await expect(close).toBeEnabled();
}

async function measureRemoteLayout(
  page: Page,
  sheet: Locator,
  recovery: Locator,
  viewport: Readonly<{ width: number; height: number; zoom?: number }>
): Promise<Record<string, unknown>> {
  const measurement = await page.evaluate(() => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const rail = document.querySelector<HTMLElement>(".hostdeck-remote-recovery");
    const action = rail?.querySelector<HTMLElement>("button");
    const close = dialog?.querySelector<HTMLElement>('[aria-label="Close Host and access"]');
    if (dialog === null || rail === null || close === null || close === undefined) {
      throw new TypeError("Remote recovery layout target is missing.");
    }
    const dialogRect = dialog.getBoundingClientRect();
    const railRect = rail.getBoundingClientRect();
    const actionRect = action?.getBoundingClientRect() ?? null;
    const scrollOwners = [dialog, ...dialog.querySelectorAll<HTMLElement>("*")].filter((element) => {
      const style = getComputedStyle(element);
      return (
        element.scrollHeight > element.clientHeight + 1 &&
        (style.overflowY === "auto" || style.overflowY === "scroll")
      );
    });
    return {
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      dialog: rect(dialogRect),
      rail: rect(railRect),
      action: actionRect === null ? null : rect(actionRect),
      close: rect(close.getBoundingClientRect()),
      scrollOwnerCount: scrollOwners.length
    };

    function rect(value: DOMRect) {
      return {
        top: value.top,
        right: value.right,
        bottom: value.bottom,
        left: value.left,
        width: value.width,
        height: value.height
      };
    }
  });
  expect(measurement.documentScrollWidth).toBeLessThanOrEqual(measurement.documentClientWidth);
  expect(measurement.rail.left).toBeGreaterThanOrEqual(measurement.dialog.left - 1);
  expect(measurement.rail.right).toBeLessThanOrEqual(measurement.dialog.right + 1);
  expect(measurement.action?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(measurement.action?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(measurement.close.height).toBeGreaterThanOrEqual(44);
  expect(measurement.close.width).toBeGreaterThanOrEqual(44);
  expect(measurement.scrollOwnerCount).toBe(1);
  await expect(sheet).toBeVisible();
  await expect(recovery).toBeVisible();
  return { viewport, ...measurement };
}

function pathCount(requests: readonly { url(): string }[], path: string): number {
  return requests.filter((request) => new URL(request.url()).pathname === path).length;
}

function unsafeRemoteRequests(requests: readonly { url(): string }[]): readonly string[] {
  return requests
    .map((request) => new URL(request.url()).pathname)
    .filter((path) =>
      [
        "/api/v1/remote/enable",
        "/api/v1/remote/disable",
        "/api/v1/access/unlock"
      ].includes(path)
    );
}

async function expectPrivateFreeBrowser(page: Page): Promise<void> {
  const state = await page.evaluate(() => ({
    body: document.body.innerText,
    history: location.pathname + location.search + location.hash,
    localStorage: localStorage.length,
    sessionStorage: sessionStorage.length
  }));
  expect(state.body).not.toMatch(
    /device_remote_recovery_phone|device_recovery_replaced|csrf|cookie|account@example|profile-key|command output/iu
  );
  expect(state.history).not.toMatch(/device_|csrf|cookie|profile-key/iu);
  expect(state.localStorage).toBe(0);
  expect(state.sessionStorage).toBe(0);
}

function observePage(page: Page, appOrigin = "http://127.0.0.1:4175") {
  const consoleErrors: string[] = [];
  const externalRequests: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== appOrigin) externalRequests.push(request.url());
  });
  return { consoleErrors, externalRequests, pageErrors };
}
