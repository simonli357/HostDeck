import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  type SessionCatalogEvent,
  type SharedSessionCatalogEntry,
  sessionCatalogEventSchema,
  sharedSessionCatalogEntrySchema
} from "../../packages/contracts/src/index.js";
import {
  installMissionControlApi,
  missionRequestPaths
} from "./mission-control-fixture.js";
import {
  installSessionCatalogBrowserStream,
  type SessionCatalogBrowserController
} from "./session-catalog-ui-fixture.js";
import {
  installSessionDetailApi,
  sessionDetailBrowserSessionId
} from "./session-detail-fixture.js";

const artifactDirectory = resolve("artifacts/fe-v1-107-live-session-catalog");
const streamA = "catalog_browser_ui_stream_a";
const streamB = "catalog_browser_ui_stream_b";
const timestamp = "2026-08-15T15:00:00.000Z";
const laterTimestamp = "2026-08-15T15:01:00.000Z";
const viewports = [
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 412, height: 915 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 }
] as const;
const nativeIds = [
  "019fc8bd-25ef-74c3-a3bf-c6e59e4122a4",
  "019fc8c8-f71a-7080-9d4d-d5cdbe484587",
  "019f37b0-917f-7fa0-9e3e-03a98b2cf2bf",
  "019f0000-0000-7000-8000-000000000004",
  "019f0000-0000-7000-8000-000000000005",
  "019f0000-0000-7000-8000-000000000006"
] as const;

test.beforeAll(async () => {
  await mkdir(artifactDirectory, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-08-15T15:05:00.000Z"));
});

test("updates Mission Control live without layout, focus, or scroll instability", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const catalog = await installSessionCatalogBrowserStream(page);
  const api = await installMissionControlApi(page, "mixed", {
    catalogStream: false
  });
  await page.goto("/");
  await expect(page.getByRole("link", { name: "release-approval" })).toBeVisible();
  await expect.poll(async () => (await catalog.requestUrls()).length).toBe(1);

  const entries = nativeIds.map((_, index) => catalogEntry(index + 1));
  await pushBootstrap(catalog, 100, entries, streamA);
  await expect(page.getByRole("link", { name: "catalog-live-1" })).toBeVisible();
  await expect(page.getByRole("link", { name: "release-approval" })).toHaveCount(0);
  await expect(page.getByText("6 sessions", { exact: true })).toBeVisible();

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await expectNoHorizontalOverflow(page, viewport.width);
    await expectStableTargets(page);
    await page.screenshot({
      path: resolve(
        artifactDirectory,
        `catalog-current-${viewport.width}x${viewport.height}.png`
      ),
      animations: "disabled"
    });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  const focusedSession = page.getByRole("link", { name: "catalog-live-5" });
  await focusedSession.scrollIntoViewIfNeeded();
  await focusedSession.focus();
  await expect(focusedSession).toBeFocused();
  const scrollBefore = await page.evaluate(() => window.scrollY);

  await catalog.push(
    upsertEvent(
      108,
      catalogEntry(5, {
        attention: "needs_input",
        summary: "Phone-visible laptop update.",
        turnState: "waiting_for_input",
        updatedAt: laterTimestamp
      }),
      streamA
    )
  );
  await expect(page.getByText("Phone-visible laptop update.", { exact: true })).toBeVisible();
  await expect(focusedSession).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
  await expectNoHorizontalOverflow(page, 390);

  await catalog.push(boundaryEvent(109, streamA));
  await expect(
    page.getByText("Session list resynchronizing", { exact: true })
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "catalog-live-5" })).toBeVisible();
  await page.screenshot({
    path: resolve(artifactDirectory, "catalog-boundary-390x844.png"),
    animations: "disabled"
  });

  await catalog.closeConnections();
  await expect.poll(async () => (await catalog.requestUrls()).length).toBe(2);
  expect((await catalog.requestUrls())[1]).toContain("?after=109");
  const replacement = catalogEntry(1, {
    name: "catalog-replacement",
    summary: "Replacement snapshot committed atomically.",
    updatedAt: laterTimestamp
  });
  await catalog.push(resetEvent(200, 1, streamB));
  await catalog.push(upsertEvent(201, replacement, streamB));
  await expect(page.getByRole("link", { name: "catalog-live-5" })).toBeVisible();
  await expect(page.getByRole("link", { name: "catalog-replacement" })).toHaveCount(0);
  await catalog.push(readyEvent(202, 1, streamB));
  await expect(page.getByRole("link", { name: "catalog-replacement" })).toBeVisible();
  await expect(page.getByRole("link", { name: "catalog-live-5" })).toHaveCount(0);
  await expect(page.getByText("Current", { exact: true })).toBeVisible();

  expect(
    missionRequestPaths(api).filter((path) => path === "/api/v1/sessions")
  ).toHaveLength(1);
  await expectCleanBrowser(page, diagnostics);
});

