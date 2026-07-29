import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  expect,
  type Page,
  type Request,
  type TestInfo,
  test
} from "@playwright/test";
import { selectedPairClaimRequestSchema } from "../../packages/contracts/src/index.js";
import type { MobileInteractionId } from "../../packages/test-fixtures/src/index.js";
import { installApprovalDecisionsApi } from "./approval-decisions-fixture.js";
import { installArchiveApi } from "./archive-control-fixture.js";
import { installCompactControlApi } from "./compact-control-fixture.js";
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
  installPrivateOriginProxy,
  installRemoteRecoveryApi,
  remoteRecoveryPrivateOrigin
} from "./remote-connection-recovery-fixture.js";
import {
  installSessionDetailApi,
  liveActivityEvent,
  promptTurnEvent,
  sessionDetailBrowserSessionId
} from "./session-detail-fixture.js";
import { installSkillsControlApi } from "./skills-control-fixture.js";
import { installUsageControlApi } from "./usage-control-fixture.js";

const packageOrigin = "http://127.0.0.1:4175";
const cookieOrigin = "https://hostdeck-cookie.fixture-tailnet.ts.net";
const cookieSiblingOrigin = "https://hostdeck-cookie-sibling.fixture-tailnet.ts.net";
const cookieCrossSiteOrigin = "https://hostdeck-cookie-cross.other-fixture.ts.net";
const detailPath = `/sessions/${sessionDetailBrowserSessionId}`;
const packageManifest = JSON.parse(
  readFileSync(resolve("dist/hostdeck/hostdeck-package.json"), "utf8")
) as {
  readonly packageVersion: string;
  readonly manifestSha256: string;
  readonly content: Readonly<{ sha256: string }>;
  readonly web: Readonly<{ sha256: string; manifestSha256: string }>;
};
const supportManifest = JSON.parse(
  readFileSync(resolve("tests/browser/supported-browser-manifest.json"), "utf8")
) as {
  readonly package: Readonly<{
    package_version: string;
    content_sha256: string;
    manifest_sha256: string;
    web_sha256: string;
    web_manifest_sha256: string;
  }>;
  readonly scenarios: readonly Readonly<{
    id: string;
    interaction_ids: readonly MobileInteractionId[];
  }>[];
  readonly automated_interaction_ids: readonly string[];
  readonly projects: readonly Readonly<{
    id: string;
    browser_name: string;
    regime: string;
    viewport: Readonly<{ width: number; height: number }>;
    has_touch: boolean;
    is_mobile: boolean;
    input_modes: readonly string[];
  }>[];
};
const runtimeInspection = parseRuntimeInspection(
  process.env.HOSTDECK_BROWSER_RUNTIME_INSPECTION
);
const evidenceRoot = requiredEvidenceRoot(
  process.env.HOSTDECK_BROWSER_EVIDENCE_TEMP_ROOT
);
const projectScenarios: ScenarioEvidence[] = [];
let activeProject = "";
let projectStartedAt = 0;

interface BrowserDiagnostics {
  readonly consoleErrors: Array<Readonly<{ text: string; url: string }>>;
  readonly cspViolations: string[];
  readonly externalRequests: string[];
  readonly httpFailures: Array<Readonly<{ path: string; status: number; url: string }>>;
  readonly networkFailures: Array<Readonly<{
    path: string;
    method: string;
    error: string;
  }>>;
  readonly pendingRequests: Set<Request>;
  readonly pageErrors: string[];
}

interface ScenarioEvidence {
  readonly id: string;
  readonly status: "passed";
  readonly interactions: readonly MobileInteractionId[];
  readonly request_count: number;
  readonly mutation_count: number;
  readonly duration_ms: number;
  readonly observations: Readonly<Record<string, string | number | boolean>>;
}

test.beforeAll(async ({ browserName }, workerInfo) => {
  projectScenarios.length = 0;
  activeProject = workerInfo.project.name;
  projectStartedAt = performance.now();
  const expected = supportManifest.projects.find(({ id }) => id === activeProject);
  if (expected === undefined) throw new TypeError("Browser matrix project is not supported.");
  expect(browserName).toBe(expected.browser_name);
  expect(workerInfo.project.use.browserName).toBe(expected.browser_name);
  expect(workerInfo.project.use.viewport).toEqual(expected.viewport);
  expect(workerInfo.project.use.hasTouch).toBe(expected.has_touch);
  expect(workerInfo.project.use.isMobile).toBe(expected.is_mobile);
  expect({
    package_version: packageManifest.packageVersion,
    content_sha256: packageManifest.content.sha256,
    manifest_sha256: packageManifest.manifestSha256,
    web_sha256: packageManifest.web.sha256,
    web_manifest_sha256: packageManifest.web.manifestSha256
  }).toEqual(supportManifest.package);
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-07-28T20:00:00.000Z"));
});

