import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  expectAxeClean,
  expectCoreTargets,
  expectDialogFocusCycle,
  expectDisabledContrastPolicy,
  expectFocusInViewport,
  expectLiveRegionContract,
  expectNoHorizontalOverflow,
  expectPageSemantics,
  expectReducedMotion,
  expectThemeContrastContract,
  expectValidDefinitionLists
} from "./accessibility-assertions.js";
import {
  broadApprovalRequestEvent,
  installApprovalDecisionsApi,
} from "./approval-decisions-fixture.js";
import { installArchiveApi } from "./archive-control-fixture.js";
import { installEventDiagnosticsApi } from "./event-diagnostics-fixture.js";
import { installGoalControlApi } from "./goal-control-fixture.js";
import { openHostAccess } from "./host-access-navigation.js";
import { installHostLockApi } from "./host-lock-fixture.js";
import {
  installInterruptApi,
  interruptBrowserTurnId
} from "./interrupt-control-fixture.js";
import { installLaptopResumeApi } from "./laptop-resume-control-fixture.js";
import { installMissionControlApi } from "./mission-control-fixture.js";
import { installModelControlApi } from "./model-control-fixture.js";
import {
  installPairedDeviceManagementApi,
  pairedDevice,
  pairedDeviceCurrentId
} from "./paired-device-management-fixture.js";
import { installPlanControlApi } from "./plan-control-fixture.js";
import {
  installSessionDetailApi,
  liveActivityEvent,
  promptTurnEvent,
  sessionDetailBrowserSessionId
} from "./session-detail-fixture.js";
import { installSkillsControlApi } from "./skills-control-fixture.js";

const detailPath = `/sessions/${sessionDetailBrowserSessionId}`;
const artifactDirectory = resolve("artifacts/fe-v1-039-semantic-accessibility-hardening");
const visualReviewTime = new Date("2026-07-27T20:00:00.000Z");
const approvalReviewTime = new Date("2026-07-22T22:00:00.000Z");

test.describe.configure({ timeout: 90_000 });

test.beforeAll(async () => {
  await mkdir(artifactDirectory, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(visualReviewTime);
});

test("audits Mission, route focus, retained detail, and error recovery", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installSessionDetailApi(page, "writable");
  await installMissionControlApi(page, "responsive", { fallbackUnhandled: true });
  await page.goto("/");

  await expect(page.locator("body")).toContainText("android-release");
  await expectPageSemantics(page, "Mission Control | HostDeck");
  await expectValidDefinitionLists(page);
  await expectLiveRegionContract(page);
  await expectCoreTargets(page);
  await expectThemeContrastContract(page);
  await expectAxeClean(page, "Mission Control");

  const skip = page.getByRole("link", { name: "Skip to content" });
  await skip.focus();
  await expect(skip).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
  await expectFocusInViewport(page);
  await page.evaluate(() => window.history.replaceState(window.history.state, "", "/"));

  const sourceRow = page.getByRole("link", { name: /^android-release/u });
  await sourceRow.focus();
  await expectFocusInViewport(page);
  await capture(page, "mission-row-focus-390x844.png");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`${detailPath}$`, "u"));
  await expect(page.getByRole("main")).toBeFocused();
  await expectPageSemantics(page, "Session Detail | HostDeck");
  await expectAxeClean(page, "Session Detail after Mission navigation");

  await page.goBack();
  await expect(page).toHaveURL(/\/$/u);
  await expect(sourceRow).toBeFocused();

  await page.setViewportSize({ width: 1280, height: 800 });
  await sourceRow.click();
  await expect(page.getByRole("navigation", { name: "Mission Control sessions" })).toBeVisible();
  await expectPageSemantics(page, "Session Detail | HostDeck");
  await expectNoHorizontalOverflow(page);
  await expectAxeClean(page, "retained desktop Session Detail");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/not-a-hostdeck-route");
  await expectPageSemantics(page, "Page not found | HostDeck");
  await expectAxeClean(page, "not-found route");
  const recovery = page.getByRole("link", { name: "Mission Control" });
  await recovery.focus();
  await expectFocusInViewport(page);
  await capture(page, "not-found-focus-390x844.png");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/$/u);
  await expect(page.getByRole("main")).toBeFocused();
});

