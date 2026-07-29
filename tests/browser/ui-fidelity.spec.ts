import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { installApprovalDecisionsApi } from "./approval-decisions-fixture.js";
import { installGoalControlApi } from "./goal-control-fixture.js";
import {
  hostAccessCloseButton,
  openHostAccess
} from "./host-access-navigation.js";
import { installMissionControlApi } from "./mission-control-fixture.js";
import { installModelControlApi } from "./model-control-fixture.js";
import { installPlanControlApi } from "./plan-control-fixture.js";
import { installRemoteRecoveryApi } from "./remote-connection-recovery-fixture.js";
import {
  installSessionDetailApi,
  sessionDetailBrowserSessionId
} from "./session-detail-fixture.js";

const artifactDirectory = requiredArtifactDirectory();
const detailPath = `/sessions/${sessionDetailBrowserSessionId}`;
const fixtureTimes = Object.freeze({
  approval: "2026-07-22T22:00:00.000Z",
  detail: "2026-07-22T22:00:00.000Z",
  mission: "2026-07-22T20:00:00.000Z",
  modelGoal: "2026-07-25T20:00:00.000Z",
  plan: "2026-07-26T02:00:00.000Z",
  recovery: "2026-07-26T16:00:00.000Z"
});
const viewports = [
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 412, height: 915 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 }
] as const;
const measurements: Record<string, unknown>[] = [];

test.beforeAll(async () => {
  await mkdir(artifactDirectory, { recursive: true });
});

test.afterAll(async () => {
  await writeFile(
    resolve(artifactDirectory, "shell-measurements.json"),
    `${JSON.stringify({ fixture_times: fixtureTimes, measurements }, null, 2)}\n`,
    "utf8"
  );
});

test("captures Mission Control and exact design-system geometry", async ({ page }) => {
  await setFixtureTime(page, fixtureTimes.mission);
  const diagnostics = observePage(page, "http://127.0.0.1:4175");
  await installMissionControlApi(page, "responsive");
  await page.goto("/");
  await expect(page.getByRole("link", { name: /^release-approval/u })).toBeVisible();

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expectNoHorizontalOverflow(page, viewport.width);
    await expectStableControls(page);
    measurements.push({
      id: `mission-${viewport.width}x${viewport.height}`,
      ...(await measureMission(page, viewport))
    });
    await capture(page, `mission-${viewport.width}x${viewport.height}.png`);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  const priorityRows = page.getByRole("region", { name: "ACT NOW" }).getByRole("link");
  const second = await priorityRows.nth(1).boundingBox();
  expect(await priorityRows.count()).toBeGreaterThanOrEqual(2);
  expect((second?.y ?? 844) + (second?.height ?? 1)).toBeLessThanOrEqual(844);

  const tokens = await measureDesignSystem(page);
  expect(tokens.colors).toEqual({
    attention: "#f1b43c",
    canvas: "#121313",
    connected: "#45c2b1",
    danger: "#ff675b",
    divider: "#414447",
    focus: "#4e8dff",
    ink: "#f5f3ee",
    muted: "#a9acb0",
    surface: "#191b1c"
  });
  expect(tokens.radii.every((radius) => ["0px", "4px", "6px"].includes(radius))).toBe(
    true
  );
  const pageTypography = tokens.typography.page;
  if (pageTypography === undefined) throw new TypeError("Page typography was not measured.");
  expect(pageTypography).toMatchObject({
    fontSize: "24px",
    lineHeight: "30px"
  });
  expect(["0px", "normal"]).toContain(pageTypography.letterSpacing);
  for (const typography of Object.values(tokens.typography)) {
    expect(["12px", "13px", "14px", "16px", "18px", "24px"]).toContain(
      typography.fontSize
    );
    expect(["0px", "normal"]).toContain(typography.letterSpacing);
  }
  measurements.push({ id: "design-system", ...tokens });
  expectCleanDiagnostics(diagnostics);
});

