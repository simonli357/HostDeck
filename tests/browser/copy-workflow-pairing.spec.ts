import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const artifactDirectory = resolve("artifacts/fe-v1-018-copy-workflow-review");
const visualReviewTime = new Date("2026-07-28T14:00:00.000Z");
const evidence: PairingEvidence[] = [];

interface PairingEvidence {
  readonly state: string;
  readonly file: string;
  readonly viewport: Readonly<{ width: number; height: number }>;
  readonly rail: Readonly<{
    top: number;
    right: number;
    bottom: number;
    left: number;
    width: number;
    height: number;
  }>;
}

test.beforeAll(async () => {
  await mkdir(artifactDirectory, { recursive: true });
});

test.afterAll(async () => {
  await writeFile(
    resolve(artifactDirectory, "pairing-review-measurements.json"),
    `${JSON.stringify({ fixed_time: visualReviewTime.toISOString(), evidence }, null, 2)}\n`,
    "utf8"
  );
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(visualReviewTime);
  await page.setViewportSize({ width: 390, height: 844 });
});

test("captures fragment-safe pairing entry, success, and uncertain outcome", async ({ page }) => {
  const diagnostics = observePage(page);
  for (const [state, heading, file] of [
    ["claiming", "Pairing this phone", "pairing-claiming-390x844.png"],
    ["paired", "Phone paired", "pairing-paired-390x844.png"],
    ["claim_unknown", "Pairing outcome is unknown", "pairing-unknown-390x844.png"]
  ] as const) {
    await page.goto(`/pairing-access.html?view=pairing&state=${state}`);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(page.getByRole("list", { name: "Pairing progress" })).toBeVisible();
    await expect(page).not.toHaveURL(/#pair=/u);
    await capture(page, state, file);
  }
  expect(diagnostics).toEqual({ consoleErrors: [], externalRequests: [], pageErrors: [] });
});

async function capture(page: Page, state: string, file: string): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const measurement = await page.evaluate(() => {
    const rail = document.querySelector(".hostdeck-pairing-rail");
    if (!(rail instanceof HTMLElement)) throw new TypeError("Pairing rail is unavailable.");
    const rect = rail.getBoundingClientRect();
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      document: {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth
      },
      rail: {
        top: Math.round(rect.top),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };
  });
  expect(measurement.document.scrollWidth).toBe(measurement.document.clientWidth);
  expect(measurement.rail.left).toBeGreaterThanOrEqual(0);
  expect(measurement.rail.right).toBeLessThanOrEqual(measurement.viewport.width);
  const body = await page.locator("body").innerText();
  expect(body).not.toMatch(/#pair=|csrf[_ -]?token|cookie|custom CA|certificate/iu);
  evidence.push({ state, file, viewport: measurement.viewport, rail: measurement.rail });
  await page.screenshot({
    path: resolve(artifactDirectory, file),
    animations: "disabled",
    caret: "hide"
  });
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
