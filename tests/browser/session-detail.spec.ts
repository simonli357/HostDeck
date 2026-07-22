import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  installSessionDetailApi,
  liveActivityEvent,
  sessionDetailBrowserSessionId,
  sessionDetailRequestPaths
} from "./session-detail-fixture.js";

const artifactDirectory = resolve("artifacts/fe-v1-012-session-detail");
const detailPath = `/sessions/${sessionDetailBrowserSessionId}`;
const viewports = [
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 412, height: 915 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 }
] as const;

test.beforeAll(async () => {
  await mkdir(artifactDirectory, { recursive: true });
});

test("renders the production structured feed across the approved responsive continuum", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const api = await installSessionDetailApi(page);
  await page.goto(detailPath);

  await expect(page.getByText("The structured mobile session feed is ready for device validation."))
    .toBeVisible();
  await expect(page.getByText("Approval required", { exact: true })).toBeVisible();
  await expect(page.getByText("Install the Android validation package", { exact: true }))
    .toBeVisible();
  await expect(page.getByText("Needs approval", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Current", { exact: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "Session activity" })).toBeVisible();
  await expect(page.getByText("I reviewed the structured session contracts.", { exact: true }))
    .toHaveCount(0);
  await expect(page.getByRole("button", { name: /approve|deny/u })).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveCount(0);

  expect(await api.streamRequestUrls()).toEqual([
    `http://127.0.0.1:4175/api/v1/sessions/${sessionDetailBrowserSessionId}/events/stream?after=0`
  ]);
  expect(sessionDetailRequestPaths(api)).toEqual([
    "/api/v1/access",
    expect.stringMatching(
      new RegExp(`^/api/v1/(?:host/status|sessions/${sessionDetailBrowserSessionId})$`, "u")
    ),
    expect.stringMatching(
      new RegExp(`^/api/v1/(?:host/status|sessions/${sessionDetailBrowserSessionId})$`, "u")
    ),
    "/api/v1/access/csrf"
  ]);

  const measurements: Awaited<ReturnType<typeof measureLayout>>[] = [];
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expectNoHorizontalOverflow(page, viewport.width);
    await expectStableTargets(page);
    const measurement = await measureLayout(page, viewport);
    expect(measurement.document.scrollWidth).toBe(viewport.width);
    expect(measurement.context.bottom).toBeLessThanOrEqual(
      measurement.firstTimelineItem.top
    );
    expect(measurement.refreshTarget).toEqual({ height: 44, width: 44 });
    measurements.push(measurement);
    await page.screenshot({
      path: resolve(
        artifactDirectory,
        `active-${viewport.width}x${viewport.height}.png`
      ),
      animations: "disabled"
    });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: resolve(artifactDirectory, "active-full-390x844.png"),
    animations: "disabled",
    fullPage: true
  });
  await writeFile(
    resolve(artifactDirectory, "layout-measurements.json"),
    `${JSON.stringify({ measurements }, null, 2)}\n`,
    "utf8"
  );
  await expectDesktopCompositionBound(page);
  await expectPrivateRuntimeDataAbsent(page);
  await expectCleanBrowser(page, diagnostics);
});

test("shows stale and revoked authority truth without leaking retained session data", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const api = await installSessionDetailApi(page);
  await page.goto(detailPath);
  await expect(page.getByText("Approval required", { exact: true })).toBeVisible();

  api.setVariant("unavailable");
  await page.getByRole("button", { name: "Refresh session" }).click();
  await expect(page.getByText("Showing stale session state", { exact: true })).toBeVisible();
  await expect(page.getByText("Stale", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent activity unavailable" })).toBeVisible();
  await expectNoHorizontalOverflow(page, 390);
  await page.screenshot({
    path: resolve(artifactDirectory, "stale-390x844.png"),
    animations: "disabled"
  });

  api.setVariant("denied");
  await page.reload();
  await expect(page.getByText("Device access was revoked", { exact: true })).toBeVisible();
  await expect(page.getByText("android-release", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Session activity" })).toHaveCount(0);
  await expect(page.getByText("9 events", { exact: true })).toHaveCount(0);
  await expectNoHorizontalOverflow(page, 390);
  await page.screenshot({
    path: resolve(artifactDirectory, "access-limited-390x844.png"),
    animations: "disabled"
  });

  await expectPrivateRuntimeDataAbsent(page);
  await expectCleanBrowser(page, diagnostics, 1);
});

test("renders an honest empty state and does not invent downstream controls", async ({ page }) => {
  const diagnostics = observePage(page);
  const api = await installSessionDetailApi(page, "empty");
  await page.goto(detailPath);

  await expect(page.getByRole("heading", { name: "No activity recorded" })).toBeVisible();
  await expect(page.getByText("This session has no retained structured activity.")).toBeVisible();
  await expect(page.getByRole("list", { name: "Session activity" })).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /approve|deny/u })).toHaveCount(0);
  expect(await api.streamRequestUrls()).toEqual([
    `http://127.0.0.1:4175/api/v1/sessions/${sessionDetailBrowserSessionId}/events/stream`
  ]);

  await page.screenshot({
    path: resolve(artifactDirectory, "empty-390x844.png"),
    animations: "disabled"
  });
  await expectCleanBrowser(page, diagnostics);
});

