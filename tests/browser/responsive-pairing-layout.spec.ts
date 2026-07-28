import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const artifactDirectory = resolve("artifacts/fe-v1-016-responsive-layout-hardening");
const visualReviewTime = new Date("2026-07-27T20:00:00.000Z");

test.beforeAll(async () => {
  await mkdir(artifactDirectory, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(visualReviewTime);
});

test("contains pairing outcomes at short, inset, landscape, and desktop geometry", async ({
  page
}) => {
  const diagnostics = observePage(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const scenarios = [
    {
      filename: "pairing-claiming-inset-320x480.png",
      height: 480,
      inset: true,
      state: "claiming",
      title: "Pairing this phone",
      width: 320
    },
    {
      filename: "pairing-unknown-short-390x420.png",
      height: 420,
      inset: false,
      state: "claim_unknown",
      title: "Pairing outcome is unknown",
      width: 390
    },
    {
      filename: "pairing-paired-landscape-800x360.png",
      height: 360,
      inset: false,
      state: "paired",
      title: "Phone paired",
      width: 800
    },
    {
      filename: "pairing-paired-desktop-1280x800.png",
      height: 800,
      inset: false,
      state: "paired",
      title: "Phone paired",
      width: 1280
    }
  ] as const;
  const measurements = [];

  for (const scenario of scenarios) {
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await page.goto(`/pairing-access.html?view=pairing&state=${scenario.state}`);
    if (scenario.inset) {
      await page.evaluate(() => {
        document.documentElement.style.setProperty("--hostdeck-safe-area-top", "32px");
        document.documentElement.style.setProperty("--hostdeck-safe-area-bottom", "24px");
      });
    }
    await expect(page.getByRole("heading", { level: 1, name: scenario.title })).toBeVisible();
    await expect(page.getByRole("list", { name: "Pairing progress" })).toBeVisible();
    await expectNoHorizontalOverflow(page, scenario.width);
    measurements.push(await measurePairing(page, scenario.inset));
    const action = page.locator(".hostdeck-pairing-result__action");
    if (await action.count() > 0) {
      await action.scrollIntoViewIfNeeded();
      await expect(action).toBeVisible();
      expect((await action.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    await capture(page, scenario.filename);
  }

  await writeEvidence("pairing-layout.json", { measurements });
  await expectCleanBrowser(page, diagnostics);
});

test("contains long remote Host and access facts in one bounded body scroller", async ({ page }) => {
  const diagnostics = observePage(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const measurements = [];

  for (const viewport of [
    { width: 320, height: 480, inset: true },
    { width: 1280, height: 800, inset: false }
  ] as const) {
    await page.setViewportSize(viewport);
    await page.goto("/pairing-access.html?view=access&state=long-origin");
    if (viewport.inset) {
      await page.evaluate(() => {
        document.documentElement.style.setProperty("--hostdeck-safe-area-bottom", "24px");
      });
    }
    await page.getByRole("button", { name: "Open Host and access" }).click();
    const dialog = page.getByRole("dialog", { name: "Host & access" });
    await expect(dialog.getByRole("heading", { name: "Secure control ready" })).toBeVisible();
    await expectNoHorizontalOverflow(page, viewport.width);
    measurements.push(await measureHostSheet(page));
    await capture(page, `host-access-long-${viewport.width}x${viewport.height}.png`);
    if (viewport.width === 320) {
      const body = page.locator(".hostdeck-host-access-sheet > .hostdeck-sheet__body");
      const headerBefore = await page.locator(".hostdeck-host-access-sheet > .hostdeck-sheet__header")
        .boundingBox();
      await body.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(page.getByRole("button", { name: "Close Host and access" })).toBeVisible();
      expect(await page.locator(".hostdeck-host-access-sheet > .hostdeck-sheet__header")
        .boundingBox()).toEqual(headerBefore);
      await capture(page, "host-access-long-scrolled-320x480.png");
    }
  }

  await writeEvidence("pairing-host-access-layout.json", { measurements });
  await expectCleanBrowser(page, diagnostics);
});

async function measurePairing(page: Page, inset: boolean) {
  const measurement = await page.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (element === null) throw new TypeError(`Pairing layout target is missing: ${selector}`);
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
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      document: {
        clientWidth: document.documentElement.clientWidth,
        scrollHeight: document.documentElement.scrollHeight,
        scrollWidth: document.documentElement.scrollWidth
      },
      appBar: box(".hostdeck-app-bar"),
      main: box(".hostdeck-pairing")
    };
  });
  expect(measurement.document.scrollWidth).toBe(measurement.document.clientWidth);
  expect(measurement.main.left).toBeGreaterThanOrEqual(0);
  expect(measurement.main.right).toBeLessThanOrEqual(measurement.viewport.width);
  expect(measurement.appBar.bottom).toBe(measurement.main.top);
  expect(measurement.appBar.height).toBe(inset ? 88 : 56);
  return measurement;
}

async function measureHostSheet(page: Page) {
  const measurement = await page.evaluate(() => {
    const required = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (element === null) throw new TypeError(`Host sheet target is missing: ${selector}`);
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
    const dialog = required(".hostdeck-host-access-sheet");
    const header = required(".hostdeck-host-access-sheet > .hostdeck-sheet__header");
    const body = required(".hostdeck-host-access-sheet > .hostdeck-sheet__body");
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      dialog: box(dialog),
      header: box(header),
      body: {
        ...box(body),
        clientHeight: body.clientHeight,
        overflowY: getComputedStyle(body).overflowY,
        scrollHeight: body.scrollHeight
      }
    };
  });
  expect(measurement.dialog.left).toBeGreaterThanOrEqual(0);
  expect(measurement.dialog.right).toBeLessThanOrEqual(measurement.viewport.width + 1);
  expect(measurement.dialog.top).toBeGreaterThanOrEqual(0);
  expect(measurement.dialog.bottom).toBeLessThanOrEqual(measurement.viewport.height + 1);
  expect(measurement.header.bottom).toBeLessThanOrEqual(measurement.body.top);
  expect(measurement.body.bottom).toBeLessThanOrEqual(measurement.dialog.bottom);
  expect(measurement.body.overflowY).toBe("auto");
  expect(measurement.body.scrollHeight).toBeGreaterThan(measurement.body.clientHeight);
  return measurement;
}

async function expectNoHorizontalOverflow(page: Page, width: number): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    })))
    .toEqual({ clientWidth: width, scrollWidth: width });
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
    if (new URL(request.url()).origin !== "http://127.0.0.1:4179") {
      externalRequests.push(request.url());
    }
  });
  return { consoleErrors, externalRequests, pageErrors };
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
    localStorage: localStorage.length,
    sessionStorage: sessionStorage.length
  }));
  expect(privacy.body).not.toMatch(/#pair=|csrf_token|device_pairing_access_fixture|source_hash/iu);
  expect(privacy.localStorage).toBe(0);
  expect(privacy.sessionStorage).toBe(0);
}

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
