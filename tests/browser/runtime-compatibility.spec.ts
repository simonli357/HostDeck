import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Locator, type Page, type Request, test } from "@playwright/test";
import { selectedHostCompatibilityStates } from "../../packages/contracts/src/index.js";
import {
  hostAccessCloseButton,
  hostAccessCloseSelector,
  openHostAccess
} from "./host-access-navigation.js";
import {
  installMissionControlApi,
  missionRequestPaths
} from "./mission-control-fixture.js";
import {
  compatibilityServerState,
  installRuntimeCompatibilityHost,
  type RuntimeCompatibilityFixtureVariant,
  runtimeCompatibilityFixtureVariants
} from "./runtime-compatibility-fixture.js";
import {
  installSessionDetailApi,
  sessionDetailBrowserSessionId
} from "./session-detail-fixture.js";

const artifactDirectory = resolve("artifacts/fe-v1-035-runtime-compatibility-ui");
const visualReviewTime = new Date("2026-07-27T04:00:00.000Z");
const newerRecordTime = "2026-07-27T04:01:00.000Z";
const layoutMeasurements: Array<Record<string, unknown>> = [];
const variantCases = [
  {
    variant: "supported",
    title: "Codex compatible",
    source: "Current laptop check",
    installed: "0.147.0",
    capability: "Verified",
    evidence: "Current",
    stateCell: "Current",
    action: "Recheck compatibility"
  },
  {
    variant: "degraded_current",
    title: "Codex compatibility limited",
    source: "Current laptop check",
    installed: "0.147.0",
    capability: "Limited",
    evidence: "Current",
    stateCell: "Degraded",
    action: "Check compatibility"
  },
  {
    variant: "degraded_last_known",
    title: "Codex compatibility is stale",
    source: "Last known laptop check",
    installed: "0.147.0",
    capability: "Unverified",
    evidence: "Last known",
    stateCell: "Degraded",
    action: "Check compatibility"
  },
  {
    variant: "incompatible",
    title: "Codex interface incompatible",
    source: "Current laptop check",
    installed: "0.147.0",
    capability: "Blocked",
    evidence: "Current",
    stateCell: "Incompatible",
    action: "Check compatibility"
  },
  {
    variant: "unknown_unobserved",
    title: "Codex compatibility not checked",
    source: "Not observed",
    installed: "Not observed",
    capability: "Unverified",
    evidence: "Not observed",
    stateCell: "Unknown",
    action: "Check compatibility"
  },
  {
    variant: "unknown_last_known",
    title: "Codex compatibility unknown",
    source: "Last known laptop check",
    installed: "0.147.0",
    capability: "Unverified",
    evidence: "Last known",
    stateCell: "Unknown",
    action: "Check compatibility"
  },
  {
    variant: "disconnected",
    title: "Codex runtime disconnected",
    source: "Last known laptop check",
    installed: "0.147.0",
    capability: "Unverified",
    evidence: "Last known",
    stateCell: "Disconnected",
    action: "Check compatibility"
  },
  {
    variant: "version_drift",
    title: "Codex update required",
    source: "Current laptop check",
    installed: "0.143.1",
    capability: "Blocked",
    evidence: "Current",
    stateCell: "Update required",
    action: "Check compatibility"
  }
] as const satisfies ReadonlyArray<{
  variant: RuntimeCompatibilityFixtureVariant;
  title: string;
  source: string;
  installed: string;
  capability: string;
  evidence: string;
  stateCell: string;
  action: string;
}>;

test.beforeAll(async () => {
  await mkdir(artifactDirectory, { recursive: true });
});

test.afterAll(async () => {
  await writeFile(
    resolve(artifactDirectory, "layout-measurements.json"),
    `${JSON.stringify(layoutMeasurements, null, 2)}\n`,
    "utf8"
  );
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(visualReviewTime);
});

