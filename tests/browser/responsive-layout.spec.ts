import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { installArchiveApi } from "./archive-control-fixture.js";
import {
  eventDiagnosticsEvent,
  installEventDiagnosticsApi
} from "./event-diagnostics-fixture.js";
import {
  installMissionControlApi,
  missionRequestPaths
} from "./mission-control-fixture.js";
import { installModelControlApi } from "./model-control-fixture.js";
import {
  installSessionDetailApi,
  sessionDetailBrowserSessionId,
  sessionDetailRequestPaths
} from "./session-detail-fixture.js";
import { installSkillsControlApi } from "./skills-control-fixture.js";

const artifactDirectory = resolve(
  "artifacts/fe-v1-016-responsive-layout-hardening"
);
const detailPath = `/sessions/${sessionDetailBrowserSessionId}`;
const visualReviewTime = new Date("2026-07-27T20:00:00.000Z");
const referenceViewports = [
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

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(visualReviewTime);
});

test("keeps the production Mission queue dense across the responsive continuum", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const api = await installMissionControlApi(page, "responsive");
  await page.goto("/");
  await expect
    .poll(async () => ({
      body: await page.locator("body").innerText(),
      consoleErrors: diagnostics.consoleErrors,
      pageErrors: diagnostics.pageErrors,
      requestPaths: missionRequestPaths(api)
    }))
    .toMatchObject({
      body: expect.stringContaining("release-approval"),
      consoleErrors: [],
      pageErrors: [],
      requestPaths: expect.arrayContaining(["/api/v1/access"])
    });
  await expect(page.getByRole("link", { name: /^release-approval/u })).toBeVisible();

  const measurements = [];
  for (const viewport of referenceViewports) {
    await page.setViewportSize(viewport);
    await expectNoHorizontalOverflow(page, viewport.width);
    await expectStableCoreTargets(page);
    measurements.push(await measureMission(page, viewport));
    await capture(page, `mission-${viewport.width}x${viewport.height}.png`);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  const status = await page.getByLabel("Host and access status").boundingBox();
  const priorityRows = page
    .getByRole("region", { name: "ACT NOW" })
    .getByRole("link");
  const secondPriorityRow = await priorityRows.nth(1).boundingBox();
  expect(status).not.toBeNull();
  expect(await priorityRows.count()).toBeGreaterThanOrEqual(2);
  expect((secondPriorityRow?.y ?? 844) + (secondPriorityRow?.height ?? 1))
    .toBeLessThanOrEqual(844);
  expect(missionRequestPaths(api).filter((path) => path === "/api/v1/sessions"))
    .toHaveLength(1);

  await writeEvidence("mission-continuum.json", {
    measurements,
    firstViewport: {
      status: roundedBox(status),
      secondPriorityRow: roundedBox(secondPriorityRow),
      priorityRowCount: await priorityRows.count()
    },
    requestPaths: missionRequestPaths(api)
  });
  await expectCleanBrowser(page, diagnostics);
});