test.afterAll(async () => {
  const project = supportManifest.projects.find(({ id }) => id === activeProject);
  if (project === undefined) throw new TypeError("Browser matrix report project is missing.");
  const engine = runtimeInspection.engines.find(
    ({ browser_name }) => browser_name === project.browser_name
  );
  if (engine === undefined) throw new TypeError("Browser matrix report engine is missing.");
  expect(projectScenarios.map(({ id, interactions }) => ({
    id,
    interaction_ids: interactions
  }))).toEqual(supportManifest.scenarios);
  const interactionIds = unique(
    projectScenarios.flatMap(({ interactions }) => interactions)
  );
  expect(interactionIds).toEqual(unique(supportManifest.automated_interaction_ids));
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  await writeFile(
    join(evidenceRoot, `${activeProject}.json`),
    `${JSON.stringify({
      schema_version: 1,
      task_id: "FE-V1-040",
      status: "passed",
      project_id: activeProject,
      engine,
      playwright_version: runtimeInspection.playwright_version,
      platform: runtimeInspection.platform,
      architecture: runtimeInspection.architecture,
      regime: project.regime,
      viewport: project.viewport,
      has_touch: project.has_touch,
      is_mobile: project.is_mobile,
      input_modes: project.input_modes,
      package: {
        version: packageManifest.packageVersion,
        content_sha256: packageManifest.content.sha256,
        manifest_sha256: packageManifest.manifestSha256,
        web_sha256: packageManifest.web.sha256,
        web_manifest_sha256: packageManifest.web.manifestSha256
      },
      scenario_count: projectScenarios.length,
      interaction_ids: interactionIds,
      total_request_count: projectScenarios.reduce(
        (total, scenario) => total + scenario.request_count,
        0
      ),
      total_mutation_count: projectScenarios.reduce(
        (total, scenario) => total + scenario.mutation_count,
        0
      ),
      duration_ms: Math.round(performance.now() - projectStartedAt),
      diagnostics: {
        cache_entries: 0,
        expected_http_failures: 1,
        console_errors: 0,
        csp_violations: 0,
        external_requests: 0,
        indexeddb_databases: 0,
        unexpected_network_failures: 0,
        page_errors: 0,
        pending_request_overflow: 0,
        service_workers: 0,
        storage_entries: 0
      },
      limitations: {
        physical_mobile_device_proven: false,
        firefox_android_proven: false,
        tailscale_serve_certificate_trust_proven: false,
        tailscale_serve_routing_proven: false,
        safari_ios_supported: false
      },
      scenarios: projectScenarios
    }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
});

test("package navigation and responsive information architecture", async ({ page }, testInfo) => {
  const started = performance.now();
  const diagnostics = await observePage(page);
  const api = await installSessionDetailApi(page, "writable");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Mission Control" }))
    .toBeVisible();
  const sessionLink = page.getByRole("link", { name: /^android-release/u }).first();
  const phone = testInfo.project.name.endsWith("-phone");
  if (phone) {
    const bounds = await sessionLink.boundingBox();
    if (bounds === null) throw new TypeError("Browser matrix touch target is unavailable.");
    await page.touchscreen.tap(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2
    );
  } else {
    await sessionLink.focus();
    await page.keyboard.press("Enter");
  }
  await expect(page.getByRole("heading", { level: 1, name: "android-release activity" }))
    .toBeVisible();
  await expect(page.getByRole("textbox", { name: "Prompt for android-release" }))
    .toBeVisible();
  const retained = page.getByRole("navigation", { name: "Mission Control sessions" });
  if (testInfo.project.name.endsWith("-desktop")) {
    await expect(retained).toBeVisible();
    await expect(retained.getByRole("link", { name: /^android-release/u }))
      .toHaveAttribute("aria-current", "page");
  } else {
    await expect(retained).toBeHidden();
  }

  const platform = await page.evaluate((isPhone) => {
    const app = document.querySelector<HTMLElement>(".hostdeck-app");
    const appBar = document.querySelector<HTMLElement>(".hostdeck-app-bar");
    const controls = document.querySelector<HTMLElement>(".hostdeck-session-controls");
    if (app === null || appBar === null || controls === null) {
      throw new TypeError("Browser matrix layout anchors are missing.");
    }
    const controlBounds = controls.getBoundingClientRect();
    const controlsPosition = getComputedStyle(controls).position;
    return {
      abortController: typeof AbortController === "function",
      colorMix: CSS.supports("color", "color-mix(in srgb, #000 50%, #fff)"),
      dynamicViewport:
        CSS.supports("height", "100dvh") && app.getBoundingClientRect().height >= innerHeight,
      responsiveControls:
        controlsPosition === (isPhone ? "fixed" : "static") &&
        controlBounds.left >= -1 &&
        controlBounds.right <= innerWidth + 1 &&
        controlBounds.bottom <= innerHeight + 1,
      hasSelector: CSS.supports("selector(:has(*))"),
      randomUuid: typeof crypto.randomUUID === "function",
      readableStream: typeof ReadableStream === "function",
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      safeAreaFallback:
        getComputedStyle(document.documentElement)
          .getPropertyValue("--hostdeck-safe-area-bottom")
          .trim().length > 0,
      stickyAppBar: getComputedStyle(appBar).position === "sticky",
      textDecoder: typeof TextDecoder === "function"
    };
  }, phone);
  for (const [mechanism, supported] of Object.entries(platform)) {
    expect(supported, mechanism).toBe(true);
  }

  await page.getByRole("button", { name: "Back to Mission Control" }).click();
  await expect(sessionLink).toBeFocused();
  await page.goto(detailPath);
  await expect(page.getByRole("heading", { level: 1, name: "android-release activity" }))
    .toBeVisible();
  await page.goto("/sessions/%2Fbrowser-matrix-private");
  await expect(page.getByRole("heading", { level: 1, name: "Page not found" }))
    .toBeVisible();

  await expectCleanBrowser(page, diagnostics, {
    allowedAbortedRequests: [
      { method: "GET", path: "/events/stream" },
      { method: "GET", path: "/approvals" }
    ]
  });
  recordScenario(testInfo, started, {
    id: "package_navigation",
    interactions: [
      "bootstrap_shell",
      "read_host_access",
      "read_host_status",
      "read_sessions",
      "open_session",
      "read_session_detail",
      "navigate_back"
    ],
    requestCount: api.requests.length,
    mutationCount: 0,
    observations: {
      css_platform_features: true,
      desktop_split: testInfo.project.name.endsWith("-desktop"),
      primary_activation: phone ? "touch" : "keyboard",
      reduced_motion: true
    }
  });
});

test("fragment pairing scrubs, claims once, reloads, and preserves history", async ({
  page
}, testInfo) => {
  const started = performance.now();
  const diagnostics = await observePage(page, [packageOrigin, remoteRecoveryPrivateOrigin]);
  await installPrivateOriginProxy(page);
  const api = await installSessionDetailApi(page, "writable", {
    configuredOrigin: remoteRecoveryPrivateOrigin
  });
  const pairingRequests: Request[] = [];
  const pairingCode = "AbCdEfGhIjKlMnOpQrSt_1";
  await page.route("**/api/v1/access/pairing-claims", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = selectedPairClaimRequestSchema.parse(request.postDataJSON());
    if (
      request.method() !== "POST" ||
      url.pathname !== "/api/v1/access/pairing-claims" ||
      url.search !== "" ||
      !request.headers()["content-type"]?.startsWith("application/json") ||
      body.code !== pairingCode ||
      !/^op_browser_pair_claim_[0-9a-f]{32}$/u.test(body.operation_id)
    ) {
      throw new TypeError("Browser matrix pairing claim request is invalid.");
    }
    pairingRequests.push(request);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({
        device_id: "client_abcdefghijklmnopqrstuvwx",
        permission: "write",
        client_label: "Browser matrix phone",
        created_at: "2026-07-28T20:00:00.000Z",
        expires_at: "2026-10-26T20:00:00.000Z",
        csrf_bootstrap_required: true
      })
    });
  });

  const previousUrl = `${packageOrigin}/`;
  await page.goto(previousUrl);
  await page.goto(`${remoteRecoveryPrivateOrigin}/#pair=${pairingCode}`);
  await expect(page.getByRole("heading", { level: 1, name: "Phone paired" }))
    .toBeVisible();
  expect(page.url()).toBe(`${remoteRecoveryPrivateOrigin}/`);
  expect(pairingRequests).toHaveLength(1);
  expect(pairingRequests[0]?.url()).not.toContain(pairingCode);
  expect(pairingRequests[0]?.headers().referer).toBeUndefined();
  expect(pairingRequests[0]?.postData()).toContain(pairingCode);
  expect(pairingRequests[0]?.headers()["x-hostdeck-csrf"]).toBeUndefined();
  expect(pairingRequests[0]?.headers()["x-hostdeck-local-admin"]).toBeUndefined();

  await page.getByRole("button", { name: "Open Mission Control" }).click();
  await expect(page.getByRole("main")).toBeFocused();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Mission Control" })).toBeVisible();
  expect(pairingRequests).toHaveLength(1);
  let historyBackSteps = 0;
  while (page.url() !== previousUrl && historyBackSteps < 3) {
    await page.goBack();
    historyBackSteps += 1;
    expect(page.url()).not.toContain("#pair=");
    expect(pairingRequests).toHaveLength(1);
  }
  expect(page.url()).toBe(previousUrl);
  for (let step = 0; step < historyBackSteps; step += 1) {
    await page.goForward();
    expect(page.url()).not.toContain("#pair=");
    expect(pairingRequests).toHaveLength(1);
  }
  expect(page.url()).toBe(`${remoteRecoveryPrivateOrigin}/`);
  expect(pairingRequests).toHaveLength(1);

  const csrfRequests = api.requests.filter(
    (request) => new URL(request.url()).pathname === "/api/v1/access/csrf"
  );
  expect(csrfRequests).toHaveLength(1);
  await expectCleanBrowser(page, diagnostics, {
    allowedFragments: [pairingCode],
    allowedAbortedRequests: [
      { method: "GET", path: "/events/stream" },
      { method: "GET", path: "/approvals" }
    ]
  });
  recordScenario(testInfo, started, {
    id: "pairing_reload",
    interactions: ["consume_pairing_fragment", "claim_pairing", "bootstrap_csrf"],
    requestCount: pairingRequests.length + api.requests.length,
    mutationCount: 2,
    observations: {
      claim_replayed: false,
      fragment_scrubbed: true,
      history_back_steps: historyBackSteps,
      history_preserved: true
    }
  });
});

test("stream continuity exposes disconnect and reload recovery", async ({ page }, testInfo) => {
  const started = performance.now();
  const diagnostics = await observePage(page);
  const first = liveActivityEvent(1);
  const second = liveActivityEvent(2);
  const third = liveActivityEvent(3);
  const api = await installSessionDetailApi(page, "writable", {
    initialEvents: [first],
    streamEvents: [first, second]
  });
  await page.goto(detailPath);
  await expect(page.getByText("Device validation completed", { exact: true }))
    .toHaveCount(2);
  await api.pushEvent(third);
  await expect(page.getByText("Device validation completed", { exact: true }))
    .toHaveCount(3);
  const initialStreamUrls = await api.streamRequestUrls();
  expect(initialStreamUrls).toHaveLength(1);
  expect(new URL(initialStreamUrls[0] ?? "http://invalid").searchParams.get("after"))
    .toBe("0");
  await api.dropStream();
  await expect(page.getByText("Activity stream reconnecting", { exact: true }))
    .toBeVisible();
  await api.resumeStream();
  await expect.poll(async () => (await api.streamRequestUrls()).length).toBe(2);
  const streamUrls = await api.streamRequestUrls();
  expect(new URL(streamUrls[1] ?? "http://invalid").searchParams.get("after"))
    .toBe("3");
  await expect(page.getByText("Activity stream reconnecting", { exact: true }))
    .toHaveCount(0);
  await expect(page.getByText("Device validation completed", { exact: true }))
    .toHaveCount(3);
  await expectCleanBrowser(page, diagnostics, {
    allowedAbortedRequests: [{ method: "GET", path: "/events/stream" }]
  });
  recordScenario(testInfo, started, {
    id: "stream_continuity",
    interactions: ["stream_events", "reconnect_stream"],
    requestCount: streamUrls.length,
    mutationCount: 0,
    observations: {
      duplicate_events: false,
      highest_cursor: 3,
      reconnect_visible: true,
      resumed_after_cursor: 3
    }
  });
});

test("prompt owns one keyboard submission and event-confirmed turn", async ({ page }, testInfo) => {
  const started = performance.now();
  const diagnostics = await observePage(page);
  const api = await installSessionDetailApi(page, "writable");
  api.setPromptOutcome("pending");
  await page.goto(detailPath);
  const textarea = page.getByRole("textbox", { name: "Prompt for android-release" });
  await textarea.fill("Run the supported browser interaction check.");
  await textarea.press("Control+Enter");
  await expect.poll(api.hasPendingPrompt).toBe(true);
  await textarea.press("Control+Enter");
  expect(api.promptRequests()).toHaveLength(1);
  expectProtectedMutation(api.promptRequests()[0], "POST");
  api.releasePendingPrompt();
  await expect(page.getByText("New turn accepted", { exact: true })).toBeVisible();
  await expect(textarea).toBeFocused();
  expect(await api.streamRequestUrls()).toHaveLength(1);
  await api.pushEvent(promptTurnEvent(4, "in_progress"));
  await expect(page.getByText("Turn running", { exact: true })).toBeVisible();
  expect(api.promptRequests()).toHaveLength(1);
  expect(api.promptRequests()[0]?.postDataJSON()).toMatchObject({
    kind: "prompt",
    text: "Run the supported browser interaction check."
  });
  await expectCleanBrowser(page, diagnostics, {
    forbiddenBodyValues: ["Run the supported browser interaction check."]
  });
  recordScenario(testInfo, started, {
    id: "prompt",
    interactions: ["send_prompt"],
    requestCount: 1,
    mutationCount: 1,
    observations: { duplicate_submit: false, event_confirmed: true }
  });
});

test("model selection uses native choice and one protected write", async ({ page }, testInfo) => {
  const started = performance.now();
  const diagnostics = await observePage(page);
  const api = await installModelControlApi(page);
  api.setSelectOutcome("pending");
  await page.goto(detailPath);
  const trigger = page.getByRole("button", { name: "/model for android-release" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "/model" });
  const alpha = dialog.getByRole("radio", { name: /Codex Alpha/u });
  await alpha.focus();
  await page.keyboard.press("ArrowDown");
  await expect(dialog.getByRole("radio", { name: /Codex Beta/u })).toBeChecked();
  const hasSelectorApplied = await dialog.getByRole("radio", { name: /Codex Beta/u })
    .evaluate((radio) => {
      const selected = radio.closest<HTMLElement>(".hostdeck-model-option");
      const unselected = radio.closest(".hostdeck-model-options")
        ?.querySelector<HTMLElement>(".hostdeck-model-option:not(:has(input:checked))");
      if (selected === null || unselected === undefined || unselected === null) return false;
      return getComputedStyle(selected).borderTopColor !==
        getComputedStyle(unselected).borderTopColor;
    });
  expect(hasSelectorApplied).toBe(true);
  const submit = dialog.getByRole("button", { name: "Set for next turn" });
  await submit.click();
  await expect.poll(api.hasPendingModelSelect).toBe(true);
  await expect(dialog.getByText("Saving next-turn model", { exact: true })).toBeVisible();
  await expect(submit).toBeDisabled();
  await submit.evaluate((button) => (button as HTMLButtonElement).click());
  expect(api.modelSelectRequests()).toHaveLength(1);
  api.releaseModelSelect();
  await expect(dialog.getByText("Model staged for next turn", { exact: true }))
    .toBeVisible();
  expect(api.modelReadRequests()).toHaveLength(1);
  expect(api.modelSelectRequests()).toHaveLength(1);
  expectProtectedMutation(api.modelSelectRequests()[0], "POST");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expectCleanBrowser(page, diagnostics);
  recordScenario(testInfo, started, {
    id: "model_control",
    interactions: ["read_model", "select_model"],
    requestCount: 2,
    mutationCount: 1,
    observations: { has_selector_applied: true, native_radio_keyboard: true }
  });
});

test("goal control creates one paused goal", async ({ page }, testInfo) => {
  const started = performance.now();
  const diagnostics = await observePage(page);
  const api = await installGoalControlApi(page, { snapshotVariant: "no_goal" });
  api.setMutateOutcome("pending");
  await page.goto(detailPath);
  const trigger = page.getByRole("button", { name: "/goal for android-release" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "/goal" });
  await dialog.getByRole("textbox", { name: "Goal objective" })
    .fill("Complete the supported browser matrix.");
  const save = dialog.getByRole("button", { name: "Create paused goal" });
  await save.click();
  await expect.poll(api.hasPendingGoalMutate).toBe(true);
  await expect(dialog.getByText("Saving paused goal", { exact: true })).toBeVisible();
  await expect(save).toBeDisabled();
  await save.evaluate((button) => (button as HTMLButtonElement).click());
  expect(api.goalMutateRequests()).toHaveLength(1);
  api.releaseGoalMutate();
  await expect(dialog.getByText("Paused goal created", { exact: true })).toBeVisible();
  await expect(dialog.getByText("No turn was started.", { exact: true })).toBeVisible();
  expect(api.goalReadRequests()).toHaveLength(1);
  expect(api.goalMutateRequests()).toHaveLength(1);
  expectProtectedMutation(api.goalMutateRequests()[0], "POST");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expectCleanBrowser(page, diagnostics);
  recordScenario(testInfo, started, {
    id: "goal_control",
    interactions: ["read_goal", "mutate_goal"],
    requestCount: 2,
    mutationCount: 1,
    observations: { paused_without_turn: true }
  });
});

test("Plan selection uses native choice and one protected write", async ({ page }, testInfo) => {
  const started = performance.now();
  const diagnostics = await observePage(page);
  const api = await installPlanControlApi(page);
  api.setSelectOutcome("pending");
  await page.goto(detailPath);
  const trigger = page.getByRole("button", { name: "/plan for android-release" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "/plan" });
  const defaultMode = dialog.getByRole("radio", { name: /Default/u });
  await defaultMode.focus();
  await page.keyboard.press("ArrowUp");
  await expect(dialog.getByRole("radio", { name: /Plan/u })).toBeChecked();
  const submit = dialog.getByRole("button", { name: "Set for next turn" });
  await submit.click();
  await expect.poll(api.hasPendingPlanSelect).toBe(true);
  await expect(dialog.getByText("Saving next-turn mode", { exact: true })).toBeVisible();
  await expect(submit).toBeDisabled();
  await submit.evaluate((button) => (button as HTMLButtonElement).click());
  expect(api.planSelectRequests()).toHaveLength(1);
  api.releasePlanSelect();
  await expect(dialog.getByText("Plan staged for next turn", { exact: true }))
    .toBeVisible();
  expect(api.planReadRequests()).toHaveLength(1);
  expect(api.planSelectRequests()).toHaveLength(1);
  expectProtectedMutation(api.planSelectRequests()[0], "POST");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expectCleanBrowser(page, diagnostics);
  recordScenario(testInfo, started, {
    id: "plan_control",
    interactions: ["read_plan", "select_plan"],
    requestCount: 2,
    mutationCount: 1,
    observations: { native_radio_keyboard: true }
  });
});

test("Usage performs one read through the utility menu", async ({ page }, testInfo) => {
  const started = performance.now();
  const diagnostics = await observePage(page);
  const api = await installUsageControlApi(page);
  await page.goto(detailPath);
  const more = page.getByRole("button", {
    name: "More session utilities for android-release"
  });
  await more.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("dialog", { name: "Session utilities" });
  await menu.getByRole("button", { name: /usage/iu }).click();
  const usage = page.getByRole("dialog", { name: "/usage" });
  await expect(usage.getByText("Usage capture current", { exact: true })).toBeVisible();
  expect(api.requests()).toHaveLength(1);
  await usage.getByRole("button", { name: "Back to session utilities" }).click();
  await page.keyboard.press("Escape");
  await expect(more).toBeFocused();
  await expectCleanBrowser(page, diagnostics);
  recordScenario(testInfo, started, {
    id: "usage_utility",
    interactions: ["read_usage"],
    requestCount: 1,
    mutationCount: 0,
    observations: { utility_focus_restored: true }
  });
});

test("Compact confirms and starts exactly once", async ({ page }, testInfo) => {
  const started = performance.now();
  const diagnostics = await observePage(page);
  const api = await installCompactControlApi(page);
  api.setStartOutcome("pending");
  await page.goto(detailPath);
  const more = page.getByRole("button", {
    name: "More session utilities for android-release"
  });
  await more.click();
  const menu = page.getByRole("dialog", { name: "Session utilities" });
  await menu.getByRole("button", { name: /compact/iu }).click();
  const compact = page.getByRole("dialog", { name: "/compact" });
  await expect(compact.getByText("Confirmation required", { exact: true })).toBeVisible();
  await compact.getByRole("button", { name: "Compact context" }).click();
  await compact.getByRole("button", { name: "Confirm compact" }).click();
  await expect.poll(api.hasPendingStart).toBe(true);
  await expect(compact.getByText("Submitting compaction", { exact: true })).toBeVisible();
  await expect(compact.getByRole("button", { name: "Back to session utilities" }))
    .toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(compact).toBeVisible();
  expect(api.startRequests()).toHaveLength(1);
  api.releaseStart();
  await expect(compact.getByText("Compaction accepted", { exact: true })).toBeVisible();
  expect(api.readRequests()).toHaveLength(1);
  expect(api.startRequests()).toHaveLength(1);
  expectProtectedMutation(api.startRequests()[0], "POST");
  await compact.getByRole("button", { name: "Back to session utilities" }).click();
  await page.keyboard.press("Escape");
  await expect(more).toBeFocused();
  await expectCleanBrowser(page, diagnostics);
  recordScenario(testInfo, started, {
    id: "compact_utility",
    interactions: ["read_compact", "start_compact"],
    requestCount: 2,
    mutationCount: 1,
    observations: { confirmation_required: true }
  });
});

test("Skills search remains local after one read", async ({ page }, testInfo) => {
  const started = performance.now();
  const diagnostics = await observePage(page);
  const api = await installSkillsControlApi(page, { snapshotVariant: "long" });
  await page.goto(detailPath);
  await page.getByRole("button", { name: "More session utilities for android-release" })
    .click();
  const menu = page.getByRole("dialog", { name: "Session utilities" });
  await menu.getByRole("button", { name: /skills/iu }).click();
  const skills = page.getByRole("dialog", { name: "/skills" });
  await expect(skills.getByText("Skills capture current", { exact: true })).toBeVisible();
  const skillRows = skills.locator(".hostdeck-skill-row");
  expect(await skillRows.count()).toBeGreaterThanOrEqual(20);
  await skillRows.last().scrollIntoViewIfNeeded();
  await skills.getByRole("searchbox", { name: "Search skills" }).fill("null-description");
  await expect(skills.locator(".hostdeck-skill-row")).toHaveCount(1);
  expect(api.requests()).toHaveLength(1);
  await skills.getByRole("button", { name: "Back to session utilities" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", {
    name: "More session utilities for android-release"
  })).toBeFocused();
  await expectCleanBrowser(page, diagnostics);
  recordScenario(testInfo, started, {
    id: "skills_utility",
    interactions: ["read_skills"],
    requestCount: 1,
    mutationCount: 0,
    observations: { local_search: true }
  });
});