test("captures the active detail continuum and selected desktop split", async ({ page }) => {
  await setFixtureTime(page, fixtureTimes.detail);
  const diagnostics = observePage(page, "http://127.0.0.1:4175");
  await page.setViewportSize({ width: 1280, height: 800 });
  await installSessionDetailApi(page, "writable", { turnState: "in_progress" });
  await installMissionControlApi(page, "responsive", { fallbackUnhandled: true });
  await page.goto("/");
  await page.getByRole("link", { name: /^android-release/u }).click();
  await expect(page).toHaveURL(new RegExp(`${detailPath}$`, "u"));
  await expect(page.getByRole("textbox", { name: "Prompt for android-release" })).toBeVisible();

  for (const viewport of [...viewports].reverse()) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expectNoHorizontalOverflow(page, viewport.width);
    await expectStableControls(page);
    measurements.push({
      id: `session-detail-${viewport.width}x${viewport.height}`,
      ...(await measureDetail(page, viewport))
    });
    await capture(page, `session-detail-${viewport.width}x${viewport.height}.png`);
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  const retained = page.getByRole("navigation", { name: "Mission Control sessions" });
  await expect(retained).toBeVisible();
  await expect(retained.getByRole("link", { name: /^android-release/u })).toHaveAttribute(
    "aria-current",
    "page"
  );
  expectCleanDiagnostics(diagnostics);
});

test("captures the replay boundary attached to the event rail", async ({ page }) => {
  await setFixtureTime(page, fixtureTimes.detail);
  const diagnostics = observePage(page, "http://127.0.0.1:4175");
  await installSessionDetailApi(page, "boundary");
  await page.goto(detailPath);
  await expect(page.getByText("Earlier activity unavailable", { exact: true })).toBeVisible();
  await expect(page.locator(".hostdeck-timeline-item--danger")).toBeVisible();
  await capture(page, "approval-boundary-390x844.png");
  expectCleanDiagnostics(diagnostics);
});