test("uses one retained Mission snapshot for the live desktop detail split and purges it", async ({
  page
}) => {
  const diagnostics = observePage(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  const detailApi = await installSessionDetailApi(page, "writable");
  const missionApi = await installMissionControlApi(page, "responsive", {
    fallbackUnhandled: true
  });
  await page.goto("/");

  const selectedLink = page.getByRole("link", { name: /^android-release/u });
  await expect(selectedLink).toBeVisible();
  await selectedLink.click();
  await expect(page).toHaveURL(new RegExp(`${detailPath}$`, "u"));
  await expect(
    page.getByRole("textbox", { name: "Prompt for android-release" })
  ).toBeVisible();

  const retained = page.getByRole("navigation", {
    name: "Mission Control sessions"
  });
  await expect(retained).toBeVisible();
  await expect(retained.getByText(/Retained list/u)).toBeVisible();
  await expect(retained.getByRole("link", { name: /^android-release/u }))
    .toHaveAttribute("aria-current", "page");
  await expect(retained.getByRole("button", { name: /refresh|load more/iu }))
    .toHaveCount(0);
  expect(missionRequestPaths(missionApi).filter((path) => path === "/api/v1/sessions"))
    .toHaveLength(1);

  const split = await measureDesktopSplit(page);
  expect(split.layout.width).toBeLessThanOrEqual(1216);
  expect(split.mission.right).toBeLessThanOrEqual(split.detail.left);
  expect(split.controls.left).toBeGreaterThanOrEqual(split.detail.left);
  expect(split.controls.right).toBeLessThanOrEqual(split.detail.right);
  expect(split.missionOverflowY).toBe("auto");
  expect(split.detailOverflowY).toBe("auto");
  expect(split.document).toEqual({ clientHeight: 800, scrollHeight: 800 });
  await capture(page, "desktop-split-1280x800.png");

  missionApi.setVariant("denied");
  await page.getByRole("button", { name: "Refresh session" }).click();
  await expect(page.getByText("Device access is invalid", { exact: true })).toBeVisible();
  await expect(retained.getByText("No retained session list", { exact: true }))
    .toBeVisible();
  await expect(retained.getByRole("listitem")).toHaveCount(0);
  await capture(page, "desktop-authority-purged-1280x800.png");

  const requestPaths = missionRequestPaths(missionApi);
  expect(requestPaths.filter((path) => path === "/api/v1/sessions")).toHaveLength(1);
  await writeEvidence("desktop-split.json", {
    split,
    missionRequestPaths: requestPaths,
    detailRequestPaths: sessionDetailRequestPaths(detailApi),
    retainedAfterAuthorityLoss: await retained.getByRole("listitem").count()
  });
  await expectCleanBrowser(page, diagnostics);
});

test("renders a truthful direct-detail desktop fallback with no hidden list read", async ({
  page
}) => {
  const diagnostics = observePage(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  const api = await installSessionDetailApi(page, "writable");
  await page.goto(detailPath);
  await expect(
    page.getByRole("textbox", { name: "Prompt for android-release" })
  ).toBeVisible();

  const retained = page.getByRole("navigation", {
    name: "Mission Control sessions"
  });
  await expect(retained).toBeVisible();
  await expect(retained.getByText("No retained session list", { exact: true }))
    .toBeVisible();
  await expect(retained.getByRole("listitem")).toHaveCount(0);
  await expect(retained.getByRole("link")).toHaveCount(1);
  await expect(retained.getByRole("link", { name: "Open Mission Control" }))
    .toHaveAttribute("href", "/");
  expect(sessionDetailRequestPaths(api).filter((path) => path === "/api/v1/sessions"))
    .toHaveLength(0);
  await capture(page, "desktop-direct-fallback-1280x800.png");
  await expectCleanBrowser(page, diagnostics);
});

test("contains the detail controls at short, landscape, inset, and 200 percent reflow geometry", async ({
  page
}) => {
  test.setTimeout(45_000);
  const diagnostics = observePage(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installSessionDetailApi(page, "writable_long");
  await page.goto(detailPath);
  const target = "android-release-validation-long-session-name-2026";
  await expect(page.getByRole("textbox", { name: `Prompt for ${target}` }))
    .toBeVisible();

  const stressViewports = [
    { width: 320, height: 480 },
    { width: 390, height: 420 },
    { width: 800, height: 360 },
    { width: 915, height: 412 }
  ] as const;
  const measurements = [];
  for (const viewport of stressViewports) {
    await page.setViewportSize(viewport);
    await expectNoHorizontalOverflow(page, viewport.width);
    await expect(page.locator(".hostdeck-responsive-detail-layout__mission"))
      .toBeHidden();
    await expect(page.getByRole("textbox", { name: `Prompt for ${target}` }))
      .toBeVisible();
    await expect(page.getByRole("button", { name: `Send prompt to ${target}` }))
      .toBeVisible();
    measurements.push(await measureMobileDetail(page, viewport));
    await capture(page, `detail-stress-${viewport.width}x${viewport.height}.png`);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--hostdeck-safe-area-top", "32px");
    document.documentElement.style.setProperty("--hostdeck-safe-area-bottom", "24px");
  });
  const inset = await measureInsetGeometry(page, target);
  expect(inset.appBar.height).toBe(88);
  expect(inset.appBar.bottom).toBe(inset.main.top);
  expect(inset.back.top).toBeGreaterThanOrEqual(32);
  expect(inset.send.bottom).toBeLessThanOrEqual(844 - 24);
  await capture(page, "detail-safe-area-32-24-390x844.png");

  await page.evaluate(() => {
    document.documentElement.style.removeProperty("--hostdeck-safe-area-top");
    document.documentElement.style.removeProperty("--hostdeck-safe-area-bottom");
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
  await expectNoHorizontalOverflow(page, 640);
  await expect(page.locator(".hostdeck-responsive-detail-layout__mission"))
    .toBeHidden();
  const effectiveViewport = await page.evaluate(() => ({
    height: window.innerHeight,
    width: window.innerWidth
  }));
  expect(effectiveViewport).toEqual({ width: 640, height: 400 });
  const zoomCapture = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false
  });
  await writeFile(
    resolve(artifactDirectory, "detail-reflow-200-1280x800.png"),
    Buffer.from(zoomCapture.data, "base64")
  );

  await writeEvidence("detail-stress.json", {
    measurements,
    inset,
    reflow: { effectiveViewport, physicalViewport: { width: 1280, height: 800 } }
  });
  await expectCleanBrowser(page, diagnostics);
});

test("contains the maximum primary model sheet at short phone and desktop geometry", async ({
  page
}) => {
  const diagnostics = observePage(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 480 });
  await installModelControlApi(page, {
    sessionVariant: "writable_long",
    snapshotVariant: "long"
  });
  await page.goto(detailPath);
  const target = "android-release-validation-long-session-name-2026";
  await page.getByRole("button", { name: `/model for ${target}` }).click();
  const dialog = page.getByRole("dialog", { name: "/model" });
  await expect(dialog).toBeVisible();

  const measurements = [];
  for (const viewport of [
    { width: 320, height: 480 },
    { width: 1280, height: 800 }
  ] as const) {
    await page.setViewportSize(viewport);
    await expectNoHorizontalOverflow(page, viewport.width);
    measurements.push(await measureSheet(page, {
      body: ".hostdeck-model-sheet__body",
      dialog: ".hostdeck-model-sheet",
      footer: ".hostdeck-model-sheet__footer"
    }));
    await capture(page, `primary-model-${viewport.width}x${viewport.height}.png`);
  }

  await page.setViewportSize({ width: 320, height: 480 });
  await page.locator(".hostdeck-model-sheet__body").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(dialog.getByText("Effort level", { exact: true })).toBeVisible();
  await expect(dialog.locator(".hostdeck-model-sheet__submit")).toBeVisible();
  await capture(page, "primary-model-scrolled-320x480.png");
  await writeEvidence("primary-model-sheet.json", { measurements });
  await expectCleanBrowser(page, diagnostics);
});

test("contains long Skills utility data with one bounded sheet scroller", async ({ page }) => {
  const diagnostics = observePage(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 420 });
  const api = await installSkillsControlApi(page, {
    sessionVariant: "writable_long",
    snapshotVariant: "long"
  });
  await page.goto(detailPath);
  const target = "android-release-validation-long-session-name-2026";
  await page.getByRole("button", { name: `More session utilities for ${target}` }).click();
  const utilities = page.getByRole("dialog", { name: "Session utilities" });
  await utilities.getByRole("button", { name: /skills/iu }).click();
  const dialog = page.getByRole("dialog", { name: "/skills" });
  await expect(dialog.getByText("Loading Skills", { exact: true })).toHaveCount(0);

  const measurements = [];
  for (const viewport of [
    { width: 390, height: 420 },
    { width: 1280, height: 800 }
  ] as const) {
    await page.setViewportSize(viewport);
    await expectNoHorizontalOverflow(page, viewport.width);
    measurements.push(await measureSheet(page, {
      body: ".hostdeck-skills-sheet__scroller",
      dialog: ".hostdeck-usage-sheet",
      footer: ".hostdeck-skills-footer"
    }));
    await capture(page, `utility-skills-${viewport.width}x${viewport.height}.png`);
  }

  await page.setViewportSize({ width: 390, height: 420 });
  await page.locator(".hostdeck-skills-sheet__scroller").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(dialog.getByRole("button", { name: "Refresh Skills" })).toBeVisible();
  await capture(page, "utility-skills-scrolled-390x420.png");
  await writeEvidence("utility-skills-sheet.json", {
    measurements,
    requestCount: api.requests().length
  });
  await expectCleanBrowser(page, diagnostics);
});