test("renders every selected state and evidence product through one complete Focus Rail", async ({
  page
}) => {
  test.setTimeout(90_000);
  expect(runtimeCompatibilityFixtureVariants).toEqual(
    variantCases.map(({ variant }) => variant)
  );
  expect([...new Set(variantCases.map(({ variant }) => compatibilityServerState(variant)))])
    .toEqual(selectedHostCompatibilityStates);
  const diagnostics = observePage(page);
  const mission = await installMissionControlApi(page, "read_only");
  const host = await installRuntimeCompatibilityHost(page, variantCases[0].variant);

  for (const [index, selected] of variantCases.entries()) {
    host.setVariant(selected.variant);
    if (index === 0) await page.goto("/");
    else await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Mission Control" }))
      .toBeVisible();
    await expect(page.getByText("release-approval", { exact: true }).first()).toBeVisible();
    await expect(stateCell(page)).toHaveText(selected.stateCell);
    if (selected.variant === "supported") {
      await expect(page.getByText(selected.title, { exact: true })).toHaveCount(0);
    } else {
      await expect(page.getByText(selected.title, { exact: true }).first()).toBeVisible();
    }

    const sheet = await openHostAccess(page);
    const rail = compatibilityRail(sheet);
    await expect(rail.getByText("CODEX RUNTIME", { exact: true })).toBeVisible();
    await expect(rail.locator(".hostdeck-runtime-compatibility__owner > small"))
      .toHaveText(selected.source);
    await expect(rail.getByRole("heading", { name: selected.title })).toBeVisible();
    await expectFact(rail, "Installed", selected.installed);
    await expectFact(rail, "HostDeck supports", "0.147.0");
    await expectFact(rail, "Controls", selected.capability);
    await expectFact(rail, "Evidence", selected.evidence);
    await expect(rail.getByText(/Checked Jul 27, 2026|Not checked/u)).toBeVisible();
    await expect(rail.getByRole("button", { name: selected.action })).toBeEnabled();
    await expect(
      rail.getByRole(
        selected.variant === "version_drift" || selected.variant === "incompatible"
          ? "alert"
          : "status"
      )
    ).toBeVisible();
    await rail.scrollIntoViewIfNeeded();
    await capture(page, `state-${selected.variant}-390x844.png`);
    await hostAccessCloseButton(sheet).click();
  }

  expect(host.requests).toHaveLength(variantCases.length);
  expect(readOnlyViolations([...mission.requests, ...host.requests])).toEqual([]);
  expect(unexpectedMissionPaths(mission.requests)).toEqual([]);
  await expectPrivateFreeBrowser(page);
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.externalRequests).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
});

test("downgrades retained browser data and synchronously purges it after authority loss", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const mission = await installMissionControlApi(page, "read_only");
  const host = await installRuntimeCompatibilityHost(page, "degraded_current");
  await page.goto("/");
  await expect(page.getByText("Codex compatibility limited", { exact: true }).first())
    .toBeVisible();

  host.setOutcome("failure");
  await page.getByRole("button", { name: "Refresh sessions" }).click();
  await expect(page.getByText("Codex compatibility is stale", { exact: true }).first())
    .toBeVisible();
  let sheet = await openHostAccess(page);
  let rail = compatibilityRail(sheet);
  await expect(rail.getByText("Last known browser data", { exact: true })).toBeVisible();
  await expectFact(rail, "Controls", "Unverified");
  await expectFact(rail, "Evidence", "Last known");
  await rail.scrollIntoViewIfNeeded();
  await capture(page, "browser-stale-390x844.png");
  await hostAccessCloseButton(sheet).click();

  host.setOutcome("success");
  mission.setVariant("denied");
  await page.getByRole("button", { name: "Refresh sessions" }).click();
  await expect(page.getByText("Device access is invalid", { exact: true })).toBeVisible();
  sheet = await openHostAccess(page);
  rail = compatibilityRail(sheet);
  await expect(rail.getByRole("heading", { name: "Codex compatibility unavailable" }))
    .toBeVisible();
  await expect(rail.locator("dl")).toHaveCount(0);
  await expect(rail.getByRole("button")).toHaveCount(0);
  await expect(rail).not.toContainText("0.147.0");
  await rail.scrollIntoViewIfNeeded();
  await capture(page, "authority-purged-390x844.png");

  expect(readOnlyViolations([...mission.requests, ...host.requests])).toEqual([]);
  await expectPrivateFreeBrowser(page);
  expect(diagnostics.pageErrors).toEqual([]);
});

