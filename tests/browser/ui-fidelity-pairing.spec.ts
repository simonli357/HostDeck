import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const artifactDirectory = requiredArtifactDirectory();
const visualReviewTime = new Date("2026-07-22T20:00:00.000Z");
const measurements: Record<string, unknown>[] = [];

test.beforeAll(async () => {
  await mkdir(artifactDirectory, { recursive: true });
});

test.afterAll(async () => {
  await writeFile(
    resolve(artifactDirectory, "pairing-measurements.json"),
    `${JSON.stringify({ fixed_time: visualReviewTime.toISOString(), measurements }, null, 2)}\n`,
    "utf8"
  );
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(visualReviewTime);
});

test("captures fragment-safe claiming and paired confirmation rails", async ({ page }) => {
  const diagnostics = observePage(page);
  for (const [state, heading] of [
    ["claiming", "Pairing this phone"],
    ["paired", "Phone paired"]
  ] as const) {
    await page.goto(`/pairing-access.html?view=pairing&state=${state}`);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(page.getByRole("list", { name: "Pairing progress" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    measurements.push({ id: `pairing-${state}`, ...(await measurePairing(page)) });
    await capture(page, `pairing-${state}-390x844.png`);
  }
  expect(diagnostics).toEqual({ consoleErrors: [], externalRequests: [], pageErrors: [] });
});

test("captures locked read-only access with no remote unlock", async ({ page }) => {
  const diagnostics = observePage(page);
  await page.goto("/pairing-access.html?view=access&state=locked");
  await page.getByRole("button", { name: "Open Host and access" }).click();
  const dialog = page.getByRole("dialog", { name: "Host & access" });
  await expect(dialog.getByRole("heading", { name: "Remote writes are locked" })).toBeVisible();
  await expect(
    dialog.getByText("Session monitoring remains available. Unlocking requires the laptop.", {
      exact: true
    })
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: /unlock/iu })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  measurements.push({ id: "access-locked", ...(await measureDialog(page)) });
  await capture(page, "access-locked-390x844.png");
  expect(diagnostics).toEqual({ consoleErrors: [], externalRequests: [], pageErrors: [] });
});

function requiredArtifactDirectory(): string {
  const value = process.env.HOSTDECK_FIDELITY_ARTIFACT_DIR;
  if (value === undefined || value.length === 0 || !value.startsWith("/")) {
    throw new TypeError("HOSTDECK_FIDELITY_ARTIFACT_DIR must be an absolute path.");
  }
  return value;
}

function observePage(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const externalRequests: string[] = [];
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

async function capture(page: Page, name: string): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.screenshot({
    path: resolve(artifactDirectory, name),
    animations: "disabled",
    caret: "hide"
  });
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

async function measurePairing(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const rectangle = (element: Element) => {
      const value = element.getBoundingClientRect();
      return {
        bottom: Math.round(value.bottom),
        height: Math.round(value.height),
        left: Math.round(value.left),
        right: Math.round(value.right),
        top: Math.round(value.top),
        width: Math.round(value.width)
      };
    };
    const documentDimensions = () => ({
      clientHeight: document.documentElement.clientHeight,
      clientWidth: document.documentElement.clientWidth,
      scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth
    });
    const rail = document.querySelector<HTMLElement>(".hostdeck-pairing-rail");
    const result = document.querySelector<HTMLElement>(".hostdeck-pairing-result");
    if (rail === null || result === null) throw new TypeError("Pairing fidelity target missing.");
    return {
      rail: rectangle(rail),
      result: rectangle(result),
      document: documentDimensions()
    };
  });
}

async function measureDialog(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const rectangle = (element: Element) => {
      const value = element.getBoundingClientRect();
      return {
        bottom: Math.round(value.bottom),
        height: Math.round(value.height),
        left: Math.round(value.left),
        right: Math.round(value.right),
        top: Math.round(value.top),
        width: Math.round(value.width)
      };
    };
    const documentDimensions = () => ({
      clientHeight: document.documentElement.clientHeight,
      clientWidth: document.documentElement.clientWidth,
      scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth
    });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    if (dialog === null) throw new TypeError("Access fidelity dialog missing.");
    return { dialog: rectangle(dialog), document: documentDimensions() };
  });
}