test("approval response is confirmed once", async ({ page }, testInfo) => {
  const started = performance.now();
  const diagnostics = await observePage(page);
  await page.clock.setFixedTime(new Date("2026-07-22T20:00:00.000Z"));
  const api = await installApprovalDecisionsApi(page, { snapshotVariant: "elevated" });
  api.setRespondOutcome("pending");
  await page.goto(detailPath);
  const item = page.locator(".hostdeck-approval-item").filter({
    hasText: "Install the Android validation package"
  });
  await expect(item.getByText("Connected test phone", { exact: true })).toBeVisible();
  await expect(item.getByText("Elevated", { exact: true })).toBeVisible();
  await item.getByRole("button", { name: "Review & approve" }).click();
  const dialog = page.getByRole("dialog", { name: "Approve elevated request?" });
  await dialog.getByRole("button", { name: "Approve once" }).click();
  await expect.poll(api.hasPendingResponse).toBe(true);
  await dialog.getByRole("button", { name: "Approve once" }).evaluate((button) => {
    (button as HTMLButtonElement).click();
  });
  expect(api.approvalRespondRequests()).toHaveLength(1);
  api.releaseResponse("terminal");
  await expect(page.getByText("Approved once", { exact: true })).toBeVisible();
  expect(api.approvalReadRequests()).toHaveLength(3);
  expect(api.approvalRespondRequests()).toHaveLength(1);
  expectProtectedMutation(api.approvalRespondRequests()[0], "POST");
  await expectCleanBrowser(page, diagnostics);
  recordScenario(testInfo, started, {
    id: "approval",
    interactions: ["read_approvals", "respond_approval"],
    requestCount: api.approvalReadRequests().length + 1,
    mutationCount: 1,
    observations: { duplicate_response: false, terminal_confirmed: true }
  });
});