test("coalesces one explicit check across sheet closure and confirms only a newer recovery", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const mission = await installMissionControlApi(page, "read_only");
  const host = await installRuntimeCompatibilityHost(page, "version_drift");
  await page.goto("/");
  let sheet = await openHostAccess(page);
  let rail = compatibilityRail(sheet);
  const hostStart = host.requests.length;
  const accessStart = pathCount(mission.requests, "/api/v1/access");
  const sessionsStart = pathCount(mission.requests, "/api/v1/sessions");

  host.setVariant("supported");
  host.setRecordedAt(newerRecordTime);
  host.setOutcome("pending");
  await rail.getByRole("button", { name: "Check compatibility" })
    .evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
  await expect.poll(host.hasPendingHost).toBe(true);
  expect(host.requests).toHaveLength(hostStart + 1);
  await expect(rail.getByRole("heading", { name: "Checking Codex compatibility" }))
    .toBeVisible();
  await expect(rail.getByText("Read-only status check", { exact: true })).toBeVisible();
  await expect(rail.getByRole("button", { name: "Check compatibility" })).toBeDisabled();
  await rail.scrollIntoViewIfNeeded();
  await capture(page, "checking-390x844.png");

  await hostAccessCloseButton(sheet).click();
  sheet = await openHostAccess(page);
  rail = compatibilityRail(sheet);
  await expect(rail.getByRole("heading", { name: "Checking Codex compatibility" }))
    .toBeVisible();
  expect(host.requests).toHaveLength(hostStart + 1);

  host.releaseHost();
  await expect(rail.getByRole("heading", { name: "Codex compatibility restored" }))
    .toBeVisible();
  await expect(rail.getByRole("button", { name: "Recheck compatibility" })).toBeEnabled();
  await rail.scrollIntoViewIfNeeded();
  await capture(page, "newer-recovery-confirmed-390x844.png");

  expect(pathCount(mission.requests, "/api/v1/access")).toBe(accessStart + 1);
  expect(pathCount(mission.requests, "/api/v1/sessions")).toBe(sessionsStart + 1);
  expect(host.requests).toHaveLength(hostStart + 1);
  const checkedHost = host.requests.at(-1);
  expect(checkedHost?.method()).toBe("GET");
  expect(checkedHost?.postData()).toBeNull();
  expect(checkedHost?.headers()["x-hostdeck-csrf"]).toBeUndefined();
  expect(checkedHost?.headers()["x-hostdeck-local-admin"]).toBeUndefined();
  await page.waitForTimeout(250);
  expect(host.requests).toHaveLength(hostStart + 1);
  expect(readOnlyViolations([...mission.requests, ...host.requests])).toEqual([]);
  await expectPrivateFreeBrowser(page);
  expect(diagnostics.pageErrors).toEqual([]);
});

test("latches same-revision and failed checks until a new human attempt", async ({ page }) => {
  const diagnostics = observePage(page);
  const mission = await installMissionControlApi(page, "read_only");
  const host = await installRuntimeCompatibilityHost(page, "version_drift");
  await page.goto("/");
  let sheet = await openHostAccess(page);
  let rail = compatibilityRail(sheet);

  host.setVariant("supported");
  await rail.getByRole("button", { name: "Check compatibility" }).click();
  await expect(rail.getByRole("heading", { name: "Compatibility recovery not confirmed" }))
    .toBeVisible();
  await rail.scrollIntoViewIfNeeded();
  await capture(page, "same-revision-unconfirmed-390x844.png");

  await hostAccessCloseButton(sheet).click();
  host.setVariant("incompatible");
  host.setRecordedAt(newerRecordTime);
  await page.reload();
  sheet = await openHostAccess(page);
  rail = compatibilityRail(sheet);
  const requestsBeforeFailure = host.requests.length;
  host.setOutcome("failure");
  await rail.getByRole("button", { name: "Check compatibility" }).click();
  await expect(rail.getByRole("heading", { name: "Compatibility check not confirmed" }))
    .toBeVisible();
  await expect(rail.getByText("Last status check", { exact: true })).toBeVisible();
  await page.waitForTimeout(250);
  expect(host.requests).toHaveLength(requestsBeforeFailure + 1);
  await rail.scrollIntoViewIfNeeded();
  await capture(page, "check-failed-390x844.png");

  host.setOutcome("success");
  host.setVariant("supported");
  host.setRecordedAt("2026-07-27T04:02:00.000Z");
  await rail.getByRole("button", { name: "Check compatibility" }).click();
  await expect(rail.getByRole("heading", { name: "Codex compatibility restored" }))
    .toBeVisible();
  expect(host.requests).toHaveLength(requestsBeforeFailure + 2);
  expect(readOnlyViolations([...mission.requests, ...host.requests])).toEqual([]);
  await expectPrivateFreeBrowser(page);
  expect(diagnostics.pageErrors).toEqual([]);
});

