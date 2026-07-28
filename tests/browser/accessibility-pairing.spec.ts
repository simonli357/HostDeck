import { expect, test } from "@playwright/test";
import {
  expectAxeClean,
  expectCoreTargets,
  expectDialogFocusCycle,
  expectFocusInViewport,
  expectLiveRegionContract,
  expectNoHorizontalOverflow,
  expectPageSemantics,
  expectReducedMotion,
  expectThemeContrastContract,
  expectValidDefinitionLists
} from "./accessibility-assertions.js";

const pairingStates = [
  ["claiming", "Pairing this phone"],
  ["paired", "Phone paired"],
  ["link_not_accepted", "Pairing link was not accepted"],
  ["claim_unknown", "Pairing outcome is unknown"],
  ["paired_csrf_unavailable", "Phone paired, secure access incomplete"]
] as const;

test.describe.configure({ timeout: 90_000 });

test("audits all bounded pairing results and progress semantics", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [state, heading] of pairingStates) {
    await page.goto(`/pairing-access.html?view=pairing&state=${state}`);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expectPageSemantics(page, "Pair a phone | HostDeck");
    await expectValidDefinitionLists(page);
    await expectLiveRegionContract(page);
    await expectNoHorizontalOverflow(page);
    await expectReducedMotion(page);
    await expectThemeContrastContract(page);
    await expect(page.getByRole("list", { name: "Pairing progress" })).toBeVisible();
    await expect(page.locator('[aria-current="step"]')).toHaveCount(1);
    await expectAxeClean(page, `pairing state ${state}`);
  }
});

test("audits pairing skip navigation, action focus, targets, and 320 reflow", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/pairing-access.html?view=pairing&state=paired");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await skip.focus();
  await expect(skip).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
  await expectFocusInViewport(page);
  await expectCoreTargets(page);
  await expectNoHorizontalOverflow(page);

  const action = page.getByRole("button", { name: "Open Mission Control" });
  await action.focus();
  await expectFocusInViewport(page);
  await page.keyboard.press("Space");
  await expect(action).toBeFocused();
});

test("audits all Host and access fixture states and modal focus", async ({ page }) => {
  const states = [
    "unpaired",
    "read-only",
    "writer",
    "locked",
    "stale",
    "reconnecting",
    "long-origin"
  ] as const;
  await page.setViewportSize({ width: 390, height: 844 });
  for (const state of states) {
    await page.goto(`/pairing-access.html?view=access&state=${state}`);
    await expectPageSemantics(page, "Mission Control | HostDeck");
    const trigger = page.getByRole("button", { name: "Open Host and access" });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Host & access" });
    await expect(dialog).toBeVisible();
    await expectValidDefinitionLists(page);
    await expectLiveRegionContract(page);
    await expectAxeClean(page, `Host and access fixture ${state}`);
    if (state === "writer") await expectDialogFocusCycle(page, dialog);
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  }
});