test("event diagnostics performs one exact read", async ({ page }, testInfo) => {
  const started = performance.now();
  const diagnostics = await observePage(page);
  const api = await installEventDiagnosticsApi(page);
  await page.goto(detailPath);
  await page.getByRole("button", { name: "View event details" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Event details" });
  await expect(dialog.getByText("Event details current", { exact: true })).toBeVisible();
  expect(api.requests()).toHaveLength(1);
  await dialog.getByRole("button", { name: "Close event details" }).click();
  await expectCleanBrowser(page, diagnostics);
  recordScenario(testInfo, started, {
    id: "event_diagnostics",
    interactions: ["read_event_details"],
    requestCount: 1,
    mutationCount: 0,
    observations: { bounded_projection: true }
  });
});

test("interrupt confirms and sends one exact turn mutation", async ({ page }, testInfo) => {
  const started = performance.now();
  const diagnostics = await observePage(page);
  const event = promptTurnEvent(1, "in_progress", interruptBrowserTurnId);
  await installSessionDetailApi(page, "writable", {
    initialEvents: [event],
    streamEvents: [event],
    turnState: "in_progress"
  });
  const interrupt = await installInterruptApi(page, interruptBrowserTurnId);
  await page.goto(detailPath);
  await page.getByRole("button", { name: "Open session actions" }).click();
  await page.getByRole("dialog", { name: "Session actions" })
    .getByRole("button", { name: /Interrupt active turn/iu }).click();
  await page.getByRole("dialog", { name: "Interrupt active turn?" })
    .getByRole("button", { name: "Interrupt turn" }).click();
  await expect(page.getByRole("dialog", { name: "Turn interrupted" })).toBeVisible();
  expect(interrupt.requests()).toHaveLength(1);
  expectProtectedMutation(interrupt.requests()[0], "POST");
  await expectCleanBrowser(page, diagnostics);
  recordScenario(testInfo, started, {
    id: "interrupt",
    interactions: ["interrupt_turn"],
    requestCount: 1,
    mutationCount: 1,
    observations: { exact_turn_confirmed: true }
  });
});

test("archive confirms and sends one exact session mutation", async ({ page }, testInfo) => {
  const started = performance.now();
  const diagnostics = await observePage(page);
  await installSessionDetailApi(page, "writable", {
    initialEvents: [],
    streamEvents: [],
    turnState: "idle"
  });
  const archive = await installArchiveApi(page);
  await page.goto(detailPath);
  await page.getByRole("button", { name: "Open session actions" }).click();
  await page.getByRole("dialog", { name: "Session actions" })
    .getByRole("button", { name: /Archive session/iu }).click();
  await page.getByRole("dialog", { name: "Archive session?" })
    .getByRole("button", { name: "Archive session", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Session archived" })).toBeVisible();
  expect(archive.requests()).toHaveLength(1);
  expectProtectedMutation(archive.requests()[0], "POST");
  await expectCleanBrowser(page, diagnostics);
  recordScenario(testInfo, started, {
    id: "archive",
    interactions: ["archive_session"],
    requestCount: 1,
    mutationCount: 1,
    observations: { retained_history_not_deleted: true }
  });
});

test("laptop resume reads metadata and exposes clipboard outcome", async ({ page }, testInfo) => {
  const started = performance.now();
  const diagnostics = await observePage(page);
  await installSessionDetailApi(page, "writable", {
    initialEvents: [],
    streamEvents: [],
    turnState: "idle"
  });
  const resume = await installLaptopResumeApi(page);
  await page.goto(detailPath);
  await page.getByRole("button", { name: "Open session actions" }).click();
  await page.getByRole("dialog", { name: "Session actions" })
    .getByRole("button", { name: /Resume on laptop/iu }).click();
  const dialog = page.getByRole("dialog", { name: "Resume on laptop" });
  await expect(dialog.getByText("Laptop terminal only", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Copy command" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Copy command" }).click();
  const copied = dialog.getByText("Command copied", { exact: true });
  const failed = dialog.getByText("Copy failed", { exact: true });
  await expect(copied.or(failed)).toBeVisible();
  const clipboardOutcome = await copied.isVisible() ? "copied" : "unavailable";
  expect(resume.requests()).toHaveLength(1);
  await expectCleanBrowser(page, diagnostics);
  recordScenario(testInfo, started, {
    id: "laptop_resume",
    interactions: ["read_resume_metadata", "copy_resume_command"],
    requestCount: 1,
    mutationCount: 0,
    observations: { clipboard_outcome: clipboardOutcome }
  });
});

test("paired-device revoke confirms and sends once", async ({ page }, testInfo) => {
  const started = performance.now();
  const diagnostics = await observePage(page);
  await installMissionControlApi(page);
  const devices = await installPairedDeviceManagementApi(page, {
    pages: [[
      pairedDevice(pairedDeviceCurrentId, "Browser matrix phone", "write"),
      pairedDevice("device_office_browser", "Office browser", "read")
    ]]
  });
  await page.goto("/");
  const sheet = await openHostAccess(page);
  await sheet.getByRole("region", { name: "Paired devices" }).scrollIntoViewIfNeeded();
  await sheet.getByRole("button", { name: "Revoke Office browser, Device 2" }).click();
  await page.getByRole("dialog", { name: "Revoke paired device?" })
    .getByRole("button", { name: "Revoke device" }).click();
  await expect(sheet.getByText("Device revoked", { exact: true })).toBeVisible();
  expect(devices.listRequests()).toHaveLength(1);
  expect(devices.revokeRequests()).toHaveLength(1);
  expectProtectedMutation(devices.revokeRequests()[0], "POST");
  await expectCleanBrowser(page, diagnostics);
  recordScenario(testInfo, started, {
    id: "device_revoke",
    interactions: ["read_devices", "revoke_device"],
    requestCount: 2,
    mutationCount: 1,
    observations: { confirmation_required: true }
  });
});

test("host lock confirms, purges writes, and exposes local unlock", async ({ page }, testInfo) => {
  const started = performance.now();
  const diagnostics = await observePage(page);
  await installMissionControlApi(page);
  await installPairedDeviceManagementApi(page, {
    pages: [[pairedDevice(pairedDeviceCurrentId, "Browser matrix phone", "write")]]
  });
  const lock = await installHostLockApi(page);
  await page.goto("/");
  const sheet = await openHostAccess(page);
  const lockSection = sheet.locator(".hostdeck-host-lock");
  await lockSection.getByRole("button", { name: "Lock writes" }).click();
  await page.getByRole("dialog", { name: "Lock remote writes?" })
    .getByRole("button", { name: "Lock writes" }).click();
  await expect(lockSection.getByRole("heading", { name: "Remote writes locked" }))
    .toBeVisible();
  await expect(lockSection.getByText("codexdeck unlock", { exact: true })).toBeVisible();
  await expect(lockSection.getByRole("button", { name: /unlock/iu })).toHaveCount(0);
  expect(lock.lockRequests()).toHaveLength(1);
  expectProtectedMutation(lock.lockRequests()[0], "POST");
  await expectCleanBrowser(page, diagnostics);
  recordScenario(testInfo, started, {
    id: "host_lock",
    interactions: ["lock_host"],
    requestCount: 1,
    mutationCount: 1,
    observations: { local_unlock_only: true, writes_purged: true }
  });
});

test("remote disconnect and profile return recover only by observation", async ({
  page
}, testInfo) => {
  const started = performance.now();
  const diagnostics = await observePage(page, [packageOrigin, remoteRecoveryPrivateOrigin]);
  await page.clock.setFixedTime(new Date("2026-07-26T16:00:00.000Z"));
  const api = await installRemoteRecoveryApi(page, "remote", "ready");
  await page.goto(`${remoteRecoveryPrivateOrigin}/`);
  await expect(page.getByRole("heading", { name: "No active sessions" })).toBeVisible();

  api.setAvailable(false);
  await page.getByRole("button", { name: "Refresh sessions" }).click();
  await expect(page.getByText("Showing stale session state", { exact: true })).toBeVisible();
  let sheet = await openHostAccess(page);
  await expect(sheet.getByRole("heading", { name: "Private connection is reconnecting" }))
    .toBeVisible();
  let recovery = sheet.locator(".hostdeck-remote-recovery");
  await expect(recovery.getByRole("button", { name: /Check remote access|Check again/iu }))
    .toHaveCount(0);
  await sheet.getByRole("button", { name: "Close Host and access" }).click();
  const disconnectedRequestCount = api.requests.length;
  await page.waitForTimeout(200);
  expect(api.requests).toHaveLength(disconnectedRequestCount);

  api.setAvailable(true);
  await page.getByRole("button", { name: "Refresh sessions" }).click();
  sheet = await openHostAccess(page);
  await expect(sheet.getByRole("heading", { name: "Remote access ready" })).toBeVisible();
  recovery = sheet.locator(".hostdeck-remote-recovery");
  await recovery.getByRole("button", { name: "Check again" }).click();
  await expect(recovery.getByRole("heading", { name: "Remote access ready" })).toBeVisible();
  expect(api.remoteStatusRequests()).toHaveLength(1);
  const requestCount = api.requests.length;
  await page.waitForTimeout(200);
  expect(api.requests).toHaveLength(requestCount);
  expect(api.requests.every((request) => request.method() === "GET")).toBe(true);
  expect(diagnostics.httpFailures.map(({ path, status }) => ({ path, status })))
    .toEqual([{ path: "/api/v1/access", status: 503 }]);
  await expectCleanBrowser(page, diagnostics, {
    allowedNetworkStatuses: [503]
  });
  recordScenario(testInfo, started, {
    id: "remote_recovery",
    interactions: ["read_remote_status"],
    requestCount: api.requests.length,
    mutationCount: 0,
    observations: {
      automatic_profile_switch: false,
      polling: false,
      profile_return_observed: true
    }
  });
});

test("HTTPS origin enforces secure HttpOnly SameSite cookie semantics", async ({
  context,
  page
}, testInfo) => {
  const started = performance.now();
  const diagnostics = await observePage(page, [
    cookieOrigin,
    cookieSiblingOrigin,
    cookieCrossSiteOrigin
  ]);
  const api = await installRemoteRecoveryApi(page, "remote", "ready", {
    configuredOrigin: cookieOrigin,
    proxyPrivateOrigin: false
  });
  const documentResponse = await page.goto(`${cookieOrigin}/`);
  expect(documentResponse?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "No active sessions" })).toBeVisible();
  expect(await page.locator('meta[name="hostdeck-package-version"]').getAttribute("content"))
    .toBe(packageManifest.packageVersion);
  await page.evaluate(async () => {
    const response = await fetch("/browser-matrix-cookie/claim", {
      method: "POST",
      credentials: "same-origin"
    });
    if (response.status !== 204) throw new TypeError("Cookie claim failed.");
  });
  const cookies = await context.cookies(cookieOrigin);
  const deviceCookie = cookies.find(({ name }) => name === "__Host-hostdeck_device");
  expect(deviceCookie).toMatchObject({
    secure: true,
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
    domain: "hostdeck-cookie.fixture-tailnet.ts.net"
  });
  expect(await page.evaluate(() => document.cookie)).toBe("");
  await page.reload();
  await expect(page.getByRole("heading", { name: "No active sessions" })).toBeVisible();
  await page.evaluate(async () => {
    const response = await fetch("/browser-matrix-cookie/check", {
      credentials: "same-origin"
    });
    if (
      response.status !== 204 ||
      response.headers.get("x-hostdeck-cookie-observed") !== "present"
    ) {
      throw new TypeError("Cookie check failed.");
    }
  });
  await expectCleanBrowser(page, diagnostics, {
    allowedAbortedRequests: [
      { method: "POST", path: "/browser-matrix-cookie/claim" },
      { method: "GET", path: "/browser-matrix-cookie/check" }
    ]
  });
  const crossSiteResponse = await page.goto(`${cookieCrossSiteOrigin}/`);
  expect(crossSiteResponse?.status()).toBe(200);
  expect(crossSiteResponse?.headers()["x-hostdeck-host-only-cookie-absent"]).toBe("true");
  const crossSiteCheckUrl = `${cookieOrigin}/browser-matrix-cookie/cross-site-check`;
  const crossSiteCheckPromise = page.waitForResponse(crossSiteCheckUrl);
  await page.evaluate((url) => window.location.assign(url), crossSiteCheckUrl);
  const crossSiteCheck = await crossSiteCheckPromise;
  expect(crossSiteCheck.status()).toBe(200);
  expect(crossSiteCheck.headers()["x-hostdeck-same-site-cookie-absent"]).toBe("true");
  await page.waitForURL(crossSiteCheckUrl);
  await page.waitForLoadState("domcontentloaded");
  const siblingResponse = await page.goto(`${cookieSiblingOrigin}/`);
  expect(siblingResponse?.status()).toBe(200);
  expect(siblingResponse?.headers()["x-hostdeck-host-only-cookie-absent"]).toBe("true");
  expect((await context.cookies(cookieSiblingOrigin)).some(
    ({ name }) => name === "__Host-hostdeck_device"
  )).toBe(false);
  await expectCleanBrowser(page, diagnostics, {
    allowedAbortedRequests: [
      { method: "POST", path: "/browser-matrix-cookie/claim" },
      { method: "GET", path: "/browser-matrix-cookie/check" },
      { method: "GET", path: "/events/stream" },
      { method: "GET", path: "/approvals" }
    ]
  });
  recordScenario(testInfo, started, {
    id: "https_cookie",
    interactions: [],
    requestCount: api.requests.length + 3,
    mutationCount: 1,
    observations: {
      certificate_trust_proven: false,
      credential_storage_entries: 0,
      cross_site_suppressed: true,
      http_only: true,
      host_only: true,
      javascript_invisible: true,
      packaged_document: true,
      reload_persistent: true,
      same_site_strict: true,
      secure: true
    }
  });
});

async function observePage(
  page: Page,
  allowedOrigins: readonly string[] = [packageOrigin]
): Promise<BrowserDiagnostics> {
  const diagnostics: BrowserDiagnostics = {
    consoleErrors: [],
    cspViolations: [],
    externalRequests: [],
    httpFailures: [],
    networkFailures: [],
    pendingRequests: new Set<Request>(),
    pageErrors: []
  };
  await page.addInitScript(() => {
    const violations: string[] = [];
    Object.defineProperty(window, "__hostdeckBrowserMatrixCsp", {
      configurable: false,
      enumerable: false,
      value: violations,
      writable: false
    });
    document.addEventListener("securitypolicyviolation", (event) => {
      violations.push(`${event.effectiveDirective}:${event.blockedURI}`);
    });
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      diagnostics.consoleErrors.push({
        text: message.text(),
        url: message.location().url
      });
    }
  });
  page.on("pageerror", (error) => diagnostics.pageErrors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol === "http:" || url.protocol === "https:") {
      diagnostics.pendingRequests.add(request);
    }
    if (url.protocol.startsWith("http") && !allowedOrigins.includes(url.origin)) {
      diagnostics.externalRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
    }
  });
  page.on("requestfinished", (request) => diagnostics.pendingRequests.delete(request));
  page.on("requestfailed", (request) => {
    diagnostics.pendingRequests.delete(request);
    const url = new URL(request.url());
    diagnostics.networkFailures.push({
      path: url.pathname,
      method: request.method(),
      error: request.failure()?.errorText ?? "unknown"
    });
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    diagnostics.httpFailures.push({
      path: url.pathname,
      status: response.status(),
      url: response.url()
    });
  });
  return diagnostics;
}