test("keeps readable Session Detail visible while compatibility blocks unsafe controls", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const detail = await installSessionDetailApi(page, "writable");
  const host = await installRuntimeCompatibilityHost(
    page,
    "version_drift",
    "paired_write"
  );
  await page.goto(`/sessions/${sessionDetailBrowserSessionId}`);

  await expect(page.getByRole("heading", { level: 1, name: "android-release activity" }))
    .toBeVisible();
  await expect(page.getByText("Codex update required", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("list", { name: "Session activity" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Prompt for android-release" }))
    .toBeDisabled();
  await expect(page.getByRole("button", { name: "Send prompt to android-release" }))
    .toBeDisabled();
  await capture(page, "session-detail-update-required-390x844.png");

  const sheet = await openHostAccess(page);
  const rail = compatibilityRail(sheet);
  await expect(rail.getByRole("heading", { name: "Codex update required" })).toBeVisible();
  await expectFact(rail, "Installed", "0.143.1");
  await expectFact(rail, "HostDeck supports", "0.147.0");
  expect(detail.promptRequests()).toHaveLength(0);
  expect(unsafeSessionMutations(detail.requests)).toEqual([]);
  expect(host.requests.every((request) => request.method() === "GET")).toBe(true);
  await expectPrivateFreeBrowser(page);
  expect(diagnostics.pageErrors).toEqual([]);
});

test("contains long compatibility truth across phone, tablet, desktop, short-height, and 200 percent reflow", async ({
  page
}) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const mission = await installMissionControlApi(page, "read_only");
  const host = await installRuntimeCompatibilityHost(page, "version_drift");
  host.setVersions(
    "0.143.1-experimental-mobile-runtime-compatibility-a",
    "0.147.0-hostdeck-selected-mobile-runtime-20260727"
  );
  await page.goto("/");
  const sheet = await openHostAccess(page);
  const rail = compatibilityRail(sheet);
  await expect(rail.getByRole("heading", { name: "Codex update required" })).toBeVisible();
  const action = rail.getByRole("button", { name: "Check compatibility" });
  await action.focus();
  await expect(action).toBeFocused();

  for (const viewport of [
    { width: 320, height: 800 },
    { width: 360, height: 800 },
    { width: 390, height: 844 },
    { width: 412, height: 915 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 }
  ]) {
    await page.setViewportSize(viewport);
    await expectCloseReachable(sheet);
    await action.scrollIntoViewIfNeeded();
    layoutMeasurements.push(await measureLayout(page, sheet, rail, viewport));
    await capture(page, `responsive-${viewport.width}x${viewport.height}.png`);
  }

  await page.setViewportSize({ width: 390, height: 420 });
  await expectCloseReachable(sheet);
  await action.scrollIntoViewIfNeeded();
  layoutMeasurements.push(
    await measureLayout(page, sheet, rail, { width: 390, height: 420 })
  );
  await capture(page, "responsive-short-390x420.png");

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  await expectCloseReachable(sheet);
  await action.scrollIntoViewIfNeeded();
  layoutMeasurements.push(
    await measureLayout(page, sheet, rail, { width: 1280, height: 800, zoom: 2 })
  );
  await capture(page, "responsive-reflow-200-1280x800.png");
  await page.evaluate(() => {
    document.documentElement.style.zoom = "1";
  });

  expect(readOnlyViolations([...mission.requests, ...host.requests])).toEqual([]);
  await expectPrivateFreeBrowser(page);
});

function compatibilityRail(sheet: Locator): Locator {
  return sheet.locator(".hostdeck-runtime-compatibility");
}

function stateCell(page: Page): Locator {
  return page.locator(".hostdeck-status-rail__cell").filter({ hasText: /^State/u }).locator("dd");
}

async function expectFact(rail: Locator, label: string, value: string): Promise<void> {
  const fact = rail.locator(".hostdeck-runtime-compatibility__facts > div")
    .filter({ hasText: label })
    .first();
  await expect(fact.locator("dt")).toHaveText(label);
  await expect(fact.locator("dd > span")).toHaveText(value);
}

async function capture(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: resolve(artifactDirectory, name),
    animations: "disabled",
    fullPage: false
  });
}

async function expectCloseReachable(sheet: Locator): Promise<void> {
  const close = hostAccessCloseButton(sheet);
  await close.scrollIntoViewIfNeeded();
  await expect(close).toBeVisible();
  await expect(close).toBeEnabled();
}