test("captures pending approval and elevated confirmation hierarchy", async ({ page }) => {
  await setFixtureTime(page, fixtureTimes.approval);
  const diagnostics = observePage(page, "http://127.0.0.1:4175");
  await installApprovalDecisionsApi(page, { snapshotVariant: "elevated" });
  await page.goto(detailPath);
  const approval = page.locator(".hostdeck-approval-item").first();
  const review = approval.getByRole("button", { name: "Review & approve" });
  await expect(review).toBeVisible();
  await revealAboveSessionControls(page, approval);
  await capture(page, "approval-pending-390x844.png");

  await review.click();
  const dialog = page.getByRole("dialog", { name: "Approve elevated request?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Approve once" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expectStableControls(dialog);
  await capture(page, "approval-elevated-confirmation-390x844.png");
  expectCleanDiagnostics(diagnostics);
});

test("captures local-laptop recovery ownership without remote mutation controls", async ({
  page
}) => {
  await setFixtureTime(page, fixtureTimes.recovery);
  const diagnostics = observePage(page, "http://127.0.0.1:4175");
  const states = [
    ["remote_disabled", "Remote access disabled"],
    ["client_stopped", "Tailscale is stopped"],
    ["profile_other", "HostDeck profile is not active"],
    ["serve_colliding", "Private HTTPS mapping conflict"]
  ] as const;
  const api = await installRemoteRecoveryApi(page, "loopback", states[0][0]);

  for (const [index, [state, title]] of states.entries()) {
    api.setRemoteState(state);
    if (index === 0) await page.goto("/");
    else await page.reload();
    const sheet = await openHostAccess(page);
    const recovery = sheet.locator(".hostdeck-remote-recovery");
    await expect(recovery.getByText("LOCAL LAPTOP", { exact: true })).toBeVisible();
    await expect(recovery.getByRole("heading", { name: title })).toBeVisible();
    await expect(recovery.getByRole("button", { name: "Check remote access" })).toBeVisible();
    await expect(recovery.getByRole("button", { name: /enable|switch|repair|unlock/iu }))
      .toHaveCount(0);
    await recovery.scrollIntoViewIfNeeded();
    await capture(page, `access-${state.replaceAll("_", "-")}-390x844.png`);
    await hostAccessCloseButton(sheet).click();
  }
  expectCleanDiagnostics(diagnostics);
});

test("captures the current model rail", async ({ page }) => {
  await setFixtureTime(page, fixtureTimes.modelGoal);
  const diagnostics = observePage(page, "http://127.0.0.1:4175");
  await installModelControlApi(page);
  await page.goto(detailPath);
  await page.getByRole("button", { name: "/model for android-release" }).click();
  const dialog = page.getByRole("dialog", { name: "/model" });
  await expect(dialog.getByText("No pending change", { exact: true })).toBeVisible();
  await expectStableControls(dialog);
  await capture(page, "primary-model-390x844.png");
  expectCleanDiagnostics(diagnostics);
});

test("captures the active goal objective and execution rails", async ({ page }) => {
  await setFixtureTime(page, fixtureTimes.modelGoal);
  const diagnostics = observePage(page, "http://127.0.0.1:4175");
  await installGoalControlApi(page, { snapshotVariant: "active" });
  await page.goto(detailPath);
  await page.getByRole("button", { name: "/goal for android-release" }).click();
  const dialog = page.getByRole("dialog", { name: "/goal" });
  await expect(dialog.getByText("Active", { exact: true }).last()).toBeVisible();
  await expectStableControls(dialog);
  await capture(page, "primary-goal-390x844.png");
  expectCleanDiagnostics(diagnostics);
});

test("captures the current Plan and next-turn rails", async ({ page }) => {
  await setFixtureTime(page, fixtureTimes.plan);
  const diagnostics = observePage(page, "http://127.0.0.1:4175");
  await installPlanControlApi(page);
  await page.goto(detailPath);
  await page.getByRole("button", { name: "/plan for android-release" }).click();
  const dialog = page.getByRole("dialog", { name: "/plan" });
  await expect(dialog.getByText("No pending change", { exact: true })).toBeVisible();
  await expectStableControls(dialog);
  await capture(page, "primary-plan-390x844.png");
  expectCleanDiagnostics(diagnostics);
});

function requiredArtifactDirectory(): string {
  const value = process.env.HOSTDECK_FIDELITY_ARTIFACT_DIR;
  if (value === undefined || value.length === 0 || !value.startsWith("/")) {
    throw new TypeError("HOSTDECK_FIDELITY_ARTIFACT_DIR must be an absolute path.");
  }
  return value;
}

function observePage(page: Page, allowedOrigin: string) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const externalRequests: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== allowedOrigin) externalRequests.push(request.url());
  });
  return { consoleErrors, externalRequests, pageErrors };
}

function expectCleanDiagnostics(diagnostics: ReturnType<typeof observePage>): void {
  expect(diagnostics).toEqual({ consoleErrors: [], externalRequests: [], pageErrors: [] });
}

async function capture(page: Page, name: string): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.screenshot({
    path: resolve(artifactDirectory, name),
    animations: "disabled",
    caret: "hide",
    fullPage: false
  });
}