test("keeps boundary and terminal stream failure truth visible with retained activity", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const api = await installSessionDetailApi(page, "boundary");
  await page.goto(detailPath);

  await expect(page.getByText("Earlier activity unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText("History limited", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Approval required", { exact: true })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: resolve(artifactDirectory, "approval-boundary-390x844.png"),
    animations: "disabled"
  });

  await api.breakStream();
  await expect(page.getByText("Live activity stopped", { exact: true })).toBeVisible();
  await expect(page.getByText("Continue from retained history.", { exact: true })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: resolve(artifactDirectory, "stream-failed-390x844.png"),
    animations: "disabled"
  });
  await expectCleanBrowser(page, diagnostics);
});

test("shows reconnecting state without discarding or falsifying retained activity", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const api = await installSessionDetailApi(page);
  await page.goto(detailPath);
  await expect(page.getByText("Approval required", { exact: true })).toBeVisible();

  await api.dropStream();
  await expect(page.getByText("Activity stream reconnecting", { exact: true })).toBeVisible();
  await expect(page.getByText("Reconnecting", { exact: true })).toBeVisible();
  await expect(page.getByText("The structured mobile session feed is ready for device validation."))
    .toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: resolve(artifactDirectory, "reconnecting-390x844.png"),
    animations: "disabled"
  });
  await expectCleanBrowser(page, diagnostics);
});

test("contains long content and passes keyboard, reflow, zoom, and live-update checks", async ({
  page
}) => {
  const diagnostics = observePage(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 800 });
  const api = await installSessionDetailApi(page, "long");
  await page.goto(detailPath);
  await expect(page.getByText(/The bounded mobile validation remains readable/u)).toBeVisible();

  await page.evaluate(() => window.scrollTo(0, 0));
  await expectNoHorizontalOverflow(page, 320);
  await expectStableTargets(page);
  await expectNoClippedTimelineItems(page);
  await expectNextKeyboardFocus(page, page.getByRole("link", { name: "Skip to content" }));
  await expectNextKeyboardFocus(page, page.getByRole("button", { name: "Back to Mission Control" }));
  await expectNextKeyboardFocus(page, page.getByRole("button", { name: "Open Host and access" }));
  await expectNextKeyboardFocus(page, page.getByRole("button", { name: "Refresh session" }));
  await expectTokenContrast(page);
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.screenshot({
    path: resolve(artifactDirectory, "long-reflow-320x800.png"),
    animations: "disabled",
    fullPage: true
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await api.pushEvent(liveActivityEvent(5));
  await expect(page.getByRole("button", { name: "1 new event" })).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
  await page.screenshot({
    path: resolve(artifactDirectory, "new-activity-390x844.png"),
    animations: "disabled"
  });
  await page.getByRole("button", { name: "1 new event" }).click();
  await expect(page.getByText("Device validation completed", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "1 new event" })).toHaveCount(0);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(scrollBefore);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.documentElement.style.zoom = "2";
  });
  await expectNoDocumentOverflow(page);
  await expect(page.getByRole("button", { name: "Refresh session" })).toBeVisible();
  await page.screenshot({
    path: resolve(artifactDirectory, "zoom-200-1280x800.png"),
    animations: "disabled"
  });

  await expectPrivateRuntimeDataAbsent(page);
  await expectCleanBrowser(page, diagnostics);
});

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

async function expectNoHorizontalOverflow(page: Page, expectedWidth: number): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth
      }))
    )
    .toEqual({ clientWidth: expectedWidth, scrollWidth: expectedWidth });
}