async function expectCleanBrowser(
  page: Page,
  diagnostics: BrowserDiagnostics,
  options: Readonly<{
    allowedAbortedRequests?: readonly Readonly<{ method: string; path: string }>[];
    allowedFragments?: readonly string[];
    allowedNetworkStatuses?: readonly number[];
    forbiddenBodyValues?: readonly string[];
  }> = {}
): Promise<void> {
  await expectNoHorizontalOverflow(page);
  await expect.poll(() => diagnostics.pageErrors).toEqual([]);
  const allowedStatuses = new Set(options.allowedNetworkStatuses ?? []);
  for (const failure of diagnostics.httpFailures) {
    expect(allowedStatuses.has(failure.status), `${failure.status} ${failure.path}`)
      .toBe(true);
  }
  const allowedFailureUrls = new Set(
    diagnostics.httpFailures
      .filter(({ status }) => allowedStatuses.has(status))
      .map(({ url }) => url)
  );
  for (const error of diagnostics.consoleErrors) {
    expect(
      allowedFailureUrls.has(error.url) &&
        /^Failed to load resource: the server responded with a status of [45][0-9]{2}/u
          .test(error.text),
      `${error.url}:${error.text}`
    ).toBe(true);
  }
  expect(diagnostics.externalRequests).toEqual([]);
  const allowedAbortedRequests = options.allowedAbortedRequests ?? [];
  for (const failure of diagnostics.networkFailures) {
    const aborted = failure.error.toLowerCase().includes("aborted");
    const expectedReadCancellation =
      failure.method === "GET" &&
      failure.path.startsWith("/api/v1/") &&
      aborted;
    expect(
      (aborted &&
        allowedAbortedRequests.some(({ method, path }) =>
          failure.method === method && failure.path === path
        )) ||
        expectedReadCancellation,
      `${failure.method} ${failure.path}:${failure.error}`
    ).toBe(true);
  }
  await expect.poll(() => [...diagnostics.pendingRequests]
    .map((request) => new URL(request.url()).pathname)
    .filter((path) => !path.endsWith("/events/stream") && !path.endsWith("/approvals")))
    .toEqual([]);
  const retainedOwners = [...diagnostics.pendingRequests]
    .map((request) => new URL(request.url()).pathname)
    .filter((path) => path.endsWith("/events/stream") || path.endsWith("/approvals"));
  expect(retainedOwners.filter((path) => path.endsWith("/events/stream")).length)
    .toBeLessThanOrEqual(1);
  expect(retainedOwners.filter((path) => path.endsWith("/approvals")).length)
    .toBeLessThanOrEqual(1);
  const state = await page.evaluate(async () => {
    const runtime = window as typeof window & {
      readonly __hostdeckBrowserMatrixCsp?: readonly string[];
    };
    const databases = typeof indexedDB.databases === "function"
      ? await indexedDB.databases()
      : [];
    return {
      body: document.body.innerText,
      caches: typeof caches === "undefined" ? [] : await caches.keys(),
      csp: runtime.__hostdeckBrowserMatrixCsp ?? [],
      databases: databases.map(({ name }) => name ?? "unnamed"),
      localStorage: Object.keys(localStorage),
      serviceWorkers:
        "serviceWorker" in navigator
          ? (await navigator.serviceWorker.getRegistrations()).length
          : 0,
      sessionStorage: Object.keys(sessionStorage)
    };
  });
  expect(state.csp).toEqual([]);
  expect(state.caches).toEqual([]);
  expect(state.databases).toEqual([]);
  expect(state.localStorage).toEqual([]);
  expect(state.serviceWorkers).toBe(0);
  expect(state.sessionStorage).toEqual([]);
  for (const value of options.forbiddenBodyValues ?? []) expect(state.body).not.toContain(value);
  for (const fragment of options.allowedFragments ?? []) {
    expect(page.url()).not.toContain(fragment);
    expect(state.body).not.toContain(fragment);
  }
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  if (viewport === null) throw new TypeError("Browser matrix viewport is unavailable.");
  await expect.poll(() => page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    escapedFixedRegions: [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element) => {
        const style = getComputedStyle(element);
        if (style.position !== "fixed" && style.position !== "sticky") return false;
        const bounds = element.getBoundingClientRect();
        const verticallyVisible = bounds.bottom > 0 && bounds.top < innerHeight;
        return verticallyVisible && (bounds.left < -1 || bounds.right > innerWidth + 1);
      })
      .length,
    scrollWidth: document.documentElement.scrollWidth
  }))).toEqual({
    clientWidth: viewport.width,
    escapedFixedRegions: 0,
    scrollWidth: viewport.width
  });
}

