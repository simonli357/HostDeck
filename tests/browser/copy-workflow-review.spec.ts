import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { installApprovalDecisionsApi } from "./approval-decisions-fixture.js";
import { hostAccessScrollOwner, openHostAccess } from "./host-access-navigation.js";
import {
  installInterruptApi,
  interruptBrowserTurnId
} from "./interrupt-control-fixture.js";
import { installMissionControlApi } from "./mission-control-fixture.js";
import { installRemoteRecoveryApi } from "./remote-connection-recovery-fixture.js";
import {
  installSessionDetailApi,
  promptTurnEvent,
  sessionDetailBrowserSessionId
} from "./session-detail-fixture.js";

const artifactDirectory = resolve("artifacts/fe-v1-018-copy-workflow-review");
const detailPath = `/sessions/${sessionDetailBrowserSessionId}`;
const visualReviewTime = new Date("2026-07-28T14:00:00.000Z");
const evidence: ReviewEvidence[] = [];

interface ReviewEvidence {
  readonly id: string;
  readonly file: string;
  readonly viewport: Readonly<{ width: number; height: number }>;
  readonly document: Readonly<{
    clientWidth: number;
    scrollWidth: number;
    clientHeight: number;
    scrollHeight: number;
  }>;
  readonly visibleDialog: Rectangle | null;
  readonly primaryControls: Rectangle | null;
}

interface Rectangle {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

test.beforeAll(async () => {
  await mkdir(artifactDirectory, { recursive: true });
});

test.afterAll(async () => {
  await writeFile(
    resolve(artifactDirectory, "review-measurements.json"),
    `${JSON.stringify({ fixed_time: visualReviewTime.toISOString(), evidence }, null, 2)}\n`,
    "utf8"
  );
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(visualReviewTime);
});

test("captures the phone-first Mission entry and selected-session control hierarchy", async ({
  page
}) => {
  const diagnostics = observePage(page);
  await installMissionControlApi(page, "mixed");
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1, name: "Mission Control" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "ACT NOW" })).toBeVisible();
  await expect(page.getByRole("link", { name: /^release-approval/u })).toBeVisible();
  await capture(page, "mission-entry-390x844.png", "mission-entry");

  await expectCleanBrowser(diagnostics);
});

test("captures prompt-ready, one pending dispatch, and authoritative completion", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const api = await installSessionDetailApi(page, "writable");
  api.setPromptOutcome("pending");
  await page.goto(detailPath);

  const textarea = page.getByRole("textbox", { name: "Prompt for android-release" });
  await expect(textarea).toBeEditable();
  await expect(page.getByRole("button", { name: /^\/model for /u })).toBeVisible();
  await expect(page.getByRole("button", { name: /^\/goal for /u })).toBeVisible();
  await expect(page.getByRole("button", { name: /^\/plan for /u })).toBeVisible();
  await capture(page, "session-ready-390x844.png", "session-ready");

  await textarea.fill("Review the bounded phone workflow.");
  await page.getByRole("button", { name: "Send prompt to android-release" }).click();
  await expect(page.getByText("Sending prompt", { exact: true })).toBeVisible();
  await expect.poll(api.hasPendingPrompt).toBe(true);
  await capture(page, "prompt-pending-390x844.png", "prompt-pending", [textarea]);

  api.releasePendingPrompt();
  await expect(page.getByText("New turn accepted", { exact: true })).toBeVisible();
  await api.pushEvent(promptTurnEvent(4, "completed"));
  await expect(page.getByText("Turn completed", { exact: true })).toBeVisible();
  await capture(page, "prompt-completed-390x844.png", "prompt-completed");

  expect(api.promptRequests()).toHaveLength(1);
  await expectCleanBrowser(diagnostics);
});