test("contains a maximum event payload in the diagnostic sheet", async ({ page }) => {
  test.setTimeout(45_000);
  const diagnostics = observePage(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 480 });
  const text = "x".repeat(12_000);
  const event = eventDiagnosticsEvent("message", 1, { itemId: null, text });
  const api = await installEventDiagnosticsApi(page, {
    events: [event],
    sessionVariant: "writable_long"
  });
  await page.goto(detailPath);
  await page.getByRole("button", { name: "View event details" }).click();
  const dialog = page.getByRole("dialog", { name: "Event details" });
  await expect(dialog.getByText("Event details current", { exact: true })).toBeVisible();

  const measurements = [];
  for (const viewport of [
    { width: 320, height: 480 },
    { width: 1280, height: 800 }
  ] as const) {
    await page.setViewportSize(viewport);
    await expectNoHorizontalOverflow(page, viewport.width);
    measurements.push(await measureSheet(page, {
      body: ".hostdeck-event-sheet__scroller",
      dialog: ".hostdeck-event-sheet"
    }));
    await capture(page, `diagnostic-event-${viewport.width}x${viewport.height}.png`);
  }

  await page.setViewportSize({ width: 320, height: 480 });
  await dialog.getByRole("button", { name: "Expand field" }).click();
  await page.locator(".hostdeck-event-sheet__scroller").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(dialog.getByRole("button", { name: "Retry" })).toBeVisible();
  await capture(page, "diagnostic-event-expanded-scrolled-320x480.png");
  await writeEvidence("diagnostic-event-sheet.json", {
    measurements,
    payloadLength: text.length,
    requestCount: api.requests().length
  });
  await expectCleanBrowser(page, diagnostics);
});

