import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const artifactDirectory = resolve("artifacts/fe-v1-010-shell");
const sessionId = "sess_shell_001";

test.beforeAll(async () => {
  await mkdir(artifactDirectory, { recursive: true });
});

test("renders the Mission Control shell and preserves modal route and focus", async ({ page }) => {
  const diagnostics = observePage(page);

  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1, name: "Mission Control" })).toBeVisible();
  await expect(page.getByText("Loading sessions", { exact: true })).toBeVisible();
  const trigger = page.getByRole("button", { name: "Open Host and access" });
  await expect(trigger).toHaveCSS("width", "44px");
  await expect(trigger).toHaveCSS("height", "44px");
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: resolve(artifactDirectory, "mission-control-390x844.png") });

  await trigger.click();

  const dialog = page.getByRole("dialog", { name: "Host & access" });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL("http://127.0.0.1:4175/");
  await expect
    .poll(() => page.evaluate(() => document.querySelector('[role="dialog"]')?.contains(document.activeElement)))
    .toBe(true);
  await page.keyboard.press("Tab");
  await expect
    .poll(() => page.evaluate(() => document.querySelector('[role="dialog"]')?.contains(document.activeElement)))
    .toBe(true);
  await page.screenshot({ path: resolve(artifactDirectory, "host-access-390x844.png") });

  await page.keyboard.press("Escape");

  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(page).toHaveURL("http://127.0.0.1:4175/");
  await expectNoUnexpectedRuntimeActivity(page, diagnostics);
});

test("renders direct Session Detail safely and rejects invalid routes", async ({ page }) => {
  const diagnostics = observePage(page);

  await page.goto(`/sessions/${sessionId}`);

  await expect(page.getByRole("heading", { level: 1, name: "Session Detail" })).toBeVisible();
  await expect(page.getByText(sessionId, { exact: true })).toHaveCount(2);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: resolve(artifactDirectory, "session-detail-390x844.png") });

  await page.getByRole("button", { name: "Back to Mission Control" }).click();

  await expect(page).toHaveURL("http://127.0.0.1:4175/");
  await expect(page.getByRole("heading", { level: 1, name: "Mission Control" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to Mission Control" })).toHaveCount(0);

  await page.goto("/sessions/%2Fprivate-secret");

  await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
  await expect(page.getByRole("main")).not.toContainText("private-secret");
  await expectNoHorizontalOverflow(page);
  await expectNoUnexpectedRuntimeActivity(page, diagnostics);
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
  diagnostics: ReturnType<typeof observePage>
): Promise<void> {
  expect(diagnostics.apiRequests).toEqual([]);
  expect(diagnostics.externalRequests).toEqual([]);
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
  await expect
    .poll(() => page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })))
    .toEqual({ local: 0, session: 0 });
}
