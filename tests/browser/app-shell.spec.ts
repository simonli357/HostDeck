import { expect, type Page, test } from "@playwright/test";
import {
  installMissionControlApi,
  missionRequestPaths
} from "./mission-control-fixture.js";
import {
  installSessionDetailApi,
  sessionDetailBrowserSessionId
} from "./session-detail-fixture.js";

test("renders the Mission Control shell and preserves modal route and focus", async ({ page }) => {
  const diagnostics = observePage(page);
  const api = await installMissionControlApi(page);

  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1, name: "Mission Control" })).toBeVisible();
  await expect(page.getByRole("link", { name: /^release-approval/u })).toBeVisible();
  await expect(page.getByText("Write", { exact: true })).toBeVisible();
  await expect(page.getByText("Current", { exact: true })).toBeVisible();
  const trigger = page.getByRole("button", { name: "Open Host and access" });
  await expect(trigger).toHaveCSS("width", "44px");
  await expect(trigger).toHaveCSS("height", "44px");
  await expectNoHorizontalOverflow(page);

  await trigger.click();

  const dialog = page.getByRole("dialog", { name: "Host & access" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Secure control ready" })).toBeVisible();
  await expect(dialog.getByText("Read & write", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Ready", { exact: true }).first()).toBeVisible();
  await expect(dialog.getByText("http://127.0.0.1:4175", { exact: true })).toBeVisible();
  await expect(page).toHaveURL("http://127.0.0.1:4175/");
  await expect
    .poll(() => page.evaluate(() => document.querySelector('[role="dialog"]')?.contains(document.activeElement)))
    .toBe(true);
  await page.keyboard.press("Tab");
  await expect
    .poll(() => page.evaluate(() => document.querySelector('[role="dialog"]')?.contains(document.activeElement)))
    .toBe(true);

  await page.keyboard.press("Escape");

  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(page).toHaveURL("http://127.0.0.1:4175/");
  await expectNoUnexpectedRuntimeActivity(page, diagnostics, [
    "/api/v1/access",
    "/api/v1/host/status",
    "/api/v1/sessions",
    "/api/v1/access/csrf"
  ]);
  expect(missionRequestPaths(api)).toHaveLength(4);
});

test("scrubs an invalid production fragment before routes or API work", async ({ page }) => {
  const diagnostics = observePage(page);
  const pairingCode = "AbCdEfGhIjKlMnOpQrSt_1";

  await page.goto(`/#pair=${pairingCode}`);

  await expect(page.getByRole("heading", { level: 1, name: "Pairing link is invalid" }))
    .toBeVisible();
  await expect(page).toHaveURL("http://127.0.0.1:4175/");
  await expect(page.getByRole("heading", { level: 1, name: "Mission Control" })).toHaveCount(0);
  expect(await page.locator("body").innerText()).not.toContain(pairingCode);
  await expectNoHorizontalOverflow(page);
  await expectNoUnexpectedRuntimeActivity(page, diagnostics);
});

test("renders direct Session Detail safely and rejects invalid routes", async ({ page }) => {
  const diagnostics = observePage(page);
  await installSessionDetailApi(page);

  await page.goto(`/sessions/${sessionDetailBrowserSessionId}`);

  await expect(page.getByText("The structured mobile session feed is ready for device validation."))
    .toBeVisible();
  await expect(page.getByRole("banner")).toContainText("android-release");
  await expect(page.getByRole("banner")).not.toContainText(sessionDetailBrowserSessionId);
  await expectNoHorizontalOverflow(page);

  await page.getByRole("button", { name: "Back to Mission Control" }).click();

  await expect(page).toHaveURL("http://127.0.0.1:4175/");
  await expect(page.getByRole("heading", { level: 1, name: "Mission Control" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to Mission Control" })).toHaveCount(0);

  await page.goto("/sessions/%2Fprivate-secret");

  await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
  await expect(page.getByRole("main")).not.toContainText("private-secret");
  await expectNoHorizontalOverflow(page);
  await expectNoUnexpectedRuntimeActivity(page, diagnostics, [
    "/api/v1/access",
    "/api/v1/host/status",
    `/api/v1/sessions/${sessionDetailBrowserSessionId}`,
    "/api/v1/access/csrf",
    "/api/v1/access",
    "/api/v1/host/status",
    "/api/v1/sessions"
  ]);
});

function observePage(page: Page) {
  const apiRequests: string[] = [];
  const externalRequests: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) apiRequests.push(request.url());
    if (url.origin !== "http://127.0.0.1:4175") externalRequests.push(request.url());
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  return { apiRequests, consoleErrors, externalRequests, pageErrors };
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth
      }))
    )
    .toEqual({ clientWidth: 390, scrollWidth: 390 });
}

async function expectNoUnexpectedRuntimeActivity(
  page: Page,
  diagnostics: ReturnType<typeof observePage>,
  expectedApiPaths: readonly string[] = []
): Promise<void> {
  const actualApiPaths = diagnostics.apiRequests.map((url) => new URL(url).pathname);
  expect(actualApiPaths[0]).toBe(expectedApiPaths[0]);
  expect([...actualApiPaths].sort()).toEqual([...expectedApiPaths].sort());
  expect(diagnostics.externalRequests).toEqual([]);
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
  await expect
    .poll(() => page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })))
    .toEqual({ local: 0, session: 0 });
}