test("keeps the archive confirmation consequence and actions reachable", async ({ page }) => {
  const diagnostics = observePage(page);
  await page.setViewportSize({ width: 320, height: 480 });
  await installSessionDetailApi(page, "writable_long", {
    initialEvents: [],
    streamEvents: [],
    turnState: "idle"
  });
  const archive = await installArchiveApi(page);
  await page.goto(detailPath);
  await page.getByRole("button", { name: "Open session actions" }).click();
  const actions = page.getByRole("dialog", { name: "Session actions", exact: true });
  await actions.getByRole("button", { name: /Archive session/iu }).click();
  const confirmation = page.getByRole("dialog", { name: "Archive session?", exact: true });
  await expect(confirmation.getByText("Archive this managed session", { exact: true }))
    .toBeVisible();

  const measurements = [];
  for (const viewport of [
    { width: 320, height: 480 },
    { width: 1280, height: 800 }
  ] as const) {
    await page.setViewportSize(viewport);
    await expectNoHorizontalOverflow(page, viewport.width);
    measurements.push(await measureSheet(page, {
      body: ".hostdeck-session-actions__scroller",
      dialog: ".hostdeck-session-actions-sheet",
      footer: ".hostdeck-session-actions__footer"
    }));
    await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeVisible();
    await expect(
      confirmation.getByRole("button", { name: "Archive session", exact: true })
    ).toBeVisible();
    await capture(page, `archive-confirmation-${viewport.width}x${viewport.height}.png`);
  }

  expect(archive.requests()).toHaveLength(0);
  await writeEvidence("archive-confirmation-sheet.json", { measurements });
  await expectCleanBrowser(page, diagnostics);
});

