import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";

const artifactDirectory = resolve("artifacts/fe-v1-013-pairing-host-access");
const pairingStates = [
  ["claiming", "Pairing this phone"],
  ["paired", "Phone paired"],
  ["link_not_accepted", "Pairing link was not accepted"],
  ["claim_unknown", "Pairing outcome is unknown"],
  ["paired_csrf_unavailable", "Phone paired, secure access incomplete"]
] as const;
const accessStates = [
  ["unpaired", "Pairing required"],
  ["read-only", "Read-only access"],
  ["writer", "Secure control ready"],
  ["locked", "Remote writes are locked"],
  ["stale", "Access state is stale"],
  ["reconnecting", "Secure control ready"],
  ["long-origin", "Secure control ready"]
] as const;
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

test("captures every bounded pairing outcome without secret or retry drift", async ({ page }) => {
  const diagnostics = observePage(page);
  await page.setViewportSize({ width: 390, height: 844 });

  for (const [state, title] of pairingStates) {
    await page.goto(`/pairing-access.html?view=pairing&state=${state}`);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(page.getByRole("list", { name: "Pairing progress" })).toBeVisible();
    await expectNoHorizontalOverflow(page, 390);
    await expectPairingActions(page, state);
    await expectPrivateTextAbsent(page);
    await page.screenshot({
      path: resolve(artifactDirectory, `pairing-${state}-390x844.png`),
      animations: "disabled"
    });
  }

  await expectCleanBrowser(page, diagnostics);
});

test("captures typed Host and access states in the production sheet", async ({ page }) => {
  const diagnostics = observePage(page);
  await page.setViewportSize({ width: 390, height: 844 });

  for (const [state, title] of accessStates) {
    await page.goto(`/pairing-access.html?view=access&state=${state}`);
    const trigger = page.getByRole("button", { name: "Open Host and access" });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Host & access" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: title })).toBeVisible();
    await expectNoHorizontalOverflow(page, 390);
    await expectNoClippedText(
      dialog.locator("dt, dd, small, h2, p:not(.hostdeck-visually-hidden)")
    );
    await expectPrivateTextAbsent(page);
    if (state === "reconnecting") {
      await dialog.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(dialog.getByText("Reconnecting", { exact: true })).toBeVisible();
      await expect(dialog.getByText("History boundary visible", { exact: true })).toBeVisible();
    }
    await page.screenshot({
      path: resolve(artifactDirectory, `access-${state}-390x844.png`),
      animations: "disabled"
    });
  }

  await expectCleanBrowser(page, diagnostics);
});

test("passes reference widths, 320 reflow, 200 percent zoom, focus, motion, and contrast", async ({
  page
}) => {
  const diagnostics = observePage(page);
  await page.emulateMedia({ reducedMotion: "reduce" });

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto("/pairing-access.html?view=pairing&state=paired");
    await expectNoHorizontalOverflow(page, viewport.width);
    await expectStableAction(page.getByRole("button", { name: "Open Mission Control" }));
    await page.screenshot({
      path: resolve(
        artifactDirectory,
        `pairing-paired-${viewport.width}x${viewport.height}.png`
      ),
      animations: "disabled"
    });
  }

  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/pairing-access.html?view=access&state=long-origin");
  await page.getByRole("button", { name: "Open Host and access" }).click();
  const dialog = page.getByRole("dialog", { name: "Host & access" });
  await expectNoHorizontalOverflow(page, 320);
  await expectNoClippedText(
    dialog.locator("dt, dd, small, h2, p:not(.hostdeck-visually-hidden)")
  );
  await expectStableAction(page.getByRole("button", { name: "Close Host and access" }));
  await page.screenshot({
    path: resolve(artifactDirectory, "access-long-origin-reflow-320x800.png"),
    animations: "disabled",
    fullPage: true
  });

  await page.keyboard.press("Escape");
  const trigger = page.getByRole("button", { name: "Open Host and access" });
  await expect(trigger).toBeFocused();
  await expectVisibleFocus(trigger);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(trigger).toBeFocused();

  await page.goto("/pairing-access.html?view=pairing&state=claiming");
  const spinnerAnimations = await page.locator(".hostdeck-spin").evaluateAll(
    (elements) => elements.map((element) => getComputedStyle(element).animationName)
  );
  expect(spinnerAnimations).toEqual(["none", "none"]);
  await expectTokenContrast(page);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/pairing-access.html?view=pairing&state=paired");
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  await expectNoDocumentOverflow(page);
  await page.screenshot({
    path: resolve(artifactDirectory, "pairing-paired-zoom-200-1280x800.png"),
    animations: "disabled"
  });

  await expectCleanBrowser(page, diagnostics);
});

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

async function expectPairingActions(page: Page, state: string): Promise<void> {
  const buttons = page.getByRole("button");
  if (state === "paired") {
    await expect(buttons).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Open Mission Control" })).toBeVisible();
    return;
  }
  if (state === "claim_unknown" || state === "paired_csrf_unavailable") {
    await expect(buttons).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Reload to check" })).toBeVisible();
    return;
  }
  await expect(buttons).toHaveCount(0);
}

async function expectPrivateTextAbsent(page: Page): Promise<void> {
  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/#pair=|csrf_token|device_pairing_access_fixture|source_hash|cookie/iu);
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

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth
    ))
    .toBe(true);
}

async function expectNoClippedText(locator: Locator): Promise<void> {
  const clipped = await locator.evaluateAll((elements) =>
    elements.flatMap((element) => {
      if (
        element.scrollWidth <= element.clientWidth &&
        element.scrollHeight <= element.clientHeight
      ) {
        return [];
      }
      return [{
        tag: element.tagName,
        text: element.textContent,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight
      }];
    })
  );
  expect(clipped).toEqual([]);
}

async function expectStableAction(locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
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
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function luminance(color: string): number {
  const match = /^#([0-9a-f]{6})$/iu.exec(color);
  if (match === null) throw new TypeError(`Unsupported contrast color: ${color}`);
  const value = match[1] as string;
  const channels = [0, 2, 4].map((offset) =>
    Number.parseInt(value.slice(offset, offset + 2), 16) / 255
  );
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  );
  return (red ?? 0) * 0.2126 + (green ?? 0) * 0.7152 + (blue ?? 0) * 0.0722;
}

async function expectCleanBrowser(
  page: Page,
  diagnostics: ReturnType<typeof observePage>
): Promise<void> {
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
  expect(diagnostics.externalRequests).toEqual([]);
  await expect
    .poll(() => page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })))
    .toEqual({ local: 0, session: 0 });
}