async function expectStableTargets(page: Page): Promise<void> {
  const iconButtons = page.locator(".hostdeck-icon-button:visible");
  for (let index = 0; index < (await iconButtons.count()); index += 1) {
    const box = await iconButtons.nth(index).boundingBox();
    expect(box?.width).toBe(44);
    expect(box?.height).toBe(44);
  }
  const actionButtons = page.locator(".hostdeck-action-button:visible");
  for (let index = 0; index < (await actionButtons.count()); index += 1) {
    const box = await actionButtons.nth(index).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
}

async function expectNoClippedTimelineItems(page: Page): Promise<void> {
  const items = page.locator(".hostdeck-timeline-item:visible");
  for (let index = 0; index < (await items.count()); index += 1) {
    const clipped = await items.nth(index).evaluate(
      (element) =>
        element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight
    );
    expect(clipped).toBe(false);
  }
}

async function expectNextKeyboardFocus(page: Page, locator: Locator): Promise<void> {
  await page.keyboard.press("Tab");
  await expect(locator).toBeFocused();
  await expectVisibleFocus(locator);
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

async function expectDesktopCompositionBound(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  const box = await page.locator(".hostdeck-detail").boundingBox();
  expect(box).not.toBeNull();
  expect(box?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(820);
}

async function measureLayout(
  page: Page,
  viewport: { readonly width: number; readonly height: number }
) {
  return page.evaluate((selectedViewport) => {
    const detail = document.querySelector(".hostdeck-detail");
    const context = document.querySelector(".hostdeck-detail-context");
    const firstTimelineItem = document.querySelector(".hostdeck-timeline-item");
    const refresh = document.querySelector(
      ".hostdeck-detail-context__refresh"
    );
    if (
      detail === null ||
      context === null ||
      firstTimelineItem === null ||
      refresh === null
    ) {
      throw new TypeError("Session Detail layout measurement target is missing.");
    }
    const roundedBox = (element: Element) => {
      const box = element.getBoundingClientRect();
      return {
        bottom: Math.round(box.bottom),
        height: Math.round(box.height),
        left: Math.round(box.left),
        right: Math.round(box.right),
        top: Math.round(box.top),
        width: Math.round(box.width)
      };
    };
    const refreshBox = refresh.getBoundingClientRect();
    return {
      viewport: selectedViewport,
      document: {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth
      },
      detail: roundedBox(detail),
      context: roundedBox(context),
      firstTimelineItem: roundedBox(firstTimelineItem),
      refreshTarget: {
        height: Math.round(refreshBox.height),
        width: Math.round(refreshBox.width)
      }
    };
  }, viewport);
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <= document.documentElement.clientWidth
      )
    )
    .toBe(true);
}

async function expectPrivateRuntimeDataAbsent(page: Page): Promise<void> {
  const bodyText = await page.locator("body").innerText();
  expect(bodyText).not.toContain(sessionDetailBrowserSessionId);
  expect(bodyText).not.toContain("thread-private-browser-detail");
  expect(bodyText).not.toContain("request-private-browser-detail");
  expect(bodyText).not.toContain("/workspace/");
  expect(bodyText).not.toContain("codex_app_server");
}

async function expectTokenContrast(page: Page): Promise<void> {
  const colors = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return Object.fromEntries(
      [
        "--hostdeck-canvas",
        "--hostdeck-surface",
        "--hostdeck-ink",
        "--hostdeck-muted",
        "--hostdeck-connected",
        "--hostdeck-attention",
        "--hostdeck-danger",
        "--hostdeck-focus"
      ].map((name) => [name, style.getPropertyValue(name).trim()])
    );
  });
  const surface = colors["--hostdeck-surface"] ?? "";
  for (const foreground of [
    "--hostdeck-ink",
    "--hostdeck-muted",
    "--hostdeck-connected",
    "--hostdeck-attention",
    "--hostdeck-danger"
  ]) {
    expect(contrastRatio(colors[foreground] ?? "", surface)).toBeGreaterThanOrEqual(4.5);
  }
  expect(
    contrastRatio(colors["--hostdeck-focus"] ?? "", colors["--hostdeck-canvas"] ?? "")
  ).toBeGreaterThanOrEqual(3);
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
}

function relativeLuminance(color: string): number {
  if (!/^#[0-9a-f]{6}$/iu.test(color)) {
    throw new TypeError(`Expected a six-digit hex color, received ${color}.`);
  }
  const channels = [1, 3, 5].map((offset) =>
    Number.parseInt(color.slice(offset, offset + 2), 16) / 255
  );
  const [red = 0, green = 0, blue = 0] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

async function expectCleanBrowser(
  page: Page,
  diagnostics: ReturnType<typeof observePage>,
  expectedBrowserNetworkErrors = 0
): Promise<void> {
  expect(diagnostics.externalRequests).toEqual([]);
  expect(diagnostics.consoleErrors).toHaveLength(expectedBrowserNetworkErrors);
  for (const error of diagnostics.consoleErrors) {
    expect(error).toMatch(/^Failed to load resource: the server responded with a status of 503/u);
    expect(error).not.toContain("HostDeck is temporarily unavailable");
  }
  expect(diagnostics.pageErrors).toEqual([]);
  await expect
    .poll(() => page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })))
    .toEqual({ local: 0, session: 0 });
}