test("contains Host and access plus bounded production route errors", async ({ page }) => {
  const diagnostics = observePage(page);
  await page.setViewportSize({ width: 320, height: 480 });
  await installMissionControlApi(page, "responsive");
  await page.goto("/");
  await expect(page.getByRole("link", { name: /^release-approval/u })).toBeVisible();
  await page.getByRole("button", { name: "Open Host and access" }).click();
  const dialog = page.getByRole("dialog", { name: "Host & access" });
  await expect(dialog.getByRole("heading", { name: "Secure control ready" })).toBeVisible();

  const measurements = [];
  for (const viewport of [
    { width: 320, height: 480 },
    { width: 1280, height: 800 }
  ] as const) {
    await page.setViewportSize(viewport);
    await expectNoHorizontalOverflow(page, viewport.width);
    measurements.push(await measureSheet(page, {
      body: ".hostdeck-sheet__body",
      dialog: ".hostdeck-sheet"
    }));
    await capture(page, `host-access-${viewport.width}x${viewport.height}.png`);
  }

  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 320, height: 480 });
  await page.goto("/sessions/%2Fprivate-secret");
  await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
  await expect(page.getByRole("main")).not.toContainText("private-secret");
  await expectNoHorizontalOverflow(page, 320);
  await capture(page, "route-not-found-320x480.png");

  const pairingCode = "AbCdEfGhIjKlMnOpQrSt_1";
  await page.goto(`/#pair=${pairingCode}`);
  await expect(page.getByRole("heading", { level: 1, name: "Pairing link is invalid" }))
    .toBeVisible();
  await expect(page).toHaveURL("http://127.0.0.1:4175/");
  expect(await page.locator("body").innerText()).not.toContain(pairingCode);
  await expectNoHorizontalOverflow(page, 320);
  await capture(page, "pairing-invalid-fragment-320x480.png");

  await writeEvidence("host-access-and-errors.json", { measurements });
  await expectCleanBrowser(page, diagnostics);
});

async function capture(page: Page, filename: string): Promise<void> {
  await page.screenshot({
    path: resolve(artifactDirectory, filename),
    animations: "disabled"
  });
}

async function writeEvidence(filename: string, evidence: unknown): Promise<void> {
  await writeFile(
    resolve(artifactDirectory, filename),
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8"
  );
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

async function expectNoHorizontalOverflow(page: Page, width: number): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth
      }))
    )
    .toEqual({ clientWidth: width, scrollWidth: width });
}

async function expectStableCoreTargets(page: Page): Promise<void> {
  for (const selector of [
    ".hostdeck-icon-button:visible",
    ".hostdeck-action-button:visible",
    ".hostdeck-session-row__link:visible"
  ]) {
    const targets = page.locator(selector);
    for (let index = 0; index < (await targets.count()); index += 1) {
      const box = await targets.nth(index).boundingBox();
      expect(box?.height ?? 0, `${selector} target ${index + 1}`).toBeGreaterThanOrEqual(44);
    }
  }
}

async function measureMission(
  page: Page,
  viewport: { readonly width: number; readonly height: number }
) {
  return page.evaluate((selectedViewport) => {
    const required = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (element === null) {
        throw new TypeError(`Responsive layout target is missing: ${selector}`);
      }
      return element;
    };
    const box = (element: Element) => {
      const bounds = element.getBoundingClientRect();
      return {
        bottom: Math.round(bounds.bottom),
        height: Math.round(bounds.height),
        left: Math.round(bounds.left),
        right: Math.round(bounds.right),
        top: Math.round(bounds.top),
        width: Math.round(bounds.width)
      };
    };
    const route = required(".hostdeck-mission");
    return {
      viewport: selectedViewport,
      document: {
        clientHeight: document.documentElement.clientHeight,
        clientWidth: document.documentElement.clientWidth,
        scrollHeight: document.documentElement.scrollHeight,
        scrollWidth: document.documentElement.scrollWidth
      },
      route: box(route),
      fontSize: getComputedStyle(required("#mission-control-title")).fontSize
    };
  }, viewport);
}