test("captures elevated approval consequence, locked pending state, and terminal result", async ({
  page
}) => {
  const diagnostics = observePage(page);
  await page.clock.setFixedTime(new Date("2026-07-22T20:00:00.000Z"));
  const api = await installApprovalDecisionsApi(page, {
    snapshotVariant: "elevated",
    respondOutcome: "pending"
  });
  await page.goto(detailPath);

  const item = page
    .locator(".hostdeck-approval-item")
    .filter({ hasText: "Install the Android validation package" })
    .first();
  await item.getByRole("button", { name: "Review & approve" }).click();
  const confirmation = page.getByRole("dialog", { name: "Approve elevated request?" });
  await expect(confirmation.getByText("Elevated risk", { exact: true })).toBeVisible();
  await expect(confirmation.getByText("One time", { exact: true })).toBeVisible();
  await capture(page, "approval-confirmation-390x844.png", "approval-confirmation");

  await confirmation.getByRole("button", { name: "Approve once" }).click();
  await expect.poll(api.hasPendingResponse).toBe(true);
  await expect(confirmation.getByText("Confirming decision", { exact: true })).toBeVisible();
  await capture(page, "approval-pending-390x844.png", "approval-pending");

  api.releaseResponse();
  await expect(confirmation).toBeHidden();
  await expect(item.getByText("The selected request was approved once.", { exact: true }))
    .toBeVisible();
  await expect(
    page.getByText(
      "The turn still reports waiting for approval. Refresh before sending.",
      { exact: true }
    )
  ).toBeVisible();
  await expect(page.getByText("Resolve the pending approval first.", { exact: true }))
    .toHaveCount(0);
  await item.scrollIntoViewIfNeeded();
  await capture(page, "approval-confirmed-390x844.png", "approval-confirmed");

  expect(api.approvalRespondRequests()).toHaveLength(1);
  await expectCleanBrowser(diagnostics);
});

test("captures the exact interrupt target and non-destructive consequence", async ({ page }) => {
  const diagnostics = observePage(page);
  const events = [promptTurnEvent(1, "in_progress", interruptBrowserTurnId)];
  await installSessionDetailApi(page, "writable", {
    initialEvents: events,
    streamEvents: events,
    turnState: "in_progress"
  });
  const interrupt = await installInterruptApi(page, interruptBrowserTurnId);
  await page.goto(detailPath);

  await page.getByRole("button", { name: "Open session actions" }).click();
  const menu = page.getByRole("dialog", { name: "Session actions", exact: true });
  await menu.getByRole("button", { name: /Interrupt active turn/iu }).click();
  const confirmation = page.getByRole("dialog", {
    name: "Interrupt active turn?",
    exact: true
  });
  await expect(confirmation.getByText("Stop only this active turn", { exact: true }))
    .toBeVisible();
  await expect(confirmation.getByText("Not archived, deleted, or erased", { exact: true }))
    .toBeVisible();
  await capture(page, "interrupt-confirmation-390x844.png", "interrupt-confirmation");

  expect(interrupt.requests()).toHaveLength(0);
  await expectCleanBrowser(diagnostics);
});

test("captures a replay boundary at 320 reflow without inventing missing history", async ({
  page
}) => {
  const diagnostics = observePage(page);
  await page.setViewportSize({ width: 320, height: 800 });
  await installSessionDetailApi(page, "boundary");
  await page.goto(detailPath);

  const boundary = page.getByText("Earlier activity unavailable", { exact: true });
  await expect(boundary).toBeVisible();
  await expect(
    page.getByText("Only retained activity after this boundary is available.", { exact: true })
  )
    .toBeVisible();
  await boundary.evaluate((element) => {
    element.closest("li")?.scrollIntoView({ block: "center" });
  });
  await capture(page, "boundary-reflow-320x800.png", "boundary-reflow");

  await expectCleanBrowser(diagnostics);
});