test("audits detail timeline, fixed controls, and live regions", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await installSessionDetailApi(page, "writable");
  await page.goto(detailPath);

  await expect(page.getByRole("textbox", { name: "Prompt for android-release" })).toBeVisible();
  await expectPageSemantics(page, "Session Detail | HostDeck");
  await expectValidDefinitionLists(page);
  await expectLiveRegionContract(page);
  await expectCoreTargets(page);
  await expectDisabledContrastPolicy(page);
  await expectNoHorizontalOverflow(page);
  await expect(page.locator(".hostdeck-detail-timeline__list[aria-live]")).toHaveCount(0);
  const dock = page.locator("fieldset.hostdeck-primary-action-dock");
  await expect(dock).not.toHaveAttribute("role", "toolbar");
  await expect(dock.locator("legend")).toHaveText("Session controls");
  await expectAxeClean(page, "detail timeline and fixed controls");
});

test("audits the inline approval card", async ({ page }) => {
  await page.clock.setFixedTime(approvalReviewTime);
  await installApprovalDecisionsApi(page, { snapshotVariant: "elevated" });
  await page.goto(detailPath);
  const approval = page.locator(".hostdeck-approval-item");
  await expect(approval.getByRole("button", { name: "Review & approve" })).toBeVisible();
  await approval.evaluate((element) => {
    const appBar = document.querySelector(".hostdeck-app-bar");
    if (!(appBar instanceof HTMLElement)) {
      throw new TypeError("HostDeck app bar is unavailable.");
    }
    window.scrollBy(0, element.getBoundingClientRect().top - appBar.getBoundingClientRect().bottom - 8);
  });
  const appBarBox = await page.locator(".hostdeck-app-bar").boundingBox();
  const approvalBox = await approval.boundingBox();
  expect(appBarBox).not.toBeNull();
  expect(approvalBox).not.toBeNull();
  expect(approvalBox?.y ?? 0).toBeGreaterThanOrEqual(
    (appBarBox?.y ?? 0) + (appBarBox?.height ?? 0) + 7
  );
  await expectLiveRegionContract(page);
  await expectAxeClean(page, "inline approval card");
});

test("announces each newly actionable approval once after baseline", async ({ page }) => {
  await page.clock.setFixedTime(approvalReviewTime);
  const api = await installApprovalDecisionsApi(page, { snapshotVariant: "normal" });
  await page.goto(detailPath);
  await expect(page.getByRole("heading", { name: "Approval required" }).first()).toBeVisible();

  const approvalUpdates = page.locator("#hostdeck-approval-updates");
  await expect(approvalUpdates).toHaveText("");
  await expect.poll(() => api.approvalReadRequests().length).toBeGreaterThanOrEqual(1);
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  await installLiveMutationRecorder(page, "#hostdeck-approval-updates");

  api.setSnapshotVariant("multiple");
  await api.session.pushEvent(broadApprovalRequestEvent(10));
  await expect.poll(() => api.approvalReadRequests().length).toBeGreaterThanOrEqual(2);
  await expect.poll(() => readLiveMutationRecords(page)).toContain(
    "Approval required for android-release: Publish the signed Android validation package. Broad risk."
  );

  await page.getByRole("button", { name: "Refresh session" }).click();
  await expect.poll(() => api.approvalReadRequests().length).toBeGreaterThanOrEqual(3);
  expect(await readLiveMutationRecords(page, true)).toEqual([
    "Approval required for android-release: Publish the signed Android validation package. Broad risk."
  ]);
  await expect(page.locator(".hostdeck-detail-timeline[aria-live]")).toHaveCount(0);
});

test("announces only increasing unpinned activity counts", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 480 });
  const api = await installSessionDetailApi(page, "long");
  await page.goto(detailPath);
  await expect(page.getByText("Current", { exact: true })).toBeVisible();
  await expect.poll(async () => (await api.streamRequestUrls()).length).toBe(1);
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  const activityUpdates = page.locator("#hostdeck-activity-updates");
  await expect(activityUpdates).toHaveText("");
  await installLiveMutationRecorder(page, "#hostdeck-activity-updates");

  await page.evaluate(() => {
    window.scrollTo(0, 0);
    window.dispatchEvent(new Event("scroll"));
  });
  const unpinnedGeometry = await page.evaluate(() => {
    const end = document.querySelector<HTMLElement>(".hostdeck-detail-timeline__end");
    if (end === null) throw new TypeError("Timeline end marker is missing.");
    return {
      endTop: end.getBoundingClientRect().top,
      innerHeight: window.innerHeight,
      scrollHeight: document.documentElement.scrollHeight,
      scrollY: window.scrollY
    };
  });
  expect(unpinnedGeometry.endTop).toBeGreaterThan(unpinnedGeometry.innerHeight + 80);
  await api.pushEvent(liveActivityEvent(5));
  await expect(activityUpdates).toHaveText("1 new event.");
  await api.pushEvent(liveActivityEvent(6));
  await expect(activityUpdates).toHaveText("2 new events.");

  expect(await readLiveMutationRecords(page, true)).toEqual(["1 new event.", "2 new events."]);
  await expect(page.locator(".hostdeck-detail-timeline[aria-live]")).toHaveCount(0);
  await page.getByRole("button", { name: "2 new events" }).click();
  await expect(activityUpdates).toHaveText("");
});

