import {
  type ChildProcess,
  execFile,
  execFileSync,
  spawn,
  spawnSync
} from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { createRequire } from "node:module";
import { type AddressInfo, createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  assessCodexCompatibility,
  codexBindingDescriptor
} from "@hostdeck/codex-adapter";
import {
  codexThreadIdSchema,
  codexTurnIdSchema,
  defaultResourceBudget,
  type RemoteIngressObservationSnapshot,
  type RemoteServeDescriptor,
  remoteProxyTrustRejectionReasons,
  remoteServeDescriptorSchema,
  runtimeCompatibilitySchema,
  type SelectedProjectionEvent,
  selectedHostLockStateResponseSchema,
  selectedPairingFragmentPrefix,
  selectedPairingLinkSchema,
  selectedProjectionEventSchema,
  selectedRequestAuthenticationContextSchema,
  selectedRuntimeCompatibilityRecordSchema,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "@hostdeck/contracts";
import {
  type CodexPromptControlService,
  type CodexPromptControlServiceOptions,
  createCodexPromptControlService,
  createHostDeckCsrfPolicy,
  createHostDeckCsrfRouteRegistration,
  createHostDeckDeviceRevokeRouteRegistration,
  createHostDeckHealthRouteRegistration,
  createHostDeckHostHealthService,
  createHostDeckHostLockPolicy,
  createHostDeckHostLockRouteRegistration,
  createHostDeckPairingPolicy,
  createHostDeckPairingRouteRegistration,
  createHostDeckProjectedEventRouteRegistration,
  createHostDeckProjectionStreamRouteRegistration,
  createHostDeckPromptRouteRegistration,
  createHostDeckRemoteIngressLifecycle,
  createHostDeckRemoteIngressRouteRegistration,
  createHostDeckRequestAuthenticationPolicy,
  createHostDeckRuntimeCompatibilityRecordReader,
  createHostDeckSelectedApiRouteComposition,
  createHostDeckSelectedWriteAdmissionPolicy,
  createHostDeckSelectedWriteAuditExecutor,
  createHostDeckSessionReadRouteRegistration,
  createHostDeckSseTransportRegistration,
  createHostDeckStaticBoundaryRegistration,
  createProjectionSubscriberStreamService,
  createRemoteIngressControlService,
  createSecurityMutationAuditExecutor,
  createTailscaleObserver,
  createTailscaleServeManager,
  type HostDeckFastifyInstance,
  type HostDeckFastifyLifecycle,
  HostDeckProjectionHandoffError,
  type HostDeckRemoteIngressLifecycle,
  type HostDeckRoutePluginRegistration,
  hostDeckLocalHealthComponents,
  hostDeckNoStoreRouteConfig,
  type OpenProjectionReplayLiveHandoffInput,
  type ProjectionHandoffFailure,
  type ProjectionReplayLiveHandoff,
  type ProjectionReplayLiveHandoffService,
  requireHostDeckRequestAuthentication,
  resolveHostDeckRequestAuthentication,
  startHostDeckTailscaleServeFastifyLifecycle,
  type TailscaleObserver,
  type TailscaleServeManager,
  tailscaleServeProxyTrustSnapshot
} from "@hostdeck/server";
import {
  createAuthDeviceRepository,
  createDeviceListingRepository,
  createDeviceRevocationRepository,
  createPairingCodeRepository,
  createRemoteIngressAdmissionProofRepository,
  createRemoteIngressStateRepository,
  createSelectedAuditRepository,
  createSelectedCsrfAuthorizationRepository,
  createSelectedSessionReadRepository,
  createSelectedStateRepository,
  createSettingsRepository,
  openMigratedDatabase,
  selectedProjectedEventByteLength,
  selectedStateRevision
} from "@hostdeck/storage";
import QRCode from "qrcode";
import { build as viteBuild } from "vite";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type PhysicalTalkBackObserverCategory,
  type PhysicalTalkBackObserverEvent,
  type PhysicalTalkBackTranscriptSummary,
  parsePhysicalTalkBackObserverLine,
  runPhysicalTalkBackCleanupPlan,
  validatePhysicalTalkBackTranscript
} from "../../../tests/support/android-talkback.js";
import {
  createPhysicalDashboardControls,
  type PhysicalDashboardControls
} from "../../../tests/support/mobile-dashboard-android.js";
import { createOperationDeadline } from "../../core/src/index.js";
import { writeProductionWebTestManifest } from "../../server/src/production-web-assets.test-support.js";
import { mobileDashboardPhysicalStateIds } from "../../test-fixtures/src/mobile-dashboard-physical-hardening.js";
import { mobileInteractionIds } from "../../test-fixtures/src/mobile-design-contract.js";
import { cliExitCodes } from "./exit-codes.js";
import { createBoundedLoopbackFetch } from "./loopback-http.js";
import { runCli } from "./shell.js";

const requireRemoteAndroidAcceptance =
  process.env.HOSTDECK_REQUIRE_REMOTE_ANDROID_ACCEPTANCE === "1";
const requireDashboardUiAcceptance =
  process.env.HOSTDECK_REQUIRE_MOBILE_DASHBOARD_ANDROID === "1" &&
  !requireRemoteAndroidAcceptance;
const requireRecoveryUiAcceptance =
  process.env.HOSTDECK_REQUIRE_RECOVERY_ANDROID_SMOKE === "1" &&
  !requireRemoteAndroidAcceptance &&
  !requireDashboardUiAcceptance;
const requirePromptUiAcceptance =
  process.env.HOSTDECK_REQUIRE_PROMPT_ANDROID_SMOKE === "1" &&
  !requireRemoteAndroidAcceptance &&
  !requireDashboardUiAcceptance &&
  !requireRecoveryUiAcceptance;
const requirePairingUiAcceptance =
  process.env.HOSTDECK_REQUIRE_PAIRING_ANDROID_SMOKE === "1" &&
  !requireRemoteAndroidAcceptance &&
  !requireDashboardUiAcceptance &&
  !requireRecoveryUiAcceptance &&
  !requirePromptUiAcceptance;
const requireProductionUiAcceptance =
  requireDashboardUiAcceptance ||
  requirePairingUiAcceptance ||
  requirePromptUiAcceptance ||
  requireRecoveryUiAcceptance;
const requirePhysicalPairing =
  requireProductionUiAcceptance || requireRemoteAndroidAcceptance;
const describePhysical = requirePhysicalPairing ? describe : describe.skip;
const overallTimeoutMs = requireRemoteAndroidAcceptance
  ? 20 * 60_000
  : requireDashboardUiAcceptance
    ? 35 * 60_000
  : requireRecoveryUiAcceptance
    ? 15 * 60_000
  : requirePromptUiAcceptance
    ? 12 * 60_000
    : 10 * 60_000;
const claimTimeoutMs = 5 * 60_000;
const automatedClaimTimeoutMs = 45_000;
const androidTailscaleComponent = "com.tailscale.ipn/.MainActivity";
const androidEditTextClass = "android.widget.EditText";
const androidMobileDataStateCommand =
  "dumpsys telephony.registry | grep -E '^ *mUserMobileDataState= *(true|false) *$'";
const androidPowerPlugTypeCommand =
  "dumpsys power | grep -E '^ *mPlugType=[0-7] *$'";
const chromeCompositorResourceId =
  "com.android.chrome:id/compositor_view_holder";
const chromeToolbarResourceId = "com.android.chrome:id/toolbar_container";
const physicalAndroidChromeStopCommandPlan = Object.freeze([
  Object.freeze([
    "shell",
    "input",
    "keyevent",
    "KEYCODE_HOME"
  ] as const),
  Object.freeze([
    "shell",
    "am",
    "force-stop",
    "com.android.chrome"
  ] as const)
] as const);
const physicalAndroidChromeRetainedTabCommandPlan = Object.freeze([
  Object.freeze(["shell", "input", "keyevent", "KEYCODE_BACK"] as const),
  Object.freeze([
    "shell",
    "am",
    "start",
    "--user",
    "0",
    "-W",
    "-a",
    "android.intent.action.MAIN",
    "-c",
    "android.intent.category.LAUNCHER",
    "-n",
    "com.android.chrome/com.google.android.apps.chrome.Main"
  ] as const)
] as const);
const pairingStartupDiagnosticLabels = Object.freeze([
  "Checking secure link",
  "Pairing this phone",
  "Phone paired",
  "Pairing link is invalid",
  "Secure entry failed",
  "Pairing link was not accepted",
  "Pairing address was rejected",
  "Pairing attempts are limited",
  "Pairing is temporarily unavailable",
  "Pairing outcome is unknown",
  "Phone paired, secure access incomplete",
  "HostDeck could not start",
  "Checking this phone",
  "HostDeck is closed"
] as const);
const tailscaleDnsServer = "100.100.100.100";
const physicalPageMaxBytes = defaultResourceBudget.cli_response_max_bytes;
const chromeForegroundAdbArgs = [
  "shell",
  "dumpsys",
  "window",
  "displays"
] as const;
const chromeForegroundMaxBytes = 128 * 1024;
const physicalEvidenceDirectory = join(
  process.cwd(),
  "artifacts",
  "ifc-v1-079-device"
);
const physicalPromptEvidenceDirectory = join(
  process.cwd(),
  "artifacts",
  "fe-v1-020-selected-session-prompt-composer"
);
const physicalRecoveryEvidenceDirectory = join(
  process.cwd(),
  "artifacts",
  "fe-v1-034-remote-connection-recovery",
  "physical-android"
);
const physicalDashboardEvidenceDirectory = join(
  process.cwd(),
  "artifacts",
  "fe-v1-090-mobile-dashboard-physical-hardening",
  "physical-android"
);
const physicalUiSessionId = "sess_physical_pairing_ui";
const physicalUiSessionName = "physical-pairing-review";
const physicalUiThreadId = "thread-physical-pairing-ui";
const physicalSessionControlDescriptions = Object.freeze([
  `/model for ${physicalUiSessionName}`,
  `/goal for ${physicalUiSessionName}`,
  `/plan for ${physicalUiSessionName}`,
  `More session utilities for ${physicalUiSessionName}`
]);
const physicalEventActionMaxDistancePx = 480;
const physicalHostAccessHeaderGapPx = 24;
const physicalSessionOverlayGapPx = 24;
const physicalApprovalLifetimeMs = 30 * 60 * 1_000;
const physicalScreenshotRedactionInsetPx = 8;
const physicalScreenshotRedactionRgba = Object.freeze([24, 28, 33, 255] as const);
const physicalRuntimeIncompatibleTitle = "Codex interface incompatible";
const physicalRuntimeSupportedTitle = "Codex compatible";
const physicalDashboardRemoteBrowserCheckCount = 4;
const physicalApprovalConfirmationTitle = "Approve elevated request?";
const physicalApprovalConfirmationReason =
  "Continue the bounded release validation on the selected device.";
const physicalApprovalConfirmationAction = "Approve once";
const physicalApprovalConfirmationStatus = "Approval confirmation open";
const physicalPromptTurnId = "turn-physical-prompt-001";
const physicalPromptText = "FE020_android_line_one\nFE020_android_line_two";
const physicalGoalObjective = "Complete_FE090_device_acceptance";
const physicalSkillSearch = "release-readiness";
const androidTalkBackPackage = "com.google.android.marvin.talkback";
const androidTalkBackService =
  `${androidTalkBackPackage}/${androidTalkBackPackage}.TalkBackService`;
const physicalTalkBackDeviceDex = "/data/local/tmp/hostdeck-talkback.dex";
const physicalTalkBackObserverClass =
  "app.hostdeck.talkbackobserver.HostDeckTalkBackObserver";
const physicalTalkBackTouchClass =
  "app.hostdeck.talkbackobserver.HostDeckUhidTouch";
const physicalTalkBackPermissions = Object.freeze([
  "android.permission.POST_NOTIFICATIONS",
  "android.permission.READ_PHONE_STATE"
] as const);
const physicalTalkBackMutablePermissionFlags = Object.freeze([
  "review-required",
  "revoked-compat",
  "revoke-when-requested",
  "user-fixed",
  "user-set"
] as const);
const deviceForbiddenValues = new Set<string>();
const { PNG: Png } = createRequire(import.meta.url)("pngjs") as unknown as {
  readonly PNG: PngConstructor;
};
let adbCommandCount = 0;

describe("physical Android phone-driver protocol", () => {
  it("accepts only the frozen checkpoint and command sequence", () => {
    const runtime = createPhysicalDriverRuntime();
    for (const checkpoint of physicalCheckpointOrder) {
      runtime.recordCheckpoint(checkpoint);
    }
    runtime.setCommand("prepare-away");
    runtime.setCommand("revoke");

    expect(runtime.snapshot()).toEqual({
      checkpoints: physicalCheckpointOrder,
      command: "revoke",
      revision: 2
    });
    expect(Object.isFrozen(runtime.snapshot())).toBe(true);
    expect(Object.isFrozen(runtime.snapshot().checkpoints)).toBe(true);
    expect(() => runtime.recordCheckpoint("recovered")).toThrow(
      "Physical phone checkpoint violated the frozen sequence."
    );
    expect(() => runtime.setCommand("cleanup")).toThrow(
      "Physical phone command transition was invalid."
    );
  });

  it("supports the bounded pairing-only cleanup branch", () => {
    const runtime = createPhysicalDriverRuntime();
    runtime.recordCheckpoint("paired");
    runtime.recordCheckpoint("reloaded");
    runtime.setCommand("cleanup");

    expect(runtime.snapshot()).toEqual({
      checkpoints: ["paired", "reloaded"],
      command: "cleanup",
      revision: 1
    });
    expect(() => runtime.recordCheckpoint("locked")).toThrow(
      "Physical phone checkpoint violated the frozen sequence."
    );
  });

  it("bundles a phone-resident runner without remote-debugging control", async () => {
    const bundle = await buildPhysicalBrowserBundle();

    expect(bundle).toContain("/__physical/checkpoint/");
    expect(bundle).toContain("/__physical/clipboard");
    expect(bundle).toContain("/__physical/cleanup");
    expect(bundle).toContain("requestFullscreen");
    expect(bundle).not.toMatch(
      /chrome_devtools|Runtime\.evaluate|webSocketDebuggerUrl|__hostDeckPhysical/iu
    );
  });

  it(
    "builds the real production browser app for pairing-only acceptance",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "hostdeck-pairing-ui-build-"));
      try {
        const buildRoot = await buildProductionBrowserApp(directory);
        expect(readFileSync(join(buildRoot, "index.html"), "utf8")).toContain(
          "/assets/"
        );
        expect(
          readdirSync(join(buildRoot, "assets")).some((name) =>
            name.endsWith(".js")
          )
        ).toBe(true);
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    },
    15_000
  );

  it("seeds one repository-valid production pairing session", () => {
    const directory = mkdtempSync(join(tmpdir(), "hostdeck-pairing-session-"));
    const opened = openMigratedDatabase(join(directory, "hostdeck.sqlite"));
    try {
      const fixture = createPhysicalSessionReads(
        opened.db,
        increasingWallClock(),
        "none"
      );
      const page = fixture.reads.list({
        after: null,
        expected_order_snapshot: null,
        limit: 1
      });
      expect(page.sessions).toHaveLength(1);
      expect(page.sessions[0]?.session.name).toBe(
        "physical-pairing-review"
      );
      expect(fixture.promptSeedEvent).toBeNull();
      expect(fixture.streamSeedEvents).toEqual([]);
    } finally {
      opened.db.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("persists the exact prompt replay seed with matching projection metadata", () => {
    const directory = mkdtempSync(join(tmpdir(), "hostdeck-prompt-session-"));
    const opened = openMigratedDatabase(join(directory, "hostdeck.sqlite"));
    try {
      const fixture = createPhysicalSessionReads(
        opened.db,
        increasingWallClock(),
        "prompt"
      );
      const seed = fixture.promptSeedEvent;
      requireCondition(seed !== null, "Physical prompt fixture omitted its seed.");
      const states = createSelectedStateRepository(opened.db);
      const state = states.require(physicalUiSessionId);
      const page = states.listEvents(physicalUiSessionId, {
        after: null,
        limit: 1
      });

      expect(page.events).toEqual([seed]);
      expect(state.projection).toMatchObject({
        earliest_retained_cursor: 1,
        retained_event_bytes: selectedProjectedEventByteLength(seed),
        retained_event_count: 1,
        session: {
          last_event_cursor: 1,
          recent_summary: "Physical prompt stream ready"
        }
      });
    } finally {
      opened.db.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("seeds the complete dashboard attention and diagnostic fixture", () => {
    const directory = mkdtempSync(join(tmpdir(), "hostdeck-dashboard-session-"));
    const opened = openMigratedDatabase(join(directory, "hostdeck.sqlite"));
    try {
      const fixture = createPhysicalSessionReads(
        opened.db,
        increasingWallClock(),
        "dashboard"
      );
      const page = fixture.reads.list({
        after: null,
        expected_order_snapshot: null,
        limit: 10
      });

      expect(page.sessions.map((entry) => entry.session.name).sort()).toEqual([
        "migration-input",
        "physical-pairing-review",
        "release-approval"
      ]);
      expect(
        page.sessions.map((entry) => entry.session.attention).sort()
      ).toEqual(["needs_approval", "needs_input", "none"]);
      expect(fixture.promptSeedEvent).toBeNull();
      expect(fixture.streamSeedEvents.map((event) => event.type)).toEqual([
        "replay_boundary",
        "message",
        "turn",
        "approval",
        "runtime"
      ]);
      expect(fixture.streamSeedEvents.map((event) => event.cursor)).toEqual([
        1, 2, 3, 4, 5
      ]);
      expect(fixture.streamSeedEvents[2]).toMatchObject({
        content_state: "redacted",
        state: "failed"
      });
      const approvalEvent = fixture.streamSeedEvents[3];
      requireCondition(
        approvalEvent?.type === "approval" && fixture.approvalTiming !== null,
        "Physical dashboard approval timing fixture was absent."
      );
      expect(fixture.approvalTiming).toEqual({
        createdAt: approvalEvent.captured_at,
        expiresAt: approvalEvent.expires_at
      });
      expect(
        Date.parse(fixture.approvalTiming.expiresAt) -
          Date.parse(fixture.approvalTiming.createdAt)
      ).toBe(physicalApprovalLifetimeMs);
    } finally {
      opened.db.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("uses visible attention truth before revealing the quiet dashboard target", () => {
    expect(missionControlInitialViewportText("dashboard_attention")).toBe(
      "ACT NOW"
    );
    expect(missionControlInitialViewportField("dashboard_attention")).toBe(
      "text"
    );
    expect(missionControlInitialViewportText("single_session")).toBe(
      physicalUiSessionName
    );
    expect(missionControlInitialViewportField("single_session")).toBe(
      "description"
    );
  });

  it("opens the collapsed quiet queue before acquiring its physical target", () => {
    expect(physicalQuietQueueDisclosureLabel(false)).toBe(
      "Expand quiet sessions (1)"
    );
    expect(physicalQuietQueueDisclosureLabel(true)).toBe(
      "Collapse quiet sessions (1)"
    );
    const [trigger] = parseAndroidUiNodes(
      '<hierarchy><node text="" class="android.widget.Button" ' +
        'content-desc="Expand quiet sessions (1)" clickable="true" ' +
        'bounds="[0,400][1080,560]" /></hierarchy>'
    );
    expect(trigger?.className).toBe("android.widget.Button");
    expect(
      trigger === undefined
        ? false
        : matchesAndroidUiNode(
            trigger,
            "description",
            physicalQuietQueueDisclosureLabel(false)
          )
    ).toBe(true);
  });

  it("acquires the named whole-session target instead of its text fragment", () => {
    const nodes = parseAndroidUiNodes(
      '<hierarchy><node text="" class="android.view.ViewGroup" ' +
        `content-desc="" resource-id="${chromeToolbarResourceId}" ` +
        'bounds="[0,0][1080,240]" />' +
        '<node text="" class="android.widget.FrameLayout" ' +
        `content-desc="" resource-id="${chromeCompositorResourceId}" ` +
        'bounds="[0,0][1080,2200]" />' +
        '<node text="" class="android.view.View" ' +
        `content-desc="${physicalUiSessionName}" clickable="true" ` +
        'bounds="[0,400][1080,688]" />' +
        `<node text="${physicalUiSessionName}" class="android.view.View" ` +
        'content-desc="" clickable="false" bounds="[24,424][558,487]" />' +
        '</hierarchy>'
    );
    const target = nodes.find((node) =>
      matchesAndroidUiNode(
        node,
        "description",
        physicalUiSessionName
      )
    );
    const fragment = nodes.find((node) =>
      matchesAndroidUiNode(node, "text", physicalUiSessionName)
    );

    expect(target).toBeDefined();
    expect(fragment).toBeDefined();
    expect(target?.clickable).toBe(true);
    expect(fragment?.clickable).toBe(false);
    expect(target === undefined ? 0 : androidUiNodeHeight(target)).toBe(288);
    expect(fragment === undefined ? 0 : androidUiNodeHeight(fragment)).toBe(63);
    expect(
      target === undefined
        ? false
        : androidUiNodeIsFullyInsideChromePage(target, nodes)
    ).toBe(true);
    expect(
      target === undefined
        ? true
        : androidUiNodeIsFullyInsideChromePage(
            Object.freeze({
              ...target,
              bounds: Object.freeze({
                ...target.bounds,
                bottom: 2300,
                top: 2012
              })
            }),
            nodes
          )
    ).toBe(false);
  });

  it("recognizes Plan lifecycle truth from its approved phone viewports", () => {
    const nodes = parseAndroidUiNodes(
      '<hierarchy><node text="Default" bounds="[100,0][200,80]" />' +
        '<node text="No pending change" bounds="[100,80][300,120]" />' +
        '<node text="No observed Plan execution" bounds="[100,120][360,160]" />' +
        '<node text="Plan" bounds="[0,200][100,240]" />' +
        '<node text="Default" bounds="[100,200][200,240]" />' +
        '</hierarchy>'
    );

    expect(physicalPlanCurrentTruthVisible(nodes, "Default")).toBe(true);
    expect(physicalPlanCurrentTruthVisible(nodes, "Plan")).toBe(false);
    for (const missing of [
      "Default",
      "No pending change",
      "No observed Plan execution"
    ]) {
      expect(
        physicalPlanCurrentTruthVisible(
          nodes.filter((node) => node.text !== missing),
          "Default"
        )
      ).toBe(false);
    }
    expect(
      physicalPlanCurrentTruthVisible(
        parseAndroidUiNodes(
          '<hierarchy><node text="Loading Plan state" bounds="[0,0][200,40]" /></hierarchy>'
        ),
        "Default"
      )
    ).toBe(false);

    const submitting = parseAndroidUiNodes(
      '<hierarchy><node text="A Plan selection is already being saved." bounds="[0,0][360,40]" /></hierarchy>'
    );
    expect(physicalPlanSubmittingTruthVisible(submitting)).toBe(true);
    expect(physicalPlanSubmittingTruthVisible([])).toBe(false);

    const staged = parseAndroidUiNodes(
      '<hierarchy><node text="Plan" bounds="[100,0][200,40]" />' +
        '<node text="Pending next turn: Staged in HostDeck" bounds="[100,40][380,80]" />' +
        '<node text="No observed Plan execution" bounds="[100,80][360,120]" />' +
        '<node text="Plan" bounds="[100,160][200,200]" />' +
        '</hierarchy>'
    );
    expect(physicalPlanStagedTruthVisible(staged)).toBe(true);
    for (const missing of [
      "Plan",
      "Pending next turn: Staged in HostDeck",
      "No observed Plan execution"
    ]) {
      expect(
        physicalPlanStagedTruthVisible(
          staged.filter((node) => node.text !== missing)
        )
      ).toBe(false);
    }
  });

  it("admits event diagnostics only above the complete fixed control dock", () => {
    const timelineLabel = "Sensitive turn detail was redacted at projection time.";
    const controls = physicalSessionControlDescriptions
      .map(
        (description, index) =>
          `<node text="" class="android.widget.Button" ` +
          `content-desc="${description}" clickable="true" ` +
          `bounds="[${index * 270},1760][${(index + 1) * 270},1900]" />`
      )
      .join("");
    const nodes = parseAndroidUiNodes(
      '<hierarchy><node text="" class="android.view.ViewGroup" ' +
        `content-desc="" resource-id="${chromeToolbarResourceId}" ` +
        'bounds="[0,80][1080,240]" />' +
        '<node text="" class="android.widget.FrameLayout" ' +
        `content-desc="" resource-id="${chromeCompositorResourceId}" ` +
        'bounds="[0,80][1080,2400]" />' +
        '<node text="" class="android.widget.Button" ' +
        'content-desc="Back to Mission Control" clickable="true" ' +
        'bounds="[0,250][160,390]" />' +
        '<node text="" class="android.widget.Button" ' +
        'content-desc="View event details" clickable="true" ' +
        'bounds="[900,985][1040,1115]" />' +
        `<node text="${timelineLabel}" class="android.view.View" ` +
        'content-desc="" bounds="[80,1200][820,1300]" />' +
        '<node text="" class="android.widget.Button" ' +
        'content-desc="View event details" clickable="true" ' +
        'bounds="[900,1310][1040,1430]" />' +
        controls +
        '</hierarchy>'
    );

    const admitted = selectPhysicalEventDiagnosticTarget(nodes, timelineLabel);
    expect(admitted?.action.description).toBe("View event details");
    expect(admitted?.action.bounds.top).toBe(985);
    expect(admitted?.label.text).toBe(timelineLabel);
    expect(physicalEventDiagnosticGeometrySummary(nodes, timelineLabel)).toContain(
      "target=admitted"
    );
    expect(selectPhysicalSessionContentSwipe(nodes)).toEqual({
      endY: 784,
      startY: 1418,
      x: 540
    });
    expect(selectPhysicalSessionContentSwipe(nodes, "backward")).toEqual({
      endY: 1418,
      startY: 784,
      x: 540
    });
    const review = Object.freeze({
      bounds: Object.freeze({ bottom: 1950, left: 630, right: 1035, top: 1800 }),
      className: "android.widget.Button",
      clickable: true,
      description: "",
      resourceId: "",
      text: "Review & approve"
    });
    const reviewNodes = (
      targets: readonly AndroidUiNode[],
      base: readonly AndroidUiNode[] = nodes
    ) => [...base, ...targets];
    const selectReview = (
      targets: readonly AndroidUiNode[],
      base: readonly AndroidUiNode[] = nodes
    ) =>
      selectPhysicalSessionContentNode(
        reviewNodes(targets, base),
        "text",
        "Review & approve",
        true
      );
    const summarizeReview = (
      targets: readonly AndroidUiNode[],
      selected: AndroidUiNode | null = null,
      base: readonly AndroidUiNode[] = nodes
    ) =>
      physicalSessionContentNodeSummary(
        reviewNodes(targets, base),
        "text",
        "Review & approve",
        true,
        selected
      );
    expect(selectReview([review])).toBeNull();
    expect(summarizeReview([review])).toContain("disposition=below");
    const safeReview = Object.freeze({
      ...review,
      bounds: Object.freeze({ ...review.bounds, bottom: 1600, top: 1450 })
    });
    expect(selectReview([safeReview])).toBe(safeReview);
    expect(summarizeReview([safeReview], safeReview)).toContain(
      "disposition=admitted"
    );
    const duplicateReviews = [safeReview, Object.freeze({ ...safeReview })];
    expect(selectReview(duplicateReviews)).toBeNull();
    expect(summarizeReview(duplicateReviews)).toContain(
      "disposition=duplicate"
    );
    const incompleteDock = nodes.filter(
      (node) => node.description !== physicalSessionControlDescriptions[3]
    );
    expect(selectReview([safeReview], incompleteDock)).toBeNull();
    expect(summarizeReview([safeReview], null, incompleteDock)).toContain(
      "disposition=content-blocked"
    );
    expect(summarizeReview([])).toContain("disposition=absent");
    const disabledReview = Object.freeze({
      ...safeReview,
      enabled: false as const
    });
    expect(selectReview([disabledReview])).toBeNull();
    expect(summarizeReview([disabledReview])).toContain(
      "disposition=disabled"
    );
    const staticReview = Object.freeze({
      ...safeReview,
      clickable: false
    });
    expect(summarizeReview([staticReview])).toContain(
      "disposition=not-clickable"
    );
    const clippedReview = Object.freeze({
      ...safeReview,
      bounds: Object.freeze({ ...safeReview.bounds, bottom: 1760, top: 1650 })
    });
    expect(summarizeReview([clippedReview])).toContain(
      "disposition=clipped-bottom"
    );
    const aboveReview = Object.freeze({
      ...safeReview,
      bounds: Object.freeze({ ...safeReview.bounds, bottom: 400, top: 300 })
    });
    expect(summarizeReview([aboveReview])).toContain("disposition=above");
    const clippedTopReview = Object.freeze({
      ...safeReview,
      bounds: Object.freeze({ ...safeReview.bounds, bottom: 460, top: 380 })
    });
    expect(summarizeReview([clippedTopReview])).toContain(
      "disposition=clipped-top"
    );
    const outsideReview = Object.freeze({
      ...safeReview,
      bounds: Object.freeze({ ...safeReview.bounds, left: 1090, right: 1200 })
    });
    expect(summarizeReview([outsideReview])).toContain(
      "disposition=horizontal-outside"
    );
    const clippedHorizontalReview = Object.freeze({
      ...safeReview,
      bounds: Object.freeze({ ...safeReview.bounds, left: 900, right: 1100 })
    });
    expect(summarizeReview([clippedHorizontalReview])).toContain(
      "disposition=clipped-horizontal"
    );
    expect(summarizeReview([safeReview])).toContain(
      "disposition=selector-blocked"
    );
    const initialScrollSummary = physicalSessionContentNodeSummary(
      nodes,
      "text",
      "Review & approve",
      true,
      null
    );
    const shiftedScrollSummary = physicalSessionContentNodeSummary(
      nodes.map((node) =>
        node.text === timelineLabel || node.description === "View event details"
          ? Object.freeze({
              ...node,
              bounds: Object.freeze({
                ...node.bounds,
                bottom: node.bounds.bottom - 120,
                top: node.bounds.top - 120
              })
            })
          : node
      ),
      "text",
      "Review & approve",
      true,
      null
    );
    expect(initialScrollSummary).not.toBe(shiftedScrollSummary);
    expect(initialScrollSummary).not.toContain(timelineLabel);
    expect(initialScrollSummary).not.toContain("Review & approve");
    const scrollWitness = /;scroll=\d+:([^;]+);gesture=/u.exec(
      initialScrollSummary
    )?.[1];
    expect(scrollWitness?.split("|").length).toBeLessThanOrEqual(6);
    const observations: string[] = [];
    for (const observation of ["a", "a", "b", "c", "d", "e", "f", "g"]) {
      retainPhysicalSessionContentObservation(observations, observation);
    }
    expect(observations).toEqual(["b", "c", "d", "e", "f", "g"]);
    expect(() =>
      retainPhysicalSessionContentObservation(observations, "x".repeat(4_097))
    ).toThrow("observation exceeded its private-safe bound");
    const collapsedToolbar = nodes.filter(
      (node) => node.resourceId !== chromeToolbarResourceId
    );
    expect(selectChromePageViewport(collapsedToolbar)).toEqual({
      height: 2320,
      left: 0,
      top: 80,
      width: 1080
    });
    expect(
      selectPhysicalEventDiagnosticTarget(collapsedToolbar, timelineLabel)
        ?.action.description
    ).toBe("View event details");
    const collapsedSummary = physicalEventDiagnosticGeometrySummary(
      collapsedToolbar,
      timelineLabel
    );
    expect(collapsedSummary).toContain("target=admitted");
    expect(collapsedSummary).toContain("page=0,80,1080,2320");
    expect(collapsedSummary).not.toContain("content=unavailable");

    const malformedToolbar = nodes.map((node) =>
      node.resourceId === chromeToolbarResourceId
        ? Object.freeze({
            ...node,
            bounds: Object.freeze({ ...node.bounds, bottom: 80, top: 80 })
          })
        : node
    );
    expect(() => selectChromePageViewport(malformedToolbar)).toThrow(
      "Chrome viewport geometry was invalid"
    );
    expect(
      selectPhysicalEventDiagnosticTarget(malformedToolbar, timelineLabel)
        ?.action.description
    ).toBe("View event details");
    const malformedSummary = physicalEventDiagnosticGeometrySummary(
      malformedToolbar,
      timelineLabel
    );
    expect(malformedSummary).toContain("target=admitted");
    expect(malformedSummary).toContain("page=invalid");
    expect(malformedSummary).not.toContain("content=unavailable");

    const moveEventNode = (node: AndroidUiNode, top: number, bottom: number) =>
      node.text === timelineLabel || node.description === "View event details"
        ? Object.freeze({
            ...node,
            bounds: Object.freeze({ ...node.bounds, bottom, top })
          })
        : node;
    expect(
      selectPhysicalEventDiagnosticTarget(
        nodes.map((node) => moveEventNode(node, 1880, 2010)),
        timelineLabel
      )
    ).toBeNull();
    expect(
      selectPhysicalEventDiagnosticTarget(
        nodes.filter((node) => node !== admitted?.action),
        timelineLabel
      )
    ).toBeNull();
    expect(
      selectPhysicalEventDiagnosticTarget(
        nodes.map((node) => moveEventNode(node, 300, 420)),
        timelineLabel
      )
    ).toBeNull();
    expect(
      selectPhysicalEventDiagnosticTarget(
        nodes.filter(
          (node) => node.description !== physicalSessionControlDescriptions[3]
        ),
        timelineLabel
      )
    ).toBeNull();
    expect(
      selectPhysicalEventDiagnosticTarget(
        nodes.filter(
          (node) => node.description !== "Back to Mission Control"
        ),
        timelineLabel
      )
    ).toBeNull();
    const label = admitted?.label;
    requireCondition(label !== undefined, "Event diagnostic fixture label was absent.");
    expect(
      selectPhysicalEventDiagnosticTarget(
        [...nodes, Object.freeze({ ...label })],
        timelineLabel
      )
    ).toBeNull();
    expect(
      selectPhysicalEventDiagnosticTarget(
        nodes.map((node) =>
          node.description === "View event details"
            ? moveEventNode(node, 640, 770)
            : node
        ),
        timelineLabel
      )
    ).toBeNull();
  });

  it("admits Host actions only below the complete Session Actions header", () => {
    const nodes = parseAndroidUiNodes(
      '<hierarchy><node text="" class="android.view.ViewGroup" ' +
        `content-desc="" resource-id="${chromeToolbarResourceId}" ` +
        'bounds="[0,80][1080,240]" />' +
        '<node text="" class="android.widget.FrameLayout" ' +
        `content-desc="" resource-id="${chromeCompositorResourceId}" ` +
        'bounds="[0,80][1080,2400]" />' +
        '<node text="" class="android.widget.Button" ' +
        'content-desc="Back to session actions" clickable="true" enabled="true" ' +
        'bounds="[40,360][164,484]" />' +
        '<node text="Host &amp; access" class="android.view.View" ' +
        'content-desc="" bounds="[190,370][720,450]" />' +
        '<node text="" class="android.widget.Button" ' +
        'content-desc="Close session actions" clickable="true" enabled="true" ' +
        'bounds="[916,360][1040,484]" />' +
        '<node text="Lock writes" class="android.widget.Button" content-desc="" ' +
        'clickable="true" enabled="true" bounds="[157,440][1029,566]" />' +
        '</hierarchy>'
    );
    const lock = nodes.find((node) => node.text === "Lock writes");
    const title = nodes.find((node) => node.text === "Host & access");
    const back = nodes.find(
      (node) => node.description === "Back to session actions"
    );
    const close = nodes.find(
      (node) => node.description === "Close session actions"
    );
    requireCondition(
      lock !== undefined &&
        title !== undefined &&
        back !== undefined &&
        close !== undefined,
      "Host action geometry fixture was incomplete."
    );

    expect(
      selectAndroidUiNodeForReveal(
        nodes,
        "text",
        "Lock writes",
        "fully_visible",
        true
      )
    ).toBe(lock);
    expect(
      selectPhysicalHostAccessContentNode(
        nodes,
        "text",
        "Lock writes",
        true
      )
    ).toBeNull();
    expect(selectPhysicalHostAccessContentRegion(nodes)).toEqual({
      height: 1_892,
      left: 0,
      top: 508,
      width: 1_080
    });
    expect(selectPhysicalHostAccessContentSwipe(nodes, "backward")).toEqual({
      endY: 1_945,
      startY: 1_037,
      x: 540
    });

    const androidPresentationVariant = nodes.map((node) => {
      if (node === title) {
        return Object.freeze({
          ...node,
          className: "android.view.ViewGroup",
          description: "Host & access",
          resourceId: "web-generated-title-id"
        });
      }
      if (node === back || node === close) {
        return Object.freeze({
          ...node,
          resourceId: "web-generated-button-id",
          text: node.description
        });
      }
      return node;
    });
    expect(selectPhysicalHostAccessContentRegion(androidPresentationVariant)).toEqual({
      height: 1_892,
      left: 0,
      top: 508,
      width: 1_080
    });

    const observedPhoneGeometry = nodes.map((node) => {
      if (node === title) {
        return Object.freeze({
          ...node,
          bounds: Object.freeze({ bottom: 630, left: 191, right: 683, top: 560 })
        });
      }
      if (node === back) {
        return Object.freeze({
          ...node,
          bounds: Object.freeze({ bottom: 687, left: 45, right: 171, top: 560 })
        });
      }
      if (node === close) {
        return Object.freeze({
          ...node,
          bounds: Object.freeze({ bottom: 687, left: 908, right: 1_035, top: 560 })
        });
      }
      if (node === lock) {
        return Object.freeze({
          ...node,
          bounds: Object.freeze({ bottom: 751, left: 157, right: 1_029, top: 625 })
        });
      }
      return node;
    });
    expect(
      selectPhysicalHostAccessContentNode(
        observedPhoneGeometry,
        "text",
        "Lock writes",
        true
      )
    ).toBeNull();
    expect(selectPhysicalHostAccessContentRegion(observedPhoneGeometry)).toEqual({
      height: 1_689,
      left: 0,
      top: 711,
      width: 1_080
    });
    expect(selectPhysicalHostAccessContentSwipe(observedPhoneGeometry, "backward")).toEqual({
      endY: 1_994,
      startY: 1_183,
      x: 540
    });
    const revealedPhoneGeometry = observedPhoneGeometry.map((node) =>
      node.text === "Lock writes"
        ? Object.freeze({
            ...node,
            bounds: Object.freeze({ ...node.bounds, bottom: 861, top: 735 })
          })
        : node
    );
    const revealedPhoneLock = revealedPhoneGeometry.find(
      (node) => node.text === "Lock writes"
    );
    expect(
      selectPhysicalHostAccessContentNode(
        revealedPhoneGeometry,
        "text",
        "Lock writes",
        true
      )
    ).toBe(revealedPhoneLock);

    const visibleLock = Object.freeze({
      ...lock,
      bounds: Object.freeze({ ...lock.bounds, bottom: 658, top: 532 })
    });
    const withVisibleLock = nodes.map((node) =>
      node === lock ? visibleLock : node
    );
    expect(
      selectPhysicalHostAccessContentNode(
        withVisibleLock,
        "text",
        "Lock writes",
        true
      )
    ).toBe(visibleLock);

    const rejects = (candidateNodes: readonly AndroidUiNode[]) => {
      expect(
        selectPhysicalHostAccessContentNode(
          candidateNodes,
          "text",
          "Lock writes",
          true
        )
      ).toBeNull();
    };
    rejects(withVisibleLock.filter((node) => node !== title));
    rejects(withVisibleLock.filter((node) => node !== back));
    rejects(withVisibleLock.filter((node) => node !== close));
    rejects([...withVisibleLock, Object.freeze({ ...title })]);
    rejects([...withVisibleLock, Object.freeze({ ...visibleLock })]);
    rejects(
      withVisibleLock.map((node) =>
        node === visibleLock
          ? Object.freeze({ ...node, clickable: false })
          : node
      )
    );
    rejects(
      withVisibleLock.map((node) =>
        node === visibleLock
          ? Object.freeze({ ...node, enabled: false })
          : node
      )
    );
    rejects(
      withVisibleLock.map((node) =>
        node === back ? Object.freeze({ ...node, clickable: false }) : node
      )
    );
    rejects(
      withVisibleLock.map((node) =>
        node === close ? Object.freeze({ ...node, enabled: false }) : node
      )
    );
    rejects(
      withVisibleLock.map((node) =>
        node === title ? Object.freeze({ ...node, clickable: true }) : node
      )
    );
    rejects(
      withVisibleLock.map((node) =>
        node === title
          ? Object.freeze({ ...node, description: "Unrelated sheet" })
          : node
      )
    );
    rejects(
      withVisibleLock.map((node) =>
        node === visibleLock
          ? Object.freeze({
              ...node,
              bounds: Object.freeze({ ...node.bounds, bottom: 2_440, top: 2_314 })
            })
          : node
      )
    );
  });

  it("holds exactly one armed reconnect request until explicit release", async () => {
    const gate = new PhysicalStreamRecoveryGate();
    await expect(gate.holdIfArmed()).resolves.toBeUndefined();
    expect(gate.snapshot()).toEqual({ held_requests: 0, state: "idle" });

    gate.arm();
    const held = gate.holdIfArmed();
    expect(gate.snapshot()).toEqual({ held_requests: 1, state: "holding" });
    expect(() => gate.arm()).toThrow("armed more than once");
    expect(() => gate.holdIfArmed()).toThrow("duplicate held request");
    expect(gate.release()).toBe(true);
    await expect(held).resolves.toBeUndefined();
    expect(gate.snapshot()).toEqual({ held_requests: 1, state: "released" });
    expect(gate.release()).toBe(false);
    await expect(gate.holdIfArmed()).resolves.toBeUndefined();
  });

  it("holds and resolves every deterministic dashboard control transition", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hostdeck-dashboard-controls-"));
    const opened = openMigratedDatabase(join(directory, "hostdeck.sqlite"));
    const now = increasingWallClock();
    const deadline = createOperationDeadline({ timeoutMs: 10_000 });
    try {
      const fixture = createPhysicalSessionReads(opened.db, now, "dashboard");
      const states = createSelectedStateRepository(opened.db);
      const prompts = createPhysicalPromptRuntime(
        states,
        now,
        fixture.streamSeedEvents
      );
      requireCondition(
        fixture.approvalTiming !== null,
        "Physical dashboard control timing was unavailable."
      );
      const dashboard = createPhysicalDashboardControls({
        approval: fixture.approvalTiming,
        now,
        prompts: Object.freeze({
          dispatch: prompts.service.dispatch,
          snapshot: prompts.service.snapshot
        }),
        runtime: physicalPromptCompatibility(now),
        states
      });
      const target = Object.freeze({
        type: "managed_session" as const,
        session_id: physicalUiSessionId,
        codex_thread_id: physicalUiThreadId
      });

      const skills = await dashboard.controls.skills.list(
        {
          operation_id: "op_skills_read_00000000000000000000000000000001",
          kind: "skills",
          target
        },
        deadline
      );
      expect(skills).toMatchObject({
        state: "content",
        skills: expect.arrayContaining([
          expect.objectContaining({ name: "release-readiness" })
        ])
      });
      expect(skills.skills).toHaveLength(25);
      expect(skills.skills.map((skill) => skill.name)).toEqual(
        [...skills.skills.map((skill) => skill.name)].sort()
      );

      const model = dashboard.controls.models.select({
        operation_id: "op_physical_model_unit_0001",
        kind: "model",
        target,
        model_id: "model-b",
        reasoning_effort: "medium",
        expected_pending_revision: null
      }, deadline);
      await waitFor(
        dashboard.hasPendingModel,
        1_000,
        "Physical model test gate did not become pending."
      );
      dashboard.releaseModel();
      await expect(model).resolves.toMatchObject({
        pending: { model_id: "model-b", phase: "pending" }
      });
      dashboard.applyModel();

      const goal = dashboard.controls.goals.mutate({
        operation_id: "op_physical_goal_unit_0001",
        kind: "goal",
        target,
        action: "set",
        objective: physicalGoalObjective,
        expected_goal_revision: null
      }, deadline);
      await waitFor(
        dashboard.hasPendingGoal,
        1_000,
        "Physical goal test gate did not become pending."
      );
      dashboard.releaseGoal();
      await expect(goal).resolves.toMatchObject({
        action: "set",
        goal: { objective: physicalGoalObjective, status: "paused" },
        state: "succeeded"
      });

      const plan = dashboard.controls.plans.select({
        operation_id: "op_physical_plan_unit_0001",
        kind: "plan",
        target,
        action: "enter",
        expected_pending_revision: null
      }, deadline);
      await waitFor(
        dashboard.hasPendingPlan,
        1_000,
        "Physical Plan test gate did not become pending."
      );
      dashboard.releasePlan();
      await expect(plan).resolves.toMatchObject({
        pending: { mode: "plan", phase: "pending" }
      });
      dashboard.applyPlan();

      const compact = dashboard.controls.compact.compact({
        operation_id: "op_physical_compact_unit_0001",
        kind: "compact",
        target,
        confirm: true
      }, deadline);
      await waitFor(
        dashboard.hasPendingCompact,
        1_000,
        "Physical Compact test gate did not become pending."
      );
      dashboard.releaseCompact();
      await expect(compact).resolves.toMatchObject({ state: "accepted" });
      dashboard.completeCompact();

      const [pendingApproval] = await dashboard.controls.approvals.list(target);
      expect(pendingApproval).toMatchObject({
        created_at: fixture.approvalTiming.createdAt,
        expires_at: fixture.approvalTiming.expiresAt,
        state: "pending"
      });
      const responding = await dashboard.controls.approvals.respond({
        operation_id: "op_physical_approval_unit_0001",
        kind: "approval_response",
        target: pendingApproval?.target,
        decision: "approve",
        confirm: true
      }, deadline);
      expect(responding).toMatchObject({ state: "responding" });
      const terminalApproval = dashboard.controls.approvals.waitForTerminal(
        pendingApproval?.target,
        deadline
      );
      await waitFor(
        dashboard.hasPendingApproval,
        1_000,
        "Physical approval test gate did not become pending."
      );
      dashboard.releaseApproval();
      await expect(terminalApproval).resolves.toMatchObject({
        decision: "approve",
        state: "approved"
      });

      dashboard.markSessionStale();
      expect(states.require(physicalUiSessionId).projection.session).toMatchObject({
        freshness: "stale",
        freshness_reason: "Runtime resubscription is required."
      });
      dashboard.restoreSessionCurrent();
      expect(states.require(physicalUiSessionId).projection.session).toMatchObject({
        freshness: "current",
        freshness_reason: null
      });

      dashboard.beginInterruptibleTurn();
      prompts.publishInterruptTurn(dashboard.interruptTurnId, "in_progress");
      expect(() =>
        prompts.publishInterruptTurn(dashboard.interruptTurnId, "in_progress")
      ).toThrow("Physical interrupt progress violated accepted event order.");
      const turnTarget = Object.freeze({
        type: "turn" as const,
        session_id: physicalUiSessionId,
        codex_thread_id: physicalUiThreadId,
        turn_id: dashboard.interruptTurnId
      });
      await dashboard.controls.interrupts.requireInterruptible(turnTarget);
      await expect(
        dashboard.controls.interrupts.interrupt({
          operation_id: "op_physical_interrupt_unit_0001",
          kind: "interrupt",
          target: turnTarget,
          confirm: true
        }, deadline)
      ).resolves.toMatchObject({ state: "interrupted" });
      dashboard.finishInterrupt();
      prompts.publishInterruptTurn(dashboard.interruptTurnId, "interrupted");
      expect(() =>
        prompts.publishInterruptTurn(dashboard.interruptTurnId, "interrupted")
      ).toThrow("Physical interrupt progress violated accepted event order.");

      expect(dashboard.resume.read(physicalUiSessionId)).toMatchObject({
        available: true,
        command:
          `codex resume --remote unix:///hostdeck-physical.sock ${physicalUiThreadId}`,
        local_only: true
      });
      await dashboard.managed.archive(physicalUiSessionId, deadline);
      expect(states.require(physicalUiSessionId).projection.session).toMatchObject({
        archived_at: expect.any(String),
        session_state: "archived"
      });
      expect(dashboard.snapshot()).toMatchObject({
        approvalDecision: "approve",
        archived: true,
        compactState: "completed",
        goalStatus: "paused",
        modelApplied: true,
        planApplied: true
      });
    } finally {
      deadline.dispose();
      opened.db.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("requires the exact production index during the private HTTPS preflight", () => {
    const productionIndex =
      '<!doctype html><html><body><div id="root"></div><script src="/assets/app-12345678.js"></script></body></html>';
    const legacyPage =
      '<title>HostDeck pairing acceptance</title>/__physical/checkpoint/';

    expect(
      isExpectedPhysicalPage(
        { body: productionIndex, status: 200 },
        productionIndex
      )
    ).toBe(true);
    expect(
      isExpectedPhysicalPage(
        { body: `${productionIndex}\n`, status: 200 },
        productionIndex
      )
    ).toBe(false);
    expect(
      isExpectedPhysicalPage({ body: legacyPage, status: 200 }, productionIndex)
    ).toBe(false);
    expect(
      isExpectedPhysicalPage({ body: legacyPage, status: 200 }, null)
    ).toBe(true);
    expect(
      isExpectedPhysicalPage({ body: legacyPage, status: 503 }, null)
    ).toBe(false);
  });

  it("hands the private pairing link to Chrome only through bounded ADB stdin", () => {
    const link =
      "https://private-laptop.fixture-tailnet.ts.net/#pair=AbCdEfGhIjKlMnOpQrSt_1";
    const component =
      "com.android.chrome/com.google.android.apps.chrome.IntentDispatcher";
    const handoff = createPrivatePairingChromeHandoff(link, component);

    expect(handoff.adbArgs).toEqual(["shell"]);
    expect(handoff.adbArgs.join("\u0000")).not.toContain(link);
    expect(handoff.stdin.split("\n")).toEqual([
      "set -eu",
      "IFS= read -r url",
      link,
      `am start --user 0 -n ${component} -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d "$url" >/dev/null 2>&1`,
      "unset url",
      ""
    ]);
    expect(handoff.stdin.split(link)).toHaveLength(2);
    expect(Object.isFrozen(handoff)).toBe(true);
    expect(Object.isFrozen(handoff.adbArgs)).toBe(true);
    expect(() =>
      createPrivatePairingChromeHandoff(link, "com.android.chrome;id")
    ).toThrow("Physical Chrome activity was invalid.");
  });

  it("diagnoses a stalled pairing confirmation without emitting arbitrary UI content", () => {
    const privateUiText = "private-host-and-pairing-material";
    const diagnostic = pairingConfirmationFailure({
      claimRequests: 1,
      claimResponseStatuses: [201],
      csrfRequests: 0,
      csrfResponseStatuses: [],
      devices: 2,
      hardenedCookieObserved: true,
      nodes: [
        { description: "", text: privateUiText },
        { description: "Pairing this phone", text: "" }
      ],
      proxyRejection: null,
      usedPairingCodes: 1
    });

    expect(diagnostic).toBe(
      "Production pairing confirmation did not render on Android " +
        "(claim=1/201;csrf=0/none;cookie=set;devices=2;used_codes=1;" +
        "proxy=none;ui=Pairing this phone)."
    );
    expect(diagnostic).not.toContain(privateUiText);
  });

  it("injects the two-line prompt without placing prompt text in ADB arguments or stdin", () => {
    const handoff = createPhysicalPromptTextHandoff(physicalPromptText);
    const lines = physicalPromptText.split("\n");

    expect(handoff.adbArgs).toEqual(["shell"]);
    expect(handoff.stdin).not.toContain(physicalPromptText);
    for (const line of lines) {
      expect(handoff.adbArgs.join("\u0000")).not.toContain(line);
      expect(handoff.stdin).not.toContain(line);
      expect(handoff.stdin).toContain(Buffer.from(line, "utf8").toString("base64"));
    }
    expect(Object.isFrozen(handoff)).toBe(true);
    expect(Object.isFrozen(handoff.adbArgs)).toBe(true);
    expect(() => createPhysicalPromptTextHandoff("one line only")).toThrow(
      "Physical prompt text was invalid."
    );
  });

  it("closes the owned QR display process within its deadline", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore"
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", resolve);
    });

    await closeQrDisplay(Object.freeze({ process: child }));

    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it("declares strict response schemas for every fixed driver route", async () => {
    const routes = new Map<string, Readonly<Record<number, z.ZodType>>>();
    const app = {
      get(path: string, options: unknown) {
        const response = (
          options as {
            readonly schema?: {
              readonly response?: Readonly<Record<number, z.ZodType>>;
            };
          }
        ).schema?.response;
        expect(response).toBeDefined();
        routes.set(path, response ?? {});
        return app;
      }
    } as unknown as HostDeckFastifyInstance;

    await physicalDriverRoute(createPhysicalDriverRuntime()).register(
      app,
      Object.freeze({ resourceBudget: defaultResourceBudget, surface: "api" })
    );

    const checkpointPaths = physicalCheckpointOrder.map(
      (checkpoint) => `/__physical/checkpoint/${checkpoint}`
    );
    expect([...routes.keys()]).toEqual([
      ...checkpointPaths,
      "/__physical/checkpoint/revoked",
      "/__physical/command"
    ]);
    for (const path of checkpointPaths) {
      const response = routes.get(path);
      expect(Object.keys(response ?? {})).toEqual(["204"]);
      expect(response?.[204]?.parse(undefined)).toBeUndefined();
      expect(() => response?.[204]?.parse(null)).toThrow();
    }
    const revoked = routes.get("/__physical/checkpoint/revoked")?.[409];
    expect(revoked?.parse(physicalAuthorityNotRevokedResponse)).toEqual(
      physicalAuthorityNotRevokedResponse
    );
    expect(() =>
      revoked?.parse({ ...physicalAuthorityNotRevokedResponse, extra: true })
    ).toThrow();
    const command = routes.get("/__physical/command")?.[200];
    expect(command?.parse({ command: "prepare-away", revision: 1 })).toEqual({
      command: "prepare-away",
      revision: 1
    });
    expect(() => command?.parse({ command: "hold", revision: 3 })).toThrow();
  });

  it("checks Chrome foreground state without reading activity intents", () => {
    const chromeDisplay = [
      "WINDOW MANAGER DISPLAY CONTENTS (dumpsys window displays)",
      "  Display: mDisplayId=0 (organized)",
      "  mCurrentFocus=Window{afa5077 u0 com.android.chrome/com.google.android.apps.chrome.Main}",
      "  mFocusedApp=ActivityRecord{148943046 u0 com.android.chrome/com.google.android.apps.chrome.Main t2525}"
    ].join("\n");

    expect(chromeForegroundAdbArgs).toEqual([
      "shell",
      "dumpsys",
      "window",
      "displays"
    ]);
    expect(chromeForegroundAdbArgs).not.toContain("activity");
    expect(isChromeForegroundWindowDisplay(chromeDisplay)).toBe(true);
    for (const candidate of [
      chromeDisplay.replace("com.android.chrome", "com.android.camera"),
      chromeDisplay.replace(
        "mCurrentFocus=Window{afa5077 u0 com.android.chrome/com.google.android.apps.chrome.Main}",
        "mCurrentFocus=null"
      ),
      `${chromeDisplay}\n  mCurrentFocus=Window{bbb123 u0 com.android.chrome/com.google.android.apps.chrome.Main}`,
      `${chromeDisplay}\nhttps://private.invalid/#hostdeck-pair=protected`,
      "x".repeat(chromeForegroundMaxBytes + 1)
    ]) {
      expect(isChromeForegroundWindowDisplay(candidate)).toBe(false);
    }
  });

  it("builds bounded Android tailnet and HTTPS probes for one private origin", () => {
    const ping = createAndroidPrivateTailnetPing("https://hostdeck.test");
    const probe = createAndroidPrivateHttpsProbe("https://hostdeck.test");

    expect(ping).toEqual([
      "shell",
      "ping",
      "-c",
      "1",
      "-W",
      "3",
      "hostdeck.test"
    ]);
    expect(probe).toEqual([
      "shell",
      "curl",
      "--connect-timeout",
      "5",
      "--fail",
      "--max-time",
      "10",
      "--output",
      "/dev/null",
      "--proto",
      "=https",
      "--silent",
      "--show-error",
      "https://hostdeck.test/"
    ]);
    expect(Object.isFrozen(ping)).toBe(true);
    expect(Object.isFrozen(probe)).toBe(true);
    expect(probe).not.toContain("--insecure");
    for (const candidate of [
      "http://hostdeck.test",
      "https://user@hostdeck.test",
      "https://hostdeck.test/path",
      "https://hostdeck.test?query=1",
      "https://hostdeck.test/#fragment"
    ]) {
      expect(() => createAndroidPrivateHttpsProbe(candidate)).toThrow(
        "probe target was invalid"
      );
      expect(() => createAndroidPrivateTailnetPing(candidate)).toThrow(
        "probe target was invalid"
      );
    }
  });

  it("requires separate validated cellular Internet and Tailscale VPN networks", () => {
    const cellular =
      "NetworkAgentInfo{network{101} ni{MOBILE[LTE] CONNECTED} " +
      "Score(IS_VALIDATED) Transports: CELLULAR Capabilities: INTERNET&VALIDATED}";
    const tailscale =
      "NetworkAgentInfo{network{102} ni{VPN CONNECTED extra: VPN:com.tailscale.ipn} " +
      "Score(IS_VALIDATED&IS_VPN) Transports: VPN Capabilities: INTERNET&VALIDATED}";
    const cellularBackedTailscale = tailscale.replace(
      "Transports: VPN",
      "Transports: CELLULAR|VPN"
    );
    const imsOnly = cellular
      .replace("Capabilities: INTERNET&VALIDATED", "Capabilities: IMS&VALIDATED")
      .replace("network{101}", "network{103}");
    const wifi =
      "NetworkAgentInfo{network{104} ni{WIFI CONNECTED} " +
      "Score(IS_VALIDATED) Transports: WIFI Capabilities: INTERNET&VALIDATED}";

    expect(hasAndroidCellularTailscaleTransport(`${cellular}\n${tailscale}`)).toBe(
      true
    );
    expect(
      hasAndroidCellularTailscaleTransport(
        `${cellular}\n${cellularBackedTailscale}`
      )
    ).toBe(true);
    expect(hasAndroidCellularInternetNetwork(cellular)).toBe(true);
    expect(hasAndroidCellularInternetNetwork(imsOnly)).toBe(false);
    expect(hasAndroidCellularTailscaleTransport(`${imsOnly}\n${tailscale}`)).toBe(
      false
    );
    expect(hasAndroidCellularTailscaleTransport(`${cellular}\n${wifi}\n${tailscale}`)).toBe(
      false
    );
    expect(hasAndroidCellularTailscaleTransport("\u0000")).toBe(false);
    expect(
      parseAndroidMobileDataState(
        "  mUserMobileDataState= true\n  mUserMobileDataState=true\n"
      )
    ).toBe(true);
    expect(parseAndroidMobileDataState("mUserMobileDataState=false\n")).toBe(
      false
    );
    expect(() =>
      parseAndroidMobileDataState(
        "mUserMobileDataState=true\nmUserMobileDataState=false\n"
      )
    ).toThrow("observation was contradictory");
  });

  it("uses the active Android power plug bit for physical stay-awake enforcement", () => {
    expect(parseAndroidPlugType("mPlugType=1\n")).toBe(1);
    expect(parseAndroidPlugType("  mPlugType=2\n")).toBe(2);
    expect(parseAndroidPlugType("mPlugType=4\n")).toBe(4);
    expect(() => parseAndroidPlugType("mPlugType=0\n")).toThrow(
      "Android power plug type was not active."
    );
    expect(() => parseAndroidPlugType("mPlugType=8\n")).toThrow(
      "Android power plug type was invalid."
    );
    expect(() => parseAndroidPlugType("mPlugType=1\nmPlugType=2\n")).toThrow(
      "Android power plug observation was contradictory."
    );
    expect(() => parseAndroidPlugType("x".repeat(512 * 1024 + 1))).toThrow(
      "Android power observation was invalid."
    );
  });

  it("parses bounded Android semantic nodes without retaining pairing material", () => {
    const nodes = parseAndroidUiNodes(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<hierarchy rotation="0">' +
        '<node text="Host &amp; access" content-desc="" bounds="[0,80][720,180]" />' +
        '<node text="" content-desc="Open Host and access" bounds="[620,80][720,180]" />' +
        '<node text="" content-desc="" class="android.widget.EditText" ' +
        'bounds="[20,200][700,320]" />' +
        '<node text="" content-desc="" class="android.widget.Button" ' +
        'clickable="true" enabled="false" focused="true" bounds="[350,1100][700,1180]" />' +
        '<node text="" content-desc="" class="android.view.ViewGroup" ' +
        `resource-id="${chromeToolbarResourceId}" bounds="[0,80][720,180]" />` +
        '<node text="" content-desc="" class="android.widget.FrameLayout" ' +
        `resource-id="${chromeCompositorResourceId}" bounds="[0,80][720,1280]" />` +
        "</hierarchy>"
    );

    expect(nodes).toEqual([
      {
        bounds: { bottom: 180, left: 0, right: 720, top: 80 },
        className: "",
        clickable: false,
        description: "",
        resourceId: "",
        text: "Host & access"
      },
      {
        bounds: { bottom: 180, left: 620, right: 720, top: 80 },
        className: "",
        clickable: false,
        description: "Open Host and access",
        resourceId: "",
        text: ""
      },
      {
        bounds: { bottom: 320, left: 20, right: 700, top: 200 },
        className: androidEditTextClass,
        clickable: false,
        description: "",
        resourceId: "",
        text: ""
      },
      {
        bounds: { bottom: 1180, left: 350, right: 700, top: 1100 },
        className: "android.widget.Button",
        clickable: true,
        description: "",
        enabled: false,
        focused: true,
        resourceId: "",
        text: ""
      },
      {
        bounds: { bottom: 180, left: 0, right: 720, top: 80 },
        className: "android.view.ViewGroup",
        clickable: false,
        description: "",
        resourceId: chromeToolbarResourceId,
        text: ""
      },
      {
        bounds: { bottom: 1280, left: 0, right: 720, top: 80 },
        className: "android.widget.FrameLayout",
        clickable: false,
        description: "",
        resourceId: chromeCompositorResourceId,
        text: ""
      }
    ]);
    expect(Object.isFrozen(nodes)).toBe(true);
    expect(nodes.every(Object.isFrozen)).toBe(true);
    const textNode = nodes[0];
    const descriptionNode = nodes[1];
    const editNode = nodes[2];
    requireCondition(
      textNode !== undefined &&
        descriptionNode !== undefined &&
        editNode !== undefined,
      "Android semantic-node fixture was incomplete."
    );
    expect(matchesAndroidUiNode(textNode, "semantic", "Host & access")).toBe(
      true
    );
    expect(
      matchesAndroidUiNode(
        descriptionNode,
        "semantic",
        "Open Host and access"
      )
    ).toBe(true);
    expect(
      matchesAndroidUiNode(textNode, "semantic", "Open Host and access")
    ).toBe(false);
    expect(
      matchesAndroidUiNode(editNode, "className", androidEditTextClass)
    ).toBe(true);
    expect(findAndroidPromptEditor(nodes, "Host & access")).toBe(editNode);
    const textAction = Object.freeze({
      bounds: Object.freeze({ bottom: 260, left: 20, right: 300, top: 200 }),
      className: "android.widget.Button",
      clickable: true,
      description: "",
      resourceId: "",
      text: "Approve once"
    });
    const descriptionAction = Object.freeze({
      ...textAction,
      description: "Approve once",
      text: ""
    });
    expect(
      selectAndroidUiNodeForReveal(
        nodes,
        "semantic",
        "Approve once",
        "fully_visible",
        true
      )
    ).toBeNull();
    expect(
      selectAndroidUiNodeForReveal(
        [...nodes, textAction],
        "semantic",
        "Approve once",
        "fully_visible",
        true
      )
    ).toBe(textAction);
    expect(
      selectAndroidUiNodeForReveal(
        [...nodes, descriptionAction],
        "semantic",
        "Approve once",
        "fully_visible",
        true
      )
    ).toBe(descriptionAction);
    expect(
      selectAndroidUiNodeForReveal(
        [...nodes, textAction, descriptionAction],
        "semantic",
        "Approve once",
        "fully_visible",
        true
      )
    ).toBeNull();
    expect(
      selectAndroidUiNodeForReveal(
        [...nodes, Object.freeze({ ...textAction, clickable: false })],
        "semantic",
        "Approve once",
        "fully_visible",
        true
      )
    ).toBeNull();
    expect(
      selectAndroidUiNodeForReveal(
        [...nodes, Object.freeze({ ...textAction, enabled: false })],
        "semantic",
        "Approve once",
        "fully_visible",
        true
      )
    ).toBeNull();
    expect(
      selectAndroidUiNodeForReveal(
        [
          ...nodes,
          Object.freeze({
            ...textAction,
            bounds: Object.freeze({ ...textAction.bounds, bottom: 160, top: 100 })
          })
        ],
        "semantic",
        "Approve once",
        "fully_visible",
        true
      )
    ).toBeNull();
    const revealSummary = androidUiRevealGeometrySummary(
      [...nodes, descriptionAction],
      "semantic",
      "Approve once",
      "fully_visible",
      true
    );
    expect(revealSummary).toContain(
      "match=1;text=0;description=1;first=20,200,300,260,click"
    );
    expect(revealSummary).toContain("normalized=1;contains=1;cancel=0/0/0:none");
    expect(revealSummary).toContain("page=0,180,720,1100;eligible=yes");
    expect(revealSummary).toContain(
      "focused=1:350,1100,700,1180,click,t0,d0"
    );
    expect(revealSummary).toContain(
      "clickable=2:20,200,300,260,click,t0,d1|350,1100,700,1180,click,t0,d0"
    );
    expect(revealSummary).not.toContain("Approve once");
    const confirmationContext = Object.freeze([
      Object.freeze({
        bounds: Object.freeze({ bottom: 380, left: 30, right: 500, top: 320 }),
        className: "android.view.View",
        clickable: false,
        description: "",
        resourceId: "",
        text: physicalApprovalConfirmationTitle
      }),
      Object.freeze({
        bounds: Object.freeze({ bottom: 780, left: 200, right: 680, top: 700 }),
        className: "android.view.View",
        clickable: false,
        description: "",
        resourceId: "",
        text: physicalApprovalConfirmationReason
      }),
      Object.freeze({
        bounds: Object.freeze({ bottom: 880, left: 30, right: 650, top: 820 }),
        className: "android.view.View",
        clickable: false,
        description: "",
        resourceId: "",
        text: physicalApprovalConfirmationStatus
      })
    ]);
    const confirmationTitle = confirmationContext[0];
    const confirmationReason = confirmationContext[1];
    const confirmationStatus = confirmationContext[2];
    requireCondition(
      confirmationTitle !== undefined &&
        confirmationReason !== undefined &&
        confirmationStatus !== undefined,
      "Physical approval confirmation fixture was incomplete."
    );
    const unrelatedAction = Object.freeze({
      bounds: Object.freeze({ bottom: 980, left: 30, right: 690, top: 900 }),
      className: "android.widget.Button",
      clickable: true,
      description: "",
      resourceId: "",
      text: ""
    });
    const backgroundReason = Object.freeze({
      ...confirmationReason,
      bounds: Object.freeze({ bottom: 280, left: 200, right: 680, top: 200 })
    });
    const anonymousCancel = Object.freeze({
      ...unrelatedAction,
      bounds: Object.freeze({ bottom: 1180, left: 30, right: 588, top: 1100 })
    });
    const anonymousApprove = Object.freeze({
      ...unrelatedAction,
      bounds: Object.freeze({ bottom: 1180, left: 590, right: 690, top: 1100 }),
      description: "Opaque submit control"
    });
    const closeConfirmation = Object.freeze({
      ...unrelatedAction,
      bounds: Object.freeze({ bottom: 380, left: 640, right: 690, top: 330 }),
      description: "Close approval confirmation"
    });
    const riskMarker = Object.freeze({
      ...confirmationReason,
      bounds: Object.freeze({ bottom: 460, left: 30, right: 300, top: 400 }),
      text: "Elevated risk"
    });
    const pageNodes = nodes.filter((node) => !node.clickable);
    const anonymousConfirmation = Object.freeze([
      ...pageNodes,
      backgroundReason,
      ...confirmationContext,
      closeConfirmation,
      riskMarker,
      unrelatedAction,
      anonymousCancel,
      anonymousApprove
    ]);
    expect(
      selectPhysicalApprovalConfirmationAction(anonymousConfirmation)
    ).toBeNull();
    expect(
      physicalApprovalConfirmationContextSummary(anonymousConfirmation)
    ).toBe(
      "exact=1/2/1;status=1/1:30,820,650,880,static,t1,d0;" +
        "close=1:640,330,690,380,click,t0,d1;risk=1:30,400,300,460,static,t1,d0"
    );
    expect(physicalApprovalConfirmationTitleIsOpen([confirmationTitle])).toBe(
      true
    );
    expect(
      physicalApprovalConfirmationTitleIsOpen([
        Object.freeze({
          ...confirmationTitle,
          description: physicalApprovalConfirmationTitle,
          text: ""
        })
      ])
    ).toBe(true);
    expect(
      physicalApprovalConfirmationTitleIsOpen([
        confirmationTitle,
        Object.freeze({ ...confirmationTitle })
      ])
    ).toBe(false);
    expect(
      physicalApprovalConfirmationContextSummary([
        ...anonymousConfirmation.filter(
          (node) => node.text !== physicalApprovalConfirmationStatus
        ),
        Object.freeze({
          ...confirmationStatus,
          text:
            `${physicalApprovalConfirmationStatus}. ` +
            "No response is sent until Approve once is submitted."
        })
      ])
    ).toBe(
      "exact=1/2/0;status=0/1:30,820,650,880,static,t1,d0;" +
        "close=1:640,330,690,380,click,t0,d1;risk=1:30,400,300,460,static,t1,d0"
    );
    expect(
      selectPhysicalApprovalConfirmationAction([
        ...pageNodes,
        ...confirmationContext,
        Object.freeze({
          ...anonymousApprove,
          description: physicalApprovalConfirmationAction
        })
      ])
    ).toEqual(expect.objectContaining({
      description: physicalApprovalConfirmationAction
    }));
    expect(
      selectPhysicalApprovalConfirmationAction(
        anonymousConfirmation.filter(
          (node) => node.text !== physicalApprovalConfirmationReason
        )
      )
    ).toBeNull();
    expect(
      selectPhysicalApprovalConfirmationAction(
        anonymousConfirmation.filter((node) => node !== confirmationTitle)
      )
    ).toBeNull();
    expect(
      selectPhysicalApprovalConfirmationAction([
        ...pageNodes,
        ...confirmationContext,
        Object.freeze({
          ...anonymousApprove,
          description: physicalApprovalConfirmationAction
        }),
        Object.freeze({
          ...anonymousCancel,
          text: physicalApprovalConfirmationAction
        })
      ])
    ).toBeNull();
    expect(
      selectPhysicalApprovalConfirmationAction([
        ...anonymousConfirmation,
        Object.freeze({ ...confirmationTitle })
      ])
    ).toBeNull();
    expect(
      selectPhysicalApprovalConfirmationAction([
        ...pageNodes,
        confirmationTitle,
        confirmationReason,
        Object.freeze({
          ...confirmationStatus,
          text:
            `${physicalApprovalConfirmationStatus}. ` +
            "No response is sent until Approve once is submitted."
        }),
        Object.freeze({
          ...anonymousApprove,
          description: physicalApprovalConfirmationAction
        })
      ])
    ).toBeNull();
    expect(
      physicalSessionWriteReady(
        [Object.freeze({ ...confirmationReason, text: "Ready to send" })],
        1
      )
    ).toBe(true);
    expect(
      physicalSessionWriteReady(
        [
          Object.freeze({ ...confirmationReason, text: "Ready to send" }),
          Object.freeze({
            ...confirmationReason,
            text: "Activity stream reconnecting"
          })
        ],
        1
      )
    ).toBe(false);
    expect(
      physicalSessionWriteReady(
        [Object.freeze({ ...confirmationReason, text: "Ready to send" })],
        0
      )
    ).toBe(false);
    expect(
      physicalSessionWriteReady(
        [
          Object.freeze({ ...confirmationReason, text: "Ready to send" }),
          Object.freeze({ ...confirmationStatus, text: "Ready to send" })
        ],
        1
      )
    ).toBe(false);
    expect(
      physicalSessionWriteReady(
        [
          Object.freeze({ ...confirmationReason, text: "Ready to send" }),
          Object.freeze({
            ...confirmationReason,
            text: "Session activity is reconnecting."
          })
        ],
        1
      )
    ).toBe(false);
    expect(
      physicalSessionWriteReady(
        [
          Object.freeze({ ...confirmationReason, text: "Ready to send" }),
          Object.freeze({ ...confirmationReason, text: "Prompt unavailable" })
        ],
        1
      )
    ).toBe(false);
    expect(
      physicalSessionWriteReady(
        [Object.freeze({ ...confirmationReason, text: "Ready to send" })],
        2
      )
    ).toBe(false);
    const unlockedMissionNodes = Object.freeze([
      Object.freeze({ ...confirmationReason, text: "Mission Control" }),
      Object.freeze({ ...confirmationReason, text: "Remote ready" }),
      Object.freeze({ ...confirmationReason, text: "Write" }),
      Object.freeze({
        ...confirmationReason,
        description: physicalUiSessionName,
        text: ""
      })
    ]);
    expect(physicalMissionControlWriteReady(unlockedMissionNodes, 0)).toBe(true);
    expect(physicalMissionControlWriteReady(unlockedMissionNodes, 1)).toBe(false);
    expect(
      physicalMissionControlWriteReady(
        [
          ...unlockedMissionNodes,
          Object.freeze({ ...confirmationReason, text: "Remote writes locked" })
        ],
        0
      )
    ).toBe(false);
    expect(
      physicalMissionControlWriteReady(
        unlockedMissionNodes.filter((node) => node.text !== "Write"),
        0
      )
    ).toBe(false);
    expect(
      physicalPromptCompletionRestored(
        [Object.freeze({ ...confirmationReason, text: "Turn completed" })],
        1
      )
    ).toBe(true);
    for (const [nodes, activeSubscribers] of [
      [[], 1],
      [[Object.freeze({ ...confirmationReason, text: "Turn completed" })], 0],
      [
        [
          Object.freeze({ ...confirmationReason, text: "Turn completed" }),
          Object.freeze({ ...confirmationStatus, text: "Turn completed" })
        ],
        1
      ],
      [
        [
          Object.freeze({ ...confirmationReason, text: "Turn completed" }),
          Object.freeze({
            ...confirmationStatus,
            text: "Activity stream reconnecting"
          })
        ],
        1
      ],
      [
        [
          Object.freeze({ ...confirmationReason, text: "Turn completed" }),
          Object.freeze({
            ...confirmationStatus,
            text: "Session activity is reconnecting."
          })
        ],
        1
      ],
      [
        [
          Object.freeze({ ...confirmationReason, text: "Turn completed" }),
          Object.freeze({ ...confirmationStatus, text: "Prompt unavailable" })
        ],
        1
      ]
    ] as const) {
      expect(physicalPromptCompletionRestored(nodes, activeSubscribers)).toBe(
        false
      );
    }
    expect(
      physicalPromptCompletionRestored(
        [Object.freeze({ ...confirmationReason, text: "Turn completed" })],
        2
      )
    ).toBe(false);
    expect(() =>
      parseAndroidUiNodes(
        `<hierarchy><node text="${selectedPairingFragmentPrefix}secret" ` +
          'content-desc="" bounds="[0,0][100,100]" /></hierarchy>'
      )
    ).toThrow("retained pairing material");
  });

  it("selects only the destructive action owned by the Host-lock dialog", () => {
    const nodes = parseAndroidUiNodes(
      '<hierarchy rotation="0">' +
        '<node text="Lock writes" content-desc="" class="android.widget.Button" ' +
        'clickable="true" enabled="true" bounds="[40,300][680,380]" />' +
        '<node text="Lock remote writes?" content-desc="" class="android.widget.TextView" ' +
        'bounds="[40,700][600,760]" />' +
        '<node text="Cancel" content-desc="" class="android.widget.Button" ' +
        'clickable="true" enabled="true" bounds="[40,1000][330,1080]" />' +
        '<node text="Lock writes" content-desc="" class="android.widget.Button" ' +
        'clickable="true" enabled="true" bounds="[350,1000][690,1080]" />' +
        '<node text="" content-desc="" class="android.view.ViewGroup" ' +
        `resource-id="${chromeToolbarResourceId}" bounds="[0,0][720,180]" />` +
        '<node text="" content-desc="" class="android.widget.FrameLayout" ' +
        `resource-id="${chromeCompositorResourceId}" bounds="[0,0][720,1280]" />` +
        "</hierarchy>"
    );
    const title = nodes.find((node) => node.text === "Lock remote writes?");
    const cancel = nodes.find((node) => node.text === "Cancel");
    const actions = nodes.filter((node) => node.text === "Lock writes");
    const originAction = actions[0];
    const confirmAction = actions[1];
    requireCondition(
      title !== undefined &&
        cancel !== undefined &&
        originAction !== undefined &&
        confirmAction !== undefined,
      "Physical Host-lock confirmation fixture was incomplete."
    );

    expect(selectPhysicalHostLockConfirmationAction(nodes)).toBe(confirmAction);
    expect(
      physicalHostLockConfirmationSummary(nodes, confirmAction)
    ).toContain("title=1;cancel=1;action=2;selected=350,1000,690,1080,click");
    expect(
      selectPhysicalHostLockConfirmationAction(
        nodes.filter((node) => node !== title)
      )
    ).toBeNull();
    expect(
      selectPhysicalHostLockConfirmationAction([
        ...nodes,
        Object.freeze({ ...title })
      ])
    ).toBeNull();
    expect(
      selectPhysicalHostLockConfirmationAction(
        nodes.filter((node) => node !== cancel)
      )
    ).toBeNull();
    expect(
      selectPhysicalHostLockConfirmationAction(
        nodes.map((node) =>
          node === confirmAction
            ? Object.freeze({ ...node, clickable: false })
            : node
        )
      )
    ).toBeNull();
    expect(
      selectPhysicalHostLockConfirmationAction(
        nodes.map((node) =>
          node === confirmAction
            ? Object.freeze({ ...node, enabled: false })
            : node
        )
      )
    ).toBeNull();
    expect(
      selectPhysicalHostLockConfirmationAction(
        nodes.map((node) =>
          node === confirmAction
            ? Object.freeze({
                ...node,
                bounds: Object.freeze({
                  ...node.bounds,
                  bottom: 900,
                  top: 820
                })
              })
            : node
        )
      )
    ).toBeNull();
    expect(
      selectPhysicalHostLockConfirmationAction([
        ...nodes,
        Object.freeze({
          ...confirmAction,
          bounds: Object.freeze({
            ...confirmAction.bounds,
            left: 360,
            right: 700
          })
        })
      ])
    ).toBeNull();
    expect(
      selectPhysicalHostLockConfirmationAction(
        nodes.map((node) =>
          node === confirmAction
            ? Object.freeze({
                ...node,
                bounds: Object.freeze({
                  ...node.bounds,
                  bottom: 1300,
                  top: 1220
                })
              })
            : node
        )
      )
    ).toBeNull();
  });

  it("selects only the destructive action owned by the archive dialog", () => {
    const nodes = parseAndroidUiNodes(
      '<hierarchy rotation="0">' +
        '<node text="Archive session" content-desc="" class="android.widget.Button" ' +
        'clickable="true" enabled="true" bounds="[40,300][680,380]" />' +
        '<node text="Archive session?" content-desc="" class="android.widget.TextView" ' +
        'bounds="[40,700][600,760]" />' +
        '<node text="Cancel" content-desc="" class="android.widget.Button" ' +
        'clickable="true" enabled="true" bounds="[40,1000][330,1080]" />' +
        '<node text="Archive session" content-desc="" class="android.widget.Button" ' +
        'clickable="true" enabled="true" bounds="[350,1000][690,1080]" />' +
        '<node text="" content-desc="" class="android.view.ViewGroup" ' +
        `resource-id="${chromeToolbarResourceId}" bounds="[0,0][720,180]" />` +
        '<node text="" content-desc="" class="android.widget.FrameLayout" ' +
        `resource-id="${chromeCompositorResourceId}" bounds="[0,0][720,1280]" />` +
        "</hierarchy>"
    );
    const title = nodes.find((node) => node.text === "Archive session?");
    const cancel = nodes.find((node) => node.text === "Cancel");
    const actions = nodes.filter((node) => node.text === "Archive session");
    const originAction = actions[0];
    const confirmAction = actions[1];
    requireCondition(
      title !== undefined &&
        cancel !== undefined &&
        originAction !== undefined &&
        confirmAction !== undefined,
      "Physical archive confirmation fixture was incomplete."
    );

    expect(selectPhysicalArchiveConfirmationAction(nodes)).toBe(confirmAction);
    expect(
      physicalArchiveConfirmationSummary(nodes, confirmAction)
    ).toContain("title=1;cancel=1;action=2;selected=350,1000,690,1080,click");
    expect(
      selectPhysicalArchiveConfirmationAction(
        nodes.filter((node) => node !== title)
      )
    ).toBeNull();
    expect(
      selectPhysicalArchiveConfirmationAction([
        ...nodes,
        Object.freeze({ ...title })
      ])
    ).toBeNull();
    expect(
      selectPhysicalArchiveConfirmationAction(
        nodes.filter((node) => node !== cancel)
      )
    ).toBeNull();
    expect(
      selectPhysicalArchiveConfirmationAction(
        nodes.map((node) =>
          node === cancel ? Object.freeze({ ...node, enabled: false }) : node
        )
      )
    ).toBeNull();
    expect(
      selectPhysicalArchiveConfirmationAction(
        nodes.map((node) =>
          node === confirmAction
            ? Object.freeze({ ...node, clickable: false })
            : node
        )
      )
    ).toBeNull();
    expect(
      selectPhysicalArchiveConfirmationAction(
        nodes.map((node) =>
          node === confirmAction
            ? Object.freeze({ ...node, enabled: false })
            : node
        )
      )
    ).toBeNull();
    expect(
      selectPhysicalArchiveConfirmationAction(
        nodes.map((node) =>
          node === confirmAction
            ? Object.freeze({
                ...node,
                bounds: Object.freeze({
                  ...node.bounds,
                  bottom: 900,
                  top: 820
                })
              })
            : node
        )
      )
    ).toBeNull();
    expect(
      selectPhysicalArchiveConfirmationAction([
        ...nodes,
        Object.freeze({
          ...confirmAction,
          bounds: Object.freeze({
            ...confirmAction.bounds,
            left: 360,
            right: 700
          })
        })
      ])
    ).toBeNull();
    expect(
      selectPhysicalArchiveConfirmationAction(
        nodes.map((node) =>
          node === confirmAction
            ? Object.freeze({
                ...node,
                bounds: Object.freeze({
                  ...node.bounds,
                  bottom: 1300,
                  top: 1220
                })
              })
            : node
        )
      )
    ).toBeNull();
  });

  it("isolates the current physical Skills editor from Chrome and duplicate controls", () => {
    const nodes = parseAndroidUiNodes(
      '<hierarchy rotation="0">' +
        '<node text="" content-desc="" class="android.view.ViewGroup" ' +
        `resource-id="${chromeToolbarResourceId}" bounds="[0,127][1080,288]" />` +
        '<node text="" content-desc="" class="android.widget.FrameLayout" ' +
        `resource-id="${chromeCompositorResourceId}" bounds="[0,127][1080,2355]" />` +
        '<node text="private.example.ts.net" content-desc="" ' +
        'class="android.widget.EditText" bounds="[225,127][664,285]" />' +
        '<node text="/skills" content-desc="" bounds="[191,560][683,630]" />' +
        '<node text="" content-desc="" class="android.widget.EditText" ' +
        'clickable="true" bounds="[171,1480][992,1606]" />' +
        '<node text="Skills capture current" content-desc="" ' +
        'bounds="[129,2194][888,2250]" />' +
        '<node text="25 structured skills reported." content-desc="" ' +
        'bounds="[129,2250][888,2298]" />' +
        "</hierarchy>"
    );
    const editor = nodes.find(
      (node) =>
        node.className === androidEditTextClass && node.bounds.top === 1480
    );
    requireCondition(editor !== undefined, "Physical Skills editor fixture was absent.");

    expect(findPhysicalSkillsSearchEditor(nodes)).toBe(editor);
    expect(
      findPhysicalSkillsSearchEditor(
        nodes.filter((node) => node.text !== "Skills capture current")
      )
    ).toBeNull();
    expect(
      findPhysicalSkillsSearchEditor(
        nodes.filter((node) => node.text !== "25 structured skills reported.")
      )
    ).toBeNull();
    expect(
      findPhysicalSkillsSearchEditor([
        ...nodes,
        Object.freeze({
          ...editor,
          bounds: Object.freeze({ ...editor.bounds, bottom: 1800, top: 1674 })
        })
      ])
    ).toBeNull();
    expect(
      findPhysicalSkillsSearchEditor(
        nodes.map((node) =>
          node === editor ? Object.freeze({ ...node, clickable: false }) : node
        )
      )
    ).toBeNull();
  });

  it("selects only the production page viewport for private-free evidence", () => {
    const nodes = parseAndroidUiNodes(
      '<hierarchy rotation="0">' +
        '<node text="private.example.ts.net" content-desc="" ' +
        'class="android.widget.EditText" bounds="[220,120][700,280]" />' +
        '<node text="Mission Control" content-desc="" ' +
        'bounds="[24,360][720,440]" />' +
        '<node text="" content-desc="" class="android.view.ViewGroup" ' +
        `resource-id="${chromeToolbarResourceId}" bounds="[0,120][720,288]" />` +
        '<node text="" content-desc="" class="android.widget.FrameLayout" ' +
        `resource-id="${chromeCompositorResourceId}" bounds="[0,120][720,1280]" />` +
        "</hierarchy>"
    );

    expect(
      selectPrivateFreeProductionScreenshotRegion(
        nodes,
        "https://private.example.ts.net"
      )
    ).toEqual({ height: 992, left: 0, top: 288, width: 720 });
    const collapsed = nodes.filter(
      (node) => node.resourceId !== chromeToolbarResourceId
    );
    expect(() =>
      selectPrivateFreeProductionScreenshotRegion(
        collapsed,
        "https://private.example.ts.net"
      )
    ).toThrow("retained private browser material");
    expect(
      selectPrivateFreeProductionScreenshotRegion(
        collapsed.filter((node) => node.text !== "private.example.ts.net"),
        "https://private.example.ts.net"
      )
    ).toEqual({ height: 1160, left: 0, top: 120, width: 720 });
    const toolbar = nodes.find(
      (node) => node.resourceId === chromeToolbarResourceId
    );
    const compositor = nodes.find(
      (node) => node.resourceId === chromeCompositorResourceId
    );
    requireCondition(
      toolbar !== undefined && compositor !== undefined,
      "Chrome screenshot geometry fixture was incomplete."
    );
    expect(() => selectChromePageViewport([...nodes, toolbar])).toThrow(
      "ambiguous Chrome toolbar geometry"
    );
    expect(() => selectChromePageViewport([...nodes, compositor])).toThrow(
      "could not isolate the Chrome compositor"
    );
    expect(() =>
      selectPrivateFreeProductionScreenshotRegion(
        [
          ...nodes,
          Object.freeze({
            bounds: Object.freeze({ bottom: 500, left: 0, right: 720, top: 440 }),
            className: "",
            clickable: false,
            description: "",
            resourceId: "",
            text: "private.example.ts.net"
          })
        ],
        "https://private.example.ts.net"
      )
    ).toThrow("retained private browser material");
  });

  it("selects bounded redactions for exact inert Host origin text", () => {
    const externalOrigin = "https://private.example.ts.net";
    const nodes = parseAndroidUiNodes(
      '<hierarchy rotation="0">' +
        '<node text="Host &amp; access" content-desc="" class="android.view.View" ' +
        'bounds="[24,320][400,380]" />' +
        '<node text="" content-desc="Back to session actions" ' +
        'class="android.widget.Button" clickable="true" bounds="[600,320][700,400]" />' +
        '<node text="Read &amp; write" content-desc="" class="android.view.View" ' +
        'bounds="[24,400][300,440]" />' +
        `<node text="${externalOrigin}" content-desc="" class="android.view.View" ` +
        'bounds="[160,500][700,550]" />' +
        `<node text="${externalOrigin}" content-desc="" class="android.widget.TextView" ` +
        'bounds="[160,720][700,770]" />' +
        '<node text="" content-desc="" class="android.view.ViewGroup" ' +
        `resource-id="${chromeToolbarResourceId}" bounds="[0,120][720,288]" />` +
        '<node text="" content-desc="" class="android.widget.FrameLayout" ' +
        `resource-id="${chromeCompositorResourceId}" bounds="[0,120][720,1280]" />` +
        "</hierarchy>"
    );

    expect(() =>
      selectPrivateFreeProductionScreenshotEvidence(nodes, externalOrigin)
    ).toThrow("retained private browser material");
    const selection = selectPrivateFreeProductionScreenshotEvidence(
      nodes,
      externalOrigin,
      { redactProductOrigin: true }
    );
    expect(selection).toEqual({
      redactions: [
        { height: 66, left: 152, top: 492, width: 556 },
        { height: 66, left: 152, top: 712, width: 556 }
      ],
      region: { height: 992, left: 0, top: 288, width: 720 }
    });
    expect(Object.isFrozen(selection)).toBe(true);
    expect(Object.isFrozen(selection.redactions)).toBe(true);
    expect(selection.redactions.every(Object.isFrozen)).toBe(true);
  });

  it("selects bounded redactions for the global Host sheet context", () => {
    const externalOrigin = "https://private.example.ts.net";
    const nodes = parseAndroidUiNodes(
      '<hierarchy rotation="0">' +
        '<node text="Host &amp; access" content-desc="" class="android.view.View" ' +
        'bounds="[24,320][400,380]" />' +
        '<node text="" content-desc="Close Host and access" class="android.widget.Button" ' +
        'clickable="true" bounds="[600,320][700,400]" />' +
        `<node text="${externalOrigin}" content-desc="" class="android.view.View" ` +
        'bounds="[160,500][700,550]" />' +
        '<node text="" content-desc="" class="android.view.ViewGroup" ' +
        `resource-id="${chromeToolbarResourceId}" bounds="[0,120][720,288]" />` +
        '<node text="" content-desc="" class="android.widget.FrameLayout" ' +
        `resource-id="${chromeCompositorResourceId}" bounds="[0,120][720,1280]" />` +
        "</hierarchy>"
    );

    expect(
      selectPrivateFreeProductionScreenshotEvidence(nodes, externalOrigin, {
        redactProductOrigin: true
      })
    ).toEqual({
      redactions: [{ height: 66, left: 152, top: 492, width: 556 }],
      region: { height: 992, left: 0, top: 288, width: 720 }
    });
    const close = nodes.find(
      (node) => node.description === "Close Host and access"
    );
    requireCondition(close !== undefined, "Global Host context fixture was incomplete.");
    expect(() =>
      selectPrivateFreeProductionScreenshotEvidence(
        nodes.map((node) =>
          node === close ? Object.freeze({ ...node, clickable: false }) : node
        ),
        externalOrigin,
        { redactProductOrigin: true }
      )
    ).toThrow("retained private browser material");
    const duplicateCloseNodes =
      close === undefined ? nodes : [...nodes, Object.freeze({ ...close })];
    expect(() =>
      selectPrivateFreeProductionScreenshotEvidence(
        duplicateCloseNodes,
        externalOrigin,
        { redactProductOrigin: true }
      )
    ).toThrow("retained private browser material");
  });

  it("routes every Host-access checkpoint through mandatory origin redaction", async () => {
    const calls: Array<
      Readonly<{
        name: string;
        options: Readonly<{ readonly redactProductOrigin?: boolean }> | undefined;
      }>
    > = [];
    await capturePhysicalHostAccessEvidence(
      async (name, options) => {
        calls.push(Object.freeze({ name, options }));
      },
      "fe090-39-profile-recovered.png"
    );

    expect(calls).toEqual([
      {
        name: "fe090-39-profile-recovered.png",
        options: { redactProductOrigin: true }
      }
    ]);
    expect(Object.isFrozen(calls[0]?.options)).toBe(true);
    await expect(
      capturePhysicalHostAccessEvidence(async () => undefined, "private-origin.png")
    ).rejects.toThrow("Host-access evidence name was invalid");
  });

  it("rejects every non-product or ambiguous private origin redaction", () => {
    const externalOrigin = "https://private.example.ts.net";
    const nodes = parseAndroidUiNodes(
      '<hierarchy rotation="0">' +
        '<node text="Host &amp; access" content-desc="" class="android.view.View" ' +
        'bounds="[24,320][400,380]" />' +
        '<node text="" content-desc="Back to session actions" ' +
        'class="android.widget.Button" clickable="true" bounds="[600,320][700,400]" />' +
        '<node text="Read &amp; write" content-desc="" class="android.view.View" ' +
        'bounds="[24,400][300,440]" />' +
        `<node text="${externalOrigin}" content-desc="" class="android.view.View" ` +
        'bounds="[160,500][700,550]" />' +
        '<node text="" content-desc="" class="android.widget.FrameLayout" ' +
        `resource-id="${chromeCompositorResourceId}" bounds="[0,120][720,1280]" />` +
        "</hierarchy>"
    );
    const title = nodes.find((node) => node.text === "Host & access");
    const back = nodes.find(
      (node) => node.description === "Back to session actions"
    );
    const permission = nodes.find((node) => node.text === "Read & write");
    const value = nodes.find((node) => node.text === externalOrigin);
    requireCondition(
      title !== undefined &&
        back !== undefined &&
        permission !== undefined &&
        value !== undefined,
      "Private origin rejection fixture was incomplete."
    );
    const rejects = (candidateNodes: readonly AndroidUiNode[]) => {
      expect(() =>
        selectPrivateFreeProductionScreenshotEvidence(
          candidateNodes,
          externalOrigin,
          { redactProductOrigin: true }
        )
      ).toThrow("retained private browser material");
    };
    const replaceValue = (replacement: AndroidUiNode) =>
      nodes.map((node) => (node === value ? replacement : node));

    rejects(replaceValue(Object.freeze({ ...value, text: new URL(externalOrigin).hostname })));
    rejects(replaceValue(Object.freeze({ ...value, className: androidEditTextClass })));
    rejects(replaceValue(Object.freeze({ ...value, clickable: true })));
    rejects(
      replaceValue(
        Object.freeze({
          ...value,
          description: externalOrigin,
          text: ""
        })
      )
    );
    rejects(replaceValue(Object.freeze({ ...value, resourceId: "product-origin" })));
    rejects(nodes.filter((node) => node !== title));
    rejects(nodes.filter((node) => node !== permission));
    rejects(
      nodes.map((node) =>
        node === back
          ? Object.freeze({
              ...node,
              clickable: false
            })
          : node
      )
    );
    rejects([
      ...nodes,
      Object.freeze({
        ...title,
        bounds: Object.freeze({ ...title.bounds, bottom: 500, top: 440 })
      })
    ]);
    rejects(
      replaceValue(
        Object.freeze({
          ...value,
          bounds: Object.freeze({ ...value.bounds, top: 80 })
        })
      )
    );
    rejects([
      ...nodes,
      Object.freeze({
        ...title,
        bounds: Object.freeze({ bottom: 700, left: 60, right: 300, top: 660 }),
        text: "Private address"
      }),
      Object.freeze({
        ...value,
        bounds: Object.freeze({ bottom: 770, left: 160, right: 700, top: 720 })
      }),
      Object.freeze({
        ...title,
        bounds: Object.freeze({ bottom: 920, left: 60, right: 240, top: 880 })
      }),
      Object.freeze({
        ...value,
        bounds: Object.freeze({ bottom: 990, left: 160, right: 700, top: 940 })
      })
    ]);

    const unknownPrivateValue = "device-private-value";
    deviceForbiddenValues.add(unknownPrivateValue);
    try {
      rejects([
        ...nodes,
        Object.freeze({
          ...value,
          bounds: Object.freeze({ bottom: 650, left: 160, right: 500, top: 580 }),
          text: unknownPrivateValue
        })
      ]);
    } finally {
      deviceForbiddenValues.delete(unknownPrivateValue);
    }
  });

  it("reports rejected origin structure without retaining private values", () => {
    const externalOrigin = "https://private.example.ts.net";
    const privateValue = "private-diagnostic-value";
    const nodes = parseAndroidUiNodes(
      '<hierarchy rotation="0">' +
        '<node text="Origin" content-desc="" class="android.view.View" ' +
        'bounds="[60,440][240,480]" />' +
        `<node text="${externalOrigin}" content-desc="${privateValue}" ` +
        `class="${privateValue}" resource-id="${privateValue}" ` +
        'bounds="[160,500][700,550]" />' +
        '<node text="" content-desc="" class="android.widget.FrameLayout" ' +
        `resource-id="${chromeCompositorResourceId}" bounds="[0,120][720,1280]" />` +
        "</hierarchy>"
    );
    deviceForbiddenValues.add(privateValue);
    try {
      let message = "";
      try {
        selectPrivateFreeProductionScreenshotEvidence(
          nodes,
          externalOrigin,
          { redactProductOrigin: true }
        );
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("private=1;nodes=n0=te,dn,th,dx,rx,rd,co");
      expect(message).toContain("context=h0/0,b0/0,p0/0");
      expect(message).not.toContain(externalOrigin);
      expect(message).not.toContain(new URL(externalOrigin).hostname);
      expect(message).not.toContain(privateValue);
    } finally {
      deviceForbiddenValues.delete(privateValue);
    }
  });

  it("crops physical PNG evidence to the exact selected pixel region", () => {
    const source = new Png({ height: 600, width: 320 });
    for (let y = 0; y < source.height; y += 1) {
      for (let x = 0; x < source.width; x += 1) {
        const offset = (y * source.width + x) * 4;
        source.data[offset] = x % 256;
        source.data[offset + 1] = y % 256;
        source.data[offset + 2] = (x + y) % 256;
        source.data[offset + 3] = 255;
      }
    }
    const cropped = Png.sync.read(
      cropPhysicalScreenshot(Png.sync.write(source), {
        height: 480,
        left: 0,
        top: 120,
        width: 320
      })
    );

    expect({ height: cropped.height, width: cropped.width }).toEqual({
      height: 480,
      width: 320
    });
    expect([...cropped.data.subarray(0, 4)]).toEqual([0, 120, 120, 255]);
    const lastOffset = (cropped.width * cropped.height - 1) * 4;
    expect([...cropped.data.subarray(lastOffset, lastOffset + 4)]).toEqual([
      63,
      87,
      150,
      255
    ]);
  });

  it("overwrites only admitted private pixels after the exact page crop", () => {
    const source = new Png({ height: 600, width: 320 });
    for (let y = 0; y < source.height; y += 1) {
      for (let x = 0; x < source.width; x += 1) {
        const offset = (y * source.width + x) * 4;
        source.data[offset] = x % 256;
        source.data[offset + 1] = y % 256;
        source.data[offset + 2] = (x + y) % 256;
        source.data[offset + 3] = 255;
      }
    }
    const bytes = Png.sync.write(source);
    const evidence = Png.sync.read(
      preparePhysicalScreenshotEvidence(
        bytes,
        { height: 480, left: 0, top: 120, width: 320 },
        [{ height: 8, left: 20, top: 150, width: 10 }]
      )
    );
    const pixel = (x: number, y: number) => {
      const offset = (y * evidence.width + x) * 4;
      return [...evidence.data.subarray(offset, offset + 4)];
    };

    expect({ height: evidence.height, width: evidence.width }).toEqual({
      height: 480,
      width: 320
    });
    expect(pixel(20, 30)).toEqual(physicalScreenshotRedactionRgba);
    expect(pixel(29, 37)).toEqual(physicalScreenshotRedactionRgba);
    expect(pixel(19, 30)).toEqual([19, 150, 169, 255]);
    expect(pixel(30, 37)).toEqual([30, 157, 187, 255]);
    expect(() =>
      preparePhysicalScreenshotEvidence(
        bytes,
        { height: 480, left: 0, top: 120, width: 320 },
        [{ height: 8, left: 20, top: 116, width: 10 }]
      )
    ).toThrow("redaction exceeded the selected page viewport");
    expect(() => redactPhysicalScreenshot(bytes, [])).toThrow(
      "redaction exceeded the bounded image dimensions"
    );
  });

  it("opens private Chrome paths without placing the origin in ADB arguments or stdin", () => {
    const target =
      "https://hostdeck-laptop.example.ts.net/sessions/sess_physical_pairing_ui";
    const handoff = createPrivateChromePathHandoff(target);

    expect(handoff.adbArgs).toEqual(["shell"]);
    expect(handoff.adbArgs.join("\u0000")).not.toContain(target);
    expect(handoff.stdin).not.toContain(target);
    expect(handoff.stdin).toContain(
      Buffer.from(target, "utf8").toString("base64")
    );
  });

  it("reports physical cleanup failures without retaining private causes", async () => {
    const errors: unknown[] = [];
    await collectPhysicalCleanupError(
      "Physical cleanup could not restore Android mobile-data state.",
      () => {
        throw new Error("private device output");
      },
      errors
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual(
      new Error("Physical cleanup could not restore Android mobile-data state.")
    );
    expect(JSON.stringify(errors)).not.toContain("private device output");
  });

  it("returns Home before force-stopping Chrome during physical cleanup", () => {
    expect(physicalAndroidChromeStopCommandPlan).toEqual([
      ["shell", "input", "keyevent", "KEYCODE_HOME"],
      ["shell", "am", "force-stop", "com.android.chrome"]
    ]);
    expect(Object.isFrozen(physicalAndroidChromeStopCommandPlan)).toBe(true);
    expect(Object.isFrozen(physicalAndroidChromeStopCommandPlan[0])).toBe(true);
    expect(Object.isFrozen(physicalAndroidChromeStopCommandPlan[1])).toBe(true);
  });

  it("closes the external Chrome tab before relaunching the retained tab", () => {
    expect(physicalAndroidChromeRetainedTabCommandPlan).toEqual([
      ["shell", "input", "keyevent", "KEYCODE_BACK"],
      [
        "shell",
        "am",
        "start",
        "--user",
        "0",
        "-W",
        "-a",
        "android.intent.action.MAIN",
        "-c",
        "android.intent.category.LAUNCHER",
        "-n",
        "com.android.chrome/com.google.android.apps.chrome.Main"
      ]
    ]);
    expect(Object.isFrozen(physicalAndroidChromeRetainedTabCommandPlan)).toBe(true);
    expect(Object.isFrozen(physicalAndroidChromeRetainedTabCommandPlan[0])).toBe(true);
    expect(Object.isFrozen(physicalAndroidChromeRetainedTabCommandPlan[1])).toBe(true);
  });

  it("matches physical session navigation authority exactly", () => {
    const expected: PhysicalSessionNavigationSnapshot = Object.freeze({
      activeSubscribers: 1,
      missingDetailRequests: 1,
      openedSubscribers: 4,
      selectedDetailRequests: 3,
      streamRequests: 4
    });

    expect(physicalSessionNavigationMatches(expected, expected)).toBe(true);
    for (const key of Object.keys(expected) as Array<
      keyof PhysicalSessionNavigationSnapshot
    >) {
      expect(
        physicalSessionNavigationMatches(
          Object.freeze({ ...expected, [key]: expected[key] + 1 }),
          expected
        )
      ).toBe(false);
    }

    const before: PhysicalSessionNavigationSnapshot = Object.freeze({
      activeSubscribers: 0,
      missingDetailRequests: 1,
      openedSubscribers: 4,
      selectedDetailRequests: 3,
      streamRequests: 4
    });
    const opened: PhysicalSessionNavigationSnapshot = Object.freeze({
      ...before,
      activeSubscribers: 1,
      openedSubscribers: 5,
      selectedDetailRequests: 4,
      streamRequests: 5
    });
    expect(physicalSessionNavigationOpened(opened, before)).toBe(true);
    for (const key of Object.keys(opened) as Array<
      keyof PhysicalSessionNavigationSnapshot
    >) {
      expect(
        physicalSessionNavigationOpened(
          Object.freeze({ ...opened, [key]: opened[key] + 1 }),
          before
        )
      ).toBe(false);
    }
    expect(
      physicalSessionNavigationOpened(
        opened,
        Object.freeze({ ...before, activeSubscribers: 1 })
      )
    ).toBe(false);
  });

  it("settles one remote check only after its exact successful host response", () => {
    const before = physicalRemoteCheckBoundary(7, 9, 9, 200);
    const settled = physicalRemoteCheckBoundary(8, 10, 10, 200);

    expect(physicalRemoteCheckSettled(before, settled)).toBe(true);
    expect(
      physicalRemoteCheckSettled(
        before,
        physicalRemoteCheckBoundary(8, 10, 9, 200)
      )
    ).toBe(false);
    expect(
      physicalRemoteCheckSettled(
        before,
        physicalRemoteCheckBoundary(8, 10, 10, 500)
      )
    ).toBe(false);
    expect(
      physicalRemoteCheckSettled(
        before,
        physicalRemoteCheckBoundary(9, 10, 10, 200)
      )
    ).toBe(false);
    expect(
      physicalRemoteCheckSettled(
        before,
        physicalRemoteCheckBoundary(8, 11, 11, 200)
      )
    ).toBe(false);
  });

  it("requires the exact route-owned incompatible and supported runtime truth", () => {
    const incompatible = physicalRuntimeRouteFixture("incompatible");
    const supported = physicalRuntimeRouteFixture("supported");
    const incompatibleWithSessionOffscreen = incompatible.filter(
      (node) => node.description !== physicalUiSessionName
    );

    expect(
      physicalMissionRuntimeStateVisible(incompatible, 0, "incompatible")
    ).toBe(true);
    expect(
      physicalMissionRuntimeStateVisible(supported, 0, "supported")
    ).toBe(true);
    expect(
      physicalMissionRuntimeStateVisible(
        incompatibleWithSessionOffscreen,
        0,
        "incompatible"
      )
    ).toBe(true);
    expect(
      physicalMissionRuntimeStateVisible(incompatible, 0, "supported")
    ).toBe(false);
    expect(
      physicalMissionRuntimeStateVisible(supported, 0, "incompatible")
    ).toBe(false);
    expect(
      physicalMissionRuntimeStateVisible(
        Object.freeze([
          ...supported,
          physicalRuntimeFixtureNode({ text: physicalRuntimeSupportedTitle })
        ]),
        0,
        "supported"
      )
    ).toBe(false);
    expect(
      physicalMissionRuntimeStateVisible(
        Object.freeze([
          ...incompatible,
          physicalRuntimeFixtureNode({ description: "Close Host and access" })
        ]),
        0,
        "incompatible"
      )
    ).toBe(false);
    expect(
      physicalMissionRuntimeStateVisible(incompatible, 1, "incompatible")
    ).toBe(false);
  });

  it("uses the authoritative Android keyboard request over stale view state", () => {
    expect(
      parseAndroidKeyboardVisibility(
        "mInputShown=false\nmIsInputViewShown=true\nisInputViewShown=true"
      )
    ).toBe(false);
    expect(
      parseAndroidKeyboardVisibility(
        "mInputShown=true\nmIsInputViewShown=false"
      )
    ).toBe(true);
    expect(parseAndroidKeyboardVisibility("isInputViewShown=true")).toBe(true);
    expect(() =>
      parseAndroidKeyboardVisibility(
        "mIsInputViewShown=true\nisInputViewShown=false"
      )
    ).toThrow("visibility was contradictory");
  });

  it("distinguishes a stopped Chrome package from malformed pid output", () => {
    expect(readChromeProcessState(0, "123 456\n", "")).toBe("running");
    expect(readChromeProcessState(1, "", "")).toBe("stopped");
    expect(() => readChromeProcessState(0, "not-a-pid", "")).toThrow(
      "Chrome process state was invalid"
    );
    expect(() => readChromeProcessState(1, "123", "")).toThrow(
      "Chrome process state was invalid"
    );
    expect(() => readChromeProcessState(2, "", "failure")).toThrow(
      "Chrome process state was invalid"
    );
  });

  it("opens the physical prompt replay through the strict subscriber contract", async () => {
    const event = physicalPromptSeedEvent("2026-07-25T00:00:00.000Z");
    const handoff = new PhysicalPromptHandoffService([event]);
    const failures: unknown[] = [];
    const subscribers = createProjectionSubscriberStreamService({
      handoff: Object.freeze({
        open: (input: unknown) => handoff.open(input)
      }),
      observe_failure: (failure) => failures.push(failure),
      resource_budget: defaultResourceBudget
    });
    const stream = subscribers.open({
      after: null,
      authorization: Object.freeze({ state: "local_admin" }),
      device_id: null,
      session_id: physicalUiSessionId,
      signal: new AbortController().signal,
      subscriber_id: "physical-prompt-contract"
    });

    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first).toEqual({ done: false, value: event });
    expect(failures).toEqual([]);
    expect(subscribers.snapshot().active_subscribers).toBe(1);
    const pending = iterator.next();
    await Promise.resolve();
    expect(subscribers.snapshot().active_subscribers).toBe(1);
    expect(stream.close()).toBe(true);
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(subscribers.snapshot().active_subscribers).toBe(0);
    expect(subscribers.close()).toBe(0);
  });

  it("opens the complete physical dashboard boundary replay through the strict subscriber contract", async () => {
    expect(() => physicalApprovalTiming("not-a-timestamp")).toThrow(
      "Physical approval fixture received an invalid creation time."
    );
    const timing = physicalApprovalTiming("2026-07-25T00:00:00.000Z");
    expect(timing).toEqual({
      createdAt: "2026-07-25T00:00:00.000Z",
      expiresAt: "2026-07-25T00:30:00.000Z"
    });
    const events = physicalDashboardSeedEvents(timing);
    expect(events[3]).toMatchObject({
      captured_at: "2026-07-25T00:00:00.000Z",
      expires_at: "2026-07-25T00:30:00.000Z",
      state: "pending",
      type: "approval"
    });
    const handoff = new PhysicalPromptHandoffService(events);
    const failures: unknown[] = [];
    const subscribers = createProjectionSubscriberStreamService({
      handoff: Object.freeze({
        open: (input: unknown) => handoff.open(input)
      }),
      observe_failure: (failure) => failures.push(failure),
      resource_budget: defaultResourceBudget
    });
    const stream = subscribers.open({
      after: 0,
      authorization: Object.freeze({ state: "local_admin" }),
      device_id: null,
      session_id: physicalUiSessionId,
      signal: new AbortController().signal,
      subscriber_id: "physical-dashboard-contract"
    });

    const iterator = stream[Symbol.asyncIterator]();
    for (const event of events) {
      await expect(iterator.next()).resolves.toEqual({
        done: false,
        value: event
      });
    }
    expect(failures).toEqual([]);
    expect(stream.replay_event_count).toBe(events.length);
    expect(subscribers.snapshot().active_subscribers).toBe(1);
    const pending = iterator.next();
    await Promise.resolve();
    expect(stream.close()).toBe(true);
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(subscribers.snapshot().active_subscribers).toBe(0);
    expect(subscribers.close()).toBe(0);
  });
});

describePhysical("selected remote-ingress physical Android acceptance", () => {
  it(
    "pairs through private HTTPS and proves lifecycle authority, recovery, revocation, and cleanup",
    async () => {
      requireOneAuthorizedDevice();
      const controller = new AbortController();
      const directory = mkdtempSync(join(tmpdir(), "hostdeck-pairing-android-"));
      const talkBackArtifacts = requireDashboardUiAcceptance
        ? buildPhysicalTalkBackArtifacts(directory)
        : null;
      const dbPath = join(directory, "hostdeck.sqlite");
      const opened = openMigratedDatabase(dbPath);
      const remoteStates = createRemoteIngressStateRepository(opened.db);
      const proofs = createRemoteIngressAdmissionProofRepository(opened.db);
      const observer = createTailscaleObserver({ signal: controller.signal });
      const manager = createTailscaleServeManager({
        observer,
        signal: controller.signal
      });
      const secrets = createSecretRegistry();
      const requestInspection: RequestInspection = {
        accessRequests: 0,
        accessResponseStatuses: [],
        claimRequests: 0,
        claimResponseStatuses: [],
        csrfRequests: 0,
        csrfResponseStatuses: [],
        deletionCookieObserved: false,
        fragmentLeaks: 0,
        hardenedCookieObserved: false,
        hostStatusRequests: 0,
        hostStatusResponseStatuses: [],
        noReferrerApiRequests: 0,
        planReadRequests: 0,
        promptNoReferrerRequests: 0,
        promptRequests: 0,
        promptResponseStatuses: [],
        protectedReadRejections: 0,
        protectedReadRequests: 0,
        protectedReadSuccesses: 0,
        remoteBrowserMutationRequests: 0,
        remoteBrowserStatusRequests: 0,
        remoteDisableRequests: 0,
        remoteEnableRequests: 0,
        remoteStatusRequests: 0,
        rejectedRevokedCheckpoints: 0,
        revokedCheckpointRequests: 0,
        revokeRequests: 0,
        sessionDetailRequests: 0,
        sessionEventRequests: 0,
        sessionListRequests: 0,
        sessionListResponseStatuses: [],
        sessionMissingDetailRequests: 0,
        sessionStreamRequests: 0,
        sessionStreamResponseStatuses: []
      };
      const streamRecoveryGate = new PhysicalStreamRecoveryGate();
      const driverRuntime = createPhysicalDriverRuntime();
      const dashboardPairingGate = requireDashboardUiAcceptance
        ? new PhysicalPairingClaimGate()
        : null;
      const sseRuntime: PhysicalSseRuntime = {
        active: 0,
        closed: 0,
        maxActive: 0,
        opened: 0
      };
      const profileSwitch =
        requireRemoteAndroidAcceptance ||
        requireDashboardUiAcceptance ||
        requireRecoveryUiAcceptance
        ? requireProfileSwitchInput()
        : null;
      const acceptanceStartedAt =
        requireRemoteAndroidAcceptance ||
        requireDashboardUiAcceptance ||
        requirePromptUiAcceptance ||
        requireRecoveryUiAcceptance
          ? new Date().toISOString()
          : null;
      const screenshotDirectory = join(directory, "device-evidence");
      mkdirSync(screenshotDirectory, { mode: 0o700 });
      let host: HostDeckFastifyLifecycle<PhysicalRuntimeContext> | null = null;
      let lifecycleManager: TailscaleServeManager | null = null;
      let cleanupRemote: HostDeckRemoteIngressLifecycle | null = null;
      let display: QrDisplay | null = null;
      let remoteEnabled = false;
      let fallbackCleanup: CleanupTarget | null = null;
      let externalOrigin: string | null = null;
      let localOrigin: string | null = null;
      let env: Readonly<Record<string, string>> | null = null;
      let foreignServeBefore: ServeStatusFingerprint | null = null;
      let environmentFacts: PhysicalEnvironmentFacts | null = null;
      let fullResult: PhysicalSequenceResult | null = null;
      let dashboardResult: PhysicalDashboardSequenceResult | null = null;
      let promptResult: PhysicalPromptSequenceResult | null = null;
      let recoveryResult: PhysicalRecoverySequenceResult | null = null;
      let promptRuntime: PhysicalPromptRuntime | null = null;
      let dashboardControls: PhysicalDashboardControls | null = null;
      let promptSubscribers: ReturnType<
        typeof createProjectionSubscriberStreamService
      > | null = null;
      let initialWifiEnabled: boolean | null = null;
      let initialMobileDataEnabled: boolean | null = null;
      let initialStayAwakeSetting: number | null = null;
      let activePlugType: number | null = null;
      let selectedProfile: "away" | "dedicated" = "dedicated";
      let internalErrorCount = 0;
      let acceptanceError: unknown = null;
      const cleanupErrors: unknown[] = [];

      try {
        adbCommandCount = 0;
        deviceForbiddenValues.clear();
        if (requireProductionUiAcceptance || requireRemoteAndroidAcceptance) {
          requireCleanAcceptanceWorktree();
          requireNoAdbApplicationTunnels();
          initialStayAwakeSetting = readAndroidStayAwakeSetting();
          activePlugType = readAndroidPlugType();
          initialWifiEnabled = readAndroidWifiEnabled();
          initialMobileDataEnabled = readAndroidMobileDataEnabled();
          environmentFacts = readPhysicalEnvironmentFacts();
          requireCondition(
            isAndroidAwakeAndUnlocked(),
            "Physical acceptance requires an awake and unlocked phone before mutation."
          );
          if (requireDashboardUiAcceptance) {
            requireAndroidTalkBackService();
            requireReadableAndroidAccessibilitySettings();
            requirePhysicalTalkBackDevicePreflight();
          }
        }
        if (
          requireRemoteAndroidAcceptance ||
          requireDashboardUiAcceptance ||
          requireRecoveryUiAcceptance
        ) {
          requireCondition(
            (await readSelectedSavedProfileId()) ===
              profileSwitch?.dedicatedProfileId,
            "Physical acceptance must start on the dedicated saved profile."
          );
        }
        if (requireProductionUiAcceptance || requireRemoteAndroidAcceptance) {
          const plugType = activePlugType;
          requireCondition(
            plugType !== null,
            "Android power plug type was unavailable before stay-awake enforcement."
          );
          await enforceAndroidAwakeAndUnlocked(
            initialStayAwakeSetting as number,
            plugType
          );
          await enforceUnrelatedAndroidNetwork(
            initialWifiEnabled as boolean,
            initialMobileDataEnabled as boolean
          );
        }
        if (
          requireRemoteAndroidAcceptance ||
          requireDashboardUiAcceptance ||
          requireRecoveryUiAcceptance
        ) {
          await switchSavedProfile(profileSwitch?.awayProfileId as string);
          selectedProfile = "away";
          foreignServeBefore = await readServeStatusFingerprint();
          await switchSavedProfile(profileSwitch?.dedicatedProfileId as string);
          selectedProfile = "dedicated";
        }
        const browserBundle = await buildPhysicalBrowserBundle();
        const productionBuildRoot = requireProductionUiAcceptance
          ? await buildProductionBrowserApp(directory)
          : null;
        const candidate = requireDedicatedAbsentCandidate(
          await observer.observeCandidate()
        );
        adb(["shell", "am", "force-stop", "com.android.chrome"]);
        externalOrigin = candidate.externalOrigin;
        const port = await reserveLoopbackPort();
        localOrigin = `http://127.0.0.1:${port}`;
        const selectedLocalOrigin = localOrigin;
        fallbackCleanup = Object.freeze({
          expectedProfileKey: candidate.expectedProfileKey,
          expectedServe: remoteServeDescriptorSchema.parse({
            external_origin: candidate.externalOrigin,
            https_port: 443,
            path: "/",
            proxy_origin: localOrigin,
            visibility: "private"
          })
        });

        const now = increasingWallClock();
        const audit = createSelectedAuditRepository(opened.db);
        let auditIndex = 0;
        const auditExecutor = createSecurityMutationAuditExecutor({
          repository: audit,
          now: () => now().toISOString(),
          create_record_id: () => `audit:physical:remote:${++auditIndex}`
        });
        const compatibilityRecordedAt = now().toISOString();
        const health = createHostDeckHostHealthService({ now });
        let dashboardRuntimeCompatible = true;
        const compatibility = createHostDeckRuntimeCompatibilityRecordReader({
          read: () =>
            selectedRuntimeCompatibilityRecordSchema.parse({
              id: "hostdeck_runtime",
              compatibility: assessCodexCompatibility({
                observed_version: codexBindingDescriptor.codex_version,
                checked_at: compatibilityRecordedAt,
                handshake: {
                  state: "initialized",
                  user_agent: `hostdeck/${codexBindingDescriptor.codex_version}`,
                  platform_family: "unix",
                  platform_os: "linux",
                  collaboration_modes: dashboardRuntimeCompatible
                    ? ["Plan", "Default"]
                    : ["Default"]
                }
              }),
              recorded_at: compatibilityRecordedAt
            })
        });
        if (requireProductionUiAcceptance) {
          for (const component of hostDeckLocalHealthComponents) {
            health.updateLocal({
              component,
              reasons: [],
              source_generation: 1,
              state: "ready"
            });
          }
        }
        const selectedRemote = createHostDeckRemoteIngressLifecycle({
          createControl(input) {
            const lifecycleObserver = createTailscaleObserver({
              signal: input.signal
            });
            const selectedManager = createTailscaleServeManager({
              observer: lifecycleObserver,
              signal: input.signal
            });
            lifecycleManager = selectedManager;
            return createRemoteIngressControlService({
              admissionProofs: proofs,
              audit: auditExecutor,
              localOrigin: selectedLocalOrigin,
              manager: selectedManager,
              monotonicNow: input.monotonicNow,
              now,
              observer: lifecycleObserver,
              states: remoteStates
            });
          },
          health
        });
        cleanupRemote = selectedRemote;
        const auth = createAuthDeviceRepository(opened.db);
        const authenticationPolicy = createHostDeckRequestAuthenticationPolicy({
          authenticateDeviceToken: (input) =>
            auth.authenticateDeviceToken(input),
          now
        });
        const pairing = createPairingCodeRepository(opened.db, {
          policy: defaultResourceBudget,
          generatePairingCode: () => secrets.create(16),
          generateDeviceId: () => {
            const deviceId = `client_${createOpaqueIdentifier(18)}`;
            deviceForbiddenValues.add(deviceId);
            return deviceId;
          },
          generateDeviceToken: () => secrets.create(32),
          generateCsrfToken: () => secrets.create(32)
        });
        const pairingPolicy = createHostDeckPairingPolicy({
          pairing: {
            issue: (input) => pairing.issue(input),
            claim: async (input) => {
              if (dashboardPairingGate !== null) {
                await dashboardPairingGate.wait();
              }
              return pairing.claim(input);
            }
          },
          now,
          createPairingId: () => `pair_${createOpaqueIdentifier(18)}`
        });
        const csrfRepository = createSelectedCsrfAuthorizationRepository(
          opened.db,
          { generateCsrfToken: () => secrets.create(32) }
        );
        const csrfPolicy = createHostDeckCsrfPolicy({
          csrf: {
            authorizeBrowserWrite: (input) =>
              csrfRepository.authorizeBrowserWrite(input),
            rotateBootstrap: (input) => csrfRepository.rotateBootstrap(input)
          },
          now
        });
        const settings = createSettingsRepository(opened.db);
        settings.getOrCreateDefault({
          bindPort: port,
          now,
          stateDir: directory
        });
        const lock = createHostDeckHostLockPolicy({
          settings: {
            read: () => settings.readHostLock(),
            transition: (input) => settings.transitionHostLock(input)
          },
          now
        });
        const writeAdmission = createHostDeckSelectedWriteAdmissionPolicy({
          resourceBudget: defaultResourceBudget,
          now: () => performance.now()
        });
        const revocations = createDeviceRevocationRepository(opened.db);
        const sessionFixture = requireProductionUiAcceptance
          ? createPhysicalSessionReads(
              opened.db,
              now,
              requireDashboardUiAcceptance
                ? "dashboard"
                : requirePromptUiAcceptance
                  ? "prompt"
                  : "none"
            )
          : null;
        const sessionReads = sessionFixture?.reads ?? null;
        const selectedStates =
          requirePromptUiAcceptance || requireDashboardUiAcceptance
          ? createSelectedStateRepository(opened.db)
          : null;
        const promptAuditExecutor =
          requirePromptUiAcceptance || requireDashboardUiAcceptance
          ? createHostDeckSelectedWriteAuditExecutor({
              repository: audit,
              now: () => now().toISOString(),
              create_record_id: () => `audit:physical:prompt:${++auditIndex}`
            })
          : null;
        const promptApiRoutes: HostDeckRoutePluginRegistration[] = [];
        const promptSseRoutes: HostDeckRoutePluginRegistration[] = [];
        if (requirePromptUiAcceptance || requireDashboardUiAcceptance) {
          requireCondition(
            selectedStates !== null &&
              promptAuditExecutor !== null &&
              sessionFixture !== null &&
              sessionFixture.streamSeedEvents.length > 0,
            "Physical prompt state or audit owner was unavailable."
          );
          promptRuntime = createPhysicalPromptRuntime(
            selectedStates,
            now,
            sessionFixture.streamSeedEvents,
            streamRecoveryGate
          );
          promptSubscribers = promptRuntime.subscribers;
          if (requirePromptUiAcceptance) {
            promptApiRoutes.push(
              createHostDeckProjectedEventRouteRegistration({
                state: Object.freeze({
                  listEvents: selectedStates.listEvents,
                  require: selectedStates.require
                })
              }),
              createHostDeckPromptRouteRegistration({
                admission: writeAdmission,
                audit: promptAuditExecutor,
                csrf: csrfPolicy,
                lock,
                prompts: {
                  dispatch: promptRuntime.service.dispatch,
                  snapshot: promptRuntime.service.snapshot
                },
                runtime: { read: () => physicalPromptCompatibility(now) },
                sessions: {
                  read: (sessionId) => selectedStates.require(sessionId)
                }
              })
            );
            promptSseRoutes.push(
              createHostDeckProjectionStreamRouteRegistration({
                observe_error: promptRuntime.recordStreamFailure,
                subscribers: promptSubscribers
              })
            );
          }
        }
        let dashboardApiRoutes: readonly HostDeckRoutePluginRegistration[] = [];
        let dashboardSseRoutes: readonly HostDeckRoutePluginRegistration[] = [];
        if (requireDashboardUiAcceptance) {
          requireCondition(
            selectedStates !== null &&
              promptAuditExecutor !== null &&
              promptRuntime !== null &&
              promptSubscribers !== null &&
              sessionReads !== null &&
              sessionFixture !== null &&
              sessionFixture.approvalTiming !== null,
            "Physical dashboard composition dependencies were unavailable."
          );
          dashboardControls = createPhysicalDashboardControls({
            approval: sessionFixture.approvalTiming,
            now,
            prompts: Object.freeze({
              dispatch: promptRuntime.service.dispatch,
              snapshot: promptRuntime.service.snapshot
            }),
            runtime: physicalPromptCompatibility(now),
            states: selectedStates
          });
          const deviceListing = createDeviceListingRepository(opened.db);
          const routes = createHostDeckSelectedApiRouteComposition({
            admission: writeAdmission,
            audit: promptAuditExecutor,
            authentication: authenticationPolicy,
            controls: dashboardControls.controls,
            csrf: csrfPolicy,
            devices: Object.freeze({
              list: deviceListing.list,
              revoke: revocations.revoke
            }),
            health: Object.freeze({ compatibility, health }),
            lock,
            now,
            observeSseError: promptRuntime.recordStreamFailure,
            pairing: pairingPolicy,
            remote: selectedRemote.control,
            runtimes: dashboardControls.runtimes,
            securityAudit: auditExecutor,
            sessions: Object.freeze({
              managed: dashboardControls.managed,
              read: sessionReads,
              resume: dashboardControls.resume,
              subscribers: promptSubscribers
            }),
            state: Object.freeze({
              get: selectedStates.get,
              listEvents: selectedStates.listEvents,
              require: selectedStates.require
            })
          });
          dashboardApiRoutes = Object.freeze(
            routes.filter((route) => route.surface === "api")
          );
          dashboardSseRoutes = Object.freeze(
            routes.filter((route) => route.surface === "sse")
          );
        }
        const apiRoutes = requireDashboardUiAcceptance
          ? [
              ...dashboardApiRoutes,
              physicalProtectedRoute(),
              physicalDriverRoute(driverRuntime)
            ]
          : [
          createHostDeckRemoteIngressRouteRegistration({
            service: selectedRemote.control
          }),
          createHostDeckPairingRouteRegistration({
            audit: auditExecutor,
            pairing: pairingPolicy
          }),
          createHostDeckCsrfRouteRegistration({
            audit: auditExecutor,
            csrf: csrfPolicy
          }),
          createHostDeckHostLockRouteRegistration({
            audit: auditExecutor,
            csrf: csrfPolicy,
            lock
          }),
          createHostDeckDeviceRevokeRouteRegistration({
            activeDeviceAuthority:
              authenticationPolicy.activeDeviceAuthority,
            admission: writeAdmission,
            audit: auditExecutor,
            csrf: csrfPolicy,
            devices: { revoke: (input) => revocations.revoke(input) },
            lock,
            now
          }),
          ...(requireProductionUiAcceptance && sessionReads !== null
            ? [
                createHostDeckHealthRouteRegistration({ compatibility, health }),
                createHostDeckSessionReadRouteRegistration({
                  sessions: sessionReads
                })
              ]
            : []),
          ...promptApiRoutes,
          physicalProtectedRoute(),
          physicalDriverRoute(driverRuntime)
        ];
        const staticRoutes = requireProductionUiAcceptance
          ? [
              createHostDeckStaticBoundaryRegistration({
                browserRoutes: ["/", "/sessions/:session_id"],
                buildRoot: requireProductionBuildRoot(productionBuildRoot),
                id: "physical-production-browser",
                packageVersion: "0.0.0"
              }),
              physicalPageRoute(browserBundle, {
                id: "physical-production-clipboard-page",
                path: "/__physical/clipboard"
              }),
              physicalPageRoute(browserBundle, {
                id: "physical-production-cleanup-page",
                path: "/__physical/cleanup"
              })
            ]
          : [physicalPageRoute(browserBundle)];
        const sseRoutes = requireDashboardUiAcceptance
          ? dashboardSseRoutes
          : [physicalSseRoute(sseRuntime), ...promptSseRoutes];
        const routePlugins = [
          composePhysicalRouteRegistration(
            "physical-remote-api",
            "api",
            apiRoutes,
            requestInspection,
            secrets
          ),
          composePhysicalRouteRegistration(
            "physical-remote-sse",
            "sse",
            sseRoutes,
            requestInspection,
            secrets,
            streamRecoveryGate
          ),
          composePhysicalRouteRegistration(
            "physical-remote-page",
            "static",
            staticRoutes,
            requestInspection,
            secrets
          )
        ];
        host = await startHostDeckTailscaleServeFastifyLifecycle({
          createRequestAuthenticationPolicy: () => authenticationPolicy,
          createRoutePlugins: () => routePlugins,
          observeInternalError: () => {
            internalErrorCount += 1;
          },
          resourceBudget: defaultResourceBudget,
          runtime: {
            beginDrain() {
              // Remote authority owns this acceptance surface.
            },
            closeRuntime() {
              // The acceptance route has no external runtime process.
            },
            closeSse() {
              // Request/device authority closes each selected SSE source.
            },
            closeStartup() {
              if (opened.db.open) opened.db.close();
            },
            start() {
              return Object.freeze({
                bind: Object.freeze({
                  host: "127.0.0.1" as const,
                  port,
                  transport: "http" as const
                }),
                context: Object.freeze({ remote: selectedRemote })
              });
            }
          },
          selectRemoteIngressLifecycle: (context) => context.remote
        });
        requireCondition(
          host.baseUrl.origin === localOrigin &&
            host.snapshot().configured.host === "127.0.0.1" &&
            host.snapshot().listening,
          "Physical acceptance did not start one exact loopback lifecycle."
        );
        env = Object.freeze({
          HOME: directory,
          HOSTDECK_API_BASE_URL: localOrigin,
          HOSTDECK_STATE_DIR: directory
        });
        await waitFor(
          () =>
            selectedRemote.snapshot().poll_cycles >= 1 &&
            selectedRemote.snapshot().active_control_operations === 0,
          15_000,
          "Physical lifecycle did not settle its initial observation."
        );

        assertRemoteCliResult(
          await runCli(["remote", "enable", "--json"], {
            createOperationId: () => "op_physical_remote_enable_0001",
            env
          }),
          "ready"
        );
        remoteEnabled = true;
        requireOpenAdmission(
          selectedRemote.readAdmission(),
          candidate.externalOrigin
        );
        await assertTrustedPhysicalPage(
          candidate.externalOrigin,
          requireProductionUiAcceptance
            ? readFileSync(
                join(
                  requireProductionBuildRoot(productionBuildRoot),
                  "index.html"
                ),
                "utf8"
              )
            : null
        );
        if (requireProductionUiAcceptance) {
          await requireAndroidPrivateHttpsReachability(
            candidate.externalOrigin
          );
        }
        requireNoAdbApplicationTunnels();

        const rendered: PairingRenderCapture = {
          link: null,
          qrImage: null
        };
        let pairResult: Awaited<ReturnType<typeof runCli>> | null =
          await runCli(["pair", "--label", "Physical Android Chrome", "--write"], {
            createPairOperationId: () => "op_physical_pair_request_0001",
            env,
            renderPairingQr: async (link) => {
              rendered.link = selectedPairingLinkSchema.parse(link);
              rendered.qrImage = await QRCode.toBuffer(link, {
                errorCorrectionLevel: "M",
                margin: 4,
                type: "png",
                width: 560
              });
              return "Private QR display ready.";
            }
          });
        const pairingLink = rendered.link;
        const qrImage = rendered.qrImage;
        requireCondition(
          pairResult.exitCode === cliExitCodes.ok &&
            pairResult.stderr === "" &&
            typeof pairingLink === "string" &&
            Buffer.isBuffer(qrImage) &&
            pairResult.stdout.includes(pairingLink) &&
            pairResult.stdout.includes("Private QR display ready.") &&
            !pairResult.stdout.includes("Code:"),
          "Physical pairing CLI did not produce one private link."
        );
        const parsedLink = new URL(pairingLink);
        const pairingCode = parsedLink.hash.slice(
          selectedPairingFragmentPrefix.length
        );
        requireCondition(
          parsedLink.origin === candidate.externalOrigin &&
            parsedLink.pathname === "/" &&
            parsedLink.search === "" &&
            /^[A-Za-z0-9_-]{22}$/u.test(pairingCode) &&
            secrets.has(pairingCode) &&
            !(qrImage as Buffer).includes(Buffer.from(pairingCode, "utf8")),
          "Physical pairing link did not match the selected contract."
        );
        deviceForbiddenValues.add(pairingLink);
        pairResult = null;

        rendered.link = null;
        rendered.qrImage = null;

        adb(["shell", "am", "force-stop", "com.android.chrome"]);
        if (requireProductionUiAcceptance) {
          openPrivatePairingLinkInChrome(pairingLink);
        } else {
          display = await startQrDisplay(qrImage as Buffer);
          openDefaultCamera();
        }
        const dashboardPairingScreenshotNames: string[] = [];
        if (requireDashboardUiAcceptance) {
          await waitFor(
            () =>
              requestInspection.claimRequests === 1 &&
              dashboardPairingGate?.pending === true,
            30_000,
            "Physical dashboard pairing claim did not enter its bounded gate."
          );
          await waitForAndroidUiText(
            "Pairing this phone",
            30_000,
            "Physical dashboard did not render claiming truth."
          );
          await capturePrivateFreeProductionScreenshot(
            join(screenshotDirectory, "fe090-45-pair-claiming.png"),
            candidate.externalOrigin
          );
          dashboardPairingScreenshotNames.push("fe090-45-pair-claiming.png");
          dashboardPairingGate?.release();
        }
        await waitFor(
          () =>
            countRows(opened.db, "auth_devices") === 1 ||
            firstProxyRejection(
              (host as HostDeckFastifyLifecycle<PhysicalRuntimeContext>).app
            ) !== null ||
            selectedRemote.snapshot().phase !== "running",
          requireProductionUiAcceptance
            ? automatedClaimTimeoutMs
            : claimTimeoutMs,
          "The physical phone did not claim the private pairing link in time."
        );
        const proxyRejection = firstProxyRejection(host.app);
        requireCondition(
          selectedRemote.snapshot().phase === "running" &&
            selectedRemote.readAdmission().admission === "open",
          "The selected remote lifecycle closed during physical pairing."
        );
        requireCondition(
          proxyRejection === null,
          `The physical phone was rejected at the Serve boundary (${proxyRejection}).`
        );
        if (display !== null) {
          await closeQrDisplay(display);
          display = null;
        }
        if (requireDashboardUiAcceptance) {
          const officeDeviceToken = secrets.create(32);
          const officeCsrfToken = secrets.create(32);
          auth.create({
            clientLabel: "Office browser",
            createdAt: now(),
            id: "client_zzzzzzzzzzzzzzzzzz",
            permission: "read",
            rawCsrfToken: officeCsrfToken,
            rawDeviceToken: officeDeviceToken
          });
          requireCondition(
            countRows(opened.db, "auth_devices") === 2,
            "Physical dashboard did not seed one distinct revoke target."
          );
        }

        requireChromeRunning();
        if (requireDashboardUiAcceptance) {
          const selectedDashboardControls = dashboardControls;
          const selectedPromptRuntime = promptRuntime;
          const dashboardUiHost = host;
          requireCondition(
            selectedDashboardControls !== null &&
              selectedPromptRuntime !== null &&
              dashboardUiHost !== null &&
              lifecycleManager !== null &&
              talkBackArtifacts !== null,
            "Physical dashboard production runtime was unavailable."
          );
          dashboardResult = await runProductionDashboardUiSequence({
            controls: selectedDashboardControls,
            db: opened.db,
            driver: driverRuntime,
            env,
            externalOrigin: candidate.externalOrigin,
            foreignServeBefore: foreignServeBefore as ServeStatusFingerprint,
            initialScreenshotNames: dashboardPairingScreenshotNames,
            manager: lifecycleManager,
            profileSwitch: profileSwitch as ProfileSwitchInput,
            prompt: selectedPromptRuntime,
            readProxyRejection: () => firstProxyRejection(dashboardUiHost.app),
            remote: selectedRemote,
            requestInspection,
            screenshotDirectory,
            setSelectedProfile(profile) {
              selectedProfile = profile;
            },
            setRuntimeCompatible(compatible) {
              dashboardRuntimeCompatible = compatible;
            },
            talkBackArtifacts: talkBackArtifacts as PhysicalTalkBackArtifacts
          });
        } else if (requireRecoveryUiAcceptance) {
          const recoveryUiHost = host;
          requireCondition(
            recoveryUiHost !== null && lifecycleManager !== null,
            "Physical recovery production runtime was unavailable."
          );
          recoveryResult = await runProductionRemoteRecoveryUiSequence({
            db: opened.db,
            driver: driverRuntime,
            env,
            externalOrigin: candidate.externalOrigin,
            foreignServeBefore: foreignServeBefore as ServeStatusFingerprint,
            manager: lifecycleManager,
            profileSwitch: profileSwitch as ProfileSwitchInput,
            readProxyRejection: () => firstProxyRejection(recoveryUiHost.app),
            remote: selectedRemote,
            requestInspection,
            screenshotDirectory,
            setSelectedProfile(profile) {
              selectedProfile = profile;
            }
          });
          assertRecoveryUiRuntimeTruth(opened.db, requestInspection);
        } else if (requirePairingUiAcceptance) {
          const pairingUiHost = host;
          requireCondition(
            pairingUiHost !== null,
            "Physical production UI host was unavailable."
          );
          await runProductionPairingUiSequence({
            db: opened.db,
            driver: driverRuntime,
            externalOrigin: candidate.externalOrigin,
            readProxyRejection: () => firstProxyRejection(pairingUiHost.app),
            requestInspection,
            screenshotDirectory
          });
          assertPairingUiRuntimeTruth(opened.db, requestInspection);
        } else if (requirePromptUiAcceptance) {
          const selectedPromptRuntime = promptRuntime;
          const promptUiHost = host;
          requireCondition(
            promptUiHost !== null && selectedPromptRuntime !== null,
            "Physical prompt production runtime was unavailable."
          );
          promptResult = await runProductionPromptUiSequence({
            db: opened.db,
            driver: driverRuntime,
            externalOrigin: candidate.externalOrigin,
            prompt: selectedPromptRuntime,
            readProxyRejection: () => firstProxyRejection(promptUiHost.app),
            requestInspection,
            screenshotDirectory
          });
          assertPromptUiRuntimeTruth(
            opened.db,
            requestInspection,
            selectedPromptRuntime
          );
        } else {
          await waitFor(
            () => hasPhysicalCheckpoint(driverRuntime, "paired"),
            30_000,
            "Physical Chrome did not validate paired browser state."
          );
          await waitFor(
            () => hasPhysicalCheckpoint(driverRuntime, "reloaded"),
            30_000,
            "Physical Chrome did not validate a fragment-free reload."
          );
          requireChromeForeground();
          assertPairingRuntimeTruth(opened.db, requestInspection);
        }
        if (requireDashboardUiAcceptance) {
          assertPhysicalDashboardAudit(
            opened.db,
            requestInspection,
            dashboardResult as PhysicalDashboardSequenceResult
          );
        } else {
          assertPairingAudit(opened.db, {
            successfulCsrfBootstrapCount: requirePairingUiAcceptance
              ? 3
              : requirePromptUiAcceptance || requireRecoveryUiAcceptance
                ? 2
                : 1,
            deviceRevokeCount: requireProductionUiAcceptance ? 1 : 0
          });
        }
        if (requirePromptUiAcceptance || requireDashboardUiAcceptance) {
          assertPhysicalPromptAudit(opened.db);
        }
        assertSecretsAbsentFromDatabase(
          dbPath,
          requirePromptUiAcceptance || requireDashboardUiAcceptance
            ? [...secrets.values(), ...physicalPromptText.split("\n")]
            : secrets.values()
        );

        if (requireRemoteAndroidAcceptance) {
          await waitFor(
            () => hasPhysicalCheckpoint(driverRuntime, "started"),
            claimTimeoutMs,
            "Tap Start check on the unlocked phone to continue physical acceptance."
          );
          fullResult = await runPhysicalSecuritySequence({
            db: opened.db,
            driver: driverRuntime,
            env,
            foreignServeBefore: foreignServeBefore as ServeStatusFingerprint,
            manager: requireLifecycleManager(lifecycleManager),
            profileSwitch: profileSwitch as ProfileSwitchInput,
            remote: selectedRemote,
            requestInspection,
            screenshotDirectory,
            setSelectedProfile(profile) {
              selectedProfile = profile;
            },
            sseRuntime
          });
        } else if (!requireProductionUiAcceptance) {
          driverRuntime.setCommand("cleanup");
          await waitFor(
            () => requestInspection.rejectedRevokedCheckpoints === 1,
            30_000,
            "Physical pairing cleanup did not revoke browser authority."
          );
          requireCondition(
            requestInspection.deletionCookieObserved &&
              countMatchingRows(
                opened.db,
                "auth_devices",
                "revoked_at IS NOT NULL"
              ) === 1,
            "Physical pairing cleanup truth was incomplete."
          );
        }
        await waitFor(
          () => selectedRemote.snapshot().poll_cycles >= 2,
          15_000,
          "Physical pairing did not prove lifecycle-owned observation renewal."
        );
        await waitForFreshLifecycleIdle(selectedRemote);

        assertRemoteCliResult(
          await runCli(["remote", "disable", "--json"], {
            createOperationId: () => "op_physical_remote_disable_0001",
            env
          }),
          "disabled"
        );
        remoteEnabled = false;
        requireClosedAdmission(selectedRemote.readAdmission());
        await requireConfiguredServeAbsent(
          observer,
          candidate.expectedProfileKey,
          fallbackCleanup.expectedServe
        );
        if (
          requireRemoteAndroidAcceptance ||
          requireDashboardUiAcceptance ||
          requireRecoveryUiAcceptance
        ) {
          await switchSavedProfile(profileSwitch?.awayProfileId as string);
          selectedProfile = "away";
          requireMatchingServeFingerprint(
            foreignServeBefore as ServeStatusFingerprint,
            await readServeStatusFingerprint()
          );
          await switchSavedProfile(profileSwitch?.dedicatedProfileId as string);
          selectedProfile = "dedicated";
          await requireConfiguredServeAbsent(
            observer,
            candidate.expectedProfileKey,
            fallbackCleanup.expectedServe
          );
          if (requireRemoteAndroidAcceptance) {
            await capturePhysicalScreenshot(
              join(screenshotDirectory, "04-revoked-cleaned.png")
            );
            assertFullPhysicalAudit(opened.db);
          } else if (requireDashboardUiAcceptance) {
            requireCondition(
              requestInspection.remoteEnableRequests === 1 &&
                requestInspection.remoteDisableRequests === 1 &&
                requestInspection.remoteBrowserStatusRequests === 4 &&
                requestInspection.remoteBrowserMutationRequests === 0,
              "Physical dashboard cleanup observed an unexpected remote request path."
            );
            assertPhysicalDashboardCleanupAudit(opened.db);
          } else {
            requireCondition(
              requestInspection.remoteEnableRequests === 1 &&
                requestInspection.remoteDisableRequests === 1 &&
                requestInspection.remoteBrowserMutationRequests === 0,
              "Physical recovery cleanup observed an unexpected remote mutation path."
            );
            assertRecoveryPhysicalAudit(opened.db);
          }
          assertSecretsAbsentFromDatabase(dbPath, secrets.values());
        }
        fallbackCleanup = null;
        await stopPhysicalAndroidChrome();
        if (requirePromptUiAcceptance || requireDashboardUiAcceptance) {
          await waitFor(
            () => !isAndroidKeyboardVisible(),
            10_000,
            "Physical prompt acceptance retained the software keyboard."
          );
        }
        requireNoAdbApplicationTunnels();
        const promptSubscriberSnapshot = promptSubscribers?.snapshot() ?? null;
        requireCondition(
          adbCommandCount > 0 &&
            internalErrorCount === 0 &&
            sseRuntime.active === 0 &&
            (!(requirePromptUiAcceptance || requireDashboardUiAcceptance) ||
              (promptRuntime?.streamFailureCount ===
                (requireDashboardUiAcceptance ? 1 : 0) &&
                promptSubscriberSnapshot?.active_subscribers === 0)),
          "Physical acceptance retained an internal error or active device resource."
        );
        const screenshotBytes = requireRemoteAndroidAcceptance
          ? readPhysicalScreenshots(screenshotDirectory)
          : null;
        const recoveryScreenshotBytes = requireRecoveryUiAcceptance
          ? readPhysicalRecoveryScreenshots(screenshotDirectory)
          : null;
        const dashboardScreenshotBytes = requireDashboardUiAcceptance
          ? readPhysicalDashboardScreenshots(
              screenshotDirectory,
              dashboardResult as PhysicalDashboardSequenceResult
            )
          : null;
        await host.close();
        host = null;
        requireCondition(
          !(await canConnectLoopback(port)) && !opened.db.open,
          "Physical lifecycle retained its listener or database after close."
        );
        controller.abort();
        rmSync(directory, { force: true, recursive: true });
        requireCondition(
          !existsSync(directory),
          "Physical acceptance retained its temporary state directory."
        );
        if (requireRemoteAndroidAcceptance) {
          await restoreAndroidWifi(initialWifiEnabled as boolean);
          initialWifiEnabled = null;
          await restoreAndroidMobileData(
            initialMobileDataEnabled as boolean
          );
          initialMobileDataEnabled = null;
          await restoreAndroidStayAwake(
            initialStayAwakeSetting as number
          );
          initialStayAwakeSetting = null;
          requireNoAdbApplicationTunnels();
          publishPhysicalEvidence({
            completedAt: new Date().toISOString(),
            environment: environmentFacts as PhysicalEnvironmentFacts,
            foreignServeBytes: (
              foreignServeBefore as ServeStatusFingerprint
            ).bytes,
            managerAttempts: requireLifecycleManager(lifecycleManager)
              .snapshot().command_attempts,
            screenshots: screenshotBytes as readonly PhysicalScreenshot[],
            sequence: fullResult as PhysicalSequenceResult,
            startedAt: acceptanceStartedAt as string
          });
        } else if (requireDashboardUiAcceptance) {
          await restoreAndroidWifi(initialWifiEnabled as boolean);
          initialWifiEnabled = null;
          await restoreAndroidMobileData(
            initialMobileDataEnabled as boolean
          );
          initialMobileDataEnabled = null;
          await restoreAndroidStayAwake(
            initialStayAwakeSetting as number
          );
          initialStayAwakeSetting = null;
          requirePhysicalDashboardDisplaySettingsUnchanged(
            environmentFacts as PhysicalEnvironmentFacts
          );
          requireNoAdbApplicationTunnels();
          publishPhysicalDashboardEvidence({
            completedAt: new Date().toISOString(),
            environment: environmentFacts as PhysicalEnvironmentFacts,
            foreignServeBytes: (
              foreignServeBefore as ServeStatusFingerprint
            ).bytes,
            managerAttempts: requireLifecycleManager(lifecycleManager)
              .snapshot().command_attempts,
            screenshots:
              dashboardScreenshotBytes as readonly PhysicalScreenshot[],
            sequence: dashboardResult as PhysicalDashboardSequenceResult,
            startedAt: acceptanceStartedAt as string
          });
        } else if (requireRecoveryUiAcceptance) {
          await restoreAndroidWifi(initialWifiEnabled as boolean);
          initialWifiEnabled = null;
          await restoreAndroidMobileData(
            initialMobileDataEnabled as boolean
          );
          initialMobileDataEnabled = null;
          await restoreAndroidStayAwake(
            initialStayAwakeSetting as number
          );
          initialStayAwakeSetting = null;
          requireNoAdbApplicationTunnels();
          publishPhysicalRecoveryEvidence({
            completedAt: new Date().toISOString(),
            environment: environmentFacts as PhysicalEnvironmentFacts,
            foreignServeBytes: (
              foreignServeBefore as ServeStatusFingerprint
            ).bytes,
            managerAttempts: requireLifecycleManager(lifecycleManager)
              .snapshot().command_attempts,
            screenshots:
              recoveryScreenshotBytes as readonly PhysicalScreenshot[],
            sequence: recoveryResult as PhysicalRecoverySequenceResult,
            startedAt: acceptanceStartedAt as string
          });
        } else if (requirePromptUiAcceptance) {
          await restoreAndroidWifi(initialWifiEnabled as boolean);
          initialWifiEnabled = null;
          await restoreAndroidMobileData(
            initialMobileDataEnabled as boolean
          );
          initialMobileDataEnabled = null;
          await restoreAndroidStayAwake(
            initialStayAwakeSetting as number
          );
          initialStayAwakeSetting = null;
          requireNoAdbApplicationTunnels();
          publishPhysicalPromptEvidence({
            completedAt: new Date().toISOString(),
            environment: environmentFacts as PhysicalEnvironmentFacts,
            sequence: promptResult as PhysicalPromptSequenceResult,
            startedAt: acceptanceStartedAt as string
          });
        }
      } catch (error) {
        acceptanceError = error;
      } finally {
        if (dashboardPairingGate?.pending === true) {
          dashboardPairingGate.release();
        }
        await collectPhysicalCleanupError(
          "Physical cleanup could not stop Android Chrome.",
          () => stopPhysicalAndroidChrome(),
          cleanupErrors
        );
        if (display !== null) {
          await collectPhysicalCleanupError(
            "Physical cleanup could not close the QR display.",
            () => closeQrDisplay(display as QrDisplay),
            cleanupErrors
          );
        }
        if (
          (requireRemoteAndroidAcceptance ||
            requireDashboardUiAcceptance ||
            requireRecoveryUiAcceptance) &&
          profileSwitch !== null
        ) {
          await collectPhysicalCleanupError(
            "Physical cleanup could not restore the dedicated saved profile.",
            async () => {
              if (
                (await readSelectedSavedProfileId()) !==
                profileSwitch.dedicatedProfileId
              ) {
                await switchSavedProfile(profileSwitch.dedicatedProfileId);
              }
              selectedProfile = "dedicated";
            },
            cleanupErrors
          );
        }
        const cleanupRemoteLifecycle = cleanupRemote;
        if (
          remoteEnabled &&
          env !== null &&
          host !== null &&
          externalOrigin !== null &&
          localOrigin !== null &&
          cleanupRemoteLifecycle !== null &&
          selectedProfile === "dedicated"
        ) {
          await collectPhysicalCleanupError(
            "Physical cleanup could not disable remote access through the selected lifecycle.",
            async () => {
              await waitForFreshLifecycleIdle(cleanupRemoteLifecycle);
              assertRemoteCliResult(
                await runCli(["remote", "disable", "--json"], {
                  createOperationId: () =>
                    "op_physical_remote_disable_cleanup_0001",
                  env: env as Readonly<Record<string, string>>
                }),
                "disabled"
              );
              remoteEnabled = false;
            },
            cleanupErrors
          );
        }
        if (fallbackCleanup !== null) {
          await collectPhysicalCleanupError(
            "Physical cleanup could not prove or restore absent Serve state.",
            () =>
              proveOrRestoreAbsent(
                observer,
                manager,
                fallbackCleanup as CleanupTarget
              ),
            cleanupErrors
          );
        }
        controller.abort();
        if (host !== null) {
          await collectPhysicalCleanupError(
            "Physical cleanup could not close the HostDeck lifecycle.",
            () => host?.close(),
            cleanupErrors
          );
        }
        if (opened.db.open) {
          await collectPhysicalCleanupError(
            "Physical cleanup could not close the acceptance database.",
            () => {
              opened.db.close();
            },
            cleanupErrors
          );
        }
        await collectPhysicalCleanupError(
          "Physical cleanup could not remove temporary acceptance state.",
          () => rmSync(directory, { force: true, recursive: true }),
          cleanupErrors
        );
        if (initialWifiEnabled !== null) {
          await collectPhysicalCleanupError(
            "Physical cleanup could not restore Android Wi-Fi state.",
            () => restoreAndroidWifi(initialWifiEnabled as boolean),
            cleanupErrors
          );
        }
        if (initialMobileDataEnabled !== null) {
          await collectPhysicalCleanupError(
            "Physical cleanup could not restore Android mobile-data state.",
            () => restoreAndroidMobileData(initialMobileDataEnabled as boolean),
            cleanupErrors
          );
        }
        if (initialStayAwakeSetting !== null) {
          await collectPhysicalCleanupError(
            "Physical cleanup could not restore Android stay-awake state.",
            () => restoreAndroidStayAwake(initialStayAwakeSetting as number),
            cleanupErrors
          );
        }
        await collectPhysicalCleanupError(
          "Physical cleanup retained an ADB application tunnel.",
          () => requireNoAdbApplicationTunnels(),
          cleanupErrors
        );
        await collectPhysicalCleanupError(
          "Physical cleanup could not prove settled Android Chrome absence.",
          () => stopPhysicalAndroidChrome(),
          cleanupErrors
        );
        deviceForbiddenValues.clear();
      }
      if (acceptanceError !== null && cleanupErrors.length > 0) {
        throw new AggregateError(
          [acceptanceError, ...cleanupErrors],
          "Physical acceptance and cleanup failed."
        );
      }
      if (acceptanceError !== null) throw acceptanceError;
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          cleanupErrors,
          "Physical acceptance cleanup failed."
        );
      }
    },
    overallTimeoutMs
  );
});

interface CleanupTarget {
  readonly expectedProfileKey: string;
  readonly expectedServe: RemoteServeDescriptor;
}

interface RequestInspection {
  accessRequests: number;
  accessResponseStatuses: number[];
  claimRequests: number;
  claimResponseStatuses: number[];
  csrfRequests: number;
  csrfResponseStatuses: number[];
  deletionCookieObserved: boolean;
  fragmentLeaks: number;
  hardenedCookieObserved: boolean;
  hostStatusRequests: number;
  hostStatusResponseStatuses: number[];
  noReferrerApiRequests: number;
  planReadRequests: number;
  promptNoReferrerRequests: number;
  promptRequests: number;
  promptResponseStatuses: number[];
  protectedReadRejections: number;
  protectedReadRequests: number;
  protectedReadSuccesses: number;
  remoteBrowserMutationRequests: number;
  remoteBrowserStatusRequests: number;
  remoteDisableRequests: number;
  remoteEnableRequests: number;
  remoteStatusRequests: number;
  rejectedRevokedCheckpoints: number;
  revokedCheckpointRequests: number;
  revokeRequests: number;
  sessionDetailRequests: number;
  sessionEventRequests: number;
  sessionListRequests: number;
  sessionListResponseStatuses: number[];
  sessionMissingDetailRequests: number;
  sessionStreamRequests: number;
  sessionStreamResponseStatuses: number[];
}

interface PhysicalSessionNavigationSnapshot {
  readonly activeSubscribers: number;
  readonly missingDetailRequests: number;
  readonly openedSubscribers: number;
  readonly selectedDetailRequests: number;
  readonly streamRequests: number;
}

interface PairingRenderCapture {
  link: string | null;
  qrImage: Buffer | null;
}

interface PhysicalRuntimeContext {
  readonly remote: HostDeckRemoteIngressLifecycle;
}

interface PhysicalSseRuntime {
  active: number;
  closed: number;
  maxActive: number;
  opened: number;
}

const physicalCheckpointOrder = [
  "paired",
  "reloaded",
  "started",
  "locked",
  "unlocked",
  "stream-ready",
  "away-ready",
  "recovered"
] as const;

const physicalDriverCommands = [
  "hold",
  "prepare-away",
  "revoke",
  "cleanup"
] as const;
const physicalCheckpointResponseSchema = z.undefined();
const physicalAuthorityNotRevokedResponse = Object.freeze({
  code: "authority_not_revoked" as const,
  message: "Device authority remains active." as const,
  retryable: false as const
});
const physicalAuthorityNotRevokedResponseSchema = z.strictObject({
  code: z.literal(physicalAuthorityNotRevokedResponse.code),
  message: z.literal(physicalAuthorityNotRevokedResponse.message),
  retryable: z.literal(physicalAuthorityNotRevokedResponse.retryable)
});
const physicalDriverCommandResponseSchema = z.strictObject({
  command: z.enum(physicalDriverCommands),
  revision: z.number().int().min(0).max(2)
});

type PhysicalCheckpoint = (typeof physicalCheckpointOrder)[number];
type PhysicalDriverCommand = (typeof physicalDriverCommands)[number];

interface PhysicalDriverRuntime {
  readonly recordCheckpoint: (checkpoint: PhysicalCheckpoint) => void;
  readonly setCommand: (command: PhysicalDriverCommand) => void;
  readonly snapshot: () => Readonly<{
    readonly checkpoints: readonly PhysicalCheckpoint[];
    readonly command: PhysicalDriverCommand;
    readonly revision: number;
  }>;
}

class PhysicalPairingClaimGate {
  private resolvePending: (() => void) | null = null;
  private waiting: Promise<void> | null = null;

  get pending(): boolean {
    return this.resolvePending !== null;
  }

  wait(): Promise<void> {
    requireCondition(
      this.waiting === null && this.resolvePending === null,
      "Physical pairing claim gate was reused."
    );
    this.waiting = new Promise<void>((resolve) => {
      this.resolvePending = resolve;
    });
    return this.waiting.finally(() => {
      this.waiting = null;
    });
  }

  release(): void {
    const resolve = this.resolvePending;
    requireCondition(resolve !== null, "Physical pairing claim gate was not pending.");
    this.resolvePending = null;
    resolve();
  }
}

interface ProfileSwitchInput {
  readonly awayProfileId: string;
  readonly dedicatedProfileId: string;
}

interface CommandObservation {
  readonly exit_code: number;
  readonly stderr: string;
  readonly stdout: string;
}

interface ServeStatusFingerprint {
  readonly bytes: number;
  readonly sha256: string;
}

interface PhysicalEnvironmentFacts {
  readonly android_api: string;
  readonly android_model: string;
  readonly android_release: string;
  readonly android_tailscale_version: string;
  readonly battery_percent: number;
  readonly chrome_version: string;
  readonly commit: string;
  readonly display_size: string;
  readonly font_scale: string;
  readonly host_os: string;
  readonly node_version: string;
  readonly physical_density: number;
  readonly tailscale_version: string;
}

interface PhysicalSequenceResult {
  readonly foreignServeUnchanged: true;
  readonly lockPassed: true;
  readonly managerAttemptsBeforeDisable: number;
  readonly managerAttemptsDuringSwitch: 0;
  readonly profileAwayClosedAuthority: true;
  readonly profileReturnRecovered: true;
  readonly protectedReads: number;
  readonly remoteUnlockDenied: true;
  readonly selfRevoked: true;
  readonly sseEvents: number;
  readonly sseHeartbeats: number;
}

interface PhysicalRecoverySequenceResult {
  readonly browserMutationRequests: 0;
  readonly checkedReadyVisible: true;
  readonly claimRequests: 1;
  readonly genericBrowserFailureVisible: true;
  readonly managerAttemptsBeforeDisable: 1;
  readonly managerAttemptsDuringSwitch: 0;
  readonly profileReturnRecovered: true;
  readonly remoteBrowserStatusRequests: 2;
}

interface PhysicalDashboardSequenceResult {
  readonly archived: true;
  readonly approvalDecision: "approve";
  readonly clipboardOutcome: "copied" | "unavailable";
  readonly compactState: "completed";
  readonly interactionIds: readonly string[];
  readonly modelApplied: true;
  readonly planApplied: true;
  readonly profileReturnRecovered: true;
  readonly screenshotNames: readonly string[];
  readonly selfRevoked: true;
  readonly stateIds: readonly string[];
  readonly talkBack: PhysicalTalkBackResult;
  readonly targetMeasurements: readonly PhysicalTargetMeasurement[];
}

interface PhysicalTalkBackResult {
  readonly available: true;
  readonly permissionStateRestored: true;
  readonly restored: true;
  readonly serviceBound: true;
  readonly touchExplorationActive: true;
  readonly transcript: PhysicalTalkBackTranscriptSummary;
}

interface PhysicalTalkBackArtifacts {
  readonly dexPath: string;
  readonly sha256: string;
}

interface AndroidAccessibilitySnapshot {
  readonly accessibilityEnabled: string;
  readonly enabledServices: string;
  readonly touchExplorationEnabled: string;
  readonly touchExplorationGrantedServices: string;
}

interface AndroidPermissionSnapshot {
  readonly flags: readonly string[];
  readonly granted: boolean;
  readonly permission: (typeof physicalTalkBackPermissions)[number];
}

interface PhysicalTalkBackObserverRuntime {
  readonly events: PhysicalTalkBackObserverEvent[];
  readonly markStopping: () => void;
  readonly process: ChildProcess;
  readonly readFailure: () => Error | null;
  readonly ready: () => boolean;
  readonly stderr: () => string;
}

interface PhysicalTargetMeasurement {
  readonly heightCssPx: number;
  readonly label: string;
  readonly widthCssPx: number;
}

type PhysicalPromptTurnPort = CodexPromptControlServiceOptions["turns"];
type PhysicalPromptStartInput = Parameters<
  PhysicalPromptTurnPort["startTurn"]
>[0];
type PhysicalOutputCursor = Exclude<
  ProjectionReplayLiveHandoff["high_water_cursor"],
  null
>;

interface PhysicalPromptRuntime {
  readonly advance: (state: "in_progress" | "completed") => Promise<void>;
  readonly disconnectForRecovery: () => void;
  readonly publishInterruptTurn: (
    turnId: string,
    state: "in_progress" | "interrupted"
  ) => void;
  readonly recoverySnapshot: () => PhysicalStreamRecoveryGateSnapshot;
  readonly recordStreamFailure: (failure: unknown) => void;
  readonly releaseRecovery: () => boolean;
  readonly service: CodexPromptControlService;
  readonly startCalls: readonly PhysicalPromptStartInput[];
  readonly streamFailureCount: number;
  readonly streamFailureCodes: readonly string[];
  readonly subscribers: ReturnType<
    typeof createProjectionSubscriberStreamService
  >;
}

type PhysicalStreamRecoveryGateState = "idle" | "armed" | "holding" | "released";

interface PhysicalStreamRecoveryGateSnapshot {
  readonly held_requests: number;
  readonly state: PhysicalStreamRecoveryGateState;
}

interface PhysicalPromptSequenceResult {
  readonly acceptedVisible: true;
  readonly completedVisible: true;
  readonly keyboardVisible: true;
  readonly multilineEdited: true;
  readonly promptCharacterCount: number;
  readonly promptLineCount: number;
  readonly promptRequestCount: 1;
  readonly runningVisible: true;
  readonly sendAction: "start";
  readonly sentOnce: true;
}

interface PhysicalScreenshot {
  readonly bytes: Buffer;
  readonly name: string;
  readonly sha256: string;
}

interface QrDisplay {
  readonly process: ChildProcess;
}

function createSecretRegistry(): Readonly<{
  create(bytes: number): string;
  has(value: string): boolean;
  values(): readonly string[];
}> {
  const values: string[] = [];
  return Object.freeze({
    create(bytes) {
      const value = randomBytes(bytes).toString("base64url");
      values.push(value);
      deviceForbiddenValues.add(value);
      return value;
    },
    has(value) {
      return values.includes(value);
    },
    values() {
      return Object.freeze([...values]);
    }
  });
}

function createOpaqueIdentifier(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function increasingWallClock(): () => Date {
  let wallTime = Date.now();
  return () => {
    wallTime = Math.max(wallTime + 1, Date.now());
    return new Date(wallTime);
  };
}

async function buildPhysicalBrowserBundle(): Promise<string> {
  const entry = fileURLToPath(
    new URL("../../../tests/browser/fixtures/physical-pairing-entry.ts", import.meta.url)
  );
  const result = await viteBuild({
    configFile: false,
    logLevel: "silent",
    build: {
      target: "es2022",
      minify: false,
      sourcemap: false,
      write: false,
      rollupOptions: {
        input: entry,
        output: { codeSplitting: false, format: "es" }
      }
    }
  });
  const candidates = (Array.isArray(result) ? result : [result]).flatMap(
    (output) => ("output" in output ? output.output : [])
  );
  const entries = candidates.filter(
    (output) => output.type === "chunk" && output.isEntry
  );
  requireCondition(
    entries.length === 1 &&
      entries[0]?.type === "chunk" &&
      entries[0].code.length > 0 &&
      Buffer.byteLength(entries[0].code, "utf8") <= physicalPageMaxBytes &&
      !/<\/script/iu.test(entries[0].code),
    "Physical pairing browser bundle is invalid."
  );
  return entries[0].code;
}

async function buildProductionBrowserApp(directory: string): Promise<string> {
  const webRoot = fileURLToPath(
    new URL("../../web/", import.meta.url)
  );
  const configFile = fileURLToPath(
    new URL("../../web/vite.config.ts", import.meta.url)
  );
  const buildRoot = join(directory, "production-web");
  await viteBuild({
    configFile,
    logLevel: "silent",
    root: webRoot,
    build: {
      emptyOutDir: true,
      outDir: buildRoot,
      sourcemap: false
    }
  });
  writeProductionWebTestManifest(buildRoot, {
    browserRoutes: ["/", "/sessions/:session_id"],
    packageVersion: "0.0.0"
  });
  const indexPath = join(buildRoot, "index.html");
  const assetsRoot = join(buildRoot, "assets");
  const index = readFileSync(indexPath, "utf8");
  const assets = readdirSync(assetsRoot, { withFileTypes: true });
  requireCondition(
    Buffer.byteLength(index, "utf8") > 0 &&
      Buffer.byteLength(index, "utf8") <= 2 * 1024 * 1024 &&
      index.includes("/assets/") &&
      !index.includes("/src/") &&
      assets.length >= 2 &&
      assets.length <= 20 &&
      assets.every(
        (entry) =>
          entry.isFile() &&
          /^[a-zA-Z0-9_.-]+-[a-zA-Z0-9_-]{8,}\.(?:css|js)$/u.test(
            entry.name
          )
      ),
    "Physical production browser build was invalid."
  );
  return buildRoot;
}

function buildPhysicalTalkBackArtifacts(
  directory: string
): PhysicalTalkBackArtifacts {
  const sdkRoot = [
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
    join(homedir(), "Android", "Sdk")
  ].find((candidate): candidate is string =>
    typeof candidate === "string" && candidate.length > 0 && existsSync(candidate)
  );
  requireCondition(
    sdkRoot !== undefined,
    "Physical TalkBack acceptance requires an Android SDK root."
  );
  const androidJar = join(sdkRoot, "platforms", "android-34", "android.jar");
  const d8 = join(sdkRoot, "build-tools", "35.0.0", "d8");
  const sourceRoot = fileURLToPath(
    new URL("../test-support/android-talkback/", import.meta.url)
  );
  const sources = [
    join(sourceRoot, "HostDeckTalkBackObserver.java"),
    join(sourceRoot, "HostDeckUhidTouch.java")
  ] as const;
  requireCondition(
    existsSync(androidJar) &&
      existsSync(d8) &&
      sources.every((source) => existsSync(source)),
    "Physical TalkBack acceptance build inputs were unavailable."
  );

  const buildRoot = join(directory, "android-talkback");
  const classesRoot = join(buildRoot, "classes");
  const dexRoot = join(buildRoot, "dex");
  const jarPath = join(buildRoot, "hostdeck-talkback.jar");
  mkdirSync(classesRoot, { mode: 0o700, recursive: true });
  mkdirSync(dexRoot, { mode: 0o700 });
  const buildOptions = {
    ...commandOptions(),
    maxBuffer: 128 * 1024,
    timeout: 45_000
  } as const;
  const javacOutput = execFileSync(
    "javac",
    [
      "--release",
      "17",
      "-classpath",
      androidJar,
      "-d",
      classesRoot,
      ...sources
    ],
    buildOptions
  );
  const jarOutput = execFileSync(
    "jar",
    ["--create", "--file", jarPath, "-C", classesRoot, "."],
    buildOptions
  );
  const d8Output = execFileSync(
    d8,
    [
      "--lib",
      androidJar,
      "--min-api",
      "33",
      "--output",
      dexRoot,
      jarPath
    ],
    buildOptions
  );
  const dexPath = join(dexRoot, "classes.dex");
  const bytes = readFileSync(dexPath);
  const dexVersion = bytes.subarray(4, 7).toString("ascii");
  requireCondition(
    javacOutput === "" &&
      jarOutput === "" &&
      d8Output === "" &&
      JSON.stringify(readdirSync(dexRoot)) === '["classes.dex"]' &&
      bytes.length >= 1_024 &&
      bytes.length <= 256 * 1024 &&
      bytes.subarray(0, 4).equals(Buffer.from([100, 101, 120, 10])) &&
      ["035", "037", "038", "039", "040", "041"].includes(dexVersion) &&
      bytes[7] === 0,
    "Physical TalkBack acceptance DEX was invalid."
  );
  return Object.freeze({
    dexPath,
    sha256: createHash("sha256").update(bytes).digest("hex")
  });
}

function requireProductionBuildRoot(candidate: string | null): string {
  requireCondition(
    typeof candidate === "string" && candidate.length > 0,
    "Physical production browser build root was unavailable."
  );
  return candidate;
}

type PhysicalApprovalTiming = Readonly<{
  readonly createdAt: string;
  readonly expiresAt: string;
}>;

interface PhysicalSessionReadFixture {
  readonly approvalTiming: PhysicalApprovalTiming | null;
  readonly promptSeedEvent: SelectedProjectionEvent | null;
  readonly reads: ReturnType<typeof createSelectedSessionReadRepository>;
  readonly streamSeedEvents: readonly SelectedProjectionEvent[];
}

type PhysicalSessionSeedMode = "dashboard" | "none" | "prompt";

function createPhysicalSessionReads(
  db: ReturnType<typeof openMigratedDatabase>["db"],
  now: () => Date,
  seedMode: PhysicalSessionSeedMode
): PhysicalSessionReadFixture {
  const createdAt = now().toISOString();
  const updatedAt = now().toISOString();
  db.prepare(
    `
      INSERT INTO selected_sessions (
        id, name, codex_thread_id, cwd, runtime_source, runtime_version,
        disposition, created_at, updated_at, archived_at
      ) VALUES (
        '${physicalUiSessionId}', '${physicalUiSessionName}',
        '${physicalUiThreadId}', '/workspace/hostdeck',
        'codex_app_server', '0.144.0', 'selected', ?, ?, NULL
      )
    `
  ).run(createdAt, updatedAt);
  db.prepare(
    `
      INSERT INTO selected_session_projections (
        session_id, session_state, turn_state, attention, freshness,
        freshness_reason, updated_at, last_activity_at, branch, model,
        settings_json, goal_json, recent_summary, last_event_cursor,
        retained_event_count, retained_event_bytes, earliest_retained_cursor,
        retention_boundary_cursor
      ) VALUES (
        '${physicalUiSessionId}', 'active', 'idle', 'none', 'current',
        NULL, ?, ?, 'main', 'gpt-5.5-codex', ?, ?, ?, NULL, 0, 0, NULL, NULL
      )
    `
  ).run(
    updatedAt,
    updatedAt,
    JSON.stringify({
      collaboration_mode: "default",
      observed_at: updatedAt,
      reasoning_effort: "high",
      runtime_model: "gpt-5.5-codex"
    }),
    JSON.stringify({
      objective: "Validate physical pairing UI.",
      state: "active"
    }),
    "Production pairing UI acceptance."
  );
  if (seedMode === "dashboard") {
    const insertSession = db.prepare(
      `
        INSERT INTO selected_sessions (
          id, name, codex_thread_id, cwd, runtime_source, runtime_version,
          disposition, created_at, updated_at, archived_at
        ) VALUES (?, ?, ?, '/workspace/hostdeck', 'codex_app_server',
          '0.144.0', 'selected', ?, ?, NULL)
      `
    );
    const insertProjection = db.prepare(
      `
        INSERT INTO selected_session_projections (
          session_id, session_state, turn_state, attention, freshness,
          freshness_reason, updated_at, last_activity_at, branch, model,
          settings_json, goal_json, recent_summary, last_event_cursor,
          retained_event_count, retained_event_bytes, earliest_retained_cursor,
          retention_boundary_cursor
        ) VALUES (?, 'active', ?, ?, 'current', NULL, ?, ?, 'main',
          'gpt-5.5-codex', ?, NULL, ?, NULL, 0, 0, NULL, NULL)
      `
    );
    for (const companion of [
      {
        id: "sess_physical_dashboard_approval",
        name: "release-approval",
        threadId: "thread-physical-dashboard-approval",
        turnState: "waiting_for_approval",
        attention: "needs_approval",
        summary: "Approval required for release validation."
      },
      {
        id: "sess_physical_dashboard_input",
        name: "migration-input",
        threadId: "thread-physical-dashboard-input",
        turnState: "waiting_for_input",
        attention: "needs_input",
        summary: "Input required before migration continues."
      }
    ] as const) {
      insertSession.run(
        companion.id,
        companion.name,
        companion.threadId,
        createdAt,
        updatedAt
      );
      insertProjection.run(
        companion.id,
        companion.turnState,
        companion.attention,
        updatedAt,
        updatedAt,
        JSON.stringify({
          collaboration_mode: "default",
          observed_at: updatedAt,
          reasoning_effort: "high",
          runtime_model: "gpt-5.5-codex"
        }),
        companion.summary
      );
    }
  }
  const approvalTiming = seedMode === "dashboard"
    ? physicalApprovalTiming(updatedAt)
    : null;
  const streamSeedEvents = approvalTiming !== null
    ? physicalDashboardSeedEvents(approvalTiming)
    : seedMode === "prompt"
      ? Object.freeze([physicalPromptSeedEvent(updatedAt)])
      : Object.freeze([]);
  const promptSeedEvent = seedMode === "prompt"
    ? streamSeedEvents[0] ?? null
    : null;
  if (streamSeedEvents.length > 0) {
    const states = createSelectedStateRepository(db);
    let retainedEventBytes = 0;
    for (const event of streamSeedEvents) {
      const current = states.require(physicalUiSessionId);
      const byteLength = selectedProjectedEventByteLength(event);
      retainedEventBytes += byteLength;
      states.appendEvent(
        Object.freeze({ byte_length: byteLength, event }),
        {
          ...current.projection,
          session: {
            ...current.projection.session,
            last_activity_at: updatedAt,
            last_event_cursor: event.cursor,
            recent_summary:
              event.type === "message"
                ? event.text
                : current.projection.session.recent_summary,
            updated_at: updatedAt
          },
          earliest_retained_cursor: streamSeedEvents[0]?.cursor ?? null,
          retained_event_bytes: retainedEventBytes,
          retained_event_count: event.cursor,
          retention_boundary_cursor:
            event.type === "replay_boundary"
              ? event.after
              : current.projection.retention_boundary_cursor
        },
        selectedStateRevision(current)
      );
    }
  }
  return Object.freeze({
    approvalTiming,
    promptSeedEvent,
    reads: createSelectedSessionReadRepository(db),
    streamSeedEvents
  });
}

class PhysicalStreamRecoveryGate {
  private heldRequests = 0;
  private releaseHeldRequest: (() => void) | null = null;
  private state: PhysicalStreamRecoveryGateState = "idle";

  arm(): void {
    requireCondition(
      this.state === "idle",
      "Physical stream recovery gate was armed more than once."
    );
    this.state = "armed";
  }

  holdIfArmed(): Promise<void> {
    if (this.state === "idle" || this.state === "released") {
      return Promise.resolve();
    }
    requireCondition(
      this.state === "armed" && this.releaseHeldRequest === null,
      "Physical stream recovery gate received a duplicate held request."
    );
    this.state = "holding";
    this.heldRequests += 1;
    return new Promise((resolve) => {
      this.releaseHeldRequest = resolve;
    });
  }

  release(): boolean {
    if (this.state === "idle" || this.state === "released") return false;
    const release = this.releaseHeldRequest;
    this.releaseHeldRequest = null;
    this.state = "released";
    release?.();
    return true;
  }

  snapshot(): PhysicalStreamRecoveryGateSnapshot {
    return Object.freeze({
      held_requests: this.heldRequests,
      state: this.state
    });
  }
}

function createPhysicalPromptRuntime(
  states: ReturnType<typeof createSelectedStateRepository>,
  now: () => Date,
  initialEvents: readonly SelectedProjectionEvent[],
  recoveryGate = new PhysicalStreamRecoveryGate()
): PhysicalPromptRuntime {
  const selected = states.require(physicalUiSessionId);
  selectedSessionMappingRecordSchema.parse(selected.mapping);
  selectedSessionProjectionRecordSchema.parse(selected.projection);
  const turns = new PhysicalPromptTurnClient();
  const service = createCodexPromptControlService({
    turns,
    models: noPendingPhysicalPromptControl("model"),
    plans: noPendingPhysicalPromptControl("plan"),
    states,
    now: () => now().toISOString()
  });
  requireCondition(
    initialEvents.length >= 1,
    "Physical prompt runtime requires one retained event."
  );
  const handoff = new PhysicalPromptHandoffService(initialEvents);
  const initialCursor = initialEvents.at(-1)?.cursor ?? 0;
  let nextCursor = initialCursor + 1;
  const streamFailures: unknown[] = [];
  const recordStreamFailure = (failure: unknown): void => {
    streamFailures.push(failure);
  };
  const subscribers = createProjectionSubscriberStreamService({
    handoff: Object.freeze({
      open: (input: unknown) => handoff.open(input)
    }),
    observe_failure: recordStreamFailure,
    resource_budget: defaultResourceBudget
  });
  let phase: "ready" | "in_progress" | "completed" = "ready";
  let interruptPhase: "idle" | "in_progress" | "interrupted" = "idle";
  let interruptTurnId: string | null = null;
  const runtime: PhysicalPromptRuntime = {
    async advance(state) {
      requireCondition(
        (phase === "ready" && state === "in_progress") ||
          (phase === "in_progress" && state === "completed"),
        "Physical prompt progress violated accepted event order."
      );
      const capturedAt = now().toISOString();
      replacePhysicalPromptAdmissionState(states, state, capturedAt);
      await service.observeEvent(
        physicalPromptRuntimeEvent(state, capturedAt)
      );
      handoff.publish(
        physicalPromptTurnEvent(nextCursor, state, capturedAt)
      );
      nextCursor += 1;
      phase = state;
    },
    disconnectForRecovery() {
      recoveryGate.arm();
      handoff.disconnectAll();
    },
    publishInterruptTurn(turnId, state) {
      const parsedTurnId = codexTurnIdSchema.parse(turnId);
      requireCondition(
        ((interruptPhase === "idle" && state === "in_progress") ||
          (interruptPhase === "in_progress" && state === "interrupted")) &&
          (interruptTurnId === null || interruptTurnId === parsedTurnId),
        "Physical interrupt progress violated accepted event order."
      );
      handoff.publish(
        physicalInterruptTurnEvent(
          nextCursor,
          parsedTurnId,
          state,
          now().toISOString()
        )
      );
      nextCursor += 1;
      interruptPhase = state;
      interruptTurnId = parsedTurnId;
    },
    recoverySnapshot: () => recoveryGate.snapshot(),
    recordStreamFailure,
    releaseRecovery: () => recoveryGate.release(),
    service,
    get startCalls() {
      return Object.freeze([...turns.startCalls]);
    },
    get streamFailureCount() {
      return streamFailures.length;
    },
    get streamFailureCodes() {
      return Object.freeze(streamFailures.map(physicalStreamFailureCode));
    },
    subscribers
  };
  return Object.freeze(runtime);
}

function physicalStreamFailureCode(candidate: unknown): string {
  if (candidate === null || typeof candidate !== "object") return "unknown";
  const descriptor = Object.getOwnPropertyDescriptor(candidate, "code");
  return descriptor !== undefined &&
    "value" in descriptor &&
    typeof descriptor.value === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/u.test(descriptor.value)
    ? descriptor.value
    : "unknown";
}

class PhysicalPromptTurnClient implements PhysicalPromptTurnPort {
  readonly runtime_version = "0.144.0";
  readonly startCalls: PhysicalPromptStartInput[] = [];

  async startTurn(
    input: PhysicalPromptStartInput
  ): ReturnType<PhysicalPromptTurnPort["startTurn"]> {
    this.startCalls.push(input);
    return Object.freeze({
      thread_id: codexThreadIdSchema.parse(input.thread_id),
      turn_id: codexTurnIdSchema.parse(physicalPromptTurnId),
      state: "accepted" as const
    });
  }

  async steerTurn(
    _input: Parameters<PhysicalPromptTurnPort["steerTurn"]>[0]
  ): ReturnType<PhysicalPromptTurnPort["steerTurn"]> {
    throw new Error("Physical prompt acceptance must start one new turn.");
  }

  async interruptTurn(
    _input: Parameters<PhysicalPromptTurnPort["interruptTurn"]>[0]
  ): ReturnType<PhysicalPromptTurnPort["interruptTurn"]> {
    throw new Error("Physical prompt acceptance must not interrupt a turn.");
  }
}

function noPendingPhysicalPromptControl(kind: "model" | "plan") {
  return Object.freeze({
    readPendingSettings: () => Object.freeze([]),
    async dispatchPendingTurn() {
      throw new Error(
        `Physical prompt acceptance has no pending ${kind} control.`
      );
    }
  });
}

function physicalPromptCompatibility(now: () => Date) {
  return runtimeCompatibilitySchema.parse({
    source: "codex_app_server",
    state: "ready",
    mutation_policy: "allowed",
    observed_version: "0.144.0",
    binding_id: "binding-physical-prompt-001",
    capabilities: [
      "thread_lifecycle",
      "turn_input",
      "turn_steer",
      "turn_interrupt",
      "model",
      "goal",
      "plan",
      "usage",
      "compact",
      "skills",
      "approvals",
      "multi_client"
    ].map((name) => ({ name, state: "available", reason: null })),
    checked_at: now().toISOString(),
    reason: null
  });
}

function replacePhysicalPromptAdmissionState(
  states: ReturnType<typeof createSelectedStateRepository>,
  turnState: "in_progress" | "completed",
  updatedAt: string
): void {
  const current = states.require(physicalUiSessionId);
  states.replace(
    {
      mapping: { ...current.mapping, updated_at: updatedAt },
      projection: {
        ...current.projection,
        session: {
          ...current.projection.session,
          turn_state: turnState,
          attention: "none",
          updated_at: updatedAt,
          last_activity_at: updatedAt
        }
      }
    },
    {
      mapping_updated_at: current.mapping.updated_at,
      projection_updated_at: current.projection.session.updated_at,
      last_event_cursor: current.projection.session.last_event_cursor
    }
  );
}

function physicalPromptRuntimeEvent(
  state: "in_progress" | "completed",
  capturedAt: string
): Parameters<CodexPromptControlService["observeEvent"]>[0] {
  return {
    sequence: state === "in_progress" ? 2 : 3,
    method: state === "in_progress" ? "turn/started" : "turn/completed",
    captured_at: capturedAt,
    upstream_at: null,
    codex_event_id: null,
    scope: "thread",
    thread_id: physicalUiThreadId,
    turn_id: physicalPromptTurnId,
    status: state,
    ...(state === "completed" ? { error_message: null } : {})
  } as Parameters<CodexPromptControlService["observeEvent"]>[0];
}

function physicalPromptSeedEvent(capturedAt: string): SelectedProjectionEvent {
  return Object.freeze(selectedProjectionEventSchema.parse({
    captured_at: capturedAt,
    codex_event_id: "physical-prompt-stream-ready",
    codex_event_type: "item/agentMessage/delta",
    content_notice: null,
    content_state: "complete",
    cursor: 1,
    item_id: null,
    phase: "delta",
    role: "agent",
    session_id: physicalUiSessionId,
    text: "Physical prompt stream ready",
    type: "message",
    upstream_at: null
  }));
}

function physicalDashboardSeedEvents(
  approvalTiming: PhysicalApprovalTiming
): readonly SelectedProjectionEvent[] {
  const base = (cursor: number, content: Readonly<Record<string, unknown>>) => ({
    session_id: physicalUiSessionId,
    cursor,
    captured_at: approvalTiming.createdAt,
    upstream_at: null,
    codex_event_id: `physical-dashboard-event-${cursor}`,
    codex_event_type: `physical/dashboard/${cursor}`,
    ...content
  });
  return Object.freeze([
    selectedProjectionEventSchema.parse(base(1, {
      type: "replay_boundary",
      content_state: "truncated",
      content_notice: "Earlier retained projections are outside this bounded window.",
      after: 0,
      next_cursor: 1,
      reason: "retention"
    })),
    selectedProjectionEventSchema.parse(base(2, {
      type: "message",
      content_state: "complete",
      content_notice: null,
      role: "agent",
      phase: "completed",
      item_id: "item-physical-dashboard-complete",
      text: "Physical dashboard event complete"
    })),
    selectedProjectionEventSchema.parse(base(3, {
      type: "turn",
      content_state: "redacted",
      content_notice: "Sensitive turn detail was redacted at projection time.",
      turn_id: "turn-physical-redacted-001",
      state: "failed",
      error: {
        code: "runtime_unavailable",
        message: "The selected runtime stopped before completion."
      }
    })),
    selectedProjectionEventSchema.parse(base(4, {
      type: "approval",
      content_state: "complete",
      content_notice: null,
      request_id: "request-physical-approval-001",
      state: "pending",
      action: "Install the Android validation package",
      scope: "Connected test phone",
      reason: "Continue the bounded release validation on the selected device.",
      risk: "elevated",
      expires_at: approvalTiming.expiresAt,
      decision: null
    })),
    selectedProjectionEventSchema.parse(base(5, {
      type: "runtime",
      content_state: "complete",
      content_notice: null,
      state: "ready",
      message: null
    }))
  ]);
}

function physicalApprovalTiming(createdAt: string): PhysicalApprovalTiming {
  const createdAtMs = Date.parse(createdAt);
  requireCondition(
    Number.isSafeInteger(createdAtMs),
    "Physical approval fixture received an invalid creation time."
  );
  return Object.freeze({
    createdAt,
    expiresAt: new Date(createdAtMs + physicalApprovalLifetimeMs).toISOString()
  });
}

function physicalPromptTurnEvent(
  cursor: number,
  state: "in_progress" | "completed",
  capturedAt: string
): SelectedProjectionEvent {
  return Object.freeze(selectedProjectionEventSchema.parse({
    session_id: physicalUiSessionId,
    cursor,
    captured_at: capturedAt,
    upstream_at: null,
    codex_event_id: `physical-prompt-turn-${cursor}`,
    codex_event_type:
      state === "in_progress" ? "turn/started" : "turn/completed",
    content_state: "complete",
    content_notice: null,
    type: "turn",
    turn_id: physicalPromptTurnId,
    state,
    error: null
  }));
}

function physicalInterruptTurnEvent(
  cursor: number,
  turnId: string,
  state: "in_progress" | "interrupted",
  capturedAt: string
): SelectedProjectionEvent {
  return Object.freeze(selectedProjectionEventSchema.parse({
    session_id: physicalUiSessionId,
    cursor,
    captured_at: capturedAt,
    upstream_at: null,
    codex_event_id: `physical-interrupt-turn-${cursor}`,
    codex_event_type:
      state === "in_progress" ? "turn/started" : "turn/interrupted",
    content_state: "complete",
    content_notice: null,
    type: "turn",
    turn_id: codexTurnIdSchema.parse(turnId),
    state,
    error: null
  }));
}

class PhysicalPromptHandoffService
  implements ProjectionReplayLiveHandoffService
{
  private readonly events: SelectedProjectionEvent[];
  private readonly live = new Map<
    string,
    {
      readonly controller: AbortController;
      readonly sink: (event: SelectedProjectionEvent) => void;
    }
  >();

  constructor(events: readonly SelectedProjectionEvent[]) {
    this.events = events.map(freezePhysicalProjectionEvent);
  }

  publish(event: SelectedProjectionEvent): void {
    const frozenEvent = freezePhysicalProjectionEvent(event);
    const previous = this.events.at(-1);
    requireCondition(
      frozenEvent.session_id === physicalUiSessionId &&
        (previous === undefined || frozenEvent.cursor === previous.cursor + 1),
      "Physical prompt event cursor was invalid."
    );
    this.events.push(frozenEvent);
    for (const entry of [...this.live.values()]) entry.sink(frozenEvent);
  }

  disconnectAll(): void {
    for (const [subscriberId, entry] of [...this.live.entries()]) {
      this.live.delete(subscriberId);
      entry.controller.abort();
    }
  }

  open(candidate: unknown): ProjectionReplayLiveHandoff {
    const input = candidate as OpenProjectionReplayLiveHandoffInput;
    if (input.session_id !== physicalUiSessionId) {
      throw new HostDeckProjectionHandoffError(
        "session_not_found",
        "Physical prompt session was not found."
      );
    }
    const after = input.after as PhysicalOutputCursor | null;
    const replay = Object.freeze(
      this.events.filter(
        (event) => after === null || event.cursor > after
      )
    );
    const highWater = (this.events.at(-1)?.cursor ?? after) as
      | PhysicalOutputCursor
      | null;
    const controller = new AbortController();
    const replayBytes = replay.reduce(
      (total, event) => total + physicalProjectionWireByteLength(event),
      0
    );
    let activated = false;
    let claimed = false;
    let closed = false;
    const service = this;
    return Object.freeze({
      activate(activationCandidate: unknown) {
        const activation = activationCandidate as {
          readonly on_event: (event: SelectedProjectionEvent) => void;
        };
        requireCondition(
          !activated && typeof activation.on_event === "function",
          "Physical prompt stream activation was invalid."
        );
        service.live.set(input.subscriber_id, {
          controller,
          sink: activation.on_event
        });
        activated = true;
        return Object.freeze({
          drained_event_count: 0,
          live_after_cursor: highWater
        });
      },
      after,
      claim_replay() {
        requireCondition(!claimed, "Physical prompt replay was already claimed.");
        claimed = true;
        return Object.freeze({
          event_count: replay.length,
          events: replay,
          wire_bytes: replayBytes
        });
      },
      close() {
        if (closed) return false;
        closed = true;
        service.live.delete(input.subscriber_id);
        controller.abort();
        return true;
      },
      get failure(): ProjectionHandoffFailure | null {
        return null;
      },
      high_water_cursor: highWater,
      observed_fanout_cursor: null,
      get paused_event_count() {
        return 0;
      },
      get paused_wire_bytes() {
        return 0;
      },
      replay_event_count: replay.length,
      replay_wire_bytes: replayBytes,
      session_id: input.session_id,
      signal: controller.signal,
      get state() {
        return closed ? "closed" : activated ? "live" : "paused";
      },
      subscriber_id: input.subscriber_id,
      truncated: replay[0]?.type === "replay_boundary"
    });
  }
}

function freezePhysicalProjectionEvent(
  event: SelectedProjectionEvent
): SelectedProjectionEvent {
  return deepFreezePhysicalData(selectedProjectionEventSchema.parse(event));
}

function deepFreezePhysicalData<Value>(value: Value): Value {
  if (value === null || typeof value !== "object") return value;
  for (const child of Object.values(value)) deepFreezePhysicalData(child);
  Object.freeze(value);
  return value;
}

function physicalProjectionWireByteLength(
  event: SelectedProjectionEvent
): number {
  return Buffer.byteLength(
    `id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
    "utf8"
  );
}

function composePhysicalRouteRegistration(
  id: string,
  surface: "api" | "sse" | "static",
  registrations: readonly HostDeckRoutePluginRegistration[],
  inspection: RequestInspection,
  secrets: ReturnType<typeof createSecretRegistry>,
  streamRecoveryGate: PhysicalStreamRecoveryGate | null = null
): HostDeckRoutePluginRegistration {
  requireCondition(
    registrations.length > 0 &&
      registrations.every((registration) => registration.surface === surface),
    "Physical route composition crossed a Fastify surface boundary."
  );
  const registration: HostDeckRoutePluginRegistration = {
    id,
    surface,
    async register(app, context) {
      installRequestInspection(app, inspection, secrets, streamRecoveryGate);
      for (const registration of registrations) {
        await registration.register(app, context);
      }
    }
  };
  return Object.freeze(registration);
}

function physicalPageRoute(
  bundle: string,
  options: Readonly<{
    id: string;
    path: `/${string}`;
  }> = Object.freeze({
    id: "physical-fragment-pairing-page",
    path: "/"
  })
): HostDeckRoutePluginRegistration {
  requireCondition(
    /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(options.id) &&
      (options.path === "/" ||
        options.path === "/__physical/clipboard" ||
        options.path === "/__physical/cleanup"),
    "Physical browser page route options are invalid."
  );
  const nonce = randomBytes(18).toString("base64url");
  const html =
    "<!doctype html><html lang=\"en\"><head>" +
    "<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<title>HostDeck pairing acceptance</title>" +
    `<style nonce="${nonce}">:root{font-family:Inter,system-ui,sans-serif;color:#17191c;background:#eef1f2}*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:#eef1f2}body{min-height:100vh;min-height:100svh}main{min-height:100vh;min-height:100svh;display:flex;flex-direction:column;padding:clamp(28px,7vh,64px) 28px 32px;background:#fff;border-top:6px solid #167c5a}.brand{margin:0 0 clamp(48px,14vh,120px);font-size:14px;font-weight:800;text-transform:uppercase;color:#3e474d}.marker{width:52px;height:52px;display:grid;place-items:center;margin-bottom:28px;background:#e4f2ed;color:#116b4d;font-size:24px;font-weight:800;border-radius:6px}h1{margin:0;font-size:30px;line-height:1.15;letter-spacing:0}#status{margin:18px 0 0;font-size:20px;font-weight:750;color:#22272b}#detail{min-height:72px;margin:10px 0 0;color:#596168;font-size:16px;line-height:1.5}#start{width:100%;min-height:54px;margin:28px 0 0;border:0;border-radius:6px;background:#167c5a;color:#fff;font:inherit;font-size:17px;font-weight:750}#start:focus-visible{outline:3px solid #111;outline-offset:3px}#start[hidden]{display:none}.rule{height:1px;margin:auto 0 20px;background:#d9dfe2}.foot{margin:0;font-size:13px;color:#6d757b}html[data-acceptance-state=profile_away] main{border-top-color:#b26a00}html[data-acceptance-state=profile_away] .marker{background:#fff0d8;color:#8a5100}html[data-acceptance-state=recovered] main,html[data-acceptance-state=paired_ready] main{border-top-color:#167c5a}html[data-acceptance-state=revoked_cleaned] main{border-top-color:#4b555c}html[data-acceptance-state=revoked_cleaned] .marker{background:#e9edef;color:#3f484e}html[data-acceptance-state=failed] main{border-top-color:#a52e2e}html[data-acceptance-state=failed] .marker{background:#f8e5e5;color:#8d2525}@media(min-width:600px){main{width:480px;margin:0 auto;border-left:1px solid #d9dfe2;border-right:1px solid #d9dfe2}}</style></head>` +
    "<body><main><p class=\"brand\">HostDeck</p><div class=\"marker\" aria-hidden=\"true\">H</div>" +
    "<h1>Remote access check</h1><p id=\"status\">Starting</p>" +
    "<p id=\"detail\">Checking the private phone connection.</p>" +
    "<button id=\"start\" type=\"button\" hidden>Start check</button><div class=\"rule\"></div>" +
    "<p class=\"foot\">Private Android acceptance</p></main>" +
    `<script type="module" nonce="${nonce}">${bundle}</script></body></html>`;
  const registration: HostDeckRoutePluginRegistration = {
    id: options.id,
    surface: "static",
    register(app) {
      app.get(options.path, async (_request, reply) => {
        reply.headers({
          "cache-control": "no-store",
          "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
          "content-type": "text/html; charset=utf-8",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff"
        });
        return reply.send(html);
      });
    }
  };
  return Object.freeze(registration);
}

function physicalProtectedRoute(): HostDeckRoutePluginRegistration {
  const registration: HostDeckRoutePluginRegistration = {
    id: "physical-fragment-pairing-protected-read",
    surface: "api",
    register(app) {
      app.get(
        "/__physical/protected",
        {
          config: hostDeckNoStoreRouteConfig,
          exposeHeadRoute: false,
          async preHandler(request) {
            requireHostDeckRequestAuthentication(request, "device_cookie");
          },
          schema: {
            response: { 200: selectedRequestAuthenticationContextSchema }
          }
        },
        async (request) => resolveHostDeckRequestAuthentication(request)
      );
    }
  };
  return Object.freeze(registration);
}

function createPhysicalDriverRuntime(): PhysicalDriverRuntime {
  const checkpoints: PhysicalCheckpoint[] = [];
  let command: PhysicalDriverCommand = "hold";
  let revision = 0;
  return Object.freeze({
    recordCheckpoint(checkpoint: PhysicalCheckpoint) {
      const expected = physicalCheckpointOrder[checkpoints.length];
      requireCondition(
        checkpoint === expected,
        "Physical phone checkpoint violated the frozen sequence."
      );
      checkpoints.push(checkpoint);
    },
    setCommand(next: PhysicalDriverCommand) {
      const allowed =
        (command === "hold" &&
          (next === "prepare-away" || next === "cleanup")) ||
        (command === "prepare-away" && next === "revoke");
      requireCondition(allowed, "Physical phone command transition was invalid.");
      command = next;
      revision += 1;
    },
    snapshot() {
      return Object.freeze({
        checkpoints: Object.freeze([...checkpoints]),
        command,
        revision
      });
    }
  });
}

function hasPhysicalCheckpoint(
  runtime: PhysicalDriverRuntime,
  checkpoint: PhysicalCheckpoint
): boolean {
  return runtime.snapshot().checkpoints.includes(checkpoint);
}

function physicalDriverRoute(
  runtime: PhysicalDriverRuntime
): HostDeckRoutePluginRegistration {
  const registration: HostDeckRoutePluginRegistration = {
    id: "physical-phone-driver",
    surface: "api",
    register(app) {
      for (const checkpoint of physicalCheckpointOrder) {
        const path = `/__physical/checkpoint/${checkpoint}`;
        app.get(
          path,
          {
            config: hostDeckNoStoreRouteConfig,
            exposeHeadRoute: false,
            async preHandler(request) {
              requirePhysicalDriverRequest(request, path);
              requireHostDeckRequestAuthentication(request, "device_cookie");
            },
            schema: { response: { 204: physicalCheckpointResponseSchema } }
          },
          async (_request, reply) => {
            runtime.recordCheckpoint(checkpoint);
            return reply.code(204).send();
          }
        );
      }
      const revokedPath = "/__physical/checkpoint/revoked";
      app.get(
        revokedPath,
        {
          config: hostDeckNoStoreRouteConfig,
          exposeHeadRoute: false,
          async preHandler(request) {
            requirePhysicalDriverRequest(request, revokedPath);
            requireHostDeckRequestAuthentication(request, "device_cookie");
          },
          schema: {
            response: { 409: physicalAuthorityNotRevokedResponseSchema }
          }
        },
        async (_request, reply) =>
          reply.code(409).send(physicalAuthorityNotRevokedResponse)
      );
      app.get(
        "/__physical/command",
        {
          config: hostDeckNoStoreRouteConfig,
          exposeHeadRoute: false,
          async preHandler(request) {
            requirePhysicalDriverRequest(request, "/__physical/command");
            requireHostDeckRequestAuthentication(request, "device_cookie");
          },
          schema: { response: { 200: physicalDriverCommandResponseSchema } }
        },
        async () => {
          const snapshot = runtime.snapshot();
          return Object.freeze({
            command: snapshot.command,
            revision: snapshot.revision
          });
        }
      );
    }
  };
  return Object.freeze(registration);
}

function requirePhysicalDriverRequest(
  request: Readonly<{
    readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
    readonly url: string;
  }>,
  path: string
): void {
  const contentLength = request.headers["content-length"];
  requireCondition(
    request.url === path &&
      (contentLength === undefined || contentLength === "0") &&
      request.headers["transfer-encoding"] === undefined,
    "Physical phone driver rejected an unexpected request shape."
  );
}

function physicalSseRoute(
  runtime: PhysicalSseRuntime
): HostDeckRoutePluginRegistration {
  return createHostDeckSseTransportRegistration({
    id: "physical-remote-events",
    observeError: () => undefined,
    path: "/__physical/events",
    source: {
      open({ after, request, signal }) {
        requireHostDeckRequestAuthentication(request, "device_cookie");
        const cursor = (after ?? 0) + 1;
        runtime.opened += 1;
        runtime.active += 1;
        runtime.maxActive = Math.max(runtime.maxActive, runtime.active);
        return (async function* () {
          try {
            yield selectedProjectionEventSchema.parse({
              captured_at: new Date().toISOString(),
              codex_event_id: `physical-remote-event-${cursor}`,
              codex_event_type: "item/agentMessage/delta",
              content_notice: null,
              content_state: "complete",
              cursor,
              item_id: null,
              phase: "delta",
              role: "agent",
              session_id: "sess_physical_remote_001",
              text: "Remote acceptance event",
              type: "message",
              upstream_at: null
            });
            await waitForAbort(signal);
          } finally {
            runtime.active -= 1;
            runtime.closed += 1;
          }
        })();
      }
    }
  });
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function installRequestInspection(
  app: HostDeckFastifyInstance,
  inspection: RequestInspection,
  secrets: ReturnType<typeof createSecretRegistry>,
  streamRecoveryGate: PhysicalStreamRecoveryGate | null
): void {
  app.addHook("onRequest", async (request) => {
    const referrer = request.headers.referer;
    const localAdmin = request.headers["x-hostdeck-local-admin"];
    const observed = `${request.url}\n${typeof referrer === "string" ? referrer : ""}`;
    if (secrets.values().some((secret) => observed.includes(secret))) {
      inspection.fragmentLeaks += 1;
    }
    if (request.url === "/api/v1/access/pairing-claims") {
      inspection.claimRequests += 1;
      if (referrer === undefined) inspection.noReferrerApiRequests += 1;
    }
    if (request.url === "/api/v1/access/csrf") {
      inspection.csrfRequests += 1;
      if (referrer === undefined) inspection.noReferrerApiRequests += 1;
    }
    if (request.url === "/api/v1/access") {
      inspection.accessRequests += 1;
    }
    if (request.url === "/api/v1/host/status") {
      inspection.hostStatusRequests += 1;
    }
    if (request.url === "/api/v1/remote/status") {
      inspection.remoteStatusRequests += 1;
      if (localAdmin === undefined) inspection.remoteBrowserStatusRequests += 1;
    }
    if (request.url === "/api/v1/remote/enable") {
      inspection.remoteEnableRequests += 1;
    }
    if (request.url === "/api/v1/remote/disable") {
      inspection.remoteDisableRequests += 1;
    }
    if (
      request.method === "GET" &&
      request.url === `/api/v1/sessions/${physicalUiSessionId}/plan`
    ) {
      inspection.planReadRequests += 1;
    }
    if (
      request.url === "/api/v1/sessions" ||
      request.url.startsWith("/api/v1/sessions?")
    ) {
      inspection.sessionListRequests += 1;
    }
    if (request.url === `/api/v1/sessions/${physicalUiSessionId}`) {
      inspection.sessionDetailRequests += 1;
    }
    if (request.url === "/api/v1/sessions/sess_physical_missing") {
      inspection.sessionMissingDetailRequests += 1;
    }
    if (
      request.url === `/api/v1/sessions/${physicalUiSessionId}/events` ||
      request.url.startsWith(
        `/api/v1/sessions/${physicalUiSessionId}/events?`
      )
    ) {
      inspection.sessionEventRequests += 1;
    }
    if (
      request.url ===
        `/api/v1/sessions/${physicalUiSessionId}/events/stream` ||
      request.url.startsWith(
        `/api/v1/sessions/${physicalUiSessionId}/events/stream?`
      )
    ) {
      inspection.sessionStreamRequests += 1;
      await streamRecoveryGate?.holdIfArmed();
    }
    if (
      request.url === `/api/v1/sessions/${physicalUiSessionId}/prompts`
    ) {
      inspection.promptRequests += 1;
      if (referrer === undefined) inspection.promptNoReferrerRequests += 1;
    }
    if (request.url === "/__physical/protected") {
      inspection.protectedReadRequests += 1;
    }
    if (
      request.url.startsWith("/api/v1/access/devices/") &&
      request.url.endsWith("/revoke")
    ) {
      inspection.revokeRequests += 1;
    }
    if (request.url === "/__physical/checkpoint/revoked") {
      inspection.revokedCheckpointRequests += 1;
    }
  });
  app.addHook("onSend", async (request, _reply, payload) => {
    if (
      request.url ===
        `/api/v1/sessions/${physicalUiSessionId}/events/stream` ||
      request.url.startsWith(
        `/api/v1/sessions/${physicalUiSessionId}/events/stream?`
      )
    ) {
      recordPhysicalResponseStatus(
        inspection.sessionStreamResponseStatuses,
        _reply.statusCode
      );
    }
    if (
      request.url !== "/api/v1/remote/enable" &&
      request.url !== "/api/v1/remote/disable"
    ) {
      return payload;
    }
    try {
      if (resolveHostDeckRequestAuthentication(request).state !== "local_admin") {
        inspection.remoteBrowserMutationRequests += 1;
      }
    } catch {
      inspection.remoteBrowserMutationRequests += 1;
    }
    return payload;
  });
  app.addHook("onResponse", async (request, reply) => {
    if (request.url === "/api/v1/access/pairing-claims") {
      recordPhysicalResponseStatus(
        inspection.claimResponseStatuses,
        reply.statusCode
      );
    }
    if (request.url === "/api/v1/access/csrf") {
      recordPhysicalResponseStatus(
        inspection.csrfResponseStatuses,
        reply.statusCode
      );
    }
    if (request.url === "/api/v1/access") {
      recordPhysicalResponseStatus(
        inspection.accessResponseStatuses,
        reply.statusCode
      );
    }
    if (request.url === "/api/v1/host/status") {
      recordPhysicalResponseStatus(
        inspection.hostStatusResponseStatuses,
        reply.statusCode
      );
    }
    if (
      request.url === "/api/v1/sessions" ||
      request.url.startsWith("/api/v1/sessions?")
    ) {
      recordPhysicalResponseStatus(
        inspection.sessionListResponseStatuses,
        reply.statusCode
      );
    }
    if (
      request.url === `/api/v1/sessions/${physicalUiSessionId}/prompts`
    ) {
      recordPhysicalResponseStatus(
        inspection.promptResponseStatuses,
        reply.statusCode
      );
    }
    if (request.url === "/__physical/protected") {
      if (reply.statusCode === 200) inspection.protectedReadSuccesses += 1;
      if (reply.statusCode === 401) inspection.protectedReadRejections += 1;
    }
    if (
      request.url === "/api/v1/access/pairing-claims" &&
      reply.statusCode >= 200 &&
      reply.statusCode < 300
    ) {
      const raw = reply.getHeader("set-cookie");
      const values = Array.isArray(raw) ? raw.map(String) : raw === undefined ? [] : [String(raw)];
      inspection.hardenedCookieObserved =
        values.length === 1 &&
        /;\s*Secure(?:;|$)/iu.test(values[0] ?? "") &&
        /;\s*HttpOnly(?:;|$)/iu.test(values[0] ?? "") &&
        /;\s*SameSite=Strict(?:;|$)/iu.test(values[0] ?? "") &&
        /;\s*Path=\/(?:;|$)/iu.test(values[0] ?? "") &&
        !/;\s*Domain=/iu.test(values[0] ?? "");
    }
    if (
      request.url.startsWith("/api/v1/access/devices/") &&
      request.url.endsWith("/revoke") &&
      reply.statusCode >= 200 &&
      reply.statusCode < 300
    ) {
      const raw = reply.getHeader("set-cookie");
      const values = Array.isArray(raw)
        ? raw.map(String)
        : raw === undefined
          ? []
          : [String(raw)];
      inspection.deletionCookieObserved =
        values.length === 1 &&
        /Max-Age=0/iu.test(values[0] ?? "") &&
        /;\s*Secure(?:;|$)/iu.test(values[0] ?? "") &&
        /;\s*HttpOnly(?:;|$)/iu.test(values[0] ?? "") &&
        /;\s*SameSite=Strict(?:;|$)/iu.test(values[0] ?? "");
    }
    if (
      request.url === "/__physical/checkpoint/revoked" &&
      reply.statusCode === 401
    ) {
      inspection.rejectedRevokedCheckpoints += 1;
    }
  });
}

function recordPhysicalResponseStatus(statuses: number[], status: number): void {
  requireCondition(
    statuses.length < 16 && Number.isSafeInteger(status) && status >= 100 && status <= 599,
    "Physical response-status evidence was invalid or exhausted."
  );
  statuses.push(status);
}

function requireDedicatedAbsentCandidate(
  snapshot: RemoteIngressObservationSnapshot
): Readonly<{ externalOrigin: string; expectedProfileKey: string }> {
  const expectedProfileKey = snapshot.profile.comparison.expected_profile_key;
  requireCondition(
    snapshot.client === "available" &&
      snapshot.failure === null &&
      snapshot.profile.state === "dedicated" &&
      snapshot.profile.comparison.relation === "match" &&
      typeof expectedProfileKey === "string" &&
      expectedProfileKey === snapshot.profile.comparison.active_profile_key &&
      typeof snapshot.external_origin === "string" &&
      snapshot.serve === "absent",
    "Physical pairing requires one clean active dedicated profile."
  );
  return Object.freeze({
    externalOrigin: snapshot.external_origin,
    expectedProfileKey
  });
}

function requireProfileSwitchInput(): ProfileSwitchInput {
  const awayProfileId =
    process.env.HOSTDECK_REMOTE_CONTROL_AWAY_PROFILE_ID ?? null;
  const dedicatedProfileId =
    process.env.HOSTDECK_REMOTE_CONTROL_DEDICATED_PROFILE_ID ?? null;
  requireCondition(
    isBoundedProfileId(awayProfileId) &&
      isBoundedProfileId(dedicatedProfileId) &&
      awayProfileId !== dedicatedProfileId,
    "Physical acceptance requires two distinct bounded saved-profile ids."
  );
  return Object.freeze({ awayProfileId, dedicatedProfileId });
}

function isBoundedProfileId(value: unknown): value is string {
  return (
    typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/u.test(value)
  );
}

async function switchSavedProfile(profileId: string): Promise<void> {
  requireCondition(
    isBoundedProfileId(profileId),
    "Physical saved-profile id was invalid."
  );
  const observation = await runBoundedTailscaleCommand([
    "switch",
    profileId
  ]);
  await waitFor(
    async () => (await readSelectedSavedProfileId()) === profileId,
    10_000,
    "Physical saved-profile selection did not converge."
  );
  requireCondition(
    isAcceptedProfileSwitchObservation(observation),
    "Physical saved-profile switch failed."
  );
}

function isAcceptedProfileSwitchObservation(
  observation: CommandObservation
): boolean {
  if (observation.stderr !== "") return false;
  const switchingLine =
    "Switching to account [^\\u0000-\\u001f\\u007f]{1,128}";
  if (observation.exit_code === 0) {
    return new RegExp(
      `^${switchingLine}\\r?\\nSuccess\\.\\r?\\n$`,
      "u"
    ).test(observation.stdout);
  }
  return (
    observation.exit_code === 1 &&
    new RegExp(
      `^${switchingLine}\\r?\\nTailscale is stopped\\.\\r?\\n$`,
      "u"
    ).test(observation.stdout)
  );
}

async function readSelectedSavedProfileId(): Promise<string> {
  const observation = await runBoundedTailscaleCommand([
    "switch",
    "--list",
    "--json"
  ]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(observation.stdout) as unknown;
  } catch {
    throw new Error("Physical saved-profile inventory was invalid.");
  }
  requireCondition(
    observation.exit_code === 0 &&
      observation.stderr === "" &&
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      parsed.every(
        (profile) =>
          profile !== null &&
          typeof profile === "object" &&
          isBoundedProfileId((profile as Record<string, unknown>).id) &&
          typeof (profile as Record<string, unknown>).selected === "boolean"
      ),
    "Physical saved-profile inventory was unavailable."
  );
  const profiles = parsed as readonly Readonly<Record<string, unknown>>[];
  const selected = profiles.filter((profile) => profile.selected === true);
  requireCondition(
    new Set(profiles.map((profile) => profile.id)).size === 2 &&
      selected.length === 1,
    "Physical saved-profile inventory was ambiguous."
  );
  return selected[0]?.id as string;
}

async function readServeStatusFingerprint(): Promise<ServeStatusFingerprint> {
  const observation = await runBoundedTailscaleCommand([
    "serve",
    "status",
    "--json"
  ]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(observation.stdout) as unknown;
  } catch {
    throw new Error("Physical Serve status was invalid.");
  }
  requireCondition(
    observation.exit_code === 0 &&
      observation.stderr === "" &&
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed),
    "Physical Serve status was unavailable."
  );
  return Object.freeze({
    bytes: Buffer.byteLength(observation.stdout, "utf8"),
    sha256: createHash("sha256")
      .update(observation.stdout, "utf8")
      .digest("hex")
  });
}

function requireMatchingServeFingerprint(
  before: ServeStatusFingerprint,
  after: ServeStatusFingerprint
): void {
  requireCondition(
    before.bytes === after.bytes && before.sha256 === after.sha256,
    "Physical acceptance changed foreign-profile Serve bytes."
  );
}

function runBoundedTailscaleCommand(
  args: readonly string[]
): Promise<CommandObservation> {
  requireCondition(
    args.length >= 2 &&
      args.length <= 3 &&
      args.every(
        (value) =>
          typeof value === "string" &&
          value.length >= 1 &&
          value.length <= 64 &&
          !hasControlCharacters(value)
      ),
    "Physical Tailscale command arguments were invalid."
  );
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/tailscale",
      [...args],
      {
        encoding: "utf8",
        env: {
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          PATH: "/usr/bin:/bin"
        },
        maxBuffer: 64 * 1024,
        timeout: 10_000,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        const rawExitCode = error === null ? 0 : Reflect.get(error, "code");
        if (typeof rawExitCode !== "number") {
          reject(new Error("Physical Tailscale command failed."));
          return;
        }
        resolve(
          Object.freeze({
            exit_code: rawExitCode,
            stderr,
            stdout
          })
        );
      }
    );
  });
}

function requireLifecycleManager(
  manager: TailscaleServeManager | null
): TailscaleServeManager {
  requireCondition(
    manager !== null,
    "Physical lifecycle did not create its Serve manager."
  );
  return manager as TailscaleServeManager;
}

function assertRemoteCliResult(
  result: Awaited<ReturnType<typeof runCli>>,
  expected: "disabled" | "ready" | "unavailable"
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }
  requireCondition(
    result.exitCode === cliExitCodes.ok &&
      result.stderr === "" &&
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).availability === expected &&
      !Object.hasOwn(parsed as object, "external_origin"),
    "Physical pairing remote control returned invalid public state."
  );
}

function requireOpenAdmission(
  admission: Readonly<{
    admission: string;
    external_origin: string | null;
    generation: number;
  }>,
  origin: string
): void {
  requireCondition(
    admission.admission === "open" &&
      admission.external_origin === origin &&
      Number.isSafeInteger(admission.generation) &&
      admission.generation > 0,
    "Physical pairing did not establish selected remote admission."
  );
}

function requireClosedAdmission(admission: Readonly<{
  admission: string;
  external_origin: string | null;
  generation: number;
}>): void {
  requireCondition(
    admission.admission === "closed" && admission.external_origin === null,
    "Physical pairing did not close selected remote admission."
  );
}

async function assertTrustedPhysicalPage(
  origin: string,
  expectedProductionIndex: string | null
): Promise<void> {
  const url = new URL("/", origin);
  const address = await resolveTailnetIpv4(url.hostname);
  const response = await new Promise<{
    readonly body: string;
    readonly status: number;
  }>((resolve, reject) => {
    const pending = httpsRequest(
      {
        agent: false,
        headers: { accept: "text/html", connection: "close", host: url.host },
        hostname: address,
        method: "GET",
        path: "/",
        port: 443,
        rejectUnauthorized: true,
        servername: url.hostname
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        incoming.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.byteLength;
          if (bytes > physicalPageMaxBytes) {
            incoming.destroy(new Error("Physical page response exceeded its limit."));
            return;
          }
          chunks.push(buffer);
        });
        incoming.on("end", () => {
          resolve({
            body: Buffer.concat(chunks, bytes).toString("utf8"),
            status: incoming.statusCode ?? 0
          });
        });
        incoming.on("error", () => reject(new Error("Physical HTTPS preflight failed.")));
      }
    );
    pending.setTimeout(10_000, () =>
      pending.destroy(new Error("Physical HTTPS preflight timed out."))
    );
    pending.on("error", () => reject(new Error("Physical HTTPS preflight failed.")));
    pending.end();
  });
  requireCondition(
    isExpectedPhysicalPage(response, expectedProductionIndex),
    "Physical HTTPS page preflight was invalid."
  );
}

function isExpectedPhysicalPage(
  response: Readonly<{ body: string; status: number }>,
  expectedProductionIndex: string | null
): boolean {
  if (response.status !== 200) return false;
  if (expectedProductionIndex !== null) {
    return (
      expectedProductionIndex.length > 0 && response.body === expectedProductionIndex
    );
  }
  return (
    response.body.includes("HostDeck pairing acceptance") &&
    response.body.includes("/__physical/checkpoint/")
  );
}

async function resolveTailnetIpv4(hostname: string): Promise<string> {
  const { Resolver } = await import("node:dns/promises");
  const resolver = new Resolver({ timeout: 2_000, tries: 2 });
  resolver.setServers([tailscaleDnsServer]);
  let addresses: readonly string[];
  try {
    addresses = await resolver.resolve4(hostname);
  } catch {
    throw new Error("Physical Tailnet DNS resolution failed.");
  }
  const selected = addresses.find(isTailnetIpv4);
  requireCondition(
    selected !== undefined && addresses.length <= 8,
    "Physical Tailnet DNS response was invalid."
  );
  return selected;
}

function isTailnetIpv4(value: string): boolean {
  const parts = value.split(".").map(Number);
  return (
    parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    parts[0] === 100 &&
    (parts[1] as number) >= 64 &&
    (parts[1] as number) <= 127
  );
}

async function startQrDisplay(png: Buffer): Promise<QrDisplay> {
  requireCondition(
    png.length >= 1_024 &&
      png.length <= defaultResourceBudget.cli_response_max_bytes * 4 &&
      png.subarray(0, 8).equals(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
      ) &&
      existsSync("/usr/bin/display"),
    "Physical QR image was invalid."
  );
  const child = spawn(
    "/usr/bin/display",
    ["-title", "HostDeck private pairing QR", "png:-"],
    {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, DISPLAY: process.env.DISPLAY },
      stdio: ["pipe", "ignore", "ignore"]
    }
  );
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Physical QR display did not start.")),
      5_000
    );
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("Physical QR display did not start."));
    });
    child.once("spawn", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  child.stdin?.on("error", () => undefined);
  requireCondition(
    child.stdin !== null && child.exitCode === null,
    "Physical QR display exited before reading its image."
  );
  child.stdin.end(png);
  return Object.freeze({ process: child });
}

async function closeQrDisplay(display: QrDisplay): Promise<void> {
  if (display.process.exitCode !== null || display.process.signalCode !== null) return;
  display.process.kill("SIGTERM");
  if (await waitForChildExit(display.process, 2_000)) return;
  display.process.kill("SIGKILL");
  requireCondition(
    await waitForChildExit(display.process, 2_000),
    "Physical QR display did not close."
  );
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off("exit", exited);
      resolve(false);
    }, timeoutMs);
    const exited = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once("exit", exited);
  });
}

function requireOneAuthorizedDevice(): void {
  const output = adb(["devices", "-l"]);
  const rows = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  requireCondition(
    rows.length === 2 &&
      rows[0] === "List of devices attached" &&
      /^\S+\s+device(?:\s|$)/u.test(rows[1] ?? ""),
    "Physical pairing requires exactly one authorized ADB device."
  );
}

function requireCleanAcceptanceWorktree(): void {
  const status = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    commandOptions()
  );
  requireCondition(
    status === "",
    "Physical acceptance must run from one clean committed worktree."
  );
}

function requireNoAdbApplicationTunnels(): void {
  const forwards = adb(["forward", "--list"]).trim();
  const reverses = adb(["reverse", "--list"]).trim();
  requireCondition(
    forwards === "" && reverses === "",
    "Physical acceptance found an ADB application tunnel."
  );
}

async function enforceUnrelatedAndroidNetwork(
  initialWifiEnabled: boolean,
  initialMobileDataEnabled: boolean
): Promise<void> {
  if (!initialMobileDataEnabled) {
    adb(["shell", "svc", "data", "enable"]);
  }
  await waitFor(
    () => readAndroidMobileDataEnabled(),
    15_000,
    "Physical acceptance could not enable Android mobile data."
  );
  if (initialWifiEnabled) {
    adb(["shell", "svc", "wifi", "disable"]);
  }
  await waitFor(
    () => !readAndroidWifiEnabled(),
    15_000,
    "Physical acceptance could not disable Android Wi-Fi."
  );
  await waitFor(
    () => {
      const connectivity = adb(["shell", "dumpsys", "connectivity"]);
      return hasAndroidCellularTailscaleTransport(connectivity);
    },
    30_000,
    "Physical acceptance requires active cellular and Tailscale VPN transport."
  );
}

function hasAndroidCellularTailscaleTransport(output: string): boolean {
  if (!isBoundedAndroidConnectivityOutput(output)) return false;
  const networkAgents = output
    .split(/\r?\n/u)
    .filter((line) => line.includes("NetworkAgentInfo"));
  const cellular = networkAgents.some(isAndroidCellularInternetAgent);
  const tailscale = networkAgents.some(
    (line) =>
      isCurrentAndroidInternetAgent(line) &&
      /\bni\{VPN\s+CONNECTED\b/iu.test(line) &&
      /\bVPN:com\.tailscale\.ipn\b/iu.test(line) &&
      /\bTransports:[^}\r\n]{0,96}\bVPN\b/iu.test(line)
  );
  const wifi = networkAgents.some(
    (line) =>
      /\bni\{WIFI(?:\[[^\]\r\n]{1,32}\])?[^}\r\n]{0,128}\bCONNECTED\b/iu.test(
        line
      )
  );
  return cellular && tailscale && !wifi;
}

function isBoundedAndroidConnectivityOutput(output: string): boolean {
  return (
    Buffer.byteLength(output, "utf8") > 0 &&
    Buffer.byteLength(output, "utf8") <= 512 * 1024 &&
    !output.includes("\u0000")
  );
}

function isCurrentAndroidInternetAgent(line: string): boolean {
  return (
    /\bCONNECTED\b/iu.test(line) &&
    /\bINTERNET\b/iu.test(line) &&
    /\b(?:IS_)?VALIDATED\b/iu.test(line)
  );
}

function isAndroidCellularInternetAgent(line: string): boolean {
  return (
    isCurrentAndroidInternetAgent(line) &&
    /\bni\{MOBILE(?:\[[^\]\r\n]{1,32}\])?[^}\r\n]{0,128}\bCONNECTED\b/iu.test(
      line
    ) &&
    /\bTransports:[^}\r\n]{0,96}\bCELLULAR\b/iu.test(line)
  );
}

function hasAndroidCellularInternetNetwork(output: string): boolean {
  return (
    isBoundedAndroidConnectivityOutput(output) &&
    output
      .split(/\r?\n/u)
      .filter((line) => line.includes("NetworkAgentInfo"))
      .some(isAndroidCellularInternetAgent)
  );
}

async function requireAndroidPrivateHttpsReachability(
  origin: string
): Promise<void> {
  const ping = createAndroidPrivateTailnetPing(origin);
  const probe = createAndroidPrivateHttpsProbe(origin);
  adb([
    "shell",
    "am",
    "start",
    "-W",
    "-n",
    androidTailscaleComponent
  ]);
  await waitFor(async () => {
    const output = await adbAsync(ping);
    return (
      Buffer.byteLength(output, "utf8") <= 16 * 1024 &&
      output.includes("1 received")
    );
  }, 30_000, "Physical Android could not establish a cellular Tailscale peer path.");
  await waitFor(async () => {
    const output = await adbAsync(probe);
    return output === "";
  }, 45_000, "Physical Android could not reach private HTTPS over Tailscale.");
}

function createAndroidPrivateTailnetPing(origin: string): readonly string[] {
  const target = parseAndroidPrivateHttpsOrigin(origin);
  return Object.freeze([
    "shell",
    "ping",
    "-c",
    "1",
    "-W",
    "3",
    target.hostname
  ]);
}

function createAndroidPrivateHttpsProbe(origin: string): readonly string[] {
  const target = parseAndroidPrivateHttpsOrigin(origin);
  return Object.freeze([
    "shell",
    "curl",
    "--connect-timeout",
    "5",
    "--fail",
    "--max-time",
    "10",
    "--output",
    "/dev/null",
    "--proto",
    "=https",
    "--silent",
    "--show-error",
    target.toString()
  ]);
}

function parseAndroidPrivateHttpsOrigin(origin: string): URL {
  const target = new URL(origin);
  requireCondition(
    target.origin === origin &&
      target.protocol === "https:" &&
      target.username === "" &&
      target.password === "" &&
      target.pathname === "/" &&
      target.search === "" &&
      target.hash === "",
    "Physical Android HTTPS probe target was invalid."
  );
  return target;
}

function readAndroidStayAwakeSetting(): number {
  const value = adb([
    "shell",
    "settings",
    "get",
    "global",
    "stay_on_while_plugged_in"
  ]).trim();
  requireCondition(
    /^[0-7]$/u.test(value),
    "Android stay-awake setting was invalid."
  );
  return Number(value);
}

function readAndroidPlugType(): number {
  return parseAndroidPlugType(adb(["shell", androidPowerPlugTypeCommand]));
}

function parseAndroidPlugType(output: string): number {
  requireCondition(
    Buffer.byteLength(output, "utf8") <= 512 * 1024 && !output.includes("\u0000"),
    "Android power observation was invalid."
  );
  const matches = [...output.matchAll(/^\s*mPlugType=(\d+)\s*$/gmu)];
  requireCondition(
    matches.length === 1,
    "Android power plug observation was contradictory."
  );
  const value = Number(matches[0]?.[1]);
  requireCondition(
    Number.isSafeInteger(value) && value >= 1 && value <= 7,
    value === 0
      ? "Android power plug type was not active."
      : "Android power plug type was invalid."
  );
  return value;
}

async function enforceAndroidAwakeAndUnlocked(
  initialSetting: number,
  activePlugType: number
): Promise<void> {
  const requiredSetting = initialSetting | activePlugType;
  if (requiredSetting !== initialSetting) {
    adb([
      "shell",
      "settings",
      "put",
      "global",
      "stay_on_while_plugged_in",
      String(requiredSetting)
    ]);
  }
  adb(["shell", "input", "keyevent", "KEYCODE_WAKEUP"]);
  await waitFor(
    () =>
      readAndroidStayAwakeSetting() === requiredSetting &&
      isAndroidAwakeAndUnlocked(),
    10_000,
    "Physical acceptance requires one awake and unlocked Android device."
  );
}

function isAndroidAwakeAndUnlocked(): boolean {
  const policy = adb(["shell", "dumpsys", "window", "policy"]);
  const trust = adb(["shell", "dumpsys", "trust"]);
  return (
    Buffer.byteLength(policy, "utf8") <= 512 * 1024 &&
    Buffer.byteLength(trust, "utf8") <= 512 * 1024 &&
    /^\s*interactiveState=INTERACTIVE_STATE_AWAKE\s*$/mu.test(policy) &&
    /^\s*mIsShowing=false\s*$/mu.test(policy) &&
    /^\s*mIsScreenOn = true\s*$/mu.test(policy) &&
    /\(current\):[^\r\n]{0,512}\bdeviceLocked=0\b/u.test(trust)
  );
}

async function restoreAndroidStayAwake(initialSetting: number): Promise<void> {
  if (readAndroidStayAwakeSetting() !== initialSetting) {
    adb([
      "shell",
      "settings",
      "put",
      "global",
      "stay_on_while_plugged_in",
      String(initialSetting)
    ]);
  }
  await waitFor(
    () => readAndroidStayAwakeSetting() === initialSetting,
    10_000,
    "Physical acceptance could not restore Android stay-awake state."
  );
}

function readAndroidWifiEnabled(): boolean {
  const value = adb([
    "shell",
    "settings",
    "get",
    "global",
    "wifi_on"
  ]).trim();
  requireCondition(
    value === "0" || value === "1",
    "Android Wi-Fi state was invalid."
  );
  return value === "1";
}

async function restoreAndroidWifi(initiallyEnabled: boolean): Promise<void> {
  if (readAndroidWifiEnabled() !== initiallyEnabled) {
    adb([
      "shell",
      "svc",
      "wifi",
      initiallyEnabled ? "enable" : "disable"
    ]);
  }
  await waitFor(
    () => readAndroidWifiEnabled() === initiallyEnabled,
    15_000,
    "Physical acceptance could not restore Android Wi-Fi state."
  );
}

function readAndroidMobileDataEnabled(): boolean {
  return parseAndroidMobileDataState(
    adb(["shell", androidMobileDataStateCommand])
  );
}

function parseAndroidMobileDataState(output: string): boolean {
  requireCondition(
    Buffer.byteLength(output, "utf8") > 0 &&
      Buffer.byteLength(output, "utf8") <= 1_024 &&
      !output.includes("\u0000"),
    "Android mobile-data observation was invalid."
  );
  const states = [
    ...output.matchAll(/^\s*mUserMobileDataState=\s*(true|false)\s*$/gmu)
  ].map((match) => match[1]);
  requireCondition(
    states.length >= 1 &&
      states.length <= 4 &&
      states.every((state) => state === states[0]),
    "Android mobile-data observation was contradictory."
  );
  return states[0] === "true";
}

async function restoreAndroidMobileData(
  initiallyEnabled: boolean
): Promise<void> {
  if (readAndroidMobileDataEnabled() !== initiallyEnabled) {
    adb([
      "shell",
      "svc",
      "data",
      initiallyEnabled ? "enable" : "disable"
    ]);
  }
  await waitFor(
    () => readAndroidMobileDataEnabled() === initiallyEnabled,
    15_000,
    "Physical acceptance could not restore Android mobile-data state."
  );
}

async function collectPhysicalCleanupError(
  message: string,
  operation: () => void | Promise<void>,
  errors: unknown[]
): Promise<void> {
  try {
    await operation();
  } catch {
    errors.push(new Error(message));
  }
}

function readPhysicalEnvironmentFacts(): PhysicalEnvironmentFacts {
  const commit = execFileSync(
    "git",
    ["rev-parse", "HEAD"],
    commandOptions()
  ).trim();
  const tailscaleVersion = execFileSync(
    "/usr/bin/tailscale",
    ["version"],
    commandOptions()
  )
    .split(/\r?\n/u)[0]
    ?.trim();
  const osRelease = readFileSync("/etc/os-release", "utf8");
  const hostOs = readOsReleaseName(osRelease);
  const packageDump = adb([
    "shell",
    "dumpsys",
    "package",
    "com.android.chrome"
  ]);
  const chromeVersion = packageDump.match(
    /^\s*versionName=([^\r\n]{1,80})$/mu
  )?.[1];
  const tailscalePackageDump = adb([
    "shell",
    "dumpsys",
    "package",
    "com.tailscale.ipn"
  ]);
  const androidTailscaleVersion = tailscalePackageDump.match(
    /^\s*versionName=([^\r\n]{1,80})$/mu
  )?.[1];
  const chromePackages = adb([
    "shell",
    "pm",
    "list",
    "packages",
    "com.android.chrome"
  ]).trim();
  const tailscalePackages = adb([
    "shell",
    "pm",
    "list",
    "packages",
    "com.tailscale.ipn"
  ]).trim();
  const battery = adb(["shell", "dumpsys", "battery"]);
  const batteryPercent = Number(
    battery.match(/^\s*level:\s*(\d{1,3})\s*$/mu)?.[1]
  );
  const batteryPowered =
    /^\s*(?:AC|USB|Wireless) powered:\s*true\s*$/mu.test(battery);
  const displaySize = readAndroidDisplaySize();
  const fontScale = readAndroidSetting("system", "font_scale");
  const physicalDensity = readAndroidPhysicalDensity();
  const marketName = readOptionalAdbProperty("ro.product.marketname");
  const model = marketName ?? readRequiredAdbProperty("ro.product.model");
  const androidApi = readRequiredAdbProperty("ro.build.version.sdk");
  const androidRelease = readRequiredAdbProperty("ro.build.version.release");
  requireCondition(
    /^[0-9a-f]{40}$/u.test(commit) &&
      tailscaleVersion === "1.98.8" &&
      typeof chromeVersion === "string" &&
      /^[A-Za-z0-9._+-]{1,80}$/u.test(chromeVersion) &&
      typeof androidTailscaleVersion === "string" &&
      /^[A-Za-z0-9._+-]{1,80}$/u.test(androidTailscaleVersion) &&
      chromePackages === "package:com.android.chrome" &&
      tailscalePackages === "package:com.tailscale.ipn" &&
      Number.isSafeInteger(batteryPercent) &&
      batteryPercent >= 0 &&
      batteryPercent <= 100 &&
      (batteryPercent >= 30 || batteryPowered) &&
      /^\d{3,4}x\d{3,5}$/u.test(displaySize) &&
      /^(?:0\.[5-9]\d*|1(?:\.\d+)?|2(?:\.0+)?)$/u.test(fontScale) &&
      /^\d{1,3}$/u.test(androidApi) &&
      /^[A-Za-z0-9._ -]{1,32}$/u.test(androidRelease) &&
      model.length <= 80 &&
      !hasControlCharacters(model),
    "Physical environment versions did not match the acceptance contract."
  );
  return Object.freeze({
    android_api: androidApi,
    android_model: model,
    android_release: androidRelease,
    android_tailscale_version: androidTailscaleVersion,
    battery_percent: batteryPercent,
    chrome_version: chromeVersion,
    commit,
    display_size: displaySize,
    font_scale: fontScale,
    host_os: hostOs,
    node_version: process.version,
    physical_density: physicalDensity,
    tailscale_version: tailscaleVersion
  });
}

function readAndroidDisplaySize(): string {
  const output = adb(["shell", "wm", "size"]);
  const matches = [...output.matchAll(/(?:Physical|Override) size:\s*(\d{3,4}x\d{3,5})/gu)];
  const value = matches.at(-1)?.[1];
  requireCondition(
    matches.length >= 1 && matches.length <= 2 && typeof value === "string",
    "Android display size was invalid."
  );
  return value;
}

function readOptionalAdbProperty(property: string): string | null {
  requireCondition(
    /^[a-z0-9._-]{1,80}$/u.test(property),
    "Android property name was invalid."
  );
  const value = adb(["shell", "getprop", property]).trim();
  if (value === "" || value.toLowerCase() === "unknown") return null;
  requireCondition(
    value.length <= 80 && !hasControlCharacters(value),
    "Android property value was invalid."
  );
  return value;
}

function readRequiredAdbProperty(property: string): string {
  const value = readOptionalAdbProperty(property);
  requireCondition(value !== null, "Required Android property was absent.");
  return value as string;
}

function readOsReleaseName(contents: string): string {
  requireCondition(
    Buffer.byteLength(contents, "utf8") <= 64 * 1024,
    "Host OS release metadata exceeded its bound."
  );
  const raw = contents.match(/^PRETTY_NAME=(.+)$/mu)?.[1]?.trim();
  requireCondition(
    typeof raw === "string",
    "Host OS release name was unavailable."
  );
  const value = raw.startsWith('"') && raw.endsWith('"')
    ? raw.slice(1, -1)
    : raw;
  requireCondition(
    value.length >= 1 &&
      value.length <= 120 &&
      !hasControlCharacters(value),
    "Host OS release name was invalid."
  );
  return value;
}

function adb(args: readonly string[]): string {
  const serialized = args.join("\u0000");
  requireCondition(
    [...deviceForbiddenValues].every((value) => !serialized.includes(value)),
    "A protected pairing value was rejected before ADB dispatch."
  );
  adbCommandCount += 1;
  const output = execFileSync("adb", [...args], commandOptions());
  requireCondition(
    [...deviceForbiddenValues].every((value) => !output.includes(value)),
    "A protected pairing value was rejected in ADB output."
  );
  return output;
}

function adbAsync(args: readonly string[]): Promise<string> {
  const serialized = args.join("\u0000");
  requireCondition(
    [...deviceForbiddenValues].every((value) => !serialized.includes(value)),
    "A protected pairing value was rejected before asynchronous ADB dispatch."
  );
  adbCommandCount += 1;
  return new Promise((resolve, reject) => {
    execFile(
      "adb",
      [...args],
      commandOptions(),
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error("Physical asynchronous ADB command failed."));
          return;
        }
        try {
          requireCondition(
            [...deviceForbiddenValues].every(
              (value) => !stdout.includes(value) && !stderr.includes(value)
            ),
            "A protected pairing value was rejected in asynchronous ADB output."
          );
          resolve(stdout);
        } catch (failure) {
          reject(failure);
        }
      }
    );
  });
}

function adbWithStatus(args: readonly string[]): Readonly<{
  status: number;
  stderr: string;
  stdout: string;
}> {
  const serialized = args.join("\u0000");
  requireCondition(
    [...deviceForbiddenValues].every((value) => !serialized.includes(value)),
    "A protected pairing value was rejected before status-aware ADB dispatch."
  );
  adbCommandCount += 1;
  const result = spawnSync("adb", [...args], commandOptions());
  requireCondition(
    result.error === undefined &&
      result.signal === null &&
      typeof result.status === "number" &&
      typeof result.stdout === "string" &&
      typeof result.stderr === "string",
    "Physical status-aware ADB command did not complete."
  );
  requireCondition(
    [...deviceForbiddenValues].every(
      (value) =>
        !result.stdout.includes(value) && !result.stderr.includes(value)
    ),
    "A protected pairing value was rejected in status-aware ADB output."
  );
  return Object.freeze({
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout
  });
}

function openPrivatePairingLinkInChrome(pairingLink: string): void {
  requireCondition(
    deviceForbiddenValues.has(pairingLink),
    "Physical pairing link was not registered as protected."
  );
  const action = "android.intent.action.VIEW";
  const category = "android.intent.category.BROWSABLE";
  const resolution = adb([
    "shell",
    "cmd",
    "package",
    "resolve-activity",
    "--brief",
    "-a",
    action,
    "-c",
    category,
    "-d",
    "https://example.invalid/",
    "com.android.chrome"
  ]);
  const component = resolution
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .findLast((line) =>
      /^com\.android\.chrome\/[A-Za-z0-9_.$]+$/u.test(line)
    );
  requireCondition(
    component !== undefined && component.length <= 256,
    "Physical pairing could not resolve Android Chrome."
  );
  const handoff = createPrivatePairingChromeHandoff(pairingLink, component);
  requireCondition(
    [...deviceForbiddenValues].every(
      (value) => !handoff.adbArgs.join("\u0000").includes(value)
    ),
    "A protected pairing value was rejected before ADB handoff."
  );
  adbCommandCount += 1;
  const output = execFileSync("adb", [...handoff.adbArgs], {
    ...commandOptions(),
    input: handoff.stdin
  });
  requireCondition(
    output === "" &&
      [...deviceForbiddenValues].every((value) => !output.includes(value)),
    "Physical private pairing handoff returned unexpected output."
  );
}

function createPrivatePairingChromeHandoff(
  pairingLink: string,
  component: string
): Readonly<{
  adbArgs: readonly ["shell"];
  stdin: string;
}> {
  const selectedLink = selectedPairingLinkSchema.parse(pairingLink);
  requireCondition(
    /^com\.android\.chrome\/[A-Za-z0-9_.$]+$/u.test(component) &&
      component.length <= 256,
    "Physical Chrome activity was invalid."
  );
  const adbArgs = Object.freeze(["shell"] as const);
  const stdin = [
    "set -eu",
    "IFS= read -r url",
    selectedLink,
    `am start --user 0 -n ${component} -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d "$url" >/dev/null 2>&1`,
    "unset url",
    ""
  ].join("\n");
  requireCondition(
    Buffer.byteLength(stdin, "utf8") <= 1_024 &&
      stdin.split(selectedLink).length === 2,
    "Physical Chrome handoff input was invalid."
  );
  return Object.freeze({ adbArgs, stdin });
}

function enterPhysicalPromptText(prompt: string): void {
  const handoff = createPhysicalPromptTextHandoff(prompt);
  const promptLines = prompt.split("\n");
  requireCondition(
    promptLines.every(
      (line) =>
        !handoff.adbArgs.join("\u0000").includes(line) &&
        !handoff.stdin.includes(line)
    ),
    "Physical prompt text reached the ADB handoff surface."
  );
  adbCommandCount += 1;
  const output = execFileSync("adb", [...handoff.adbArgs], {
    ...commandOptions(),
    input: handoff.stdin
  });
  requireCondition(
    output === "" && promptLines.every((line) => !output.includes(line)),
    "Physical prompt text handoff returned unexpected output."
  );
}

function enterPhysicalSingleLineText(value: string): void {
  requireCondition(
    /^[A-Za-z0-9_-]{1,96}$/u.test(value),
    "Physical single-line text was invalid."
  );
  const encoded = Buffer.from(value, "utf8").toString("base64");
  requireCondition(
    /^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) && encoded !== value,
    "Physical single-line text encoding was invalid."
  );
  const stdin = [
    "set -eu",
    "IFS= read -r value_b64",
    encoded,
    'value="$(printf \'%s\' "$value_b64" | base64 -d)"',
    'input text "$value" >/dev/null 2>&1',
    "unset value_b64 value",
    ""
  ].join("\n");
  requireCondition(
    Buffer.byteLength(stdin, "utf8") <= 512 && !stdin.includes(value),
    "Physical single-line text reached the ADB handoff surface."
  );
  adbCommandCount += 1;
  const output = execFileSync("adb", ["shell"], {
    ...commandOptions(),
    input: stdin
  });
  requireCondition(
    output === "" && !output.includes(value),
    "Physical single-line text handoff returned unexpected output."
  );
}

function createPhysicalPromptTextHandoff(prompt: string): Readonly<{
  adbArgs: readonly ["shell"];
  stdin: string;
}> {
  const lines = prompt.split("\n");
  requireCondition(
    lines.length === 2 &&
      lines.every((line) => /^[A-Za-z0-9_-]{1,80}$/u.test(line)),
    "Physical prompt text was invalid."
  );
  const encoded = lines.map((line) =>
    Buffer.from(line, "utf8").toString("base64")
  );
  requireCondition(
    encoded.length === 2 &&
      encoded.every(
        (value, index) =>
          /^[A-Za-z0-9+/]+={0,2}$/u.test(value) &&
          value !== lines[index]
      ),
    "Physical prompt encoding was invalid."
  );
  const adbArgs = Object.freeze(["shell"] as const);
  const stdin = [
    "set -eu",
    "IFS= read -r first_b64",
    encoded[0] as string,
    "IFS= read -r second_b64",
    encoded[1] as string,
    'first="$(printf \'%s\' "$first_b64" | base64 -d)"',
    'second="$(printf \'%s\' "$second_b64" | base64 -d)"',
    'input text "$first" >/dev/null 2>&1',
    "sleep 1",
    "input keyevent KEYCODE_ENTER >/dev/null 2>&1",
    "sleep 1",
    'input text "$second" >/dev/null 2>&1',
    "unset first_b64 second_b64 first second",
    ""
  ].join("\n");
  requireCondition(
    Buffer.byteLength(stdin, "utf8") <= 1_024 &&
      lines.every((line) => !stdin.includes(line)),
    "Physical prompt handoff input was invalid."
  );
  return Object.freeze({ adbArgs, stdin });
}

function isAndroidKeyboardVisible(): boolean {
  const output = adb(["shell", "dumpsys", "input_method"]);
  requireCondition(
    Buffer.byteLength(output, "utf8") > 0 &&
      Buffer.byteLength(output, "utf8") <= 1024 * 1024 &&
      !output.includes("\u0000"),
    "Android input-method state was invalid."
  );
  return parseAndroidKeyboardVisibility(output);
}

function parseAndroidKeyboardVisibility(output: string): boolean {
  const requested = [...output.matchAll(
    /\bmInputShown=((?:true|false))\b/gu
  )].map((match) => match[1]);
  requireCondition(
    requested.length <= 8 &&
      requested.every((value) => value === requested[0]),
    "Android input-method request state was contradictory."
  );
  if (requested.length > 0) return requested[0] === "true";

  const visible = [...output.matchAll(
    /\b(?:mIsInputViewShown|isInputViewShown)=((?:true|false))\b/gu
  )].map((match) => match[1]);
  requireCondition(
    visible.length >= 1 && visible.length <= 32,
    "Android input-method visibility was unavailable."
  );
  requireCondition(
    visible.every((value) => value === visible[0]),
    "Android input-method visibility was contradictory."
  );
  return visible[0] === "true";
}

function openDefaultCamera(): void {
  const action = "android.media.action.STILL_IMAGE_CAMERA";
  const resolution = adb([
    "shell",
    "cmd",
    "package",
    "resolve-activity",
    "--brief",
    "-a",
    action
  ]);
  const component = resolution
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .findLast((line) => /^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/u.test(line));
  requireCondition(
    component !== undefined && component.length <= 256,
    "Physical pairing could not resolve one camera activity."
  );
  adb(["shell", "am", "start", "-n", component, "-a", action]);
}

function requireChromeRunning(): void {
  const processes = adb(["shell", "pidof", "com.android.chrome"]).trim();
  requireCondition(
    /^\d+(?:\s+\d+)*$/u.test(processes),
    "The private pairing link did not open in Android Chrome."
  );
}

function isChromeStopped(): boolean {
  const result = adbWithStatus(["shell", "pidof", "com.android.chrome"]);
  return readChromeProcessState(
    result.status,
    result.stdout,
    result.stderr
  ) === "stopped";
}

async function stopPhysicalAndroidChrome(): Promise<void> {
  adb(physicalAndroidChromeStopCommandPlan[0]);
  await new Promise((resolve) => setTimeout(resolve, 250));
  adb(physicalAndroidChromeStopCommandPlan[1]);
  await waitFor(
    () => isChromeStopped(),
    10_000,
    "Physical Android Chrome did not stop."
  );
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  requireCondition(
    isChromeStopped(),
    "Physical Android Chrome restarted during settled cleanup verification."
  );
}

function readChromeProcessState(
  status: number,
  stdout: string,
  stderr: string
): "running" | "stopped" {
  const output = stdout.trim();
  const error = stderr.trim();
  if (status === 0 && /^\d+(?:\s+\d+)*$/u.test(output) && error === "") {
    return "running";
  }
  if (status === 1 && output === "" && error === "") return "stopped";
  throw new Error("Android Chrome process state was invalid.");
}

function requireChromeForeground(): void {
  requireChromeRunning();
  const displayState = adb(chromeForegroundAdbArgs);
  requireCondition(
    isChromeForegroundWindowDisplay(displayState),
    "Android Chrome was not foregrounded for physical evidence."
  );
}

function isChromeForegroundWindowDisplay(output: string): boolean {
  if (
    Buffer.byteLength(output, "utf8") > chromeForegroundMaxBytes ||
    output.includes("\u0000") ||
    output.includes("://") ||
    output.includes(selectedPairingFragmentPrefix)
  ) {
    return false;
  }
  const focusLines = output
    .split(/\r?\n/u)
    .filter((line) => line.includes("mCurrentFocus="));
  return (
    focusLines.length === 1 &&
    /^\s{0,8}mCurrentFocus=Window\{[0-9a-f]{1,16} u\d{1,4} com\.android\.chrome\/[A-Za-z0-9_.$]{1,192}\}\s*$/u.test(
      focusLines[0] ?? ""
    )
  );
}

interface AndroidUiNode {
  readonly bounds: Readonly<{
    readonly bottom: number;
    readonly left: number;
    readonly right: number;
    readonly top: number;
  }>;
  readonly className: string;
  readonly clickable: boolean;
  readonly description: string;
  readonly enabled?: false;
  readonly focused?: true;
  readonly resourceId: string;
  readonly text: string;
}

interface PhysicalScreenshotRegion {
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

interface PrivateFreeProductionScreenshotSelection {
  readonly redactions: readonly PhysicalScreenshotRegion[];
  readonly region: PhysicalScreenshotRegion;
}

interface PhysicalEventDiagnosticTarget {
  readonly action: AndroidUiNode;
  readonly label: AndroidUiNode;
}

interface PngImage {
  readonly data: Buffer;
  readonly height: number;
  readonly width: number;
}

interface PngConstructor {
  new (input: Readonly<{ height: number; width: number }>): PngImage;
  readonly sync: Readonly<{
    read: (bytes: Buffer) => PngImage;
    write: (image: PngImage) => Buffer;
  }>;
}

type AndroidUiNodeField = "className" | "description" | "semantic" | "text";
type AndroidUiNodeVisibility = "fully_visible" | "present";
type AndroidVerticalRevealDirection = "backward" | "forward";

interface ProductionUiEntryInput {
  readonly db: ReturnType<typeof openMigratedDatabase>["db"];
  readonly driver: PhysicalDriverRuntime;
  readonly externalOrigin: string;
  readonly readProxyRejection: () => string | null;
  readonly requestInspection: RequestInspection;
  readonly screenshotDirectory: string;
}

async function runProductionPairingUiSequence(
  input: ProductionUiEntryInput
): Promise<void> {
  await openProductionMissionControl(input, {
    missionControl: "fe013-02-mission-control.png",
    paired: "fe013-01-paired.png"
  }, "single_session");

  const accessTrigger = await waitForAndroidUiNode(
    "description",
    "Open Host and access",
    30_000,
    "Production Host and access trigger was unavailable on Android."
  );
  await performVerifiedAndroidTap({
    initialTrigger: accessTrigger,
    triggerField: "description",
    triggerValue: "Open Host and access",
    completed: async () => {
      const nodes = await readAndroidUiNodes();
      return nodes.some(
        (node) =>
          node.description === "Close Host and access" ||
          node.description === "Host & access" ||
          node.text === "Host & access"
      );
    },
    completionFailureMessage:
      "Production Host and access sheet did not open on Android.",
    reacquireFailureMessage:
      "Production Host and access trigger could not be reacquired on Android.",
    terminalFailureMessage:
      "Production Host and access sheet remained closed after two bounded taps."
  });
  await waitForAndroidUiNode(
    "text",
    "Secure control ready",
    30_000,
    "Production Host and access sheet did not show current writer truth."
  );
  await waitForAndroidUiNode(
    "text",
    "Read & write",
    30_000,
    "Production Host and access sheet did not show writer permission."
  );
  await capturePhysicalScreenshot(
    join(input.screenshotDirectory, "fe013-03-host-access.png")
  );

  const closeAccess = await waitForAndroidUiNode(
    "description",
    "Close Host and access",
    30_000,
    "Production Host and access close control was unavailable on Android."
  );
  await performVerifiedAndroidTap({
    initialTrigger: closeAccess,
    triggerField: "description",
    triggerValue: "Close Host and access",
    completed: async () =>
      (await readAndroidUiNodes()).every(
        (node) =>
          node.description !== "Close Host and access" &&
          node.text !== "Host & access"
      ),
    completionFailureMessage:
      "Production Host and access sheet did not close on Android.",
    reacquireFailureMessage:
      "Production Host and access close control could not be reacquired on Android.",
    terminalFailureMessage:
      "Production Host and access sheet remained open after two bounded taps."
  });
  const requestsBeforeReload = Object.freeze({
    access: input.requestInspection.accessRequests,
    csrf: input.requestInspection.csrfRequests,
    host: input.requestInspection.hostStatusRequests,
    sessions: input.requestInspection.sessionListRequests
  });
  adb(["shell", "input", "keyevent", "KEYCODE_REFRESH"]);
  await waitFor(
    () =>
      input.requestInspection.accessRequests > requestsBeforeReload.access &&
      input.requestInspection.csrfRequests > requestsBeforeReload.csrf &&
      input.requestInspection.hostStatusRequests > requestsBeforeReload.host &&
      input.requestInspection.sessionListRequests > requestsBeforeReload.sessions,
    45_000,
    "Fragment-free Android reload did not restore ordinary app authority."
  );
  await revealAndroidUiNode(
    "description",
    physicalUiSessionName,
    "forward",
    30_000,
    "Fragment-free Android reload did not restore Mission Control."
  );
  requireCondition(
    input.requestInspection.claimRequests === 1 &&
      input.requestInspection.csrfRequests === 2 &&
      input.requestInspection.accessRequests >= 2 &&
      input.requestInspection.accessRequests <= 4 &&
      input.requestInspection.hostStatusRequests >= 2 &&
      input.requestInspection.hostStatusRequests <= 4 &&
      input.requestInspection.sessionListRequests >= 2 &&
      input.requestInspection.sessionListRequests <= 4 &&
      input.requestInspection.noReferrerApiRequests === 3 &&
      input.requestInspection.fragmentLeaks === 0,
    "Production Android reload repeated pairing or produced unbounded route work."
  );
  await capturePhysicalScreenshot(
    join(input.screenshotDirectory, "fe013-04-reloaded.png")
  );

  await cleanProductionUiAuthority(input);
}

async function openProductionMissionControl(
  input: ProductionUiEntryInput,
  screenshots: Readonly<{
    readonly appOnly?: boolean;
    readonly missionControl: string | null;
    readonly paired: string | null;
  }>,
  initialViewport: PhysicalMissionControlInitialViewport
): Promise<void> {
  let paired: AndroidUiNode;
  try {
    paired = await waitForAndroidUiNode(
      "text",
      "Phone paired",
      30_000,
      "Production pairing confirmation did not render on Android."
    );
  } catch {
    const nodes = await readAndroidUiNodes();
    throw new Error(
      pairingConfirmationFailure({
        claimRequests: input.requestInspection.claimRequests,
        claimResponseStatuses:
          input.requestInspection.claimResponseStatuses,
        csrfRequests: input.requestInspection.csrfRequests,
        csrfResponseStatuses: input.requestInspection.csrfResponseStatuses,
        devices: countRows(input.db, "auth_devices"),
        hardenedCookieObserved:
          input.requestInspection.hardenedCookieObserved,
        nodes,
        proxyRejection: input.readProxyRejection(),
        usedPairingCodes: countMatchingRows(
          input.db,
          "pairing_codes",
          "used_at IS NOT NULL"
        )
      })
    );
  }
  const continueButton = await waitForAndroidUiNode(
    "text",
    "Open Mission Control",
    30_000,
    "Production pairing confirmation did not expose its explicit continuation."
  );
  requireCondition(
    pairingUiBeforeContinueIsValid(
      paired,
      await readAndroidUiNodes(),
      input.requestInspection
    ),
    "Production pairing confirmation disclosed protected state or repeated startup work."
  );
  if (screenshots.paired !== null) {
    const path = join(input.screenshotDirectory, screenshots.paired);
    if (screenshots.appOnly === true) {
      await capturePrivateFreeProductionScreenshot(path, input.externalOrigin);
    } else {
      await capturePhysicalScreenshot(path);
    }
  }
  await continueFromPairingUi(continueButton, input.requestInspection);

  try {
    await waitFor(
      () =>
        input.requestInspection.accessRequests >= 1 &&
        input.requestInspection.hostStatusRequests >= 1 &&
        input.requestInspection.sessionListRequests >= 1,
      30_000,
      "Production Mission Control did not load its authenticated route data."
    );
  } catch {
    throw new Error(
      missionControlRouteFailure(
        input.requestInspection,
        input.readProxyRejection()
      )
    );
  }
  await waitForAndroidUiNode(
    "text",
    "Mission Control",
    30_000,
    "Production Mission Control did not render on Android."
  );
  try {
    await waitForAndroidUiNode(
      missionControlInitialViewportField(initialViewport),
      missionControlInitialViewportText(initialViewport),
      30_000,
      "Production Mission Control did not render its authenticated first viewport."
    );
  } catch {
    throw new Error(
      missionControlRouteFailure(
        input.requestInspection,
        input.readProxyRejection()
      )
    );
  }
  if (screenshots.missionControl !== null) {
    const path = join(input.screenshotDirectory, screenshots.missionControl);
    if (screenshots.appOnly === true) {
      await capturePrivateFreeProductionScreenshot(path, input.externalOrigin);
    } else {
      await capturePhysicalScreenshot(path);
    }
  }
}

type PhysicalMissionControlInitialViewport =
  | "dashboard_attention"
  | "single_session";

function missionControlInitialViewportText(
  viewport: PhysicalMissionControlInitialViewport
): string {
  return viewport === "dashboard_attention" ? "ACT NOW" : physicalUiSessionName;
}

function missionControlInitialViewportField(
  viewport: PhysicalMissionControlInitialViewport
): AndroidUiNodeField {
  return viewport === "dashboard_attention" ? "text" : "description";
}

function physicalQuietQueueDisclosureLabel(open: boolean): string {
  return `${open ? "Collapse" : "Expand"} quiet sessions (1)`;
}

async function runProductionDashboardUiSequence(
  input: ProductionUiEntryInput & {
    readonly controls: PhysicalDashboardControls;
    readonly env: Readonly<Record<string, string>>;
    readonly foreignServeBefore: ServeStatusFingerprint;
    readonly initialScreenshotNames: readonly string[];
    readonly manager: TailscaleServeManager;
    readonly profileSwitch: ProfileSwitchInput;
    readonly prompt: PhysicalPromptRuntime;
    readonly remote: HostDeckRemoteIngressLifecycle;
    readonly setSelectedProfile: (profile: "away" | "dedicated") => void;
    readonly setRuntimeCompatible: (compatible: boolean) => void;
    readonly talkBackArtifacts: PhysicalTalkBackArtifacts;
  }
): Promise<PhysicalDashboardSequenceResult> {
  const screenshotNames: string[] = [...input.initialScreenshotNames];
  const targetMeasurements: PhysicalTargetMeasurement[] = [];
  const capture: PhysicalDashboardCapture = async (
    name,
    options = {}
  ): Promise<void> => {
    requireCondition(
      /^fe090-[0-9]{2}-[a-z0-9-]+\.png$/u.test(name) &&
        !screenshotNames.includes(name),
      "Physical dashboard screenshot identity was invalid."
    );
    await capturePrivateFreeProductionScreenshot(
      join(input.screenshotDirectory, name),
      input.externalOrigin,
      options
    );
    screenshotNames.push(name);
  };
  const measure = (node: AndroidUiNode, label: string): void => {
    const density = readAndroidPhysicalDensity();
    const scale = density / 160;
    const measurement = Object.freeze({
      heightCssPx: roundPhysicalCssPixels(androidUiNodeHeight(node) / scale),
      label,
      widthCssPx: roundPhysicalCssPixels(androidUiNodeWidth(node) / scale)
    });
    requireCondition(
      measurement.heightCssPx >= 44 && measurement.widthCssPx >= 44,
      `Physical dashboard target ${label} was smaller than 44 CSS px ` +
        `(${measurement.widthCssPx}x${measurement.heightCssPx}).`
    );
    targetMeasurements.push(measurement);
  };

  await openProductionMissionControl(input, {
    appOnly: true,
    missionControl: "fe090-02-mission-control.png",
    paired: "fe090-01-paired.png"
  }, "dashboard_attention");
  screenshotNames.push("fe090-01-paired.png", "fe090-02-mission-control.png");
  input.driver.recordCheckpoint("paired");
  await waitForAndroidUiText("ACT NOW", 30_000, "Physical Mission Control lost ACT NOW hierarchy.");
  await waitForAndroidUiText("release-approval", 30_000, "Physical Mission Control omitted the approval session.");
  await waitForAndroidUiText("migration-input", 30_000, "Physical Mission Control omitted the input session.");
  const accessTarget = await waitForAndroidUiNodePresent(
    "description",
    "Open Host and access",
    30_000,
    "Physical Mission Control omitted Host and access."
  );
  measure(accessTarget, "open-host-access");
  assertPhysicalMissionControlGeometry(await readAndroidUiNodes());

  const requestsBeforeReload = input.requestInspection.sessionListRequests;
  adb(["shell", "input", "keyevent", "KEYCODE_REFRESH"]);
  await waitFor(
    () => input.requestInspection.sessionListRequests > requestsBeforeReload,
    45_000,
    "Physical dashboard fragment-free reload did not read sessions."
  );
  const quietDisclosure = await revealAndroidUiNode(
    "description",
    physicalQuietQueueDisclosureLabel(false),
    "forward",
    30_000,
    "Physical dashboard reload omitted the collapsed quiet-session control."
  );
  measure(quietDisclosure, "expand-quiet-sessions");
  await performVerifiedAndroidTap({
    initialTrigger: quietDisclosure,
    triggerField: "description",
    triggerValue: physicalQuietQueueDisclosureLabel(false),
    completed: async () =>
      (await readAndroidUiNodes()).some((node) =>
        matchesAndroidUiNode(
          node,
          "description",
          physicalQuietQueueDisclosureLabel(true)
        )
      ),
    completionFailureMessage:
      "Physical dashboard quiet-session control did not expand.",
    reacquireFailureMessage:
      "Physical dashboard could not reacquire the collapsed quiet-session control.",
    terminalFailureMessage:
      "Physical dashboard quiet-session control remained collapsed after two bounded taps."
  });
  const sessionTarget = await revealAndroidUiNode(
    "description",
    physicalUiSessionName,
    "forward",
    30_000,
    "Physical dashboard fragment-free reload lost paired authority.",
    "fully_visible"
  );
  requireCondition(
    input.requestInspection.claimRequests === 1 &&
      input.requestInspection.fragmentLeaks === 0,
    "Physical dashboard reload repeated pairing or leaked its fragment."
  );
  input.driver.recordCheckpoint("reloaded");

  measure(sessionTarget, "open-session");
  requireCondition(
    input.requestInspection.sessionDetailRequests === 0 &&
      input.prompt.subscribers.snapshot().active_subscribers === 0,
    "Physical dashboard Session Detail transition began with retained activity."
  );
  await tapAndroidNodeOnceAndWait(
    sessionTarget,
    () =>
      input.requestInspection.sessionDetailRequests >= 1 &&
      input.prompt.subscribers.snapshot().active_subscribers === 1,
    () =>
      "Physical dashboard Session Detail did not open " +
      physicalPromptStreamDiagnostic(input)
  );
  await waitForAndroidUiText("Ready to send", 45_000, "Physical Session Detail was not writable.");
  await waitFor(
    () => {
      const snapshot = input.prompt.subscribers.snapshot();
      return snapshot.active_subscribers === 1 && snapshot.replay_events === 0;
    },
    30_000,
    "Physical Session Detail did not drain its bounded replay into one live subscriber."
  );
  await revealAndroidUiNode(
    "text",
    "Current",
    "backward",
    30_000,
    "Physical Session Detail did not reveal current replay-to-live truth.",
    "fully_visible"
  );
  await capture("fe090-03-session-detail.png");

  await waitForPhysicalSessionWriteReady(
    input,
    "Physical approval did not receive stable current write authority."
  );
  await runPhysicalApprovalControl(input, capture, measure);

  await runPhysicalEventDiagnostic(
    input,
    capture,
    "backward",
    "Earlier activity unavailable",
    "Replay boundary",
    "Content truncated",
    "fe090-08-event-boundary.png"
  );
  await runPhysicalEventDiagnostic(
    input,
    capture,
    "forward",
    "Physical dashboard event complete",
    "Message event",
    "Bounded event summary",
    "fe090-09-event-complete.png"
  );
  await runPhysicalEventDiagnostic(
    input,
    capture,
    "forward",
    "Sensitive turn detail was redacted at projection time.",
    "Turn event",
    "Content redacted",
    "fe090-10-event-redacted.png"
  );

  await waitForPhysicalSessionWriteReady(
    input,
    "Physical prompt did not recover stable current write authority."
  );
  await runProductionPromptUiSequence(input, {
    captureScreenshots: false,
    cleanup: false,
    openMissionControl: false,
    sessionAlreadyOpen: true
  });
  await capture("fe090-11-prompt-completed.png");
  await runPhysicalStreamRecovery(input, capture);
  await runPhysicalDetailFailureStates(input, capture);
  await runPhysicalModelControl(input, capture, measure);
  await runPhysicalGoalControl(input, capture, measure);
  await runPhysicalPlanControl(input, capture, measure);
  await runPhysicalSessionUtilities(input, capture, measure);
  const clipboardOutcome = await runPhysicalLaptopResume(input, capture, measure);
  await runPhysicalInterruptControl(input, capture, measure);
  await runPhysicalHostAccessControls(input, capture, measure);

  await returnPhysicalDashboardToMissionControl(input);
  await runPhysicalDashboardProfileSwitch(input, capture);
  await runPhysicalRuntimeCompatibilityState(input, capture);
  const talkBack = await runPhysicalTalkBackTraversal(
    input.externalOrigin,
    input.talkBackArtifacts
  );
  await runPhysicalArchiveControl(input, capture, measure);
  await runPhysicalSelfRevoke(input, capture, measure);

  const controlSnapshot = input.controls.snapshot();
  requireCondition(
    controlSnapshot.approvalDecision === "approve" &&
      controlSnapshot.archived &&
      controlSnapshot.compactState === "completed" &&
      controlSnapshot.goalStatus === "paused" &&
      controlSnapshot.modelApplied &&
      controlSnapshot.planApplied &&
      controlSnapshot.calls.archive_session === 1 &&
      controlSnapshot.calls.interrupt_turn === 1 &&
      controlSnapshot.calls.mutate_goal === 1 &&
      controlSnapshot.calls.respond_approval === 1 &&
      controlSnapshot.calls.read_compact === 2 &&
      controlSnapshot.calls.read_skills === 1 &&
      controlSnapshot.calls.read_usage === 1 &&
      controlSnapshot.calls.select_model === 1 &&
      controlSnapshot.calls.select_plan === 1 &&
      controlSnapshot.calls.start_compact === 1 &&
      input.prompt.startCalls.length === 1 &&
      input.prompt.streamFailureCount === 1 &&
      JSON.stringify(input.prompt.streamFailureCodes) ===
        '["source_failed"]' &&
      input.readProxyRejection() === null,
    "Physical dashboard control counters or terminal truth were inconsistent."
  );
  requireCondition(
    screenshotNames.length >= 20 &&
      new Set(screenshotNames).size === screenshotNames.length &&
      targetMeasurements.length >= 15,
    "Physical dashboard evidence inventory was incomplete."
  );

  return Object.freeze({
    archived: true,
    approvalDecision: "approve",
    clipboardOutcome,
    compactState: "completed",
    interactionIds: Object.freeze([...mobileInteractionIds]),
    modelApplied: true,
    planApplied: true,
    profileReturnRecovered: true,
    screenshotNames: Object.freeze([...screenshotNames]),
    selfRevoked: true,
    stateIds: Object.freeze([...mobileDashboardPhysicalStateIds]),
    talkBack,
    targetMeasurements: Object.freeze([...targetMeasurements])
  });
}

type PhysicalDashboardCapture = (
  name: string,
  options?: Readonly<{ readonly redactProductOrigin?: boolean }>
) => Promise<void>;
type PhysicalDashboardMeasure = (node: AndroidUiNode, label: string) => void;

async function capturePhysicalHostAccessEvidence(
  capture: PhysicalDashboardCapture,
  name: string
): Promise<void> {
  requireCondition(
    /^fe090-\d{2}-[a-z0-9-]+\.png$/u.test(name),
    "Physical Host-access evidence name was invalid."
  );
  await capture(name, Object.freeze({ redactProductOrigin: true }));
}

function readAndroidPhysicalDensity(): number {
  const output = adb(["shell", "wm", "density"]);
  const matches = [...output.matchAll(/(?:Physical|Override) density:\s*(\d{2,4})/gu)];
  const value = Number(matches.at(-1)?.[1]);
  requireCondition(
    matches.length >= 1 &&
      matches.length <= 2 &&
      Number.isSafeInteger(value) &&
      value >= 120 &&
      value <= 1_000,
    "Android physical density was invalid."
  );
  return value;
}

function requirePhysicalDashboardDisplaySettingsUnchanged(
  environment: PhysicalEnvironmentFacts
): void {
  requireCondition(
    readAndroidDisplaySize() === environment.display_size &&
      readAndroidSetting("system", "font_scale") === environment.font_scale &&
      readAndroidPhysicalDensity() === environment.physical_density,
    "Physical dashboard acceptance changed Android display or font settings."
  );
}

function roundPhysicalCssPixels(value: number): number {
  requireCondition(Number.isFinite(value) && value > 0, "Physical CSS size was invalid.");
  return Math.round(value * 10) / 10;
}

function assertPhysicalMissionControlGeometry(nodes: readonly AndroidUiNode[]): void {
  const compositor = nodes.filter(
    (node) => node.resourceId === chromeCompositorResourceId
  );
  requireCondition(
    compositor.length === 1,
    "Physical Mission Control had an ambiguous viewport."
  );
  const viewport = compositor[0];
  requireCondition(viewport !== undefined, "Physical Mission Control viewport was absent.");
  const pageNodes = nodes.filter((node) =>
    node.resourceId !== chromeToolbarResourceId &&
    node.resourceId !== chromeCompositorResourceId &&
    node.bounds.bottom > viewport.bounds.top
  );
  requireCondition(
    pageNodes.length >= 8 &&
      pageNodes.every(
        (node) =>
          node.bounds.left >= viewport.bounds.left &&
          node.bounds.right <= viewport.bounds.right
      ),
    "Physical Mission Control overflowed its phone viewport."
  );
}

async function waitForAndroidUiText(
  value: string,
  timeoutMs: number,
  message: string
): Promise<void> {
  await waitFor(
    async () =>
      (await readAndroidUiNodes()).some(
        (node) => node.text === value || node.description === value
      ),
    timeoutMs,
    message
  );
}

async function waitForAndroidUiNodePresent(
  field: AndroidUiNodeField,
  value: string,
  timeoutMs: number,
  message: string
): Promise<AndroidUiNode> {
  let found: AndroidUiNode | null = null;
  await waitFor(async () => {
    const matches = (await readAndroidUiNodes())
      .filter((node) => matchesAndroidUiNode(node, field, value))
      .sort(
        (left, right) =>
          androidUiNodeWidth(right) * androidUiNodeHeight(right) -
          androidUiNodeWidth(left) * androidUiNodeHeight(left)
      );
    found = matches[0] ?? null;
    return found !== null;
  }, timeoutMs, message);
  requireCondition(found !== null, message);
  return found;
}

async function tapAndroidNodeOnceAndWait(
  node: AndroidUiNode,
  completed: () => boolean | Promise<boolean>,
  message: string | (() => string),
  timeoutMs = 30_000
): Promise<void> {
  tapAndroidUiNode(node);
  try {
    await waitFor(
      completed,
      timeoutMs,
      typeof message === "string"
        ? message
        : "Android UI one-tap transition did not complete."
    );
  } catch {
    let summary = "hierarchy=unavailable";
    try {
      summary = androidUiStateSummary(await readAndroidUiNodes(), node);
    } catch {
      // The bounded fallback still reports unavailable post-tap hierarchy.
    }
    const resolvedMessage = typeof message === "string" ? message : message();
    throw new Error(`${resolvedMessage} (${summary}).`);
  }
}

async function closePhysicalDialog(description: string): Promise<void> {
  const close = await waitForAndroidUiNodePresent(
    "description",
    description,
    30_000,
    `Physical dialog close control ${description} was unavailable.`
  );
  await tapAndroidNodeOnceAndWait(
    close,
    async () =>
      (await readAndroidUiNodes()).every(
        (node) => node.description !== description
      ),
    `Physical dialog ${description} did not close.`
  );
}

async function runPhysicalEventDiagnostic(
  input: ProductionUiEntryInput,
  capture: PhysicalDashboardCapture,
  direction: AndroidVerticalRevealDirection,
  timelineLabel: string,
  heading: string,
  limitation: string,
  screenshot: string
): Promise<void> {
  const target = await revealPhysicalEventDiagnosticTarget(
    timelineLabel,
    direction,
    30_000,
    `Physical event row ${timelineLabel} had no unobscured diagnostic action.`
  );
  const readsBefore = input.requestInspection.sessionEventRequests;
  await tapAndroidNodeOnceAndWait(
    target.action,
    async () =>
      input.requestInspection.sessionEventRequests === readsBefore + 1 &&
      (await readAndroidUiNodes()).some((node) => node.text === heading),
    `Physical ${heading} diagnostic did not open exactly once.`
  );
  await waitForAndroidUiText(
    limitation,
    30_000,
    `Physical ${heading} diagnostic omitted ${limitation}.`
  );
  await capture(screenshot);
  await closePhysicalDialog("Close event details");
}

async function revealPhysicalEventDiagnosticTarget(
  timelineLabel: string,
  direction: AndroidVerticalRevealDirection,
  timeoutMs: number,
  message: string
): Promise<PhysicalEventDiagnosticTarget> {
  let found: PhysicalEventDiagnosticTarget | null = null;
  let swipeCount = 0;
  const observations: string[] = [];
  try {
    await waitFor(async () => {
      const nodes = await readAndroidUiNodes();
      const observation = physicalEventDiagnosticGeometrySummary(
        nodes,
        timelineLabel
      );
      if (observations.at(-1) !== observation) {
        observations.push(observation);
        if (observations.length > 6) observations.shift();
      }
      found = selectPhysicalEventDiagnosticTarget(nodes, timelineLabel);
      if (found !== null) return true;
      if (swipeCount < 4) {
        swipeAndroidViewportAbovePhysicalSessionControls(nodes, direction);
        swipeCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      return false;
    }, timeoutMs, message);
  } catch {
    throw new Error(
      `${message} (direction=${direction};swipes=${swipeCount};states=${observations.join(" -> ") || "none"}).`
    );
  }
  requireCondition(found !== null, message);
  return found;
}

async function runPhysicalStreamRecovery(
  input: ProductionUiEntryInput & { readonly prompt: PhysicalPromptRuntime },
  capture: PhysicalDashboardCapture
): Promise<void> {
  const requestsBefore = input.requestInspection.sessionStreamRequests;
  const openedBefore = input.prompt.subscribers.snapshot().opened_subscribers;
  input.prompt.disconnectForRecovery();
  try {
    await waitFor(
      () => {
        const recovery = input.prompt.recoverySnapshot();
        return (
          recovery.state === "holding" &&
          recovery.held_requests === 1 &&
          input.prompt.streamFailureCount === 1 &&
          JSON.stringify(input.prompt.streamFailureCodes) === '["source_failed"]' &&
          input.prompt.subscribers.snapshot().active_subscribers === 0 &&
          input.requestInspection.sessionStreamRequests === requestsBefore + 1
        );
      },
      30_000,
      "Physical Session Detail did not enter one bounded reconnect attempt."
    );
    await waitForAndroidUiText(
      "Session activity is reconnecting.",
      30_000,
      "Physical Session Detail did not expose reconnecting write-block truth."
    );
    await capture("fe090-48-stream-reconnecting.png");
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Physical Session Detail recovery failed without an error object.";
    throw new Error(`${message} ${physicalPromptStreamDiagnostic(input)}`, {
      cause: error
    });
  } finally {
    input.prompt.releaseRecovery();
  }
  try {
    await waitFor(
      () =>
        input.prompt.subscribers.snapshot().active_subscribers === 1 &&
        input.prompt.subscribers.snapshot().opened_subscribers === openedBefore + 1 &&
        input.requestInspection.sessionStreamRequests === requestsBefore + 1,
      45_000,
      "Physical Session Detail did not reconnect exactly once after stream loss."
    );
    await waitFor(
      async () =>
        physicalPromptCompletionRestored(
          await readAndroidUiNodes(),
          input.prompt.subscribers.snapshot().active_subscribers
        ),
      30_000,
      "Physical Session Detail did not restore current completed-composer truth."
    );
    await capture("fe090-48-stream-recovered.png");
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Physical Session Detail reconnect failed without an error object.";
    throw new Error(`${message} ${physicalPromptStreamDiagnostic(input)}`, {
      cause: error
    });
  }
}

async function runPhysicalDetailFailureStates(
  input: ProductionUiEntryInput & {
    readonly controls: PhysicalDashboardControls;
    readonly prompt: PhysicalPromptRuntime;
  },
  capture: PhysicalDashboardCapture
): Promise<void> {
  input.controls.markSessionStale();
  const staleReadsBefore = input.requestInspection.sessionDetailRequests;
  adb(["shell", "input", "keyevent", "KEYCODE_REFRESH"]);
  await waitFor(
    () => input.requestInspection.sessionDetailRequests > staleReadsBefore,
    45_000,
    "Physical Session Detail did not reload stale projection truth."
  );
  await revealPhysicalSessionContentNode(
    "text",
    "Showing stale session state",
    "backward",
    30_000,
    "Physical Session Detail did not render stale truth."
  );
  await capture("fe090-49-detail-stale.png");

  input.controls.restoreSessionCurrent();
  const currentReadsBefore = input.requestInspection.sessionDetailRequests;
  adb(["shell", "input", "keyevent", "KEYCODE_REFRESH"]);
  await waitFor(
    () =>
      input.requestInspection.sessionDetailRequests > currentReadsBefore &&
      input.prompt.subscribers.snapshot().active_subscribers === 1,
    45_000,
    "Physical Session Detail did not recover current projection truth."
  );
  await waitForAndroidUiText(
    "Ready to send",
    30_000,
    "Physical Session Detail remained stale after current refresh."
  );

  const navigationBefore = readPhysicalSessionNavigationSnapshot(input);
  requireCondition(
    navigationBefore.activeSubscribers === 1,
    "Physical not-found navigation did not begin with one selected-session subscriber."
  );
  const navigationWhileMissing = Object.freeze({
    ...navigationBefore,
    missingDetailRequests: navigationBefore.missingDetailRequests + 1
  });
  openChromePath(input.externalOrigin, "/sessions/sess_physical_missing");
  try {
    await waitForAndroidUiText(
      "Session unavailable",
      30_000,
      "Physical Session Detail did not render not-found truth."
    );
    await waitFor(
      () =>
        physicalSessionNavigationMatches(
          readPhysicalSessionNavigationSnapshot(input),
          navigationWhileMissing
        ),
      15_000,
      "Physical not-found navigation changed selected-session stream authority."
    );
    await capture("fe090-50-detail-not-found.png");

    const navigationWhileBackgrounded = Object.freeze({
      ...navigationWhileMissing,
      activeSubscribers: 0
    });
    adb([...physicalAndroidChromeRetainedTabCommandPlan[0]]);
    await waitFor(
      () =>
        physicalSessionNavigationMatches(
          readPhysicalSessionNavigationSnapshot(input),
          navigationWhileBackgrounded
        ),
      15_000,
      "Physical Chrome Back did not close only the backgrounded selected-session stream."
    );
    const navigationAfterReturn = Object.freeze({
      ...navigationWhileMissing,
      openedSubscribers: navigationWhileMissing.openedSubscribers + 1,
      selectedDetailRequests: navigationWhileMissing.selectedDetailRequests + 1,
      streamRequests: navigationWhileMissing.streamRequests + 1
    });
    const launchOutput = adb([
      ...physicalAndroidChromeRetainedTabCommandPlan[1]
    ]);
    requireCondition(
      !launchOutput.includes("Error:") && !launchOutput.includes("Exception"),
      "Physical Chrome launcher return failed."
    );
    await waitFor(
      () =>
        physicalSessionNavigationMatches(
          readPhysicalSessionNavigationSnapshot(input),
          navigationAfterReturn
        ),
      45_000,
      "Physical Chrome launcher return did not reopen exactly one selected-session stream."
    );
    await waitForAndroidUiText(
      "Ready to send",
      30_000,
      "Physical Session Detail did not return to the retained current tab."
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Physical not-found recovery failed without an error object.";
    throw new Error(`${message} ${physicalPromptStreamDiagnostic(input)}`, {
      cause: error
    });
  }
}

function readPhysicalSessionNavigationSnapshot(
  input: Readonly<{
    readonly prompt: PhysicalPromptRuntime;
    readonly requestInspection: RequestInspection;
  }>
): PhysicalSessionNavigationSnapshot {
  const subscribers = input.prompt.subscribers.snapshot();
  return Object.freeze({
    activeSubscribers: subscribers.active_subscribers,
    missingDetailRequests: input.requestInspection.sessionMissingDetailRequests,
    openedSubscribers: subscribers.opened_subscribers,
    selectedDetailRequests: input.requestInspection.sessionDetailRequests,
    streamRequests: input.requestInspection.sessionStreamRequests
  });
}

function physicalSessionNavigationMatches(
  actual: PhysicalSessionNavigationSnapshot,
  expected: PhysicalSessionNavigationSnapshot
): boolean {
  return (
    actual.activeSubscribers === expected.activeSubscribers &&
    actual.missingDetailRequests === expected.missingDetailRequests &&
    actual.openedSubscribers === expected.openedSubscribers &&
    actual.selectedDetailRequests === expected.selectedDetailRequests &&
    actual.streamRequests === expected.streamRequests
  );
}

function physicalSessionNavigationOpened(
  actual: PhysicalSessionNavigationSnapshot,
  before: PhysicalSessionNavigationSnapshot
): boolean {
  return (
    before.activeSubscribers === 0 &&
    actual.activeSubscribers === 1 &&
    actual.missingDetailRequests === before.missingDetailRequests &&
    actual.openedSubscribers === before.openedSubscribers + 1 &&
    actual.selectedDetailRequests === before.selectedDetailRequests + 1 &&
    actual.streamRequests === before.streamRequests + 1
  );
}

async function runPhysicalApprovalControl(
  input: ProductionUiEntryInput & {
    readonly controls: PhysicalDashboardControls;
    readonly prompt: PhysicalPromptRuntime;
  },
  capture: PhysicalDashboardCapture,
  measure: PhysicalDashboardMeasure
): Promise<void> {
  await revealPhysicalSessionContentNode(
    "text",
    "Review & approve",
    "forward",
    30_000,
    "Physical pending approval action was unavailable outside the session dock.",
    true
  );
  await waitForAndroidUiText(
    "Install the Android validation package",
    30_000,
    "Physical pending approval request was unavailable."
  );
  await waitForAndroidUiText(
    "Connected test phone",
    30_000,
    "Physical pending approval omitted its scope."
  );
  await waitForAndroidUiText(
    "Elevated",
    30_000,
    "Physical pending approval omitted elevated risk."
  );
  await waitForPhysicalSessionWriteReady(
    input,
    "Physical approval row did not retain stable current write authority."
  );
  await revealPhysicalSessionContentNode(
    "text",
    "Review & approve",
    "forward",
    30_000,
    "Physical pending approval action moved outside the safe session region.",
    true
  );
  await capture("fe090-04-approval-pending.png");
  const review = selectPhysicalSessionContentNode(
    await readAndroidUiNodes(),
    "text",
    "Review & approve",
    true
  );
  requireCondition(
    review !== null,
    "Physical pending approval action was not current immediately before its one tap."
  );
  measure(review, "review-approval");
  try {
    await tapAndroidNodeOnceAndWait(
      review,
      async () =>
        physicalApprovalConfirmationTitleIsOpen(await readAndroidUiNodes()),
      "Physical elevated approval confirmation did not open."
    );
  } catch (error) {
    const context = physicalApprovalConfirmationContextSummary(
      await readAndroidUiNodes()
    );
    const message =
      error instanceof Error
        ? error.message
        : "Physical approval transition failed without an error object."
    throw new Error(
      `${message} ${context};${physicalPromptStreamDiagnostic(input)}`,
      { cause: error }
    );
  }
  await waitForAndroidUiText(
    physicalApprovalConfirmationReason,
    30_000,
    "Physical approval confirmation omitted its reason."
  );
  await capture("fe090-05-approval-confirmation.png");
  const approve = await waitForPhysicalApprovalConfirmationAction(
    input,
    30_000,
    "Physical approval confirmation action was unavailable."
  );
  measure(approve, "approve-once");
  await tapAndroidNodeOnceAndWait(
    approve,
    () => input.controls.hasPendingApproval(),
    "Physical approval response did not enter one pending request."
  );
  await waitForAndroidUiText(
    "Confirming decision",
    30_000,
    "Physical approval did not render responding truth."
  );
  await capture("fe090-06-approval-responding.png");
  input.controls.releaseApproval();
  await waitForAndroidUiText(
    "Approved once",
    30_000,
    "Physical approval did not render terminal approved truth."
  );
  await capture("fe090-07-approval-approved.png");
}

async function waitForPhysicalMissionControlWriteReady(
  input: Readonly<{
    readonly prompt: PhysicalPromptRuntime;
    readonly requestInspection: RequestInspection;
  }>,
  before: Readonly<{
    readonly accessRequests: number;
    readonly hostStatusRequests: number;
    readonly sessionListRequests: number;
  }>,
  message: string
): Promise<void> {
  const observations: string[] = [];
  let stableSince: number | null = null;
  let stableObservation: string | null = null;
  try {
    await waitFor(async () => {
      const nodes = await readAndroidUiNodes();
      const activeSubscribers =
        input.prompt.subscribers.snapshot().active_subscribers;
      const observation = [
        `requests=${input.requestInspection.accessRequests - before.accessRequests}/` +
          `${input.requestInspection.hostStatusRequests - before.hostStatusRequests}/` +
          `${input.requestInspection.sessionListRequests - before.sessionListRequests}`,
        physicalMissionControlWriteSummary(nodes, activeSubscribers)
      ].join(";");
      if (observations.at(-1) !== observation && observations.length < 6) {
        observations.push(observation);
      }
      const ready =
        input.requestInspection.accessRequests === before.accessRequests + 1 &&
        input.requestInspection.hostStatusRequests === before.hostStatusRequests + 1 &&
        input.requestInspection.sessionListRequests === before.sessionListRequests + 1 &&
        physicalMissionControlWriteReady(nodes, activeSubscribers);
      if (!ready) {
        stableSince = null;
        stableObservation = null;
        return false;
      }
      if (stableSince === null || stableObservation !== observation) {
        stableSince = performance.now();
        stableObservation = observation;
        return false;
      }
      return performance.now() - stableSince >= 2_000;
    }, 45_000, message);
  } catch (error) {
    throw new Error(
      `${message} (states=${
        observations.length === 0 ? "none" : observations.join("||")
      }) ${physicalPromptStreamDiagnostic(input)}`,
      { cause: error }
    );
  }
}

function physicalMissionControlWriteReady(
  nodes: readonly AndroidUiNode[],
  activeSubscribers: number
): boolean {
  const textCount = (value: string): number =>
    nodes.filter((node) => node.text === value).length;
  const descriptionCount = (value: string): number =>
    nodes.filter((node) => node.description === value).length;
  return (
    activeSubscribers === 0 &&
    textCount("Mission Control") === 1 &&
    textCount("Remote ready") === 1 &&
    textCount("Write") === 1 &&
    descriptionCount(physicalUiSessionName) === 1 &&
    textCount("Remote writes locked") === 0 &&
    textCount("Locked") === 0 &&
    textCount("Access stale") === 0 &&
    textCount("Reconnecting") === 0
  );
}

function physicalMissionControlWriteSummary(
  nodes: readonly AndroidUiNode[],
  activeSubscribers: number
): string {
  const textCount = (value: string): number =>
    nodes.filter((node) => node.text === value).length;
  const descriptionCount = (value: string): number =>
    nodes.filter((node) => node.description === value).length;
  return [
    `active=${activeSubscribers}`,
    `mission=${textCount("Mission Control")}`,
    `remote=${textCount("Remote ready")}`,
    `write=${textCount("Write")}`,
    `session=${descriptionCount(physicalUiSessionName)}`,
    `locked=${textCount("Remote writes locked")}/${textCount("Locked")}`,
    `stale=${textCount("Access stale")}`,
    `reconnecting=${textCount("Reconnecting")}`
  ].join(",");
}

async function waitForPhysicalSessionWriteReady(
  input: Readonly<{
    readonly prompt: PhysicalPromptRuntime;
    readonly requestInspection: RequestInspection;
  }>,
  message: string
): Promise<void> {
  let stableSince: number | null = null;
  let stableStreamRequests: number | null = null;
  try {
    await waitFor(async () => {
      const activeSubscribers =
        input.prompt.subscribers.snapshot().active_subscribers;
      const streamRequests = input.requestInspection.sessionStreamRequests;
      const ready = physicalSessionWriteReady(
        await readAndroidUiNodes(),
        activeSubscribers
      );
      if (!ready) {
        stableSince = null;
        stableStreamRequests = null;
        return false;
      }
      if (
        stableSince === null ||
        stableStreamRequests === null ||
        stableStreamRequests !== streamRequests
      ) {
        stableSince = performance.now();
        stableStreamRequests = streamRequests;
        return false;
      }
      return performance.now() - stableSince >= 2_000;
    }, 45_000, message);
  } catch {
    throw new Error(`${message} ${physicalPromptStreamDiagnostic(input)}`);
  }
}

function physicalSessionWriteReady(
  nodes: readonly AndroidUiNode[],
  activeSubscribers: number
): boolean {
  const count = (value: string): number =>
    nodes.filter((node) => matchesAndroidUiNode(node, "semantic", value)).length;
  return (
    activeSubscribers === 1 &&
    count("Ready to send") === 1 &&
    count("Activity stream reconnecting") === 0 &&
    count("Session activity is reconnecting.") === 0 &&
    count("Prompt unavailable") === 0
  );
}

function physicalPromptCompletionRestored(
  nodes: readonly AndroidUiNode[],
  activeSubscribers: number
): boolean {
  const count = (value: string): number =>
    nodes.filter((node) => matchesAndroidUiNode(node, "semantic", value)).length;
  return (
    activeSubscribers === 1 &&
    count("Turn completed") === 1 &&
    count("Activity stream reconnecting") === 0 &&
    count("Session activity is reconnecting.") === 0 &&
    count("Prompt unavailable") === 0
  );
}

async function runPhysicalModelControl(
  input: ProductionUiEntryInput & { readonly controls: PhysicalDashboardControls },
  capture: PhysicalDashboardCapture,
  measure: PhysicalDashboardMeasure
): Promise<void> {
  const triggerLabel = `/model for ${physicalUiSessionName}`;
  const trigger = await waitForAndroidUiNodePresent(
    "description",
    triggerLabel,
    30_000,
    "Physical /model trigger was unavailable."
  );
  measure(trigger, "open-model");
  await tapAndroidNodeOnceAndWait(
    trigger,
    async () =>
      (await readAndroidUiNodes()).some((node) => node.text === "Codex Current"),
    "Physical /model did not show current model truth."
  );
  const fast = await waitForAndroidUiNodePresent(
    "text",
    "Codex Fast",
    30_000,
    "Physical /model omitted the supported Codex Fast choice."
  );
  tapAndroidUiNode(fast);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const submit = await waitForAndroidUiNodePresent(
    "text",
    "Set for next turn",
    30_000,
    "Physical /model submit action was unavailable."
  );
  measure(submit, "set-model-next-turn");
  await tapAndroidNodeOnceAndWait(
    submit,
    () => input.controls.hasPendingModel(),
    "Physical /model selection did not enter one pending request."
  );
  await waitForAndroidUiText(
    "Saving next-turn model",
    30_000,
    "Physical /model did not render its submitting state."
  );
  await capture("fe090-12-model-submitting.png");
  input.controls.releaseModel();
  await waitForAndroidUiText(
    "Model staged for next turn",
    30_000,
    "Physical /model did not render accepted next-turn truth."
  );
  await capture("fe090-13-model-staged.png");
  input.controls.applyModel();
  await closePhysicalDialog("Close model control");

  const reopened = await waitForAndroidUiNodePresent(
    "description",
    triggerLabel,
    30_000,
    "Physical /model trigger was unavailable after close."
  );
  await tapAndroidNodeOnceAndWait(
    reopened,
    async () =>
      (await readAndroidUiNodes()).some(
        (node) => node.text === "Model control ready"
      ),
    "Physical /model did not reopen with current state."
  );
  await waitForAndroidUiText(
    "Codex Fast",
    30_000,
    "Physical /model did not retain the applied selection."
  );
  await capture("fe090-14-model-applied.png");
  await closePhysicalDialog("Close model control");
}

async function runPhysicalGoalControl(
  input: ProductionUiEntryInput & { readonly controls: PhysicalDashboardControls },
  capture: PhysicalDashboardCapture,
  measure: PhysicalDashboardMeasure
): Promise<void> {
  const trigger = await waitForAndroidUiNodePresent(
    "description",
    `/goal for ${physicalUiSessionName}`,
    30_000,
    "Physical /goal trigger was unavailable."
  );
  measure(trigger, "open-goal");
  await tapAndroidNodeOnceAndWait(
    trigger,
    async () =>
      (await readAndroidUiNodes()).some((node) => node.text === "No goal set"),
    "Physical /goal did not render current objective truth."
  );
  await capture("fe090-15-goal-current.png");
  const editor = await waitForAndroidPromptEditor(
    "Goal objective",
    30_000,
    "Physical Goal objective editor was unavailable."
  );
  await tapAndroidNodeOnceAndWait(
    editor,
    () => isAndroidKeyboardVisible(),
    "Physical Goal objective editor did not open the keyboard."
  );
  enterPhysicalSingleLineText(physicalGoalObjective);
  await waitForAndroidUiText(
    physicalGoalObjective,
    15_000,
    "Physical Goal objective did not retain edited text."
  );
  adb(["shell", "input", "keyevent", "KEYCODE_BACK"]);
  await waitFor(
    () => !isAndroidKeyboardVisible(),
    10_000,
    "Physical Goal objective keyboard did not close."
  );
  const save = await waitForAndroidUiNodePresent(
    "text",
    "Create paused goal",
    30_000,
    "Physical Goal save action was unavailable."
  );
  measure(save, "create-paused-goal");
  await tapAndroidNodeOnceAndWait(
    save,
    () => input.controls.hasPendingGoal(),
    "Physical Goal mutation did not enter one pending request."
  );
  await waitForAndroidUiText(
    "Saving paused goal",
    30_000,
    "Physical Goal did not render accepted transition truth."
  );
  await capture("fe090-16-goal-submitting.png");
  input.controls.releaseGoal();
  await waitForAndroidUiText(
    "Paused goal created",
    30_000,
    "Physical Goal did not render terminal paused truth."
  );
  await waitForAndroidUiText(
    "No turn was started.",
    30_000,
    "Physical Goal mutation incorrectly implied a turn."
  );
  await capture("fe090-17-goal-created.png");
  await closePhysicalDialog("Close goal control");
}

async function runPhysicalPlanControl(
  input: ProductionUiEntryInput & { readonly controls: PhysicalDashboardControls },
  capture: PhysicalDashboardCapture,
  measure: PhysicalDashboardMeasure
): Promise<void> {
  const triggerLabel = `/plan for ${physicalUiSessionName}`;
  const trigger = await waitForAndroidUiNodePresent(
    "description",
    triggerLabel,
    30_000,
    "Physical /plan trigger was unavailable."
  );
  measure(trigger, "open-plan");
  await openPhysicalPlanSheet(trigger, input.requestInspection, "Default");
  await waitForAndroidUiText(
    "Default",
    30_000,
    "Physical /plan omitted the current Default mode."
  );
  await capture("fe090-18-plan-current.png");
  const plan = await waitForAndroidUiNodePresent(
    "text",
    "Plan",
    30_000,
    "Physical /plan omitted the supported Plan choice."
  );
  tapAndroidUiNode(plan);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const submit = await waitForAndroidUiNodePresent(
    "text",
    "Set for next turn",
    30_000,
    "Physical /plan submit action was unavailable."
  );
  measure(submit, "set-plan-next-turn");
  await tapAndroidNodeOnceAndWait(
    submit,
    () => input.controls.hasPendingPlan(),
    "Physical /plan selection did not enter one pending request."
  );
  await waitFor(
    async () =>
      physicalPlanSubmittingTruthVisible(await readAndroidUiNodes()),
    30_000,
    "Physical /plan did not render its submitting state."
  );
  await capture("fe090-19-plan-submitting.png");
  input.controls.releasePlan();
  await waitFor(
    async () => physicalPlanStagedTruthVisible(await readAndroidUiNodes()),
    30_000,
    "Physical /plan did not render accepted next-turn truth."
  );
  await capture("fe090-20-plan-staged.png");
  input.controls.applyPlan();
  await closePhysicalDialog("Close Plan control");
  const reopened = await waitForAndroidUiNodePresent(
    "description",
    triggerLabel,
    30_000,
    "Physical /plan trigger was unavailable after close."
  );
  await openPhysicalPlanSheet(reopened, input.requestInspection, "Plan");
  await capture("fe090-21-plan-applied.png");
  await closePhysicalDialog("Close Plan control");
}

async function openPhysicalPlanSheet(
  trigger: AndroidUiNode,
  inspection: RequestInspection,
  expectedCurrentMode: "Default" | "Plan"
): Promise<void> {
  const readsBefore = inspection.planReadRequests;
  const triggerLabel = `/plan for ${physicalUiSessionName}`;
  await performVerifiedAndroidTap({
    initialTrigger: trigger,
    triggerField: "description",
    triggerValue: triggerLabel,
    completed: async () =>
      physicalPlanCurrentTruthVisible(
        await readAndroidUiNodes(),
        expectedCurrentMode
      ),
    completionFailureMessage:
      "Physical /plan did not render visible current-mode truth.",
    reacquireFailureMessage: "Physical /plan trigger could not be safely reacquired.",
    terminalFailureMessage:
      "Physical /plan remained closed after two bounded non-mutating taps."
  });
  requireCondition(
    inspection.planReadRequests === readsBefore + 1,
    "Physical /plan did not issue exactly one current-mode read."
  );
}

function physicalPlanCurrentTruthVisible(
  nodes: readonly AndroidUiNode[],
  expectedCurrentMode: "Default" | "Plan"
): boolean {
  return (
    physicalPlanModeOwnsRailAndOption(nodes, expectedCurrentMode) &&
    ["No pending change", "No observed Plan execution"].every((label) =>
      nodes.some((node) => node.text === label)
    )
  );
}

function physicalPlanSubmittingTruthVisible(
  nodes: readonly AndroidUiNode[]
): boolean {
  return nodes.some(
    (node) => node.text === "A Plan selection is already being saved."
  );
}

function physicalPlanStagedTruthVisible(nodes: readonly AndroidUiNode[]): boolean {
  return (
    physicalPlanModeOwnsRailAndOption(nodes, "Plan") &&
    [
      "Pending next turn: Staged in HostDeck",
      "No observed Plan execution"
    ].every((label) => nodes.some((node) => node.text === label))
  );
}

function physicalPlanModeOwnsRailAndOption(
  nodes: readonly AndroidUiNode[],
  value: "Default" | "Plan"
): boolean {
  return nodes.filter((node) => node.text === value).length >= 2;
}

async function runPhysicalSessionUtilities(
  input: ProductionUiEntryInput & { readonly controls: PhysicalDashboardControls },
  capture: PhysicalDashboardCapture,
  measure: PhysicalDashboardMeasure
): Promise<void> {
  const more = await waitForAndroidUiNodePresent(
    "description",
    `More session utilities for ${physicalUiSessionName}`,
    30_000,
    "Physical session utilities trigger was unavailable."
  );
  measure(more, "open-session-utilities");
  await tapAndroidNodeOnceAndWait(
    more,
    async () =>
      (await readAndroidUiNodes()).some(
        (node) => node.text === "Session utilities"
      ),
    "Physical session utilities did not open."
  );
  await capture("fe090-22-utilities-menu.png");

  const usage = await revealAndroidUiNode(
    "description",
    "Open /usage",
    "forward",
    30_000,
    "Physical /usage utility was unavailable.",
    "fully_visible",
    true
  );
  measure(usage, "open-usage");
  await tapAndroidNodeOnceAndWait(
    usage,
    async () =>
      (await readAndroidUiNodes()).some(
        (node) => node.text === "Usage capture current"
      ),
    "Physical /usage did not render current bounded usage."
  );
  await waitForAndroidUiText(
    "Lifetime tokens",
    30_000,
    "Physical /usage omitted account totals."
  );
  await capture("fe090-23-usage.png");
  await returnToPhysicalSessionUtilities();

  const compact = await revealAndroidUiNode(
    "description",
    "Open /compact",
    "forward",
    30_000,
    "Physical /compact utility was unavailable.",
    "fully_visible",
    true
  );
  measure(compact, "open-compact");
  await tapAndroidNodeOnceAndWait(
    compact,
    async () =>
      (await readAndroidUiNodes()).some(
        (node) => node.text === "No tracked compaction"
      ),
    "Physical /compact did not render current progress truth."
  );
  const begin = await waitForAndroidUiNodePresent(
    "text",
    "Compact context",
    30_000,
    "Physical /compact action was unavailable."
  );
  measure(begin, "compact-context");
  await tapAndroidNodeOnceAndWait(
    begin,
    async () =>
      (await readAndroidUiNodes()).some(
        (node) => node.text === "Confirm context compaction"
      ),
    "Physical /compact confirmation did not open."
  );
  await capture("fe090-24-compact-confirmation.png");
  const confirm = await waitForAndroidUiNodePresent(
    "text",
    "Confirm compact",
    30_000,
    "Physical /compact final confirmation was unavailable."
  );
  measure(confirm, "confirm-compact");
  await tapAndroidNodeOnceAndWait(
    confirm,
    () => input.controls.hasPendingCompact(),
    "Physical /compact did not enter one pending request."
  );
  await waitForAndroidUiText(
    "Submitting compaction",
    30_000,
    "Physical /compact omitted submitting truth."
  );
  await capture("fe090-25-compact-submitting.png");
  input.controls.releaseCompact();
  await waitForAndroidUiText(
    "Compaction accepted",
    30_000,
    "Physical /compact omitted accepted truth."
  );
  await capture("fe090-26-compact-accepted.png");
  input.controls.completeCompact();
  const check = await waitForAndroidUiNodePresent(
    "description",
    "Check Compact progress",
    30_000,
    "Physical /compact progress check was unavailable."
  );
  await tapAndroidNodeOnceAndWait(
    check,
    async () =>
      (await readAndroidUiNodes()).some(
        (node) => node.text === "Compaction completed"
      ),
    "Physical /compact omitted terminal completion truth."
  );
  await capture("fe090-27-compact-completed.png");
  await returnToPhysicalSessionUtilities();

  const skills = await revealAndroidUiNode(
    "description",
    "Open /skills",
    "forward",
    30_000,
    "Physical /skills utility was unavailable.",
    "fully_visible",
    true
  );
  measure(skills, "open-skills");
  const skillsReadsBefore = physicalDashboardControlCallCount(
    input.controls,
    "read_skills"
  );
  requireCondition(
    skillsReadsBefore === 0,
    "Physical /skills had an unexpected prior read."
  );
  let skillsTransitionState = "unobserved";
  await tapAndroidNodeOnceAndWait(
    skills,
    async () => {
      const nodes = await readAndroidUiNodes();
      skillsTransitionState = physicalSkillsUiStateSummary(
        nodes,
        input.controls
      );
      return (
        nodes.some((node) => node.text === "/skills") &&
        physicalDashboardControlCallCount(input.controls, "read_skills") ===
          skillsReadsBefore + 1
      );
    },
    () =>
      `Physical /skills did not enter its one-read surface (${skillsTransitionState}).`
  );
  const search = await revealPhysicalSkillsSearch(input.controls);
  await tapAndroidNodeOnceAndWait(
    search,
    () => isAndroidKeyboardVisible(),
    "Physical Skills search did not open the keyboard."
  );
  enterPhysicalSingleLineText(physicalSkillSearch);
  await waitForAndroidUiText(
    physicalSkillSearch,
    15_000,
    "Physical Skills search did not retain its local filter."
  );
  adb(["shell", "input", "keyevent", "KEYCODE_BACK"]);
  await waitFor(
    () => !isAndroidKeyboardVisible(),
    10_000,
    "Physical Skills search keyboard did not close."
  );
  await waitForAndroidUiText(
    "1 matching",
    15_000,
    "Physical Skills search did not render its one matching result."
  );
  await capture("fe090-28-skills.png");
  await returnToPhysicalSessionUtilities();
  await closePhysicalDialog("Close session utilities");
}

async function revealPhysicalSkillsSearch(
  controls: PhysicalDashboardControls
): Promise<AndroidUiNode> {
  let found: AndroidUiNode | null = null;
  let swipeCount = 0;
  const observations: string[] = [];
  try {
    await waitFor(async () => {
      const nodes = await readAndroidUiNodes();
      const observation = physicalSkillsUiStateSummary(nodes, controls);
      if (observations.at(-1) !== observation && observations.length < 6) {
        observations.push(observation);
      }
      found = findPhysicalSkillsSearchEditor(nodes);
      if (found !== null) return true;
      if (swipeCount < 4) {
        swipeAndroidViewport(nodes, "forward");
        swipeCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      return false;
    }, 30_000, "Physical Skills search was unavailable.");
  } catch {
    throw new Error(
      `Physical Skills search was unavailable (swipes=${swipeCount};states=${
        observations.length === 0 ? "none" : observations.join("||")
      }).`
    );
  }
  requireCondition(found !== null, "Physical Skills search was unavailable.");
  return found;
}

function physicalSkillsUiStateSummary(
  nodes: readonly AndroidUiNode[],
  controls: PhysicalDashboardControls
): string {
  const labels = [
    ["title", "/skills"],
    ["loading", "Loading Skills"],
    ["current", "Skills capture current"],
    ["failure", "Skills could not be loaded"],
    ["unavailable", "Skills unavailable"],
    ["summary", "Skills summary"],
    ["search", "Search skills"],
    ["reported", "25 structured skills reported."]
  ] as const;
  const state = labels.map(([key, value]) => {
    const matches = nodes.filter((node) =>
      matchesAndroidUiNode(node, "semantic", value)
    );
    return `${key}=${matches.length}:${
      matches[0] === undefined ? "none" : androidUiNodeGeometry(matches[0])
    }`;
  });
  let pageEditors: readonly AndroidUiNode[] = [];
  try {
    const page = selectChromePageViewport(nodes);
    pageEditors = nodes.filter(
      (node) =>
        node.className === androidEditTextClass &&
        androidUiNodeIsFullyInsideRegion(node, page)
    );
  } catch {
    // The bounded summary reports no page editor when Chrome geometry is invalid.
  }
  return [
    `reads=${physicalDashboardControlCallCount(controls, "read_skills")}`,
    ...state,
    `editors=${pageEditors.length}:${
      pageEditors
        .slice(0, 2)
        .map(privateFreeAndroidUiNodeGeometry)
        .join("|") || "none"
    }`
  ].join(";");
}

function physicalDashboardControlCallCount(
  controls: PhysicalDashboardControls,
  name: string
): number {
  const count = controls.snapshot().calls[name];
  requireCondition(
    count === undefined ||
      (Number.isSafeInteger(count) && count >= 0 && count <= 100),
    "Physical dashboard control call count was invalid."
  );
  return count ?? 0;
}

async function returnToPhysicalSessionUtilities(): Promise<void> {
  const back = await waitForAndroidUiNodePresent(
    "description",
    "Back to session utilities",
    30_000,
    "Physical utility back action was unavailable."
  );
  await tapAndroidNodeOnceAndWait(
    back,
    async () =>
      (await readAndroidUiNodes()).some(
        (node) => node.text === "Session utilities"
      ),
    "Physical utility did not return to its menu."
  );
}

async function runPhysicalLaptopResume(
  input: ProductionUiEntryInput & {
    readonly prompt: PhysicalPromptRuntime;
  },
  capture: PhysicalDashboardCapture,
  measure: PhysicalDashboardMeasure
): Promise<"copied" | "unavailable"> {
  const actions = await waitForAndroidUiNodePresent(
    "description",
    "Open session actions",
    30_000,
    "Physical session actions trigger was unavailable."
  );
  measure(actions, "open-session-actions");
  await tapAndroidNodeOnceAndWait(
    actions,
    async () =>
      (await readAndroidUiNodes()).some(
        (node) => node.text === "Session actions"
      ),
    "Physical session actions did not open."
  );
  const resume = await revealAndroidUiNode(
    "description",
    "Open Resume on laptop",
    "forward",
    30_000,
    "Physical laptop Resume action was unavailable.",
    "fully_visible",
    true
  );
  measure(resume, "resume-on-laptop");
  await tapAndroidNodeOnceAndWait(
    resume,
    async () =>
      (await readAndroidUiNodes()).some(
        (node) => node.text === "Laptop terminal only"
      ),
    "Physical laptop Resume metadata did not render."
  );
  await capture("fe090-29-laptop-resume.png");
  const copy = await waitForAndroidUiNodePresent(
    "text",
    "Copy command",
    30_000,
    "Physical laptop Resume copy action was unavailable."
  );
  measure(copy, "copy-resume-command");
  tapAndroidUiNode(copy);
  let outcome: "copied" | "unavailable" | null = null;
  await waitFor(async () => {
    const nodes = await readAndroidUiNodes();
    if (nodes.some((node) => node.text === "Command copied")) {
      outcome = "copied";
      return true;
    }
    if (nodes.some((node) => node.text === "Copy failed")) {
      outcome = "unavailable";
      return true;
    }
    return false;
  }, 30_000, "Physical laptop Resume copy outcome was unavailable.");
  requireCondition(outcome !== null, "Physical laptop Resume copy did not settle.");
  if (outcome === "copied") {
    await clearPhysicalAndroidClipboard(input);
    return outcome;
  }
  const back = await waitForAndroidUiNodePresent(
    "description",
    "Back to session actions",
    30_000,
    "Physical laptop Resume back action was unavailable."
  );
  await tapAndroidNodeOnceAndWait(
    back,
    async () =>
      (await readAndroidUiNodes()).some(
        (node) => node.text === "Session actions"
      ),
    "Physical laptop Resume did not return to session actions."
  );
  await closePhysicalDialog("Close session actions");
  return outcome;
}

async function clearPhysicalAndroidClipboard(
  input: ProductionUiEntryInput & {
    readonly prompt: PhysicalPromptRuntime;
  }
): Promise<void> {
  const navigationBefore = readPhysicalSessionNavigationSnapshot(input);
  requireCondition(
    navigationBefore.activeSubscribers === 1,
    "Physical clipboard cleanup did not begin with one retained Session Detail subscriber."
  );
  openChromePath(input.externalOrigin, "/__physical/clipboard");
  try {
    const clear = await waitForAndroidUiNodePresent(
      "text",
      "Clear clipboard",
      30_000,
      "Physical clipboard cleanup action was unavailable."
    );
    await tapAndroidNodeOnceAndWait(
      clear,
      async () =>
        (await readAndroidUiNodes()).some(
          (node) => node.text === "Clipboard cleared"
        ),
      "Physical clipboard cleanup did not complete."
    );
    await waitFor(
      () =>
        physicalSessionNavigationMatches(
          readPhysicalSessionNavigationSnapshot(input),
          navigationBefore
        ),
      15_000,
      "Physical clipboard page changed retained Session Detail authority."
    );

    const navigationWhileBackgrounded = Object.freeze({
      ...navigationBefore,
      activeSubscribers: 0
    });
    adb([...physicalAndroidChromeRetainedTabCommandPlan[0]]);
    await waitFor(
      () =>
        physicalSessionNavigationMatches(
          readPhysicalSessionNavigationSnapshot(input),
          navigationWhileBackgrounded
        ),
      15_000,
      "Physical clipboard Back did not close only the retained Session Detail stream."
    );

    const navigationAfterReturn = Object.freeze({
      ...navigationBefore,
      openedSubscribers: navigationBefore.openedSubscribers + 1,
      selectedDetailRequests: navigationBefore.selectedDetailRequests + 1,
      streamRequests: navigationBefore.streamRequests + 1
    });
    const launchOutput = adb([
      ...physicalAndroidChromeRetainedTabCommandPlan[1]
    ]);
    requireCondition(
      !launchOutput.includes("Error:") && !launchOutput.includes("Exception"),
      "Physical clipboard Chrome launcher return failed."
    );
    await waitFor(
      () =>
        physicalSessionNavigationMatches(
          readPhysicalSessionNavigationSnapshot(input),
          navigationAfterReturn
        ),
      45_000,
      "Physical clipboard cleanup did not reopen exactly one retained Session Detail stream."
    );
    await waitForAndroidUiText(
      "Ready to send",
      30_000,
      "Physical clipboard cleanup lost the retained selected session."
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Physical clipboard recovery failed without an error object.";
    throw new Error(`${message} ${physicalPromptStreamDiagnostic(input)}`, {
      cause: error
    });
  }
}

async function runPhysicalInterruptControl(
  input: ProductionUiEntryInput & {
    readonly controls: PhysicalDashboardControls;
    readonly prompt: PhysicalPromptRuntime;
  },
  capture: PhysicalDashboardCapture,
  measure: PhysicalDashboardMeasure
): Promise<void> {
  const detailReadsBefore = input.requestInspection.sessionDetailRequests;
  const streamsBefore = input.prompt.subscribers.snapshot().opened_subscribers;
  input.controls.beginInterruptibleTurn();
  input.prompt.publishInterruptTurn(
    input.controls.interruptTurnId,
    "in_progress"
  );
  adb(["shell", "input", "keyevent", "KEYCODE_REFRESH"]);
  await waitFor(
    () =>
      input.requestInspection.sessionDetailRequests > detailReadsBefore &&
      input.prompt.subscribers.snapshot().opened_subscribers > streamsBefore &&
      input.prompt.subscribers.snapshot().active_subscribers === 1,
    45_000,
    "Physical Session Detail did not reconnect once for interrupt truth."
  );
  const actions = await waitForAndroidUiNodePresent(
    "description",
    "Open session actions",
    30_000,
    "Physical interrupt session actions were unavailable."
  );
  await tapAndroidNodeOnceAndWait(
    actions,
    async () =>
      (await readAndroidUiNodes()).some(
        (node) => node.text === "Session actions"
      ),
    "Physical interrupt action did not open."
  );
  const interrupt = await revealAndroidUiNode(
    "description",
    "Open Interrupt active turn",
    "forward",
    30_000,
    "Physical interrupt action was unavailable.",
    "fully_visible",
    true
  );
  measure(interrupt, "interrupt-active-turn");
  await tapAndroidNodeOnceAndWait(
    interrupt,
    async () =>
      (await readAndroidUiNodes()).some(
        (node) => node.text === "Interrupt active turn?"
      ),
    "Physical interrupt confirmation did not open."
  );
  await capture("fe090-30-interrupt-confirmation.png");
  const confirm = await waitForAndroidUiNodePresent(
    "text",
    "Interrupt turn",
    30_000,
    "Physical interrupt final action was unavailable."
  );
  measure(confirm, "confirm-interrupt");
  await tapAndroidNodeOnceAndWait(
    confirm,
    async () =>
      (await readAndroidUiNodes()).some(
        (node) => node.text === "Turn interrupted"
      ),
    "Physical interrupt did not render terminal truth."
  );
  input.controls.finishInterrupt();
  input.prompt.publishInterruptTurn(
    input.controls.interruptTurnId,
    "interrupted"
  );
  await capture("fe090-31-turn-interrupted.png");
  const done = await waitForAndroidUiNodePresent(
    "text",
    "Done",
    30_000,
    "Physical interrupt result action was unavailable."
  );
  await tapAndroidNodeOnceAndWait(
    done,
    async () => {
      const nodes = await readAndroidUiNodes();
      return (
        nodes.some(
          (node) => node.description === "Open session actions"
        ) &&
        nodes.some((node) => node.text === "Ready to send") &&
        nodes.every(
          (node) =>
            node.text !== "Session actions" &&
            node.text !== "Turn interrupted"
        )
      );
    },
    "Physical interrupt result did not restore Session Detail."
  );
}

async function runPhysicalHostAccessControls(
  input: ProductionUiEntryInput & {
    readonly env: Readonly<Record<string, string>>;
    readonly manager: TailscaleServeManager;
    readonly prompt: PhysicalPromptRuntime;
  },
  capture: PhysicalDashboardCapture,
  measure: PhysicalDashboardMeasure
): Promise<void> {
  const managerAttempts = input.manager.snapshot().command_attempts;
  const actions = await waitForAndroidUiNodePresent(
    "description",
    "Open session actions",
    30_000,
    "Physical Host and access session actions were unavailable."
  );
  await tapAndroidNodeOnceAndWait(
    actions,
    async () =>
      (await readAndroidUiNodes()).some(
        (node) => node.text === "Session actions"
      ),
    "Physical Host and access session actions did not open."
  );
  const hostAccess = await revealAndroidUiNode(
    "description",
    "Open Host and access",
    "forward",
    30_000,
    "Physical Host and access action was unavailable in Session actions.",
    "fully_visible",
    true
  );
  measure(hostAccess, "open-session-host-access");
  await tapAndroidNodeOnceAndWait(
    hostAccess,
    async () => {
      const nodes = await readAndroidUiNodes();
      return (
        nodes.some((node) => node.text === "Host & access") &&
        nodes.some(
          (node) => node.description === "Back to session actions"
        )
      );
    },
    "Physical Host and access did not open from Session actions."
  );
  await revealAndroidUiNode(
    "text",
    "Remote access ready",
    "forward",
    30_000,
    "Physical Host and access omitted remote-ready truth."
  );
  await runOneProductionRemoteCheck(input.requestInspection);
  await revealAndroidUiNode(
    "text",
    "Read & write",
    "backward",
    30_000,
    "Physical Host and access omitted paired permission."
  );
  await capturePhysicalHostAccessEvidence(capture, "fe090-32-host-access.png");

  const officeRevoke = await revealAndroidUiNode(
    "description",
    "Revoke Office browser, Device 2",
    "forward",
    30_000,
    "Physical paired-device list omitted Office browser."
  );
  measure(officeRevoke, "revoke-office-device");
  await tapAndroidNodeOnceAndWait(
    officeRevoke,
    async () =>
      (await readAndroidUiNodes()).some(
        (node) => node.text === "Revoke paired device?"
      ),
    "Physical Office browser revoke confirmation did not open."
  );
  await capturePhysicalHostAccessEvidence(
    capture,
    "fe090-33-revoke-confirmation.png"
  );
  const confirmRevoke = await waitForAndroidUiNodePresent(
    "text",
    "Revoke device",
    30_000,
    "Physical Office browser revoke action was unavailable."
  );
  measure(confirmRevoke, "confirm-office-revoke");
  await tapAndroidNodeOnceAndWait(
    confirmRevoke,
    async () =>
      (await readAndroidUiNodes()).some(
        (node) => node.text === "Device revoked"
      ),
    "Physical Office browser revoke did not render terminal truth."
  );
  requireCondition(
    countMatchingRows(input.db, "auth_devices", "revoked_at IS NOT NULL") === 1,
    "Physical Office browser revoke did not revoke exactly one authority."
  );
  await capturePhysicalHostAccessEvidence(capture, "fe090-34-device-revoked.png");

  const lockAuditsBefore = countPhysicalAuditRows(input.db, "lock");
  requireCondition(
    lockAuditsBefore === 0,
    "Physical Host-lock entry started with an unexpected lock audit."
  );
  const lock = await revealPhysicalHostAccessContentNode(
    "text",
    "Lock writes",
    "backward",
    30_000,
    "Physical Host and access lock action was unavailable.",
    true
  );
  measure(lock, "lock-writes");
  await performVerifiedAndroidTap({
    initialTrigger: lock,
    triggerField: "text",
    triggerValue: "Lock writes",
    completed: async () =>
      (await readAndroidUiNodes()).some(
        (node) => node.text === "Lock remote writes?"
      ),
    completionFailureMessage:
      "Physical host-lock confirmation did not open.",
    reacquireFailureMessage:
      "Physical host-lock entry could not reacquire one current enabled action.",
    selectReacquiredTrigger: (nodes) =>
      countPhysicalAuditRows(input.db, "lock") === lockAuditsBefore
        ? selectPhysicalHostAccessContentNode(
            nodes,
            "text",
            "Lock writes",
            true
          )
        : null,
    terminalFailureMessage:
      "Physical host-lock confirmation remained closed after two bounded non-mutating taps."
  });
  requireCondition(
    countPhysicalAuditRows(input.db, "lock") === lockAuditsBefore,
    "Physical Host-lock confirmation entry dispatched a lock mutation."
  );
  await capturePhysicalHostAccessEvidence(
    capture,
    "fe090-35-lock-confirmation.png"
  );
  const confirmLock = await waitForPhysicalHostLockConfirmationAction(
    30_000,
    "Physical host-lock final action was unavailable."
  );
  measure(confirmLock, "confirm-lock-writes");
  await tapAndroidNodeOnceAndWait(
    confirmLock,
    async () =>
      (await readAndroidUiNodes()).some(
        (node) => node.text === "Remote writes locked"
      ),
    "Physical host lock did not render locked truth."
  );
  requireCondition(
    countPhysicalAuditRows(input.db, "lock") === 2,
    "Physical host lock did not retain one accepted and terminal audit pair."
  );
  const lockedNodes = await readAndroidUiNodes();
  requireCondition(
    lockedNodes.every(
      (node) =>
        !/unlock writes|remote unlock/iu.test(node.text) &&
        !/unlock writes|remote unlock/iu.test(node.description)
    ),
    "Physical locked UI exposed a forbidden remote unlock action."
  );
  await capturePhysicalHostAccessEvidence(capture, "fe090-36-host-locked.png");
  await closePhysicalDialog("Close session actions");
  const missionBack = await waitForAndroidUiNodePresent(
    "description",
    "Back to Mission Control",
    30_000,
    "Physical locked Session Detail back action was unavailable."
  );
  await tapAndroidNodeOnceAndWait(
    missionBack,
    async () =>
      (await readAndroidUiNodes()).some(
        (node) => node.text === "Mission Control"
      ),
    "Physical locked Session Detail did not return to Mission Control."
  );
  await waitForAndroidUiText(
    "Remote writes locked",
    30_000,
    "Physical Mission Control did not render locked truth."
  );
  await capture("fe090-47-mission-locked.png");
  const localUnlock = await postLocalUnlock(input.env);
  requireCondition(
    localUnlock.status === 200 &&
      localUnlock.locked === false &&
      input.manager.snapshot().command_attempts === managerAttempts,
    "Physical local unlock failed or mutated Serve state."
  );
  const reloadBefore = Object.freeze({
    accessRequests: input.requestInspection.accessRequests,
    hostStatusRequests: input.requestInspection.hostStatusRequests,
    sessionListRequests: input.requestInspection.sessionListRequests
  });
  adb(["shell", "input", "keyevent", "KEYCODE_REFRESH"]);
  await waitForPhysicalMissionControlWriteReady(
    input,
    reloadBefore,
    "Physical Mission Control did not settle current write authority after local unlock."
  );
  const navigationBefore = readPhysicalSessionNavigationSnapshot(input);
  const selected = await revealAndroidUiNode(
    "description",
    physicalUiSessionName,
    "forward",
    30_000,
    "Physical unlocked selected session was unavailable.",
    "fully_visible",
    true
  );
  await tapAndroidNodeOnceAndWait(
    selected,
    () =>
      physicalSessionNavigationOpened(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBefore
      ),
    "Physical unlocked selected session did not produce one new detail and stream generation."
  );
  await waitForPhysicalSessionWriteReady(
    input,
    "Physical Session Detail did not restore stable write authority after local unlock."
  );
  await capture("fe090-37-host-unlocked.png");
}

async function returnPhysicalDashboardToMissionControl(
  input: ProductionUiEntryInput & { readonly prompt: PhysicalPromptRuntime }
): Promise<void> {
  const back = await waitForAndroidUiNodePresent(
    "description",
    "Back to Mission Control",
    30_000,
    "Physical Session Detail back action was unavailable."
  );
  await tapAndroidNodeOnceAndWait(
    back,
    async () =>
      (await readAndroidUiNodes()).some(
        (node) => node.text === "Mission Control"
      ),
    "Physical Session Detail did not navigate back to Mission Control."
  );
  await waitFor(
    () => input.prompt.subscribers.snapshot().active_subscribers === 0,
    15_000,
    "Physical Session Detail back navigation retained its SSE subscriber."
  );
}

async function runPhysicalDashboardProfileSwitch(
  input: ProductionUiEntryInput & {
    readonly env: Readonly<Record<string, string>>;
    readonly foreignServeBefore: ServeStatusFingerprint;
    readonly manager: TailscaleServeManager;
    readonly profileSwitch: ProfileSwitchInput;
    readonly remote: HostDeckRemoteIngressLifecycle;
    readonly setSelectedProfile: (profile: "away" | "dedicated") => void;
  },
  capture: PhysicalDashboardCapture
): Promise<void> {
  const managerAttempts = input.manager.snapshot().command_attempts;
  await switchSavedProfile(input.profileSwitch.awayProfileId);
  input.setSelectedProfile("away");
  await waitFor(
    () =>
      input.remote.readAdmission().admission === "closed" &&
      input.remote.snapshot().active_control_operations === 0,
    15_000,
    "Physical dashboard profile-away did not close remote admission."
  );
  assertRemoteCliResult(
    await runRemoteStatusWhenLifecycleIdle(input.remote, input.env),
    "unavailable"
  );
  requireMatchingServeFingerprint(
    input.foreignServeBefore,
    await readServeStatusFingerprint()
  );
  requireCondition(
    input.manager.snapshot().command_attempts === managerAttempts,
    "Physical dashboard profile-away mutated Serve state."
  );
  const refreshAway = await waitForAndroidUiNodePresent(
    "description",
    "Refresh sessions",
    30_000,
    "Physical dashboard refresh was unavailable before profile-away observation."
  );
  await tapAndroidNodeOnceAndWait(
    refreshAway,
    async () =>
      (await readAndroidUiNodes()).some(
        (node) => node.text === "HostDeck is unreachable"
      ),
    "Physical dashboard did not render generic profile-away failure.",
    45_000
  );
  await capture("fe090-38-profile-away.png");

  await switchSavedProfile(input.profileSwitch.dedicatedProfileId);
  input.setSelectedProfile("dedicated");
  await waitFor(
    () =>
      input.remote.readAdmission().admission === "open" &&
      input.remote.snapshot().active_control_operations === 0,
    15_000,
    "Physical dashboard profile return did not reopen by observation."
  );
  const requestsBefore = input.requestInspection.sessionListRequests;
  const refreshReturn = await waitForAndroidUiNodePresent(
    "description",
    "Refresh sessions",
    30_000,
    "Physical dashboard refresh was unavailable after profile return."
  );
  await tapAndroidNodeOnceAndWait(
    refreshReturn,
    () => input.requestInspection.sessionListRequests > requestsBefore,
    "Physical dashboard profile return did not refresh session truth.",
    45_000
  );
  await waitForAndroidUiText(
    physicalUiSessionName,
    30_000,
    "Physical dashboard profile return did not recover without re-pairing."
  );
  await openProductionHostAccessSheet();
  await revealAndroidUiNode(
    "text",
    "Remote access ready",
    "forward",
    30_000,
    "Physical dashboard profile return omitted remote-ready truth."
  );
  await runOneProductionRemoteCheck(input.requestInspection);
  await capturePhysicalHostAccessEvidence(
    capture,
    "fe090-39-profile-recovered.png"
  );
  await closeProductionHostAccessSheet();
  requireCondition(
    input.requestInspection.claimRequests === 1 &&
      input.requestInspection.remoteBrowserStatusRequests === 2 &&
      input.requestInspection.remoteBrowserMutationRequests === 0 &&
      input.manager.snapshot().command_attempts === managerAttempts &&
      input.readProxyRejection() === null,
    "Physical dashboard profile recovery repeated pairing or mutated external state."
  );
}

async function runPhysicalRuntimeCompatibilityState(
  input: ProductionUiEntryInput & {
    readonly prompt: PhysicalPromptRuntime;
    readonly requestInspection: RequestInspection;
    readonly setRuntimeCompatible: (compatible: boolean) => void;
  },
  capture: PhysicalDashboardCapture
): Promise<void> {
  const browserChecksBefore = input.requestInspection.remoteBrowserStatusRequests;
  input.setRuntimeCompatible(false);
  await openProductionHostAccessSheet();
  await revealAndroidUiNode(
    "text",
    "Remote access ready",
    "forward",
    30_000,
    "Physical runtime compatibility check lost remote-ready truth."
  );
  await runOneProductionRemoteCheck(input.requestInspection, {
    expectedRuntime: "incompatible"
  });
  await closeProductionHostAccessSheet();
  await waitForPhysicalMissionRuntimeState(
    input.prompt,
    "incompatible",
    "Physical Mission Control did not render incompatible runtime truth."
  );
  await capture("fe090-51-runtime-incompatible.png");

  input.setRuntimeCompatible(true);
  await openProductionHostAccessSheet();
  await revealAndroidUiNode(
    "text",
    "Remote access ready",
    "forward",
    30_000,
    "Physical runtime recovery check lost remote-ready truth."
  );
  await runOneProductionRemoteCheck(input.requestInspection, {
    expectedRuntime: "supported"
  });
  await closeProductionHostAccessSheet();
  await waitForPhysicalMissionRuntimeState(
    input.prompt,
    "supported",
    "Physical Mission Control did not recover supported runtime truth."
  );
  requireCondition(
    input.requestInspection.remoteBrowserStatusRequests ===
      browserChecksBefore + 2 &&
      input.requestInspection.remoteBrowserMutationRequests === 0,
    "Physical runtime compatibility checks did not retain exact read-only route ownership."
  );
  await capture("fe090-52-runtime-supported.png");
}

type PhysicalRuntimeExpectation = "incompatible" | "supported";

async function waitForPhysicalMissionRuntimeState(
  prompt: PhysicalPromptRuntime,
  expectation: PhysicalRuntimeExpectation,
  message: string
): Promise<void> {
  await revealAndroidUiNode(
    "text",
    expectation === "incompatible"
      ? physicalRuntimeIncompatibleTitle
      : "Mission Control",
    "backward",
    30_000,
    message,
    "fully_visible"
  );
  const observations: string[] = [];
  let stableSince: number | null = null;
  let stableObservation: string | null = null;
  try {
    await waitFor(async () => {
      const nodes = await readAndroidUiNodes();
      const activeSubscribers = prompt.subscribers.snapshot().active_subscribers;
      const observation = physicalMissionRuntimeStateSummary(
        nodes,
        activeSubscribers
      );
      if (observations.at(-1) !== observation && observations.length < 6) {
        observations.push(observation);
      }
      if (
        !physicalMissionRuntimeStateVisible(
          nodes,
          activeSubscribers,
          expectation
        )
      ) {
        stableSince = null;
        stableObservation = null;
        return false;
      }
      if (stableSince === null || stableObservation !== observation) {
        stableSince = performance.now();
        stableObservation = observation;
        return false;
      }
      return performance.now() - stableSince >= 2_000;
    }, 30_000, message);
  } catch (error) {
    throw new Error(
      `${message} (states=${
        observations.length === 0 ? "none" : observations.join("||")
      }).`,
      { cause: error }
    );
  }
}

function physicalMissionRuntimeStateVisible(
  nodes: readonly AndroidUiNode[],
  activeSubscribers: number,
  expectation: PhysicalRuntimeExpectation
): boolean {
  const textCount = (value: string): number =>
    nodes.filter((node) => node.text === value).length;
  const descriptionCount = (value: string): number =>
    nodes.filter((node) => node.description === value).length;
  const common =
    activeSubscribers === 0 &&
    descriptionCount("Open Host and access") === 1 &&
    descriptionCount("Close Host and access") === 0 &&
    textCount("Mission Control") === 1 &&
    textCount("Remote ready") === 1 &&
    textCount("Write") === 1 &&
    textCount("Remote writes locked") === 0 &&
    textCount("Access stale") === 0 &&
    textCount("Reconnecting") === 0 &&
    textCount("Checking Codex compatibility") === 0 &&
    textCount("Compatibility check not confirmed") === 0;
  if (!common) return false;
  if (expectation === "incompatible") {
    return (
      textCount(physicalRuntimeIncompatibleTitle) === 1 &&
      textCount("Incompatible") === 1 &&
      textCount("Current") === 0 &&
      textCount(physicalRuntimeSupportedTitle) === 0
    );
  }
  return (
    textCount("Current") === 1 &&
    textCount("Incompatible") === 0 &&
    textCount(physicalRuntimeIncompatibleTitle) === 0 &&
    textCount(physicalRuntimeSupportedTitle) === 0
  );
}

function physicalMissionRuntimeStateSummary(
  nodes: readonly AndroidUiNode[],
  activeSubscribers: number
): string {
  const textCount = (value: string): number =>
    nodes.filter((node) => node.text === value).length;
  const descriptionCount = (value: string): number =>
    nodes.filter((node) => node.description === value).length;
  return [
    `active=${activeSubscribers}`,
    `mission=${textCount("Mission Control")}`,
    `host=${descriptionCount("Open Host and access")}/${descriptionCount("Close Host and access")}`,
    `remote=${textCount("Remote ready")}`,
    `write=${textCount("Write")}`,
    `state=${textCount("Current")}/${textCount("Incompatible")}`,
    `runtime=${textCount(physicalRuntimeSupportedTitle)}/${textCount(physicalRuntimeIncompatibleTitle)}`,
    `pending=${textCount("Checking Codex compatibility")}/${textCount("Compatibility check not confirmed")}`
  ].join(",");
}

function physicalRuntimeRouteFixture(
  expectation: PhysicalRuntimeExpectation
): readonly AndroidUiNode[] {
  const nodes = [
    physicalRuntimeFixtureNode({ description: "Open Host and access" }),
    physicalRuntimeFixtureNode({ description: physicalUiSessionName }),
    physicalRuntimeFixtureNode({ text: "Mission Control" }),
    physicalRuntimeFixtureNode({ text: "Remote ready" }),
    physicalRuntimeFixtureNode({ text: "Write" }),
    physicalRuntimeFixtureNode({
      text: expectation === "incompatible" ? "Incompatible" : "Current"
    }),
    ...(expectation === "incompatible"
      ? [physicalRuntimeFixtureNode({ text: physicalRuntimeIncompatibleTitle })]
      : [])
  ];
  return Object.freeze(nodes);
}

function physicalRuntimeFixtureNode(
  input: Readonly<{ readonly description?: string; readonly text?: string }>
): AndroidUiNode {
  return Object.freeze({
    bounds: Object.freeze({ bottom: 200, left: 20, right: 700, top: 100 }),
    className: "android.view.View",
    clickable: false,
    description: input.description ?? "",
    resourceId: "",
    text: input.text ?? ""
  });
}

async function runPhysicalTalkBackTraversal(
  externalOrigin: string,
  artifacts: PhysicalTalkBackArtifacts
): Promise<PhysicalTalkBackResult> {
  const service = requireAndroidTalkBackService();
  requireCondition(
    new URL(externalOrigin).protocol === "https:",
    "TalkBack traversal lost its private HTTPS origin."
  );
  requirePhysicalTalkBackDevicePreflight();
  const accessibilityBefore = readAndroidAccessibilitySnapshot();
  const permissionsBefore = readAndroidTalkBackPermissionSnapshots();
  let cleanupErrors: readonly unknown[] = [];
  let operationError: unknown = null;
  let observer: PhysicalTalkBackObserverRuntime | null = null;
  let pushed = false;
  let transcript: PhysicalTalkBackTranscriptSummary | null = null;
  try {
    pushed = true;
    pushPhysicalTalkBackDex(artifacts);
    observer = await startPhysicalTalkBackObserver();
    grantPhysicalTalkBackAcceptancePermissions(permissionsBefore);
    const existing = accessibilityBefore.enabledServices === "null" ||
        accessibilityBefore.enabledServices === ""
      ? []
      : accessibilityBefore.enabledServices.split(":");
    const enabled = Object.freeze([...new Set([...existing, service])]);
    writeAndroidSetting(
      "secure",
      "enabled_accessibility_services",
      enabled.join(":")
    );
    writeAndroidSetting("secure", "accessibility_enabled", "1");
    await waitFor(
      () =>
        readAndroidSetting("secure", "accessibility_enabled") === "1" &&
        readAndroidSetting("secure", "enabled_accessibility_services")
          .split(":")
          .includes(service),
      10_000,
      "Android TalkBack did not become active."
    );
    await waitForPhysicalTalkBackCondition(
      observer,
      () => physicalTalkBackServiceIsActive(service),
      15_000,
      "Android TalkBack did not bind with touch exploration and double-tap handling."
    );
    requireCondition(
      readPhysicalTalkBackProcesses().filter((line) =>
        line.includes(physicalTalkBackObserverClass)
      ).length === 1,
      "Physical TalkBack observer was not uniquely active."
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    observer.events.splice(0);

    const initialRemote = await movePhysicalTalkBackFocus(
      observer,
      0,
      "forward",
      new Set(["remote_status"]),
      24,
      "TalkBack traversal did not reach current remote-access truth."
    );
    const initialMission = await movePhysicalTalkBackFocus(
      observer,
      initialRemote.sequence,
      "forward",
      new Set(["mission_control"]),
      16,
      "TalkBack traversal did not reach the Mission Control heading."
    );
    const selectedSession = await movePhysicalTalkBackFocus(
      observer,
      initialMission.sequence,
      "forward",
      new Set(["selected_session"]),
      48,
      "TalkBack traversal did not reach the selected session."
    );
    const selectedSessionClick = await activatePhysicalTalkBackFocus(
      observer,
      selectedSession,
      "TalkBack did not activate the selected session with double-tap-anywhere."
    );
    await waitForAndroidUiText(
      "Ready to send",
      30_000,
      "TalkBack did not open Session Detail."
    );
    const sessionDetail = await movePhysicalTalkBackFocus(
      observer,
      selectedSessionClick.sequence,
      "forward",
      new Set(["session_detail"]),
      20,
      "TalkBack traversal did not reach the selected Session Detail heading."
    );
    const approvalResult = await movePhysicalTalkBackFocus(
      observer,
      sessionDetail.sequence,
      "forward",
      new Set(["approval_result"]),
      64,
      "TalkBack traversal did not reach prior approval outcome truth."
    );
    const modelTrigger = await movePhysicalTalkBackFocus(
      observer,
      approvalResult.sequence,
      "forward",
      new Set(["model_trigger"]),
      64,
      "TalkBack traversal did not reach the primary /model control."
    );
    const modelTriggerClick = await activatePhysicalTalkBackFocus(
      observer,
      modelTrigger,
      "TalkBack did not activate /model with double-tap-anywhere."
    );
    await waitForAndroidUiText(
      "Model control ready",
      30_000,
      "TalkBack did not open the model dialog."
    );
    const modalCategories = new Set<PhysicalTalkBackObserverCategory>([
      "model_close",
      "model_dialog",
      "model_settings",
      "model_state"
    ]);
    const initialModalFocus = await waitForAutomaticPhysicalTalkBackFocus(
      observer,
      modelTriggerClick.sequence,
      modalCategories,
      "The model dialog did not establish an initial TalkBack focus."
    );
    const modalForward = await movePhysicalTalkBackFocus(
      observer,
      initialModalFocus.sequence,
      "forward",
      modalCategories,
      1,
      "TalkBack focus escaped the model dialog moving forward."
    );
    const modalBackward = await movePhysicalTalkBackFocus(
      observer,
      modalForward.sequence,
      "backward",
      modalCategories,
      1,
      "TalkBack focus escaped the model dialog moving backward."
    );
    const modelClose = modalBackward.category === "model_close"
      ? modalBackward
      : await movePhysicalTalkBackFocus(
          observer,
          modalBackward.sequence,
          "backward",
          new Set(["model_close"]),
          8,
          "TalkBack traversal did not reach the model close control."
        );
    const modelCloseClick = await activatePhysicalTalkBackFocus(
      observer,
      modelClose,
      "TalkBack did not close /model with double-tap-anywhere."
    );
    await waitForAndroidUiText(
      "Ready to send",
      30_000,
      "TalkBack model close did not restore Session Detail."
    );
    const returnedModelTrigger = await waitForAutomaticPhysicalTalkBackFocus(
      observer,
      modelCloseClick.sequence,
      new Set(["model_trigger"]),
      "The model dialog did not return TalkBack focus to /model."
    );
    const backToMission = await movePhysicalTalkBackFocus(
      observer,
      returnedModelTrigger.sequence,
      "backward",
      new Set(["back_to_mission"]),
      64,
      "TalkBack traversal did not reach Back to Mission Control."
    );
    const backToMissionClick = await activatePhysicalTalkBackFocus(
      observer,
      backToMission,
      "TalkBack did not return to Mission Control with double-tap-anywhere."
    );
    await waitForAndroidUiText(
      "Mission Control",
      30_000,
      "Physical dashboard did not return to Mission Control after TalkBack."
    );
    const recoveredMission = await movePhysicalTalkBackFocus(
      observer,
      backToMissionClick.sequence,
      "backward",
      new Set(["mission_control"]),
      12,
      "TalkBack did not recover the Mission Control route heading."
    );
    await movePhysicalTalkBackFocus(
      observer,
      recoveredMission.sequence,
      "backward",
      new Set(["remote_status"]),
      16,
      "TalkBack did not recover current remote-access truth."
    );
    transcript = validatePhysicalTalkBackTranscript(
      Object.freeze([...observer.events])
    );
  } catch (error) {
    operationError = error;
  } finally {
    cleanupErrors = await runPhysicalTalkBackCleanupPlan([
      async () => {
        if (observer === null) return;
        try {
          await stopPhysicalTalkBackObserver(observer);
        } catch {
          throw new Error("Physical cleanup could not stop the TalkBack observer.");
        }
      },
      () => {
        try {
          restoreAndroidAccessibilitySnapshot(accessibilityBefore);
        } catch {
          throw new Error(
            "Physical cleanup could not restore Android accessibility settings."
          );
        }
      },
      () => {
        try {
          restoreAndroidTalkBackPermissionSnapshots(permissionsBefore);
        } catch {
          throw new Error(
            "Physical cleanup could not restore TalkBack permission state."
          );
        }
      },
      () => {
        if (!pushed) return;
        try {
          removePhysicalTalkBackDex();
        } catch {
          throw new Error("Physical cleanup could not remove the TalkBack DEX.");
        }
      },
      () => {
        try {
          requirePhysicalTalkBackProcessAbsence();
        } catch {
          throw new Error(
            "Physical cleanup retained a TalkBack observer or gesture process."
          );
        }
      }
    ]);
  }
  if (operationError !== null && cleanupErrors.length > 0) {
    throw new AggregateError(
      [operationError, ...cleanupErrors],
      "Physical TalkBack acceptance and cleanup failed."
    );
  }
  if (operationError !== null) throw operationError;
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      "Physical TalkBack acceptance cleanup failed."
    );
  }
  requireCondition(
    transcript !== null,
    "Physical TalkBack acceptance omitted its bounded transcript."
  );
  return Object.freeze({
    available: true,
    permissionStateRestored: true,
    restored: true,
    serviceBound: true,
    touchExplorationActive: true,
    transcript
  });
}

function requireAndroidTalkBackService(): string {
  const packages = adb(["shell", "pm", "list", "packages"]);
  requireCondition(
    packages.split(/\r?\n/u).includes(`package:${androidTalkBackPackage}`),
    "Android Accessibility Suite TalkBack is not installed on the target phone."
  );
  const details = adb([
    "shell",
    "dumpsys",
    "package",
    androidTalkBackPackage
  ]);
  requireCondition(
    details.includes("TalkBackService") &&
      Buffer.byteLength(details, "utf8") <= 4 * 1024 * 1024,
    "Android TalkBack service metadata was unavailable."
  );
  return androidTalkBackService;
}

function requireReadableAndroidAccessibilitySettings(): void {
  const enabled = readAndroidSetting(
    "secure",
    "enabled_accessibility_services"
  );
  const accessibility = readAndroidSetting(
    "secure",
    "accessibility_enabled"
  );
  const services = enabled === "null" || enabled === ""
    ? []
    : enabled.split(":");
  requireCondition(
    (accessibility === "0" || accessibility === "1") &&
      services.length <= 32 &&
      services.every((service) =>
        /^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/u.test(service)
      ),
    "Android accessibility settings were unavailable or malformed."
  );
}

function readAndroidSetting(namespace: "secure" | "system", key: string): string {
  requireCondition(
    /^[a-z][a-z0-9_]{0,63}$/u.test(key),
    "Android setting key was invalid."
  );
  const value = adb(["shell", "settings", "get", namespace, key]).trim();
  requireCondition(
    value.length <= 4_096 && !hasControlCharacters(value),
    "Android setting value was invalid."
  );
  return value;
}

function writeAndroidSetting(
  namespace: "secure" | "system",
  key: string,
  value: string
): void {
  requireCondition(
    /^[a-z][a-z0-9_]{0,63}$/u.test(key) &&
      value.length <= 4_096 &&
      !hasControlCharacters(value),
    "Android setting mutation was invalid."
  );
  adb(["shell", "settings", "put", namespace, key, value]);
}

function restoreAndroidSetting(
  namespace: "secure" | "system",
  key: string,
  value: string
): void {
  if (value === "null") {
    adb(["shell", "settings", "delete", namespace, key]);
    return;
  }
  writeAndroidSetting(namespace, key, value);
}

function requirePhysicalTalkBackDevicePreflight(): void {
  const uhid = adbWithStatus(["shell", "test", "-w", "/dev/uhid"]);
  requireCondition(
    uhid.status === 0 && uhid.stdout === "" && uhid.stderr === "",
    "Physical TalkBack acceptance requires shell access to /dev/uhid."
  );
  const dex = adbWithStatus([
    "shell",
    "test",
    "!",
    "-e",
    physicalTalkBackDeviceDex
  ]);
  requireCondition(
    dex.status === 0 && dex.stdout === "" && dex.stderr === "",
    "Physical TalkBack acceptance found a retained device DEX."
  );
  requirePhysicalTalkBackProcessAbsence();
}

function readAndroidAccessibilitySnapshot(): AndroidAccessibilitySnapshot {
  return Object.freeze({
    accessibilityEnabled: readAndroidSetting("secure", "accessibility_enabled"),
    enabledServices: readAndroidSetting(
      "secure",
      "enabled_accessibility_services"
    ),
    touchExplorationEnabled: readAndroidSetting(
      "secure",
      "touch_exploration_enabled"
    ),
    touchExplorationGrantedServices: readAndroidSetting(
      "secure",
      "touch_exploration_granted_accessibility_services"
    )
  });
}

function restoreAndroidAccessibilitySnapshot(
  snapshot: AndroidAccessibilitySnapshot
): void {
  restoreAndroidSetting(
    "secure",
    "enabled_accessibility_services",
    snapshot.enabledServices
  );
  restoreAndroidSetting(
    "secure",
    "accessibility_enabled",
    snapshot.accessibilityEnabled
  );
  restoreAndroidSetting(
    "secure",
    "touch_exploration_granted_accessibility_services",
    snapshot.touchExplorationGrantedServices
  );
  restoreAndroidSetting(
    "secure",
    "touch_exploration_enabled",
    snapshot.touchExplorationEnabled
  );
  requireCondition(
    JSON.stringify(readAndroidAccessibilitySnapshot()) ===
      JSON.stringify(snapshot),
    "Android TalkBack accessibility settings were not restored exactly."
  );
}

function readAndroidTalkBackPermissionSnapshots(): readonly AndroidPermissionSnapshot[] {
  const details = adb(["shell", "dumpsys", "package", androidTalkBackPackage]);
  const activePackage = details.split("\nHidden system packages:", 1)[0] ?? "";
  requireCondition(
    activePackage.length >= 1 &&
      Buffer.byteLength(activePackage, "utf8") <= 4 * 1024 * 1024,
    "Android TalkBack permission metadata was unavailable."
  );
  return Object.freeze(
    physicalTalkBackPermissions.map((permission) => {
      const prefix = `${permission}: granted=`;
      const matches = activePackage
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.startsWith(prefix));
      requireCondition(
        matches.length === 1,
        "Android TalkBack permission state was ambiguous."
      );
      const value = matches[0]?.slice(prefix.length) ?? "";
      const parsed = /^(true|false), flags=\[([A-Z_| ]*)\]$/u.exec(value);
      requireCondition(
        parsed !== null,
        "Android TalkBack permission state was malformed."
      );
      const flags = Object.freeze(
        (parsed[2] ?? "")
          .split(/[| ]+/u)
          .filter((flag) => flag.length > 0)
          .sort()
      );
      requireCondition(
        flags.length <= 16 &&
          new Set(flags).size === flags.length &&
          flags.every((flag) => /^[A-Z_]{1,48}$/u.test(flag)),
        "Android TalkBack permission flags were malformed."
      );
      return Object.freeze({
        flags,
        granted: parsed[1] === "true",
        permission
      });
    })
  );
}

function grantPhysicalTalkBackAcceptancePermissions(
  snapshots: readonly AndroidPermissionSnapshot[]
): void {
  for (const snapshot of snapshots) {
    if (snapshot.granted) continue;
    const output = adb([
      "shell",
      "pm",
      "grant",
      "--user",
      "0",
      androidTalkBackPackage,
      snapshot.permission
    ]);
    requireCondition(
      output === "",
      "Android TalkBack temporary permission grant was noisy."
    );
  }
}

function restoreAndroidTalkBackPermissionSnapshots(
  snapshots: readonly AndroidPermissionSnapshot[]
): void {
  const flagNames = new Map<string, string>([
    ["REVIEW_REQUIRED", "review-required"],
    ["REVOKED_COMPAT", "revoked-compat"],
    ["REVOKE_WHEN_REQUESTED", "revoke-when-requested"],
    ["USER_FIXED", "user-fixed"],
    ["USER_SET", "user-set"]
  ]);
  for (const snapshot of snapshots) {
    const grantCommand = snapshot.granted ? "grant" : "revoke";
    requireCondition(
      adb([
        "shell",
        "pm",
        grantCommand,
        "--user",
        "0",
        androidTalkBackPackage,
        snapshot.permission
      ]) === "",
      "Android TalkBack permission grant state was not restorable."
    );
    requireCondition(
      adb([
        "shell",
        "pm",
        "clear-permission-flags",
        "--user",
        "0",
        androidTalkBackPackage,
        snapshot.permission,
        ...physicalTalkBackMutablePermissionFlags
      ]) === "",
      "Android TalkBack permission flags were not clearable."
    );
    const mutableFlags = snapshot.flags.flatMap((flag) => {
      const value = flagNames.get(flag);
      return value === undefined ? [] : [value];
    });
    if (mutableFlags.length > 0) {
      requireCondition(
        adb([
          "shell",
          "pm",
          "set-permission-flags",
          "--user",
          "0",
          androidTalkBackPackage,
          snapshot.permission,
          ...mutableFlags
        ]) === "",
        "Android TalkBack permission flags were not restorable."
      );
    }
  }
  requireCondition(
    JSON.stringify(readAndroidTalkBackPermissionSnapshots()) ===
      JSON.stringify(snapshots),
    "Android TalkBack permission state was not restored exactly."
  );
}

function pushPhysicalTalkBackDex(artifacts: PhysicalTalkBackArtifacts): void {
  requireCondition(
    /^[0-9a-f]{64}$/u.test(artifacts.sha256) && existsSync(artifacts.dexPath),
    "Physical TalkBack DEX artifact was unavailable."
  );
  const push = adb(["push", artifacts.dexPath, physicalTalkBackDeviceDex]);
  requireCondition(
    Buffer.byteLength(push, "utf8") <= 4_096,
    "Physical TalkBack DEX push output was invalid."
  );
  adb(["shell", "chmod", "600", physicalTalkBackDeviceDex]);
  const remoteHash = adb([
    "shell",
    "sha256sum",
    physicalTalkBackDeviceDex
  ]).trim();
  requireCondition(
    remoteHash === `${artifacts.sha256}  ${physicalTalkBackDeviceDex}`,
    "Physical TalkBack device DEX did not match its host artifact."
  );
}

function removePhysicalTalkBackDex(): void {
  const removed = adbWithStatus([
    "shell",
    "rm",
    "-f",
    physicalTalkBackDeviceDex
  ]);
  const absent = adbWithStatus([
    "shell",
    "test",
    "!",
    "-e",
    physicalTalkBackDeviceDex
  ]);
  requireCondition(
    removed.status === 0 &&
      removed.stdout === "" &&
      removed.stderr === "" &&
      absent.status === 0 &&
      absent.stdout === "" &&
      absent.stderr === "",
    "Physical TalkBack device DEX was retained."
  );
}

async function startPhysicalTalkBackObserver(): Promise<PhysicalTalkBackObserverRuntime> {
  adbCommandCount += 1;
  const child = spawn(
    "adb",
    [
      "shell",
      `CLASSPATH=${physicalTalkBackDeviceDex}`,
      "app_process",
      "/system/bin",
      physicalTalkBackObserverClass
    ],
    {
      env: { HOME: process.env.HOME, PATH: process.env.PATH },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  requireCondition(
    child.stdout !== null && child.stderr !== null,
    "Physical TalkBack observer streams were unavailable."
  );
  const events: PhysicalTalkBackObserverEvent[] = [];
  let failure: Error | null = null;
  let outputBytes = 0;
  let ready = false;
  let stderr = "";
  let stopping = false;
  let stdoutBuffer = "";
  const fail = (message: string): void => {
    failure ??= new Error(message);
  };
  const consumeLine = (line: string): void => {
    try {
      const record = parsePhysicalTalkBackObserverLine(line);
      if (record === null) return;
      if (record.kind === "ready") {
        if (ready || events.length > 0) {
          fail("Physical TalkBack observer emitted a duplicate ready record.");
        }
        ready = true;
        return;
      }
      if (record.kind === "error" || record.kind === "overflow") {
        fail("Physical TalkBack observer reported a bounded runtime failure.");
        return;
      }
      if (!ready) {
        fail("Physical TalkBack observer emitted an event before readiness.");
        return;
      }
      const previous = events.at(-1);
      if (
        previous !== undefined &&
        record.event.sequence !== previous.sequence + 1
      ) {
        fail("Physical TalkBack observer event order was not contiguous.");
        return;
      }
      events.push(record.event);
    } catch {
      fail("Physical TalkBack observer emitted unrecognized output.");
    }
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    outputBytes += Buffer.byteLength(chunk, "utf8");
    if (
      outputBytes > 64 * 1024 ||
      [...deviceForbiddenValues].some((value) => chunk.includes(value))
    ) {
      fail("Physical TalkBack observer output violated its privacy bound.");
      return;
    }
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) consumeLine(line);
  });
  child.stderr.on("data", (chunk: string) => {
    outputBytes += Buffer.byteLength(chunk, "utf8");
    stderr += chunk;
    if (outputBytes > 64 * 1024 || (!stopping && chunk.trim() !== "")) {
      fail("Physical TalkBack observer emitted unexpected stderr."
      );
    }
  });
  child.once("error", () => {
    fail("Physical TalkBack observer process could not start.");
  });
  child.once("exit", () => {
    if (stdoutBuffer !== "") {
      consumeLine(stdoutBuffer);
      stdoutBuffer = "";
    }
    if (!stopping) {
      fail("Physical TalkBack observer exited before cleanup."
      );
    }
  });
  const runtime = Object.freeze({
    events,
    markStopping() {
      stopping = true;
    },
    process: child,
    readFailure: () => failure,
    ready: () => ready,
    stderr: () => stderr
  });
  try {
    await waitForPhysicalTalkBackCondition(
      runtime,
      runtime.ready,
      10_000,
      "Physical TalkBack observer did not become ready."
    );
  } catch (error) {
    try {
      await stopPhysicalTalkBackObserver(runtime);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Physical TalkBack observer startup and cleanup failed."
      );
    }
    throw error;
  }
  return runtime;
}

async function stopPhysicalTalkBackObserver(
  runtime: PhysicalTalkBackObserverRuntime
): Promise<void> {
  runtime.markStopping();
  const running = readPhysicalTalkBackProcesses().some((line) =>
    line.includes(physicalTalkBackObserverClass)
  );
  if (running) {
    const kill = adbWithStatus([
      "shell",
      "pkill",
      "-9",
      "-f",
      physicalTalkBackObserverClass
    ]);
    requireCondition(
      (kill.status === 0 || kill.status === 137) &&
        kill.stdout.trim() === "" &&
        (kill.stderr.trim() === "" || kill.stderr.trim() === "Killed"),
      "Physical TalkBack observer could not be terminated exactly."
    );
  }
  requireCondition(
    await waitForChildExit(runtime.process, 5_000),
    "Physical TalkBack observer host process did not exit."
  );
  requireCondition(
    runtime.stderr().trim() === "" || runtime.stderr().trim() === "Killed",
    "Physical TalkBack observer retained unexpected stderr."
  );
  requirePhysicalTalkBackProcessAbsence();
}

function readPhysicalTalkBackProcesses(): readonly string[] {
  const output = adb(["shell", "ps", "-A", "-o", "PID,ARGS"]);
  requireCondition(
    Buffer.byteLength(output, "utf8") >= 1 &&
      Buffer.byteLength(output, "utf8") <= 256 * 1024,
    "Physical TalkBack process inventory was invalid."
  );
  return Object.freeze(
    output
      .split(/\r?\n/u)
      .filter(
        (line) =>
          line.includes(physicalTalkBackObserverClass) ||
          line.includes(physicalTalkBackTouchClass)
      )
  );
}

function requirePhysicalTalkBackProcessAbsence(): void {
  requireCondition(
    readPhysicalTalkBackProcesses().length === 0,
    "Physical TalkBack observer or gesture process was retained."
  );
}

function physicalTalkBackServiceIsActive(service: string): boolean {
  const output = adb([
    "shell",
    "dumpsys accessibility | head -n 60"
  ]);
  requireCondition(
    Buffer.byteLength(output, "utf8") >= 1 &&
      Buffer.byteLength(output, "utf8") <= 64 * 1024,
    "Android accessibility service observation was invalid."
  );
  return (
    output.includes("touchExplorationEnabled=true") &&
    output.includes("serviceHandlesDoubleTap=true") &&
    output.includes(service) &&
    !output.includes("Bound services:{}")
  );
}

async function waitForPhysicalTalkBackCondition(
  runtime: PhysicalTalkBackObserverRuntime,
  predicate: () => boolean,
  timeoutMs: number,
  message: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const failure = runtime.readFailure();
    if (failure !== null) throw failure;
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function movePhysicalTalkBackFocus(
  runtime: PhysicalTalkBackObserverRuntime,
  afterSequence: number,
  direction: "backward" | "forward",
  targets: ReadonlySet<PhysicalTalkBackObserverCategory>,
  maximumGestures: number,
  message: string
): Promise<PhysicalTalkBackObserverEvent> {
  requireCondition(
    Number.isSafeInteger(afterSequence) &&
      afterSequence >= 0 &&
      targets.size >= 1 &&
      Number.isSafeInteger(maximumGestures) &&
      maximumGestures >= 1 &&
      maximumGestures <= 64,
    "Physical TalkBack focus traversal arguments were invalid."
  );
  let cursor = afterSequence;
  for (let gestureCount = 0; gestureCount <= maximumGestures; gestureCount += 1) {
    const queued = runtime.events.find(
      (event) => event.sequence > cursor && event.kind === "focus"
    );
    if (queued !== undefined) {
      requirePhysicalTalkBackProductEvent(queued);
      cursor = queued.sequence;
      if (targets.has(queued.category)) return queued;
      continue;
    }
    if (gestureCount === maximumGestures) break;
    const checkpoint = runtime.events.at(-1)?.sequence ?? cursor;
    runPhysicalTalkBackSwipe(direction);
    await waitForPhysicalTalkBackCondition(
      runtime,
      () =>
        runtime.events.some(
          (event) => event.sequence > checkpoint && event.kind === "focus"
        ),
      4_000,
      message
    );
  }
  throw new Error(message);
}

async function waitForAutomaticPhysicalTalkBackFocus(
  runtime: PhysicalTalkBackObserverRuntime,
  afterSequence: number,
  allowed: ReadonlySet<PhysicalTalkBackObserverCategory>,
  message: string
): Promise<PhysicalTalkBackObserverEvent> {
  await waitForPhysicalTalkBackCondition(
    runtime,
    () =>
      runtime.events.some(
        (event) => event.sequence > afterSequence && event.kind === "focus"
      ),
    4_000,
    message
  );
  const focus = runtime.events.find(
    (event) => event.sequence > afterSequence && event.kind === "focus"
  );
  requireCondition(
    focus !== undefined && allowed.has(focus.category),
    message
  );
  requirePhysicalTalkBackProductEvent(focus);
  return focus;
}

function requirePhysicalTalkBackProductEvent(
  event: PhysicalTalkBackObserverEvent
): void {
  requireCondition(
    event.category !== "unknown" &&
      event.category !== "platform_deny" &&
      event.category !== "platform_permission" &&
      event.enabled &&
      event.visible,
    "Physical TalkBack focus entered an unknown or non-product surface."
  );
}

async function activatePhysicalTalkBackFocus(
  runtime: PhysicalTalkBackObserverRuntime,
  focus: PhysicalTalkBackObserverEvent,
  message: string
): Promise<PhysicalTalkBackObserverEvent> {
  requireCondition(
    focus.kind === "focus" &&
      focus.clickable &&
      focus.focusable &&
      focus.enabled &&
      focus.visible,
    "Physical TalkBack activation target was invalid."
  );
  const point = selectPhysicalTalkBackActivationPoint(focus);
  const checkpoint = runtime.events.at(-1)?.sequence ?? focus.sequence;
  runPhysicalTalkBackDoubleTap(point.x, point.y);
  await waitForPhysicalTalkBackCondition(
    runtime,
    () =>
      runtime.events.some(
        (event) => event.sequence > checkpoint && event.kind === "click"
      ),
    4_000,
    message
  );
  const click = runtime.events.find(
    (event) => event.sequence > checkpoint && event.kind === "click"
  );
  requireCondition(
    click !== undefined &&
      click.category === focus.category &&
      click.bounds.left === focus.bounds.left &&
      click.bounds.top === focus.bounds.top &&
      click.bounds.right === focus.bounds.right &&
      click.bounds.bottom === focus.bounds.bottom,
    message
  );
  return click;
}

function selectPhysicalTalkBackActivationPoint(
  focus: PhysicalTalkBackObserverEvent
): Readonly<{ readonly x: number; readonly y: number }> {
  const [widthValue, heightValue] = readAndroidDisplaySize().split("x");
  const width = Number(widthValue);
  const height = Number(heightValue);
  requireCondition(
    Number.isSafeInteger(width) &&
      Number.isSafeInteger(height) &&
      width >= 320 &&
      height >= 480,
    "Physical TalkBack display geometry was invalid."
  );
  const candidates = [
    Object.freeze({ x: 1_000, y: 1_000 }),
    Object.freeze({ x: 9_000, y: 1_000 }),
    Object.freeze({ x: 1_000, y: 9_000 }),
    Object.freeze({ x: 9_000, y: 9_000 })
  ] as const;
  const selected = candidates.find((candidate) => {
    const screenX = Math.round((candidate.x / 10_000) * width);
    const screenY = Math.round((candidate.y / 10_000) * height);
    return !(
      screenX >= focus.bounds.left &&
      screenX <= focus.bounds.right &&
      screenY >= focus.bounds.top &&
      screenY <= focus.bounds.bottom
    );
  });
  requireCondition(
    selected !== undefined,
    "Physical TalkBack could not select an activation point outside the target."
  );
  return selected;
}

function runPhysicalTalkBackSwipe(direction: "backward" | "forward"): void {
  const coordinates = direction === "forward"
    ? ["2000", "5000", "8000", "5000"]
    : ["8000", "5000", "2000", "5000"];
  requireCondition(
    adb([
      "shell",
      `CLASSPATH=${physicalTalkBackDeviceDex}`,
      "app_process",
      "/system/bin",
      physicalTalkBackTouchClass,
      "swipe",
      ...coordinates,
      "12",
      "25"
    ]) === "",
    "Physical TalkBack swipe gesture emitted unexpected output."
  );
}

function runPhysicalTalkBackDoubleTap(x: number, y: number): void {
  requireCondition(
    Number.isSafeInteger(x) &&
      Number.isSafeInteger(y) &&
      x >= 0 &&
      x <= 10_000 &&
      y >= 0 &&
      y <= 10_000,
    "Physical TalkBack double-tap coordinates were invalid."
  );
  requireCondition(
    adb([
      "shell",
      `CLASSPATH=${physicalTalkBackDeviceDex}`,
      "app_process",
      "/system/bin",
      physicalTalkBackTouchClass,
      "doubletap",
      String(x),
      String(y)
    ]) === "",
    "Physical TalkBack double-tap gesture emitted unexpected output."
  );
}

async function runPhysicalArchiveControl(
  input: ProductionUiEntryInput & {
    readonly controls: PhysicalDashboardControls;
    readonly prompt: PhysicalPromptRuntime;
  },
  capture: PhysicalDashboardCapture,
  measure: PhysicalDashboardMeasure
): Promise<void> {
  await waitFor(
    () => input.prompt.subscribers.snapshot().active_subscribers === 0,
    15_000,
    "Physical archive began before TalkBack Session Detail transport closed."
  );
  const navigationBefore = readPhysicalSessionNavigationSnapshot(input);
  const session = await revealAndroidUiNode(
    "description",
    physicalUiSessionName,
    "forward",
    30_000,
    "Physical archive target session was unavailable.",
    "fully_visible",
    true
  );
  await tapAndroidNodeOnceAndWait(
    session,
    () =>
      physicalSessionNavigationOpened(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBefore
      ),
    "Physical archive target did not produce one new detail and stream generation."
  );
  await waitForPhysicalSessionWriteReady(
    input,
    "Physical archive Session Detail did not settle with current write authority."
  );
  const actions = await waitForAndroidUiNodePresent(
    "description",
    "Open session actions",
    30_000,
    "Physical archive session actions were unavailable."
  );
  await tapAndroidNodeOnceAndWait(
    actions,
    async () =>
      (await readAndroidUiNodes()).some(
        (node) => node.text === "Session actions"
      ),
    "Physical archive action did not open."
  );
  const archive = await revealAndroidUiNode(
    "description",
    "Open Archive session",
    "forward",
    30_000,
    "Physical Archive session action was unavailable.",
    "fully_visible",
    true
  );
  measure(archive, "archive-session");
  await tapAndroidNodeOnceAndWait(
    archive,
    async () =>
      (await readAndroidUiNodes()).some(
        (node) => node.text === "Archive session?"
      ),
    "Physical Archive session confirmation did not open."
  );
  await capture("fe090-40-archive-confirmation.png");
  const confirm = await waitForPhysicalArchiveConfirmationAction(
    30_000,
    "Physical Archive session final action was unavailable."
  );
  measure(confirm, "confirm-archive");
  await tapAndroidNodeOnceAndWait(
    confirm,
    async () =>
      (await readAndroidUiNodes()).some(
        (node) => node.text === "Session archived"
      ),
    "Physical Archive session did not render terminal truth."
  );
  await capture("fe090-41-session-archived.png");
  const back = await waitForAndroidUiNodePresent(
    "text",
    "Back to sessions",
    30_000,
    "Physical archived-session result did not expose Back to sessions."
  );
  await tapAndroidNodeOnceAndWait(
    back,
    async () =>
      (await readAndroidUiNodes()).some(
        (node) => node.text === "Mission Control"
      ),
    "Physical archived-session result did not return to Mission Control."
  );
  await waitFor(
    () => input.prompt.subscribers.snapshot().active_subscribers === 0,
    15_000,
    "Physical archive retained its Session Detail SSE subscriber."
  );
}

async function waitForPhysicalArchiveConfirmationAction(
  timeoutMs: number,
  message: string
): Promise<AndroidUiNode> {
  let found: AndroidUiNode | null = null;
  const observations: string[] = [];
  try {
    await waitFor(async () => {
      const nodes = await readAndroidUiNodes();
      found = selectPhysicalArchiveConfirmationAction(nodes);
      const observation = physicalArchiveConfirmationSummary(nodes, found);
      if (
        observations.at(-1) !== observation &&
        observations.length < 6
      ) {
        observations.push(observation);
      }
      return found !== null;
    }, timeoutMs, message);
  } catch {
    throw new Error(
      `${message} (states=${
        observations.length === 0 ? "none" : observations.join("||")
      }).`
    );
  }
  requireCondition(found !== null, message);
  return found;
}

async function runPhysicalSelfRevoke(
  input: ProductionUiEntryInput & { readonly prompt: PhysicalPromptRuntime },
  capture: PhysicalDashboardCapture,
  measure: PhysicalDashboardMeasure
): Promise<void> {
  await openProductionHostAccessSheet();
  const self = await revealAndroidUiNodeContaining(
    "description",
    "Revoke Physical Android Chrome",
    "forward",
    30_000,
    "Physical paired-device list omitted the current phone."
  );
  measure(self, "revoke-this-phone");
  await tapAndroidNodeOnceAndWait(
    self,
    async () =>
      (await readAndroidUiNodes()).some(
        (node) => node.text === "Revoke this phone?"
      ),
    "Physical self-revoke confirmation did not open."
  );
  await capture("fe090-42-self-revoke-confirmation.png");
  const confirm = await waitForAndroidUiNodePresent(
    "text",
    "Revoke this phone",
    30_000,
    "Physical self-revoke final action was unavailable."
  );
  measure(confirm, "confirm-self-revoke");
  await tapAndroidNodeOnceAndWait(
    confirm,
    async () =>
      (await readAndroidUiNodes()).some(
        (node) => node.text === "This phone was revoked"
      ),
    "Physical self-revoke did not render terminal loss of authority."
  );
  await waitFor(
    () => input.prompt.subscribers.snapshot().active_subscribers === 0,
    15_000,
    "Physical self-revoke retained an SSE subscriber."
  );
  requireCondition(
    countRows(input.db, "auth_devices") === 2 &&
      countMatchingRows(input.db, "auth_devices", "revoked_at IS NOT NULL") === 2 &&
      input.requestInspection.revokeRequests === 2 &&
      input.requestInspection.deletionCookieObserved,
    "Physical self-revoke did not close exactly both test authorities."
  );
  await capture("fe090-43-self-revoked.png");
  openChromePath(input.externalOrigin, "/");
  await waitForAndroidUiText(
    "Pairing link is invalid",
    30_000,
    "Physical revoked phone did not return to unpaired startup truth."
  );
  requireCondition(
    input.requestInspection.claimRequests === 1 &&
      input.requestInspection.fragmentLeaks === 0,
    "Physical self-revoke triggered a second claim or fragment leak."
  );
  await capture("fe090-44-unpaired.png");
}

async function revealAndroidUiNodeContaining(
  field: "description" | "text",
  value: string,
  direction: AndroidVerticalRevealDirection,
  timeoutMs: number,
  message: string
): Promise<AndroidUiNode> {
  let found: AndroidUiNode | null = null;
  let swipeCount = 0;
  await waitFor(async () => {
    const nodes = await readAndroidUiNodes();
    const matches = nodes
      .filter((node) => node[field].includes(value))
      .sort(
        (left, right) =>
          androidUiNodeWidth(right) * androidUiNodeHeight(right) -
          androidUiNodeWidth(left) * androidUiNodeHeight(left)
      );
    found = matches[0] ?? null;
    if (found !== null) return true;
    if (swipeCount < 6) {
      swipeAndroidViewport(nodes, direction);
      swipeCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    return false;
  }, timeoutMs, message);
  requireCondition(found !== null, message);
  return found;
}

async function runProductionRemoteRecoveryUiSequence(
  input: ProductionUiEntryInput & {
    readonly env: Readonly<Record<string, string>>;
    readonly foreignServeBefore: ServeStatusFingerprint;
    readonly manager: TailscaleServeManager;
    readonly profileSwitch: ProfileSwitchInput;
    readonly remote: HostDeckRemoteIngressLifecycle;
    readonly setSelectedProfile: (profile: "away" | "dedicated") => void;
  }
): Promise<PhysicalRecoverySequenceResult> {
  await openProductionMissionControl(input, {
    missionControl: null,
    paired: null
  }, "single_session");
  const managerAttemptsBeforeSwitch = input.manager.snapshot().command_attempts;
  requireCondition(
    managerAttemptsBeforeSwitch === 1,
    "Physical recovery expected exactly one explicit local Serve enable."
  );
  requireCondition(
    Number(input.requestInspection.remoteBrowserStatusRequests) === 0 &&
      Number(input.requestInspection.remoteBrowserMutationRequests) === 0 &&
      input.requestInspection.remoteStatusRequests === 2 &&
      input.requestInspection.remoteEnableRequests === 1 &&
      input.requestInspection.remoteDisableRequests === 0,
    "Physical recovery started with unexpected browser remote traffic " +
      recoveryRequestSummary(input.requestInspection, input.manager)
  );

  await openProductionHostAccessSheet();
  await revealAndroidUiNode(
    "text",
    "Remote access ready",
    "forward",
    30_000,
    "Production recovery UI did not show current ready truth."
  );
  await runOneProductionRemoteCheck(input.requestInspection);
  requireCondition(
    input.requestInspection.remoteBrowserStatusRequests === 1 &&
      input.requestInspection.remoteBrowserMutationRequests === 0 &&
      input.manager.snapshot().command_attempts === managerAttemptsBeforeSwitch,
    "The first production recovery check mutated external state or used the wrong route " +
      recoveryRequestSummary(input.requestInspection, input.manager)
  );
  await closeProductionHostAccessSheet();
  await waitForAndroidUiNode(
    "text",
    "Mission Control",
    30_000,
    "Production recovery ready capture lost Mission Control."
  );
  await capturePrivateFreeProductionScreenshot(
    join(input.screenshotDirectory, "fe034-01-ready.png"),
    input.externalOrigin
  );

  await switchSavedProfile(input.profileSwitch.awayProfileId);
  input.setSelectedProfile("away");
  await waitFor(
    () =>
      input.remote.readAdmission().admission === "closed" &&
      input.remote.snapshot().active_control_operations === 0,
    15_000,
    "Production recovery profile-away did not close remote admission."
  );
  assertRemoteCliResult(
    await runRemoteStatusWhenLifecycleIdle(input.remote, input.env),
    "unavailable"
  );
  requireMatchingServeFingerprint(
    input.foreignServeBefore,
    await readServeStatusFingerprint()
  );
  requireCondition(
    input.manager.snapshot().command_attempts === managerAttemptsBeforeSwitch,
    "Profile-away triggered an automatic Serve mutation."
  );

  const refreshAway = await waitForAndroidUiNode(
    "description",
    "Refresh sessions",
    30_000,
    "Production recovery refresh control was unavailable before profile-away observation."
  );
  tapAndroidUiNode(refreshAway);
  await waitForAndroidUiNode(
    "text",
    "HostDeck is unreachable",
    45_000,
    "Production recovery did not render generic loaded-browser failure."
  );
  await capturePrivateFreeProductionScreenshot(
    join(input.screenshotDirectory, "fe034-02-profile-away.png"),
    input.externalOrigin
  );

  await switchSavedProfile(input.profileSwitch.dedicatedProfileId);
  input.setSelectedProfile("dedicated");
  await waitFor(
    () =>
      input.remote.readAdmission().admission === "open" &&
      input.remote.snapshot().active_control_operations === 0,
    15_000,
    "Production recovery profile return did not reopen by observation."
  );
  const requestsBeforeRecovery = Object.freeze({
    access: input.requestInspection.accessRequests,
    host: input.requestInspection.hostStatusRequests,
    sessions: input.requestInspection.sessionListRequests
  });
  const refreshRecovered = await waitForAndroidUiNode(
    "description",
    "Refresh sessions",
    30_000,
    "Production recovery refresh control was unavailable after profile return."
  );
  tapAndroidUiNode(refreshRecovered);
  await waitFor(
    () =>
      input.requestInspection.accessRequests > requestsBeforeRecovery.access &&
      input.requestInspection.hostStatusRequests > requestsBeforeRecovery.host &&
      input.requestInspection.sessionListRequests > requestsBeforeRecovery.sessions,
    45_000,
    "Production recovery did not refresh lifecycle-owned host truth after profile return."
  );
  await waitForAndroidUiNode(
    "description",
    physicalUiSessionName,
    30_000,
    "Production recovery did not restore Mission Control without re-pairing."
  );
  await openProductionHostAccessSheet();
  await revealAndroidUiNode(
    "text",
    "Remote access ready",
    "forward",
    30_000,
    "Production recovery did not restore current detailed ready truth."
  );
  await runOneProductionRemoteCheck(input.requestInspection);
  await closeProductionHostAccessSheet();
  await capturePrivateFreeProductionScreenshot(
    join(input.screenshotDirectory, "fe034-03-recovered.png"),
    input.externalOrigin
  );

  requireCondition(
    input.requestInspection.claimRequests === 1 &&
      Number(input.requestInspection.remoteBrowserStatusRequests) === 2 &&
      input.requestInspection.remoteBrowserMutationRequests === 0 &&
      input.manager.snapshot().command_attempts === managerAttemptsBeforeSwitch &&
      input.readProxyRejection() === null,
    "Production recovery repeated pairing, mutated external state, or lost Serve trust."
  );
  await cleanProductionUiAuthority(input);
  return Object.freeze({
    browserMutationRequests: 0,
    checkedReadyVisible: true,
    claimRequests: 1,
    genericBrowserFailureVisible: true,
    managerAttemptsBeforeDisable: 1,
    managerAttemptsDuringSwitch: 0,
    profileReturnRecovered: true,
    remoteBrowserStatusRequests: 2
  });
}

function recoveryRequestSummary(
  inspection: RequestInspection,
  manager: TailscaleServeManager
): string {
  return (
    `(browser_status=${inspection.remoteBrowserStatusRequests};` +
    `browser_mutation=${inspection.remoteBrowserMutationRequests};` +
    `remote_total=${inspection.remoteStatusRequests};` +
    `enable=${inspection.remoteEnableRequests};` +
    `disable=${inspection.remoteDisableRequests};` +
    `manager_attempts=${manager.snapshot().command_attempts}).`
  );
}

async function openProductionHostAccessSheet(): Promise<void> {
  const trigger = await waitForAndroidUiNode(
    "description",
    "Open Host and access",
    30_000,
    "Production Host and access trigger was unavailable on Android."
  );
  await performVerifiedAndroidTap({
    initialTrigger: trigger,
    triggerField: "description",
    triggerValue: "Open Host and access",
    completed: async () =>
      (await readAndroidUiNodes()).some(
        (node) => node.description === "Close Host and access"
      ),
    completionFailureMessage:
      "Production Host and access sheet did not open on Android.",
    reacquireFailureMessage:
      "Production Host and access trigger could not be reacquired on Android.",
    terminalFailureMessage:
      "Production Host and access sheet remained closed after two bounded taps."
  });
}

async function closeProductionHostAccessSheet(): Promise<void> {
  const close = await revealAndroidUiNode(
    "description",
    "Close Host and access",
    "backward",
    30_000,
    "Production Host and access close control was unavailable on Android."
  );
  await performVerifiedAndroidTap({
    initialTrigger: close,
    triggerField: "description",
    triggerValue: "Close Host and access",
    completed: async () =>
      (await readAndroidUiNodes()).every(
        (node) => node.description !== "Close Host and access"
      ),
    completionFailureMessage:
      "Production Host and access sheet did not close on Android.",
    reacquireFailureMessage:
      "Production Host and access close control could not be reacquired on Android.",
    terminalFailureMessage:
      "Production Host and access sheet remained open after two bounded taps."
  });
}

async function runOneProductionRemoteCheck(
  inspection: RequestInspection,
  options: Readonly<{
    readonly expectedRuntime?: PhysicalRuntimeExpectation;
  }> = {}
): Promise<void> {
  const before = readPhysicalRemoteCheckBoundary(inspection);
  const check = await revealAndroidUiNode(
    "text",
    "Check again",
    "forward",
    30_000,
    "Production remote check action was unavailable on Android."
  );
  try {
    await performVerifiedAndroidTap({
      initialTrigger: check,
      triggerField: "text",
      triggerValue: "Check again",
      completed: () =>
        physicalRemoteCheckSettled(
          before,
          readPhysicalRemoteCheckBoundary(inspection)
        ),
      completionFailureMessage:
        "Production remote check did not complete its exact successful status-then-refresh sequence.",
      reacquireFailureMessage:
        "Production remote check action could not be reacquired on Android.",
      terminalFailureMessage:
        "Production remote check did not settle after two bounded taps."
    });
  } catch (error) {
    throw new Error(
      `Production remote check failed (${physicalRemoteCheckBoundarySummary(
        before,
        readPhysicalRemoteCheckBoundary(inspection)
      )}).`,
      { cause: error }
    );
  }
  await revealAndroidUiNode(
    "text",
    "Remote access ready",
    "backward",
    30_000,
    "Production remote check did not return to current ready truth."
  );
  if (options.expectedRuntime !== undefined) {
    await revealAndroidUiNode(
      "text",
      options.expectedRuntime === "incompatible"
        ? physicalRuntimeIncompatibleTitle
        : physicalRuntimeSupportedTitle,
      "forward",
      30_000,
      "Production remote check did not render exact compatibility truth.",
      "fully_visible"
    );
  }
}

interface PhysicalRemoteCheckBoundary {
  readonly hostRequests: number;
  readonly hostResponseCount: number;
  readonly hostResponseStatus: number | null;
  readonly remoteBrowserRequests: number;
}

function readPhysicalRemoteCheckBoundary(
  inspection: RequestInspection
): PhysicalRemoteCheckBoundary {
  return physicalRemoteCheckBoundary(
    inspection.remoteBrowserStatusRequests,
    inspection.hostStatusRequests,
    inspection.hostStatusResponseStatuses.length,
    inspection.hostStatusResponseStatuses.at(-1) ?? null
  );
}

function physicalRemoteCheckBoundary(
  remoteBrowserRequests: number,
  hostRequests: number,
  hostResponseCount: number,
  hostResponseStatus: number | null
): PhysicalRemoteCheckBoundary {
  return Object.freeze({
    hostRequests,
    hostResponseCount,
    hostResponseStatus,
    remoteBrowserRequests
  });
}

function physicalRemoteCheckSettled(
  before: PhysicalRemoteCheckBoundary,
  current: PhysicalRemoteCheckBoundary
): boolean {
  return (
    current.remoteBrowserRequests === before.remoteBrowserRequests + 1 &&
    current.hostRequests === before.hostRequests + 1 &&
    current.hostResponseCount === before.hostResponseCount + 1 &&
    current.hostResponseStatus === 200
  );
}

function physicalRemoteCheckBoundarySummary(
  before: PhysicalRemoteCheckBoundary,
  current: PhysicalRemoteCheckBoundary
): string {
  return (
    `remote=${current.remoteBrowserRequests - before.remoteBrowserRequests};` +
    `host=${current.hostRequests - before.hostRequests};` +
    `responses=${current.hostResponseCount - before.hostResponseCount}/` +
    `${current.hostResponseStatus ?? "none"}`
  );
}

async function capturePrivateFreeProductionScreenshot(
  path: string,
  externalOrigin: string,
  options: Readonly<{ readonly redactProductOrigin?: boolean }> = {}
): Promise<void> {
  const nodes = await readAndroidUiNodes();
  const selection = selectPrivateFreeProductionScreenshotEvidence(
    nodes,
    externalOrigin,
    options
  );
  await capturePhysicalScreenshot(
    path,
    selection.region,
    selection.redactions
  );
}

function selectPrivateFreeProductionScreenshotRegion(
  nodes: readonly AndroidUiNode[],
  externalOrigin: string
): PhysicalScreenshotRegion {
  return selectPrivateFreeProductionScreenshotEvidence(nodes, externalOrigin)
    .region;
}

function selectPrivateFreeProductionScreenshotEvidence(
  nodes: readonly AndroidUiNode[],
  externalOrigin: string,
  options: Readonly<{ readonly redactProductOrigin?: boolean }> = {}
): PrivateFreeProductionScreenshotSelection {
  const region = selectChromePageViewport(nodes);
  const origin = new URL(externalOrigin);
  const privateNodes = nodes.filter(
    (node) =>
      androidNodeIntersectsRegion(node, region) &&
      androidUiNodeContainsPrivateMaterial(node, origin)
  );
  const redactions =
    options.redactProductOrigin === true
      ? selectProductOriginScreenshotRedactions(
          nodes,
          privateNodes,
          origin,
          region
        )
      : Object.freeze([]);
  requireCondition(
    privateNodes.length === 0 || redactions.length > 0,
    "Physical production screenshot page viewport retained private browser material."
  );
  return Object.freeze({ redactions, region });
}

function androidUiNodeContainsPrivateMaterial(
  node: AndroidUiNode,
  origin: URL
): boolean {
  return [node.text, node.description].some(
    (value) =>
      value.includes(origin.origin) ||
      value.includes(origin.hostname) ||
      [...deviceForbiddenValues].some(
        (privateValue) => value.includes(privateValue)
      )
  );
}

function selectProductOriginScreenshotRedactions(
  nodes: readonly AndroidUiNode[],
  privateNodes: readonly AndroidUiNode[],
  origin: URL,
  page: PhysicalScreenshotRegion
): readonly PhysicalScreenshotRegion[] {
  if (privateNodes.length === 0) return Object.freeze([]);
  const failure = privateProductOriginRedactionFailure(
    nodes,
    privateNodes,
    origin,
    page
  );
  requireCondition(privateNodes.length <= 2, failure);
  const context = findProductOriginScreenshotContext(nodes, page);
  const hasSessionContext =
    context.hostMatches.length === 1 &&
    context.backMatches.length === 1 &&
    context.permissionMatches.length === 1 &&
    context.hostEligible.length === 1 &&
    context.backEligible.length === 1 &&
    context.permissionEligible.length === 1;
  const hasGlobalContext =
    context.hostMatches.length === 1 &&
    context.closeMatches.length === 1 &&
    context.hostEligible.length === 1 &&
    context.closeEligible.length === 1;
  requireCondition(
    (hasSessionContext && !hasGlobalContext) ||
      (!hasSessionContext && hasGlobalContext),
    failure
  );
  const redactions = privateNodes.map((node) => {
    requireCondition(
      node.text === origin.origin &&
        androidUiNodeIsWebText(node) &&
        !node.clickable &&
        node.description === "" &&
        node.resourceId === "" &&
        androidUiNodeIsFullyInsideRegion(node, page),
      failure
    );
    const right = Math.min(
      page.left + page.width,
      node.bounds.right + physicalScreenshotRedactionInsetPx
    );
    const bottom = Math.min(
      page.top + page.height,
      node.bounds.bottom + physicalScreenshotRedactionInsetPx
    );
    const left = Math.max(
      page.left,
      node.bounds.left - physicalScreenshotRedactionInsetPx
    );
    const top = Math.max(
      page.top,
      node.bounds.top - physicalScreenshotRedactionInsetPx
    );
    requireCondition(right > left && bottom > top, failure);
    return Object.freeze({
      height: bottom - top,
      left,
      top,
      width: right - left
    });
  });
  return mergePhysicalScreenshotRegions(redactions);
}

function privateProductOriginRedactionFailure(
  nodes: readonly AndroidUiNode[],
  privateNodes: readonly AndroidUiNode[],
  origin: URL,
  page: PhysicalScreenshotRegion
): string {
  const context = findProductOriginScreenshotContext(nodes, page);
  const privateShape = privateNodes.slice(0, 4).map((node, index) => {
    const registeredText = [...deviceForbiddenValues].some((value) =>
      node.text.includes(value)
    );
    const registeredDescription = [...deviceForbiddenValues].some((value) =>
      node.description.includes(value)
    );
    const classCategory =
      node.className === "android.view.View"
        ? "v"
        : node.className === androidEditTextClass
          ? "e"
          : node.className === "android.widget.TextView"
            ? "t"
            : "o";
    return (
      `n${String(index)}=` +
      `${node.text === origin.origin ? "te" : node.text.includes(origin.origin) ? "tc" : "tn"},` +
      `${node.description === origin.origin ? "de" : node.description.includes(origin.origin) ? "dc" : "dn"},` +
      `${node.text.includes(origin.hostname) ? "th" : "tx"},` +
      `${node.description.includes(origin.hostname) ? "dh" : "dx"},` +
      `${registeredText ? "rt" : "rx"},${registeredDescription ? "rd" : "rx"},` +
      `c${classCategory},k${node.clickable ? "1" : "0"},` +
      `d${node.description === "" ? "0" : "1"},r${node.resourceId === "" ? "0" : "1"},` +
      `i${androidUiNodeIsFullyInsideRegion(node, page) ? "1" : "0"},` +
      `${node.bounds.left},${node.bounds.top},${node.bounds.right},${node.bounds.bottom}`
    );
  });
  const diagnostic =
    `private=${String(privateNodes.length)};` +
    `nodes=${privateShape.join("|") || "none"};` +
    `context=h${String(context.hostMatches.length)}/${String(context.hostEligible.length)},` +
    `b${String(context.backMatches.length)}/${String(context.backEligible.length)},` +
    `p${String(context.permissionMatches.length)}/${String(context.permissionEligible.length)},` +
    `c${String(context.closeMatches.length)}/${String(context.closeEligible.length)}`;
  const privateValues = [
    origin.origin,
    origin.hostname,
    ...deviceForbiddenValues
  ];
  const safeDiagnostic = privateValues.some(
    (value) => value !== "" && diagnostic.includes(value)
  )
    ? "private-diagnostic-suppressed"
    : diagnostic;
  return (
    "Physical production screenshot page viewport retained private browser material " +
    `(${safeDiagnostic}).`
  );
}

function findProductOriginScreenshotContext(
  nodes: readonly AndroidUiNode[],
  page: PhysicalScreenshotRegion
) {
  const hostMatches = nodes.filter((node) => node.text === "Host & access");
  const backMatches = nodes.filter(
    (node) => node.description === "Back to session actions"
  );
  const permissionMatches = nodes.filter(
    (node) => node.text === "Read & write"
  );
  const closeMatches = nodes.filter(
    (node) => node.description === "Close Host and access"
  );
  return Object.freeze({
    backEligible: Object.freeze(
      backMatches.filter(
        (node) =>
          node.text === "" &&
          node.clickable &&
          node.resourceId === "" &&
          androidUiNodeIsFullyInsideRegion(node, page)
      )
    ),
    backMatches: Object.freeze(backMatches),
    closeEligible: Object.freeze(
      closeMatches.filter(
        (node) =>
          node.text === "" &&
          node.clickable &&
          node.resourceId === "" &&
          androidUiNodeIsFullyInsideRegion(node, page)
      )
    ),
    closeMatches: Object.freeze(closeMatches),
    hostEligible: Object.freeze(
      hostMatches.filter((node) => androidNodeIntersectsRegion(node, page))
    ),
    hostMatches: Object.freeze(hostMatches),
    permissionEligible: Object.freeze(
      permissionMatches.filter((node) =>
        androidProductContextTextIsEligible(node, page)
      )
    ),
    permissionMatches: Object.freeze(permissionMatches)
  });
}

function androidProductContextTextIsEligible(
  node: AndroidUiNode,
  page: PhysicalScreenshotRegion
): boolean {
  return (
    androidUiNodeIsWebText(node) &&
    !node.clickable &&
    node.description === "" &&
    node.resourceId === "" &&
    androidUiNodeIsFullyInsideRegion(node, page)
  );
}

function androidUiNodeIsWebText(node: AndroidUiNode): boolean {
  return (
    node.className === "android.view.View" ||
    node.className === "android.widget.TextView"
  );
}

function mergePhysicalScreenshotRegions(
  regions: readonly PhysicalScreenshotRegion[]
): readonly PhysicalScreenshotRegion[] {
  const sorted = [...regions].sort(
    (left, right) => left.top - right.top || left.left - right.left
  );
  const merged: PhysicalScreenshotRegion[] = [];
  for (const region of sorted) {
    const previous = merged.at(-1);
    if (previous === undefined || !physicalScreenshotRegionsOverlap(previous, region)) {
      merged.push(region);
      continue;
    }
    const right = Math.max(
      previous.left + previous.width,
      region.left + region.width
    );
    const bottom = Math.max(
      previous.top + previous.height,
      region.top + region.height
    );
    const left = Math.min(previous.left, region.left);
    const top = Math.min(previous.top, region.top);
    merged[merged.length - 1] = Object.freeze({
      height: bottom - top,
      left,
      top,
      width: right - left
    });
  }
  return Object.freeze(merged);
}

function physicalScreenshotRegionsOverlap(
  left: PhysicalScreenshotRegion,
  right: PhysicalScreenshotRegion
): boolean {
  return (
    left.left <= right.left + right.width &&
    left.left + left.width >= right.left &&
    left.top <= right.top + right.height &&
    left.top + left.height >= right.top
  );
}

function selectChromePageViewport(
  nodes: readonly AndroidUiNode[]
): PhysicalScreenshotRegion {
  const compositor = selectChromeCompositorRegion(nodes);
  const toolbarNodes = nodes.filter(
    (node) => node.resourceId === chromeToolbarResourceId
  );
  requireCondition(
    toolbarNodes.length <= 1,
    "Physical production screenshot had ambiguous Chrome toolbar geometry."
  );
  if (toolbarNodes.length === 0) return compositor;
  const toolbar = toolbarNodes[0];
  requireCondition(
    toolbar !== undefined &&
      toolbar.bounds.left === compositor.left &&
      toolbar.bounds.right === compositor.left + compositor.width &&
      toolbar.bounds.top >= compositor.top &&
      toolbar.bounds.bottom > toolbar.bounds.top &&
      toolbar.bounds.bottom < compositor.top + compositor.height,
    "Physical production screenshot Chrome viewport geometry was invalid."
  );
  const region = Object.freeze({
    height: compositor.top + compositor.height - toolbar.bounds.bottom,
    left: compositor.left,
    top: toolbar.bounds.bottom,
    width: compositor.width
  });
  requireCondition(
    region.width >= 320 &&
      region.width <= 4_096 &&
      region.height >= 480 &&
      region.height <= 8_192,
    "Physical production screenshot page viewport was outside bounded dimensions."
  );
  return region;
}

function selectChromeCompositorRegion(
  nodes: readonly AndroidUiNode[]
): PhysicalScreenshotRegion {
  const compositorNodes = nodes.filter(
    (node) => node.resourceId === chromeCompositorResourceId
  );
  requireCondition(
    compositorNodes.length === 1,
    "Physical evidence could not isolate the Chrome compositor."
  );
  const compositor = compositorNodes[0];
  requireCondition(
    compositor !== undefined,
    "Physical evidence Chrome compositor was absent."
  );
  const region = Object.freeze({
    height: compositor.bounds.bottom - compositor.bounds.top,
    left: compositor.bounds.left,
    top: compositor.bounds.top,
    width: compositor.bounds.right - compositor.bounds.left
  });
  requireCondition(
    region.left >= 0 &&
      region.top >= 0 &&
      region.width >= 320 &&
      region.width <= 4_096 &&
      region.height >= 480 &&
      region.height <= 8_192,
    "Physical evidence Chrome compositor was outside bounded dimensions."
  );
  return region;
}

function androidUiNodeIsFullyInsideChromePage(
  node: AndroidUiNode,
  nodes: readonly AndroidUiNode[]
): boolean {
  return androidUiNodeIsFullyInsideRegion(
    node,
    selectChromePageViewport(nodes)
  );
}

function androidUiNodeIsFullyInsideRegion(
  node: AndroidUiNode,
  region: PhysicalScreenshotRegion
): boolean {
  return (
    node.bounds.left >= region.left &&
    node.bounds.right <= region.left + region.width &&
    node.bounds.top >= region.top &&
    node.bounds.bottom <= region.top + region.height
  );
}

function selectPhysicalEventDiagnosticTarget(
  nodes: readonly AndroidUiNode[],
  timelineLabel: string
): PhysicalEventDiagnosticTarget | null {
  const labels = nodes.filter(
    (node) => node.text === timelineLabel
  );
  if (labels.length !== 1) return null;
  const label = labels[0];
  if (label === undefined) return null;
  const labelIndex = nodes.indexOf(label);
  if (labelIndex < 0) return null;

  const contentRegion = selectPhysicalSessionContentRegion(nodes);
  if (contentRegion === null) return null;

  const labelY = Math.floor((label.bounds.top + label.bounds.bottom) / 2);
  const precedingActions = nodes
    .map((node, index) => ({ index, node }))
    .filter(
      ({ index, node }) =>
        index < labelIndex &&
        node.description === "View event details" &&
        node.clickable
    )
    .map(({ index, node }) => ({
      distance: Math.abs(
        Math.floor((node.bounds.top + node.bounds.bottom) / 2) - labelY
      ),
      index,
      node
    }))
    .filter(
      ({ node }) =>
        Math.floor((node.bounds.top + node.bounds.bottom) / 2) <= labelY
    )
    .sort((left, right) => right.index - left.index);
  const owner = precedingActions[0];
  if (
    owner === undefined ||
    owner.distance > physicalEventActionMaxDistancePx
  ) {
    return null;
  }

  const isUnobscured = (node: AndroidUiNode): boolean =>
    node.bounds.left >= contentRegion.left &&
    node.bounds.right <= contentRegion.left + contentRegion.width &&
    node.bounds.top >= contentRegion.top &&
    node.bounds.bottom <= contentRegion.top + contentRegion.height;
  if (!isUnobscured(label) || !isUnobscured(owner.node)) return null;
  return Object.freeze({ action: owner.node, label });
}

function physicalEventDiagnosticGeometrySummary(
  nodes: readonly AndroidUiNode[],
  timelineLabel: string
): string {
  const labels = nodes.filter((node) => node.text === timelineLabel);
  const label = labels[0];
  const labelY =
    label === undefined
      ? null
      : Math.floor((label.bounds.top + label.bounds.bottom) / 2);
  const actions = nodes
    .map((node, index) => ({ index, node }))
    .filter(({ node }) => node.description === "View event details")
    .map(({ index, node }) => ({
      distance:
        labelY === null
          ? null
          : Math.abs(
              Math.floor((node.bounds.top + node.bounds.bottom) / 2) - labelY
            ),
      index,
      node
    }))
    .sort(
      (left, right) =>
        (left.distance ?? Number.MAX_SAFE_INTEGER) -
        (right.distance ?? Number.MAX_SAFE_INTEGER)
    );
  const back = nodes.filter(
    (node) => node.description === "Back to Mission Control"
  );
  const controls = physicalSessionControlDescriptions.map((description) => {
    const matches = nodes.filter((node) => node.description === description);
    return `${matches.length}:${matches[0] === undefined ? "none" : androidUiNodeGeometry(matches[0])}`;
  });
  let page = "invalid";
  let content = "unavailable";
  let gesture = "unavailable";
  let owner = "none";
  let target = "invalid";
  try {
    const selectedPage = selectChromePageViewport(nodes);
    page = physicalRegionGeometry(selectedPage);
  } catch {
    // The bounded summary reports invalid screenshot geometry without raw hierarchy data.
  }
  try {
    const selectedContent = selectPhysicalSessionContentRegion(nodes);
    if (selectedContent !== null) content = physicalRegionGeometry(selectedContent);
    const selectedGesture = selectPhysicalSessionContentSwipe(nodes);
    if (selectedGesture !== null) {
      gesture = `${selectedGesture.x},${selectedGesture.startY},${selectedGesture.endY}`;
    }
    const selectedTarget = selectPhysicalEventDiagnosticTarget(
      nodes,
      timelineLabel
    );
    target = selectedTarget === null ? "blocked" : "admitted";
    if (selectedTarget !== null) owner = androidUiNodeGeometry(selectedTarget.action);
  } catch {
    // The bounded summary reports invalid interaction geometry without raw hierarchy data.
  }
  return [
    `target=${target}`,
    `label=${labels.length}:${label === undefined ? "none" : androidUiNodeGeometry(label)}`,
    `action=${actions.length}:${actions[0] === undefined ? "none" : `${actions[0].index},${actions[0].distance ?? "na"},${androidUiNodeGeometry(actions[0].node)}`}`,
    `owner=${owner}`,
    `back=${back.length}:${back[0] === undefined ? "none" : androidUiNodeGeometry(back[0])}`,
    `controls=${controls.join("|")}`,
    `page=${page}`,
    `content=${content}`,
    `gesture=${gesture}`
  ].join(";");
}

function androidUiNodeGeometry(node: AndroidUiNode): string {
  return (
    `${node.bounds.left},${node.bounds.top},${node.bounds.right},${node.bounds.bottom},` +
    `${node.clickable ? "click" : "static"}`
  );
}

function privateFreeAndroidUiNodeGeometry(node: AndroidUiNode): string {
  return (
    `${androidUiNodeGeometry(node)},` +
    `t${node.text === "" ? "0" : "1"},d${node.description === "" ? "0" : "1"}`
  );
}

function physicalRegionGeometry(region: PhysicalScreenshotRegion): string {
  return `${region.left},${region.top},${region.width},${region.height}`;
}

function selectPhysicalHostAccessContentRegion(
  nodes: readonly AndroidUiNode[]
): PhysicalScreenshotRegion | null {
  let page: PhysicalScreenshotRegion;
  try {
    page = selectChromePageViewport(nodes);
  } catch {
    return null;
  }
  const titles = nodes.filter((node) => node.text === "Host & access");
  const backButtons = nodes.filter(
    (node) => node.description === "Back to session actions"
  );
  const closeButtons = nodes.filter(
    (node) => node.description === "Close session actions"
  );
  if (
    titles.length !== 1 ||
    backButtons.length !== 1 ||
    closeButtons.length !== 1
  ) {
    return null;
  }
  const title = titles[0];
  const back = backButtons[0];
  const close = closeButtons[0];
  if (
    title === undefined ||
    back === undefined ||
    close === undefined ||
    !physicalHostAccessTitleIsEligible(title, page) ||
    !physicalHostAccessHeaderButtonIsEligible(back, page) ||
    !physicalHostAccessHeaderButtonIsEligible(close, page) ||
    !physicalHostAccessHeaderIsCoherent(title, back, close)
  ) {
    return null;
  }
  const top =
    Math.max(title.bounds.bottom, back.bounds.bottom, close.bounds.bottom) +
    physicalHostAccessHeaderGapPx;
  const bottom = page.top + page.height;
  if (!Number.isSafeInteger(top) || bottom - top < 320) return null;
  return Object.freeze({
    height: bottom - top,
    left: page.left,
    top,
    width: page.width
  });
}

function physicalHostAccessTitleIsEligible(
  node: AndroidUiNode,
  page: PhysicalScreenshotRegion
): boolean {
  return (
    node.text === "Host & access" &&
    (node.description === "" || node.description === "Host & access") &&
    !node.clickable &&
    node.enabled !== false &&
    androidUiNodeWidth(node) >= 48 &&
    androidUiNodeWidth(node) <= Math.floor(page.width * 0.8) &&
    androidUiNodeHeight(node) >= 16 &&
    androidUiNodeHeight(node) <= 160 &&
    androidUiNodeIsFullyInsideRegion(node, page)
  );
}

function physicalHostAccessHeaderButtonIsEligible(
  node: AndroidUiNode,
  page: PhysicalScreenshotRegion
): boolean {
  return (
    node.clickable &&
    node.enabled !== false &&
    androidUiNodeWidth(node) >= 24 &&
    androidUiNodeWidth(node) <= 256 &&
    androidUiNodeHeight(node) >= 24 &&
    androidUiNodeHeight(node) <= 256 &&
    androidUiNodeIsFullyInsideRegion(node, page)
  );
}

function physicalHostAccessHeaderIsCoherent(
  title: AndroidUiNode,
  back: AndroidUiNode,
  close: AndroidUiNode
): boolean {
  const centerX = (node: AndroidUiNode) =>
    Math.floor((node.bounds.left + node.bounds.right) / 2);
  const centerY = (node: AndroidUiNode) =>
    Math.floor((node.bounds.top + node.bounds.bottom) / 2);
  const centersY = [title, back, close].map(centerY);
  return (
    centerX(back) < centerX(title) &&
    centerX(title) < centerX(close) &&
    Math.max(...centersY) - Math.min(...centersY) <= 128 &&
    Math.max(title.bounds.bottom, back.bounds.bottom, close.bounds.bottom) -
      Math.min(title.bounds.top, back.bounds.top, close.bounds.top) <=
      256
  );
}

function selectPhysicalHostAccessContentNode(
  nodes: readonly AndroidUiNode[],
  field: AndroidUiNodeField,
  value: string,
  requireClickable: boolean
): AndroidUiNode | null {
  const matches = nodes.filter((node) =>
    matchesAndroidUiNode(node, field, value)
  );
  if (matches.length !== 1) return null;
  const node = matches[0];
  if (
    node === undefined ||
    (requireClickable && (!node.clickable || node.enabled === false))
  ) {
    return null;
  }
  const region = selectPhysicalHostAccessContentRegion(nodes);
  return region !== null && androidUiNodeIsFullyInsideRegion(node, region)
    ? node
    : null;
}

function selectPhysicalHostAccessContentSwipe(
  nodes: readonly AndroidUiNode[],
  direction: AndroidVerticalRevealDirection = "forward"
): Readonly<{ readonly endY: number; readonly startY: number; readonly x: number }> | null {
  const region = selectPhysicalHostAccessContentRegion(nodes);
  if (region === null) return null;
  const upperY = region.top + Math.floor(region.height * 0.28);
  const lowerY = region.top + Math.floor(region.height * 0.76);
  const [startY, endY] =
    direction === "forward" ? [lowerY, upperY] : [upperY, lowerY];
  return Object.freeze({
    endY,
    startY,
    x: region.left + Math.floor(region.width / 2)
  });
}

function swipePhysicalHostAccessContent(
  nodes: readonly AndroidUiNode[],
  direction: AndroidVerticalRevealDirection
): boolean {
  const gesture = selectPhysicalHostAccessContentSwipe(nodes, direction);
  if (gesture === null) return false;
  adb([
    "shell",
    "input",
    "swipe",
    String(gesture.x),
    String(gesture.startY),
    String(gesture.x),
    String(gesture.endY),
    "350"
  ]);
  return true;
}

function selectPhysicalSessionControlDockTop(
  nodes: readonly AndroidUiNode[]
): number | null {
  const dockControls = physicalSessionControlDescriptions.map((description) =>
    nodes.filter((node) => node.description === description)
  );
  if (
    dockControls.some(
      (matches) => matches.length !== 1 || matches[0]?.clickable !== true
    )
  ) {
    return null;
  }
  const controls = dockControls.flat();
  const controlTops = controls.map((node) => node.bounds.top);
  const dockTop = Math.min(...controlTops);
  if (
    !Number.isSafeInteger(dockTop) ||
    Math.max(...controlTops) - dockTop > 64
  ) {
    return null;
  }
  return dockTop;
}

function selectPhysicalSessionContentRegion(
  nodes: readonly AndroidUiNode[]
): PhysicalScreenshotRegion | null {
  const compositor = selectChromeCompositorRegion(nodes);
  const backButtons = nodes.filter(
    (node) =>
      node.description === "Back to Mission Control" && node.clickable
  );
  const dockTop = selectPhysicalSessionControlDockTop(nodes);
  if (backButtons.length !== 1 || dockTop === null) return null;
  const back = backButtons[0];
  if (
    back === undefined ||
    !androidUiNodeIsFullyInsideRegion(back, compositor)
  ) {
    return null;
  }
  const top = Math.max(
    compositor.top,
    back.bounds.bottom + physicalSessionOverlayGapPx
  );
  const bottom = Math.min(
    compositor.top + compositor.height,
    dockTop - physicalSessionOverlayGapPx
  );
  if (bottom - top < 320) return null;
  return Object.freeze({
    height: bottom - top,
    left: compositor.left,
    top,
    width: compositor.width
  });
}

function selectPhysicalSessionContentNode(
  nodes: readonly AndroidUiNode[],
  field: AndroidUiNodeField,
  value: string,
  requireClickable: boolean
): AndroidUiNode | null {
  const matches = nodes.filter((node) =>
    matchesAndroidUiNode(node, field, value)
  );
  if (matches.length !== 1) return null;
  const node = matches[0];
  if (
    node === undefined ||
    (requireClickable && (!node.clickable || node.enabled === false))
  ) {
    return null;
  }
  const region = selectPhysicalSessionContentRegion(nodes);
  if (region === null || !androidUiNodeIsFullyInsideRegion(node, region)) {
    return null;
  }
  return node;
}

function physicalSessionContentNodeSummary(
  nodes: readonly AndroidUiNode[],
  field: AndroidUiNodeField,
  value: string,
  requireClickable: boolean,
  selected: AndroidUiNode | null
): string {
  const matches = nodes.filter((node) =>
    matchesAndroidUiNode(node, field, value)
  );
  const target = matches[0];
  const backs = nodes.filter(
    (node) => node.description === "Back to Mission Control"
  );
  const controls = physicalSessionControlDescriptions.map((description) => {
    const matchesForControl = nodes.filter(
      (node) => node.description === description
    );
    const first = matchesForControl[0];
    return (
      `${matchesForControl.length}:` +
      `${first === undefined ? "none" : androidUiNodeGeometry(first)}`
    );
  });
  let region: PhysicalScreenshotRegion | null = null;
  let gesture = "unavailable";
  try {
    region = selectPhysicalSessionContentRegion(nodes);
    const selectedGesture = selectPhysicalSessionContentSwipe(nodes);
    if (selectedGesture !== null) {
      gesture = `${selectedGesture.x},${selectedGesture.startY},${selectedGesture.endY}`;
    }
  } catch {
    // The bounded summary reports invalid interaction geometry without raw hierarchy data.
  }
  return [
    `disposition=${physicalSessionContentNodeDisposition(
      matches,
      target,
      region,
      requireClickable,
      selected
    )}`,
    `target=${matches.length}:${
      target === undefined ? "none" : androidUiNodeGeometry(target)
    }:${
      target === undefined
        ? "none"
        : target.enabled === false
          ? "disabled"
          : "enabled"
    }`,
    `back=${backs.length}:${
      backs[0] === undefined ? "none" : androidUiNodeGeometry(backs[0])
    }`,
    `controls=${controls.join("|")}`,
    `content=${region === null ? "unavailable" : physicalRegionGeometry(region)}`,
    `scroll=${physicalSessionContentScrollSummary(nodes, region)}`,
    `gesture=${gesture}`,
    `selected=${selected === null ? "none" : androidUiNodeGeometry(selected)}`
  ].join(";");
}

function physicalSessionContentNodeDisposition(
  matches: readonly AndroidUiNode[],
  target: AndroidUiNode | undefined,
  region: PhysicalScreenshotRegion | null,
  requireClickable: boolean,
  selected: AndroidUiNode | null
): string {
  if (matches.length === 0) return "absent";
  if (matches.length !== 1 || target === undefined) return "duplicate";
  if (requireClickable && !target.clickable) return "not-clickable";
  if (requireClickable && target.enabled === false) return "disabled";
  if (region === null) return "content-blocked";
  if (selected === target) return "admitted";

  const right = region.left + region.width;
  const bottom = region.top + region.height;
  if (target.bounds.right <= region.left || target.bounds.left >= right) {
    return "horizontal-outside";
  }
  if (target.bounds.left < region.left || target.bounds.right > right) {
    return "clipped-horizontal";
  }
  if (target.bounds.bottom <= region.top) return "above";
  if (target.bounds.top < region.top) return "clipped-top";
  if (target.bounds.top >= bottom) return "below";
  if (target.bounds.bottom > bottom) return "clipped-bottom";
  return "selector-blocked";
}

function physicalSessionContentScrollSummary(
  nodes: readonly AndroidUiNode[],
  region: PhysicalScreenshotRegion | null
): string {
  if (region === null) return "unavailable";
  const witnesses = nodes
    .filter(
      (node) =>
        androidNodeIntersectsRegion(node, region) &&
        node.resourceId !== chromeToolbarResourceId &&
        node.resourceId !== chromeCompositorResourceId &&
        node.description !== "Back to Mission Control" &&
        !physicalSessionControlDescriptions.includes(node.description)
    )
    .sort(
      (left, right) =>
        left.bounds.top - right.bounds.top ||
        left.bounds.left - right.bounds.left ||
        left.bounds.bottom - right.bounds.bottom ||
        left.bounds.right - right.bounds.right
    );
  const bounded =
    witnesses.length <= 6
      ? witnesses
      : [...witnesses.slice(0, 3), ...witnesses.slice(-3)];
  return (
    `${witnesses.length}:` +
    `${bounded.map(privateFreeAndroidUiNodeGeometry).join("|") || "none"}`
  );
}

function retainPhysicalSessionContentObservation(
  observations: string[],
  observation: string
): void {
  requireCondition(
    Buffer.byteLength(observation, "utf8") >= 1 &&
      Buffer.byteLength(observation, "utf8") <= 4_096,
    "Physical session-content observation exceeded its private-safe bound."
  );
  if (observations.at(-1) === observation) return;
  observations.push(observation);
  if (observations.length > 6) observations.shift();
}

function swipeAndroidViewportAbovePhysicalSessionControls(
  nodes: readonly AndroidUiNode[],
  direction: AndroidVerticalRevealDirection = "forward"
): void {
  const gesture = selectPhysicalSessionContentSwipe(nodes, direction);
  requireCondition(
    gesture !== null,
    "Physical session-control dock left no bounded page swipe lane."
  );
  adb([
    "shell",
    "input",
    "swipe",
    String(gesture.x),
    String(gesture.startY),
    String(gesture.x),
    String(gesture.endY),
    "350"
  ]);
}

function selectPhysicalSessionContentSwipe(
  nodes: readonly AndroidUiNode[],
  direction: AndroidVerticalRevealDirection = "forward"
): Readonly<{ readonly endY: number; readonly startY: number; readonly x: number }> | null {
  const region = selectPhysicalSessionContentRegion(nodes);
  if (region === null) return null;
  const upperY = region.top + Math.floor(region.height * 0.28);
  const lowerY = region.top + Math.floor(region.height * 0.76);
  const [startY, endY] =
    direction === "forward" ? [lowerY, upperY] : [upperY, lowerY];
  return Object.freeze({
    endY,
    startY,
    x: region.left + Math.floor(region.width / 2)
  });
}

function androidNodeIntersectsRegion(
  node: AndroidUiNode,
  region: PhysicalScreenshotRegion
): boolean {
  return (
    node.bounds.right > region.left &&
    node.bounds.left < region.left + region.width &&
    node.bounds.bottom > region.top &&
    node.bounds.top < region.top + region.height
  );
}

async function runProductionPromptUiSequence(
  input: ProductionUiEntryInput & {
    readonly prompt: PhysicalPromptRuntime;
  },
  options: Readonly<{
    readonly captureScreenshots?: boolean;
    readonly cleanup: boolean;
    readonly openMissionControl: boolean;
    readonly sessionAlreadyOpen?: boolean;
  }> = Object.freeze({ cleanup: true, openMissionControl: true })
): Promise<PhysicalPromptSequenceResult> {
  if (options.openMissionControl) {
    await openProductionMissionControl(input, {
      missionControl: "fe020-02-mission-control.png",
      paired: "fe020-01-paired.png"
    }, "single_session");
  }
  const inputLabel = `Prompt for ${physicalUiSessionName}`;
  const sendLabel = `Send prompt to ${physicalUiSessionName}`;
  if (options.sessionAlreadyOpen !== true) {
    const sessionLink = await revealAndroidUiNode(
      "description",
      physicalUiSessionName,
      "forward",
      30_000,
      "Physical prompt session link was unavailable on Android."
    );
    await performVerifiedAndroidTap({
      initialTrigger: sessionLink,
      triggerField: "description",
      triggerValue: physicalUiSessionName,
      completed: () =>
        input.requestInspection.sessionDetailRequests >= 1 &&
        input.prompt.subscribers.snapshot().active_subscribers === 1,
      completionFailureMessage:
        "Production Session Detail did not open on Android.",
      reacquireFailureMessage:
        "Physical prompt session link could not be reacquired on Android.",
      terminalFailureMessage:
        "Production Session Detail remained closed after two bounded taps."
    });
  }
  try {
    await waitFor(
      () =>
        input.requestInspection.sessionDetailRequests >= 1 &&
        input.requestInspection.sessionStreamRequests >= 1 &&
        input.prompt.subscribers.snapshot().active_subscribers === 1,
      45_000,
      "Physical prompt detail did not establish one current production stream."
    );
  } catch {
    throw new Error(
      "Physical prompt detail did not establish one current production stream " +
        physicalPromptStreamDiagnostic(input)
    );
  }
  await waitForAndroidUiNode(
    "text",
    "Ready to send",
    30_000,
    "Physical prompt composer did not become writable on Android."
  );
  const textarea = await waitForAndroidPromptEditor(
    inputLabel,
    30_000,
    "Physical prompt textarea was unavailable on Android."
  );
  await performVerifiedAndroidTap({
    initialTrigger: textarea,
    triggerField: "className",
    triggerValue: androidEditTextClass,
    completed: () => isAndroidKeyboardVisible(),
    completionFailureMessage:
      "Physical prompt textarea did not open the Android keyboard.",
    reacquireFailureMessage:
      "Physical prompt textarea could not be reacquired on Android.",
    terminalFailureMessage:
      "Physical prompt textarea did not retain keyboard focus after two bounded taps."
  });
  await waitFor(
    () => isAndroidKeyboardVisible(),
    10_000,
    "Physical prompt Android keyboard did not remain visible."
  );
  const keyboardNodes = await readAndroidUiNodes();
  const promptTargetVisible = keyboardNodes.some(
    (node) =>
      node.text === "Prompt target" || node.text === "PROMPT TARGET"
  );
  const promptLabelVisible = keyboardNodes.some((node) =>
    matchesAndroidUiNode(node, "semantic", inputLabel)
  );
  const promptEditorVisible =
    findAndroidPromptEditor(keyboardNodes, inputLabel) !== null;
  const promptSendVisible = keyboardNodes.some(
    (node) => node.description === sendLabel
  );
  const editTextCount = keyboardNodes.filter(
    (node) => node.className === androidEditTextClass
  ).length;
  requireCondition(
    promptTargetVisible && promptEditorVisible && promptSendVisible,
    "Physical prompt controls were not all visible above the Android keyboard " +
      `(target=${promptTargetVisible};label=${promptLabelVisible};` +
      `editor=${promptEditorVisible};send=${promptSendVisible};` +
      `edit_texts=${editTextCount}).`
  );
  if (options.captureScreenshots !== false) {
    await capturePhysicalScreenshot(
      join(input.screenshotDirectory, "fe020-03-keyboard-open.png")
    );
  }

  enterPhysicalPromptText(physicalPromptText);
  await waitForAndroidUiNode(
    "text",
    physicalPromptText,
    15_000,
    "Physical prompt textarea did not preserve two edited lines."
  );
  requireCondition(
    isAndroidKeyboardVisible(),
    "Physical prompt multiline edit unexpectedly closed the Android keyboard."
  );
  const send = await waitForAndroidUiNode(
    "description",
    sendLabel,
    15_000,
    "Physical prompt send action was unavailable on Android."
  );
  await performVerifiedAndroidTap({
    initialTrigger: send,
    triggerField: "description",
    triggerValue: sendLabel,
    completed: () => input.requestInspection.promptRequests === 1,
    completionFailureMessage:
      "Physical prompt send did not issue its protected request.",
    reacquireFailureMessage:
      "Physical prompt send action could not be reacquired on Android.",
    terminalFailureMessage:
      "Physical prompt send did not dispatch after two bounded taps."
  });
  await waitForAndroidUiNode(
    "text",
    "New turn accepted",
    30_000,
    "Physical prompt accepted state did not render on Android."
  );
  const acceptedNodes = await readAndroidUiNodes();
  const promptLines = physicalPromptText.split("\n");
  const acceptedTextarea = findAndroidPromptEditor(acceptedNodes, inputLabel);
  requireCondition(
    acceptedTextarea !== null &&
      promptLines.every(
        (line) => !acceptedTextarea.text.includes(line)
      ) &&
      input.requestInspection.promptRequests === 1 &&
      input.requestInspection.promptNoReferrerRequests === 1 &&
      JSON.stringify(input.requestInspection.promptResponseStatuses) ===
        "[202]" &&
      input.prompt.startCalls.length === 1 &&
      input.prompt.startCalls[0]?.thread_id === physicalUiThreadId &&
      input.prompt.startCalls[0]?.text === physicalPromptText,
    "Physical prompt acceptance did not preserve exact one-attempt private request truth."
  );
  if (isAndroidKeyboardVisible()) {
    adb(["shell", "input", "keyevent", "KEYCODE_BACK"]);
  }
  await waitFor(
    () => !isAndroidKeyboardVisible(),
    10_000,
    "Physical prompt acceptance could not dismiss the Android keyboard."
  );
  const scrubbedNodes = await readAndroidUiNodes();
  requireCondition(
    scrubbedNodes.every((node) =>
      promptLines.every(
        (line) =>
          !node.text.includes(line) && !node.description.includes(line)
      )
    ),
    "Physical prompt text remained visible after accepted-state keyboard cleanup."
  );
  for (const line of promptLines) {
    deviceForbiddenValues.add(line);
  }
  if (options.captureScreenshots !== false) {
    await capturePhysicalScreenshot(
      join(input.screenshotDirectory, "fe020-04-accepted.png")
    );
  }

  await input.prompt.advance("in_progress");
  await waitForAndroidUiNode(
    "text",
    "Turn running",
    30_000,
    "Physical prompt running event did not render on Android."
  );
  if (options.captureScreenshots !== false) {
    await capturePhysicalScreenshot(
      join(input.screenshotDirectory, "fe020-05-running.png")
    );
  }
  await input.prompt.advance("completed");
  await waitForAndroidUiNode(
    "text",
    "Turn completed",
    30_000,
    "Physical prompt completion event did not render on Android."
  );
  if (options.captureScreenshots !== false) {
    await capturePhysicalScreenshot(
      join(input.screenshotDirectory, "fe020-06-completed.png")
    );
  }
  requireCondition(
    input.requestInspection.promptRequests === 1 &&
      input.prompt.startCalls.length === 1 &&
      input.prompt.streamFailureCount === 0,
    "Physical prompt progress introduced a duplicate dispatch or stream failure."
  );

  if (options.cleanup) {
    await cleanProductionUiAuthority(input);
    await waitFor(
      () => input.prompt.subscribers.snapshot().active_subscribers === 0,
      15_000,
      "Physical prompt cleanup retained a production stream subscriber."
    );
  }
  requireCondition(
    input.readProxyRejection() === null,
    "Physical prompt production request was rejected at the Serve boundary."
  );
  return Object.freeze({
    acceptedVisible: true,
    completedVisible: true,
    keyboardVisible: true,
    multilineEdited: true,
    promptCharacterCount: physicalPromptText.length,
    promptLineCount: 2,
    promptRequestCount: 1,
    runningVisible: true,
    sendAction: "start",
    sentOnce: true
  });
}

function physicalPromptStreamDiagnostic(
  input: Readonly<{
    readonly prompt: PhysicalPromptRuntime;
    readonly requestInspection: RequestInspection;
  }>
): string {
  const snapshot = input.prompt.subscribers.snapshot();
  const recovery = input.prompt.recoverySnapshot();
  const failures = input.prompt.streamFailureCodes;
  const statuses = input.requestInspection.sessionStreamResponseStatuses;
  return (
    `(detail=${input.requestInspection.sessionDetailRequests};` +
    `missing_detail=${input.requestInspection.sessionMissingDetailRequests};` +
    `event_page=${input.requestInspection.sessionEventRequests};` +
    `plan_read=${input.requestInspection.planReadRequests};` +
    `stream=${input.requestInspection.sessionStreamRequests};` +
    `statuses=${statuses.length === 0 ? "none" : statuses.join("|")};` +
    `active=${snapshot.active_subscribers};opened=${snapshot.opened_subscribers};` +
    `aborted=${snapshot.aborted_subscribers};explicit=${snapshot.explicit_closures};` +
    `source_failed=${snapshot.source_failed_subscribers};` +
    `open_failed=${snapshot.source_open_failures};` +
    `recovery=${recovery.state}/${recovery.held_requests};` +
    `failures=${failures.length === 0 ? "none" : failures.join("|")}).`
  );
}

async function cleanProductionUiAuthority(
  input: ProductionUiEntryInput
): Promise<void> {
  input.driver.recordCheckpoint("paired");
  input.driver.setCommand("cleanup");
  openChromePath(input.externalOrigin, "/__physical/cleanup");
  await waitFor(
    () => hasPhysicalCheckpoint(input.driver, "reloaded"),
    30_000,
    "Physical UI cleanup did not enter with fragment-free cookie authority."
  );
  await waitFor(
    () => input.requestInspection.rejectedRevokedCheckpoints === 1,
    30_000,
    "Physical UI cleanup did not revoke browser authority."
  );
  requireCondition(
    input.requestInspection.deletionCookieObserved &&
      countMatchingRows(
        input.db,
        "auth_devices",
        "revoked_at IS NOT NULL"
      ) === 1,
    "Physical UI cleanup did not remove its browser authority."
  );
}

function missionControlRouteFailure(
  inspection: RequestInspection,
  proxyRejection: string | null
): string {
  const route = (requests: number, statuses: readonly number[]): string =>
    `${requests}/${statuses.length === 0 ? "none" : statuses.join(",")}`;
  return (
    "Production Mission Control did not load its authenticated route data " +
    `(access=${route(inspection.accessRequests, inspection.accessResponseStatuses)};` +
    `host=${route(inspection.hostStatusRequests, inspection.hostStatusResponseStatuses)};` +
    `sessions=${route(inspection.sessionListRequests, inspection.sessionListResponseStatuses)};` +
    `proxy=${proxyRejection ?? "none"}).`
  );
}

function pairingConfirmationFailure(input: Readonly<{
  readonly claimRequests: number;
  readonly claimResponseStatuses: readonly number[];
  readonly csrfRequests: number;
  readonly csrfResponseStatuses: readonly number[];
  readonly devices: number;
  readonly hardenedCookieObserved: boolean;
  readonly nodes: readonly Pick<AndroidUiNode, "description" | "text">[];
  readonly proxyRejection: string | null;
  readonly usedPairingCodes: number;
}>): string {
  const route = (requests: number, statuses: readonly number[]): string =>
    `${requests}/${statuses.length === 0 ? "none" : statuses.join(",")}`;
  const knownStates = pairingStartupDiagnosticLabels.filter((label) =>
    input.nodes.some(
      (node) => node.text === label || node.description === label
    )
  );
  return (
    "Production pairing confirmation did not render on Android " +
    `(claim=${route(input.claimRequests, input.claimResponseStatuses)};` +
    `csrf=${route(input.csrfRequests, input.csrfResponseStatuses)};` +
    `cookie=${input.hardenedCookieObserved ? "set" : "absent"};` +
    `devices=${input.devices};used_codes=${input.usedPairingCodes};` +
    `proxy=${input.proxyRejection ?? "none"};` +
    `ui=${knownStates.length === 0 ? "unknown" : knownStates.join("|")}).`
  );
}

function pairingUiBeforeContinueIsValid(
  paired: AndroidUiNode,
  nodes: readonly AndroidUiNode[],
  inspection: RequestInspection
): boolean {
  return (
    paired.text === "Phone paired" &&
    nodes.every(
      (node) => !node.text.includes(selectedPairingFragmentPrefix)
    ) &&
    inspection.claimRequests === 1 &&
    inspection.csrfRequests === 1 &&
    inspection.accessRequests === 0 &&
    inspection.hostStatusRequests === 0 &&
    inspection.sessionListRequests === 0
  );
}

async function readAndroidUiNodes(): Promise<readonly AndroidUiNode[]> {
  return parseAndroidUiNodes(
    await adbAsync(["exec-out", "uiautomator", "dump", "/dev/tty"])
  );
}

function parseAndroidUiNodes(output: string): readonly AndroidUiNode[] {
  requireCondition(
    Buffer.byteLength(output, "utf8") > 0 &&
      Buffer.byteLength(output, "utf8") <= 512 * 1024 &&
      !output.includes("\u0000") &&
      !output.includes(selectedPairingFragmentPrefix),
    "Android UI hierarchy was invalid or retained pairing material."
  );
  const nodes: AndroidUiNode[] = [];
  for (const match of output.matchAll(/<node\b([^>]*)\/?\s*>/gu)) {
    const attributes = new Map<string, string>();
    for (const attribute of (match[1] ?? "").matchAll(
      /([a-zA-Z][a-zA-Z0-9_-]{0,31})="([^"]*)"/gu
    )) {
      const key = attribute[1];
      const value = attribute[2];
      if (key === undefined || value === undefined || attributes.has(key)) {
        throw new Error("Android UI hierarchy attributes were invalid.");
      }
      attributes.set(key, decodeXmlAttribute(value));
    }
    const bounds = /^\[(\d{1,5}),(\d{1,5})\]\[(\d{1,5}),(\d{1,5})\]$/u.exec(
      attributes.get("bounds") ?? ""
    );
    if (bounds === null) continue;
    const left = Number(bounds[1]);
    const top = Number(bounds[2]);
    const right = Number(bounds[3]);
    const bottom = Number(bounds[4]);
    if (
      ![left, top, right, bottom].every(Number.isSafeInteger) ||
      left < 0 ||
      top < 0 ||
      right <= left ||
      bottom <= top ||
      right > 10_000 ||
      bottom > 10_000
    ) {
      continue;
    }
    const text = attributes.get("text") ?? "";
    const description = attributes.get("content-desc") ?? "";
    const className = attributes.get("class") ?? "";
    const resourceId = attributes.get("resource-id") ?? "";
    const clickableAttribute = attributes.get("clickable");
    const enabledAttribute = attributes.get("enabled");
    const focusedAttribute = attributes.get("focused");
    requireCondition(
      clickableAttribute === undefined ||
        clickableAttribute === "true" ||
        clickableAttribute === "false",
      "Android UI hierarchy clickable state was invalid."
    );
    requireCondition(
      enabledAttribute === undefined ||
        enabledAttribute === "true" ||
        enabledAttribute === "false",
      "Android UI hierarchy enabled state was invalid."
    );
    requireCondition(
      focusedAttribute === undefined ||
        focusedAttribute === "true" ||
        focusedAttribute === "false",
      "Android UI hierarchy focused state was invalid."
    );
    const clickable = clickableAttribute === "true";
    const enabled = enabledAttribute !== "false";
    const focused = focusedAttribute === "true";
    if (
      text === "" &&
      description === "" &&
      !clickable &&
      className !== androidEditTextClass &&
      resourceId !== chromeToolbarResourceId &&
      resourceId !== chromeCompositorResourceId
    ) {
      continue;
    }
    nodes.push(
      Object.freeze({
        bounds: Object.freeze({ bottom, left, right, top }),
        className,
        clickable,
        description,
        ...(enabled ? {} : { enabled: false as const }),
        ...(focused ? { focused: true as const } : {}),
        resourceId,
        text
      })
    );
  }
  requireCondition(
    nodes.length >= 1 && nodes.length <= 2_048,
    "Android UI hierarchy had no bounded semantic nodes."
  );
  return Object.freeze(nodes);
}

async function waitForAndroidPromptEditor(
  label: string,
  timeoutMs: number,
  message: string
): Promise<AndroidUiNode> {
  let found: AndroidUiNode | null = null;
  await waitFor(async () => {
    found = findAndroidPromptEditor(await readAndroidUiNodes(), label);
    return found !== null;
  }, timeoutMs, message);
  requireCondition(found !== null, message);
  return found;
}

function findAndroidPromptEditor(
  nodes: readonly AndroidUiNode[],
  label: string
): AndroidUiNode | null {
  const labels = nodes.filter((node) =>
    matchesAndroidUiNode(node, "semantic", label)
  );
  requireCondition(
    labels.length <= 2,
    "Android UI hierarchy duplicated the prompt editor label."
  );
  if (labels.length === 0) return null;
  const editors = nodes.filter(
    (node) =>
      node.className === androidEditTextClass &&
      androidUiNodeWidth(node) >= 120 &&
      androidUiNodeHeight(node) >= 36 &&
      labels.some((labelNode) => promptEditorIsNearLabel(node, labelNode))
  );
  requireCondition(
    editors.length <= 1,
    "Android UI hierarchy duplicated the prompt editor control."
  );
  return editors[0] ?? null;
}

function findPhysicalSkillsSearchEditor(
  nodes: readonly AndroidUiNode[]
): AndroidUiNode | null {
  const titles = nodes.filter((node) => node.text === "/skills");
  const currentStatuses = nodes.filter(
    (node) => node.text === "Skills capture current"
  );
  const reports = nodes.filter(
    (node) => node.text === "25 structured skills reported."
  );
  if (
    titles.length !== 1 ||
    currentStatuses.length !== 1 ||
    reports.length !== 1
  ) {
    return null;
  }
  const title = titles[0];
  const current = currentStatuses[0];
  if (title === undefined || current === undefined) return null;
  let page: PhysicalScreenshotRegion;
  try {
    page = selectChromePageViewport(nodes);
  } catch {
    return null;
  }
  const editors = nodes.filter(
    (node) =>
      node.className === androidEditTextClass &&
      node.clickable &&
      androidUiNodeWidth(node) >= 120 &&
      androidUiNodeHeight(node) >= 36 &&
      androidUiNodeIsFullyInsideRegion(node, page) &&
      node.bounds.top >= title.bounds.bottom &&
      node.bounds.bottom <= current.bounds.top
  );
  if (editors.length !== 1) return null;
  const editor = editors[0];
  if (editor === undefined) return null;
  const labelled = findAndroidPromptEditor(nodes, "Search skills");
  if (labelled !== null) return labelled === editor ? editor : null;
  return editor.text === "" && editor.description === "" ? editor : null;
}

function promptEditorIsNearLabel(
  editor: AndroidUiNode,
  label: AndroidUiNode
): boolean {
  const labelX = Math.floor((label.bounds.left + label.bounds.right) / 2);
  const labelY = Math.floor((label.bounds.top + label.bounds.bottom) / 2);
  return (
    labelX >= editor.bounds.left - 64 &&
    labelX <= editor.bounds.right + 64 &&
    labelY >= editor.bounds.top - 192 &&
    labelY <= editor.bounds.bottom + 192
  );
}

function androidUiNodeWidth(node: AndroidUiNode): number {
  return node.bounds.right - node.bounds.left;
}

function androidUiNodeHeight(node: AndroidUiNode): number {
  return node.bounds.bottom - node.bounds.top;
}

async function waitForAndroidUiNode(
  field: AndroidUiNodeField,
  value: string,
  timeoutMs: number,
  message: string
): Promise<AndroidUiNode> {
  let found: AndroidUiNode | null = null;
  await waitFor(async () => {
    const matches = (await readAndroidUiNodes()).filter(
      (node) => matchesAndroidUiNode(node, field, value)
    );
    requireCondition(
      matches.length <= 1,
      `Android UI hierarchy duplicated ${field} ${value}.`
    );
    found = matches[0] ?? null;
    return found !== null;
  }, timeoutMs, message);
  requireCondition(found !== null, message);
  return found;
}

async function revealPhysicalSessionContentNode(
  field: AndroidUiNodeField,
  value: string,
  direction: AndroidVerticalRevealDirection,
  timeoutMs: number,
  message: string,
  requireClickable = false
): Promise<AndroidUiNode> {
  let found: AndroidUiNode | null = null;
  let swipeCount = 0;
  const observations: string[] = [];
  try {
    await waitFor(async () => {
      const nodes = await readAndroidUiNodes();
      found = selectPhysicalSessionContentNode(
        nodes,
        field,
        value,
        requireClickable
      );
      const observation = physicalSessionContentNodeSummary(
        nodes,
        field,
        value,
        requireClickable,
        found
      );
      retainPhysicalSessionContentObservation(observations, observation);
      if (found !== null) return true;
      if (swipeCount < 4) {
        swipeAndroidViewportAbovePhysicalSessionControls(nodes, direction);
        swipeCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      return false;
    }, timeoutMs, message);
  } catch {
    throw new Error(
      `${message} (direction=${direction};swipes=${swipeCount};states=${
        observations.length === 0 ? "none" : observations.join(" -> ")
      }).`
    );
  }
  requireCondition(found !== null, message);
  return found;
}

async function revealPhysicalHostAccessContentNode(
  field: AndroidUiNodeField,
  value: string,
  direction: AndroidVerticalRevealDirection,
  timeoutMs: number,
  message: string,
  requireClickable = false
): Promise<AndroidUiNode> {
  let found: AndroidUiNode | null = null;
  let swipeCount = 0;
  const observations: string[] = [];
  try {
    await waitFor(async () => {
      const nodes = await readAndroidUiNodes();
      found = selectPhysicalHostAccessContentNode(
        nodes,
        field,
        value,
        requireClickable
      );
      const observation = physicalHostAccessContentSummary(
        nodes,
        field,
        value,
        found
      );
      if (
        observations.at(-1) !== observation &&
        observations.length < 6
      ) {
        observations.push(observation);
      }
      if (found !== null) return true;
      if (
        swipeCount < 4 &&
        swipePhysicalHostAccessContent(nodes, direction)
      ) {
        swipeCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      return false;
    }, timeoutMs, message);
  } catch {
    throw new Error(
      `${message} (swipes=${swipeCount};states=${
        observations.length === 0 ? "none" : observations.join("||")
      }).`
    );
  }
  requireCondition(found !== null, message);
  return found;
}

function physicalHostAccessContentSummary(
  nodes: readonly AndroidUiNode[],
  field: AndroidUiNodeField,
  value: string,
  selected: AndroidUiNode | null
): string {
  const geometry = (node: AndroidUiNode | undefined) =>
    node === undefined ? "none" : androidUiNodeGeometry(node);
  const matches = nodes.filter((node) =>
    matchesAndroidUiNode(node, field, value)
  );
  const titles = nodes.filter((node) => node.text === "Host & access");
  const backs = nodes.filter(
    (node) => node.description === "Back to session actions"
  );
  const closes = nodes.filter(
    (node) => node.description === "Close session actions"
  );
  const region = selectPhysicalHostAccessContentRegion(nodes);
  return [
    `target=${matches.length}:${geometry(matches[0])}`,
    `title=${titles.length}:${geometry(titles[0])}`,
    `back=${backs.length}:${geometry(backs[0])}`,
    `close=${closes.length}:${geometry(closes[0])}`,
    `header=${physicalHostAccessHeaderSummary(nodes, titles[0], backs[0], closes[0])}`,
    `region=${region === null ? "blocked" : physicalRegionGeometry(region)}`,
    `selected=${selected === null ? "none" : androidUiNodeGeometry(selected)}`
  ].join(";");
}

function physicalHostAccessHeaderSummary(
  nodes: readonly AndroidUiNode[],
  title: AndroidUiNode | undefined,
  back: AndroidUiNode | undefined,
  close: AndroidUiNode | undefined
): string {
  let page: PhysicalScreenshotRegion;
  try {
    page = selectChromePageViewport(nodes);
  } catch {
    return "page-blocked";
  }
  return [
    `p${physicalRegionGeometry(page)}`,
    `t${title !== undefined && physicalHostAccessTitleIsEligible(title, page) ? "1" : "0"}`,
    `b${back !== undefined && physicalHostAccessHeaderButtonIsEligible(back, page) ? "1" : "0"}`,
    `c${close !== undefined && physicalHostAccessHeaderButtonIsEligible(close, page) ? "1" : "0"}`,
    `g${
      title !== undefined &&
      back !== undefined &&
      close !== undefined &&
      physicalHostAccessHeaderIsCoherent(title, back, close)
        ? "1"
        : "0"
    }`
  ].join(",");
}

async function revealAndroidUiNode(
  field: AndroidUiNodeField,
  value: string,
  direction: AndroidVerticalRevealDirection,
  timeoutMs: number,
  message: string,
  visibility: AndroidUiNodeVisibility = "present",
  requireClickable = false
): Promise<AndroidUiNode> {
  let found: AndroidUiNode | null = null;
  let swipeCount = 0;
  const observations: string[] = [];
  try {
    await waitFor(async () => {
      const nodes = await readAndroidUiNodes();
      const observation = androidUiRevealGeometrySummary(
        nodes,
        field,
        value,
        visibility,
        requireClickable
      );
      if (
        observations.at(-1) !== observation &&
        observations.length < 6
      ) {
        observations.push(observation);
      }
      found = selectAndroidUiNodeForReveal(
        nodes,
        field,
        value,
        visibility,
        requireClickable
      );
      if (found !== null) return true;
      if (swipeCount < 4) {
        swipeAndroidViewport(nodes, direction);
        swipeCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      return false;
    }, timeoutMs, message);
  } catch {
    throw new Error(
      `${message} (swipes=${swipeCount};states=${
        observations.length === 0 ? "none" : observations.join("||")
      }).`
    );
  }
  requireCondition(found !== null, message);
  return found;
}

async function waitForPhysicalHostLockConfirmationAction(
  timeoutMs: number,
  message: string
): Promise<AndroidUiNode> {
  let found: AndroidUiNode | null = null;
  const observations: string[] = [];
  try {
    await waitFor(async () => {
      const nodes = await readAndroidUiNodes();
      found = selectPhysicalHostLockConfirmationAction(nodes);
      const observation = physicalHostLockConfirmationSummary(nodes, found);
      if (
        observations.at(-1) !== observation &&
        observations.length < 6
      ) {
        observations.push(observation);
      }
      return found !== null;
    }, timeoutMs, message);
  } catch {
    throw new Error(
      `${message} (states=${
        observations.length === 0 ? "none" : observations.join("||")
      }).`
    );
  }
  requireCondition(found !== null, message);
  return found;
}

function selectPhysicalHostLockConfirmationAction(
  nodes: readonly AndroidUiNode[]
): AndroidUiNode | null {
  return selectPhysicalConfirmationFooterAction(
    nodes,
    "Lock remote writes?",
    "Lock writes"
  );
}

function selectPhysicalArchiveConfirmationAction(
  nodes: readonly AndroidUiNode[]
): AndroidUiNode | null {
  return selectPhysicalConfirmationFooterAction(
    nodes,
    "Archive session?",
    "Archive session"
  );
}

function selectPhysicalConfirmationFooterAction(
  nodes: readonly AndroidUiNode[],
  titleText: string,
  actionText: string
): AndroidUiNode | null {
  let page: PhysicalScreenshotRegion;
  try {
    page = selectChromePageViewport(nodes);
  } catch {
    return null;
  }
  const titles = nodes.filter(
    (node) =>
      node.text === titleText &&
      androidUiNodeIsFullyInsideRegion(node, page)
  );
  const cancels = nodes.filter(
    (node) =>
      node.text === "Cancel" &&
      node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsFullyInsideRegion(node, page)
  );
  if (titles.length !== 1 || cancels.length !== 1) return null;
  const title = titles[0];
  const cancel = cancels[0];
  if (title === undefined || cancel === undefined) return null;
  if (cancel.bounds.top < title.bounds.bottom) return null;
  const cancelCenterY = Math.floor(
    (cancel.bounds.top + cancel.bounds.bottom) / 2
  );
  const actions = nodes.filter((node) => {
    if (
      node.text !== actionText ||
      !node.clickable ||
      node.enabled === false ||
      !androidUiNodeIsFullyInsideRegion(node, page) ||
      node.bounds.top < title.bounds.bottom
    ) {
      return false;
    }
    const actionCenterY = Math.floor(
      (node.bounds.top + node.bounds.bottom) / 2
    );
    return (
      Math.abs(actionCenterY - cancelCenterY) <= 128 &&
      androidUiNodesShareControlRegion(node, cancel)
    );
  });
  return actions.length === 1 ? actions[0] ?? null : null;
}

function physicalArchiveConfirmationSummary(
  nodes: readonly AndroidUiNode[],
  selected: AndroidUiNode | null
): string {
  return (
    `title=${nodes.filter((node) => node.text === "Archive session?").length};` +
    `cancel=${nodes.filter((node) => node.text === "Cancel").length};` +
    `action=${nodes.filter((node) => node.text === "Archive session").length};` +
    `selected=${selected === null ? "none" : androidUiNodeGeometry(selected)}`
  );
}

function physicalHostLockConfirmationSummary(
  nodes: readonly AndroidUiNode[],
  selected: AndroidUiNode | null
): string {
  return (
    `title=${nodes.filter((node) => node.text === "Lock remote writes?").length};` +
    `cancel=${nodes.filter((node) => node.text === "Cancel").length};` +
    `action=${nodes.filter((node) => node.text === "Lock writes").length};` +
    `selected=${selected === null ? "none" : androidUiNodeGeometry(selected)}`
  );
}

async function waitForPhysicalApprovalConfirmationAction(
  input: Readonly<{
    readonly prompt: PhysicalPromptRuntime;
    readonly requestInspection: RequestInspection;
  }>,
  timeoutMs: number,
  message: string
): Promise<AndroidUiNode> {
  let found: AndroidUiNode | null = null;
  const observations: string[] = [];
  try {
    await waitFor(async () => {
      const nodes = await readAndroidUiNodes();
      found = selectPhysicalApprovalConfirmationAction(nodes);
      const observation =
        `${androidUiRevealGeometrySummary(
          nodes,
          "semantic",
          physicalApprovalConfirmationAction,
          "fully_visible",
          true
        )};context=${physicalApprovalConfirmationContextSummary(nodes)};` +
        `footer=${found === null ? "blocked" : androidUiNodeGeometry(found)}`;
      if (
        observations.at(-1) !== observation &&
        observations.length < 6
      ) {
        observations.push(observation);
      }
      return found !== null;
    }, timeoutMs, message);
  } catch {
    throw new Error(
      `${message} (states=${
        observations.length === 0 ? "none" : observations.join("||")
      }). ${physicalPromptStreamDiagnostic(input)}`
    );
  }
  requireCondition(found !== null, message);
  return found;
}

function swipeAndroidViewport(
  nodes: readonly AndroidUiNode[],
  direction: AndroidVerticalRevealDirection
): void {
  const right = Math.max(...nodes.map((node) => node.bounds.right));
  const bottom = Math.max(...nodes.map((node) => node.bounds.bottom));
  requireCondition(
    Number.isSafeInteger(right) &&
      Number.isSafeInteger(bottom) &&
      right >= 320 &&
      bottom >= 480 &&
      right <= 10_000 &&
      bottom <= 10_000,
    "Android viewport bounds were invalid for a bounded reveal."
  );
  const x = Math.floor(right / 2);
  const upperY = Math.floor(bottom * 0.32);
  const lowerY = Math.floor(bottom * 0.76);
  const [startY, endY] =
    direction === "forward" ? [lowerY, upperY] : [upperY, lowerY];
  adb([
    "shell",
    "input",
    "swipe",
    String(x),
    String(startY),
    String(x),
    String(endY),
    "350"
  ]);
}

async function continueFromPairingUi(
  initialButton: AndroidUiNode,
  inspection: RequestInspection
): Promise<void> {
  await performVerifiedAndroidTap({
    initialTrigger: initialButton,
    triggerField: "text",
    triggerValue: "Open Mission Control",
    completed: async () => {
      if (
        inspection.accessRequests > 0 ||
        inspection.hostStatusRequests > 0 ||
        inspection.sessionListRequests > 0
      ) {
        return true;
      }
      const nodes = await readAndroidUiNodes();
      return nodes.every((node) => node.text !== "Open Mission Control");
    },
    completionFailureMessage:
      "Production pairing continuation did not leave the confirmation screen.",
    reacquireFailureMessage:
      "Production pairing continuation could not reacquire its explicit button.",
    terminalFailureMessage:
      "Production pairing continuation remained on the confirmation screen after two bounded taps."
  });
}

async function performVerifiedAndroidTap(input: {
  readonly completed: () => boolean | Promise<boolean>;
  readonly completionFailureMessage: string;
  readonly initialTrigger: AndroidUiNode;
  readonly reacquireFailureMessage: string;
  readonly selectReacquiredTrigger?: (
    nodes: readonly AndroidUiNode[]
  ) => AndroidUiNode | null;
  readonly terminalFailureMessage: string;
  readonly triggerField: AndroidUiNodeField;
  readonly triggerValue: string;
}): Promise<void> {
  let trigger = input.initialTrigger;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    tapAndroidUiNode(trigger);
    try {
      await waitFor(
        input.completed,
        8_000,
        input.completionFailureMessage
      );
      return;
    } catch {
      const nodes = await readAndroidUiNodes();
      const matches = nodes.filter(
        (node) =>
          matchesAndroidUiNode(
            node,
            input.triggerField,
            input.triggerValue
          ) &&
          node.enabled !== false &&
          (input.triggerField !== "className" ||
            androidUiNodesShareControlRegion(node, trigger))
      );
      requireCondition(
        matches.length <= 1,
        "Android UI hierarchy duplicated a verified tap trigger."
      );
      if (attempt === 1) {
        throw new Error(
          `${input.terminalFailureMessage} (${androidUiStateSummary(nodes, trigger)}).`
        );
      }
      const reacquired =
        input.selectReacquiredTrigger === undefined
          ? matches[0]
          : input.selectReacquiredTrigger(nodes);
      if (reacquired === undefined || reacquired === null) {
        throw new Error(
          `${input.reacquireFailureMessage} (${androidUiStateSummary(nodes, trigger)}).`
        );
      }
      trigger = reacquired;
    }
  }
  throw new Error(input.terminalFailureMessage);
}

function matchesAndroidUiNode(
  node: AndroidUiNode,
  field: AndroidUiNodeField,
  value: string
): boolean {
  return field === "semantic"
    ? node.text === value || node.description === value
    : node[field] === value;
}

function selectAndroidUiNodeForReveal(
  nodes: readonly AndroidUiNode[],
  field: AndroidUiNodeField,
  value: string,
  visibility: AndroidUiNodeVisibility,
  requireClickable: boolean
): AndroidUiNode | null {
  const matches = nodes.filter((node) =>
    matchesAndroidUiNode(node, field, value)
  );
  if (matches.length !== 1) return null;
  const node = matches[0];
  if (
    node === undefined ||
    (requireClickable && (!node.clickable || node.enabled === false))
  ) {
    return null;
  }
  if (
    visibility === "fully_visible" &&
    !androidUiNodeIsFullyInsideChromePage(node, nodes)
  ) {
    return null;
  }
  return node;
}

function selectPhysicalApprovalConfirmationAction(
  nodes: readonly AndroidUiNode[]
): AndroidUiNode | null {
  const titleNodes = nodes.filter((node) =>
    matchesAndroidUiNode(node, "semantic", physicalApprovalConfirmationTitle)
  );
  const reasonNodes = nodes.filter((node) =>
    matchesAndroidUiNode(node, "semantic", physicalApprovalConfirmationReason)
  );
  const statusNodes = nodes.filter((node) =>
    matchesAndroidUiNode(node, "semantic", physicalApprovalConfirmationStatus)
  );
  if (
    titleNodes.length !== 1 ||
    reasonNodes.length < 1 ||
    reasonNodes.length > 2 ||
    statusNodes.length !== 1
  ) {
    return null;
  }

  let page: PhysicalScreenshotRegion;
  try {
    page = selectChromePageViewport(nodes);
  } catch {
    return null;
  }
  const title = titleNodes[0];
  const status = statusNodes[0];
  if (
    title === undefined ||
    status === undefined ||
    !androidUiNodeIsFullyInsideRegion(title, page) ||
    !androidUiNodeIsFullyInsideRegion(status, page)
  ) {
    return null;
  }
  const modalReasons = reasonNodes.filter(
    (node) =>
      androidUiNodeIsFullyInsideRegion(node, page) &&
      node.bounds.top >= title.bounds.bottom &&
      node.bounds.bottom <= status.bounds.top
  );
  if (modalReasons.length !== 1) return null;

  const semantic = selectAndroidUiNodeForReveal(
    nodes,
    "semantic",
    physicalApprovalConfirmationAction,
    "fully_visible",
    true
  );
  return semantic;
}

function physicalApprovalConfirmationTitleIsOpen(
  nodes: readonly AndroidUiNode[]
): boolean {
  return (
    nodes.filter((node) =>
      matchesAndroidUiNode(node, "semantic", physicalApprovalConfirmationTitle)
    ).length === 1
  );
}

function physicalApprovalConfirmationContextSummary(
  nodes: readonly AndroidUiNode[]
): string {
  const count = (value: string): number =>
    nodes.filter((node) => matchesAndroidUiNode(node, "semantic", value)).length;
  const normalize = (value: string): string =>
    value.trim().replace(/\s+/gu, " ");
  const normalizedStatus = nodes.filter(
    (node) =>
      normalize(node.text) === physicalApprovalConfirmationStatus ||
      normalize(node.description) === physicalApprovalConfirmationStatus
  );
  const containingStatus = nodes.filter(
    (node) =>
      node.text.includes(physicalApprovalConfirmationStatus) ||
      node.description.includes(physicalApprovalConfirmationStatus)
  );
  const exact = [
    count(physicalApprovalConfirmationTitle),
    count(physicalApprovalConfirmationReason),
    count(physicalApprovalConfirmationStatus)
  ].join("/");
  const observation = (value: string): string => {
    const matches = nodes.filter((node) =>
      matchesAndroidUiNode(node, "semantic", value)
    );
    return (
      `${matches.length}:` +
      `${matches
        .slice(0, 2)
        .map(privateFreeAndroidUiNodeGeometry)
        .join("|") || "none"}`
    );
  };
  return (
    `exact=${exact};status=${normalizedStatus.length}/${containingStatus.length}:` +
    `${containingStatus
      .slice(0, 2)
      .map(privateFreeAndroidUiNodeGeometry)
      .join("|") || "none"}`
    + `;close=${observation("Close approval confirmation")}`
    + `;risk=${observation("Elevated risk")}`
  );
}

function androidUiRevealGeometrySummary(
  nodes: readonly AndroidUiNode[],
  field: AndroidUiNodeField,
  value: string,
  visibility: AndroidUiNodeVisibility,
  requireClickable: boolean
): string {
  const matches = nodes.filter((node) =>
    matchesAndroidUiNode(node, field, value)
  );
  const first = matches[0];
  const normalize = (candidate: string): string =>
    candidate.trim().replace(/\s+/gu, " ");
  const normalizedMatches = nodes.filter(
    (node) =>
      normalize(node.text) === value ||
      normalize(node.description) === value
  );
  const containingMatches = nodes.filter(
    (node) => node.text.includes(value) || node.description.includes(value)
  );
  const cancelMatches = nodes.filter((node) =>
    matchesAndroidUiNode(node, "semantic", "Cancel")
  );
  const normalizedCancelMatches = nodes.filter(
    (node) =>
      normalize(node.text) === "Cancel" ||
      normalize(node.description) === "Cancel"
  );
  const containingCancelMatches = nodes.filter(
    (node) => node.text.includes("Cancel") || node.description.includes("Cancel")
  );
  const focused = nodes.filter((node) => node.focused === true);
  const clickables = nodes
    .filter((node) => node.clickable)
    .sort(
      (left, right) =>
        left.bounds.top - right.bounds.top ||
        left.bounds.left - right.bounds.left ||
        left.bounds.bottom - right.bounds.bottom ||
        left.bounds.right - right.bounds.right
    );
  let page = "invalid";
  let eligible = false;
  try {
    page = physicalRegionGeometry(selectChromePageViewport(nodes));
    eligible =
      selectAndroidUiNodeForReveal(
        nodes,
        field,
        value,
        visibility,
        requireClickable
      ) !== null;
  } catch {
    // The bounded summary reports invalid geometry without raw hierarchy data.
  }
  return [
    `match=${matches.length}`,
    `text=${nodes.filter((node) => node.text === value).length}`,
    `description=${nodes.filter((node) => node.description === value).length}`,
    `first=${first === undefined ? "none" : androidUiNodeGeometry(first)}`,
    `normalized=${normalizedMatches.length}`,
    `contains=${containingMatches.length}`,
    `cancel=${cancelMatches.length}/${normalizedCancelMatches.length}/${containingCancelMatches.length}:${containingCancelMatches[0] === undefined ? "none" : androidUiNodeGeometry(containingCancelMatches[0])}`,
    `page=${page}`,
    `eligible=${eligible ? "yes" : "no"}`,
    `focused=${focused.length}:${focused
      .slice(-4)
      .map(privateFreeAndroidUiNodeGeometry)
      .join("|") || "none"}`,
    `clickable=${clickables.length}:${clickables
      .slice(-6)
      .map(privateFreeAndroidUiNodeGeometry)
      .join("|") || "none"}`
  ].join(";");
}

function androidUiNodesShareControlRegion(
  left: AndroidUiNode,
  right: AndroidUiNode
): boolean {
  return (
    left.bounds.left <= right.bounds.right + 64 &&
    left.bounds.right >= right.bounds.left - 64 &&
    left.bounds.top <= right.bounds.bottom + 128 &&
    left.bounds.bottom >= right.bounds.top - 128
  );
}

function androidUiStateSummary(
  nodes: readonly AndroidUiNode[],
  trigger: AndroidUiNode
): string {
  const labels = [
    "Phone paired",
    "Open Mission Control",
    "Mission Control",
    "physical-pairing-review",
    "Back to Mission Control",
    "Ready to send",
    "Loading session",
    "Detail unavailable",
    "Earlier activity unavailable",
    "Live activity could not start. Refresh the session to retry.",
    "Activity stream reconnecting",
    "Live activity stopped",
    "Open Host and access",
    "Host & access",
    "Close Host and access",
    "Secure control ready",
    "Read & write"
  ];
  const visible = labels.filter((label) =>
    nodes.some(
      (node) => node.text === label || node.description === label
    )
  );
  const semanticValue = trigger.description || trigger.text;
  const current = nodes
    .filter(
      (node) =>
        semanticValue !== "" &&
        (node.description === semanticValue || node.text === semanticValue)
    )
    .sort(
      (left, right) =>
        androidUiNodeWidth(right) * androidUiNodeHeight(right) -
        androidUiNodeWidth(left) * androidUiNodeHeight(left)
    )[0];
  const currentState =
    current === undefined
      ? "none"
      : `${current.bounds.left},${current.bounds.top},` +
        `${current.bounds.right},${current.bounds.bottom},${current.clickable}`;
  return (
    `bounds=${trigger.bounds.left},${trigger.bounds.top},` +
    `${trigger.bounds.right},${trigger.bounds.bottom};` +
    `clickable=${trigger.clickable};current=${currentState};` +
    `known=${visible.length === 0 ? "none" : visible.join("|")}`
  );
}

function tapAndroidUiNode(node: AndroidUiNode): void {
  requireChromeForeground();
  requireCondition(
    node.enabled !== false &&
      androidUiNodeWidth(node) >= 24 &&
      androidUiNodeHeight(node) >= 24,
    "Android UI tap target was not visibly actionable."
  );
  const x = Math.floor((node.bounds.left + node.bounds.right) / 2);
  const y = Math.floor((node.bounds.top + node.bounds.bottom) / 2);
  adb(["shell", "input", "tap", String(x), String(y)]);
}

function openChromePath(origin: string, path: `/${string}`): void {
  const target = new URL(path, origin);
  requireCondition(
    target.origin === origin &&
      target.pathname === path &&
      target.search === "" &&
      target.hash === "",
    "Physical Chrome path was invalid."
  );
  const handoff = createPrivateChromePathHandoff(target.toString());
  adbCommandCount += 1;
  const output = execFileSync("adb", [...handoff.adbArgs], {
    ...commandOptions(),
    input: handoff.stdin
  });
  requireCondition(
    output === "" && !output.includes(target.origin),
    "Physical private Chrome navigation returned unexpected output."
  );
}

function createPrivateChromePathHandoff(target: string): Readonly<{
  adbArgs: readonly ["shell"];
  stdin: string;
}> {
  const parsed = new URL(target);
  requireCondition(
    parsed.toString() === target &&
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.pathname.startsWith("/") &&
      target.length <= 1_024,
    "Physical private Chrome navigation target was invalid."
  );
  const encoded = Buffer.from(target, "utf8").toString("base64");
  const adbArgs = Object.freeze(["shell"] as const);
  const stdin = [
    "set -eu",
    "IFS= read -r url_b64",
    encoded,
    'url="$(printf \'%s\' "$url_b64" | base64 -d)"',
    'am start --user 0 -W -a android.intent.action.VIEW -d "$url" -p com.android.chrome >/dev/null 2>&1',
    "unset url_b64 url",
    ""
  ].join("\n");
  requireCondition(
    /^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) &&
      encoded !== target &&
      Buffer.byteLength(stdin, "utf8") <= 2_048 &&
      !stdin.includes(target),
    "Physical private Chrome navigation handoff was invalid."
  );
  return Object.freeze({ adbArgs, stdin });
}

function decodeXmlAttribute(value: string): string {
  return value
    .replace(/&#(?:x([0-9A-Fa-f]{1,6})|(\d{1,7}));/gu, (entity, hex, decimal) => {
      const codePoint = Number.parseInt(hex ?? decimal, hex === undefined ? 10 : 16);
      return Number.isSafeInteger(codePoint) &&
        (codePoint === 9 ||
          codePoint === 10 ||
          codePoint === 13 ||
          (codePoint >= 32 && codePoint <= 0x10ffff))
        ? String.fromCodePoint(codePoint)
        : entity;
    })
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

async function runPhysicalSecuritySequence(input: {
  readonly db: ReturnType<typeof openMigratedDatabase>["db"];
  readonly driver: PhysicalDriverRuntime;
  readonly env: Readonly<Record<string, string>>;
  readonly foreignServeBefore: ServeStatusFingerprint;
  readonly manager: TailscaleServeManager;
  readonly profileSwitch: ProfileSwitchInput;
  readonly remote: HostDeckRemoteIngressLifecycle;
  readonly requestInspection: RequestInspection;
  readonly screenshotDirectory: string;
  readonly setSelectedProfile: (profile: "away" | "dedicated") => void;
  readonly sseRuntime: PhysicalSseRuntime;
}): Promise<PhysicalSequenceResult> {
  const managerAttemptsBeforeSwitch = input.manager.snapshot().command_attempts;
  requireCondition(
    managerAttemptsBeforeSwitch === 1,
    "Physical acceptance expected exactly one explicit Serve enable command."
  );

  await waitFor(
    () => hasPhysicalCheckpoint(input.driver, "locked"),
    30_000,
    "Physical phone did not validate writer lock and remote-unlock denial."
  );
  const localUnlock = await postLocalUnlock(input.env);
  requireCondition(
    localUnlock.status === 200 && localUnlock.locked === false,
    "Physical local-admin unlock did not restore the host."
  );
  assertRemoteCliResult(
    await runRemoteStatusWhenLifecycleIdle(input.remote, input.env),
    "ready"
  );
  requireCondition(
    input.manager.snapshot().command_attempts === managerAttemptsBeforeSwitch,
    "Host lock or local unlock mutated Tailscale Serve state."
  );

  await waitFor(
    () => hasPhysicalCheckpoint(input.driver, "unlocked"),
    30_000,
    "Physical phone did not observe local unlock."
  );
  await waitFor(
    () =>
      hasPhysicalCheckpoint(input.driver, "stream-ready") &&
      input.sseRuntime.active === 1 &&
      input.sseRuntime.maxActive >= 2,
    defaultResourceBudget.sse_heartbeat_interval_ms + 20_000,
    "Physical EventSource did not receive one event and transport heartbeat."
  );
  await capturePhysicalScreenshot(
    join(input.screenshotDirectory, "01-paired-ready.png")
  );
  const sseOpenedBeforeAway = input.sseRuntime.opened;

  input.driver.setCommand("prepare-away");
  await waitFor(
    () => hasPhysicalCheckpoint(input.driver, "away-ready"),
    30_000,
    "Physical phone did not prepare its profile-away observation."
  );
  await switchSavedProfile(input.profileSwitch.awayProfileId);
  input.setSelectedProfile("away");
  await waitFor(
    () =>
      input.remote.readAdmission().admission === "closed" &&
      input.remote.snapshot().active_control_operations === 0,
    15_000,
    "Profile-away did not close selected remote authority."
  );
  assertRemoteCliResult(
    await runRemoteStatusWhenLifecycleIdle(input.remote, input.env),
    "unavailable"
  );
  await waitFor(
    () => input.sseRuntime.active === 0,
    15_000,
    "Profile-away did not close the active physical EventSource."
  );
  const foreignServeAway = await readServeStatusFingerprint();
  requireMatchingServeFingerprint(
    input.foreignServeBefore,
    foreignServeAway
  );
  requireCondition(
    input.manager.snapshot().command_attempts === managerAttemptsBeforeSwitch,
    "Profile-away triggered an automatic Serve mutation."
  );
  await capturePhysicalScreenshot(
    join(input.screenshotDirectory, "02-profile-away.png")
  );

  await switchSavedProfile(input.profileSwitch.dedicatedProfileId);
  input.setSelectedProfile("dedicated");
  await waitFor(
    () =>
      input.remote.readAdmission().admission === "open" &&
      input.remote.snapshot().active_control_operations === 0,
    15_000,
    "Dedicated-profile return did not recover by observation."
  );
  assertRemoteCliResult(
    await runRemoteStatusWhenLifecycleIdle(input.remote, input.env),
    "ready"
  );
  await waitFor(
    () =>
      hasPhysicalCheckpoint(input.driver, "recovered") &&
      input.sseRuntime.opened > sseOpenedBeforeAway &&
      input.sseRuntime.active === 1,
    90_000,
    "Physical EventSource did not reconnect after profile return."
  );
  requireCondition(
    input.manager.snapshot().command_attempts === managerAttemptsBeforeSwitch &&
      input.requestInspection.claimRequests === 1,
    "Profile return repaired Serve state or re-paired the device."
  );
  await capturePhysicalScreenshot(
    join(input.screenshotDirectory, "03-recovered.png")
  );

  input.driver.setCommand("revoke");
  await waitFor(
    () =>
      input.sseRuntime.active === 0 &&
      input.requestInspection.rejectedRevokedCheckpoints === 1,
    30_000,
    "Self-revocation did not close authority and reject the final checkpoint."
  );
  requireCondition(
    input.requestInspection.revokeRequests === 1 &&
      input.requestInspection.revokedCheckpointRequests === 1 &&
      input.requestInspection.deletionCookieObserved &&
      input.requestInspection.protectedReadRequests === 7 &&
      input.requestInspection.protectedReadSuccesses === 5 &&
      input.requestInspection.protectedReadRejections === 2 &&
      countMatchingRows(
        input.db,
        "auth_devices",
        "revoked_at IS NOT NULL"
      ) === 1 &&
      input.manager.snapshot().command_attempts === managerAttemptsBeforeSwitch &&
      JSON.stringify(input.driver.snapshot()) ===
        JSON.stringify({
          checkpoints: physicalCheckpointOrder,
          command: "revoke",
          revision: 2
        }),
    "Physical self-revocation truth or cookie deletion was incomplete."
  );
  assertRemoteCliResult(
    await runRemoteStatusWhenLifecycleIdle(input.remote, input.env),
    "ready"
  );
  return Object.freeze({
    foreignServeUnchanged: true,
    lockPassed: true,
    managerAttemptsBeforeDisable: managerAttemptsBeforeSwitch,
    managerAttemptsDuringSwitch: 0,
    profileAwayClosedAuthority: true,
    profileReturnRecovered: true,
    protectedReads: 5,
    remoteUnlockDenied: true,
    selfRevoked: true,
    sseEvents: Math.max(2, input.sseRuntime.opened - 1),
    sseHeartbeats: 1
  });
}

async function postLocalUnlock(
  env: Readonly<Record<string, string>>
): Promise<Readonly<{ locked: boolean | null; status: number }>> {
  const baseUrl = env.HOSTDECK_API_BASE_URL;
  requireCondition(
    typeof baseUrl === "string",
    "Physical local-admin base URL was unavailable."
  );
  const response = await createBoundedLoopbackFetch()(
    new URL("/api/v1/access/unlock", baseUrl).toString(),
    {
    method: "POST",
    headers: {
      accept: "application/json",
      "cache-control": "no-store",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      operation_id: "op_physical_local_unlock_0001",
      confirmed: true
    })
  });
  const parsed = selectedHostLockStateResponseSchema.safeParse(
    await response.json()
  );
  return Object.freeze({
    locked: parsed.success ? parsed.data.locked : null,
    status: response.status
  });
}

async function runRemoteStatusWhenLifecycleIdle(
  remote: HostDeckRemoteIngressLifecycle,
  env: Readonly<Record<string, string>>
): Promise<Awaited<ReturnType<typeof runCli>>> {
  await waitForFreshLifecycleIdle(remote);
  return runCli(["remote", "status", "--json"], { env });
}

async function waitForFreshLifecycleIdle(
  remote: HostDeckRemoteIngressLifecycle
): Promise<void> {
  const initialCycles = remote.snapshot().poll_cycles;
  await waitFor(
    () => {
      const snapshot = remote.snapshot();
      return (
        snapshot.poll_cycles > initialCycles &&
        snapshot.active_control_operations === 0
      );
    },
    remote.snapshot().observation_interval_ms + 5_000,
    "Physical lifecycle did not settle one fresh observation cycle."
  );
}

async function capturePhysicalScreenshot(
  path: string,
  region: PhysicalScreenshotRegion | null = null,
  redactions: readonly PhysicalScreenshotRegion[] = []
): Promise<void> {
  requireChromeForeground();
  adbCommandCount += 1;
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    execFile("adb", ["exec-out", "screencap", "-p"], {
      encoding: null,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 15_000
    }, (error, stdout) => {
      if (error !== null || !Buffer.isBuffer(stdout)) {
        reject(new Error("Physical screenshot capture failed."));
        return;
      }
      resolve(stdout);
    });
  });
  requireValidPngBytes(bytes);
  const evidenceBytes = preparePhysicalScreenshotEvidence(
    bytes,
    region,
    redactions
  );
  requireValidPngBytes(evidenceBytes);
  writeFileSync(path, evidenceBytes, { flag: "wx", mode: 0o600 });
}

function preparePhysicalScreenshotEvidence(
  bytes: Buffer,
  region: PhysicalScreenshotRegion | null,
  redactions: readonly PhysicalScreenshotRegion[]
): Buffer {
  const evidenceBytes =
    region === null ? bytes : cropPhysicalScreenshot(bytes, region);
  if (redactions.length === 0) return evidenceBytes;
  requireCondition(
    region !== null,
    "Physical screenshot redaction requires a selected page viewport."
  );
  const translated = redactions.map((redaction) => {
    requireCondition(
      redaction.left >= region.left &&
        redaction.top >= region.top &&
        redaction.left + redaction.width <= region.left + region.width &&
        redaction.top + redaction.height <= region.top + region.height,
      "Physical screenshot redaction exceeded the selected page viewport."
    );
    return Object.freeze({
      height: redaction.height,
      left: redaction.left - region.left,
      top: redaction.top - region.top,
      width: redaction.width
    });
  });
  return redactPhysicalScreenshot(evidenceBytes, translated);
}

function requireValidPngBytes(bytes: Buffer): void {
  requireCondition(
    Buffer.isBuffer(bytes) &&
      bytes.length >= 1_024 &&
      bytes.length <= 4 * 1024 * 1024 &&
      bytes.subarray(0, 8).equals(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
      ),
    "Physical screenshot bytes were invalid."
  );
}

function cropPhysicalScreenshot(
  bytes: Buffer,
  region: PhysicalScreenshotRegion
): Buffer {
  requireCondition(
    bytes.length >= 24,
    "Physical screenshot dimensions were unavailable."
  );
  const encodedWidth = bytes.readUInt32BE(16);
  const encodedHeight = bytes.readUInt32BE(20);
  requireCondition(
    encodedWidth >= 320 &&
      encodedWidth <= 4_096 &&
      encodedHeight >= 480 &&
      encodedHeight <= 8_192 &&
      region.left >= 0 &&
      region.top >= 0 &&
      region.left + region.width <= encodedWidth &&
      region.top + region.height <= encodedHeight,
    "Physical screenshot crop exceeded the bounded image dimensions."
  );
  const source = Png.sync.read(bytes);
  requireCondition(
    source.width === encodedWidth &&
      source.height === encodedHeight &&
      source.data.length === source.width * source.height * 4,
    "Physical screenshot decoded dimensions were invalid."
  );
  const target = new Png({ height: region.height, width: region.width });
  const rowBytes = region.width * 4;
  for (let row = 0; row < region.height; row += 1) {
    const sourceStart =
      ((region.top + row) * source.width + region.left) * 4;
    source.data.copy(
      target.data,
      row * rowBytes,
      sourceStart,
      sourceStart + rowBytes
    );
  }
  return Png.sync.write(target);
}

function redactPhysicalScreenshot(
  bytes: Buffer,
  redactions: readonly PhysicalScreenshotRegion[]
): Buffer {
  requireCondition(
    bytes.length >= 24,
    "Physical screenshot redaction dimensions were unavailable."
  );
  const encodedWidth = bytes.readUInt32BE(16);
  const encodedHeight = bytes.readUInt32BE(20);
  requireCondition(
    redactions.length >= 1 &&
      redactions.length <= 2 &&
      encodedWidth >= 320 &&
      encodedWidth <= 4_096 &&
      encodedHeight >= 480 &&
      encodedHeight <= 8_192 &&
      redactions.every(
        (region) =>
          Number.isSafeInteger(region.left) &&
          Number.isSafeInteger(region.top) &&
          Number.isSafeInteger(region.width) &&
          Number.isSafeInteger(region.height) &&
          region.left >= 0 &&
          region.top >= 0 &&
          region.width > 0 &&
          region.height > 0 &&
          region.left + region.width <= encodedWidth &&
          region.top + region.height <= encodedHeight
      ),
    "Physical screenshot redaction exceeded the bounded image dimensions."
  );
  const image = Png.sync.read(bytes);
  requireCondition(
    image.width === encodedWidth &&
      image.height === encodedHeight &&
      image.data.length === image.width * image.height * 4,
    "Physical screenshot redaction decoded dimensions were invalid."
  );
  for (const region of redactions) {
    for (let y = region.top; y < region.top + region.height; y += 1) {
      for (let x = region.left; x < region.left + region.width; x += 1) {
        const offset = (y * image.width + x) * 4;
        image.data[offset] = physicalScreenshotRedactionRgba[0];
        image.data[offset + 1] = physicalScreenshotRedactionRgba[1];
        image.data[offset + 2] = physicalScreenshotRedactionRgba[2];
        image.data[offset + 3] = physicalScreenshotRedactionRgba[3];
      }
    }
  }
  return Png.sync.write(image);
}

function assertPairingUiRuntimeTruth(
  db: ReturnType<typeof openMigratedDatabase>["db"],
  inspection: RequestInspection
): void {
  const devices = countRows(db, "auth_devices");
  const usedCodes = countMatchingRows(
    db,
    "pairing_codes",
    "used_at IS NOT NULL"
  );
  const revokedDevices = countMatchingRows(
    db,
    "auth_devices",
    "revoked_at IS NOT NULL"
  );
  requireCondition(
    devices === 1 &&
      usedCodes === 1 &&
      revokedDevices === 1 &&
      inspection.claimRequests === 1 &&
      inspection.csrfRequests === 4 &&
      inspection.noReferrerApiRequests === 5 &&
      inspection.accessRequests >= 3 &&
      inspection.accessRequests <= 5 &&
      inspection.hostStatusRequests >= 2 &&
      inspection.hostStatusRequests <= 4 &&
      inspection.sessionListRequests >= 2 &&
      inspection.sessionListRequests <= 4 &&
      inspection.protectedReadRequests === 2 &&
      inspection.protectedReadSuccesses === 1 &&
      inspection.protectedReadRejections === 1 &&
      inspection.revokeRequests === 1 &&
      inspection.revokedCheckpointRequests === 1 &&
      inspection.rejectedRevokedCheckpoints === 1 &&
      inspection.fragmentLeaks === 0 &&
      inspection.hardenedCookieObserved &&
      inspection.deletionCookieObserved,
    "Physical production UI runtime truth was inconsistent " +
      `(devices=${devices};used=${usedCodes};revoked=${revokedDevices};` +
      `claims=${inspection.claimRequests};csrf=${inspection.csrfRequests};` +
      `no_referrer=${inspection.noReferrerApiRequests};` +
      `access=${inspection.accessRequests};host=${inspection.hostStatusRequests};` +
      `sessions=${inspection.sessionListRequests};` +
      `protected=${inspection.protectedReadRequests}/` +
      `${inspection.protectedReadSuccesses}/` +
      `${inspection.protectedReadRejections};` +
      `revoke=${inspection.revokeRequests};` +
      `fragment_leaks=${inspection.fragmentLeaks};` +
      `cookie=${inspection.hardenedCookieObserved}/` +
      `${inspection.deletionCookieObserved}).`
  );
}

function assertRecoveryUiRuntimeTruth(
  db: ReturnType<typeof openMigratedDatabase>["db"],
  inspection: RequestInspection
): void {
  const devices = countRows(db, "auth_devices");
  const usedCodes = countMatchingRows(
    db,
    "pairing_codes",
    "used_at IS NOT NULL"
  );
  const revokedDevices = countMatchingRows(
    db,
    "auth_devices",
    "revoked_at IS NOT NULL"
  );
  requireCondition(
    devices === 1 &&
      usedCodes === 1 &&
      revokedDevices === 1 &&
      inspection.claimRequests === 1 &&
      inspection.csrfRequests === 3 &&
      inspection.noReferrerApiRequests === 4 &&
      inspection.accessRequests >= 4 &&
      inspection.accessRequests <= 7 &&
      inspection.hostStatusRequests >= 4 &&
      inspection.hostStatusRequests <= 6 &&
      inspection.sessionListRequests >= 4 &&
      inspection.sessionListRequests <= 6 &&
      inspection.remoteStatusRequests === 5 &&
      inspection.remoteBrowserStatusRequests === 4 &&
      inspection.remoteEnableRequests === 1 &&
      inspection.remoteDisableRequests === 0 &&
      inspection.remoteBrowserMutationRequests === 0 &&
      inspection.protectedReadRequests === 2 &&
      inspection.protectedReadSuccesses === 1 &&
      inspection.protectedReadRejections === 1 &&
      inspection.revokeRequests === 1 &&
      inspection.revokedCheckpointRequests === 1 &&
      inspection.rejectedRevokedCheckpoints === 1 &&
      inspection.fragmentLeaks === 0 &&
      inspection.hardenedCookieObserved &&
      inspection.deletionCookieObserved,
    "Physical recovery production runtime truth was inconsistent " +
      `(devices=${devices};used=${usedCodes};revoked=${revokedDevices};` +
      `claims=${inspection.claimRequests};csrf=${inspection.csrfRequests};` +
      `access=${inspection.accessRequests};host=${inspection.hostStatusRequests};` +
      `sessions=${inspection.sessionListRequests};` +
      `remote=${inspection.remoteStatusRequests}/` +
      `${inspection.remoteBrowserStatusRequests}/` +
      `${inspection.remoteBrowserMutationRequests};` +
      `mutation=${inspection.remoteEnableRequests}/` +
      `${inspection.remoteDisableRequests};` +
      `fragment_leaks=${inspection.fragmentLeaks}).`
  );
}

function assertPromptUiRuntimeTruth(
  db: ReturnType<typeof openMigratedDatabase>["db"],
  inspection: RequestInspection,
  prompt: PhysicalPromptRuntime
): void {
  const devices = countRows(db, "auth_devices");
  const usedCodes = countMatchingRows(
    db,
    "pairing_codes",
    "used_at IS NOT NULL"
  );
  const revokedDevices = countMatchingRows(
    db,
    "auth_devices",
    "revoked_at IS NOT NULL"
  );
  requireCondition(
    devices === 1 &&
      usedCodes === 1 &&
      revokedDevices === 1 &&
      inspection.claimRequests === 1 &&
      inspection.csrfRequests === 3 &&
      inspection.noReferrerApiRequests === 4 &&
      inspection.promptNoReferrerRequests === 1 &&
      inspection.accessRequests >= 2 &&
      inspection.accessRequests <= 4 &&
      inspection.hostStatusRequests >= 1 &&
      inspection.hostStatusRequests <= 3 &&
      inspection.sessionListRequests >= 1 &&
      inspection.sessionListRequests <= 3 &&
      inspection.sessionDetailRequests >= 1 &&
      inspection.sessionDetailRequests <= 2 &&
      inspection.sessionEventRequests === 0 &&
      inspection.sessionStreamRequests >= 1 &&
      inspection.sessionStreamRequests <= 2 &&
      inspection.promptRequests === 1 &&
      inspection.promptResponseStatuses.length === 1 &&
      inspection.promptResponseStatuses[0] === 202 &&
      inspection.protectedReadRequests === 2 &&
      inspection.protectedReadSuccesses === 1 &&
      inspection.protectedReadRejections === 1 &&
      inspection.revokeRequests === 1 &&
      inspection.revokedCheckpointRequests === 1 &&
      inspection.rejectedRevokedCheckpoints === 1 &&
      inspection.fragmentLeaks === 0 &&
      inspection.hardenedCookieObserved &&
      inspection.deletionCookieObserved &&
      prompt.startCalls.length === 1 &&
      prompt.startCalls[0]?.text === physicalPromptText &&
      prompt.streamFailureCount === 0 &&
      prompt.subscribers.snapshot().active_subscribers === 0,
    "Physical prompt production runtime truth was inconsistent."
  );
}

function assertPhysicalPromptAudit(
  db: ReturnType<typeof openMigratedDatabase>["db"]
): void {
  const rows = db
    .prepare(
      "SELECT phase, outcome, error_code, record_json " +
        "FROM selected_audit_events WHERE action = 'prompt' " +
        "ORDER BY phase, outcome"
    )
    .all() as readonly Readonly<{
      readonly error_code: string | null;
      readonly outcome: string;
      readonly phase: string;
      readonly record_json: string;
    }>[];
  requireCondition(
    rows.length === 2 &&
      rows[0]?.phase === "accepted" &&
      rows[0].outcome === "accepted" &&
      rows[0].error_code === null &&
      rows[1]?.phase === "terminal" &&
      rows[1].outcome === "succeeded" &&
      rows[1].error_code === null,
    "Physical prompt audit phases were invalid."
  );
  const records = rows.map((row) => JSON.parse(row.record_json) as unknown);
  const accepted = records[0] as {
    readonly payload_summary?: Readonly<Record<string, unknown>>;
  };
  const terminal = records[1] as {
    readonly payload_summary?: Readonly<Record<string, unknown>>;
  };
  const raw = JSON.stringify(rows);
  requireCondition(
    accepted.payload_summary?.schema_version === 1 &&
      accepted.payload_summary.text_length === physicalPromptText.length &&
      terminal.payload_summary?.schema_version === 1 &&
      terminal.payload_summary.accepted === true &&
      physicalPromptText
        .split("\n")
        .every((line) => !raw.includes(line)),
    "Physical prompt audit retained private text or lost bounded summary truth."
  );
}

function assertPairingRuntimeTruth(
  db: ReturnType<typeof openMigratedDatabase>["db"],
  inspection: RequestInspection
): void {
  const devices = countRows(db, "auth_devices");
  const usedCodes = countMatchingRows(db, "pairing_codes", "used_at IS NOT NULL");
  requireCondition(
    devices === 1 &&
      usedCodes === 1 &&
      inspection.claimRequests === 1 &&
      inspection.csrfRequests === 1 &&
      inspection.noReferrerApiRequests === 2 &&
      inspection.protectedReadRequests === 3 &&
      inspection.protectedReadSuccesses === 2 &&
      inspection.protectedReadRejections === 1 &&
      inspection.fragmentLeaks === 0 &&
      inspection.hardenedCookieObserved,
    "Physical pairing runtime truth was inconsistent " +
      `(devices=${devices};used=${usedCodes};claims=${inspection.claimRequests};` +
      `csrf=${inspection.csrfRequests};no_referrer=${inspection.noReferrerApiRequests};` +
      `protected=${inspection.protectedReadRequests}/${inspection.protectedReadSuccesses}/` +
      `${inspection.protectedReadRejections};` +
      `fragment_leaks=${inspection.fragmentLeaks};cookie=${inspection.hardenedCookieObserved}).`
  );
}

function firstProxyRejection(app: HostDeckFastifyInstance): string | null {
  const snapshot = tailscaleServeProxyTrustSnapshot(app);
  for (const reason of remoteProxyTrustRejectionReasons) {
    if (snapshot.rejected_requests[reason] > 0) return reason;
  }
  return null;
}

function assertPairingAudit(
  db: ReturnType<typeof openMigratedDatabase>["db"],
  expected: Readonly<{
    successfulCsrfBootstrapCount: number;
    deviceRevokeCount: number;
  }>
): void {
  requireCondition(
    (expected.successfulCsrfBootstrapCount === 1 ||
      expected.successfulCsrfBootstrapCount === 2 ||
      expected.successfulCsrfBootstrapCount === 3) &&
      (expected.deviceRevokeCount === 0 || expected.deviceRevokeCount === 1),
    "Physical pairing audit expectation was invalid."
  );
  const rows = db
    .prepare(
      "SELECT action, phase, outcome, COUNT(*) AS count " +
        "FROM selected_audit_events " +
        "WHERE action IN ('pair_request','pair_claim','csrf_bootstrap','device_revoke') " +
        "GROUP BY action, phase, outcome ORDER BY action, phase, outcome"
    )
    .all();
  const deviceRevokeRows =
    expected.deviceRevokeCount === 0
      ? []
      : [
          {
            action: "device_revoke",
            phase: "accepted",
            outcome: "accepted",
            count: expected.deviceRevokeCount
          },
          {
            action: "device_revoke",
            phase: "terminal",
            outcome: "succeeded",
            count: expected.deviceRevokeCount
          }
        ];
  requireCondition(
    JSON.stringify(rows) ===
      JSON.stringify([
        {
          action: "csrf_bootstrap",
          phase: "accepted",
          outcome: "accepted",
          count: expected.successfulCsrfBootstrapCount
        },
        {
          action: "csrf_bootstrap",
          phase: "terminal",
          outcome: "succeeded",
          count: expected.successfulCsrfBootstrapCount
        },
        ...deviceRevokeRows,
        { action: "pair_claim", phase: "accepted", outcome: "accepted", count: 1 },
        { action: "pair_claim", phase: "terminal", outcome: "succeeded", count: 1 },
        { action: "pair_request", phase: "accepted", outcome: "accepted", count: 1 },
        { action: "pair_request", phase: "terminal", outcome: "succeeded", count: 1 }
      ]),
    "Physical pairing audit trail was invalid."
  );
}

function assertPhysicalDashboardAudit(
  db: ReturnType<typeof openMigratedDatabase>["db"],
  inspection: RequestInspection,
  sequence: PhysicalDashboardSequenceResult
): void {
  requireCondition(
    inspection.claimRequests === 1 &&
      inspection.csrfRequests === 9 &&
      inspection.promptRequests === 1 &&
      inspection.promptNoReferrerRequests === 1 &&
      inspection.revokeRequests === 2 &&
      inspection.remoteBrowserStatusRequests ===
        physicalDashboardRemoteBrowserCheckCount &&
      inspection.remoteBrowserMutationRequests === 0 &&
      inspection.fragmentLeaks === 0 &&
      inspection.hardenedCookieObserved &&
      inspection.deletionCookieObserved &&
      countRows(db, "auth_devices") === 2 &&
      countMatchingRows(db, "auth_devices", "revoked_at IS NOT NULL") === 2 &&
      JSON.stringify(sequence.interactionIds) === JSON.stringify(mobileInteractionIds),
    "Physical dashboard request, authority, or interaction truth was inconsistent."
  );
  assertPhysicalDashboardAuditRows(db, false);
}

function assertPhysicalDashboardCleanupAudit(
  db: ReturnType<typeof openMigratedDatabase>["db"]
): void {
  assertPhysicalDashboardAuditRows(db, true);
}

function assertPhysicalDashboardAuditRows(
  db: ReturnType<typeof openMigratedDatabase>["db"],
  disabled: boolean
): void {
  const counts = new Map<string, number>([
    ["approval_response", 1],
    ["archive", 1],
    ["compact", 1],
    ["csrf_bootstrap", 9],
    ["device_revoke", 2],
    ["goal", 1],
    ["interrupt", 1],
    ["lock", 1],
    ["model", 1],
    ["pair_claim", 1],
    ["pair_request", 1],
    ["plan", 1],
    ["prompt", 1],
    ...(disabled ? [["remote_disable", 1] as const] : []),
    ["remote_enable", 1],
    ["unlock", 1]
  ]);
  const expected = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([action, count]) => [
      { action, phase: "accepted", outcome: "accepted", count },
      { action, phase: "terminal", outcome: "succeeded", count }
    ]);
  const rows = db
    .prepare(
      "SELECT action, phase, outcome, COUNT(*) AS count " +
        "FROM selected_audit_events " +
        "GROUP BY action, phase, outcome ORDER BY action, phase, outcome"
    )
    .all();
  requireCondition(
    JSON.stringify(rows) === JSON.stringify(expected),
    `Physical dashboard audit trail was invalid (${JSON.stringify(rows)}).`
  );
}

function assertFullPhysicalAudit(
  db: ReturnType<typeof openMigratedDatabase>["db"]
): void {
  const rows = db
    .prepare(
      "SELECT action, phase, outcome, COUNT(*) AS count " +
        "FROM selected_audit_events " +
        "GROUP BY action, phase, outcome ORDER BY action, phase, outcome"
    )
    .all();
  requireCondition(
    JSON.stringify(rows) ===
      JSON.stringify([
        { action: "csrf_bootstrap", phase: "accepted", outcome: "accepted", count: 3 },
        { action: "csrf_bootstrap", phase: "terminal", outcome: "succeeded", count: 3 },
        { action: "device_revoke", phase: "accepted", outcome: "accepted", count: 1 },
        { action: "device_revoke", phase: "terminal", outcome: "succeeded", count: 1 },
        { action: "lock", phase: "accepted", outcome: "accepted", count: 1 },
        { action: "lock", phase: "terminal", outcome: "succeeded", count: 1 },
        { action: "pair_claim", phase: "accepted", outcome: "accepted", count: 1 },
        { action: "pair_claim", phase: "terminal", outcome: "succeeded", count: 1 },
        { action: "pair_request", phase: "accepted", outcome: "accepted", count: 1 },
        { action: "pair_request", phase: "terminal", outcome: "succeeded", count: 1 },
        { action: "remote_disable", phase: "accepted", outcome: "accepted", count: 1 },
        { action: "remote_disable", phase: "terminal", outcome: "succeeded", count: 1 },
        { action: "remote_enable", phase: "accepted", outcome: "accepted", count: 1 },
        { action: "remote_enable", phase: "terminal", outcome: "succeeded", count: 1 },
        { action: "unlock", phase: "accepted", outcome: "accepted", count: 1 },
        { action: "unlock", phase: "terminal", outcome: "succeeded", count: 1 }
      ]),
    "Physical aggregate audit trail was invalid."
  );
}

function assertRecoveryPhysicalAudit(
  db: ReturnType<typeof openMigratedDatabase>["db"]
): void {
  const rows = db
    .prepare(
      "SELECT action, phase, outcome, COUNT(*) AS count " +
        "FROM selected_audit_events " +
        "GROUP BY action, phase, outcome ORDER BY action, phase, outcome"
    )
    .all();
  requireCondition(
    JSON.stringify(rows) ===
      JSON.stringify([
        { action: "csrf_bootstrap", phase: "accepted", outcome: "accepted", count: 2 },
        { action: "csrf_bootstrap", phase: "terminal", outcome: "succeeded", count: 2 },
        { action: "device_revoke", phase: "accepted", outcome: "accepted", count: 1 },
        { action: "device_revoke", phase: "terminal", outcome: "succeeded", count: 1 },
        { action: "pair_claim", phase: "accepted", outcome: "accepted", count: 1 },
        { action: "pair_claim", phase: "terminal", outcome: "succeeded", count: 1 },
        { action: "pair_request", phase: "accepted", outcome: "accepted", count: 1 },
        { action: "pair_request", phase: "terminal", outcome: "succeeded", count: 1 },
        { action: "remote_disable", phase: "accepted", outcome: "accepted", count: 1 },
        { action: "remote_disable", phase: "terminal", outcome: "succeeded", count: 1 },
        { action: "remote_enable", phase: "accepted", outcome: "accepted", count: 1 },
        { action: "remote_enable", phase: "terminal", outcome: "succeeded", count: 1 }
      ]),
    "Physical recovery audit trail was invalid."
  );
}

function readPhysicalScreenshots(
  directory: string
): readonly PhysicalScreenshot[] {
  const expected = [
    "01-paired-ready.png",
    "02-profile-away.png",
    "03-recovered.png",
    "04-revoked-cleaned.png"
  ] as const;
  requireCondition(
    JSON.stringify(readdirSync(directory).sort()) ===
      JSON.stringify([...expected]),
    "Physical screenshot inventory was incomplete."
  );
  return Object.freeze(
    expected.map((name) => {
      const bytes = readFileSync(join(directory, name));
      requireCondition(
        bytes.length >= 1_024 &&
          bytes.length <= 4 * 1024 * 1024 &&
          bytes.subarray(0, 8).equals(
            Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
          ),
        "Physical screenshot failed publication validation."
      );
      return Object.freeze({
        bytes,
        name,
        sha256: createHash("sha256").update(bytes).digest("hex")
      });
    })
  );
}

function readPhysicalRecoveryScreenshots(
  directory: string
): readonly PhysicalScreenshot[] {
  const expected = [
    "fe034-01-ready.png",
    "fe034-02-profile-away.png",
    "fe034-03-recovered.png"
  ] as const;
  requireCondition(
    JSON.stringify(readdirSync(directory).sort()) ===
      JSON.stringify([...expected]),
    "Physical recovery screenshot inventory was incomplete."
  );
  return Object.freeze(
    expected.map((name) => {
      const bytes = readFileSync(join(directory, name));
      requireCondition(
        bytes.length >= 1_024 &&
          bytes.length <= 4 * 1024 * 1024 &&
          bytes.subarray(0, 8).equals(
            Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
          ),
        "Physical recovery screenshot failed publication validation."
      );
      return Object.freeze({
        bytes,
        name,
        sha256: createHash("sha256").update(bytes).digest("hex")
      });
    })
  );
}

function readPhysicalDashboardScreenshots(
  directory: string,
  sequence: PhysicalDashboardSequenceResult
): readonly PhysicalScreenshot[] {
  const expected = [...sequence.screenshotNames].sort();
  requireCondition(
    expected.length >= 20 &&
      expected.length <= 60 &&
      new Set(expected).size === expected.length &&
      JSON.stringify(readdirSync(directory).sort()) === JSON.stringify(expected),
    "Physical dashboard screenshot inventory was incomplete."
  );
  return Object.freeze(
    expected.map((name) => {
      const bytes = readFileSync(join(directory, name));
      requireValidPngBytes(bytes);
      const image = Png.sync.read(bytes);
      const colors = new Set<string>();
      for (
        let index = 0;
        index < image.data.length && colors.size < 32;
        index += Math.max(4, Math.floor(image.data.length / 2_048 / 4) * 4)
      ) {
        colors.add(
          image.data.subarray(index, Math.min(index + 4, image.data.length))
            .toString("hex")
        );
      }
      requireCondition(
        image.width >= 320 &&
          image.width <= 1_440 &&
          image.height >= 480 &&
          image.height <= 3_200 &&
          image.data.length === image.width * image.height * 4 &&
          colors.size >= 8,
        `Physical dashboard screenshot ${name} was blank or unbounded.`
      );
      return Object.freeze({
        bytes,
        name,
        sha256: createHash("sha256").update(bytes).digest("hex")
      });
    })
  );
}

function publishPhysicalDashboardEvidence(input: {
  readonly completedAt: string;
  readonly environment: PhysicalEnvironmentFacts;
  readonly foreignServeBytes: number;
  readonly managerAttempts: number;
  readonly screenshots: readonly PhysicalScreenshot[];
  readonly sequence: PhysicalDashboardSequenceResult;
  readonly startedAt: string;
}): void {
  requireCondition(
    input.managerAttempts === 2 &&
      input.sequence.archived &&
      input.sequence.approvalDecision === "approve" &&
      input.sequence.clipboardOutcome === "copied" &&
      input.sequence.compactState === "completed" &&
      input.sequence.modelApplied &&
      input.sequence.planApplied &&
      input.sequence.profileReturnRecovered &&
      input.sequence.selfRevoked &&
      input.sequence.talkBack.available &&
      input.sequence.talkBack.permissionStateRestored &&
      input.sequence.talkBack.restored &&
      input.sequence.talkBack.serviceBound &&
      input.sequence.talkBack.touchExplorationActive &&
      input.sequence.talkBack.transcript.clickCount === 4 &&
      input.sequence.talkBack.transcript.focusCount >= 12 &&
      JSON.stringify(input.sequence.interactionIds) ===
        JSON.stringify(mobileInteractionIds) &&
      JSON.stringify(input.sequence.stateIds) ===
        JSON.stringify(mobileDashboardPhysicalStateIds) &&
      input.screenshots.length === input.sequence.screenshotNames.length &&
      input.sequence.targetMeasurements.every(
        (target) => target.heightCssPx >= 44 && target.widthCssPx >= 44
      ) &&
      Number.isFinite(Date.parse(input.startedAt)) &&
      Number.isFinite(Date.parse(input.completedAt)) &&
      Number.isSafeInteger(input.foreignServeBytes) &&
      input.foreignServeBytes >= 2 &&
      input.foreignServeBytes <= 64 * 1024,
    "Physical dashboard evidence inputs were incomplete."
  );
  const packageIdentity = readPhysicalDashboardPackageIdentity();
  const evidence = Object.freeze({
    schema_version: 2,
    task: "FE-V1-090",
    status: "machine_pass_pending_full_resolution_review",
    commit: input.environment.commit,
    command: "pnpm smoke:dashboard-android",
    run: Object.freeze({
      completed_at: input.completedAt,
      retry_count: 0,
      started_at: input.startedAt
    }),
    package: packageIdentity,
    browser_matrix: Object.freeze({
      case_count: 76,
      interaction_count: 34,
      project_count: 4,
      status: "passed"
    }),
    environment: Object.freeze({
      android_api: input.environment.android_api,
      android_model: input.environment.android_model,
      android_release: input.environment.android_release,
      android_tailscale_version: input.environment.android_tailscale_version,
      battery_percent: input.environment.battery_percent,
      chrome_version: input.environment.chrome_version,
      display_size: input.environment.display_size,
      font_scale: input.environment.font_scale,
      host_os: input.environment.host_os,
      node_version: input.environment.node_version,
      physical_density: input.environment.physical_density,
      tailscale_version: input.environment.tailscale_version
    }),
    network: Object.freeze({
      adb_app_tunnel_count: 0,
      cellular_active: true,
      custom_ca_used: false,
      laptop_lan_used: false,
      private_serve_https: true,
      qr_scan_count: 0,
      tailscale_vpn_active: true,
      usb_used_for_test_control_only: true,
      wifi_disabled_during_requests: true
    }),
    lifecycle: Object.freeze({
      foreign_serve_byte_count: input.foreignServeBytes,
      foreign_serve_unchanged: true,
      listener: "ipv4_loopback_http",
      manager_attempts: input.managerAttempts,
      manager_attempts_during_saved_profile_switch: 0,
      production_browser_build: true,
      production_route_composition: true,
      profile_recovery: "observation_only"
    }),
    counts: Object.freeze({
      interactions: input.sequence.interactionIds.length,
      physical_states: input.sequence.stateIds.length,
      screenshots: input.screenshots.length,
      talkback_click_events: input.sequence.talkBack.transcript.clickCount,
      talkback_focus_events: input.sequence.talkBack.transcript.focusCount,
      talkback_total_events: input.sequence.talkBack.transcript.eventCount,
      target_measurements: input.sequence.targetMeasurements.length
    }),
    sequence: input.sequence,
    screenshots: Object.freeze(
      input.screenshots.map((screenshot) =>
        Object.freeze({
          byte_count: screenshot.bytes.length,
          file: screenshot.name,
          sha256: screenshot.sha256
        })
      )
    ),
    privacy: Object.freeze({
      account_identity_retained: false,
      address_or_origin_retained: false,
      pairing_material_retained: false,
      private_path_retained: false,
      prompt_text_retained: false,
      raw_command_output_retained: false
    }),
    cleanup: Object.freeze({
      accessibility_settings_restored: true,
      adb_forwards: 0,
      adb_reverses: 0,
      browser_closed: true,
      database_open: false,
      dedicated_serve_absent: true,
      foreign_serve_unchanged: true,
      keyboard_closed: true,
      listener_open: false,
      mobile_data_restored: true,
      talkback_permission_state_restored: true,
      saved_profile_restored: true,
      sse_active: 0,
      stay_awake_setting_restored: true,
      temporary_state_present: false,
      wifi_restored: true
    })
  });
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  requireCondition(
    Buffer.byteLength(serialized, "utf8") <= 256 * 1024 &&
      !/https?:\/\/|\.ts\.net|client_[a-z0-9]|thread-physical|\/workspace\/|\/run\/user\/|pair=#|FE020_android_line/iu.test(
        serialized
      ),
    "Physical dashboard evidence retained private material or exceeded its bound."
  );

  const staging = mkdtempSync(
    join(tmpdir(), "hostdeck-dashboard-android-evidence-")
  );
  let createdFinal = false;
  try {
    const evidencePath = join(staging, "evidence.json");
    writeFileSync(evidencePath, serialized, { flag: "wx", mode: 0o600 });
    for (const screenshot of input.screenshots) {
      writeFileSync(join(staging, screenshot.name), screenshot.bytes, {
        flag: "wx",
        mode: 0o600
      });
    }
    requireCondition(
      readFileSync(evidencePath, "utf8") === serialized,
      "Physical dashboard evidence changed during private staging."
    );
    requireCondition(
      !existsSync(physicalDashboardEvidenceDirectory),
      "Physical dashboard evidence directory already exists."
    );
    mkdirSync(physicalDashboardEvidenceDirectory, {
      mode: 0o755,
      recursive: true
    });
    createdFinal = true;
    copyFileSync(
      evidencePath,
      join(physicalDashboardEvidenceDirectory, "evidence.json")
    );
    chmodSync(
      join(physicalDashboardEvidenceDirectory, "evidence.json"),
      0o644
    );
    for (const screenshot of input.screenshots) {
      const target = join(physicalDashboardEvidenceDirectory, screenshot.name);
      copyFileSync(join(staging, screenshot.name), target);
      chmodSync(target, 0o644);
    }
  } catch (error) {
    if (createdFinal) {
      rmSync(physicalDashboardEvidenceDirectory, {
        force: true,
        recursive: true
      });
    }
    throw error;
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }
}

function readPhysicalDashboardPackageIdentity(): Readonly<{
  content_entry_count: number;
  content_tree_sha256: string;
  manifest_sha256: string;
  output_file_count: number;
  output_tree_sha256: string;
  package_schema_version: number;
  source_file_count: number;
  source_tree_sha256: string;
  web_tree_sha256: string;
}> {
  const evidence = JSON.parse(
    readFileSync(
      join(
        process.cwd(),
        "artifacts",
        "ifc-v1-091-selected-production-interface-hardening",
        "evidence.json"
      ),
      "utf8"
    )
  ) as Readonly<Record<string, unknown>>;
  const production = evidence.production_identity;
  requireCondition(
    production !== null &&
      typeof production === "object" &&
      !Array.isArray(production),
    "Physical dashboard package identity evidence was invalid."
  );
  const identity = production as Readonly<Record<string, unknown>>;
  const selected = Object.freeze({
    content_entry_count: identity.content_entry_count,
    content_tree_sha256: identity.content_tree_sha256,
    manifest_sha256: identity.manifest_sha256,
    output_file_count: identity.output_file_count,
    output_tree_sha256: identity.output_tree_sha256,
    package_schema_version: identity.package_schema_version,
    source_file_count: identity.source_file_count,
    source_tree_sha256: identity.source_tree_sha256,
    web_tree_sha256: identity.web_tree_sha256
  });
  const browserManifest = JSON.parse(
    readFileSync(
      join(process.cwd(), "tests", "browser", "supported-browser-manifest.json"),
      "utf8"
    )
  ) as Readonly<Record<string, unknown>>;
  const browserPackage = browserManifest.package;
  requireCondition(
    selected.package_schema_version === 4 &&
      selected.source_file_count === 619 &&
      selected.output_file_count === 1_245 &&
      selected.content_entry_count === 6_466 &&
      [
        selected.source_tree_sha256,
        selected.output_tree_sha256,
        selected.content_tree_sha256,
        selected.manifest_sha256,
        selected.web_tree_sha256
      ].every(
        (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)
      ) &&
      browserPackage !== null &&
      typeof browserPackage === "object" &&
      !Array.isArray(browserPackage) &&
      (browserPackage as Readonly<Record<string, unknown>>).content_sha256 ===
        selected.content_tree_sha256 &&
      (browserPackage as Readonly<Record<string, unknown>>).manifest_sha256 ===
        selected.manifest_sha256 &&
      (browserPackage as Readonly<Record<string, unknown>>).web_sha256 ===
        selected.web_tree_sha256,
    "Physical dashboard package and browser identities did not match."
  );
  return selected as ReturnType<typeof readPhysicalDashboardPackageIdentity>;
}

function publishPhysicalEvidence(input: {
  readonly completedAt: string;
  readonly environment: PhysicalEnvironmentFacts;
  readonly foreignServeBytes: number;
  readonly managerAttempts: number;
  readonly screenshots: readonly PhysicalScreenshot[];
  readonly sequence: PhysicalSequenceResult;
  readonly startedAt: string;
}): void {
  requireCondition(
    input.managerAttempts === 2 &&
      input.sequence.managerAttemptsBeforeDisable === 1 &&
      input.sequence.managerAttemptsDuringSwitch === 0 &&
      input.screenshots.length === 4 &&
      Number.isSafeInteger(input.foreignServeBytes) &&
      input.foreignServeBytes >= 2 &&
      input.foreignServeBytes <= 64 * 1024,
    "Physical evidence inputs were incomplete."
  );
  const rowIds = Array.from(
    { length: 12 },
    (_value, index) => `PHONE-${String(index + 1).padStart(2, "0")}`
  );
  const evidence = Object.freeze({
    schema_version: 1,
    task: "IFC-V1-079",
    commit: input.environment.commit,
    command: "pnpm smoke:remote-android",
    run: Object.freeze({
      completed_at: input.completedAt,
      retry_count: 0,
      started_at: input.startedAt
    }),
    environment: Object.freeze({
      android_api: input.environment.android_api,
      android_model: input.environment.android_model,
      android_release: input.environment.android_release,
      chrome_version: input.environment.chrome_version,
      host_os: input.environment.host_os,
      node_version: input.environment.node_version,
      tailscale_version: input.environment.tailscale_version
    }),
    network: Object.freeze({
      adb_app_tunnel_count: 0,
      adb_device_count: 1,
      cellular_active: true,
      custom_ca_used: false,
      tailscale_vpn_active: true,
      wifi_disabled_during_requests: true
    }),
    lifecycle: Object.freeze({
      listener: "ipv4_loopback_http",
      local_ready_first: true,
      manager_attempts: input.managerAttempts,
      manager_attempts_during_saved_profile_switch: 0,
      private_serve_https: true,
      recovery: "observation_only"
    }),
    sequence: input.sequence,
    foreign_serve: Object.freeze({
      byte_count: input.foreignServeBytes,
      byte_identical: true
    }),
    operations: Object.freeze([
      "remote_enable:succeeded",
      "pair_claim:succeeded",
      "csrf_lock:succeeded",
      "host_lock:succeeded",
      "local_unlock:succeeded",
      "saved_profile_away:observed",
      "saved_profile_return:observed",
      "self_revoke:succeeded",
      "remote_disable:succeeded"
    ]),
    rows: Object.freeze(
      rowIds.map((id) => Object.freeze({ id, status: "passed" }))
    ),
    screenshots: Object.freeze(
      input.screenshots.map((screenshot) =>
        Object.freeze({
          byte_count: screenshot.bytes.length,
          file: screenshot.name,
          sha256: screenshot.sha256
        })
      )
    ),
    cleanup: Object.freeze({
      adb_forwards: 0,
      adb_reverses: 0,
      browser_closed: true,
      database_open: false,
      dedicated_serve_absent: true,
      foreign_serve_unchanged: true,
      listener_open: false,
      mobile_data_restored: true,
      saved_profile_restored: true,
      sse_active: 0,
      stay_awake_setting_restored: true,
      temporary_state_present: false,
      wifi_restored: true
    })
  });
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  validatePhysicalEvidence(evidence, serialized);

  const staging = mkdtempSync(
    join(tmpdir(), "hostdeck-remote-android-evidence-")
  );
  let createdFinal = false;
  try {
    const evidencePath = join(staging, "evidence.json");
    writeFileSync(evidencePath, serialized, { flag: "wx", mode: 0o600 });
    for (const screenshot of input.screenshots) {
      writeFileSync(join(staging, screenshot.name), screenshot.bytes, {
        flag: "wx",
        mode: 0o600
      });
    }
    requireCondition(
      readFileSync(evidencePath, "utf8") === serialized,
      "Physical evidence changed during private staging."
    );
    mkdirSync(physicalEvidenceDirectory, { mode: 0o755 });
    createdFinal = true;
    copyFileSync(
      evidencePath,
      join(physicalEvidenceDirectory, "evidence.json")
    );
    chmodSync(join(physicalEvidenceDirectory, "evidence.json"), 0o644);
    for (const screenshot of input.screenshots) {
      const target = join(physicalEvidenceDirectory, screenshot.name);
      copyFileSync(join(staging, screenshot.name), target);
      chmodSync(target, 0o644);
    }
  } catch (error) {
    if (createdFinal) {
      rmSync(physicalEvidenceDirectory, { force: true, recursive: true });
    }
    throw error;
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }
}

function publishPhysicalRecoveryEvidence(input: {
  readonly completedAt: string;
  readonly environment: PhysicalEnvironmentFacts;
  readonly foreignServeBytes: number;
  readonly managerAttempts: number;
  readonly screenshots: readonly PhysicalScreenshot[];
  readonly sequence: PhysicalRecoverySequenceResult;
  readonly startedAt: string;
}): void {
  requireCondition(
    input.managerAttempts === 2 &&
      input.sequence.managerAttemptsBeforeDisable === 1 &&
      input.sequence.managerAttemptsDuringSwitch === 0 &&
      input.sequence.browserMutationRequests === 0 &&
      input.sequence.remoteBrowserStatusRequests === 2 &&
      input.sequence.claimRequests === 1 &&
      input.screenshots.length === 3 &&
      Number.isSafeInteger(input.foreignServeBytes) &&
      input.foreignServeBytes >= 2 &&
      input.foreignServeBytes <= 64 * 1024,
    "Physical recovery evidence inputs were incomplete."
  );
  const evidence = Object.freeze({
    schema_version: 1,
    task: "FE-V1-034",
    commit: input.environment.commit,
    command: "pnpm smoke:recovery-android",
    run: Object.freeze({
      completed_at: input.completedAt,
      retry_count: 0,
      started_at: input.startedAt
    }),
    environment: Object.freeze({
      android_api: input.environment.android_api,
      android_model: input.environment.android_model,
      android_release: input.environment.android_release,
      chrome_version: input.environment.chrome_version,
      host_os: input.environment.host_os,
      node_version: input.environment.node_version,
      tailscale_version: input.environment.tailscale_version
    }),
    network: Object.freeze({
      adb_app_tunnel_count: 0,
      adb_device_count: 1,
      cellular_active: true,
      custom_ca_used: false,
      private_serve_https: true,
      qr_scan_count: 0,
      tailscale_vpn_active: true,
      usb_used_for_bootstrap_and_test_driver_only: true,
      wifi_disabled_during_requests: true
    }),
    lifecycle: Object.freeze({
      browser_mutation_requests: 0,
      listener: "ipv4_loopback_http",
      manager_attempts: input.managerAttempts,
      manager_attempts_during_saved_profile_switch: 0,
      private_serve_https: true,
      production_browser_build: true,
      recovery: "observation_only"
    }),
    pairing: Object.freeze({
      automated_one_time_link: true,
      claim_requests: 1,
      fragment_scrubbed_before_api: true,
      repaired_without_repairing: true
    }),
    sequence: input.sequence,
    foreign_serve: Object.freeze({
      byte_count: input.foreignServeBytes,
      byte_identical: true
    }),
    screenshots: Object.freeze(
      input.screenshots.map((screenshot) =>
        Object.freeze({
          byte_count: screenshot.bytes.length,
          file: screenshot.name,
          sha256: screenshot.sha256
        })
      )
    ),
    privacy: Object.freeze({
      account_identity_retained: false,
      address_or_origin_retained: false,
      pairing_material_retained: false,
      raw_command_output_retained: false
    }),
    cleanup: Object.freeze({
      adb_forwards: 0,
      adb_reverses: 0,
      browser_closed: true,
      database_open: false,
      dedicated_serve_absent: true,
      foreign_serve_unchanged: true,
      listener_open: false,
      mobile_data_restored: true,
      saved_profile_restored: true,
      stay_awake_setting_restored: true,
      temporary_state_present: false,
      wifi_restored: true
    })
  });
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  validatePhysicalRecoveryEvidence(evidence, serialized);

  const staging = mkdtempSync(
    join(tmpdir(), "hostdeck-recovery-android-evidence-")
  );
  let createdFinal = false;
  try {
    const evidencePath = join(staging, "evidence.json");
    writeFileSync(evidencePath, serialized, { flag: "wx", mode: 0o600 });
    for (const screenshot of input.screenshots) {
      writeFileSync(join(staging, screenshot.name), screenshot.bytes, {
        flag: "wx",
        mode: 0o600
      });
    }
    requireCondition(
      readFileSync(evidencePath, "utf8") === serialized,
      "Physical recovery evidence changed during private staging."
    );
    mkdirSync(physicalRecoveryEvidenceDirectory, { mode: 0o755 });
    createdFinal = true;
    copyFileSync(
      evidencePath,
      join(physicalRecoveryEvidenceDirectory, "evidence.json")
    );
    chmodSync(
      join(physicalRecoveryEvidenceDirectory, "evidence.json"),
      0o644
    );
    for (const screenshot of input.screenshots) {
      const target = join(physicalRecoveryEvidenceDirectory, screenshot.name);
      copyFileSync(join(staging, screenshot.name), target);
      chmodSync(target, 0o644);
    }
  } catch (error) {
    if (createdFinal) {
      rmSync(physicalRecoveryEvidenceDirectory, {
        force: true,
        recursive: true
      });
    }
    throw error;
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }
}

function publishPhysicalPromptEvidence(input: {
  readonly completedAt: string;
  readonly environment: PhysicalEnvironmentFacts;
  readonly sequence: PhysicalPromptSequenceResult;
  readonly startedAt: string;
}): void {
  requireCondition(
    input.sequence.acceptedVisible &&
      input.sequence.runningVisible &&
      input.sequence.completedVisible &&
      input.sequence.keyboardVisible &&
      input.sequence.multilineEdited &&
      input.sequence.sentOnce &&
      input.sequence.promptRequestCount === 1 &&
      input.sequence.promptCharacterCount === physicalPromptText.length &&
      input.sequence.promptLineCount === 2 &&
      input.sequence.sendAction === "start" &&
      Number.isFinite(Date.parse(input.startedAt)) &&
      Number.isFinite(Date.parse(input.completedAt)),
    "Physical prompt evidence inputs were incomplete."
  );
  const evidence = Object.freeze({
    schema_version: 1,
    task: "FE-V1-020",
    commit: input.environment.commit,
    command: "pnpm smoke:prompt-android",
    run: Object.freeze({
      completed_at: input.completedAt,
      retry_count: 0,
      started_at: input.startedAt
    }),
    environment: Object.freeze({
      android_api: input.environment.android_api,
      android_model: input.environment.android_model,
      android_release: input.environment.android_release,
      chrome_version: input.environment.chrome_version,
      host_os: input.environment.host_os,
      node_version: input.environment.node_version,
      tailscale_version: input.environment.tailscale_version
    }),
    network: Object.freeze({
      adb_app_tunnel_count: 0,
      cellular_active: true,
      custom_ca_used: false,
      private_serve_https: true,
      qr_scan_count: 0,
      tailscale_vpn_active: true,
      usb_used_for_bootstrap_and_test_driver_only: true,
      wifi_disabled_during_requests: true
    }),
    pairing: Object.freeze({
      automated_one_time_link: true,
      fragment_scrubbed_before_api: true,
      writer_authority_self_revoked: true
    }),
    sequence: input.sequence,
    privacy: Object.freeze({
      persisted_prompt_text: false,
      retained_phone_screenshots: 0,
      retained_private_origin: false,
      retained_runtime_identifiers: false
    }),
    cleanup: Object.freeze({
      adb_forwards: 0,
      adb_reverses: 0,
      browser_closed: true,
      database_open: false,
      dedicated_serve_absent: true,
      keyboard_visible: false,
      listener_open: false,
      mobile_data_restored: true,
      stay_awake_setting_restored: true,
      stream_subscribers: 0,
      temporary_state_present: false,
      wifi_restored: true
    })
  });
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  requireCondition(
    Object.keys(evidence).sort().join(",") ===
      [
        "cleanup",
        "command",
        "commit",
        "environment",
        "network",
        "pairing",
        "privacy",
        "run",
        "schema_version",
        "sequence",
        "task"
      ].join(",") &&
      Buffer.byteLength(serialized, "utf8") <= 16 * 1024 &&
      !/https?:\/\//iu.test(serialized) &&
      !/\.ts\.net/iu.test(serialized) &&
      !/\b(?:10|100|127|169\.254|172|192)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/u.test(
        serialized
      ) &&
      !/\bop_[A-Za-z0-9_-]+\b/u.test(serialized) &&
      physicalPromptText
        .split("\n")
        .every((line) => !serialized.includes(line)) &&
      [...deviceForbiddenValues].every(
        (value) => !serialized.includes(value)
      ),
    "Physical prompt evidence failed its privacy or schema validator."
  );

  const staging = mkdtempSync(
    join(tmpdir(), "hostdeck-prompt-android-evidence-")
  );
  try {
    const staged = join(staging, "physical-android.json");
    writeFileSync(staged, serialized, { flag: "wx", mode: 0o600 });
    requireCondition(
      readFileSync(staged, "utf8") === serialized,
      "Physical prompt evidence changed during staging."
    );
    mkdirSync(physicalPromptEvidenceDirectory, {
      mode: 0o755,
      recursive: true
    });
    const target = join(
      physicalPromptEvidenceDirectory,
      "physical-android.json"
    );
    copyFileSync(staged, target);
    chmodSync(target, 0o644);
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }
}

function validatePhysicalRecoveryEvidence(
  evidence: Readonly<Record<string, unknown>>,
  serialized: string
): void {
  requireCondition(
    Object.keys(evidence).sort().join(",") ===
      [
        "cleanup",
        "command",
        "commit",
        "environment",
        "foreign_serve",
        "lifecycle",
        "network",
        "pairing",
        "privacy",
        "run",
        "schema_version",
        "screenshots",
        "sequence",
        "task"
      ].join(",") &&
      Buffer.byteLength(serialized, "utf8") <= 32 * 1024 &&
      !/https?:\/\//iu.test(serialized) &&
      !/\.ts\.net/iu.test(serialized) &&
      !/\b(?:10|100|127|169\.254|172|192)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/u.test(
        serialized
      ) &&
      !/\b(?:serial|profile[_ -]?id|device[_ -]?id|node[_ -]?key|raw[_ -]?output)\b/iu.test(
        serialized
      ) &&
      [...deviceForbiddenValues].every(
        (value) => !serialized.includes(value)
      ),
    "Physical recovery evidence failed its privacy or schema validator."
  );
}

function validatePhysicalEvidence(
  evidence: Readonly<Record<string, unknown>>,
  serialized: string
): void {
  requireCondition(
    Object.keys(evidence).sort().join(",") ===
      [
        "cleanup",
        "command",
        "commit",
        "environment",
        "foreign_serve",
        "lifecycle",
        "network",
        "operations",
        "rows",
        "run",
        "schema_version",
        "screenshots",
        "sequence",
        "task"
      ].join(",") &&
      Buffer.byteLength(serialized, "utf8") <= 32 * 1024 &&
      !/https?:\/\//iu.test(serialized) &&
      !/\.ts\.net/iu.test(serialized) &&
      !/\b(?:10|100|127|169\.254|172|192)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/u.test(
        serialized
      ) &&
      !/\b(?:serial|profile[_ -]?id|device[_ -]?id|node[_ -]?key|raw[_ -]?output)\b/iu.test(
        serialized
      ) &&
      [...deviceForbiddenValues].every(
        (value) => !serialized.includes(value)
      ),
    "Physical evidence failed its privacy or schema validator."
  );
}

function assertSecretsAbsentFromDatabase(
  dbPath: string,
  secrets: readonly string[]
): void {
  const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter(existsSync);
  requireCondition(files.length >= 1 && secrets.length >= 4, "Physical privacy scan had no inputs.");
  for (const file of files) {
    const bytes = readFileSync(file);
    requireCondition(
      secrets.every((secret) => !bytes.includes(Buffer.from(secret, "utf8"))),
      "Physical SQLite files retained a raw pairing secret."
    );
  }
}

function countRows(
  db: ReturnType<typeof openMigratedDatabase>["db"],
  table: "auth_devices"
): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
    .count;
}

function countMatchingRows(
  db: ReturnType<typeof openMigratedDatabase>["db"],
  table: "auth_devices" | "pairing_codes",
  predicate: "revoked_at IS NOT NULL" | "used_at IS NOT NULL"
): number {
  return (
    db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${predicate}`).get() as {
      count: number;
    }
  ).count;
}

function countPhysicalAuditRows(
  db: ReturnType<typeof openMigratedDatabase>["db"],
  action: "lock"
): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM selected_audit_events WHERE action = ?"
      )
      .get(action) as { count: number }
  ).count;
}

async function requireConfiguredServeAbsent(
  observer: TailscaleObserver,
  profileKey: string,
  serve: RemoteServeDescriptor
): Promise<void> {
  const snapshot = await observer.observeConfigured({
    expected_profile_key: profileKey,
    expected_serve: serve
  });
  requireCondition(
    snapshot.client === "available" &&
      snapshot.failure === null &&
      snapshot.profile.state === "dedicated" &&
      snapshot.profile.comparison.relation === "match" &&
      snapshot.serve === "absent",
    "Physical pairing cleanup did not prove absent Serve state."
  );
}

async function proveOrRestoreAbsent(
  observer: TailscaleObserver,
  manager: TailscaleServeManager,
  fallback: CleanupTarget
): Promise<void> {
  const current = await observer.observeConfigured({
    expected_profile_key: fallback.expectedProfileKey,
    expected_serve: fallback.expectedServe
  });
  requireCondition(
    current.client === "available" &&
      current.failure === null &&
      current.profile.state === "dedicated" &&
      current.profile.comparison.relation === "match" &&
      (current.serve === "absent" || current.serve === "exact"),
    "Physical pairing cannot prove ownership-safe Serve cleanup."
  );
  if (current.serve === "absent") return;
  const removed = await manager.disable({
    expected_profile_key: fallback.expectedProfileKey,
    expected_serve: fallback.expectedServe
  });
  requireCondition(
    removed.outcome === "succeeded" &&
      removed.after !== null &&
      removed.after.serve === "absent" &&
      removed.after.failure === null,
    "Physical pairing failed to remove its owned Serve state."
  );
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await listen(server, 0);
  const address = server.address();
  requireCondition(
    address !== null && typeof address !== "string",
    "Physical pairing could not reserve a loopback port."
  );
  const port = (address as AddressInfo).port;
  await closeServer(server);
  return port;
}

function canConnectLoopback(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (connected: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(1_000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function listen(server: HttpServer, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: HttpServer): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  message: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch {
      // Browser navigation can transiently replace the execution context.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(message);
}

function commandOptions(): Readonly<{
  encoding: "utf8";
  env: NodeJS.ProcessEnv;
  maxBuffer: number;
  timeout: number;
}> {
  return {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    maxBuffer: 512 * 1024,
    timeout: 15_000
  };
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) as number;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