async function measureDesktopSplit(page: Page) {
  return page.evaluate(() => {
    const required = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (element === null) {
        throw new TypeError(`Responsive layout target is missing: ${selector}`);
      }
      return element;
    };
    const box = (element: Element) => {
      const bounds = element.getBoundingClientRect();
      return {
        bottom: Math.round(bounds.bottom),
        height: Math.round(bounds.height),
        left: Math.round(bounds.left),
        right: Math.round(bounds.right),
        top: Math.round(bounds.top),
        width: Math.round(bounds.width)
      };
    };
    const layout = required(".hostdeck-responsive-detail-layout");
    const mission = required(".hostdeck-responsive-detail-layout__mission");
    const detail = required(".hostdeck-responsive-detail-layout__detail");
    const scrollOwner = required(".hostdeck-detail__scroll-owner");
    const controls = required(".hostdeck-session-controls");
    return {
      document: {
        clientHeight: document.documentElement.clientHeight,
        scrollHeight: document.documentElement.scrollHeight
      },
      layout: box(layout),
      mission: box(mission),
      detail: box(detail),
      controls: box(controls),
      missionOverflowY: getComputedStyle(mission).overflowY,
      detailOverflowY: getComputedStyle(scrollOwner).overflowY
    };
  });
}

async function measureMobileDetail(
  page: Page,
  viewport: { readonly width: number; readonly height: number }
) {
  return page.evaluate((selectedViewport) => {
    const required = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (element === null) {
        throw new TypeError(`Responsive layout target is missing: ${selector}`);
      }
      return element;
    };
    const box = (element: Element) => {
      const bounds = element.getBoundingClientRect();
      return {
        bottom: Math.round(bounds.bottom),
        height: Math.round(bounds.height),
        left: Math.round(bounds.left),
        right: Math.round(bounds.right),
        top: Math.round(bounds.top),
        width: Math.round(bounds.width)
      };
    };
    const controls = required(".hostdeck-session-controls");
    const composer = required(".hostdeck-prompt-composer");
    const scrollOwner = required(".hostdeck-detail__scroll-owner");
    return {
      viewport: selectedViewport,
      document: {
        clientHeight: document.documentElement.clientHeight,
        clientWidth: document.documentElement.clientWidth,
        scrollHeight: document.documentElement.scrollHeight,
        scrollWidth: document.documentElement.scrollWidth
      },
      controls: box(controls),
      composer: box(composer),
      scrollOwnerDisplay: getComputedStyle(scrollOwner).display,
      controlsOverflowY: getComputedStyle(controls).overflowY
    };
  }, viewport);
}

async function measureInsetGeometry(page: Page, target: string) {
  const send = page.getByRole("button", { name: `Send prompt to ${target}` });
  return {
    appBar: roundedBox(await page.locator(".hostdeck-app-bar").boundingBox()),
    main: roundedBox(await page.locator(".hostdeck-main").boundingBox()),
    back: roundedBox(
      await page.getByRole("button", { name: "Back to Mission Control" }).boundingBox()
    ),
    send: roundedBox(await send.boundingBox())
  } as {
    readonly appBar: NonNullable<ReturnType<typeof roundedBox>>;
    readonly main: NonNullable<ReturnType<typeof roundedBox>>;
    readonly back: NonNullable<ReturnType<typeof roundedBox>>;
    readonly send: NonNullable<ReturnType<typeof roundedBox>>;
  };
}