test("audits approval confirmation focus and restoration", async ({ page }) => {
  await page.clock.setFixedTime(approvalReviewTime);
  await installApprovalDecisionsApi(page, { snapshotVariant: "elevated" });
  await page.goto(detailPath);
  const trigger = page.getByRole("button", { name: "Review & approve" });
  await expect(trigger).toBeVisible();
  await trigger.focus();
  await page.keyboard.press("Enter");
  const confirmation = page.getByRole("dialog", { name: "Approve elevated request?" });
  await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expectDialogFocusCycle(page, confirmation);
  await expectAxeClean(page, "approval confirmation");
  await capture(page, "approval-confirmation-focus-390x844.png");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expectFocusInViewport(page);
});

test("audits the primary model sheet", async ({ page }) => {
  await installModelControlApi(page);
  await page.goto(detailPath);
  const modelTrigger = page.getByRole("button", { name: "/model for android-release" });
  await modelTrigger.click();
  const dialog = page.getByRole("dialog", { name: "/model" });
  await expect(dialog.getByText("Model control ready", { exact: true })).toBeVisible();
  await expectDialogFocusCycle(page, dialog);
  await expectAxeClean(page, "model sheet");
  await page.keyboard.press("Escape");
  await expect(modelTrigger).toBeFocused();
});

test("audits the primary goal sheet and confirmation", async ({ page }) => {
  await installGoalControlApi(page, { snapshotVariant: "paused" });
  await page.goto(detailPath);
  const goalTrigger = page.getByRole("button", { name: "/goal for android-release" });
  await goalTrigger.click();
  const dialog = page.getByRole("dialog", { name: "/goal" });
  await expect(dialog.getByText("Paused", { exact: true }).first()).toBeVisible();
  await expectAxeClean(page, "goal sheet");
  await dialog.getByRole("button", { name: "Resume" }).click();
  await expect(dialog.getByRole("alert", { name: "Resume agentic goal?" })).toBeVisible();
  await expectAxeClean(page, "goal resume confirmation");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.keyboard.press("Escape");
  await expect(goalTrigger).toBeFocused();
});

test("audits the primary Plan sheet", async ({ page }) => {
  await installPlanControlApi(page);
  await page.goto(detailPath);
  const planTrigger = page.getByRole("button", { name: "/plan for android-release" });
  await planTrigger.click();
  const dialog = page.getByRole("dialog", { name: "/plan" });
  await expect(dialog.getByRole("radio", { name: /Default/u })).toBeChecked();
  await expectAxeClean(page, "Plan sheet");
  await page.keyboard.press("Escape");
  await expect(planTrigger).toBeFocused();
});