async function measureLayout(
  page: Page,
  sheet: Locator,
  rail: Locator,
  viewport: Readonly<{ width: number; height: number; zoom?: number }>
): Promise<Record<string, unknown>> {
  const measurement = await page.evaluate((closeSelector) => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const section = document.querySelector<HTMLElement>(".hostdeck-runtime-compatibility");
    const button = section?.querySelector<HTMLElement>("button");
    const close = dialog?.querySelector<HTMLElement>(closeSelector);
    const facts = [...(section?.querySelectorAll<HTMLElement>("dl > div") ?? [])]
      .map((element) => rectangle(element.getBoundingClientRect()));
    if (
      dialog === null ||
      section === null ||
      button === undefined ||
      button === null ||
      close === undefined ||
      close === null
    ) {
      throw new TypeError("Compatibility layout target is missing.");
    }
    const scrollOwners = [dialog, ...dialog.querySelectorAll<HTMLElement>("*")].filter(
      (element) => {
        const style = getComputedStyle(element);
        return (
          element.scrollHeight > element.clientHeight + 1 &&
          (style.overflowY === "auto" || style.overflowY === "scroll")
        );
      }
    );
    return {
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      dialog: rectangle(dialog.getBoundingClientRect()),
      rail: rectangle(section.getBoundingClientRect()),
      action: rectangle(button.getBoundingClientRect()),
      close: rectangle(close.getBoundingClientRect()),
      facts,
      scrollOwnerCount: scrollOwners.length
    };

    function rectangle(value: DOMRect) {
      return {
        top: value.top,
        right: value.right,
        bottom: value.bottom,
        left: value.left,
        width: value.width,
        height: value.height
      };
    }
  }, hostAccessCloseSelector);
  expect(measurement.documentScrollWidth).toBeLessThanOrEqual(measurement.documentClientWidth);
  expect(measurement.rail.left).toBeGreaterThanOrEqual(measurement.dialog.left - 1);
  expect(measurement.rail.right).toBeLessThanOrEqual(measurement.dialog.right + 1);
  expect(measurement.action.height).toBeGreaterThanOrEqual(44);
  expect(measurement.action.width).toBeGreaterThanOrEqual(44);
  expect(measurement.close.height).toBeGreaterThanOrEqual(44);
  expect(measurement.close.width).toBeGreaterThanOrEqual(44);
  expect(measurement.scrollOwnerCount).toBe(1);
  expect(rectanglesOverlap(measurement.facts)).toBe(false);
  await expect(sheet).toBeVisible();
  await expect(rail).toBeVisible();
  return { viewport, ...measurement };
}

function rectanglesOverlap(
  rectangles: readonly Readonly<{
    top: number;
    right: number;
    bottom: number;
    left: number;
  }>[]
): boolean {
  return rectangles.some((left, index) =>
    rectangles.slice(index + 1).some(
      (right) =>
        left.left < right.right - 0.5 &&
        left.right > right.left + 0.5 &&
        left.top < right.bottom - 0.5 &&
        left.bottom > right.top + 0.5
    )
  );
}

function readOnlyViolations(requests: readonly Request[]): readonly string[] {
  return requests
    .filter((request) => request.method() !== "GET" || request.postData() !== null)
    .map((request) => `${request.method()} ${new URL(request.url()).pathname}`);
}

function unsafeSessionMutations(requests: readonly Request[]): readonly string[] {
  return requests
    .filter(
      (request) =>
        request.method() !== "GET" &&
        new URL(request.url()).pathname !== "/api/v1/access/csrf"
    )
    .map((request) => `${request.method()} ${new URL(request.url()).pathname}`);
}

function unexpectedMissionPaths(requests: readonly Request[]): readonly string[] {
  const allowed = new Set([
    "/api/v1/access",
    "/api/v1/access/devices",
    "/api/v1/sessions"
  ]);
  return missionRequestPaths({ requests, setVariant() {} }).filter((path) => !allowed.has(path));
}

function pathCount(requests: readonly Request[], path: string): number {
  return missionRequestPaths({ requests, setVariant() {} })
    .filter((candidate) => candidate === path).length;
}

async function expectPrivateFreeBrowser(page: Page): Promise<void> {
  const state = await page.evaluate(() => ({
    body: document.body.innerText,
    history: location.pathname + location.search + location.hash,
    localStorage: localStorage.length,
    sessionStorage: sessionStorage.length
  }));
  expect(state.body).not.toMatch(
    /device_mission_phone|device_detail_phone|thread-private|binding[_ -]?id|capabilit(?:y|ies):|schema|socket|executable|command output|operation[_ -]?id|csrf|credential/iu
  );
  expect(state.history).not.toMatch(/device_|thread-|csrf|credential/iu);
  expect(state.localStorage).toBe(0);
  expect(state.sessionStorage).toBe(0);
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