async function setFixtureTime(page: Page, value: string): Promise<void> {
  await page.clock.setFixedTime(new Date(value));
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

async function expectStableControls(scope: Page | Locator): Promise<void> {
  const controls = scope.locator(
    "button:visible, a:visible:not(.hostdeck-skip-link), textarea:visible"
  );
  const violations = await controls.evaluateAll((elements) =>
    elements.flatMap((element) => {
      const box = element.getBoundingClientRect();
      if (box.width >= 40 && box.height >= 40) return [];
      return [
        {
          ariaLabel: element.getAttribute("aria-label"),
          className: element.getAttribute("class"),
          height: Math.round(box.height),
          tag: element.tagName,
          text: element.textContent?.trim().slice(0, 80) ?? "",
          width: Math.round(box.width)
        }
      ];
    })
  );
  expect(violations).toEqual([]);
}

async function revealAboveSessionControls(page: Page, target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const delta = await target.evaluate((element) => {
    const controls = document.querySelector(".hostdeck-session-controls");
    if (!(controls instanceof HTMLElement)) return 0;
    return Math.max(
      0,
      Math.ceil(element.getBoundingClientRect().bottom - controls.getBoundingClientRect().top + 12)
    );
  });
  if (delta > 0) await page.evaluate((offset) => window.scrollBy(0, offset), delta);
}

async function measureMission(
  page: Page,
  viewport: Readonly<{ width: number; height: number }>
): Promise<Record<string, unknown>> {
  return page.evaluate((selectedViewport) => {
    const requiredElement = (selector: string) => {
      const selected = document.querySelector<HTMLElement>(selector);
      if (selected === null) {
        throw new TypeError(`Missing fidelity layout target: ${selector}`);
      }
      return selected;
    };
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
    const status = requiredElement(".hostdeck-status-rail");
    const queue = requiredElement(".hostdeck-mission__queue");
    const rows = [...document.querySelectorAll<HTMLElement>(".hostdeck-session-row__link")];
    return {
      viewport: selectedViewport,
      status: rectangle(status),
      queue: rectangle(queue),
      row_count: rows.length,
      row_heights: rows.map((row) => Math.round(row.getBoundingClientRect().height)),
      document: documentDimensions()
    };
  }, viewport);
}

async function measureDetail(
  page: Page,
  viewport: Readonly<{ width: number; height: number }>
): Promise<Record<string, unknown>> {
  return page.evaluate((selectedViewport) => {
    const requiredElement = (selector: string) => {
      const selected = document.querySelector<HTMLElement>(selector);
      if (selected === null) {
        throw new TypeError(`Missing fidelity layout target: ${selector}`);
      }
      return selected;
    };
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
    const timeline = requiredElement(".hostdeck-detail-timeline");
    const controls = requiredElement(".hostdeck-session-controls");
    const composer = requiredElement(".hostdeck-prompt-composer");
    const split = document.querySelector<HTMLElement>(".hostdeck-responsive-detail-layout");
    return {
      viewport: selectedViewport,
      timeline: rectangle(timeline),
      controls: rectangle(controls),
      composer: rectangle(composer),
      split: split === null ? null : rectangle(split),
      document: documentDimensions()
    };
  }, viewport);
}

async function measureDesignSystem(page: Page): Promise<{
  colors: Record<string, string>;
  radii: string[];
  typography: Record<string, Record<string, string>>;
}> {
  return page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const token = (name: string) => root.getPropertyValue(name).trim();
    const style = (selector: string) => {
      const selected = document.querySelector<HTMLElement>(selector);
      if (selected === null) throw new TypeError(`Missing typography target: ${selector}`);
      const computed = getComputedStyle(selected);
      return {
        fontSize: computed.fontSize,
        fontWeight: computed.fontWeight,
        letterSpacing: computed.letterSpacing,
        lineHeight: computed.lineHeight
      };
    };
    const radii = [
      ".hostdeck-icon-button",
      ".hostdeck-session-row",
      ".hostdeck-session-row__link",
      ".hostdeck-status-rail"
    ].map((selector) => {
      const selected = document.querySelector<HTMLElement>(selector);
      if (selected === null) throw new TypeError(`Missing radius target: ${selector}`);
      return getComputedStyle(selected).borderRadius;
    });
    return {
      colors: {
        attention: token("--hostdeck-attention"),
        canvas: token("--hostdeck-canvas"),
        connected: token("--hostdeck-connected"),
        danger: token("--hostdeck-danger"),
        divider: token("--hostdeck-divider"),
        focus: token("--hostdeck-focus"),
        ink: token("--hostdeck-ink"),
        muted: token("--hostdeck-muted"),
        surface: token("--hostdeck-surface")
      },
      radii,
      typography: {
        body: style(".hostdeck-session-row__summary"),
        meta: style(".hostdeck-session-row__meta"),
        page: style(".hostdeck-route h1"),
        title: style(".hostdeck-session-row__topline > strong")
      }
    };
  });
}