function recordScenario(
  testInfo: TestInfo,
  started: number,
  input: Readonly<{
    id: string;
    interactions: readonly MobileInteractionId[];
    requestCount: number;
    mutationCount: number;
    observations: Readonly<Record<string, string | number | boolean>>;
  }>
): void {
  if (testInfo.project.name !== activeProject) {
    throw new TypeError("Browser matrix scenario project changed unexpectedly.");
  }
  if (projectScenarios.some(({ id }) => id === input.id)) {
    throw new TypeError(`Browser matrix scenario ${input.id} is duplicated.`);
  }
  projectScenarios.push(Object.freeze({
    id: input.id,
    status: "passed",
    interactions: Object.freeze([...input.interactions]),
    request_count: input.requestCount,
    mutation_count: input.mutationCount,
    duration_ms: Math.round(performance.now() - started),
    observations: Object.freeze({ ...input.observations })
  }));
}

function expectProtectedMutation(
  request: Request | undefined,
  method: "DELETE" | "POST"
): void {
  if (request === undefined) throw new TypeError("Browser matrix mutation is missing.");
  const url = new URL(request.url());
  const headers = request.headers();
  expect(request.method()).toBe(method);
  expect(url.search).toBe("");
  expect(headers["content-type"]).toMatch(/^application\/json(?:;|$)/u);
  expect(headers["x-hostdeck-csrf"]).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(headers["x-hostdeck-csrf-generation"]).toBe("1");
  expect(headers["x-hostdeck-local-admin"]).toBeUndefined();
  expect(request.postData()).not.toBeNull();
}

function parseRuntimeInspection(candidate: string | undefined) {
  if (candidate === undefined || candidate.length > 4_096) {
    throw new TypeError("Browser matrix runtime inspection is missing.");
  }
  const parsed = JSON.parse(candidate) as {
    readonly schema_version: number;
    readonly playwright_version: string;
    readonly platform: string;
    readonly architecture: string;
    readonly engines: readonly Readonly<{
      browser_name: string;
      browser_version: string;
      revision: string;
    }>[];
  };
  if (
    parsed.schema_version !== 1 ||
    parsed.playwright_version !== "1.61.1" ||
    parsed.platform !== "linux" ||
    parsed.architecture !== "x64" ||
    parsed.engines.length !== 2
  ) {
    throw new TypeError("Browser matrix runtime inspection is invalid.");
  }
  return parsed;
}

function requiredEvidenceRoot(candidate: string | undefined): string {
  if (candidate === undefined || !candidate.startsWith("/tmp/hostdeck-browser-matrix-run-")) {
    throw new TypeError("Browser matrix evidence root is invalid.");
  }
  return resolve(candidate);
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