test("audits utility menu, Usage, Compact confirmation, and Skills search", async ({ page }) => {
  await installSkillsControlApi(page);
  await page.goto(detailPath);
  const more = page.getByRole("button", {
    name: "More session utilities for android-release"
  });
  await more.focus();
  await page.keyboard.press("Enter");
  const utilities = page.getByRole("dialog", { name: "Session utilities" });
  await expectAxeClean(page, "utility menu");

  await utilities.getByRole("button", { name: /usage/iu }).click();
  let dialog = page.getByRole("dialog", { name: "/usage" });
  await expect(dialog.getByText("Usage capture current", { exact: true })).toBeVisible();
  await expectValidDefinitionLists(page);
  await expectAxeClean(page, "Usage sheet");
  await dialog.getByRole("button", { name: "Back to session utilities" }).click();

  await utilities.getByRole("button", { name: /compact/iu }).click();
  dialog = page.getByRole("dialog", { name: "/compact" });
  await expect(dialog.getByText("Confirmation required", { exact: true })).toBeVisible();
  await expectAxeClean(page, "Compact sheet");
  await dialog.getByRole("button", { name: "Compact context" }).click();
  await expect(dialog.getByRole("heading", { name: "Confirm context compaction" })).toBeFocused();
  await expectAxeClean(page, "Compact confirmation");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.getByRole("button", { name: "Back to session utilities" }).click();

  await utilities.getByRole("button", { name: /skills/iu }).click();
  dialog = page.getByRole("dialog", { name: "/skills" });
  await expect(dialog.getByText("Skills capture current", { exact: true })).toBeVisible();
  const search = dialog.getByRole("searchbox", { name: "Search skills" });
  await search.fill("android");
  await expect(dialog.locator('[id$="-skills-status-results"]')).toContainText(/matching/u);
  await expectAxeClean(page, "Skills sheet and search result");
  await expectCoreTargets(page);
  await page.keyboard.press("Escape");
  await expect(more).toBeFocused();
});

test("audits event diagnostic details", async ({ page }) => {
  await installEventDiagnosticsApi(page);
  await page.goto(detailPath);
  const eventTrigger = page.getByRole("button", { name: "View event details" }).first();
  await eventTrigger.click();
  const dialog = page.getByRole("dialog", { name: "Event details" });
  await expect(dialog.getByText("Event details current", { exact: true })).toBeVisible();
  await expectAxeClean(page, "event diagnostic sheet");
  await page.keyboard.press("Escape");
  await expect(eventTrigger).toBeFocused();
});

test("audits the Session actions menu and interrupt confirmation", async ({ page }) => {
  const events = [promptTurnEvent(1, "in_progress", interruptBrowserTurnId)];
  await installSessionDetailApi(page, "writable", {
    initialEvents: events,
    streamEvents: events,
    turnState: "in_progress"
  });
  await installInterruptApi(page);
  await page.goto(detailPath);
  const actionsTrigger = page.getByRole("button", { name: "Open session actions" });
  await actionsTrigger.click();
  const actions = page.getByRole("dialog", { name: "Session actions", exact: true });
  await expect(actions.getByRole("button", { name: /Interrupt active turn/iu })).toBeEnabled();
  await expectAxeClean(page, "Session actions menu");
  await actions.getByRole("button", { name: /Interrupt active turn/iu }).click();
  const dialog = page.getByRole("dialog", { name: "Interrupt active turn?", exact: true });
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expectAxeClean(page, "interrupt confirmation");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.keyboard.press("Escape");
  await expect(actionsTrigger).toBeFocused();
});

test("audits the archive confirmation", async ({ page }) => {
  await installSessionDetailApi(page, "writable", {
    initialEvents: [],
    streamEvents: [],
    turnState: "idle"
  });
  await installArchiveApi(page);
  await page.goto(detailPath);
  await page.getByRole("button", { name: "Open session actions" }).click();
  const actions = page.getByRole("dialog", { name: "Session actions", exact: true });
  await expect(actions.getByRole("button", { name: /Archive session/iu })).toBeEnabled();
  await actions.getByRole("button", { name: /Archive session/iu }).click();
  const dialog = page.getByRole("dialog", { name: "Archive session?", exact: true });
  await expect(dialog).toBeVisible();
  await expectAxeClean(page, "archive confirmation");
});

test("audits laptop resume and nested Host access", async ({ page }) => {
  await page.addInitScript(() => {
    const clipboard = Object.freeze({ writeText: async () => undefined });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: clipboard
    });
  });
  await installSessionDetailApi(page, "writable", {
    initialEvents: [],
    streamEvents: [],
    turnState: "idle"
  });
  await installLaptopResumeApi(page);
  await page.goto(detailPath);
  const actionsTrigger = page.getByRole("button", { name: "Open session actions" });
  await actionsTrigger.click();
  let dialog = page.getByRole("dialog", { name: "Session actions", exact: true });
  await dialog.getByRole("button", { name: /Resume on laptop/iu }).click();
  dialog = page.getByRole("dialog", { name: "Resume on laptop", exact: true });
  await expect(dialog.getByText("Exact laptop command ready", { exact: true })).toBeVisible();
  await expectAxeClean(page, "laptop resume sheet");
  await dialog.getByRole("button", { name: "Back to session actions" }).click();
  dialog = page.getByRole("dialog", { name: "Session actions", exact: true });
  await dialog.getByRole("button", { name: "Open Host and access" }).click();
  dialog = page.getByRole("dialog", { name: "Host & access" });
  await expectValidDefinitionLists(page);
  await expectAxeClean(page, "nested Host and access sheet");
});