test("captures stale retained state without exposing unsafe controls", async ({ page }) => {
  const diagnostics = observePage(page);
  await installSessionDetailApi(page, "stale_session");
  await page.goto(detailPath);

  await expect(page.getByText("Showing stale session state", { exact: true })).toBeVisible();
  await expect(page.getByText(/Session state last confirmed/iu)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Prompt for android-release" }))
    .toBeDisabled();
  await capture(page, "session-stale-390x844.png", "session-stale");

  await expectCleanBrowser(diagnostics);
});

test("contains the longest corrected remote-recovery copy at phone, short, and zoom bounds", async ({
  page
}) => {
  const diagnostics = observePage(page);
  await installRemoteRecoveryApi(page, "loopback", "profile_other");
  await page.goto("/");
  const dialog = await openHostAccess(page);
  await expect(dialog.getByRole("heading", { name: "HostDeck profile is not active" }))
    .toBeVisible();
  await expect(dialog.getByText("LOCAL LAPTOP", { exact: true })).toBeVisible();
  await capture(
    page,
    "remote-profile-other-overview-390x844.png",
    "remote-profile-other-overview"
  );
  const recovery = dialog.locator(".hostdeck-remote-recovery");
  await frameRemoteRecovery(dialog, recovery);
  await capture(page, "remote-profile-other-390x844.png", "remote-profile-other");

  await page.setViewportSize({ width: 320, height: 800 });
  await frameRemoteRecovery(dialog, recovery);
  await capture(page, "remote-profile-other-320x800.png", "remote-profile-other-reflow");

  await page.setViewportSize({ width: 390, height: 420 });
  await frameRemoteRecovery(dialog, recovery);
  await capture(page, "remote-profile-other-short-390x420.png", "remote-profile-other-short");

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  await frameRemoteRecovery(dialog, recovery, false);
  await capture(
    page,
    "remote-profile-other-zoom-200-1280x800.png",
    "remote-profile-other-zoom",
    [],
    true
  );

  await expectCleanBrowser(diagnostics);
});

async function frameRemoteRecovery(
  dialog: Locator,
  recovery: Locator,
  requireFullContainment = true
): Promise<void> {
  await recovery.evaluate((element) => {
    element.scrollIntoView({ block: "center" });
  });
  await expect(recovery.getByRole("heading", { name: "HostDeck profile is not active" }))
    .toBeVisible();
  await expect(recovery.getByRole("button", { name: "Check remote access" })).toBeVisible();
  if (!requireFullContainment) return;

  const [recoveryBox, scrollerBox] = await Promise.all([
    recovery.boundingBox(),
    hostAccessScrollOwner(dialog).boundingBox()
  ]);
  expect(recoveryBox).not.toBeNull();
  expect(scrollerBox).not.toBeNull();
  if (recoveryBox === null || scrollerBox === null) return;
  expect(recoveryBox.y).toBeGreaterThanOrEqual(scrollerBox.y - 1);
  expect(recoveryBox.y + recoveryBox.height).toBeLessThanOrEqual(
    scrollerBox.y + scrollerBox.height + 1
  );
}

async function capture(
  page: Page,
  file: string,
  id: string,
  mask: readonly Locator[] = [],
  allowVerticalOverflow = false
): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const measurement = await page.evaluate(() => {
    const rectangle = (element: Element | null): Rectangle | null => {
      if (!(element instanceof HTMLElement)) return null;
      const value = element.getBoundingClientRect();
      return {
        top: Math.round(value.top),
        right: Math.round(value.right),
        bottom: Math.round(value.bottom),
        left: Math.round(value.left),
        width: Math.round(value.width),
        height: Math.round(value.height)
      };
    };
    const visibleDialog = [...document.querySelectorAll('[role="dialog"]')].find((element) => {
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden";
    });
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      document: {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        clientHeight: document.documentElement.clientHeight,
        scrollHeight: document.documentElement.scrollHeight
      },
      visibleDialog: rectangle(visibleDialog ?? null),
      primaryControls: rectangle(
        document.querySelector(
          ".hostdeck-prompt-composer, .hostdeck-pairing-rail, .hostdeck-mission-screen"
        )
      )
    };
  });
  expect(measurement.document.scrollWidth).toBeLessThanOrEqual(
    measurement.document.clientWidth + 1
  );
  if (measurement.visibleDialog !== null) {
    expect(measurement.visibleDialog.left).toBeGreaterThanOrEqual(-1);
    expect(measurement.visibleDialog.right).toBeLessThanOrEqual(measurement.viewport.width + 1);
    if (!allowVerticalOverflow) {
      expect(measurement.visibleDialog.top).toBeGreaterThanOrEqual(-1);
      expect(measurement.visibleDialog.bottom).toBeLessThanOrEqual(
        measurement.viewport.height + 1
      );
    }
  }
  await expectRenderedCopySafe(page);
  evidence.push({ id, file, ...measurement });
  await page.screenshot({
    path: resolve(artifactDirectory, file),
    animations: "disabled",
    caret: "hide",
    mask: [...mask],
    maskColor: "#111315"
  });
}

async function expectRenderedCopySafe(page: Page): Promise<void> {
  const body = await page.locator("body").innerText();
  expect(body).not.toMatch(
    /#pair=|csrf[_ -]?token|cookie|thread-private|device_remote_recovery|fixture-tailnet|\/workspace\//iu
  );
  expect(body).not.toMatch(
    /\bauthority\b|terminal proof|process-live|same-generation|HostDeck projection|structured (?:approval|compact|goal|model|plan|skills|usage)/iu
  );
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
    if (new URL(request.url()).origin !== "http://127.0.0.1:4175") {
      externalRequests.push(request.url());
    }
  });
  return { consoleErrors, externalRequests, pageErrors };
}

async function expectCleanBrowser(diagnostics: ReturnType<typeof observePage>): Promise<void> {
  await expect.poll(() => diagnostics.pageErrors).toEqual([]);
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.externalRequests).toEqual([]);
}