test("makes a catalog-removed selected session unavailable and removes controls", async ({
  page
}) => {
  const diagnostics = observePage(page);
  const catalog = await installSessionCatalogBrowserStream(page);
  await installSessionDetailApi(page, "active", { catalogStream: false });
  await page.goto(`/sessions/${sessionDetailBrowserSessionId}`);
  await expect
    .poll(async () => ({
      body: await page.locator("body").innerText(),
      consoleErrors: diagnostics.consoleErrors,
      pageErrors: diagnostics.pageErrors
    }))
    .toMatchObject({
      body: expect.stringContaining(
        "The structured mobile session feed is ready for device validation."
      ),
      consoleErrors: [],
      pageErrors: []
    });
  await expect.poll(async () => (await catalog.requestUrls()).length).toBe(1);

  await catalog.push(resetEvent(1, 0, streamA));
  await catalog.push(readyEvent(2, 0, streamA));
  await expect(
    page.getByText("Session no longer active", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText(
      "This session left the live laptop catalog. Return to Mission Control to choose another session.",
      { exact: true }
    )
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: /prompt for/u })).toHaveCount(0);
  await expect(page.locator(".hostdeck-session-controls")).toHaveCount(0);
  await expectNoHorizontalOverflow(page, 390);
  await page.screenshot({
    path: resolve(artifactDirectory, "selected-removed-390x844.png"),
    animations: "disabled"
  });
  await expectCleanBrowser(page, diagnostics);
});

async function pushBootstrap(
  controller: SessionCatalogBrowserController,
  resetCursor: number,
  entries: readonly SharedSessionCatalogEntry[],
  streamId: string
): Promise<void> {
  await controller.push(resetEvent(resetCursor, entries.length, streamId));
  for (const [index, entry] of entries.entries()) {
    await controller.push(upsertEvent(resetCursor + index + 1, entry, streamId));
  }
  await controller.push(
    readyEvent(resetCursor + entries.length + 1, entries.length, streamId)
  );
}

function resetEvent(
  cursor: number,
  expectedSessionCount: number,
  streamId: string
): SessionCatalogEvent {
  return sessionCatalogEventSchema.parse({
    stream_id: streamId,
    cursor,
    emitted_at: timestamp,
    type: "catalog_reset",
    reason: "initial",
    expected_session_count: expectedSessionCount
  });
}

function upsertEvent(
  cursor: number,
  session: SharedSessionCatalogEntry,
  streamId: string
): SessionCatalogEvent {
  return sessionCatalogEventSchema.parse({
    stream_id: streamId,
    cursor,
    emitted_at: session.projection.updated_at,
    type: "session_upsert",
    session
  });
}

function readyEvent(
  cursor: number,
  sessionCount: number,
  streamId: string
): SessionCatalogEvent {
  return sessionCatalogEventSchema.parse({
    stream_id: streamId,
    cursor,
    emitted_at: sessionCount === 1 && cursor >= 200 ? laterTimestamp : timestamp,
    type: "catalog_ready",
    session_count: sessionCount,
    endpoint_generation: 11
  });
}

function boundaryEvent(cursor: number, streamId: string): SessionCatalogEvent {
  return sessionCatalogEventSchema.parse({
    stream_id: streamId,
    cursor,
    emitted_at: laterTimestamp,
    type: "catalog_boundary",
    reason: "lag",
    reset_required: true,
    detail: "Catalog receiver must reconnect."
  });
}

function catalogEntry(
  index: number,
  options: {
    readonly attention?: "none" | "needs_input";
    readonly name?: string;
    readonly summary?: string;
    readonly turnState?: "completed" | "waiting_for_input";
    readonly updatedAt?: string;
  } = {}
): SharedSessionCatalogEntry {
  const nativeThreadId = nativeIds[index - 1];
  if (nativeThreadId === undefined) throw new TypeError("Catalog fixture index is invalid.");
  const id = `sess_catalog_live_${String(index)}`;
  const name = options.name ?? `catalog-live-${String(index)}`;
  const cwd = `/workspace/catalog-live-${String(index)}`;
  const updatedAt = options.updatedAt ?? timestamp;
  return sharedSessionCatalogEntrySchema.parse({
    tracked: {
      native_thread_id: nativeThreadId,
      internal_session_id: id,
      alias: name,
      cwd,
      project_cue: `catalog-live-${String(index)}`,
      branch: "main",
      runtime_version: "0.147.0",
      runtime_source: "codex_app_server",
      enrollment_origin: "loaded_before",
      archived: false,
      created_at: timestamp,
      updated_at: updatedAt,
      archived_at: null
    },
    projection: {
      id,
      name,
      codex_thread_id: nativeThreadId,
      cwd,
      runtime_source: "codex_app_server",
      runtime_version: "0.147.0",
      created_at: timestamp,
      archived_at: null,
      session_state: "active",
      turn_state: options.turnState ?? "completed",
      attention: options.attention ?? "none",
      freshness: "current",
      freshness_reason: null,
      updated_at: updatedAt,
      last_activity_at: updatedAt,
      branch: "main",
      model: "gpt-5.5-codex",
      settings: null,
      goal: null,
      recent_summary: options.summary ?? `Live catalog session ${String(index)}.`,
      last_event_cursor: null
    }
  });
}

function observePage(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return { consoleErrors, pageErrors };
}

async function expectNoHorizontalOverflow(
  page: Page,
  expectedWidth: number
): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth
      }))
    )
    .toEqual({ clientWidth: expectedWidth, scrollWidth: expectedWidth });
}

async function expectStableTargets(page: Page): Promise<void> {
  const refresh = page.getByRole("button", { name: "Refresh sessions" });
  expect(await refresh.boundingBox()).toMatchObject({ width: 44, height: 44 });
  const links = page.locator(".hostdeck-session-row__link:visible");
  for (let index = 0; index < (await links.count()); index += 1) {
    expect((await links.nth(index).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
      44
    );
  }
}

async function expectCleanBrowser(
  page: Page,
  diagnostics: ReturnType<typeof observePage>
): Promise<void> {
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
  expect(await page.locator("body").innerText()).not.toContain("/workspace/");
  expect(await page.locator("body").innerText()).not.toContain(nativeIds[0]);
}