test("audits Host access, lock, devices, and revoke confirmation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installMissionControlApi(page, "long");
  await installPairedDeviceManagementApi(page, {
    pages: [[
      pairedDevice(pairedDeviceCurrentId, "Xiaomi 15 Pro", "write"),
      pairedDevice("device_office_browser", "Office browser", "read")
    ]]
  });
  await installHostLockApi(page);
  await page.goto("/");
  const dialog = await openHostAccess(page);
  await expect(dialog.getByText("Office browser", { exact: true })).toBeVisible();
  await expectValidDefinitionLists(page);
  await expectLiveRegionContract(page);
  await expectAxeClean(page, "Host and access with devices");

  const lock = dialog.getByRole("button", { name: "Lock writes" });
  await lock.click();
  let confirmation = page.getByRole("dialog", { name: "Lock remote writes?" });
  await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expectAxeClean(page, "host lock confirmation");
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(lock).toBeFocused();

  const revoke = dialog.getByRole("button", { name: "Revoke Office browser, Device 2" });
  await revoke.click();
  confirmation = page.getByRole("dialog", { name: "Revoke paired device?" });
  await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expectAxeClean(page, "paired-device revoke confirmation");
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(revoke).toBeFocused();
  await expectReducedMotion(page);
});

test("audits reduced-motion loading and 320 reflow without focus clipping", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 480 });
  const api = await installModelControlApi(page);
  api.setReadOutcome("pending");
  await page.goto(detailPath);
  const trigger = page.getByRole("button", { name: "/model for android-release" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "/model" });
  await expect(dialog.getByText("Loading models", { exact: true })).toBeVisible();
  await expectReducedMotion(page);
  await expectNoHorizontalOverflow(page);
  await expectDisabledContrastPolicy(page);
  const status = dialog.getByRole("status");
  await status.scrollIntoViewIfNeeded();
  expect(await isContainedBy(status, dialog)).toBe(true);
  const close = dialog.getByRole("button", { name: "Close model control" });
  await close.focus();
  await expect(close).toBeFocused();
  await expectFocusInViewport(page);
  await expectAxeClean(page, "reduced-motion short-height loading sheet");
  await capture(page, "model-loading-focus-320x480.png");
  api.releaseModelRead();
});

async function capture(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: resolve(artifactDirectory, name),
    animations: "disabled",
    fullPage: false
  });
}

async function isContainedBy(subject: ReturnType<Page["locator"]>, owner: ReturnType<Page["locator"]>) {
  const [subjectBox, ownerBox] = await Promise.all([subject.boundingBox(), owner.boundingBox()]);
  if (subjectBox === null || ownerBox === null) return false;
  return (
    subjectBox.y >= ownerBox.y &&
    subjectBox.y + subjectBox.height <= ownerBox.y + ownerBox.height
  );
}

async function installLiveMutationRecorder(page: Page, selector: string): Promise<void> {
  await page.evaluate((targetSelector) => {
    const target = document.querySelector<HTMLElement>(targetSelector);
    if (target === null) throw new TypeError("HostDeck announcement region is missing.");
    const records: string[] = [];
    const observer = new MutationObserver(() => {
      const message = target.textContent?.trim() ?? "";
      if (message !== "" && records.at(-1) !== message) records.push(message);
    });
    observer.observe(target, { childList: true, characterData: true, subtree: true });
    Object.defineProperty(window, "__hostdeckA11yAnnouncements", {
      configurable: true,
      value: Object.freeze({ records, observer })
    });
  }, selector);
}

async function readLiveMutationRecords(
  page: Page,
  disconnect = false
): Promise<readonly string[]> {
  return page.evaluate((shouldDisconnect) => {
    const runtime = (
      window as typeof window & {
        __hostdeckA11yAnnouncements?: {
          readonly records: readonly string[];
          readonly observer: MutationObserver;
        };
      }
    ).__hostdeckA11yAnnouncements;
    if (runtime === undefined) throw new TypeError("Announcement recorder is missing.");
    if (shouldDisconnect) runtime.observer.disconnect();
    return [...runtime.records];
  }, disconnect);
}