async function measureSheet(
  page: Page,
  selectors: Readonly<{ dialog: string; body: string; footer?: string }>
) {
  const measurement = await page.evaluate((selected) => {
    const required = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (element === null) {
        throw new TypeError(`Responsive sheet target is missing: ${selector}`);
      }
      return element;
    };
    const box = (element: Element) => {
      const bounds = element.getBoundingClientRect();
      return {
        bottom: Math.round(bounds.bottom),
        height: Math.round(bounds.height),
        left: Math.round(bounds.left),
        right: Math.round(bounds.right),
        top: Math.round(bounds.top),
        width: Math.round(bounds.width)
      };
    };
    const dialog = required(selected.dialog);
    const body = required(selected.body);
    const footer = selected.footer === undefined ? null : required(selected.footer);
    const visibleButtons = [...dialog.querySelectorAll("button")]
      .filter((element): element is HTMLButtonElement => {
        if (!(element instanceof HTMLButtonElement)) return false;
        const bounds = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return bounds.width > 0 && bounds.height > 0 && style.visibility !== "hidden";
      });
    const scrollOwners = [body, ...body.querySelectorAll<HTMLElement>("*")]
      .filter((element) => {
        const overflow = getComputedStyle(element).overflowY;
        return ["auto", "scroll"].includes(overflow) &&
          element.scrollHeight > element.clientHeight + 1;
      })
      .map((element) => element.className || element.tagName.toLowerCase());
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      document: {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth
      },
      dialog: box(dialog),
      body: {
        ...box(body),
        clientHeight: body.clientHeight,
        overflowY: getComputedStyle(body).overflowY,
        scrollHeight: body.scrollHeight
      },
      footer: footer === null ? null : box(footer),
      buttonCount: visibleButtons.length,
      minimumButtonHeight: Math.round(
        Math.min(...visibleButtons.map((button) => button.getBoundingClientRect().height))
      ),
      scrollOwners
    };
  }, selectors);

  expect(measurement.document.scrollWidth).toBe(measurement.document.clientWidth);
  expect(measurement.dialog.left).toBeGreaterThanOrEqual(0);
  expect(measurement.dialog.right).toBeLessThanOrEqual(measurement.viewport.width + 1);
  expect(measurement.dialog.top).toBeGreaterThanOrEqual(0);
  expect(measurement.dialog.bottom).toBeLessThanOrEqual(measurement.viewport.height + 1);
  expect(measurement.body.left).toBeGreaterThanOrEqual(measurement.dialog.left);
  expect(measurement.body.right).toBeLessThanOrEqual(measurement.dialog.right);
  expect(measurement.body.bottom).toBeLessThanOrEqual(measurement.dialog.bottom);
  expect(["auto", "scroll"]).toContain(measurement.body.overflowY);
  expect(measurement.buttonCount).toBeGreaterThan(0);
  expect(measurement.minimumButtonHeight).toBeGreaterThanOrEqual(40);
  expect(measurement.scrollOwners.length).toBeLessThanOrEqual(1);
  if (measurement.footer !== null) {
    expect(measurement.footer.left).toBeGreaterThanOrEqual(measurement.dialog.left);
    expect(measurement.footer.right).toBeLessThanOrEqual(measurement.dialog.right);
    expect(measurement.footer.bottom).toBeLessThanOrEqual(measurement.dialog.bottom);
  }
  return measurement;
}

async function expectCleanBrowser(
  page: Page,
  diagnostics: ReturnType<typeof observePage>
): Promise<void> {
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.externalRequests).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
  const privacy = await page.evaluate(() => ({
    body: document.body.innerText,
    history: JSON.stringify(history.state),
    localStorage: localStorage.length,
    sessionStorage: sessionStorage.length
  }));
  expect(privacy.body).not.toMatch(/thread-private|request-private|csrf_token/iu);
  expect(privacy.history).not.toMatch(/thread-private|request-private|csrf_token/iu);
  expect(privacy.localStorage).toBe(0);
  expect(privacy.sessionStorage).toBe(0);
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
  return {
    bottom: Math.round(box.y + box.height),
    height: Math.round(box.height),
    left: Math.round(box.x),
    right: Math.round(box.x + box.width),
    top: Math.round(box.y),
    width: Math.round(box.width)
  };
}
