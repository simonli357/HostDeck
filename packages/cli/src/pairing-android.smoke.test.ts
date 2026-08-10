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
  remoteIngressObservationSnapshotSchema,
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
import {
  type MobileInteractionId,
  mobileInteractionIds
} from "../../test-fixtures/src/mobile-design-contract.js";
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
const physicalServeCleanupObservationAttempts = 12;
const physicalServeCleanupObservationDelayMs = 5_000;
const physicalRemoteCheckResponseTimeoutMs = 45_000;
const physicalAndroidChromeAbsenceSettleMs = 30_000;
const physicalAndroidChromeStopTimeoutMs = 45_000;
const physicalAndroidChromeProcessPollMs = 200;
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
    "--user",
    "0",
    "com.android.chrome"
  ] as const)
] as const);
const physicalAndroidChromeCloseExternalTabCommand = Object.freeze([
  "shell",
  "input",
  "keyevent",
  "KEYCODE_BACK"
] as const);
const physicalMissionControlPath = "/" as const;
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
const physicalModelChoiceLabels = Object.freeze([
  "Codex Current",
  "Codex Fast"
] as const);
const physicalSessionControlDescriptions = Object.freeze([
  `/model for ${physicalUiSessionName}`,
  `/goal for ${physicalUiSessionName}`,
  `/plan for ${physicalUiSessionName}`,
  `More session utilities for ${physicalUiSessionName}`
]);
const physicalSessionActionsTriggerDescription = "Open session actions";
const physicalSessionActionsOverlayMarkers = Object.freeze([
  "Session actions",
  "Close session actions",
  "Back to session actions",
  "Host & access",
  "Close Host and access",
  "Open Resume on laptop",
  "Resume on laptop",
  "Laptop terminal only",
  "Open Interrupt active turn",
  "Interrupt active turn",
  "Interrupt result",
  "Interrupt active turn?",
  "Turn interrupted",
  "Turn ended as interrupted",
  "Interrupt blocked",
  "Outcome not confirmed",
  "Interrupt state inconsistent",
  "Secure interrupt setup unavailable",
  "Open Archive session",
  "Archive result",
  "Archive session",
  "Archive session?",
  "Session archived",
  "Archive blocked",
  "Archive not completed",
  "Archive outcome not confirmed",
  "Archive state inconsistent",
  "Secure archive setup unavailable"
] as const);
const physicalSessionActionsStableWindowMs = 2_000;
const physicalSessionActionsPollMs = 200;
const physicalPairingContinueStableWindowMs = 2_000;
const physicalTailscaleCommandTimeoutMs = 30_000;
const physicalPairingContinuePollMs = 200;
const physicalEventActionMaxDistancePx = 480;
const physicalEventDiagnosticStableWindowMs = 2_000;
const physicalEventDiagnosticPollMs = 200;
const physicalEventDiagnosticSwipeSettleMs = 350;
const physicalEventDiagnosticMaximumSwipes = 4;
const physicalEventDiagnosticObservationMaxBytes = 560;
const physicalHostAccessHeaderGapPx = 24;
const physicalSessionOverlayGapPx = 24;
const physicalApprovalLifetimeMs = 30 * 60 * 1_000;
const physicalScreenshotRedactionInsetPx = 8;
const physicalScreenshotRedactionRgba = Object.freeze([24, 28, 33, 255] as const);
const physicalScreenshotSelectionTimeoutMs = 10_000;
const physicalScreenshotSelectionStableReads = 2;
const physicalRuntimeIncompatibleTitle = "Codex interface incompatible";
const physicalRuntimeSupportedTitle = "Codex compatible";
const physicalGatedClaimAdmissionFailure =
  "Physical pairing claim lost current remote admission while evidence was captured.";
const physicalGatedClaimRefreshFailure =
  "Physical pairing claim could not refresh its remote admission runway.";
const physicalDashboardRemoteBrowserCheckCount = 4;
const physicalApprovalConfirmationTitle = "Approve elevated request?";
const physicalApprovalConfirmationReason =
  "Continue the bounded release validation on the selected device.";
const physicalApprovalConfirmationAction = "Approve once";
const physicalApprovalConfirmationStatus = "Approval confirmation open";
const physicalApprovalAction = "Install the Android validation package";
const physicalApprovalScope = "Connected test phone";
const physicalApprovalRisk = "Elevated risk";
const physicalApprovalRespondingStatus = "Confirming decision";
const physicalApprovalTerminalStatus = "Approved once";
const physicalApprovalTerminalDetail =
  "The selected request was approved once.";
const physicalApprovalCancelAction = "Cancel";
const physicalApprovalCloseAction = "Close approval confirmation";
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
const physicalAsyncAdbOperations = Object.freeze([
  "tailnet_ping",
  "private_https_probe",
  "ui_hierarchy"
] as const);
type PhysicalAsyncAdbOperation = (typeof physicalAsyncAdbOperations)[number];
const physicalAsyncAdbOperationLabels = Object.freeze({
  private_https_probe: "private HTTPS probe",
  tailnet_ping: "tailnet ping",
  ui_hierarchy: "UI hierarchy read"
} satisfies Readonly<Record<PhysicalAsyncAdbOperation, string>>);

interface PhysicalAsyncAdbCompletion {
  readonly operation: PhysicalAsyncAdbOperation;
  readonly status: number;
  readonly stdout: string;
}

interface PhysicalAsyncAdbErrorShape {
  readonly code?: number | string | null | undefined;
  readonly killed?: boolean | undefined;
  readonly signal?: NodeJS.Signals | null | undefined;
}

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

  it("binds physical evidence to one verified current package and browser identity", () => {
    const sourceHash = "a".repeat(64);
    const outputHash = "b".repeat(64);
    const contentHash = "c".repeat(64);
    const manifestHash = "d".repeat(64);
    const webHash = "e".repeat(64);
    const webManifestHash = "f".repeat(64);
    const packageManifest = {
      schemaVersion: 4,
      packageVersion: "0.0.0",
      source: { count: 620, sha256: sourceHash },
      output: { count: 1_247, sha256: outputHash },
      content: { bytes: 35_000_000, entryCount: 6_233, sha256: contentHash },
      manifestSha256: manifestHash,
      web: {
        bytes: 1_200_000,
        fileCount: 3,
        manifestSha256: webManifestHash,
        sha256: webHash
      }
    };
    const buildResult = parsePhysicalPackageBuildOutput(
      `HostDeck package built: 620 sources, 1247 owned outputs, 6233 entries, 3 web files (1200000 bytes, sha256:${webHash}), package sha256:${contentHash}.\n`
    );
    const verification = parsePhysicalPackageVerificationOutput(
      `HostDeck package verified: 6233 entries, 1247 owned outputs, 3 web files (1200000 bytes, sha256:${webHash}), package sha256:${contentHash}.\n`
    );
    const browserManifest = {
      package: {
        package_version: "0.0.0",
        content_sha256: contentHash,
        manifest_sha256: manifestHash,
        web_sha256: webHash,
        web_manifest_sha256: webManifestHash
      }
    };

    expect(
      parsePhysicalDashboardPackageIdentity({
        browserManifest,
        buildResult,
        packageManifest,
        verification
      })
    ).toEqual({
      content_entry_count: 6_233,
      content_tree_sha256: contentHash,
      manifest_sha256: manifestHash,
      output_file_count: 1_247,
      output_tree_sha256: outputHash,
      package_schema_version: 4,
      package_version: "0.0.0",
      source_file_count: 620,
      source_tree_sha256: sourceHash,
      web_manifest_sha256: webManifestHash,
      web_tree_sha256: webHash
    });

    expect(() =>
      parsePhysicalDashboardPackageIdentity({
        browserManifest: {
          package: { ...browserManifest.package, content_sha256: sourceHash }
        },
        buildResult,
        packageManifest,
        verification
      })
    ).toThrow("Physical dashboard package and browser identities did not match.");
    expect(() =>
      parsePhysicalDashboardPackageIdentity({
        browserManifest: {
          package: {
            package_version: "0.0.0",
            content_sha256: contentHash,
            manifest_sha256: manifestHash,
            web_sha256: webHash
          }
        },
        buildResult,
        packageManifest,
        verification
      })
    ).toThrow("Physical dashboard package and browser identities did not match.");
    expect(() =>
      parsePhysicalDashboardPackageIdentity({
        browserManifest,
        buildResult,
        packageManifest: {
          ...packageManifest,
          source: { ...packageManifest.source, count: 618 }
        },
        verification
      })
    ).toThrow("Physical dashboard package and browser identities did not match.");
    expect(() =>
      parsePhysicalDashboardPackageIdentity({
        browserManifest,
        buildResult: { ...buildResult, contentSha256: sourceHash },
        packageManifest,
        verification
      })
    ).toThrow("Physical dashboard package and browser identities did not match.");
    expect(() =>
      parsePhysicalDashboardPackageIdentity({
        browserManifest,
        buildResult,
        packageManifest,
        verification: { ...verification, entryCount: 6_230 }
      })
    ).toThrow("Physical dashboard package and browser identities did not match.");
    expect(() =>
      parsePhysicalPackageBuildOutput(
        `HostDeck package built: 620 sources, 1247 owned outputs, 6233 entries, 3 web files (1200000 bytes, sha256:${webHash}), package sha256:${contentHash}.\nextra\n`
      )
    ).toThrow("Physical dashboard package build output was invalid.");
    expect(() =>
      parsePhysicalPackageVerificationOutput(
        `HostDeck package verified: 6233 entries, 1247 outputs, 3 web files (1200000 bytes, sha256:${webHash}), package sha256:${contentHash}.\n`
      )
    ).toThrow("Physical dashboard package verification output was invalid.");
    expect(() =>
      parsePhysicalDashboardPackageIdentity({
        browserManifest,
        buildResult,
        packageManifest: {
          ...packageManifest,
          web: { ...packageManifest.web, manifestSha256: "invalid" }
        },
        verification
      })
    ).toThrow("Physical dashboard package and browser identities did not match.");
  });

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

  it("keeps the FE-V1-099 aggregate registry exact and executable", async () => {
    expect(Object.isFrozen(physicalAggregateReachableActionIds)).toBe(true);
    expect(Object.isFrozen(physicalAggregateCanonicalActionMap)).toBe(true);
    expect(physicalAggregateCanonicalActionMapIsExact()).toBe(true);
    expect(physicalAggregateActionRegistryIsExact()).toBe(true);
    expect(
      physicalAggregateCanonicalActionMap.read_event_details
    ).toHaveLength(6);
    expect(
      physicalAggregateCanonicalActionMap.read_compact
    ).toEqual(["compact-open", "compact-begin", "compact-check"]);
    expect(
      physicalAggregateCanonicalActionMap.switch_tailscale_profile_local
    ).toEqual(["profile-switch-away", "profile-switch-return"]);

    expect(
      physicalAggregateCanonicalActionMapIsExact({
        ...physicalAggregateCanonicalActionMap,
        read_model: []
      })
    ).toBe(false);
    expect(
      physicalAggregateCanonicalActionMapIsExact({
        ...physicalAggregateCanonicalActionMap,
        read_model: ["model-open", "model-open"]
      })
    ).toBe(false);
    expect(
      physicalAggregateCanonicalActionMapIsExact({
        ...physicalAggregateCanonicalActionMap,
        read_model: ["model-select"]
      })
    ).toBe(false);
    expect(
      physicalAggregateCanonicalActionMapIsExact(
        freezePhysicalAggregateCanonicalActionMap({
          ...physicalAggregateCanonicalActionMap,
          read_model: ["model-select"]
        })
      )
    ).toBe(false);
    expect(
      physicalAggregateCanonicalActionMapIsExact(
        freezePhysicalAggregateCanonicalActionMap({
          ...physicalAggregateCanonicalActionMap,
          navigate_back: ["host-detail-back"]
        })
      )
    ).toBe(false);

    const missing = physicalAggregateActionDefinitions.slice(0, -1);
    expect(physicalAggregateActionRegistryIsExact(missing)).toBe(false);
    expect(
      physicalAggregateActionRegistryIsExact([
        ...physicalAggregateActionDefinitions.slice(0, -1),
        physicalAggregateActionDefinitions[0] as PhysicalAggregateActionDefinition
      ])
    ).toBe(false);
    expect(
      physicalAggregateActionRegistryIsExact([
        physicalAggregateActionDefinitions[1] as PhysicalAggregateActionDefinition,
        physicalAggregateActionDefinitions[0] as PhysicalAggregateActionDefinition,
        ...physicalAggregateActionDefinitions.slice(2)
      ])
    ).toBe(false);
    expect(
      physicalAggregateActionRegistryIsExact(
        physicalAggregateActionDefinitions.map((entry, index) =>
          index === 0
            ? Object.freeze({ ...entry, actionId: "local-unlock" })
            : entry
        )
      )
    ).toBe(false);
    expect(
      physicalAggregateActionRegistryIsExact(
        physicalAggregateActionDefinitions.map((entry, index) =>
          index === 0
            ? Object.freeze({
                ...entry,
                selectorWaiter:
                  entry.transitionExecutor as unknown as PhysicalAggregateSelectorWaiter
              })
            : entry
        )
      )
    ).toBe(false);
    expect(
      physicalAggregateActionRegistryIsExact(
        physicalAggregateActionDefinitions.map((entry, index) =>
          index === 0
            ? Object.freeze({
                ...entry,
                counterOracle:
                  entry.diagnosticOwner as unknown as PhysicalAggregateCounterOracle
              })
            : entry
        )
      )
    ).toBe(false);
    expect(
      physicalAggregateActionRegistryIsExact(
        physicalAggregateActionDefinitions.map((entry, index) =>
          index === 0
            ? Object.freeze({
                ...entry,
                diagnosticOwner:
                  entry.counterOracle as unknown as PhysicalAggregateDiagnosticOwner
              })
            : entry
        )
      )
    ).toBe(false);
    expect(
      physicalAggregateActionRegistryIsExact(
        physicalAggregateActionDefinitions.map((entry, index) =>
          index === 0
            ? Object.freeze({
                ...entry,
                diagnosticOwner:
                  entry.transitionExecutor as unknown as PhysicalAggregateDiagnosticOwner
              })
            : entry
        )
      )
    ).toBe(false);
    expect(
      physicalAggregateActionRegistryIsExact(
        physicalAggregateActionDefinitions.map((entry, index) =>
          index === 0
            ? Object.freeze({ ...entry, transitionExecutor: () => true })
            : entry
        )
      )
    ).toBe(false);
    expect(
      physicalAggregateActionRegistryIsExact(
        physicalAggregateActionDefinitions.map((entry, index) =>
          index === 0 ? Object.freeze({ ...entry, maximumTaps: 0 }) : entry
        )
      )
    ).toBe(false);
    expect(
      physicalAggregateActionRegistryIsExact(
        physicalAggregateActionDefinitions.map((entry, index) =>
          index === 0 ? Object.freeze({ ...entry, driver: "talkback" as const }) : entry
        )
      )
    ).toBe(false);

    const syntheticNode = parseAndroidUiNodes(
      '<hierarchy><node text="Synthetic action" class="android.widget.Button" ' +
        'content-desc="Synthetic action" clickable="true" enabled="true" ' +
        'bounds="[40,400][280,520]" /></hierarchy>'
    )[0];
    requireCondition(syntheticNode !== undefined, "Synthetic registry node was absent.");
    const definition = physicalAggregateActionDefinitions.find(
      (entry) => entry.actionId === "model-open"
    );
    requireCondition(definition !== undefined, "Synthetic registry definition was absent.");
    const ownerContext: PhysicalAggregateOwnerContext = Object.freeze({
      actionId: "model-open",
      counterSnapshot: Object.freeze({ synthetic: 0 }),
      currentNodes: Object.freeze([syntheticNode]),
      node: syntheticNode,
      routeOwner: "Model sheet"
    });
    expect(await definition.selectorWaiter(ownerContext)).toBe(syntheticNode);
    expect(await definition.counterOracle(ownerContext)).toEqual({ synthetic: 0 });
    const diagnostic = await definition.diagnosticOwner(ownerContext);
    expect(diagnostic).toContain("action=model-open");
    const transitionContext: PhysicalAggregateTransitionContext = Object.freeze({
      ...ownerContext,
      completed: () => false,
      counterBefore: ownerContext.counterSnapshot,
      diagnostic,
      selectorResult: syntheticNode
    });
    expect(await definition.transitionExecutor(transitionContext)).toBe(false);
    expect(() =>
      definition.transitionExecutor(
        Object.freeze({ ...transitionContext, completed: () => true })
      )
    ).toThrow("unguarded completion callback");

    let syntheticTapCount = 0;
    const executableRegistry = createPhysicalAggregateActionRegistry({
      counterSnapshot: () => Object.freeze({ synthetic: 0 }),
      tapNodeOnceAndWait: async (node, completed) => {
        expect(node).toBe(syntheticNode);
        syntheticTapCount += 1;
        expect(await completed()).toBe(true);
      }
    });
    await executableRegistry.tap(
      "model-open",
      syntheticNode,
      () => syntheticNode.clickable && syntheticNode.enabled !== false,
      "synthetic model action"
    );
    executableRegistry.assertConsumed(["model-open"]);
    expect(syntheticTapCount).toBe(1);

    let guardedTapCount = 0;
    let preTapGuardCount = 0;
    const guardedRegistry = createPhysicalAggregateActionRegistry({
      counterSnapshot: () => Object.freeze({ synthetic: 0 }),
      tapNodeOnceAndWait: async (_node, completed) => {
        guardedTapCount += 1;
        expect(await completed()).toBe(true);
      }
    });
    await guardedRegistry.tap(
      "event-open-boundary",
      syntheticNode,
      () => syntheticNode.clickable && syntheticNode.enabled !== false,
      "synthetic guarded event action",
      Object.freeze({
        beforeTap: () => {
          preTapGuardCount += 1;
        },
        timeoutMs: 1_000
      })
    );
    guardedRegistry.assertConsumed(["event-open-boundary"]);
    expect(preTapGuardCount).toBe(1);
    expect(guardedTapCount).toBe(1);

    let rejectedTapCount = 0;
    const rejectedGuardRegistry = createPhysicalAggregateActionRegistry({
      counterSnapshot: () => Object.freeze({ synthetic: 0 }),
      tapNodeOnceAndWait: async () => {
        rejectedTapCount += 1;
      }
    });
    await expect(
      rejectedGuardRegistry.tap(
        "event-open-boundary",
        syntheticNode,
        () => syntheticNode.clickable && syntheticNode.enabled !== false,
        "synthetic rejected event action",
        Object.freeze({
          beforeTap: () => {
            throw new Error("synthetic authority drift");
          }
        })
      )
    ).rejects.toThrow("synthetic authority drift");
    expect(rejectedTapCount).toBe(0);

    let syntheticTalkBackActivationCount = 0;
    const talkBackRegistry = createPhysicalAggregateActionRegistry({
      counterSnapshot: () => Object.freeze({ synthetic: 0 })
    });
    await talkBackRegistry.activate(
      "talkback-model-open",
      syntheticNode,
      () => {
        syntheticTalkBackActivationCount += 1;
      },
      () =>
        syntheticTalkBackActivationCount === 1 &&
        syntheticNode.clickable &&
        syntheticNode.enabled !== false,
      "synthetic TalkBack model action"
    );
    talkBackRegistry.assertConsumed(["talkback-model-open"]);
    expect(syntheticTalkBackActivationCount).toBe(1);
    await expect(
      talkBackRegistry.activate(
        "talkback-model-open",
        syntheticNode,
        () => {
          syntheticTalkBackActivationCount += 1;
        },
        () => syntheticTalkBackActivationCount > 1,
        "synthetic duplicate TalkBack model action"
      )
    ).rejects.toThrow("exceeded its one-tap boundary");
    expect(syntheticTalkBackActivationCount).toBe(1);
    await expect(
      createPhysicalAggregateActionRegistry().tap(
        "talkback-model-open",
        syntheticNode,
        () => syntheticNode.clickable,
        "synthetic TalkBack tap bypass"
      )
    ).rejects.toThrow("was not a registered tap");
    let wrongDriverActivationCount = 0;
    await expect(
      createPhysicalAggregateActionRegistry().activate(
        "model-open",
        syntheticNode,
        () => {
          wrongDriverActivationCount += 1;
        },
        () => wrongDriverActivationCount === 1,
        "synthetic Android-node activation bypass"
      )
    ).rejects.toThrow("was not a registered TalkBack activation");
    expect(wrongDriverActivationCount).toBe(0);

    const allActionsRegistry = createPhysicalAggregateActionRegistry({
      counterSnapshot: () => Object.freeze({ synthetic: 0 }),
      tapNodeOnceAndWait: async (_node, completed) => {
        expect(await completed()).toBe(true);
      }
    });
    for (const action of physicalAggregateActionDefinitions) {
      if (action.driver === "observation") {
        allActionsRegistry.consume(
          action.actionId,
          () => action.driver === "observation",
          `synthetic ${action.actionId} observation`
        );
      } else if (action.driver === "talkback") {
        let activated = false;
        await allActionsRegistry.activate(
          action.actionId,
          syntheticNode,
          () => {
            activated = true;
          },
          () => activated && syntheticNode.clickable,
          `synthetic ${action.actionId} TalkBack activation`
        );
      } else {
        await allActionsRegistry.tap(
          action.actionId,
          syntheticNode,
          () => syntheticNode.clickable && syntheticNode.enabled !== false,
          `synthetic ${action.actionId}`
        );
      }
    }
    allActionsRegistry.assertConsumed(physicalAggregateReachableActionIds);

    const registry = createPhysicalAggregateActionRegistry();
    let recoveryObservationCalls = 0;
    registry.consume(
      "stream-recovery-observe",
      () => {
        recoveryObservationCalls += 1;
        return physicalAggregateReachableActionIds.length > 0;
      },
      "synthetic recovery observation"
    );
    expect(() => registry.consume(
      "stream-recovery-observe",
      () => {
        recoveryObservationCalls += 1;
        return physicalAggregateReachableActionIds.length > 0;
      },
      "synthetic duplicate recovery observation"
    )).toThrow(
      "exceeded its one-tap boundary"
    );
    expect(recoveryObservationCalls).toBe(1);
    await expect(
      registry.tap(
        "stream-reconnect-observe",
        {} as AndroidUiNode,
        () => false,
        "synthetic stream observation"
      )
    ).rejects.toThrow("was not a registered tap");
    expect(() => registry.assertConsumed(["stream-recovery-observe"])).not.toThrow();
    const incompleteRegistry = createPhysicalAggregateActionRegistry();
    incompleteRegistry.consume(
      "stream-recovery-observe",
      () => physicalAggregateReachableActionIds.length > 0,
      "synthetic incomplete recovery observation"
    );
    expect(() =>
      incompleteRegistry.assertConsumed([
        "stream-recovery-observe",
        "stream-reconnect-observe"
      ])
    ).toThrow("consumption was invalid");
    const reorderedRegistry = createPhysicalAggregateActionRegistry();
    reorderedRegistry.consume(
      "stream-reconnect-observe",
      () => physicalAggregateReachableActionIds.length > 0,
      "synthetic reordered reconnect observation"
    );
    reorderedRegistry.consume(
      "stream-recovery-observe",
      () => physicalAggregateReachableActionIds.length > 0,
      "synthetic reordered recovery observation"
    );
    expect(() =>
      reorderedRegistry.assertConsumed([
        "stream-recovery-observe",
        "stream-reconnect-observe"
      ])
    ).toThrow("execution order was invalid");
    expect(() =>
      createPhysicalAggregateActionRegistry().consume(
        "stream-recovery-observe",
        () => true,
        "synthetic unguarded observation"
      )
    ).toThrow("unguarded completion callback");
    expect(() =>
      createPhysicalAggregateActionRegistry({
        counterSnapshot: () => Object.freeze({ invalid: -1 })
      }).consume(
        "stream-recovery-observe",
        () => physicalAggregateReachableActionIds.length > 0,
        "synthetic invalid observation counter"
      )
    ).toThrow("observed an invalid counter snapshot");
  });

  it("enforces exact standalone and dashboard prompt registry scopes", async () => {
    const syntheticNode = parseAndroidUiNodes(
      '<hierarchy><node text="Synthetic prompt action" class="android.widget.Button" ' +
        'content-desc="Synthetic prompt action" clickable="true" enabled="true" ' +
        'bounds="[40,400][280,520]" /></hierarchy>'
    )[0];
    requireCondition(
      syntheticNode !== undefined,
      "Synthetic prompt registry node was absent."
    );

    const executeActions = async (
      actionIds: readonly PhysicalAggregateActionId[]
    ): Promise<PhysicalAggregateActionRegistry> => {
      let syntheticTransitionCount = 0;
      const registry = createPhysicalAggregateActionRegistry({
        counterSnapshot: () => Object.freeze({ synthetic: 0 }),
        tapNodeOnceAndWait: async (_node, completed) => {
          syntheticTransitionCount += 1;
          expect(await completed()).toBe(true);
        }
      });
      for (const actionId of actionIds) {
        const definition = physicalAggregateActionDefinitions.find(
          (entry) => entry.actionId === actionId
        );
        requireCondition(
          definition !== undefined,
          "Synthetic prompt registry definition was absent."
        );
        if (definition.driver === "observation") {
          const observed = definition.driver === "observation";
          registry.consume(
            actionId,
            () => observed,
            `synthetic ${actionId} observation`
          );
        } else if (definition.driver === "talkback") {
          let activated = false;
          await registry.activate(
            actionId,
            syntheticNode,
            () => {
              activated = true;
            },
            () => activated,
            `synthetic ${actionId} TalkBack activation`
          );
        } else {
          const expectedTransitionCount = syntheticTransitionCount + 1;
          await registry.tap(
            actionId,
            syntheticNode,
            () => syntheticTransitionCount === expectedTransitionCount,
            `synthetic ${actionId}`
          );
        }
      }
      return registry;
    };

    expect(
      physicalAggregatePromptExpectedActionIdsFor({
        actionRegistryScope: "standalone",
        cleanup: true,
        openMissionControl: true
      })
    ).toBe(physicalAggregatePromptExpectedActionIds);
    expect(
      physicalAggregatePromptExpectedActionIdsFor({
        actionRegistryScope: "dashboard",
        captureScreenshots: false,
        cleanup: false,
        openMissionControl: false,
        sessionAlreadyOpen: true
      })
    ).toBe(physicalAggregateDashboardPromptExpectedActionIds);
    const invalidDashboardOptions = Object.freeze([
      {
        actionRegistryScope: "dashboard",
        captureScreenshots: true,
        cleanup: false,
        openMissionControl: false,
        sessionAlreadyOpen: true
      },
      {
        actionRegistryScope: "dashboard",
        captureScreenshots: false,
        cleanup: true,
        openMissionControl: false,
        sessionAlreadyOpen: true
      },
      {
        actionRegistryScope: "dashboard",
        captureScreenshots: false,
        cleanup: false,
        openMissionControl: true,
        sessionAlreadyOpen: true
      },
      {
        actionRegistryScope: "dashboard",
        captureScreenshots: false,
        cleanup: false,
        openMissionControl: false,
        sessionAlreadyOpen: false
      }
    ]);
    for (const invalidOptions of invalidDashboardOptions) {
      expect(() =>
        physicalAggregatePromptExpectedActionIdsFor(
          invalidOptions as unknown as ProductionPromptUiSequenceOptions
        )
      ).toThrow("dashboard registry scope used an invalid embedding shape");
    }
    expect(() =>
      physicalAggregatePromptExpectedActionIdsFor({
        actionRegistryScope: "standalone",
        cleanup: false,
        openMissionControl: false,
        sessionAlreadyOpen: true
      } as unknown as ProductionPromptUiSequenceOptions)
    ).toThrow("standalone registry scope cannot inherit an open session");

    const standaloneRegistry = await executeActions(
      physicalAggregatePromptExpectedActionIds
    );
    expect(() =>
      standaloneRegistry.assertConsumed(physicalAggregatePromptExpectedActionIds)
    ).not.toThrow();
    expect(() =>
      standaloneRegistry.assertConsumed(
        physicalAggregateDashboardPromptExpectedActionIds
      )
    ).toThrow("consumption was invalid");

    const dashboardRegistry = await executeActions(
      physicalAggregateDashboardPromptExpectedActionIds
    );
    expect(() =>
      dashboardRegistry.assertConsumed(
        physicalAggregateDashboardPromptExpectedActionIds
      )
    ).not.toThrow();
    expect(() =>
      dashboardRegistry.assertConsumed(physicalAggregatePromptExpectedActionIds)
    ).toThrow("consumption was invalid");

    const missingRegistry = await executeActions(
      physicalAggregateDashboardPromptExpectedActionIds.slice(0, -1)
    );
    expect(() =>
      missingRegistry.assertConsumed(
        physicalAggregateDashboardPromptExpectedActionIds
      )
    ).toThrow("consumption was invalid");

    const extraRegistry = await executeActions([
      ...physicalAggregateDashboardPromptExpectedActionIds,
      "stream-recovery-observe"
    ]);
    expect(() =>
      extraRegistry.assertConsumed(physicalAggregateDashboardPromptExpectedActionIds)
    ).toThrow("consumption was invalid");

    const duplicateRegistry = await executeActions(
      physicalAggregateDashboardPromptExpectedActionIds
    );
    await expect(
      duplicateRegistry.tap(
        "prompt-send",
        syntheticNode,
        () => true,
        "synthetic duplicate prompt send"
      )
    ).rejects.toThrow("exceeded its one-tap boundary");

    const reorderedActionIds: PhysicalAggregateActionId[] = [
      ...physicalAggregateDashboardPromptExpectedActionIds
    ];
    const promptEditorIndex = reorderedActionIds.indexOf("prompt-editor");
    const promptSendIndex = reorderedActionIds.indexOf("prompt-send");
    requireCondition(
      promptEditorIndex >= 0 && promptSendIndex >= 0,
      "Synthetic prompt actions were absent from the dashboard prefix."
    );
    [reorderedActionIds[promptEditorIndex], reorderedActionIds[promptSendIndex]] = [
      reorderedActionIds[promptSendIndex] as PhysicalAggregateActionId,
      reorderedActionIds[promptEditorIndex] as PhysicalAggregateActionId
    ];
    const reorderedRegistry = await executeActions(reorderedActionIds);
    expect(() =>
      reorderedRegistry.assertConsumed(
        physicalAggregateDashboardPromptExpectedActionIds
      )
    ).toThrow("execution order was invalid");
  });

  it("propagates selector and invariant failures through the physical poller", async () => {
    await expect(
      waitFor(
        () => {
          throw new Error("selector invariant");
        },
        1_000,
        "poller swallowed the selector invariant"
      )
    ).rejects.toThrow("selector invariant");
  });

  it("keeps every aggregate physical action registry-bound", () => {
    const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const implementation = physicalAggregateImplementationSource(source);
    requireCondition(
      implementation !== null,
      "Physical aggregate implementation source was absent."
    );
    const callSiteIds = new Set<string>();
    for (const match of implementation.matchAll(
      /(?:input\.)?actionRegistry\.tap\(\s*"([^"]+)"/gu
    )) {
      const actionId = match[1];
      if (actionId !== undefined) callSiteIds.add(actionId);
    }
    for (const match of implementation.matchAll(
      /(?:input\.)?actionRegistry\.activate\(\s*"([^"]+)"/gu
    )) {
      const actionId = match[1];
      if (actionId !== undefined) callSiteIds.add(actionId);
    }
    for (const match of implementation.matchAll(
      /tapPhysicalSessionActionsOnceAndWait\(\s*input\.actionRegistry,\s*"([^"]+)"/gu
    )) {
      const actionId = match[1];
      if (actionId !== undefined) callSiteIds.add(actionId);
    }
    for (const match of implementation.matchAll(
      /(?:input\.actionRegistry,\s*|actionRegistry,\s*)"([^"]+)"/gu
    )) {
      const actionId = match[1];
      if (actionId !== undefined) callSiteIds.add(actionId);
    }
    for (const match of implementation.matchAll(
      /(?:input\.)?actionRegistry\.consume\(\s*"([^"]+)"/gu
    )) {
      const actionId = match[1];
      if (actionId !== undefined) callSiteIds.add(actionId);
    }
    for (const match of implementation.matchAll(
      /runPhysicalEventDiagnostic\(\s*input,\s*capture,\s*"(event-open-[^"]+)"/gu
    )) {
      const actionId = match[1];
      if (actionId !== undefined) {
        callSiteIds.add(actionId);
        callSiteIds.add(actionId.replace("event-open-", "event-close-"));
      }
    }
    for (const match of implementation.matchAll(
      /returnPhysicalExternalPageToSelectedSession\([\s\S]{0,1200}?"(external-selected-[^"]+)"/gu
    )) {
      const actionId = match[1];
      if (actionId !== undefined) callSiteIds.add(actionId);
    }
    if (implementation.includes('context === "not-found" ? "detail-expand-quiet"')) {
      callSiteIds.add("detail-expand-quiet");
      callSiteIds.add("archive-expand-quiet");
    }
    expect(implementation.match(/tapAndroidNodeOnceAndWait\(/gu)).toHaveLength(1);
    expect(physicalAggregateCallGraphIsExact(source)).toBe(true);
    const aggregateStart = source.indexOf(
      "async function runProductionPairingUiSequence" + "(\n"
    );
    expect(aggregateStart).toBeGreaterThanOrEqual(0);
    const aggregateMarker =
      "async function runProductionPairingUiSequence" + "(\n";
    expect(
      physicalAggregateCallGraphIsExact(
        source.replace(
          aggregateMarker,
          `${aggregateMarker}  tapAndroidUiNode(hostileNode);\n`
        )
      )
    ).toBe(false);
    const selfRevokeMarker =
      "async function runPhysicalSelfRevoke" + "(\n";
    expect(
      physicalAggregateCallGraphIsExact(
        source.replace(
          selfRevokeMarker,
          `${selfRevokeMarker}  tapAndroidUiNode(hostileNode);\n`
        )
      )
    ).toBe(false);
    expect(
      physicalAggregateCallGraphIsExact(
        source.replace(
          selfRevokeMarker,
          `${selfRevokeMarker}  adb(["shell", "input", "tap", "1", "1"]);\n`
        )
      )
    ).toBe(false);
    const talkBackMarker =
      "async function runPhysicalTalkBackTraversal" + "(\n";
    expect(
      physicalAggregateCallGraphIsExact(
        source.replace(
          talkBackMarker,
          `${talkBackMarker}  runPhysicalTalkBackDoubleTap(1, 1);\n`
        )
      )
    ).toBe(false);
    expect(
      physicalAggregateCallGraphIsExact(
        source.replace(
          selfRevokeMarker,
          `${selfRevokeMarker}  if (input.requestInspection.accessRequests >= 1) return;\n`
        )
      )
    ).toBe(false);
    expect(
      physicalAggregateCallGraphIsExact(
        source.replace(
          "async () => selectPhysicalHostAccessCloseAction(await readAndroidUiNodes(), \"global\") !== null",
          "() => true"
        )
      )
    ).toBe(false);
    expect(
      physicalAggregateCallGraphIsExact(
        source.replace(
          "async () => selectPhysicalHostAccessCloseAction(await readAndroidUiNodes(), \"global\") !== null",
          "() => Boolean(1)"
        )
      )
    ).toBe(false);
    expect(implementation).toContain(
      "`event-close-" + "$" + '{actionId.replace("event-open-", "")}`'
    );
    expect(
      physicalAggregateReachableActionIds.filter(
        (actionId) =>
          !callSiteIds.has(actionId) &&
          !actionId.startsWith("event-close-")
      )
    ).toEqual([]);
  });

  it("snapshots both profile transitions before changing external state", () => {
    const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const slices = [
      source.slice(
        source.lastIndexOf("async function runPhysicalDashboardProfileSwitch"),
        source.lastIndexOf("async function runPhysicalRuntimeCompatibilityState")
      ),
      source.slice(
        source.lastIndexOf("async function runProductionRemoteRecoveryUiSequence"),
        source.lastIndexOf("function recoveryRequestSummary")
      )
    ];
    for (const body of slices) {
      const awaySnapshot = body.indexOf("const profileAwaySwitchBefore");
      const awaySwitch = body.indexOf('"profile-switch-away"');
      const awayExternal = body.indexOf(
        "await switchSavedProfile(input.profileSwitch.awayProfileId)"
      );
      const awayRefreshSnapshot = body.indexOf("const profileAwayBefore");
      const returnSnapshot = body.indexOf("const profileReturnBefore");
      const returnSwitch = body.indexOf('"profile-switch-return"');
      const returnExternal = body.indexOf(
        "await switchSavedProfile(input.profileSwitch.dedicatedProfileId)"
      );
      expect(awaySnapshot).toBeGreaterThanOrEqual(0);
      expect(awaySnapshot).toBeLessThan(awayExternal);
      expect(awayExternal).toBeLessThan(awayRefreshSnapshot);
      expect(awayRefreshSnapshot).toBeLessThan(awaySwitch);
      expect(awayRefreshSnapshot).toBeLessThan(returnSnapshot);
      expect(returnSnapshot).toBeGreaterThan(awaySwitch);
      expect(returnSnapshot).toBeLessThan(returnExternal);
      expect(returnExternal).toBeLessThan(returnSwitch);
    }
  });

  it("removes legacy retry and largest-match driver helpers", () => {
    const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const legacyTokens = [
      ["waitFor", "AndroidUiNodePresent"].join(""),
      ["performVerified", "AndroidTap"].join(""),
      ["revealAndroidUiNode", "("].join("")
    ];
    expect(legacyTokens.every((token) => !source.includes(token))).toBe(true);
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
    requireCondition(trigger !== undefined, "Quiet disclosure fixture was absent.");
    expect(physicalQuietQueueDisclosureState([trigger])).toBe("collapsed");
    const expanded = Object.freeze({
      ...trigger,
      description: physicalQuietQueueDisclosureLabel(true)
    });
    expect(physicalQuietQueueDisclosureState([expanded])).toBe("expanded");
    expect(() =>
      physicalQuietQueueDisclosureState([trigger, expanded])
    ).toThrow("disclosure state was invalid");
    expect(() => physicalQuietQueueDisclosureState([])).toThrow(
      "disclosure state was invalid"
    );
  });

  it("binds dashboard actions to one structural owner and one page target", () => {
    const missionNodes = parseAndroidUiNodes(
      '<hierarchy><node text="" class="android.view.ViewGroup" ' +
        `resource-id="${chromeToolbarResourceId}" bounds="[0,80][1080,240]" />` +
        '<node text="" class="android.widget.FrameLayout" ' +
        `resource-id="${chromeCompositorResourceId}" bounds="[0,80][1080,2400]" />` +
        '<node text="Mission Control" class="android.view.View" ' +
        'bounds="[24,280][460,360]" />' +
        '<node text="" class="android.widget.Button" ' +
        'content-desc="Open Host and access" clickable="true" enabled="true" ' +
        'bounds="[24,480][520,620]" />' +
        `<node text="" class="android.widget.Button" content-desc="${physicalUiSessionName}" ` +
        'clickable="true" enabled="true" bounds="[24,700][900,880]" />' +
        '<node text="" class="android.widget.Button" content-desc="Refresh sessions" ' +
        'clickable="true" enabled="true" bounds="[820,280][1040,400]" />' +
        '<node text="" class="android.widget.Button" content-desc="Expand quiet sessions (1)" ' +
        'clickable="true" enabled="true" bounds="[540,280][800,400]" />' +
        '</hierarchy>'
    );
    const session = missionNodes.find(
      (node) => node.description === physicalUiSessionName
    );
    requireCondition(session !== undefined, "Mission selector fixture was incomplete.");
    expect(selectPhysicalMissionControlAction(missionNodes, "Open Host and access")).not.toBeNull();
    expect(selectPhysicalMissionControlSession(missionNodes)).toBe(session);
    expect(selectPhysicalMissionControlRefresh(missionNodes)).not.toBeNull();
    expect(selectPhysicalMissionControlDestination(missionNodes)).not.toBeNull();
    for (const selector of [
      (node: AndroidUiNode) => node.description === "Open Host and access",
      (node: AndroidUiNode) => node.description === "Refresh sessions",
      (node: AndroidUiNode) => node.description === "Expand quiet sessions (1)"
    ]) {
      expect(
        selectPhysicalMissionControlDestination(
          missionNodes.filter((node) => !selector(node))
        )
      ).toBeNull();
    }
    const duplicateRefresh = missionNodes.find(
      (node) => node.description === "Refresh sessions"
    );
    requireCondition(duplicateRefresh !== undefined, "Refresh fixture was incomplete.");
    expect(
      selectPhysicalMissionControlDestination([
        ...missionNodes,
        Object.freeze({ ...duplicateRefresh })
      ])
    ).toBeNull();
    const timelineCopy = Object.freeze({
      bounds: Object.freeze({ bottom: 1_040, left: 24, right: 820, top: 960 }),
      className: "android.view.View",
      clickable: false,
      description: "",
      resourceId: "",
      text: "Turn interrupted"
    });
    expect(
      selectPhysicalMissionControlDestination([...missionNodes, timelineCopy])
    ).not.toBeNull();
    const structuralOverlay = Object.freeze({
      bounds: Object.freeze({ bottom: 1_200, left: 24, right: 900, top: 1_080 }),
      className: "android.view.View",
      clickable: false,
      description: "",
      resourceId: "",
      text: "Session actions"
    });
    expect(
      selectPhysicalMissionControlDestination([
        ...missionNodes,
        structuralOverlay
      ])
    ).toBeNull();
    expect(
      selectPhysicalMissionControlAction(
        [...missionNodes, structuralOverlay],
        "Open Host and access"
      )
    ).toBeNull();
    const terminalOverlay = Object.freeze({
      bounds: Object.freeze({ bottom: 1_200, left: 24, right: 900, top: 1_080 }),
      className: "android.view.View",
      clickable: false,
      description: "",
      resourceId: "",
      text: "Turn interrupted"
    });
    const terminalDone = Object.freeze({
      bounds: Object.freeze({ bottom: 1_400, left: 700, right: 1_040, top: 1_280 }),
      className: "android.widget.Button",
      clickable: true,
      description: "",
      resourceId: "",
      text: "Done"
    });
    expect(
      selectPhysicalMissionControlDestination([
        ...missionNodes,
        terminalOverlay,
        terminalDone
      ])
    ).toBeNull();
    for (const description of [
      "Back to Mission Control",
      "Close session actions",
      "Back to session actions",
      "Back to session utilities",
      "Back to sessions",
      "Done"
    ]) {
      expect(
        selectPhysicalMissionControlDestination([
          ...missionNodes,
          Object.freeze({
            ...terminalDone,
            description,
            text: ""
          })
        ])
      ).toBeNull();
    }
    expect(
      selectPhysicalMissionControlSession([
        ...missionNodes,
        Object.freeze({ ...session })
      ])
    ).toBeNull();
    expect(
      selectPhysicalMissionControlAction(
        missionNodes.map((node) =>
          node === session
            ? Object.freeze({
                ...node,
                bounds: Object.freeze({ left: 24, top: 2_300, right: 900, bottom: 2_480 })
              })
            : node
        ),
        physicalUiSessionName
      )
    ).toBeNull();

    const sessionNodes = physicalSessionActionsFixtureNodes();
    const dockDescription = physicalSessionControlDescriptions[0];
    requireCondition(dockDescription !== undefined, "Session dock fixture was incomplete.");
    const dockAction = selectPhysicalSessionDockAction(
      sessionNodes,
      1,
      dockDescription
    );
    expect(dockAction).not.toBeNull();
    const timelineModelCopy = Object.freeze({
      bounds: Object.freeze({ bottom: 980, left: 80, right: 600, top: 900 }),
      className: "android.view.View",
      clickable: false,
      description: "",
      resourceId: "",
      text: "/model"
    });
    expect(
      selectPhysicalSessionActionsTrigger(
        [...sessionNodes, timelineModelCopy],
        1
      )
    ).not.toBeNull();
    const modelOverlayClose = Object.freeze({
      bounds: Object.freeze({ bottom: 1_000, left: 900, right: 1_040, top: 880 }),
      className: "android.widget.Button",
      clickable: true,
      description: "Close model control",
      resourceId: "",
      text: ""
    });
    expect(
      selectPhysicalSessionActionsTrigger(
        [...sessionNodes, timelineModelCopy, modelOverlayClose],
        1
      )
    ).toBeNull();
    const interruptConfirmationNodes = [
      Object.freeze({
        ...timelineModelCopy,
        text: "Interrupt active turn?"
      }),
      Object.freeze({
        ...modelOverlayClose,
        bounds: Object.freeze({
          bottom: 1_400,
          left: 80,
          right: 500,
          top: 1_280
        }),
        description: "",
        text: "Cancel"
      }),
      Object.freeze({
        ...modelOverlayClose,
        bounds: Object.freeze({
          bottom: 1_400,
          left: 540,
          right: 1_000,
          top: 1_280
        }),
        description: "",
        text: "Interrupt turn"
      })
    ];
    expect(
      selectPhysicalSessionActionsTrigger(
        [...sessionNodes, ...interruptConfirmationNodes],
        1
      )
    ).toBeNull();
    const sessionMenuNodes: readonly AndroidUiNode[] = [
      ...sessionNodes,
      Object.freeze({
        bounds: Object.freeze({ bottom: 620, left: 260, right: 820, top: 500 }),
        className: "android.view.View",
        clickable: false,
        description: "",
        resourceId: "",
        text: "Session actions"
      }),
      Object.freeze({
        bounds: Object.freeze({ bottom: 620, left: 900, right: 1040, top: 500 }),
        className: "android.widget.Button",
        clickable: true,
        description: "Close session actions",
        resourceId: "",
        text: ""
      }),
      Object.freeze({
        bounds: Object.freeze({ bottom: 820, left: 260, right: 820, top: 680 }),
        className: "android.widget.Button",
        clickable: true,
        description: "Open Resume on laptop",
        resourceId: "",
        text: ""
      })
    ];
    expect(selectPhysicalSessionActionsMenuRoot(sessionMenuNodes)).not.toBeNull();
    expect(
      selectPhysicalSessionActionsMenuAction(
        sessionMenuNodes,
        "Open Resume on laptop"
      )
    ).not.toBeNull();
    expect(
      selectPhysicalSessionActionsMenuAction(
        [...sessionMenuNodes, Object.freeze({ ...sessionMenuNodes.at(-1) }) as AndroidUiNode],
        "Open Resume on laptop"
      )
    ).toBeNull();
    expect(
      selectPhysicalSessionActionsMenuAction(
        [
          ...sessionMenuNodes,
          Object.freeze({
            ...sessionMenuNodes[2],
            text: "/model"
          }) as AndroidUiNode,
          Object.freeze({
            ...sessionMenuNodes[3],
            description: "Close model control"
          }) as AndroidUiNode
        ],
        "Open Resume on laptop"
      )
    ).toBeNull();

    const sheetNodes = parseAndroidUiNodes(
      '<hierarchy><node text="" class="android.view.ViewGroup" ' +
        `resource-id="${chromeToolbarResourceId}" bounds="[0,80][1080,240]" />` +
        '<node text="" class="android.widget.FrameLayout" ' +
        `resource-id="${chromeCompositorResourceId}" bounds="[0,80][1080,2400]" />` +
      '<node text="/model" class="android.view.View" bounds="[80,400][600,500]" />' +
        '<node text="Codex Current" class="android.widget.Button" clickable="true" checked="true" ' +
        'enabled="true" bounds="[80,620][600,760]" />' +
        '<node text="Codex Fast" class="android.widget.Button" clickable="true" ' +
        'enabled="true" bounds="[80,800][600,940]" />' +
        '<node text="Codex Balanced" class="android.widget.Button" clickable="true" ' +
        'enabled="true" bounds="[80,980][600,1120]" />' +
        '<node text="Thorough" class="android.widget.RadioButton" clickable="true" checked="true" ' +
        'enabled="true" bounds="[80,1160][300,1260]" />' +
        '<node text="" class="android.widget.Button" content-desc="Close model control" ' +
        'clickable="true" enabled="true" bounds="[900,400][1040,520]" />' +
        '</hierarchy>'
    );
    expect(
      selectPhysicalSheetAction(
        sheetNodes,
        "text",
        "Codex Fast",
        "/model"
      )
    ).not.toBeNull();
    expect(selectPhysicalDialogCloseAction(sheetNodes, "Close model control")).not.toBeNull();
    expect(physicalSheetChoiceSelected(sheetNodes, "/model", "Codex Current")).toBe(true);
    expect(physicalSheetChoiceSelected(sheetNodes, "/model", "Codex Fast")).toBe(false);
    const describedSheetNodes = sheetNodes.map((node) =>
      [...physicalModelChoiceLabels, "Codex Balanced", "Thorough"].includes(
        node.text
      )
        ? (Object.freeze({
            ...node,
            description: node.text,
            text: ""
          }) as AndroidUiNode)
        : node
    );
    expect(
      selectPhysicalSheetAction(
        describedSheetNodes,
        "semantic",
        "Codex Fast",
        "/model"
      )
    ).not.toBeNull();
    expect(
      physicalSheetChoiceSelected(
        describedSheetNodes,
        "/model",
        "Codex Current"
      )
    ).toBe(true);
    const xiaomiSheetNodes = describedSheetNodes.map((node) => {
      const { checked: _checked, ...withoutNativeSelection } = node;
      return Object.freeze(
        node.description === "Codex Current"
          ? {
              ...withoutNativeSelection,
              description: "Codex Current, selected"
            }
          : withoutNativeSelection
      ) as AndroidUiNode;
    });
    expect(
      physicalSheetChoiceSelected(
        xiaomiSheetNodes,
        "/model",
        "Codex Current"
      )
    ).toBe(true);
    expect(
      physicalSheetChoiceSelected(xiaomiSheetNodes, "/model", "Codex Fast")
    ).toBe(false);
    const fastSheetNodes = sheetNodes.map((node) => {
      if (node.text === "Thorough") return node;
      const { checked: _checked, ...unselected } = node;
      return Object.freeze(
        node.text === "Codex Fast"
          ? { ...unselected, checked: true as const }
          : unselected
      ) as AndroidUiNode;
    });
    expect(physicalSheetChoiceSelected(fastSheetNodes, "/model", "Codex Fast")).toBe(true);
    const describedFastSheetNodes = fastSheetNodes.map((node) =>
      [...physicalModelChoiceLabels, "Codex Balanced", "Thorough"].includes(
        node.text
      )
        ? (Object.freeze({
            ...node,
            description: node.text,
            text: ""
          }) as AndroidUiNode)
        : node
    );
    expect(
      physicalSheetChoiceSelected(
        describedFastSheetNodes,
        "/model",
        "Codex Fast"
      )
    ).toBe(true);
    const xiaomiFastSheetNodes = describedFastSheetNodes.map((node) => {
      const { checked: _checked, ...withoutNativeSelection } = node;
      return Object.freeze(
        node.description === "Codex Fast"
          ? { ...withoutNativeSelection, description: "Codex Fast, selected" }
          : withoutNativeSelection
      ) as AndroidUiNode;
    });
    expect(
      physicalSheetChoiceSelected(
        xiaomiFastSheetNodes,
        "/model",
        "Codex Fast"
      )
    ).toBe(true);
    expect(
      physicalSheetChoiceSelected(
        fastSheetNodes.filter((node) => node.text !== "Codex Fast"),
        "/model",
        "Codex Fast"
      )
    ).toBe(false);
    expect(
      physicalSheetChoiceSelected(
        fastSheetNodes.map((node) =>
          node.text === "Codex Current"
            ? Object.freeze({ ...node, checked: true as const })
            : node
        ),
        "/model",
        "Codex Fast"
      )
    ).toBe(false);
    expect(
      selectPhysicalSheetAction(
        [...sheetNodes, Object.freeze({ ...sheetNodes[2] }) as AndroidUiNode],
        "text",
        "Codex Fast",
        "/model"
      )
    ).toBeNull();
    const competingSheetNodes = [
      ...sheetNodes,
      Object.freeze({
        ...sheetNodes.find((node) => node.text === "/model"),
        text: "/goal"
      }) as AndroidUiNode,
      Object.freeze({
        ...sheetNodes.find((node) => node.description === "Close model control"),
        description: "Close goal control"
      }) as AndroidUiNode
    ];
    expect(
      selectPhysicalSheetAction(
        competingSheetNodes,
        "text",
        "Codex Fast",
        "/model"
      )
    ).toBeNull();
    expect(
      selectPhysicalSheetAction(
        [
          ...sheetNodes,
          Object.freeze({
            ...(sheetNodes.find((node) => node.text === "/model") as AndroidUiNode),
            bounds: Object.freeze({ bottom: 1_420, left: 80, right: 700, top: 1_340 }),
            text: "Turn completed"
          })
        ],
        "text",
        "Codex Fast",
        "/model"
      )
    ).not.toBeNull();

    const resumeNodes = parseAndroidUiNodes(
      '<hierarchy><node text="" class="android.view.ViewGroup" ' +
        `resource-id="${chromeToolbarResourceId}" bounds="[0,80][1080,240]" />` +
        '<node text="" class="android.widget.FrameLayout" ' +
        `resource-id="${chromeCompositorResourceId}" bounds="[0,80][1080,2400]" />` +
        '<node text="Resume on laptop" class="android.view.View" ' +
        'bounds="[190,300][600,380]" />' +
        '<node text="" class="android.widget.Button" ' +
        'content-desc="Back to session actions" clickable="true" enabled="true" ' +
        'bounds="[20,300][160,420]" />' +
        '<node text="" class="android.widget.Button" ' +
        'content-desc="Close session actions" clickable="true" enabled="true" ' +
        'bounds="[900,300][1040,420]" />' +
        '<node text="Laptop terminal only" bounds="[80,500][600,580]" />' +
        '<node text="Copy command" class="android.widget.Button" clickable="true" ' +
        'enabled="true" bounds="[80,620][600,760]" />' +
        '</hierarchy>'
    );
    expect(selectPhysicalResumeCopyAction(resumeNodes)).not.toBeNull();
    expect(
      selectPhysicalResumeCopyAction([
        ...resumeNodes,
        Object.freeze({ ...resumeNodes[1] }) as AndroidUiNode
      ])
    ).toBeNull();
    expect(
      selectPhysicalResumeCopyAction([
        ...resumeNodes,
        Object.freeze({
          ...resumeNodes.find((node) => node.text === "Resume on laptop"),
          text: "/model"
        }) as AndroidUiNode,
        Object.freeze({
          ...resumeNodes.find(
            (node) => node.description === "Close session actions"
          ),
          description: "Close model control"
        }) as AndroidUiNode
      ])
    ).toBeNull();
    const utilityNodes = parseAndroidUiNodes(
      '<hierarchy><node text="" class="android.view.ViewGroup" ' +
        `resource-id="${chromeToolbarResourceId}" bounds="[0,80][1080,240]" />` +
        '<node text="" class="android.widget.FrameLayout" ' +
        `resource-id="${chromeCompositorResourceId}" bounds="[0,80][1080,2400]" />` +
        '<node text="/usage" class="android.view.View" bounds="[80,300][300,380]" />' +
        '<node text="Lifetime tokens" bounds="[80,500][600,580]" />' +
        '<node text="" class="android.widget.Button" ' +
        'content-desc="Close Usage utility" clickable="true" enabled="true" ' +
        'bounds="[900,300][1040,420]" />' +
        '<node text="" class="android.widget.Button" ' +
        'content-desc="Back to session utilities" clickable="true" enabled="true" ' +
        'bounds="[20,300][160,380]" />' +
        '</hierarchy>'
    );
    const usageClose = utilityNodes.find(
      (node) => node.description === "Close Usage utility"
    );
    requireCondition(usageClose !== undefined, "Usage owner close fixture was absent.");
    expect(selectPhysicalUtilityBackAction(utilityNodes, "/usage")).not.toBeNull();
    expect(
      selectPhysicalUtilityBackAction(
        utilityNodes.filter((node) => node !== usageClose),
        "/usage"
      )
    ).toBeNull();
    expect(
      selectPhysicalUtilityBackAction(
        [...utilityNodes, Object.freeze({ ...usageClose })],
        "/usage"
      )
    ).toBeNull();
    expect(
      selectPhysicalUtilityBackAction([
        ...utilityNodes,
        Object.freeze({ ...utilityNodes.at(-1) }) as AndroidUiNode
      ], "/usage")
    ).toBeNull();
    expect(
      selectPhysicalUtilityBackAction(
        utilityNodes.map((node) =>
          node.description === "Back to session utilities"
            ? Object.freeze({
                ...node,
                bounds: Object.freeze({ ...node.bounds, top: 700, bottom: 780 })
              })
            : node
        ),
        "/usage"
      )
    ).toBeNull();
    expect(
      selectPhysicalUtilityBackAction(
        [
          ...utilityNodes,
          Object.freeze({ ...utilityNodes[2], text: "/model" }) as AndroidUiNode,
          Object.freeze({
            ...utilityNodes[4],
            description: "Close model control"
          }) as AndroidUiNode
        ],
        "/usage"
      )
    ).toBeNull();
    const utilitiesMenuNodes = parseAndroidUiNodes(
      '<hierarchy><node text="" class="android.view.ViewGroup" ' +
        `resource-id="${chromeToolbarResourceId}" bounds="[0,80][1080,240]" />` +
        '<node text="" class="android.widget.FrameLayout" ' +
        `resource-id="${chromeCompositorResourceId}" bounds="[0,80][1080,2400]" />` +
        '<node text="Session utilities" class="android.view.View" bounds="[80,300][620,380]" />' +
        '<node text="" class="android.widget.Button" content-desc="Close session utilities" ' +
        'clickable="true" enabled="true" bounds="[900,300][1040,420]" />' +
        '<node text="" class="android.widget.Button" content-desc="Open /usage" ' +
        'clickable="true" enabled="true" bounds="[80,560][700,700]" />' +
        '<node text="" class="android.widget.Button" content-desc="Open /compact" ' +
        'clickable="true" enabled="true" bounds="[80,740][700,880]" />' +
        '</hierarchy>'
    );
    expect(
      selectPhysicalSessionUtilityAction(
        utilitiesMenuNodes,
        "description",
        "Open /usage"
      )
    ).not.toBeNull();
    expect(
      selectPhysicalSessionUtilityAction(
        [
          ...utilitiesMenuNodes,
          Object.freeze({
            ...utilitiesMenuNodes.find((node) => node.description === "Open /usage"),
            bounds: Object.freeze({ bottom: 860, left: 80, right: 700, top: 720 })
          }) as AndroidUiNode
        ],
        "description",
        "Open /usage"
      )
    ).toBeNull();
    const compactPageNodes = parseAndroidUiNodes(
      '<hierarchy><node text="" class="android.view.ViewGroup" ' +
        `resource-id="${chromeToolbarResourceId}" bounds="[0,80][1080,240]" />` +
        '<node text="" class="android.widget.FrameLayout" ' +
        `resource-id="${chromeCompositorResourceId}" bounds="[0,80][1080,2400]" />` +
        '<node text="/compact" class="android.view.View" bounds="[80,300][620,380]" />' +
        '<node text="" class="android.widget.Button" content-desc="Back to session utilities" ' +
        'clickable="true" enabled="true" bounds="[20,300][160,380]" />' +
        '<node text="" class="android.widget.Button" content-desc="Close Compact utility" ' +
        'clickable="true" enabled="true" bounds="[900,300][1040,420]" />' +
        '<node text="No tracked compaction" bounds="[80,500][700,580]" />' +
        '<node text="" class="android.widget.Button" content-desc="Check Compact progress" ' +
        'clickable="true" enabled="true" bounds="[80,680][700,820]" />' +
        '</hierarchy>'
    );
    expect(
      selectPhysicalUtilityPageAction(
        compactPageNodes,
        "/compact",
        "description",
        "Check Compact progress"
      )
    ).not.toBeNull();
    expect(
      selectPhysicalUtilityPageAction(
        compactPageNodes.map((node) =>
          node.text === "No tracked compaction"
            ? Object.freeze({ ...node, bounds: Object.freeze({ ...node.bounds, top: 120, bottom: 200 }) })
            : node
        ),
        "/compact",
        "description",
        "Check Compact progress"
      )
    ).not.toBeNull();
    expect(
      selectPhysicalUtilityBackAction(
        utilityNodes.map((node) =>
          node.description === "Back to session utilities"
            ? Object.freeze({
                ...node,
                bounds: Object.freeze({ ...node.bounds, top: 100, bottom: 180 })
              })
            : node
        ),
        "/usage"
      )
    ).toBeNull();
    const resumeBackNodes = parseAndroidUiNodes(
      '<hierarchy><node text="" class="android.view.ViewGroup" ' +
        `resource-id="${chromeToolbarResourceId}" bounds="[0,80][1080,240]" />` +
        '<node text="" class="android.widget.FrameLayout" ' +
        `resource-id="${chromeCompositorResourceId}" bounds="[0,80][1080,2400]" />` +
        '<node text="Resume on laptop" class="android.view.View" ' +
        'bounds="[190,300][600,380]" />' +
        '<node text="Laptop terminal only" bounds="[80,500][600,580]" />' +
        '<node text="" class="android.widget.Button" ' +
        'content-desc="Back to session actions" clickable="true" enabled="true" ' +
        'bounds="[20,300][160,420]" />' +
        '<node text="" class="android.widget.Button" ' +
        'content-desc="Close session actions" clickable="true" enabled="true" ' +
        'bounds="[900,300][1040,420]" />' +
        '</hierarchy>'
    );
    const resumeClose = resumeBackNodes.find(
      (node) => node.description === "Close session actions"
    );
    requireCondition(resumeClose !== undefined, "Resume owner close fixture was absent.");
    expect(selectPhysicalResumeBackAction(resumeBackNodes)).not.toBeNull();
    expect(
      selectPhysicalResumeBackAction(
        resumeBackNodes.filter((node) => node !== resumeClose)
      )
    ).toBeNull();
    expect(
      selectPhysicalResumeBackAction([
        ...resumeBackNodes,
        Object.freeze({ ...resumeClose })
      ])
    ).toBeNull();
    expect(
      selectPhysicalResumeBackAction(
        resumeBackNodes.map((node) =>
          node.text === "Resume on laptop"
            ? Object.freeze({ ...node, text: "Session actions" })
            : node
        )
      )
    ).toBeNull();
    expect(
      selectPhysicalResumeBackAction(
        resumeBackNodes.map((node) =>
          node.description === "Back to session actions"
            ? Object.freeze({
                ...node,
                bounds: Object.freeze({ ...node.bounds, top: 100, bottom: 180 })
              })
            : node
        )
      )
    ).toBeNull();
    const copyBase = [
      ...resumeNodes,
      Object.freeze({
        bounds: Object.freeze({ bottom: 840, left: 80, right: 600, top: 780 }),
        className: "android.view.View",
        clickable: false,
        description: "",
        resourceId: "",
        text: "Command copied"
      }) as AndroidUiNode
    ];
    expect(physicalResumeCopyOutcome(copyBase)).toBe("copied");
    expect(
      physicalResumeCopyOutcome(
        copyBase.map((node) =>
          node.text === "Command copied"
            ? Object.freeze({ ...node, text: "Copy failed" })
            : node
        )
      )
    ).toBe("unavailable");
    expect(
      physicalResumeCopyOutcome([
        ...copyBase,
        Object.freeze({ ...copyBase.at(-1), text: "Copy failed" }) as AndroidUiNode
      ])
    ).toBeNull();
    expect(
      physicalResumeCopyOutcome([
        ...copyBase,
        Object.freeze({
          ...copyBase.at(-1),
          bounds: Object.freeze({ bottom: 290, left: 80, right: 600, top: 250 })
        }) as AndroidUiNode
      ])
    ).toBeNull();

    const clipboardNodes = parseAndroidUiNodes(
      '<hierarchy><node text="" class="android.view.ViewGroup" ' +
        `resource-id="${chromeToolbarResourceId}" bounds="[0,80][1080,240]" />` +
        '<node text="" class="android.widget.FrameLayout" ' +
        `resource-id="${chromeCompositorResourceId}" bounds="[0,80][1080,2400]" />` +
        '<node text="HostDeck" class="android.view.View" bounds="[80,280][400,340]" />' +
        '<node text="Remote access check" class="android.view.View" ' +
        'bounds="[80,400][700,480]" />' +
        '<node text="Clipboard cleared" class="android.view.View" bounds="[80,560][600,640]" />' +
        '<node text="The temporary laptop command was removed." class="android.view.View" ' +
        'bounds="[80,680][900,760]" />' +
        '</hierarchy>'
    );
    expect(physicalClipboardClearedTruthVisible(clipboardNodes)).toBe(true);
    expect(
      physicalClipboardClearedTruthVisible(
        clipboardNodes.filter((node) => node.text !== "Remote access check")
      )
    ).toBe(false);
    expect(
      physicalClipboardClearedTruthVisible([
        ...clipboardNodes,
        Object.freeze({
          bounds: Object.freeze({ bottom: 920, left: 80, right: 600, top: 840 }),
          className: "android.widget.Button",
          clickable: true,
          description: "Clear clipboard",
          resourceId: "",
          text: "Clear clipboard"
        })
      ])
    ).toBe(false);
    expect(
      physicalClipboardClearedTruthVisible([
        ...clipboardNodes,
        Object.freeze({
          ...(clipboardNodes.find(
            (node) => node.text === "Clipboard cleared"
          ) as AndroidUiNode),
          text: "Clear copied command"
        })
      ])
    ).toBe(false);

    const clipboardReady = clipboardNodes
      .filter((node) => node.text !== "Clipboard cleared")
      .map((node) =>
        node.text === "The temporary laptop command was removed."
          ? Object.freeze({
              ...node,
              text: "Remove the temporary laptop command from this phone."
            })
          : node
      );
    const clipboardAction = Object.freeze({
      bounds: Object.freeze({ bottom: 980, left: 80, right: 1000, top: 840 }),
      className: "android.widget.Button",
      clickable: true,
      description: "",
      resourceId: "",
      text: "Clear clipboard"
    });
    const clipboardReadyWithAction = [
      ...clipboardReady,
      Object.freeze({
        ...(clipboardNodes.find(
          (node) => node.text === "Clipboard cleared"
        ) as AndroidUiNode),
        text: "Clear copied command"
      }),
      clipboardAction
    ];
    expect(
      selectPhysicalExternalPageAction(clipboardReadyWithAction, "Clear clipboard")
    ).toBe(clipboardAction);
    expect(
      selectPhysicalExternalPageAction(
        [
          ...clipboardReadyWithAction,
          Object.freeze({
            ...clipboardAction,
            description: "Close session actions",
            text: ""
          })
        ],
        "Clear clipboard"
      )
    ).toBeNull();
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
      '<hierarchy><node text="" class="android.view.ViewGroup" ' +
        `resource-id="${chromeToolbarResourceId}" bounds="[0,0][1080,240]" />` +
        '<node text="" class="android.widget.FrameLayout" ' +
        `resource-id="${chromeCompositorResourceId}" bounds="[0,0][1080,2200]" />` +
        '<node text="/plan" class="android.view.View" bounds="[80,300][240,380]" />' +
        '<node text="" class="android.widget.Button" content-desc="Close Plan control" ' +
        'clickable="true" enabled="true" bounds="[900,300][1040,420]" />' +
        '<node text="Default" bounds="[100,500][300,580]" />' +
        '<node text="No pending change" bounds="[100,620][500,700]" />' +
        '<node text="No observed Plan execution" bounds="[100,740][600,820]" />' +
        '<node text="Plan" bounds="[0,900][300,980]" />' +
        '<node text="Default" bounds="[100,1020][300,1100]" />' +
        '<node text="Default" class="android.widget.RadioButton" clickable="true" ' +
        'checked="true" enabled="true" bounds="[80,1000][760,1140]" />' +
        '</hierarchy>'
    );

    expect(physicalPlanCurrentTruthVisible(nodes, "Default")).toBe(true);
    const describedCurrentMode = nodes.map((node) =>
      node.className === "android.widget.RadioButton"
        ? (Object.freeze({
            ...node,
            description: node.text,
            text: ""
          }) as AndroidUiNode)
        : node
    );
    expect(
      physicalPlanCurrentTruthVisible(describedCurrentMode, "Default")
    ).toBe(true);
    const xiaomiCurrentMode = describedCurrentMode.map((node) => {
      if (node.className !== "android.widget.RadioButton") return node;
      const { checked: _checked, ...withoutNativeSelection } = node;
      return Object.freeze({
        ...withoutNativeSelection,
        description: "Default, selected"
      }) as AndroidUiNode;
    });
    expect(physicalPlanCurrentTruthVisible(xiaomiCurrentMode, "Default")).toBe(
      true
    );
    expect(
      selectPhysicalSheetAction(
        describedCurrentMode,
        "semantic",
        "Default",
        "/plan"
      )
    ).not.toBeNull();
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
      '<hierarchy><node text="" class="android.view.ViewGroup" ' +
        `resource-id="${chromeToolbarResourceId}" bounds="[0,0][1080,240]" />` +
        '<node text="" class="android.widget.FrameLayout" ' +
        `resource-id="${chromeCompositorResourceId}" bounds="[0,0][1080,2200]" />` +
        '<node text="/plan" class="android.view.View" bounds="[80,300][240,380]" />' +
        '<node text="" class="android.widget.Button" content-desc="Close Plan control" ' +
        'clickable="true" enabled="true" bounds="[900,300][1040,420]" />' +
        '<node text="A Plan selection is already being saved." bounds="[100,500][700,580]" />' +
        '</hierarchy>'
    );
    expect(physicalPlanSubmittingTruthVisible(submitting)).toBe(true);
    expect(physicalPlanSubmittingTruthVisible([])).toBe(false);

    const staged = parseAndroidUiNodes(
      '<hierarchy><node text="" class="android.view.ViewGroup" ' +
        `resource-id="${chromeToolbarResourceId}" bounds="[0,0][1080,240]" />` +
        '<node text="" class="android.widget.FrameLayout" ' +
        `resource-id="${chromeCompositorResourceId}" bounds="[0,0][1080,2200]" />` +
        '<node text="/plan" class="android.view.View" bounds="[80,300][240,380]" />' +
        '<node text="" class="android.widget.Button" content-desc="Close Plan control" ' +
        'clickable="true" enabled="true" bounds="[900,300][1040,420]" />' +
        '<node text="Pending next turn: Staged in HostDeck" bounds="[100,500][600,580]" />' +
        '<node text="No observed Plan execution" bounds="[100,620][600,700]" />' +
        '<node text="Plan" bounds="[100,820][300,900]" />' +
        '<node text="Plan" bounds="[100,940][300,1020]" />' +
        '<node text="Plan" class="android.widget.RadioButton" clickable="true" ' +
        'checked="true" enabled="true" bounds="[80,920][760,1060]" />' +
        '</hierarchy>'
    );
    expect(physicalPlanStagedTruthVisible(staged)).toBe(true);
    expect(
      physicalPlanStagedTruthVisible(
        staged.map((node) =>
          node.className === "android.widget.RadioButton"
            ? (Object.freeze({
                ...node,
                description: node.text,
                text: ""
              }) as AndroidUiNode)
            : node
        )
      )
    ).toBe(true);
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

  it("waits for continuous event-target geometry and immutable authority", async () => {
    const timelineLabel = "Synthetic retained event";
    const initialNodes = physicalEventDiagnosticFixtureNodes(timelineLabel);
    const shiftedNodes = physicalEventDiagnosticFixtureNodes(timelineLabel, 48);
    const shiftedTarget = selectPhysicalEventDiagnosticTarget(
      shiftedNodes,
      timelineLabel
    );
    requireCondition(
      shiftedTarget !== null,
      "Shifted event-diagnostic fixture target was absent."
    );
    const absentNodes = initialNodes.filter(
      (node) =>
        node.description !== "View event details" && node.text !== timelineLabel
    );
    const navigation: PhysicalSessionNavigationSnapshot = Object.freeze({
      activeSubscribers: 1,
      missingDetailRequests: 0,
      openedSubscribers: 1,
      selectedDetailRequests: 1,
      streamRequests: 1
    });
    const baseline: PhysicalEventDiagnosticAuthoritySnapshot = Object.freeze({
      navigation,
      sessionEventRequests: 4
    });
    const reads: readonly (readonly AndroidUiNode[] | "error")[] = [
      absentNodes,
      initialNodes,
      shiftedNodes,
      absentNodes,
      "error",
      ...Array.from({ length: 11 }, () => shiftedNodes)
    ];
    let now = 0;
    let readIndex = 0;
    let swipes = 0;
    const source: PhysicalEventDiagnosticWaitSource = Object.freeze({
      readAuthority: () => baseline,
      readNodes: async () => {
        const next = reads[Math.min(readIndex, reads.length - 1)];
        readIndex += 1;
        if (next === "error") throw new Error("private hierarchy payload");
        requireCondition(next !== undefined, "Event-diagnostic fixture read was absent.");
        return next;
      },
      swipe: () => {
        swipes += 1;
      }
    });

    const admitted = await revealPhysicalEventDiagnosticTarget(
      source,
      baseline,
      timelineLabel,
      "backward",
      5_000,
      "Stable event target was not admitted.",
      {
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        }
      }
    );
    expect(physicalAggregateNodeMatches(admitted.action, shiftedTarget.action)).toBe(
      true
    );
    expect(physicalAggregateNodeMatches(admitted.label, shiftedTarget.label)).toBe(
      true
    );
    expect(now).toBeGreaterThanOrEqual(3_000);
    expect(swipes).toBe(2);
    expect(readIndex).toBe(reads.length);

    const rejectAuthorityDrift = async (
      drifted: PhysicalEventDiagnosticAuthoritySnapshot,
      marker: string
    ): Promise<void> => {
      let current = baseline;
      let rejectedNow = 0;
      let rejectedReads = 0;
      const rejected = revealPhysicalEventDiagnosticTarget(
        Object.freeze({
          readAuthority: () => current,
          readNodes: async () => {
            rejectedReads += 1;
            current = drifted;
            return shiftedNodes;
          },
          swipe: () => {
            throw new Error("authority drift must not swipe");
          }
        }),
        baseline,
        timelineLabel,
        "forward",
        600,
        "Event authority drift was accepted.",
        {
          now: () => rejectedNow,
          sleep: async (milliseconds) => {
            rejectedNow += milliseconds;
          }
        }
      );
      await expect(rejected).rejects.toThrow(marker);
      expect(rejectedNow).toBe(600);
      expect(rejectedReads).toBe(1);
    };
    await rejectAuthorityDrift(
      Object.freeze({
        ...baseline,
        navigation: Object.freeze({
          ...navigation,
          streamRequests: navigation.streamRequests + 1
        })
      }),
      "navigation=drift"
    );
    await rejectAuthorityDrift(
      Object.freeze({
        ...baseline,
        sessionEventRequests: baseline.sessionEventRequests + 1
      }),
      "event_delta=1"
    );
    expect(() =>
      requirePhysicalEventDiagnosticAuthorityBeforeTap(
        Object.freeze({
          readAuthority: () =>
            Object.freeze({
              ...baseline,
              sessionEventRequests: baseline.sessionEventRequests + 1
            }),
          readNodes: async () => shiftedNodes,
          swipe: () => undefined
        }),
        baseline,
        Object.freeze({
          actionId: "event-open-boundary",
          counterSnapshot: Object.freeze({
            session_event_requests: baseline.sessionEventRequests
          }),
          currentNodes: shiftedNodes,
          node: shiftedTarget.action,
          routeOwner: "Event details"
        }),
        shiftedTarget,
        timelineLabel
      )
    ).toThrow("drifted before its only tap");
    const stableSource: PhysicalEventDiagnosticWaitSource = Object.freeze({
      readAuthority: () => baseline,
      readNodes: async () => shiftedNodes,
      swipe: () => undefined
    });
    const preTapContext = Object.freeze({
      actionId: "event-open-boundary" as const,
      counterSnapshot: Object.freeze({
        session_event_requests: baseline.sessionEventRequests
      }),
      currentNodes: shiftedNodes,
      node: shiftedTarget.action,
      routeOwner: "Event details" as const
    });
    expect(() =>
      requirePhysicalEventDiagnosticAuthorityBeforeTap(
        stableSource,
        baseline,
        Object.freeze({
          ...preTapContext,
          currentNodes: shiftedNodes.filter(
            (node) => node.text !== timelineLabel
          )
        }),
        shiftedTarget,
        timelineLabel
      )
    ).toThrow("owner or counter drifted before its only tap");
    expect(() =>
      requirePhysicalEventDiagnosticAuthorityBeforeTap(
        stableSource,
        baseline,
        Object.freeze({
          ...preTapContext,
          counterSnapshot: Object.freeze({
            session_event_requests: baseline.sessionEventRequests + 1
          })
        }),
        shiftedTarget,
        timelineLabel
      )
    ).toThrow("owner or counter drifted before its only tap");
  });

  it("rejects duplicate, disabled, and occluded event-target owners", async () => {
    const timelineLabel = "Synthetic hostile event";
    const nodes = physicalEventDiagnosticFixtureNodes(timelineLabel);
    const action = nodes.find(
      (node) => node.description === "View event details"
    );
    requireCondition(action !== undefined, "Hostile event action fixture was absent.");
    const hostileStates: readonly (readonly AndroidUiNode[])[] = [
      Object.freeze([...nodes, Object.freeze({ ...action })]),
      Object.freeze(
        nodes.map((node) =>
          node === action
            ? Object.freeze({ ...node, enabled: false as const })
            : node
        )
      ),
      physicalEventDiagnosticFixtureNodes(timelineLabel, 700)
    ];
    const baseline: PhysicalEventDiagnosticAuthoritySnapshot = Object.freeze({
      navigation: Object.freeze({
        activeSubscribers: 1,
        missingDetailRequests: 0,
        openedSubscribers: 1,
        selectedDetailRequests: 1,
        streamRequests: 1
      }),
      sessionEventRequests: 2
    });

    for (const hostileNodes of hostileStates) {
      expect(selectPhysicalEventDiagnosticTarget(hostileNodes, timelineLabel)).toBeNull();
      let now = 0;
      const rejected = revealPhysicalEventDiagnosticTarget(
        Object.freeze({
          readAuthority: () => baseline,
          readNodes: async () => hostileNodes,
          swipe: () => undefined
        }),
        baseline,
        timelineLabel,
        "forward",
        500,
        "Hostile event target was admitted.",
        {
          now: () => now,
          sleep: async (milliseconds) => {
            now += milliseconds;
          }
        }
      );
      await expect(rejected).rejects.toThrow("target=blocked");
    }
  });

  it("classifies exact event-sheet outcomes with bounded private-free evidence", () => {
    const timelineLabel = "private synthetic event detail";
    const eventNodes = physicalEventDiagnosticFixtureNodes(timelineLabel);
    const target = selectPhysicalEventDiagnosticTarget(eventNodes, timelineLabel);
    requireCondition(target !== null, "Event outcome fixture target was absent.");
    const navigation: PhysicalSessionNavigationSnapshot = Object.freeze({
      activeSubscribers: 1,
      missingDetailRequests: 0,
      openedSubscribers: 1,
      selectedDetailRequests: 1,
      streamRequests: 1
    });
    const baselineAuthority: PhysicalEventDiagnosticAuthoritySnapshot = Object.freeze({
      navigation,
      sessionEventRequests: 4
    });
    const currentAuthority: PhysicalEventDiagnosticAuthoritySnapshot = Object.freeze({
      navigation,
      sessionEventRequests: 5
    });
    const outcome = (
      nodes: readonly AndroidUiNode[],
      actualAuthority: PhysicalEventDiagnosticAuthoritySnapshot = currentAuthority
    ): PhysicalEventDiagnosticOutcomeInput =>
      Object.freeze({
        actualAuthority,
        baselineAuthority,
        heading: "Replay boundary",
        limitation: "Content truncated",
        nodes,
        target,
        timelineLabel
      });
    const states = [
      ["Verifying event", "loading"],
      ["Event details current", "current"],
      ["Event verification failed", "failure"],
      ["Local evidence only", "local_only"],
      ["Retained event detail", "retained"]
    ] as const;
    const observations: string[] = [];
    for (const [status, expectedState] of states) {
      const nodes = physicalEventDiagnosticSheetFixtureNodes(status);
      expect(physicalEventDiagnosticSheetState(nodes)).toBe(expectedState);
      expect(physicalEventDiagnosticCurrentOutcomeVisible(outcome(nodes))).toBe(
        expectedState === "current"
      );
      const summary = physicalEventDiagnosticOutcomeSummary(outcome(nodes));
      expect(summary).toContain(`sheet=${expectedState}`);
      expect(summary).toContain("request_delta=1");
      expect(summary).toContain("navigation=match");
      expect(summary).toContain("owner=admitted");
      expect(summary).toContain("heading=1;limitation=1");
      expect(summary).not.toContain(timelineLabel);
      retainPhysicalEventDiagnosticObservation(observations, summary);
    }

    const missed = physicalEventDiagnosticOutcomeSummary(
      outcome(eventNodes, baselineAuthority)
    );
    expect(missed).toContain("target=same");
    expect(missed).toContain("request_delta=0");
    expect(missed).toContain("owner=blocked");
    expect(missed).toContain("sheet=absent");
    const moved = physicalEventDiagnosticOutcomeSummary(
      outcome(
        physicalEventDiagnosticFixtureNodes(timelineLabel, 48),
        baselineAuthority
      )
    );
    expect(moved).toContain("target=moved");
    const absent = physicalEventDiagnosticOutcomeSummary(
      outcome([], baselineAuthority)
    );
    expect(absent).toContain("target=absent");
    const duplicate = physicalEventDiagnosticOutcomeSummary(
      outcome(
        [
          ...eventNodes,
          Object.freeze({
            ...target.action,
            bounds: Object.freeze({
              ...target.action.bounds,
              bottom: target.action.bounds.bottom + 24,
              top: target.action.bounds.top + 24
            })
          })
        ],
        baselineAuthority
      )
    );
    expect(duplicate).toContain("target=duplicate");

    const currentNodes = physicalEventDiagnosticSheetFixtureNodes(
      "Event details current"
    );
    const close = currentNodes.find(
      (node) => node.description === "Close event details"
    );
    const currentStatus = currentNodes.find(
      (node) => node.text === "Event details current"
    );
    requireCondition(close !== undefined, "Event sheet close fixture was absent.");
    requireCondition(
      currentStatus !== undefined,
      "Event sheet status fixture was absent."
    );
    const openNodes = currentNodes.filter(
      (node) => node.text !== "Event details current"
    );
    expect(physicalEventDiagnosticSheetState([])).toBe("absent");
    expect(physicalEventDiagnosticSheetState(openNodes)).toBe("open");
    expect(physicalEventDiagnosticCurrentOutcomeVisible(outcome(openNodes))).toBe(
      false
    );
    expect(
      physicalEventDiagnosticSheetState([
        ...currentNodes,
        Object.freeze({ ...close })
      ])
    ).toBe("invalid");
    expect(
      physicalEventDiagnosticSheetState([
        ...currentNodes,
        Object.freeze({ ...currentStatus })
      ])
    ).toBe("invalid");
    expect(
      physicalEventDiagnosticCurrentOutcomeVisible(
        outcome(
          currentNodes.filter((node) => node.text !== "Content truncated")
        )
      )
    ).toBe(false);
    expect(
      physicalEventDiagnosticCurrentOutcomeVisible(
        outcome(
          currentNodes,
          Object.freeze({
            navigation: Object.freeze({
              ...navigation,
              streamRequests: navigation.streamRequests + 1
            }),
            sessionEventRequests: currentAuthority.sessionEventRequests
          })
        )
      )
    ).toBe(false);
    expect(
      physicalEventDiagnosticCurrentOutcomeVisible(
        outcome(
          currentNodes,
          Object.freeze({
            navigation,
            sessionEventRequests: currentAuthority.sessionEventRequests + 1
          })
        )
      )
    ).toBe(false);
    retainPhysicalEventDiagnosticObservation(observations, missed);
    retainPhysicalEventDiagnosticObservation(observations, moved);
    retainPhysicalEventDiagnosticObservation(observations, absent);
    expect(observations.length).toBe(6);
    expect(observations.join("|")).not.toContain(timelineLabel);
    expect(() =>
      retainPhysicalEventDiagnosticObservation(
        observations,
        "x".repeat(physicalEventDiagnosticObservationMaxBytes + 1)
      )
    ).toThrow("observation exceeded its private-safe bound");
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

  it("keeps global and nested Host ownership structurally separate", () => {
    const globalNodes = parseAndroidUiNodes(
      '<hierarchy><node text="" class="android.view.ViewGroup" ' +
        `resource-id="${chromeToolbarResourceId}" bounds="[0,80][1080,240]" />` +
        '<node text="" class="android.widget.FrameLayout" ' +
        `resource-id="${chromeCompositorResourceId}" bounds="[0,80][1080,2400]" />` +
        '<node text="Host &amp; access" class="android.view.View" ' +
        'bounds="[190,370][720,450]" />' +
        '<node text="" class="android.widget.Button" ' +
        'content-desc="Close Host and access" clickable="true" enabled="true" ' +
        'bounds="[916,360][1040,484]" />' +
        '<node text="Remote access ready" bounds="[190,560][720,640]" />' +
        '</hierarchy>'
    );
    expect(selectPhysicalHostAccessContentRegion(globalNodes, "global")).toEqual({
      height: 1_892,
      left: 0,
      top: 508,
      width: 1_080
    });
    expect(selectPhysicalHostAccessCloseAction(globalNodes, "global")).toBe(
      globalNodes.find((node) => node.description === "Close Host and access")
    );
    expect(selectPhysicalHostAccessContentRegion(globalNodes, "nested")).toBeNull();
    expect(selectPhysicalHostAccessCloseAction(globalNodes, "nested")).toBeNull();
    const globalResult = Object.freeze({
      ...(globalNodes.find((node) => node.text === "Remote access ready") as AndroidUiNode),
      text: "This phone was revoked"
    });
    expect(
      physicalHostAccessTextVisible(
        [...globalNodes, globalResult],
        "global",
        "This phone was revoked"
      )
    ).toBe(true);
    expect(
      physicalHostAccessTextVisible(
        [...globalNodes, globalResult, Object.freeze({ ...globalResult })],
        "global",
        "This phone was revoked"
      )
    ).toBe(false);

    const globalClose = globalNodes.find(
      (node) => node.description === "Close Host and access"
    );
    requireCondition(globalClose !== undefined, "Global Host close fixture was absent.");
    const mixedGlobal = [
      ...globalNodes,
      Object.freeze({
        ...globalClose,
        description: "Back to session actions"
      }) as AndroidUiNode
    ];
    expect(selectPhysicalHostAccessContentRegion(mixedGlobal, "global")).toBeNull();
    expect(selectPhysicalHostAccessCloseAction(mixedGlobal, "global")).toBeNull();

    const eventNodes = parseAndroidUiNodes(
      '<hierarchy><node text="" class="android.view.ViewGroup" ' +
        `resource-id="${chromeToolbarResourceId}" bounds="[0,80][1080,240]" />` +
        '<node text="" class="android.widget.FrameLayout" ' +
        `resource-id="${chromeCompositorResourceId}" bounds="[0,80][1080,2400]" />` +
        '<node text="Event details" class="android.view.View" bounds="[190,370][720,450]" />' +
        '<node text="" class="android.widget.Button" ' +
        'content-desc="Close event details" clickable="true" enabled="true" ' +
        'bounds="[916,360][1040,484]" />' +
        '</hierarchy>'
    );
    expect(selectPhysicalDialogCloseAction(eventNodes, "Close event details")).not.toBeNull();
    expect(selectPhysicalDialogCloseAction(eventNodes, "Close goal control")).toBeNull();
  });

  it("rejects ambiguous destructive confirmation and terminal-result owners", () => {
    const confirmation = parseAndroidUiNodes(
      '<hierarchy><node text="" class="android.view.ViewGroup" ' +
        `resource-id="${chromeToolbarResourceId}" bounds="[0,80][1080,240]" />` +
        '<node text="" class="android.widget.FrameLayout" ' +
        `resource-id="${chromeCompositorResourceId}" bounds="[0,80][1080,2400]" />` +
        '<node text="Lock remote writes?" class="android.view.View" ' +
        'bounds="[80,400][700,500]" />' +
        '<node text="" class="android.widget.Button" ' +
        'content-desc="Close remote write lock confirmation" clickable="true" ' +
        'enabled="true" bounds="[916,380][1040,504]" />' +
        '<node text="Cancel" class="android.widget.Button" clickable="true" ' +
        'enabled="true" bounds="[80,1800][540,1930]" />' +
        '<node text="Lock writes" class="android.widget.Button" clickable="true" ' +
        'enabled="true" bounds="[500,1800][1000,1930]" />' +
        '</hierarchy>'
    );
    const lock = selectPhysicalHostLockConfirmationAction(confirmation);
    const confirmationClose = confirmation.find(
      (node) => node.description === "Close remote write lock confirmation"
    );
    requireCondition(
      confirmationClose !== undefined,
      "Physical confirmation owner close was absent."
    );
    expect(lock).not.toBeNull();
    for (const malformed of [
      [...confirmation, Object.freeze({ ...confirmation.at(-1) }) as AndroidUiNode],
      confirmation.map((node) =>
        node.text === "Lock writes"
          ? Object.freeze({ ...node, enabled: false as const })
          : node
      ),
      confirmation.map((node) =>
        node.text === "Lock writes"
          ? Object.freeze({
              ...node,
              bounds: Object.freeze({ ...node.bounds, bottom: 2_401, top: 2_300 })
            })
          : node
      ),
      confirmation.map((node) =>
        node.text === "Cancel"
          ? Object.freeze({
              ...node,
              bounds: Object.freeze({ ...node.bounds, bottom: 300, top: 200 })
            })
          : node
      ),
      confirmation.map((node) =>
        node.text === "Lock remote writes?"
          ? Object.freeze({ ...node, text: "Old lock result" })
          : node
      ),
      confirmation.filter(
        (node) => node.description !== "Close remote write lock confirmation"
      ),
      [
        ...confirmation,
        Object.freeze({
          ...confirmationClose,
          description: "Close device revocation"
        })
      ]
    ]) {
      expect(selectPhysicalHostLockConfirmationAction(malformed)).toBeNull();
    }

    const result = parseAndroidUiNodes(
      '<hierarchy><node text="" class="android.view.ViewGroup" ' +
        `resource-id="${chromeToolbarResourceId}" bounds="[0,80][1080,240]" />` +
        '<node text="" class="android.widget.FrameLayout" ' +
        `resource-id="${chromeCompositorResourceId}" bounds="[0,80][1080,2400]" />` +
        '<node text="Turn interrupted" class="android.view.View" ' +
        'bounds="[190,370][720,450]" />' +
        '<node text="" class="android.widget.Button" ' +
        'content-desc="Close session actions" clickable="true" enabled="true" ' +
        'bounds="[916,360][1040,484]" />' +
        '<node text="Turn interrupted" class="android.view.View" ' +
        'bounds="[80,1600][600,1700]" />' +
        '<node text="Done" class="android.widget.Button" clickable="true" ' +
        'enabled="true" bounds="[580,1800][1000,1930]" />' +
        '</hierarchy>'
    );
    const resultHeader = result.find(
      (node) => node.text === "Turn interrupted" && node.bounds.top < 1_000
    );
    const resultMarker = result.find(
      (node) => node.text === "Turn interrupted" && node.bounds.top > 1_000
    );
    const resultClose = result.find(
      (node) => node.description === "Close session actions"
    );
    requireCondition(
      resultHeader !== undefined && resultMarker !== undefined && resultClose !== undefined,
      "Physical result ownership fixture was incomplete."
    );
    expect(selectPhysicalResultAction(result, ["Turn interrupted"], "Done")).not.toBeNull();
    expect(
      selectPhysicalResultAction(
        [...result, Object.freeze({ ...result.at(-1) }) as AndroidUiNode],
        ["Turn interrupted"],
        "Done"
      )
    ).toBeNull();
    expect(
      selectPhysicalResultAction(
        result.filter((node) => node !== resultHeader),
        ["Turn interrupted"],
        "Done"
      )
    ).toBeNull();
    expect(
      selectPhysicalResultAction(
        result.filter((node) => node !== resultMarker),
        ["Turn interrupted"],
        "Done"
      )
    ).toBeNull();
    expect(
      selectPhysicalResultAction(
        result.filter((node) => node !== resultClose),
        ["Turn interrupted"],
        "Done"
      )
    ).toBeNull();

    const archiveResult = result.map((node) => {
      if (node.text === "Turn interrupted") {
        return Object.freeze({ ...node, text: "Session archived" });
      }
      if (node.text === "Done") {
        return Object.freeze({ ...node, text: "Back to sessions" });
      }
      if (node.description === "Close session actions") {
        return Object.freeze({ ...node, enabled: false as const });
      }
      return node;
    });
    expect(
      selectPhysicalResultAction(
        archiveResult,
        ["Session archived"],
        "Back to sessions"
      )
    ).not.toBeNull();
    expect(
      selectPhysicalResultAction(
        archiveResult.filter((node) => node.text !== "Session archived"),
        ["Session archived"],
        "Back to sessions"
      )
    ).toBeNull();
    expect(
      selectPhysicalResultAction(
        [
          ...result,
          Object.freeze({
            ...resultHeader,
            text: "Archive session?"
          })
        ],
        ["Turn interrupted"],
        "Done"
      )
    ).toBeNull();
    expect(
      selectPhysicalResultAction(result, ["Turn interrupted"], "Back to sessions")
    ).toBeNull();
  });

  it("binds each destructive confirmation to its exact UI owner", () => {
    const modal = parseAndroidUiNodes(
      '<hierarchy><node text="" class="android.view.ViewGroup" ' +
        `resource-id="${chromeToolbarResourceId}" bounds="[0,80][1080,240]" />` +
        '<node text="" class="android.widget.FrameLayout" ' +
        `resource-id="${chromeCompositorResourceId}" bounds="[0,80][1080,2400]" />` +
        '<node text="Revoke paired device?" class="android.view.View" ' +
        'bounds="[80,400][700,500]" />' +
        '<node text="" class="android.widget.Button" ' +
        'content-desc="Close device revocation" clickable="true" enabled="true" ' +
        'bounds="[916,380][1040,504]" />' +
        '<node text="Cancel" class="android.widget.Button" clickable="true" ' +
        'enabled="true" bounds="[80,1800][540,1930]" />' +
        '<node text="Revoke device" class="android.widget.Button" clickable="true" ' +
        'enabled="true" bounds="[500,1800][1000,1930]" />' +
        '</hierarchy>'
    );
    const modalClose = modal.find(
      (node) => node.description === "Close device revocation"
    );
    requireCondition(modalClose !== undefined, "Modal owner fixture close was absent.");
    expect(
      selectPhysicalConfirmationFooterAction(
        modal,
        "Revoke paired device?",
        "Revoke device"
      )
    ).not.toBeNull();
    expect(
      selectPhysicalConfirmationFooterAction(
        modal.map((node) =>
          node.description === "Close device revocation"
            ? Object.freeze({ ...node, description: "Close session actions" })
            : node
        ),
        "Revoke paired device?",
        "Revoke device"
      )
    ).toBeNull();
    expect(
      selectPhysicalConfirmationFooterAction(
        [
          ...modal,
          Object.freeze({
            ...modalClose,
            description: "Back to session actions"
          })
        ],
        "Revoke paired device?",
        "Revoke device"
      )
    ).toBeNull();

    const compact = parseAndroidUiNodes(
      '<hierarchy><node text="" class="android.view.ViewGroup" ' +
        `resource-id="${chromeToolbarResourceId}" bounds="[0,80][1080,240]" />` +
        '<node text="" class="android.widget.FrameLayout" ' +
        `resource-id="${chromeCompositorResourceId}" bounds="[0,80][1080,2400]" />` +
        '<node text="" class="android.widget.Button" ' +
        'content-desc="Back to session utilities" clickable="true" enabled="true" ' +
        'bounds="[40,360][164,484]" />' +
        '<node text="/compact" class="android.view.View" ' +
        'bounds="[190,370][720,450]" />' +
        '<node text="" class="android.widget.Button" ' +
        'content-desc="Close Compact utility" clickable="true" enabled="true" ' +
        'bounds="[916,360][1040,484]" />' +
        '<node text="Confirm context compaction" class="android.view.View" ' +
        'bounds="[80,800][800,900]" />' +
        '<node text="Cancel" class="android.widget.Button" clickable="true" ' +
        'enabled="true" bounds="[80,1800][540,1930]" />' +
        '<node text="Confirm compact" class="android.widget.Button" clickable="true" ' +
        'enabled="true" bounds="[500,1800][1000,1930]" />' +
        '</hierarchy>'
    );
    const compactBack = compact.find(
      (node) => node.description === "Back to session utilities"
    );
    requireCondition(compactBack !== undefined, "Compact owner fixture back was absent.");
    expect(
      selectPhysicalConfirmationFooterAction(
        compact,
        "Confirm context compaction",
        "Confirm compact"
      )
    ).not.toBeNull();
    expect(
      selectPhysicalConfirmationFooterAction(
        compact.filter((node) => node.description !== "Back to session utilities"),
        "Confirm context compaction",
        "Confirm compact"
      )
    ).toBeNull();
    expect(
      selectPhysicalConfirmationFooterAction(
        [
          ...compact,
          Object.freeze({
            ...compactBack,
            bounds: Object.freeze({ bottom: 504, left: 916, right: 1040, top: 380 }),
            description: "Close session actions",
          })
        ],
        "Confirm context compaction",
        "Confirm compact"
      )
    ).toBeNull();
  });

  it("admits Session Actions only through the complete current phone shell", () => {
    const nodes = physicalSessionActionsFixtureNodes();
    const trigger = nodes.find(
      (node) => node.description === physicalSessionActionsTriggerDescription
    );
    requireCondition(trigger !== undefined, "Session Actions fixture trigger was absent.");

    expect(selectPhysicalSessionActionsTrigger(nodes, 1)).toBe(trigger);
    expect(physicalSessionActionsStateSummary(nodes, 1, trigger)).toContain(
      "admitted=yes"
    );
    expect(physicalSessionActionsStateSummary(nodes, 1)).not.toContain(
      physicalSessionActionsTriggerDescription
    );

    const rejects = (candidateNodes: readonly AndroidUiNode[], active = 1) => {
      expect(selectPhysicalSessionActionsTrigger(candidateNodes, active)).toBeNull();
    };

    rejects(nodes.filter((node) => node !== trigger));
    rejects([...nodes, Object.freeze({ ...trigger })]);
    rejects(
      nodes.map((node) =>
        node === trigger ? Object.freeze({ ...node, clickable: false }) : node
      )
    );
    rejects(
      nodes.map((node) =>
        node === trigger ? Object.freeze({ ...node, enabled: false as const }) : node
      )
    );
    rejects(
      nodes.map((node) =>
        node === trigger
          ? Object.freeze({
              ...node,
              bounds: Object.freeze({ ...node.bounds, bottom: 2_401 })
            })
          : node
      )
    );
    rejects(
      nodes.map((node) =>
        node.resourceId === chromeCompositorResourceId
          ? Object.freeze({
              ...node,
              bounds: Object.freeze({ ...node.bounds, bottom: node.bounds.top })
            })
          : node
      )
    );
    rejects(nodes.filter((node) => node.description !== "Back to Mission Control"));
    rejects([
      ...nodes,
      Object.freeze({
        ...nodes.find((node) => node.description === "Back to Mission Control"),
        description: "Back to Mission Control"
      }) as AndroidUiNode
    ]);
    for (const description of physicalSessionControlDescriptions) {
      rejects(nodes.filter((node) => node.description !== description));
      rejects([
        ...nodes,
        Object.freeze({
          ...nodes.find((node) => node.description === description),
          description
        }) as AndroidUiNode
      ]);
    }
    for (const marker of physicalSessionActionsOverlayMarkers) {
      const timelineCopy = [
        ...nodes,
        Object.freeze({
          ...trigger,
          className: "android.view.View",
          clickable: false,
          description: "",
          text: marker
        })
      ];
      expect(selectPhysicalSessionActionsTrigger(timelineCopy, 1)).toBe(trigger);
      const overlayCopy = Object.freeze({
        ...timelineCopy.at(-1),
        bounds: Object.freeze({ left: 420, top: 560, right: 660, bottom: 680 })
      }) as AndroidUiNode;
      const close = Object.freeze({
        ...trigger,
        bounds: Object.freeze({ left: 820, top: 520, right: 960, bottom: 660 }),
        description: "Close session actions"
      });
      rejects([...nodes, overlayCopy, close]);
    }
    rejects(nodes, 0);
    rejects(nodes, 2);
    const disabledDock = nodes.map((node) =>
      node.description === physicalSessionControlDescriptions[0]
        ? Object.freeze({ ...node, enabled: false as const })
        : node
    );
    rejects(disabledDock);
    const offPageBack = nodes.map((node) =>
      node.description === "Back to Mission Control"
        ? Object.freeze({
            ...node,
            bounds: Object.freeze({ ...node.bounds, bottom: 2_401, top: 2_300 })
          })
        : node
    );
    rejects(offPageBack);
  });

  it("settles dialog closure without requiring unrelated dock visibility", () => {
    const sessionNodes = physicalSessionActionsFixtureNodes();
    const withoutDock = sessionNodes.filter(
      (node) =>
        !physicalSessionControlDescriptions.includes(
          node.description as (typeof physicalSessionControlDescriptions)[number]
        ) && node.description !== physicalSessionActionsTriggerDescription
    );
    expect(
      physicalDialogClosedOnSessionDetail(
        sessionNodes,
        "Close event details"
      )
    ).toBe(true);
    expect(
      physicalDialogClosedOnSessionDetail(
        withoutDock,
        "Close event details"
      )
    ).toBe(true);
    const back = sessionNodes.find(
      (node) => node.description === "Back to Mission Control"
    );
    requireCondition(back !== undefined, "Dialog-close fixture back action was absent.");
    expect(
      physicalDialogClosedOnSessionDetail(
        [
          ...withoutDock.filter((node) => node !== back),
          Object.freeze({ ...back, clickable: false })
        ],
        "Close event details"
      )
    ).toBe(false);
    for (const retained of [
      Object.freeze({ ...back, description: "Close event details" }),
      Object.freeze({ ...back, description: "Close model control" }),
      Object.freeze({ ...back, description: "Back to session actions" })
    ]) {
      expect(
        physicalDialogClosedOnSessionDetail(
          [...withoutDock, retained],
          "Close event details"
        )
      ).toBe(false);
    }
  });

  it("waits for a stable Session Actions boundary without rebasing authority", async () => {
    const nodes = physicalSessionActionsFixtureNodes();
    const finalNodes = nodes.map((node) =>
      node.description === physicalSessionActionsTriggerDescription
        ? Object.freeze({
            ...node,
            bounds: Object.freeze({ ...node.bounds, bottom: 900, top: 760 })
          })
        : node
    );
    const finalTrigger = finalNodes.find(
      (node) => node.description === physicalSessionActionsTriggerDescription
    );
    requireCondition(finalTrigger !== undefined, "Final Session Actions trigger was absent.");
    const navigation: PhysicalSessionNavigationSnapshot = Object.freeze({
      activeSubscribers: 1,
      missingDetailRequests: 1,
      openedSubscribers: 4,
      selectedDetailRequests: 3,
      streamRequests: 4
    });
    let now = 0;
    let currentNavigation = navigation;
    let readIndex = 0;
    const reads: readonly (readonly AndroidUiNode[] | "error")[] = [
      nodes.filter(
        (node) => node.description !== physicalSessionActionsTriggerDescription
      ),
      nodes,
      "error",
      ...Array.from({ length: 11 }, () => finalNodes)
    ];
    const source: PhysicalSessionActionsWaitSource = {
      readNavigation: () => currentNavigation,
      readNodes: async () => {
        const next = reads[Math.min(readIndex, reads.length - 1)];
        readIndex += 1;
        currentNavigation = navigation;
        if (next === "error") {
          throw new Error("private hierarchy payload");
        }
        requireCondition(next !== undefined, "Session Actions test read was absent.");
        return next;
      }
    };

    const admitted = await waitForPhysicalSessionActions(
      source,
      5_000,
      "Session Actions stability was not reached.",
      {
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        }
      }
    );
    expect(admitted).toBe(finalTrigger);
    expect(now).toBe(2_600);
    expect(readIndex).toBe(14);

    let driftReads = 0;
    let driftNavigation = navigation;
    const driftSource: PhysicalSessionActionsWaitSource = {
      readNavigation: () => driftNavigation,
      readNodes: async () => {
        driftReads += 1;
        if (driftReads === 2) {
          driftNavigation = Object.freeze({
            ...navigation,
            streamRequests: navigation.streamRequests + 1
          });
        }
        return nodes;
      }
    };
    now = 0;
    await expect(
      waitForPhysicalSessionActions(
        driftSource,
        5_000,
        "Session Actions drift was not rejected.",
        { now: () => now, sleep: async (milliseconds) => { now += milliseconds; } }
      )
    ).rejects.toThrow("navigation-drift");

    now = 0;
    let caught: unknown = null;
    try {
      await waitForPhysicalSessionActions(
        {
          readNavigation: () => navigation,
          readNodes: async () => {
            throw new Error("private hierarchy payload");
          }
        },
        800,
        "Session Actions read errors were not bounded.",
        { now: () => now, sleep: async (milliseconds) => { now += milliseconds; } }
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const diagnostic = (caught as Error).message;
    expect(diagnostic).toContain("read-error");
    expect(diagnostic).toContain("states=");
    expect(diagnostic).toContain("active=1");
    expect(diagnostic).not.toContain("private hierarchy payload");
    expect(diagnostic.length).toBeLessThan(4_096);
  });

  it("gives the post-Done Session Actions handoff a fresh stability budget", async () => {
    const nodes = physicalSessionActionsFixtureNodes();
    const navigation: PhysicalSessionNavigationSnapshot = Object.freeze({
      activeSubscribers: 1,
      missingDetailRequests: 0,
      openedSubscribers: 1,
      selectedDetailRequests: 1,
      streamRequests: 1
    });
    let now = 0;
    const source: PhysicalSessionActionsWaitSource = {
      readNavigation: () => navigation,
      readNodes: async () => nodes
    };
    const admission = createPhysicalSessionActionsAdmissionWindow(
      source,
      2_500,
      {
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        }
      }
    );

    await expect(admission.wait("Initial Session Actions admission failed.")).resolves.toBe(
      nodes.find(
        (node) => node.description === physicalSessionActionsTriggerDescription
      )
    );
    const afterInterrupt = now;
    now += 10_000;
    await expect(
      admission.wait("Post-Done Session Actions handoff failed.")
    ).resolves.toBe(
      nodes.find(
        (node) => node.description === physicalSessionActionsTriggerDescription
      )
    );
    expect(now - afterInterrupt).toBeGreaterThanOrEqual(2_000);
  });

  it("requires one exact Mission Control request generation", () => {
    const before: PhysicalMissionControlRequestSnapshot = Object.freeze({
      accessRequests: 4,
      hostStatusRequests: 5,
      sessionListRequests: 6
    });
    expect(
      physicalMissionControlRequestOpened(
        Object.freeze({
          accessRequests: 5,
          hostStatusRequests: 6,
          sessionListRequests: 7
        }),
        before
      )
    ).toBe(true);
    for (const current of [
      before,
      Object.freeze({ ...before, accessRequests: before.accessRequests + 1 }),
      Object.freeze({
        ...before,
        accessRequests: before.accessRequests + 2,
        hostStatusRequests: before.hostStatusRequests + 2,
        sessionListRequests: before.sessionListRequests + 2
      }),
    ]) {
      expect(physicalMissionControlRequestOpened(current, before)).toBe(false);
    }
  });

  it("settles fragment-free Mission reload only on a complete stable shell", async () => {
    const nodes = parseAndroidUiNodes(
      '<hierarchy><node text="" class="android.view.ViewGroup" ' +
        `resource-id="${chromeToolbarResourceId}" bounds="[0,80][1080,240]" />` +
        '<node text="" class="android.widget.FrameLayout" ' +
        `resource-id="${chromeCompositorResourceId}" bounds="[0,80][1080,2400]" />` +
        '<node text="Mission Control" bounds="[24,300][460,380]" />' +
        '<node text="Remote ready" bounds="[24,460][420,540]" />' +
        '<node text="Write" bounds="[24,580][300,660]" />' +
        `<node text="" class="android.widget.Button" content-desc="${physicalUiSessionName}" ` +
        'clickable="true" enabled="true" bounds="[24,900][900,1060]" />' +
        '<node text="" class="android.widget.Button" content-desc="Open Host and access" ' +
        'clickable="true" enabled="true" bounds="[24,700][520,840]" />' +
        '<node text="" class="android.widget.Button" content-desc="Refresh sessions" ' +
        'clickable="true" enabled="true" bounds="[820,300][1040,420]" />' +
        '<node text="" class="android.widget.Button" content-desc="Expand quiet sessions (1)" ' +
        'clickable="true" enabled="true" bounds="[540,300][800,420]" />' +
        '</hierarchy>'
    );
    const before = Object.freeze({
      accessRequests: 4,
      hostStatusRequests: 5,
      sessionListRequests: 6
    });
    const opened = Object.freeze({
      accessRequests: 5,
      hostStatusRequests: 6,
      sessionListRequests: 7
    });
    let now = 0;
    let reads = 0;
    await expect(
      waitForPhysicalMissionControlReloadSettlement(
        {
          readNodes: async () => {
            reads += 1;
            if (reads === 2) throw new Error("transient hierarchy read");
            return nodes;
          },
          readRequests: () => opened
        },
        before,
        5_000,
        "Complete Mission reload did not settle.",
        { now: () => now, sleep: async (milliseconds) => { now += milliseconds; } }
      )
    ).resolves.toBeUndefined();
    expect(reads).toBeGreaterThan(2);
    expect(now).toBeGreaterThanOrEqual(2_000);

    const rejected = async (
      current: PhysicalMissionControlRequestSnapshot,
      baseline: PhysicalMissionControlRequestSnapshot = before
    ): Promise<void> => {
      let rejectedNow = 0;
      await expect(
        waitForPhysicalMissionControlReloadSettlement(
          {
            readNodes: async () => nodes,
            readRequests: () => current
          },
          baseline,
          600,
          "Hostile Mission reload was accepted.",
          { now: () => rejectedNow, sleep: async (milliseconds) => { rejectedNow += milliseconds; } }
        )
      ).rejects.toThrow("Hostile Mission reload was accepted.");
    };
    await rejected(before);
    await rejected(Object.freeze({ ...before, accessRequests: before.accessRequests + 2 }));
    await rejected(Object.freeze({ ...before, accessRequests: before.accessRequests + 1 }));
    await rejected(opened, opened);
    await rejected(Object.freeze({ ...opened, sessionListRequests: opened.sessionListRequests + 1 }));
    await rejected(Object.freeze({ ...opened, hostStatusRequests: opened.hostStatusRequests + 1 }));
  });

  it("rejects stale and non-exact profile refresh settlements", async () => {
    const requestInspection = {
      accessRequests: 5,
      accessResponseStatuses: [],
      claimRequests: 2,
      claimResponseStatuses: [],
      csrfRequests: 0,
      csrfResponseStatuses: [],
      deletionCookieObserved: false,
      fragmentLeaks: 0,
      hardenedCookieObserved: false,
      hostStatusRequests: 6,
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
      remoteBrowserStatusRequests: 3,
      remoteDisableRequests: 1,
      remoteEnableRequests: 1,
      remoteStatusRequests: 4,
      rejectedRevokedCheckpoints: 0,
      revokedCheckpointRequests: 0,
      revokeRequests: 0,
      sessionDetailRequests: 0,
      sessionEventRequests: 0,
      sessionListRequests: 7,
      sessionListResponseStatuses: [],
      sessionMissingDetailRequests: 0,
      skillsRequests: 0,
      skillsResponseStatuses: [],
      sessionStreamRequests: 0,
      sessionStreamResponseStatuses: []
    } satisfies RequestInspection;
    const aggregateCounters = readPhysicalAggregateCounterSnapshot(
      requestInspection
    );
    expect(Object.isFrozen(aggregateCounters)).toBe(true);
    expect(Object.keys(aggregateCounters)).toHaveLength(
      Object.keys(requestInspection).length
    );
    expect(aggregateCounters.plan_read_requests).toBe(0);
    expect(aggregateCounters.remote_status_requests).toBe(4);
    const returnNodes = parseAndroidUiNodes(
      '<hierarchy><node text="" class="android.view.ViewGroup" ' +
        `resource-id="${chromeToolbarResourceId}" bounds="[0,80][1080,240]" />` +
        '<node text="" class="android.widget.FrameLayout" ' +
        `resource-id="${chromeCompositorResourceId}" bounds="[0,80][1080,2400]" />` +
        '<node text="Mission Control" class="android.view.View" ' +
        'bounds="[24,280][460,360]" />' +
        '<node text="Remote ready" class="android.view.View" ' +
        'bounds="[24,420][420,500]" />' +
        '<node text="Write" class="android.view.View" ' +
        'bounds="[24,520][300,600]" />' +
        '<node text="" class="android.widget.Button" content-desc="Open Host and access" ' +
        'clickable="true" enabled="true" bounds="[320,520][620,640]" />' +
        '<node text="" class="android.widget.Button" content-desc="Refresh sessions" ' +
        'clickable="true" enabled="true" bounds="[820,280][1040,400]" />' +
        '<node text="" class="android.widget.Button" content-desc="Expand quiet sessions (1)" ' +
        'clickable="true" enabled="true" bounds="[540,280][800,400]" />' +
        '</hierarchy>'
    );
    const awayNodes = [
      ...returnNodes.filter(
        (node) => node.text !== "Remote ready" && node.text !== "Write"
      ),
      Object.freeze({
        bounds: Object.freeze({ bottom: 500, left: 24, right: 620, top: 420 }),
        className: "android.view.View",
        clickable: false,
        description: "",
        resourceId: "",
        text: "HostDeck is unreachable"
      })
    ];
    let admission: "closed" | "open" = "closed";
    let activeControlOperations = 0;
    const foreignServe = Object.freeze({ bytes: 128, sha256: "serve-baseline" });
    let currentForeignServe: ServeStatusFingerprint = foreignServe;
    let managerAttempts = 3;
    const remote = {
      readAdmission: () => ({ admission }),
      snapshot: () => ({ active_control_operations: activeControlOperations })
    } as HostDeckRemoteIngressLifecycle;
    const input = {
      remote,
      requestInspection,
      readForeignServe: async () => currentForeignServe,
      readManagerAttempts: () => managerAttempts
    };

    const awayBefore = readPhysicalProfileAwaySnapshot({
      foreignServe,
      managerAttempts,
      requestInspection
    });
    expect(Object.isFrozen(awayBefore)).toBe(true);
    expect(Object.isFrozen(awayBefore.foreignServe)).toBe(true);
    expect(Object.isFrozen(awayBefore.mission)).toBe(true);
    requestInspection.remoteStatusRequests += 1;
    const awaySwitchAfter = readPhysicalProfileAwaySnapshot({
      foreignServe,
      managerAttempts,
      requestInspection
    });
    expect(
      physicalProfileAwaySwitchBoundaryIsExact(awayBefore, awaySwitchAfter)
    ).toBe(true);
    requestInspection.remoteBrowserStatusRequests += 1;
    expect(
      physicalProfileAwaySwitchBoundaryIsExact(
        awayBefore,
        readPhysicalProfileAwaySnapshot({
          foreignServe,
          managerAttempts,
          requestInspection
        })
      )
    ).toBe(false);
    requestInspection.remoteBrowserStatusRequests -= 1;
    requestInspection.remoteStatusRequests -= 1;
    expect(await physicalProfileAwayTruthMatches(input, awayBefore, awayNodes)).toBe(true);
    admission = "open";
    expect(await physicalProfileAwayTruthMatches(input, awayBefore, awayNodes)).toBe(false);
    admission = "closed";
    requestInspection.accessRequests += 1;
    expect(await physicalProfileAwayTruthMatches(input, awayBefore, awayNodes)).toBe(false);
    requestInspection.accessRequests -= 1;
    expect(await physicalProfileAwayTruthMatches(input, awayBefore, returnNodes)).toBe(false);
    currentForeignServe = Object.freeze({ bytes: 129, sha256: "serve-mutated" });
    expect(await physicalProfileAwayTruthMatches(input, awayBefore, awayNodes)).toBe(false);
    currentForeignServe = foreignServe;
    managerAttempts += 1;
    expect(await physicalProfileAwayTruthMatches(input, awayBefore, awayNodes)).toBe(false);
    managerAttempts -= 1;

    const returnBefore = readPhysicalProfileReturnSnapshot({
      foreignServe,
      managerAttempts,
      requestInspection
    });
    expect(Object.isFrozen(returnBefore)).toBe(true);
    expect(Object.isFrozen(returnBefore.foreignServe)).toBe(true);
    expect(Object.isFrozen(returnBefore.mission)).toBe(true);
    const returnSwitchAfter = readPhysicalProfileReturnSnapshot({
      foreignServe,
      managerAttempts,
      requestInspection
    });
    expect(
      physicalProfileReturnSwitchBoundaryIsExact(returnBefore, returnSwitchAfter)
    ).toBe(true);
    for (const hostileReturnSwitch of [
      Object.freeze({
        ...returnSwitchAfter,
        claimRequests: returnSwitchAfter.claimRequests + 1
      }),
      Object.freeze({
        ...returnSwitchAfter,
        foreignServe: Object.freeze({ bytes: 129, sha256: "serve-mutated" })
      }),
      Object.freeze({
        ...returnSwitchAfter,
        managerAttempts: returnSwitchAfter.managerAttempts + 1
      }),
      Object.freeze({
        ...returnSwitchAfter,
        mission: Object.freeze({
          ...returnSwitchAfter.mission,
          accessRequests: returnSwitchAfter.mission.accessRequests + 1
        })
      }),
      Object.freeze({
        ...returnSwitchAfter,
        remoteStatusRequests: returnSwitchAfter.remoteStatusRequests + 1
      })
    ]) {
      expect(
        physicalProfileReturnSwitchBoundaryIsExact(
          returnBefore,
          hostileReturnSwitch
        )
      ).toBe(false);
    }
    admission = "open";
    const setMissionGeneration = (
      accessDelta: number,
      hostDelta: number,
      sessionDelta: number
    ): void => {
      requestInspection.accessRequests = returnBefore.mission.accessRequests + accessDelta;
      requestInspection.hostStatusRequests =
        returnBefore.mission.hostStatusRequests + hostDelta;
      requestInspection.sessionListRequests =
        returnBefore.mission.sessionListRequests + sessionDelta;
    };
    setMissionGeneration(1, 1, 1);
    expect(await physicalProfileReturnTruthMatches(input, returnBefore, returnNodes)).toBe(true);
    for (const generation of [
      [0, 0, 0],
      [1, 0, 1],
      [2, 2, 2]
    ] as const) {
      setMissionGeneration(generation[0], generation[1], generation[2]);
      expect(
        await physicalProfileReturnTruthMatches(input, returnBefore, returnNodes)
      ).toBe(false);
    }
    setMissionGeneration(1, 1, 1);
    requestInspection.remoteBrowserStatusRequests += 1;
    expect(await physicalProfileReturnTruthMatches(input, returnBefore, returnNodes)).toBe(false);
    requestInspection.remoteBrowserStatusRequests -= 1;
    admission = "closed";
    expect(await physicalProfileReturnTruthMatches(input, returnBefore, returnNodes)).toBe(false);
    admission = "open";
    activeControlOperations = 1;
    expect(await physicalProfileReturnTruthMatches(input, returnBefore, returnNodes)).toBe(false);
    activeControlOperations = 0;
    expect(await physicalProfileReturnTruthMatches(input, returnBefore, awayNodes)).toBe(false);
    currentForeignServe = Object.freeze({ bytes: 129, sha256: "serve-mutated" });
    expect(await physicalProfileReturnTruthMatches(input, returnBefore, returnNodes)).toBe(false);
  });

  it("requires immutable exact mutation deltas", () => {
    const before = Object.freeze({ control: 0, request: 0, audit: 0 });
    expect(
      physicalExactNumericTransition(
        before,
        Object.freeze({ control: 1, request: 1, audit: 2 }),
        { control: 1, request: 1, audit: 2 }
      )
    ).toBe(true);
    expect(
      physicalExactNumericTransition(
        before,
        Object.freeze({ control: 2, request: 1, audit: 2 }),
        { control: 1, request: 1, audit: 2 }
      )
    ).toBe(false);
    expect(
      physicalExactNumericTransition(
        before,
        Object.freeze({ control: 1, request: 1, audit: 2, duplicate: 1 }),
        { control: 1, request: 1, audit: 2 }
      )
    ).toBe(false);
    expect(
      physicalExactNumericTransition(
        before,
        Object.freeze({ control: 1, request: 1, audit: 1 }),
        { control: 1, request: 1, audit: 2 }
      )
    ).toBe(false);
    expect(
      physicalExactNumericTransition(
        before,
        Object.freeze({ control: 1, request: 0, audit: 0 }),
        { control: 0, request: 0, audit: 0 }
      )
    ).toBe(false);
    expect(
      physicalSelfRevokeBaselineIsExact({ revoke_requests: 1, revoked_devices: 1 })
    ).toBe(true);
    expect(
      physicalSelfRevokeBaselineIsExact({ revoke_requests: 1, revoked_devices: 0 })
    ).toBe(false);
    expect(
      physicalSelfRevokeBaselineIsExact({ revoke_requests: 0, revoked_devices: 1 })
    ).toBe(false);
    expect(
      physicalSelfRevokeBaselineIsExact({
        revoke_requests: 1,
        revoked_devices: 1,
        extra: 1
      } as never)
    ).toBe(false);
  });

  it("requires stable exact reload truth across transient reads and rejects extra generations", async () => {
    const currentNodes = parseAndroidUiNodes(
      '<hierarchy><node text="" class="android.view.ViewGroup" ' +
        `resource-id="${chromeToolbarResourceId}" bounds="[0,0][1080,240]" />` +
        '<node text="" class="android.widget.FrameLayout" ' +
        `resource-id="${chromeCompositorResourceId}" bounds="[0,0][1080,2200]" />` +
        '<node text="Ready to send" bounds="[80,400][600,500]" />' +
        "</hierarchy>"
    );
    const completedNodes = currentNodes.map((node) =>
      node.text === "Ready to send"
        ? Object.freeze({ ...node, text: "Turn completed" })
        : node
    );
    const staleNodes = parseAndroidUiNodes(
      '<hierarchy><node text="" class="android.view.ViewGroup" ' +
        `resource-id="${chromeToolbarResourceId}" bounds="[0,0][1080,240]" />` +
        '<node text="" class="android.widget.FrameLayout" ' +
        `resource-id="${chromeCompositorResourceId}" bounds="[0,0][1080,2200]" />` +
        '<node text="Prompt unavailable" bounds="[80,400][600,500]" />' +
        '<node text="Session state is stale. Refresh before sending." ' +
        'bounds="[80,520][900,620]" />' +
        "</hierarchy>"
    );
    expect(physicalSessionReloadTruthVisible(staleNodes, 1, "stale")).toBe(
      true
    );
    expect(physicalSessionReloadTruthVisible(staleNodes, 1, "current")).toBe(
      false
    );
    expect(
      physicalSessionReloadTruthVisible(completedNodes, 1, "current")
    ).toBe(true);
    expect(physicalSessionWriteReady(completedNodes, 1)).toBe(true);
    expect(
      physicalSessionReloadTruthVisible(
        [...currentNodes, ...completedNodes.filter((node) => node.text === "Turn completed")],
        1,
        "current"
      )
    ).toBe(false);
    expect(
      physicalSessionReloadTruthVisible(
        staleNodes.filter(
          (node) => node.text !== "Session state is stale. Refresh before sending."
        ),
        1,
        "stale"
      )
    ).toBe(false);
    const before: PhysicalSessionNavigationSnapshot = Object.freeze({
      activeSubscribers: 1,
      missingDetailRequests: 0,
      openedSubscribers: 3,
      selectedDetailRequests: 3,
      streamRequests: 3
    });
    const expected: PhysicalSessionNavigationSnapshot = Object.freeze({
      ...before,
      openedSubscribers: before.openedSubscribers + 1,
      selectedDetailRequests: before.selectedDetailRequests + 1,
      streamRequests: before.streamRequests + 1
    });
    let now = 0;
    let readIndex = 0;
    const reads: readonly (readonly AndroidUiNode[] | "error")[] = [
      currentNodes,
      "error",
      ...Array.from({ length: 12 }, () => staleNodes)
    ];
    await expect(
      waitForPhysicalSessionReloadSettlement(
        {
          readNavigation: () => expected,
          readNodes: async () => {
            const next = reads[Math.min(readIndex++, reads.length - 1)];
            if (next === "error") throw new Error("private hierarchy payload");
            requireCondition(next !== undefined, "Reload fixture read was absent.");
            return next;
          }
        },
        before,
        "stale",
        5_000,
        "Stable stale truth was not reached.",
        { now: () => now, sleep: async (milliseconds) => { now += milliseconds; } }
      )
    ).resolves.toBeUndefined();

    let replayNow = 0;
    let replayReads = 0;
    await expect(
      waitForPhysicalSessionReloadSettlement(
        {
          readNavigation: () => expected,
          readNodes: async () => {
            replayReads += 1;
            return replayReads === 1 ? currentNodes : completedNodes;
          }
        },
        before,
        "current",
        5_000,
        "Completed replay truth was not reached.",
        {
          now: () => replayNow,
          sleep: async (milliseconds) => {
            replayNow += milliseconds;
          }
        }
      )
    ).resolves.toBeUndefined();
    expect(replayReads).toBeGreaterThan(2);
    expect(replayNow).toBeGreaterThanOrEqual(2_000);
    expect(readIndex).toBeGreaterThan(2);
    expect(now).toBeGreaterThanOrEqual(2_000);

    let currentNow = 0;
    await expect(
      waitForPhysicalSessionReloadSettlement(
        {
          readNavigation: () => expected,
          readNodes: async () => currentNodes
        },
        before,
        "current",
        5_000,
        "Stable current truth was not reached.",
        { now: () => currentNow, sleep: async (milliseconds) => { currentNow += milliseconds; } }
      )
    ).resolves.toBeUndefined();

    let zeroNow = 0;
    await expect(
      waitForPhysicalSessionReloadSettlement(
        {
          readNavigation: () => before,
          readNodes: async () => currentNodes
        },
        before,
        "current",
        600,
        "Zero-generation reload was accepted.",
        { now: () => zeroNow, sleep: async (milliseconds) => { zeroNow += milliseconds; } }
      )
    ).rejects.toThrow("Zero-generation reload was accepted.");

    let prechangedNow = 0;
    await expect(
      waitForPhysicalSessionReloadSettlement(
        {
          readNavigation: () => expected,
          readNodes: async () => currentNodes
        },
        expected,
        "current",
        600,
        "Prechanged reload baseline was accepted.",
        { now: () => prechangedNow, sleep: async (milliseconds) => { prechangedNow += milliseconds; } }
      )
    ).rejects.toThrow("Prechanged reload baseline was accepted.");

    let activeNow = 0;
    await expect(
      waitForPhysicalSessionReloadSettlement(
        {
          readNavigation: () => Object.freeze({ ...expected, activeSubscribers: 2 }),
          readNodes: async () => currentNodes
        },
        before,
        "current",
        600,
        "Active-subscriber drift was accepted.",
        { now: () => activeNow, sleep: async (milliseconds) => { activeNow += milliseconds; } }
      )
    ).rejects.toThrow("Active-subscriber drift was accepted.");

    let mutationNow = 0;
    await expect(
      waitForPhysicalSessionReloadSettlement(
        {
          readNavigation: () => Object.freeze({ ...expected, missingDetailRequests: 1 }),
          readNodes: async () => currentNodes
        },
        before,
        "current",
        600,
        "Unrelated counter mutation was accepted.",
        { now: () => mutationNow, sleep: async (milliseconds) => { mutationNow += milliseconds; } }
      )
    ).rejects.toThrow("Unrelated counter mutation was accepted.");

    let extraNow = 0;
    const extraNavigation = Object.freeze({
      ...expected,
      openedSubscribers: expected.openedSubscribers + 1,
      selectedDetailRequests: expected.selectedDetailRequests + 1,
      streamRequests: expected.streamRequests + 1
    });
    await expect(
      waitForPhysicalSessionReloadSettlement(
        {
          readNavigation: () => extraNavigation,
          readNodes: async () => staleNodes
        },
        before,
        "stale",
        600,
        "Extra reload generation was accepted.",
        { now: () => extraNow, sleep: async (milliseconds) => { extraNow += milliseconds; } }
      )
    ).rejects.toThrow("Extra reload generation was accepted.");
  });

  it("requires exact stable missing-session product truth", async () => {
    const missingNodes = parseAndroidUiNodes(
      '<hierarchy><node text="" class="android.view.ViewGroup" ' +
        `resource-id="${chromeToolbarResourceId}" bounds="[0,0][1080,240]" />` +
        '<node text="" class="android.widget.FrameLayout" ' +
        `resource-id="${chromeCompositorResourceId}" bounds="[0,0][1080,2200]" />` +
        '<node text="Session unavailable" bounds="[80,260][900,360]" />' +
        '<node text="Session unavailable" bounds="[80,420][900,520]" />' +
        '<node text="This session was not found or is no longer active." ' +
        'bounds="[80,540][980,660]" />' +
        "</hierarchy>"
    );
    expect(physicalSessionMissingTruthVisible(missingNodes)).toBe(true);
    const firstUnavailable = missingNodes.findIndex(
      (node) => node.text === "Session unavailable"
    );
    expect(firstUnavailable).toBeGreaterThanOrEqual(0);
    expect(
      physicalSessionMissingTruthVisible(
        missingNodes.filter((_, index) => index !== firstUnavailable)
      )
    ).toBe(false);
    const body = missingNodes.find(
      (node) => node.text === "This session was not found or is no longer active."
    );
    requireCondition(body !== undefined, "Missing-session body fixture was absent.");
    for (const conflictingText of [
      "Prompt unavailable",
      "Ready to send",
      "Session activity is reconnecting."
    ]) {
      expect(
        physicalSessionMissingTruthVisible([
          ...missingNodes,
          Object.freeze({ ...body, text: conflictingText })
        ])
      ).toBe(false);
    }

    const before: PhysicalSessionNavigationSnapshot = Object.freeze({
      activeSubscribers: 1,
      missingDetailRequests: 0,
      openedSubscribers: 4,
      selectedDetailRequests: 3,
      streamRequests: 4
    });
    const expected = Object.freeze({
      ...before,
      missingDetailRequests: before.missingDetailRequests + 1
    });
    let now = 0;
    let reads = 0;
    await expect(
      waitForPhysicalSessionMissingSettlement(
        {
          readNavigation: () => expected,
          readNodes: async () => {
            reads += 1;
            if (reads === 1) throw new Error("private hierarchy payload");
            return missingNodes;
          }
        },
        expected,
        5_000,
        "Stable missing-session truth was not reached.",
        { now: () => now, sleep: async (milliseconds) => { now += milliseconds; } }
      )
    ).resolves.toBeUndefined();
    expect(reads).toBeGreaterThan(2);
    expect(now).toBeGreaterThanOrEqual(2_000);

    let driftNow = 0;
    await expect(
      waitForPhysicalSessionMissingSettlement(
        {
          readNavigation: () =>
            Object.freeze({
              ...expected,
              openedSubscribers: expected.openedSubscribers + 1
            }),
          readNodes: async () => missingNodes
        },
        expected,
        600,
        "Missing-session authority drift was accepted.",
        {
          now: () => driftNow,
          sleep: async (milliseconds) => {
            driftNow += milliseconds;
          }
        }
      )
    ).rejects.toThrow("Missing-session authority drift was accepted.");
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

  it("classifies every asynchronous ADB outcome without erasing its operation", () => {
    expect(physicalAsyncAdbOperations).toEqual([
      "tailnet_ping",
      "private_https_probe",
      "ui_hierarchy"
    ]);
    expect(Object.isFrozen(physicalAsyncAdbOperations)).toBe(true);

    const pingSuccess = classifyPhysicalAsyncAdbCompletion(
      "tailnet_ping",
      null,
      "1 packets transmitted, 1 received",
      ""
    );
    expect(pingSuccess).toEqual({
      operation: "tailnet_ping",
      status: 0,
      stdout: "1 packets transmitted, 1 received"
    });
    expect(Object.isFrozen(pingSuccess)).toBe(true);
    expect(physicalAsyncAdbTailnetPingPassed(pingSuccess)).toBe(true);

    const pingMiss = classifyPhysicalAsyncAdbCompletion(
      "tailnet_ping",
      Object.freeze({ code: 1, killed: false, signal: null }),
      "1 packets transmitted, 0 received",
      ""
    );
    expect(pingMiss.status).toBe(1);
    expect(physicalAsyncAdbTailnetPingPassed(pingMiss)).toBe(false);

    const httpsMiss = classifyPhysicalAsyncAdbCompletion(
      "private_https_probe",
      Object.freeze({ code: 7, killed: false, signal: null }),
      "",
      "private command detail"
    );
    expect(physicalAsyncAdbPrivateHttpsProbePassed(httpsMiss)).toBe(false);
    expect(
      physicalAsyncAdbPrivateHttpsProbePassed(
        classifyPhysicalAsyncAdbCompletion(
          "private_https_probe",
          null,
          "",
          ""
        )
      )
    ).toBe(true);
    expect(
      physicalAsyncAdbPrivateHttpsProbePassed(
        classifyPhysicalAsyncAdbCompletion(
          "private_https_probe",
          null,
          "unexpected",
          ""
        )
      )
    ).toBe(false);

    const hierarchyMiss = classifyPhysicalAsyncAdbCompletion(
      "ui_hierarchy",
      Object.freeze({ code: 1, killed: false, signal: null }),
      "",
      "private hierarchy detail"
    );
    expect(() => physicalAsyncAdbUiHierarchyOutput(hierarchyMiss)).toThrow(
      "UI hierarchy read exited unsuccessfully"
    );
    expect(
      physicalAsyncAdbUiHierarchyOutput(
        classifyPhysicalAsyncAdbCompletion(
          "ui_hierarchy",
          null,
          '<hierarchy rotation="0"></hierarchy>',
          ""
        )
      )
    ).toBe('<hierarchy rotation="0"></hierarchy>');

    expect(() =>
      classifyPhysicalAsyncAdbCompletion(
        "tailnet_ping",
        Object.freeze({ code: "ENOENT", killed: false, signal: null }),
        "",
        ""
      )
    ).toThrow("tailnet ping could not start");
    expect(() =>
      classifyPhysicalAsyncAdbCompletion(
        "private_https_probe",
        Object.freeze({ code: null, killed: true, signal: "SIGTERM" }),
        "",
        ""
      )
    ).toThrow("private HTTPS probe was terminated");
    expect(() =>
      classifyPhysicalAsyncAdbCompletion(
        "ui_hierarchy",
        Object.freeze({ code: 1, killed: false, signal: null }),
        "",
        "adb: device offline"
      )
    ).toThrow("UI hierarchy read lost device transport");
    expect(() =>
      classifyPhysicalAsyncAdbCompletion(
        "tailnet_ping",
        Object.freeze({ code: 999, killed: false, signal: null }),
        "",
        ""
      )
    ).toThrow("tailnet ping returned an invalid completion");

    const privateValue = "private-async-adb-value";
    deviceForbiddenValues.add(privateValue);
    try {
      let transportMessage = "";
      try {
        classifyPhysicalAsyncAdbCompletion(
          "tailnet_ping",
          Object.freeze({ code: 1, killed: false, signal: null }),
          "",
          `error: device '${privateValue}' not found`
        );
      } catch (error) {
        transportMessage = error instanceof Error ? error.message : String(error);
      }
      expect(transportMessage).toContain("tailnet ping lost device transport");
      expect(transportMessage).not.toContain(privateValue);

      for (const [stdout, stderr] of [
        [privateValue, ""],
        ["", privateValue]
      ] as const) {
        let message = "";
        try {
          classifyPhysicalAsyncAdbCompletion(
            "ui_hierarchy",
            null,
            stdout,
            stderr
          );
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        expect(message).toContain("UI hierarchy read output was invalid or private");
        expect(message).not.toContain(privateValue);
      }
    } finally {
      deviceForbiddenValues.delete(privateValue);
    }
    expect(() =>
      classifyPhysicalAsyncAdbCompletion(
        "ui_hierarchy",
        null,
        "x".repeat(512 * 1024 + 1),
        ""
      )
    ).toThrow("UI hierarchy read output was invalid or private");
  });

  it("classifies bounded Tailscale timeouts without retaining command output", () => {
    expect(
      physicalTailscaleCommandFailureMessage(
        Object.freeze({ code: null, killed: true })
      )
    ).toBe("Physical Tailscale command timed out.");
    expect(
      physicalTailscaleCommandFailureMessage(
        Object.freeze({ code: "ENOENT", killed: false })
      )
    ).toBe("Physical Tailscale command failed.");
    expect(physicalTailscaleCommandFailureMessage(null)).toBe(
      "Physical Tailscale command failed."
    );
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

  it("enforces phone wakefulness before lengthy physical builds", () => {
    const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const enforceAt = source.lastIndexOf("await enforceAndroidAwakeAndUnlocked(");
    const packageBuildAt = source.lastIndexOf(
      "dashboardPackageIdentity = buildPhysicalDashboardPackageIdentity();"
    );
    const environmentAt = source.lastIndexOf(
      "environmentFacts = readPhysicalEnvironmentFacts();"
    );
    const talkBackBuildAt = source.lastIndexOf(
      "talkBackArtifacts = buildPhysicalTalkBackArtifacts(directory);"
    );

    expect(enforceAt).toBeGreaterThan(0);
    expect(environmentAt).toBeGreaterThan(enforceAt);
    expect(packageBuildAt).toBeGreaterThan(enforceAt);
    expect(talkBackBuildAt).toBeGreaterThan(packageBuildAt);
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
    const transientEmptyNodes = parseAndroidUiNodes(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<hierarchy rotation="0">' +
        '<node text="" content-desc="" class="android.view.View" ' +
        'bounds="[0,0][0,0]" />' +
        "</hierarchy>"
    );
    expect(transientEmptyNodes).toEqual([]);
    expect(Object.isFrozen(transientEmptyNodes)).toBe(true);
    expect(() => parseAndroidUiNodes("not an Android hierarchy")).toThrow(
      "Android UI hierarchy was invalid"
    );
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
    const missionWithoutSelectedSession = unlockedMissionNodes.filter(
      (node) => node.description !== physicalUiSessionName
    );
    expect(
      physicalMissionControlWriteReady(missionWithoutSelectedSession, 0)
    ).toBe(false);
    expect(
      physicalMissionControlWriteReady(
        missionWithoutSelectedSession,
        0,
        false
      )
    ).toBe(true);
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
    const recoveryNode = Object.freeze({
      ...confirmationReason,
      text: "Session activity is reconnecting."
    });
    const recoveryUnavailableNode = Object.freeze({
      ...confirmationStatus,
      text: "Prompt unavailable"
    });
    expect(physicalPromptRecoveryHoldingVisible([recoveryNode], 0)).toBe(false);
    expect(
      physicalPromptRecoveryHoldingVisible(
        [recoveryNode, recoveryUnavailableNode],
        0
      )
    ).toBe(true);
    expect(
      physicalPromptRecoveryHoldingVisible(
        [recoveryNode, recoveryUnavailableNode],
        1
      )
    ).toBe(false);
    for (const conflictingText of [
      "Ready to send",
      "Prompt unavailable",
      "Session activity is reconnecting."
    ]) {
      expect(
        physicalPromptRecoveryHoldingVisible(
          [
            recoveryNode,
            recoveryUnavailableNode,
            Object.freeze({ ...confirmationStatus, text: conflictingText })
          ],
          0
        )
      ).toBe(false);
    }
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

  it("reacquires a stable pairing continuation without rebasing request authority", async () => {
    const initialNodes = physicalPairingContinueFixtureNodes();
    const shiftedNodes = physicalPairingContinueFixtureNodes(-120);
    const shiftedAction = shiftedNodes.find(
      (node) => node.text === "Open Mission Control"
    );
    requireCondition(
      shiftedAction !== undefined,
      "Shifted pairing-continuation fixture action was absent."
    );
    const baseline: PhysicalMissionControlRequestSnapshot = Object.freeze({
      accessRequests: 2,
      hostStatusRequests: 1,
      sessionListRequests: 1
    });
    const reads: readonly (readonly AndroidUiNode[] | "error")[] = [
      initialNodes,
      "error",
      initialNodes,
      ...Array.from({ length: 12 }, () => shiftedNodes)
    ];
    let now = 0;
    let readIndex = 0;
    const admitted = await waitForStablePhysicalPairingContinuation(
      Object.freeze({
        readNodes: async () => {
          const next = reads[Math.min(readIndex, reads.length - 1)];
          readIndex += 1;
          if (next === "error") throw new Error("private hierarchy payload");
          requireCondition(
            next !== undefined,
            "Pairing-continuation fixture read was absent."
          );
          return next;
        },
        readRequests: () => baseline
      }),
      baseline,
      5_000,
      "Stable pairing continuation was not admitted.",
      {
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        }
      }
    );
    expect(physicalAggregateNodeMatches(admitted, shiftedAction)).toBe(true);
    expect(now).toBeGreaterThanOrEqual(2_600);
    expect(readIndex).toBe(reads.length - 1);

    let current = baseline;
    now = 0;
    await expect(
      waitForStablePhysicalPairingContinuation(
        Object.freeze({
          readNodes: async () => {
            current = Object.freeze({
              ...baseline,
              accessRequests: baseline.accessRequests + 1
            });
            return initialNodes;
          },
          readRequests: () => current
        }),
        baseline,
        5_000,
        "Pairing request drift was not rejected.",
        {
          now: () => now,
          sleep: async (milliseconds) => {
            now += milliseconds;
          }
        }
      )
    ).rejects.toThrow("request-drift;access=1;host=0;sessions=0");

    now = 0;
    let caught: unknown = null;
    try {
      await waitForStablePhysicalPairingContinuation(
        Object.freeze({
          readNodes: async () => {
            throw new Error("private hierarchy payload");
          },
          readRequests: () => baseline
        }),
        baseline,
        600,
        "Pairing hierarchy failure was not bounded.",
        {
          now: () => now,
          sleep: async (milliseconds) => {
            now += milliseconds;
          }
        }
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("hierarchy-read-error");
    expect((caught as Error).message).not.toContain("private hierarchy payload");
  });

  it("binds physical approval progress to one pending dialog and one terminal row", () => {
    const responding = physicalApprovalRespondingFixtureNodes();
    const respondingOwner = selectPhysicalApprovalRespondingDialogOwner(
      responding
    );
    requireCondition(
      respondingOwner !== null,
      "Physical responding approval fixture was not admitted."
    );
    expect(Object.isFrozen(respondingOwner)).toBe(true);
    expect(respondingOwner).toMatchObject({
      action: expect.objectContaining({ text: physicalApprovalAction }),
      approve: expect.objectContaining({
        description: physicalApprovalConfirmationAction,
        enabled: false
      }),
      cancel: expect.objectContaining({
        enabled: false,
        text: physicalApprovalCancelAction
      }),
      close: expect.objectContaining({
        description: physicalApprovalCloseAction,
        enabled: false
      }),
      reason: expect.objectContaining({
        text: physicalApprovalConfirmationReason
      }),
      risk: expect.objectContaining({ text: physicalApprovalRisk }),
      scope: expect.objectContaining({ text: physicalApprovalScope }),
      status: expect.objectContaining({
        text: physicalApprovalRespondingStatus
      }),
      title: expect.objectContaining({
        text: physicalApprovalConfirmationTitle
      })
    });

    const enableFixtureButton = (node: AndroidUiNode): AndroidUiNode =>
      Object.freeze({
        bounds: node.bounds,
        className: node.className,
        clickable: node.clickable,
        description: node.description,
        resourceId: node.resourceId,
        text: node.text
      });
    const replaceRespondingNode = (
      target: AndroidUiNode,
      replacement: AndroidUiNode
    ): readonly AndroidUiNode[] =>
      responding.map((node) => (node === target ? replacement : node));
    const rejectsResponding = (nodes: readonly AndroidUiNode[]): void => {
      expect(selectPhysicalApprovalRespondingDialogOwner(nodes)).toBeNull();
    };

    rejectsResponding(
      responding.filter((node) => node !== respondingOwner.title)
    );
    rejectsResponding([
      ...responding,
      Object.freeze({ ...respondingOwner.title })
    ]);
    rejectsResponding(
      responding.filter((node) => node !== respondingOwner.status)
    );
    rejectsResponding([
      ...responding,
      Object.freeze({ ...respondingOwner.status })
    ]);
    rejectsResponding(
      replaceRespondingNode(
        respondingOwner.status,
        Object.freeze({
          ...respondingOwner.status,
          bounds: Object.freeze({ bottom: 330, left: 40, right: 800, top: 260 })
        })
      )
    );
    for (const control of [
      respondingOwner.approve,
      respondingOwner.cancel,
      respondingOwner.close
    ]) {
      rejectsResponding(
        replaceRespondingNode(control, enableFixtureButton(control))
      );
    }
    rejectsResponding(
      responding.filter((node) => node !== respondingOwner.risk)
    );
    rejectsResponding(
      responding.filter(
        (node) =>
          !matchesAndroidUiNode(
            node,
            "semantic",
            physicalApprovalConfirmationReason
          )
      )
    );
    rejectsResponding([
      ...responding,
      Object.freeze({ ...respondingOwner.action })
    ]);
    rejectsResponding([
      ...responding,
      Object.freeze({ ...respondingOwner.approve })
    ]);
    rejectsResponding(
      replaceRespondingNode(
        respondingOwner.approve,
        Object.freeze({
          ...respondingOwner.approve,
          bounds: Object.freeze({
            ...respondingOwner.approve.bounds,
            bottom: 2_401
          })
        })
      )
    );
    rejectsResponding(
      replaceRespondingNode(
        respondingOwner.approve,
        Object.freeze({
          ...respondingOwner.approve,
          bounds: Object.freeze({ bottom: 1_240, left: 540, right: 1_040, top: 1_100 })
        })
      )
    );
    rejectsResponding([
      ...responding,
      Object.freeze({
        ...respondingOwner.status,
        text: physicalApprovalTerminalStatus
      })
    ]);
    rejectsResponding(
      replaceRespondingNode(
        respondingOwner.status,
        Object.freeze({
          ...respondingOwner.status,
          text: physicalApprovalConfirmationStatus
        })
      )
    );

    const navigation: PhysicalSessionNavigationSnapshot = Object.freeze({
      activeSubscribers: 1,
      missingDetailRequests: 1,
      openedSubscribers: 4,
      selectedDetailRequests: 3,
      streamRequests: 4
    });
    const respondingCheckpoint: PhysicalApprovalCheckpointInput =
      Object.freeze({
        actualNavigation: navigation,
        approvalCalls: 1,
        approvalCallsBefore: 0,
        expectedNavigation: navigation,
        nodes: responding,
        pending: true
      });
    expect(
      physicalApprovalRespondingCheckpointMatches(respondingCheckpoint)
    ).toBe(true);
    for (const checkpoint of [
      Object.freeze({ ...respondingCheckpoint, approvalCalls: 0 }),
      Object.freeze({ ...respondingCheckpoint, approvalCalls: 2 }),
      Object.freeze({ ...respondingCheckpoint, pending: false }),
      Object.freeze({
        ...respondingCheckpoint,
        actualNavigation: Object.freeze({
          ...navigation,
          streamRequests: navigation.streamRequests + 1
        })
      })
    ]) {
      expect(physicalApprovalRespondingCheckpointMatches(checkpoint)).toBe(
        false
      );
    }

    const terminal = physicalApprovalTerminalFixtureNodes();
    const terminalOwner = selectPhysicalApprovalTerminalOwner(terminal);
    requireCondition(
      terminalOwner !== null,
      "Physical terminal approval fixture was not admitted."
    );
    expect(Object.isFrozen(terminalOwner)).toBe(true);
    expect(terminalOwner).toMatchObject({
      action: expect.objectContaining({ text: physicalApprovalAction }),
      detail: expect.objectContaining({ text: physicalApprovalTerminalDetail }),
      scope: expect.objectContaining({ text: physicalApprovalScope }),
      status: expect.objectContaining({ text: physicalApprovalTerminalStatus })
    });
    const rejectsTerminal = (nodes: readonly AndroidUiNode[]): void => {
      expect(selectPhysicalApprovalTerminalOwner(nodes)).toBeNull();
    };
    rejectsTerminal([
      ...terminal,
      Object.freeze({
        ...terminalOwner.status,
        text: physicalApprovalConfirmationTitle
      })
    ]);
    rejectsTerminal([
      ...terminal,
      Object.freeze({ ...terminalOwner.status })
    ]);
    rejectsTerminal(terminal.filter((node) => node !== terminalOwner.detail));
    rejectsTerminal(
      terminal.map((node) =>
        node === terminalOwner.detail
          ? Object.freeze({ ...node, text: "Approval terminal detail drifted." })
          : node
      )
    );
    rejectsTerminal(
      terminal.map((node) =>
        node === terminalOwner.status
          ? Object.freeze({
              ...node,
              bounds: Object.freeze({ bottom: 340, left: 72, right: 500, top: 260 })
            })
          : node
      )
    );
    rejectsTerminal(
      terminal.map((node) =>
        node === terminalOwner.detail
          ? Object.freeze({
              ...node,
              bounds: Object.freeze({ bottom: 1_020, left: 72, right: 900, top: 940 })
            })
          : node
      )
    );
    const terminalCheckpoint: PhysicalApprovalCheckpointInput = Object.freeze({
      ...respondingCheckpoint,
      nodes: terminal,
      pending: false
    });
    expect(physicalApprovalTerminalCheckpointMatches(terminalCheckpoint)).toBe(
      true
    );
    for (const checkpoint of [
      Object.freeze({ ...terminalCheckpoint, approvalCalls: 0 }),
      Object.freeze({ ...terminalCheckpoint, approvalCalls: 2 }),
      Object.freeze({ ...terminalCheckpoint, pending: true }),
      Object.freeze({
        ...terminalCheckpoint,
        actualNavigation: Object.freeze({
          ...navigation,
          selectedDetailRequests: navigation.selectedDetailRequests + 1
        })
      })
    ]) {
      expect(physicalApprovalTerminalCheckpointMatches(checkpoint)).toBe(false);
    }

    const privateDistractor = Object.freeze({
      ...respondingOwner.status,
      text: "private hierarchy payload"
    });
    const diagnostic = physicalApprovalCheckpointSummary(
      Object.freeze({
        ...respondingCheckpoint,
        nodes: Object.freeze([...responding, privateDistractor])
      }),
      true
    );
    expect(diagnostic).toContain("owner=yes");
    expect(diagnostic).toContain("pending=yes");
    expect(diagnostic).not.toContain("private hierarchy payload");
    expect(Buffer.byteLength(diagnostic, "utf8")).toBeLessThan(4_096);
    const observations: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      retainPhysicalApprovalObservation(observations, `state-${index}`);
    }
    expect(observations).toEqual([
      "state-2",
      "state-3",
      "state-4",
      "state-5",
      "state-6",
      "state-7"
    ]);
  });

  it("selects only the destructive action owned by the Host-lock dialog", () => {
    const nodes = parseAndroidUiNodes(
      '<hierarchy rotation="0">' +
        '<node text="Lock writes" content-desc="" class="android.widget.Button" ' +
        'clickable="true" enabled="true" bounds="[40,300][680,380]" />' +
        '<node text="Lock remote writes?" content-desc="" class="android.widget.TextView" ' +
        'bounds="[40,700][600,760]" />' +
        '<node text="" content-desc="Close remote write lock confirmation" ' +
        'class="android.widget.Button" clickable="true" enabled="true" ' +
        'bounds="[620,680][700,780]" />' +
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
    const close = nodes.find(
      (node) => node.description === "Close remote write lock confirmation"
    );
    const cancel = nodes.find((node) => node.text === "Cancel");
    const actions = nodes.filter((node) => node.text === "Lock writes");
    const originAction = actions[0];
    const confirmAction = actions[1];
    requireCondition(
      title !== undefined &&
        close !== undefined &&
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
        nodes.filter((node) => node !== close)
      )
    ).toBeNull();
    expect(
      selectPhysicalHostLockConfirmationAction([
        ...nodes,
        Object.freeze({ ...close })
      ])
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
        'bounds="[190,700][560,760]" />' +
        '<node text="" content-desc="Back to session actions" ' +
        'class="android.widget.Button" clickable="true" enabled="true" ' +
        'bounds="[40,680][160,780]" />' +
        '<node text="" content-desc="Close session actions" ' +
        'class="android.widget.Button" clickable="true" enabled="true" ' +
        'bounds="[620,680][700,780]" />' +
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
    const back = nodes.find(
      (node) => node.description === "Back to session actions"
    );
    const close = nodes.find(
      (node) => node.description === "Close session actions"
    );
    const cancel = nodes.find((node) => node.text === "Cancel");
    const actions = nodes.filter((node) => node.text === "Archive session");
    const originAction = actions[0];
    const confirmAction = actions[1];
    requireCondition(
      title !== undefined &&
        back !== undefined &&
        close !== undefined &&
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
        nodes.filter((node) => node !== back)
      )
    ).toBeNull();
    expect(
      selectPhysicalArchiveConfirmationAction(
        nodes.filter((node) => node !== close)
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
        '<node text="/skills" content-desc="" class="android.view.View" ' +
        'bounds="[191,560][683,630]" />' +
        '<node text="" content-desc="Back to session utilities" ' +
        'class="android.widget.Button" clickable="true" enabled="true" ' +
        'bounds="[20,520][160,640]" />' +
        '<node text="" content-desc="Close Skills utility" ' +
        'class="android.widget.Button" clickable="true" enabled="true" ' +
        'bounds="[920,520][1040,640]" />' +
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
    const controls = Object.freeze({
      snapshot: () => Object.freeze({ calls: Object.freeze({ read_skills: 0 }) })
    }) as unknown as PhysicalDashboardControls;
    const diagnostic = physicalSkillsUiStateSummary(nodes, controls, {
      proxyRejection: "remote_generation_stale",
      requests: 1,
      responseStatuses: Object.freeze([403])
    });
    expect(diagnostic).toContain(
      "reads=0;route_requests=1;route_statuses=403;" +
        "proxy_rejection=remote_generation_stale"
    );
    expect(diagnostic).not.toContain("private.example.ts.net");
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
    const pollingSelection =
      selectPrivateFreeProductionScreenshotEvidenceForPolling(
        nodes,
        "https://private.example.ts.net"
      );
    expect(pollingSelection).toEqual({
      redactions: [],
      region: { height: 992, left: 0, top: 288, width: 720 }
    });
    requireCondition(
      pollingSelection !== null,
      "Chrome screenshot polling fixture was not selected."
    );
    expect(
      privateFreeProductionScreenshotSelectionGeometry(pollingSelection)
    ).toBe("0,288,720,992");
    expect(
      selectPrivateFreeProductionScreenshotEvidenceForPolling(
        [],
        "https://private.example.ts.net"
      )
    ).toBeNull();
    expect(
      selectPrivateFreeProductionScreenshotEvidenceForPolling(
        nodes.filter((node) => node.text !== "Mission Control"),
        "https://private.example.ts.net"
      )
    ).toBeNull();
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
      selectPrivateFreeProductionScreenshotEvidenceForPolling(
        [...nodes, compositor],
        "https://private.example.ts.net"
      )
    ).toThrow("could not isolate the Chrome compositor");
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

  it("reconciles transient Serve cleanup with at most one actual mutation", async () => {
    const exact = physicalServeCleanupFixture("exact");
    const absent = physicalServeCleanupFixture("absent");
    const transient = physicalServeCleanupFixture("transient");
    const observations: Array<RemoteIngressObservationSnapshot | Error> = [
      new Error("private transient observer cause"),
      transient,
      exact,
      exact,
      absent
    ];
    let observationIndex = 0;
    let disableCalls = 0;
    let sleeps = 0;

    await reconcilePhysicalServeCleanup(
      {
        async disable() {
          disableCalls += 1;
          return { after: null, commandAttempted: true };
        },
        async observe() {
          const observation = observations[observationIndex];
          observationIndex += 1;
          requireCondition(
            observation !== undefined,
            "Physical Serve cleanup test observation was unavailable."
          );
          if (observation instanceof Error) throw observation;
          return observation;
        }
      },
      {
        attempts: 5,
        async sleep() {
          sleeps += 1;
        }
      }
    );

    expect({ disableCalls, observationIndex, sleeps }).toEqual({
      disableCalls: 1,
      observationIndex: 5,
      sleeps: 4
    });
  });

  it("retries only preflight-safe cleanup calls and rejects hostile Serve truth", async () => {
    const exact = physicalServeCleanupFixture("exact");
    const absent = physicalServeCleanupFixture("absent");
    let absentDisableCalls = 0;
    await reconcilePhysicalServeCleanup(
      {
        async disable() {
          absentDisableCalls += 1;
          return { after: null, commandAttempted: true };
        },
        async observe() {
          return absent;
        }
      },
      { attempts: 1, sleep: async () => undefined }
    );
    expect(absentDisableCalls).toBe(0);

    let safeDisableCalls = 0;
    await reconcilePhysicalServeCleanup(
      {
        async disable() {
          safeDisableCalls += 1;
          return safeDisableCalls === 1
            ? { after: null, commandAttempted: false }
            : { after: absent, commandAttempted: true };
        },
        async observe() {
          return exact;
        }
      },
      { attempts: 2, sleep: async () => undefined }
    );
    expect(safeDisableCalls).toBe(2);

    let uncertainDisableCalls = 0;
    await expect(
      reconcilePhysicalServeCleanup(
        {
          async disable() {
            uncertainDisableCalls += 1;
            return { after: null, commandAttempted: true };
          },
          async observe() {
            return exact;
          }
        },
        { attempts: 3, sleep: async () => undefined }
      )
    ).rejects.toThrow("after its single mutation");
    expect(uncertainDisableCalls).toBe(1);

    let unsafeAfterDisableCalls = 0;
    await expect(
      reconcilePhysicalServeCleanup(
        {
          async disable() {
            unsafeAfterDisableCalls += 1;
            return {
              after: physicalServeCleanupFixture("foreign"),
              commandAttempted: true
            };
          },
          async observe() {
            return exact;
          }
        },
        { attempts: 2, sleep: async () => undefined }
      )
    ).rejects.toThrow("ownership-safe Serve cleanup");
    expect(unsafeAfterDisableCalls).toBe(1);

    for (const hostile of [
      physicalServeCleanupFixture("foreign"),
      physicalServeCleanupFixture("wrong_profile")
    ]) {
      let hostileDisableCalls = 0;
      await expect(
        reconcilePhysicalServeCleanup(
          {
            async disable() {
              hostileDisableCalls += 1;
              return { after: null, commandAttempted: true };
            },
            async observe() {
              return hostile;
            }
          },
          { attempts: 2, sleep: async () => undefined }
        )
      ).rejects.toThrow("ownership-safe Serve cleanup");
      expect(hostileDisableCalls).toBe(0);
    }
  });

  it("returns Home before force-stopping Chrome during physical cleanup", () => {
    expect(physicalAndroidChromeStopCommandPlan).toEqual([
      ["shell", "input", "keyevent", "KEYCODE_HOME"],
      [
        "shell",
        "am",
        "force-stop",
        "--user",
        "0",
        "com.android.chrome"
      ]
    ]);
    expect(Object.isFrozen(physicalAndroidChromeStopCommandPlan)).toBe(true);
    expect(Object.isFrozen(physicalAndroidChromeStopCommandPlan[0])).toBe(true);
    expect(Object.isFrozen(physicalAndroidChromeStopCommandPlan[1])).toBe(true);
  });

  it("closes the external Chrome tab before a canonical app return", () => {
    expect(physicalAndroidChromeCloseExternalTabCommand).toEqual([
      "shell",
      "input",
      "keyevent",
      "KEYCODE_BACK"
    ]);
    expect(Object.isFrozen(physicalAndroidChromeCloseExternalTabCommand)).toBe(
      true
    );
    expect(physicalMissionControlPath).toBe("/");
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

    const recoveryBefore: PhysicalSessionNavigationSnapshot = Object.freeze({
      ...expected,
      missingDetailRequests: 0
    });
    const recoveryHolding: PhysicalSessionNavigationSnapshot = Object.freeze({
      ...recoveryBefore,
      activeSubscribers: 0,
      streamRequests: recoveryBefore.streamRequests + 1
    });
    const recoveryCompleted: PhysicalSessionNavigationSnapshot = Object.freeze({
      ...recoveryBefore,
      openedSubscribers: recoveryBefore.openedSubscribers + 1,
      streamRequests: recoveryBefore.streamRequests + 1
    });
    expect(
      physicalSessionNavigationRecoveryHolding(recoveryHolding, recoveryBefore)
    ).toBe(true);
    expect(
      physicalSessionNavigationRecoveryCompleted(
        recoveryCompleted,
        recoveryBefore
      )
    ).toBe(true);
    for (const key of Object.keys(recoveryHolding) as Array<
      keyof PhysicalSessionNavigationSnapshot
    >) {
      expect(
        physicalSessionNavigationRecoveryHolding(
          Object.freeze({
            ...recoveryHolding,
            [key]: recoveryHolding[key] + 1
          }),
          recoveryBefore
        )
      ).toBe(false);
      expect(
        physicalSessionNavigationRecoveryCompleted(
          Object.freeze({
            ...recoveryCompleted,
            [key]: recoveryCompleted[key] + 1
          }),
          recoveryBefore
        )
      ).toBe(false);
    }

    const missionBefore: PhysicalMissionControlRequestSnapshot = Object.freeze({
      accessRequests: 3,
      hostStatusRequests: 4,
      sessionListRequests: 5
    });
    const missionOpened: PhysicalMissionControlRequestSnapshot = Object.freeze({
      accessRequests: 4,
      hostStatusRequests: 5,
      sessionListRequests: 6
    });
    expect(
      physicalMissionControlRequestOpened(missionOpened, missionBefore)
    ).toBe(true);
    for (const key of Object.keys(missionOpened) as Array<
      keyof PhysicalMissionControlRequestSnapshot
    >) {
      expect(
        physicalMissionControlRequestOpened(
          Object.freeze({ ...missionOpened, [key]: missionOpened[key] + 1 }),
          missionBefore
        )
      ).toBe(false);
    }
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
    expect(
      physicalRemoteCheckBoundarySummary(
        before,
        physicalRemoteCheckBoundary(8, 10, 9, 200)
      )
    ).toBe(
      "remote_requests=1;host_requests=1;host_responses=0;new_host_status=none"
    );
  });

  it("owns an in-flight remote check through one bounded tap", async () => {
    const before = physicalRemoteCheckBoundary(7, 9, 9, 200);
    let current = before;
    let tapBoundaryCalls = 0;
    const check = physicalRuntimeFixtureNode({ text: "Check again" });

    await settlePhysicalRemoteCheckAfterOneTap(
      check,
      before,
      () => current,
      async (node, completed, message, timeoutMs) => {
        tapBoundaryCalls += 1;
        expect(node).toBe(check);
        expect(message).toBe(
          "Production remote check did not complete its exact successful status-then-refresh sequence."
        );
        expect(timeoutMs).toBe(physicalRemoteCheckResponseTimeoutMs);
        current = physicalRemoteCheckBoundary(8, 10, 9, 200);
        expect(await completed()).toBe(false);
        current = physicalRemoteCheckBoundary(8, 10, 10, 200);
        expect(await completed()).toBe(true);
      }
    );

    expect(tapBoundaryCalls).toBe(1);
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

  it("renews one gated pairing lease without accepting authority drift", async () => {
    const currentAuthority = Object.freeze({
      active_leases: 1,
      generation: 7,
      invalidations: 2,
      phase: "open" as const,
      signaled_leases: 1
    });
    const currentAdmission = Object.freeze({
      admission: "open" as const,
      external_origin: "https://hostdeck.example.ts.net",
      generation: 7
    });
    let statusReads = 0;
    let admissionReads = 0;
    let authorityReads = 0;
    await refreshPhysicalGatedClaimAdmission({
      expectedExternalOrigin: currentAdmission.external_origin,
      remote: {
        control: {
          async readStatus() {
            statusReads += 1;
          }
        },
        readAdmission() {
          admissionReads += 1;
          return currentAdmission;
        },
        requestAuthority: {
          snapshot() {
            authorityReads += 1;
            return currentAuthority;
          }
        }
      }
    });
    expect({ admissionReads, authorityReads, statusReads }).toEqual({
      admissionReads: 1,
      authorityReads: 2,
      statusReads: 1
    });

    const hostileCases = Object.freeze([
      Object.freeze({
        admission: currentAdmission,
        after: currentAuthority,
        before: Object.freeze({ ...currentAuthority, active_leases: 0 }),
        id: "missing gated request"
      }),
      Object.freeze({
        admission: currentAdmission,
        after: currentAuthority,
        before: Object.freeze({ ...currentAuthority, active_leases: 2 }),
        id: "duplicate gated request"
      }),
      Object.freeze({
        admission: currentAdmission,
        after: Object.freeze({ ...currentAuthority, active_leases: 0 }),
        before: currentAuthority,
        id: "request invalidated"
      }),
      Object.freeze({
        admission: Object.freeze({
          admission: "closed" as const,
          external_origin: null,
          generation: 7
        }),
        after: Object.freeze({
          ...currentAuthority,
          active_leases: 0,
          phase: "closed" as const
        }),
        before: currentAuthority,
        id: "admission closed"
      }),
      Object.freeze({
        admission: Object.freeze({ ...currentAdmission, generation: 8 }),
        after: Object.freeze({ ...currentAuthority, generation: 8 }),
        before: currentAuthority,
        id: "generation changed"
      }),
      Object.freeze({
        admission: Object.freeze({
          ...currentAdmission,
          external_origin: "https://other.example.ts.net"
        }),
        after: currentAuthority,
        before: currentAuthority,
        id: "origin changed"
      }),
      Object.freeze({
        admission: currentAdmission,
        after: Object.freeze({ ...currentAuthority, invalidations: 3 }),
        before: currentAuthority,
        id: "invalidation observed"
      }),
      Object.freeze({
        admission: currentAdmission,
        after: Object.freeze({ ...currentAuthority, signaled_leases: 2 }),
        before: currentAuthority,
        id: "lease signal observed"
      })
    ]);
    for (const testCase of hostileCases) {
      let snapshotIndex = 0;
      await expect(
        refreshPhysicalGatedClaimAdmission({
          expectedExternalOrigin: currentAdmission.external_origin,
          remote: {
            control: { readStatus: async () => undefined },
            readAdmission: () => testCase.admission,
            requestAuthority: {
              snapshot: () =>
                snapshotIndex++ === 0 ? testCase.before : testCase.after
            }
          }
        }),
        testCase.id
      ).rejects.toThrow(physicalGatedClaimAdmissionFailure);
    }

    let failedStatusReads = 0;
    await expect(
      refreshPhysicalGatedClaimAdmission({
        expectedExternalOrigin: currentAdmission.external_origin,
        remote: {
          control: {
            async readStatus() {
              failedStatusReads += 1;
              throw new Error("untrusted observer detail");
            }
          },
          readAdmission: () => currentAdmission,
          requestAuthority: { snapshot: () => currentAuthority }
        }
      })
    ).rejects.toThrow(physicalGatedClaimRefreshFailure);
    expect(failedStatusReads).toBe(1);
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

  it("requires complete Chrome package-process absence", () => {
    expect(
      readChromePackageProcessState(
        0,
        "NAME\ninit\ncom.android.chrome\n",
        ""
      )
    ).toBe("running");
    expect(
      readChromePackageProcessState(
        0,
        "NAME\ninit\ncom.android.chrome:privileged_process6\n",
        ""
      )
    ).toBe("running");
    expect(
      readChromePackageProcessState(
        0,
        "NAME\ninit\ncom.android.chromedriver\n",
        ""
      )
    ).toBe("stopped");
    expect(() => readChromePackageProcessState(0, "not-name\n", "")).toThrow(
      "Chrome process state was invalid"
    );
    expect(() => readChromePackageProcessState(1, "NAME\n", "")).toThrow(
      "Chrome process state was invalid"
    );
    expect(() => readChromePackageProcessState(0, "NAME\n", "failure")).toThrow(
      "Chrome process state was invalid"
    );
  });

  it("requires continuously settled Chrome absence and resets on reappearance", async () => {
    let now = 0;
    let observations = 0;
    await waitForSettledChromeAbsence({
      now: () => now,
      observe: () => {
        observations += 1;
        return now !== 5_000;
      },
      sleep: async () => {
        now += 5_000;
      }
    });
    expect(now).toBe(40_000);
    expect(observations).toBe(9);
  });

  it("fails Chrome settlement on timeout or malformed observation", async () => {
    let now = 0;
    await expect(
      waitForSettledChromeAbsence({
        now: () => now,
        observe: () => false,
        sleep: async () => {
          now += 5_000;
        }
      })
    ).rejects.toThrow("did not remain fully stopped");

    let sleeps = 0;
    await expect(
      waitForSettledChromeAbsence({
        now: () => 0,
        observe: () => {
          throw new Error("Android Chrome process state was invalid.");
        },
        sleep: async () => {
          sleeps += 1;
        }
      })
    ).rejects.toThrow("Chrome process state was invalid");
    expect(sleeps).toBe(0);
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
      if (requireProductionUiAcceptance || requireRemoteAndroidAcceptance) {
        requireCleanAcceptanceWorktree();
      }
      const controller = new AbortController();
      const directory = mkdtempSync(join(tmpdir(), "hostdeck-pairing-android-"));
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
        skillsRequests: 0,
        skillsResponseStatuses: [],
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
      let dashboardPackageIdentity: PhysicalDashboardPackageIdentity | null = null;
      let promptSubscribers: ReturnType<
        typeof createProjectionSubscriberStreamService
      > | null = null;
      let talkBackArtifacts: PhysicalTalkBackArtifacts | null = null;
      let initialWifiEnabled: boolean | null = null;
      let initialMobileDataEnabled: boolean | null = null;
      let initialStayAwakeSetting: number | null = null;
      let selectedProfile: "away" | "dedicated" = "dedicated";
      let internalErrorCount = 0;
      let acceptanceError: unknown = null;
      const cleanupErrors: unknown[] = [];

      try {
        adbCommandCount = 0;
        deviceForbiddenValues.clear();
        if (requireProductionUiAcceptance || requireRemoteAndroidAcceptance) {
          requireNoAdbApplicationTunnels();
          initialStayAwakeSetting = readAndroidStayAwakeSetting();
          const activePlugType = readAndroidPlugType();
          initialWifiEnabled = readAndroidWifiEnabled();
          initialMobileDataEnabled = readAndroidMobileDataEnabled();
          await enforceAndroidAwakeAndUnlocked(
            initialStayAwakeSetting,
            activePlugType
          );
          environmentFacts = readPhysicalEnvironmentFacts();
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
          await enforceUnrelatedAndroidNetwork(
            initialWifiEnabled as boolean,
            initialMobileDataEnabled as boolean
          );
        }
        if (requireDashboardUiAcceptance) {
          dashboardPackageIdentity = buildPhysicalDashboardPackageIdentity();
          talkBackArtifacts = buildPhysicalTalkBackArtifacts(directory);
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
          await refreshPhysicalGatedClaimAdmission({
            expectedExternalOrigin: candidate.externalOrigin,
            remote: selectedRemote
          });
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
          await refreshPhysicalGatedClaimAdmission({
            expectedExternalOrigin: candidate.externalOrigin,
            remote: selectedRemote
          });
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
            actionRegistry: createPhysicalAggregateActionRegistry({
              counterSnapshot: () =>
                readPhysicalAggregateCounterSnapshot(requestInspection),
              readNodes: readAndroidUiNodes
            }),
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
            actionRegistry: createPhysicalAggregateActionRegistry({
              counterSnapshot: () =>
                readPhysicalAggregateCounterSnapshot(requestInspection),
              readNodes: readAndroidUiNodes
            }),
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
            actionRegistry: createPhysicalAggregateActionRegistry({
              counterSnapshot: () =>
                readPhysicalAggregateCounterSnapshot(requestInspection),
              readNodes: readAndroidUiNodes
            }),
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
            actionRegistry: createPhysicalAggregateActionRegistry({
              counterSnapshot: () =>
                readPhysicalAggregateCounterSnapshot(requestInspection),
              readNodes: readAndroidUiNodes
            }),
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
          requireCondition(
            dashboardPackageIdentity !== null,
            "Physical dashboard package identity was not built."
          );
          publishPhysicalDashboardEvidence({
            completedAt: new Date().toISOString(),
            environment: environmentFacts as PhysicalEnvironmentFacts,
            foreignServeBytes: (
              foreignServeBefore as ServeStatusFingerprint
            ).bytes,
            managerAttempts: requireLifecycleManager(lifecycleManager)
              .snapshot().command_attempts,
            packageIdentity: dashboardPackageIdentity,
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
        if (cleanupRemoteLifecycle !== null) {
          await collectPhysicalCleanupError(
            "Physical cleanup could not drain the selected remote lifecycle.",
            () => {
              cleanupRemoteLifecycle.beginDrain();
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

interface PhysicalServeCleanupMutation {
  readonly after: RemoteIngressObservationSnapshot | null;
  readonly commandAttempted: boolean;
}

interface PhysicalServeCleanupPort {
  readonly disable: () => Promise<PhysicalServeCleanupMutation>;
  readonly observe: () => Promise<RemoteIngressObservationSnapshot>;
}

interface PhysicalServeCleanupSchedule {
  readonly attempts: number;
  readonly sleep: () => Promise<void>;
}

interface PhysicalSkillsRouteDiagnostic {
  readonly proxyRejection: string | null;
  readonly requests: number;
  readonly responseStatuses: readonly number[];
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
  skillsRequests: number;
  skillsResponseStatuses: number[];
  sessionStreamRequests: number;
  sessionStreamResponseStatuses: number[];
}

const physicalAggregateCounterNameByInspectionKey = Object.freeze({
  accessRequests: "access_requests",
  accessResponseStatuses: "access_response_statuses",
  claimRequests: "claim_requests",
  claimResponseStatuses: "claim_response_statuses",
  csrfRequests: "csrf_requests",
  csrfResponseStatuses: "csrf_response_statuses",
  deletionCookieObserved: "deletion_cookie_observed",
  fragmentLeaks: "fragment_leaks",
  hardenedCookieObserved: "hardened_cookie_observed",
  hostStatusRequests: "host_status_requests",
  hostStatusResponseStatuses: "host_status_response_statuses",
  noReferrerApiRequests: "no_referrer_api_requests",
  planReadRequests: "plan_read_requests",
  promptNoReferrerRequests: "prompt_no_referrer_requests",
  promptRequests: "prompt_requests",
  promptResponseStatuses: "prompt_response_statuses",
  protectedReadRejections: "protected_read_rejections",
  protectedReadRequests: "protected_read_requests",
  protectedReadSuccesses: "protected_read_successes",
  rejectedRevokedCheckpoints: "rejected_revoked_checkpoints",
  remoteBrowserMutationRequests: "remote_browser_mutation_requests",
  remoteBrowserStatusRequests: "remote_browser_status_requests",
  remoteDisableRequests: "remote_disable_requests",
  remoteEnableRequests: "remote_enable_requests",
  remoteStatusRequests: "remote_status_requests",
  revokeRequests: "revoke_requests",
  revokedCheckpointRequests: "revoked_checkpoint_requests",
  sessionDetailRequests: "session_detail_requests",
  sessionEventRequests: "session_event_requests",
  sessionListRequests: "session_list_requests",
  sessionListResponseStatuses: "session_list_response_statuses",
  sessionMissingDetailRequests: "session_missing_detail_requests",
  sessionStreamRequests: "session_stream_requests",
  sessionStreamResponseStatuses: "session_stream_response_statuses",
  skillsRequests: "skills_requests",
  skillsResponseStatuses: "skills_response_statuses"
} satisfies Record<keyof RequestInspection, string>);

function readPhysicalAggregateCounterSnapshot(
  inspection: RequestInspection
): Readonly<Record<string, number>> {
  const entries = Object.entries(physicalAggregateCounterNameByInspectionKey);
  requireCondition(
    new Set(entries.map(([, counterName]) => counterName)).size === entries.length,
    "Physical aggregate counter names were not unique."
  );
  return Object.freeze(
    Object.fromEntries(
      entries.map(([inspectionKey, counterName]) => {
        const value = inspection[inspectionKey as keyof RequestInspection];
        const count = Array.isArray(value)
          ? value.length
          : typeof value === "boolean"
            ? Number(value)
            : value;
        requireCondition(
          Number.isSafeInteger(count) && count >= 0,
          `Physical aggregate counter ${counterName} was invalid.`
        );
        return [counterName, count];
      })
    )
  );
}

interface PhysicalSessionNavigationSnapshot {
  readonly activeSubscribers: number;
  readonly missingDetailRequests: number;
  readonly openedSubscribers: number;
  readonly selectedDetailRequests: number;
  readonly streamRequests: number;
}

interface PhysicalSessionActionsWaitSource {
  readonly readNavigation: () => PhysicalSessionNavigationSnapshot;
  readonly readNodes: () => Promise<readonly AndroidUiNode[]>;
}

interface PhysicalSessionActionsWaitOptions {
  readonly baseline?: PhysicalSessionNavigationSnapshot;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

interface PhysicalSessionActionsAdmissionWindowOptions {
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

interface PhysicalSessionActionsAdmissionWindow {
  readonly baseline: PhysicalSessionNavigationSnapshot;
  readonly wait: (message: string) => Promise<AndroidUiNode>;
}

interface PhysicalSessionActionsHandoff {
  readonly admission: PhysicalSessionActionsAdmissionWindow;
  readonly node: AndroidUiNode;
}

type PhysicalSessionReloadTruth = "current" | "stale";

interface PhysicalSessionReloadWaitSource {
  readonly readNavigation: () => PhysicalSessionNavigationSnapshot;
  readonly readNodes: () => Promise<readonly AndroidUiNode[]>;
}

interface PhysicalSessionReloadWaitOptions {
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

interface PhysicalMissionControlReloadWaitSource {
  readonly readNodes: () => Promise<readonly AndroidUiNode[]>;
  readonly readRequests: () => PhysicalMissionControlRequestSnapshot;
}

interface PhysicalMissionControlReloadWaitOptions {
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

interface PhysicalMissionControlRequestSnapshot {
  readonly accessRequests: number;
  readonly hostStatusRequests: number;
  readonly sessionListRequests: number;
}

interface PhysicalPairingContinueWaitSource {
  readonly readNodes: () => Promise<readonly AndroidUiNode[]>;
  readonly readRequests: () => PhysicalMissionControlRequestSnapshot;
}

interface PhysicalPairingContinueWaitOptions {
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

interface PhysicalProfileSnapshotInput {
  readonly foreignServe: ServeStatusFingerprint;
  readonly managerAttempts: number;
  readonly requestInspection: RequestInspection;
}

interface PhysicalProfileExternalStateSource {
  readonly readForeignServe: () => Promise<ServeStatusFingerprint>;
  readonly readManagerAttempts: () => number;
}

interface PhysicalProfileAwaySnapshot {
  readonly foreignServe: ServeStatusFingerprint;
  readonly managerAttempts: number;
  readonly mission: PhysicalMissionControlRequestSnapshot;
  readonly remoteBrowserMutationRequests: number;
  readonly remoteBrowserStatusRequests: number;
  readonly remoteDisableRequests: number;
  readonly remoteEnableRequests: number;
  readonly remoteStatusRequests: number;
}

interface PhysicalProfileReturnSnapshot {
  readonly claimRequests: number;
  readonly foreignServe: ServeStatusFingerprint;
  readonly managerAttempts: number;
  readonly mission: PhysicalMissionControlRequestSnapshot;
  readonly remoteBrowserMutationRequests: number;
  readonly remoteBrowserStatusRequests: number;
  readonly remoteDisableRequests: number;
  readonly remoteEnableRequests: number;
  readonly remoteStatusRequests: number;
}

type PhysicalAggregateActionTask =
  | "FE-V1-091"
  | "FE-V1-092"
  | "FE-V1-093"
  | "FE-V1-094"
  | "FE-V1-095"
  | "FE-V1-096"
  | "FE-V1-097"
  | "FE-V1-098"
  | "FE-V1-099"
  | "FE-V1-104";

type PhysicalAggregateActionDriver =
  | "android_node"
  | "observation"
  | "talkback";

type PhysicalAggregateRouteOwner =
  | "Archive result"
  | "Event details"
  | "External page"
  | "Goal sheet"
  | "Host & access"
  | "Host lock confirmation"
  | "Mission Control"
  | "Model sheet"
  | "Plan sheet"
  | "Prompt composer"
  | "Revoke confirmation"
  | "Resume page"
  | "Session Actions"
  | "Session Detail"
  | "Session utilities"
  | "Pairing shell"
  | "Profile lifecycle"
  | "Stream recovery";

const physicalAggregateReachableActionIds = Object.freeze([
  "pairing-open-host",
  "pairing-close-host",
  "pairing-continue",
  "dashboard-bootstrap",
  "dashboard-expand-quiet",
  "dashboard-open-session",
  "approval-open",
  "approval-submit",
  "event-open-boundary",
  "event-close-boundary",
  "event-open-complete",
  "event-close-complete",
  "event-open-redacted",
  "event-close-redacted",
  "detail-expand-quiet",
  "archive-expand-quiet",
  "model-open",
  "model-select",
  "model-submit",
  "model-close",
  "model-reopen",
  "model-close-reopen",
  "goal-open",
  "goal-editor",
  "goal-save",
  "goal-close",
  "plan-open",
  "plan-select",
  "plan-submit",
  "plan-close",
  "plan-reopen",
  "plan-close-reopen",
  "utilities-open",
  "usage-open",
  "usage-back",
  "compact-open",
  "compact-begin",
  "compact-confirm",
  "compact-check",
  "compact-back",
  "skills-open",
  "skills-search",
  "skills-back",
  "utilities-close",
  "resume-session-actions",
  "resume-open",
  "resume-copy",
  "resume-back",
  "resume-close-session",
  "clipboard-clear",
  "interrupt-session-actions",
  "interrupt-open",
  "interrupt-confirm",
  "interrupt-done",
  "host-session-actions",
  "host-open-nested",
  "revoke-open",
  "revoke-confirm",
  "host-lock-open",
  "host-lock-confirm",
  "host-nested-close",
  "host-detail-back",
  "dashboard-detail-back",
  "unlocked-session-open",
  "profile-away-refresh",
  "profile-return-refresh",
  "archive-session-open",
  "archive-session-actions",
  "archive-open",
  "archive-confirm",
  "archive-result-back",
  "self-revoke-open",
  "self-revoke-confirm",
  "self-global-open",
  "profile-global-open",
  "profile-global-close",
  "runtime-incompatible-open",
  "runtime-incompatible-close",
  "runtime-supported-open",
  "runtime-supported-close",
  "talkback-open-session",
  "talkback-model-open",
  "talkback-model-close",
  "talkback-detail-back",
  "recovery-ready-open",
  "recovery-ready-close",
  "recovery-return-open",
  "recovery-return-close",
  "remote-check-nested",
  "remote-check-profile",
  "remote-check-runtime-incompatible",
  "remote-check-runtime-supported",
  "remote-check-recovery-ready",
  "remote-check-recovery-return",
  "prompt-open-session",
  "prompt-editor",
  "prompt-send",
  "external-selected-clipboard",
  "external-selected-not-found",
  "stream-recovery-observe",
  "stream-reconnect-observe",
  "profile-switch-away",
  "profile-switch-return",
  "local-unlock"
] as const);

type PhysicalAggregateActionId =
  (typeof physicalAggregateReachableActionIds)[number];

interface PhysicalAggregateOwnerContext {
  readonly actionId: PhysicalAggregateActionId;
  readonly counterSnapshot: Readonly<Record<string, number>>;
  readonly currentNodes: readonly AndroidUiNode[];
  readonly node: AndroidUiNode;
  readonly routeOwner: PhysicalAggregateRouteOwner;
}

type PhysicalAggregateSelectorWaiter = (
  context: PhysicalAggregateOwnerContext
) => AndroidUiNode;
type PhysicalAggregateCounterOracle = (
  context: PhysicalAggregateOwnerContext
) => Readonly<Record<string, number>>;
type PhysicalAggregateDiagnosticOwner = (
  context: PhysicalAggregateOwnerContext
) => string;

interface PhysicalAggregateTransitionContext
  extends PhysicalAggregateOwnerContext {
  readonly completed: () => boolean | Promise<boolean>;
  readonly counterBefore: Readonly<Record<string, number>>;
  readonly diagnostic: string;
  readonly selectorResult: AndroidUiNode;
}

interface PhysicalAggregateActionDefinition {
  readonly actionId: PhysicalAggregateActionId;
  readonly canonicalInteractionIds: readonly MobileInteractionId[];
  readonly counterOracle: PhysicalAggregateCounterOracle;
  readonly diagnosticOwner: PhysicalAggregateDiagnosticOwner;
  readonly driver: PhysicalAggregateActionDriver;
  readonly maximumTaps: 0 | 1;
  readonly routeOwner: PhysicalAggregateRouteOwner;
  readonly selectorWaiter: PhysicalAggregateSelectorWaiter;
  readonly task: PhysicalAggregateActionTask;
  readonly transitionExecutor: (
    context: PhysicalAggregateTransitionContext
  ) => boolean | Promise<boolean>;
}

interface PhysicalAggregateActionRegistry {
  readonly activate: (
    actionId: PhysicalAggregateActionId,
    node: AndroidUiNode,
    activateOnce: () => void,
    completed: () => boolean | Promise<boolean>,
    message: string,
    timeoutMs?: number
  ) => Promise<void>;
  readonly consume: (
    actionId: PhysicalAggregateActionId,
    completed: () => boolean,
    message: string
  ) => void;
  readonly assertConsumed: (
    expectedActionIds?: readonly PhysicalAggregateActionId[]
  ) => void;
  readonly tap: (
    actionId: PhysicalAggregateActionId,
    node: AndroidUiNode,
    completed: () => boolean | Promise<boolean>,
    message: string | (() => string),
    options?: number | PhysicalAggregateTapOptions
  ) => Promise<void>;
}

interface PhysicalAggregateTapOptions {
  readonly beforeTap?:
    | ((context: PhysicalAggregateOwnerContext) => void)
    | undefined;
  readonly timeoutMs?: number | undefined;
}

interface PhysicalAggregateActionRegistryOptions {
  readonly counterSnapshot?: () => Readonly<Record<string, number>>;
  readonly expectedActionIds?: readonly PhysicalAggregateActionId[];
  readonly readNodes?: () => Promise<readonly AndroidUiNode[]>;
  readonly tapNodeOnceAndWait?: (
    node: AndroidUiNode,
    completed: () => boolean | Promise<boolean>,
    message: string | (() => string),
    timeoutMs: number
  ) => Promise<void>;
}

function freezePhysicalAggregateCanonicalActionMap(
  map: Record<MobileInteractionId, readonly PhysicalAggregateActionId[]>
): Readonly<Record<MobileInteractionId, readonly PhysicalAggregateActionId[]>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(map).map(([interactionId, actionIds]) => [
        interactionId,
        Object.freeze([...actionIds])
      ])
    )
  ) as Readonly<Record<MobileInteractionId, readonly PhysicalAggregateActionId[]>>;
}

const physicalAggregateCanonicalActionMap: Readonly<
  Record<MobileInteractionId, readonly PhysicalAggregateActionId[]>
> = freezePhysicalAggregateCanonicalActionMap({
  bootstrap_csrf: ["pairing-continue"],
  bootstrap_shell: ["dashboard-bootstrap", "pairing-continue"],
  claim_pairing: ["pairing-continue"],
  consume_pairing_fragment: ["pairing-continue"],
  create_pairing_link: ["pairing-open-host", "pairing-close-host"],
  disable_remote_local: ["profile-switch-away", "profile-away-refresh"],
  enable_remote_local: ["profile-switch-return", "profile-return-refresh"],
  interrupt_turn: [
    "interrupt-session-actions",
    "interrupt-open",
    "interrupt-confirm",
    "interrupt-done"
  ],
  lock_host: ["host-lock-open", "host-lock-confirm"],
  mutate_goal: ["goal-save"],
  navigate_back: [
    "event-close-boundary",
    "event-close-complete",
    "event-close-redacted",
    "model-close",
    "model-close-reopen",
    "goal-close",
    "plan-close",
    "plan-close-reopen",
    "usage-back",
    "compact-back",
    "skills-back",
    "utilities-close",
    "resume-back",
    "resume-close-session",
    "host-nested-close",
    "host-detail-back",
    "dashboard-detail-back",
    "archive-result-back",
    "clipboard-clear",
    "external-selected-clipboard",
    "external-selected-not-found",
    "talkback-model-close",
    "talkback-detail-back"
  ],
  open_session: [
    "dashboard-open-session",
    "unlocked-session-open",
    "archive-session-open",
    "prompt-open-session",
    "talkback-open-session"
  ],
  read_approvals: ["approval-open"],
  read_compact: ["compact-open", "compact-begin", "compact-check"],
  read_devices: ["self-revoke-open", "self-global-open"],
  read_event_details: [
    "event-open-boundary",
    "event-open-complete",
    "event-open-redacted",
    "event-close-boundary",
    "event-close-complete",
    "event-close-redacted"
  ],
  read_goal: ["goal-open", "goal-editor", "goal-close"],
  read_host_access: [
    "host-session-actions",
    "host-open-nested",
    "host-nested-close",
    "self-global-open",
    "profile-global-open",
    "profile-global-close",
    "runtime-incompatible-open",
    "runtime-incompatible-close",
    "runtime-supported-open",
    "runtime-supported-close",
    "recovery-ready-open",
    "recovery-ready-close",
    "recovery-return-open",
    "recovery-return-close"
  ],
  read_host_status: [
    "remote-check-nested",
    "remote-check-profile",
    "remote-check-runtime-incompatible",
    "remote-check-runtime-supported",
    "remote-check-recovery-ready",
    "remote-check-recovery-return"
  ],
  read_model: [
    "model-open",
    "model-close",
    "model-reopen",
    "model-close-reopen",
    "talkback-model-open",
    "talkback-model-close"
  ],
  read_plan: [
    "plan-open",
    "plan-close",
    "plan-reopen",
    "plan-close-reopen"
  ],
  read_remote_status: ["remote-check-profile"],
  read_session_detail: [
    "dashboard-open-session",
    "unlocked-session-open",
    "talkback-open-session"
  ],
  read_sessions: [
    "dashboard-bootstrap",
    "dashboard-expand-quiet",
    "detail-expand-quiet",
    "archive-expand-quiet"
  ],
  read_skills: ["skills-open", "skills-search", "skills-back"],
  read_usage: ["utilities-open", "usage-open", "usage-back", "utilities-close"],
  read_resume_metadata: [
    "resume-session-actions",
    "resume-open",
    "resume-back",
    "resume-close-session"
  ],
  reconnect_stream: ["stream-reconnect-observe"],
  respond_approval: ["approval-submit"],
  revoke_device: ["revoke-open", "revoke-confirm", "self-revoke-confirm"],
  select_model: ["model-select", "model-submit"],
  select_plan: ["plan-select", "plan-submit"],
  send_prompt: ["prompt-editor", "prompt-send"],
  start_compact: ["compact-confirm"],
  stream_events: ["stream-recovery-observe"],
  switch_tailscale_profile_local: ["profile-switch-away", "profile-switch-return"],
  unlock_host_local: ["local-unlock"],
  archive_session: [
    "archive-expand-quiet",
    "archive-session-open",
    "archive-session-actions",
    "archive-open",
    "archive-confirm"
  ],
  copy_resume_command: ["resume-copy"]
});

const physicalAggregateTaskByAction = Object.freeze({
  "pairing-open-host": "FE-V1-095",
  "pairing-close-host": "FE-V1-095",
  "pairing-continue": "FE-V1-098",
  "dashboard-bootstrap": "FE-V1-098",
  "dashboard-expand-quiet": "FE-V1-093",
  "dashboard-open-session": "FE-V1-093",
  "approval-open": "FE-V1-096",
  "approval-submit": "FE-V1-096",
  "event-open-boundary": "FE-V1-104",
  "event-close-boundary": "FE-V1-095",
  "event-open-complete": "FE-V1-104",
  "event-close-complete": "FE-V1-095",
  "event-open-redacted": "FE-V1-104",
  "event-close-redacted": "FE-V1-095",
  "detail-expand-quiet": "FE-V1-093",
  "archive-expand-quiet": "FE-V1-093",
  "model-open": "FE-V1-095",
  "model-select": "FE-V1-096",
  "model-submit": "FE-V1-096",
  "model-close": "FE-V1-095",
  "model-reopen": "FE-V1-095",
  "model-close-reopen": "FE-V1-095",
  "goal-open": "FE-V1-095",
  "goal-editor": "FE-V1-096",
  "goal-save": "FE-V1-096",
  "goal-close": "FE-V1-095",
  "plan-open": "FE-V1-095",
  "plan-select": "FE-V1-096",
  "plan-submit": "FE-V1-096",
  "plan-close": "FE-V1-095",
  "plan-reopen": "FE-V1-095",
  "plan-close-reopen": "FE-V1-095",
  "utilities-open": "FE-V1-095",
  "usage-open": "FE-V1-097",
  "usage-back": "FE-V1-097",
  "compact-open": "FE-V1-096",
  "compact-begin": "FE-V1-096",
  "compact-confirm": "FE-V1-096",
  "compact-check": "FE-V1-096",
  "compact-back": "FE-V1-097",
  "skills-open": "FE-V1-097",
  "skills-search": "FE-V1-097",
  "skills-back": "FE-V1-097",
  "utilities-close": "FE-V1-095",
  "resume-session-actions": "FE-V1-097",
  "resume-open": "FE-V1-097",
  "resume-copy": "FE-V1-097",
  "resume-back": "FE-V1-097",
  "resume-close-session": "FE-V1-097",
  "clipboard-clear": "FE-V1-097",
  "interrupt-session-actions": "FE-V1-091",
  "interrupt-open": "FE-V1-091",
  "interrupt-confirm": "FE-V1-091",
  "interrupt-done": "FE-V1-091",
  "host-session-actions": "FE-V1-091",
  "host-open-nested": "FE-V1-095",
  "revoke-open": "FE-V1-092",
  "revoke-confirm": "FE-V1-092",
  "host-lock-open": "FE-V1-092",
  "host-lock-confirm": "FE-V1-092",
  "host-nested-close": "FE-V1-095",
  "host-detail-back": "FE-V1-093",
  "dashboard-detail-back": "FE-V1-093",
  "unlocked-session-open": "FE-V1-093",
  "profile-away-refresh": "FE-V1-094",
  "profile-return-refresh": "FE-V1-094",
  "archive-session-open": "FE-V1-093",
  "archive-session-actions": "FE-V1-092",
  "archive-open": "FE-V1-092",
  "archive-confirm": "FE-V1-092",
  "archive-result-back": "FE-V1-093",
  "self-revoke-open": "FE-V1-092",
  "self-revoke-confirm": "FE-V1-092",
  "self-global-open": "FE-V1-095",
  "profile-global-open": "FE-V1-094",
  "profile-global-close": "FE-V1-094",
  "runtime-incompatible-open": "FE-V1-095",
  "runtime-incompatible-close": "FE-V1-095",
  "runtime-supported-open": "FE-V1-095",
  "runtime-supported-close": "FE-V1-095",
  "talkback-open-session": "FE-V1-093",
  "talkback-model-open": "FE-V1-095",
  "talkback-model-close": "FE-V1-095",
  "talkback-detail-back": "FE-V1-093",
  "recovery-ready-open": "FE-V1-094",
  "recovery-ready-close": "FE-V1-094",
  "recovery-return-open": "FE-V1-094",
  "recovery-return-close": "FE-V1-094",
  "remote-check-nested": "FE-V1-098",
  "remote-check-profile": "FE-V1-098",
  "remote-check-runtime-incompatible": "FE-V1-098",
  "remote-check-runtime-supported": "FE-V1-098",
  "remote-check-recovery-ready": "FE-V1-098",
  "remote-check-recovery-return": "FE-V1-098",
  "prompt-open-session": "FE-V1-093",
  "prompt-editor": "FE-V1-096",
  "prompt-send": "FE-V1-096",
  "external-selected-clipboard": "FE-V1-093",
  "external-selected-not-found": "FE-V1-093",
  "stream-recovery-observe": "FE-V1-098",
  "stream-reconnect-observe": "FE-V1-098",
  "profile-switch-away": "FE-V1-094",
  "profile-switch-return": "FE-V1-094",
  "local-unlock": "FE-V1-099"
} satisfies Record<PhysicalAggregateActionId, PhysicalAggregateActionTask>);

const physicalAggregateRouteByAction = Object.freeze({
  "pairing-open-host": "Pairing shell",
  "pairing-close-host": "Pairing shell",
  "pairing-continue": "Pairing shell",
  "dashboard-bootstrap": "Mission Control",
  "dashboard-expand-quiet": "Mission Control",
  "dashboard-open-session": "Mission Control",
  "approval-open": "Session Detail",
  "approval-submit": "Session Detail",
  "event-open-boundary": "Event details",
  "event-close-boundary": "Event details",
  "event-open-complete": "Event details",
  "event-close-complete": "Event details",
  "event-open-redacted": "Event details",
  "event-close-redacted": "Event details",
  "detail-expand-quiet": "External page",
  "archive-expand-quiet": "External page",
  "model-open": "Model sheet",
  "model-select": "Model sheet",
  "model-submit": "Model sheet",
  "model-close": "Model sheet",
  "model-reopen": "Model sheet",
  "model-close-reopen": "Model sheet",
  "goal-open": "Goal sheet",
  "goal-editor": "Goal sheet",
  "goal-save": "Goal sheet",
  "goal-close": "Goal sheet",
  "plan-open": "Plan sheet",
  "plan-select": "Plan sheet",
  "plan-submit": "Plan sheet",
  "plan-close": "Plan sheet",
  "plan-reopen": "Plan sheet",
  "plan-close-reopen": "Plan sheet",
  "utilities-open": "Session utilities",
  "usage-open": "Session utilities",
  "usage-back": "Session utilities",
  "compact-open": "Session utilities",
  "compact-begin": "Session utilities",
  "compact-confirm": "Session utilities",
  "compact-check": "Session utilities",
  "compact-back": "Session utilities",
  "skills-open": "Session utilities",
  "skills-search": "Session utilities",
  "skills-back": "Session utilities",
  "utilities-close": "Session utilities",
  "resume-session-actions": "Session Actions",
  "resume-open": "Resume page",
  "resume-copy": "Resume page",
  "resume-back": "Resume page",
  "resume-close-session": "Resume page",
  "clipboard-clear": "External page",
  "interrupt-session-actions": "Session Actions",
  "interrupt-open": "Session Actions",
  "interrupt-confirm": "Session Actions",
  "interrupt-done": "Session Actions",
  "host-session-actions": "Session Actions",
  "host-open-nested": "Host & access",
  "revoke-open": "Revoke confirmation",
  "revoke-confirm": "Revoke confirmation",
  "host-lock-open": "Host lock confirmation",
  "host-lock-confirm": "Host lock confirmation",
  "host-nested-close": "Host & access",
  "host-detail-back": "Session Detail",
  "dashboard-detail-back": "Session Detail",
  "unlocked-session-open": "Mission Control",
  "profile-away-refresh": "Mission Control",
  "profile-return-refresh": "Mission Control",
  "archive-session-open": "Mission Control",
  "archive-session-actions": "Session Actions",
  "archive-open": "Archive result",
  "archive-confirm": "Archive result",
  "archive-result-back": "Archive result",
  "self-revoke-open": "Revoke confirmation",
  "self-revoke-confirm": "Revoke confirmation",
  "self-global-open": "Host & access",
  "profile-global-open": "Host & access",
  "profile-global-close": "Host & access",
  "runtime-incompatible-open": "Host & access",
  "runtime-incompatible-close": "Host & access",
  "runtime-supported-open": "Host & access",
  "runtime-supported-close": "Host & access",
  "talkback-open-session": "Mission Control",
  "talkback-model-open": "Model sheet",
  "talkback-model-close": "Model sheet",
  "talkback-detail-back": "Session Detail",
  "recovery-ready-open": "Host & access",
  "recovery-ready-close": "Host & access",
  "recovery-return-open": "Host & access",
  "recovery-return-close": "Host & access",
  "remote-check-nested": "Host & access",
  "remote-check-profile": "Host & access",
  "remote-check-runtime-incompatible": "Host & access",
  "remote-check-runtime-supported": "Host & access",
  "remote-check-recovery-ready": "Host & access",
  "remote-check-recovery-return": "Host & access",
  "prompt-open-session": "Mission Control",
  "prompt-editor": "Prompt composer",
  "prompt-send": "Prompt composer",
  "external-selected-clipboard": "External page",
  "external-selected-not-found": "External page",
  "stream-recovery-observe": "Stream recovery",
  "stream-reconnect-observe": "Stream recovery",
  "profile-switch-away": "Profile lifecycle",
  "profile-switch-return": "Profile lifecycle",
  "local-unlock": "Host & access"
} satisfies Record<PhysicalAggregateActionId, PhysicalAggregateRouteOwner>);

function physicalAggregateTaskForAction(
  actionId: PhysicalAggregateActionId
): PhysicalAggregateActionTask {
  return physicalAggregateTaskByAction[actionId];
}

function physicalAggregateRouteForAction(
  actionId: PhysicalAggregateActionId
): PhysicalAggregateRouteOwner {
  return physicalAggregateRouteByAction[actionId];
}


function physicalAggregateCanonicalIdsForAction(
  actionId: PhysicalAggregateActionId
): readonly MobileInteractionId[] {
  return mobileInteractionIds.filter((interactionId) =>
    physicalAggregateCanonicalActionMap[interactionId]?.includes(actionId)
  );
}

function physicalAggregateCanonicalActionMapIsExact(
  map: Readonly<Record<MobileInteractionId, readonly PhysicalAggregateActionId[]>> =
    physicalAggregateCanonicalActionMap
): boolean {
  const keys = Object.keys(map);
  if (
    !Object.isFrozen(map) ||
    keys.length !== mobileInteractionIds.length ||
    mobileInteractionIds.some((interactionId) => !keys.includes(interactionId))
  ) {
    return false;
  }
  const canonicalRowsAreExact = mobileInteractionIds.every((interactionId) => {
    const actionIds = map[interactionId];
    const expectedActionIds = physicalAggregateCanonicalActionMap[interactionId];
    return (
      actionIds !== undefined &&
      expectedActionIds !== undefined &&
      actionIds.length > 0 &&
      actionIds.length === expectedActionIds.length &&
      Object.isFrozen(actionIds) &&
      actionIds.every(
        (actionId, index) =>
          physicalAggregateReachableActionIds.includes(actionId) &&
          actionIds.indexOf(actionId) === index &&
          actionId === expectedActionIds[index]
      )
    );
  });
  return (
    canonicalRowsAreExact &&
    physicalAggregateReachableActionIds.every((actionId) =>
      mobileInteractionIds.some((interactionId) =>
        map[interactionId]?.includes(actionId)
      )
    )
  );
}

const physicalAggregateMaximumTapsByAction = Object.freeze({
  "pairing-open-host": 1,
  "pairing-close-host": 1,
  "pairing-continue": 1,
  "dashboard-bootstrap": 0,
  "dashboard-expand-quiet": 1,
  "dashboard-open-session": 1,
  "approval-open": 1,
  "approval-submit": 1,
  "event-open-boundary": 1,
  "event-close-boundary": 1,
  "event-open-complete": 1,
  "event-close-complete": 1,
  "event-open-redacted": 1,
  "event-close-redacted": 1,
  "detail-expand-quiet": 1,
  "archive-expand-quiet": 1,
  "model-open": 1,
  "model-select": 1,
  "model-submit": 1,
  "model-close": 1,
  "model-reopen": 1,
  "model-close-reopen": 1,
  "goal-open": 1,
  "goal-editor": 1,
  "goal-save": 1,
  "goal-close": 1,
  "plan-open": 1,
  "plan-select": 1,
  "plan-submit": 1,
  "plan-close": 1,
  "plan-reopen": 1,
  "plan-close-reopen": 1,
  "utilities-open": 1,
  "usage-open": 1,
  "usage-back": 1,
  "compact-open": 1,
  "compact-begin": 1,
  "compact-confirm": 1,
  "compact-check": 1,
  "compact-back": 1,
  "skills-open": 1,
  "skills-search": 1,
  "skills-back": 1,
  "utilities-close": 1,
  "resume-session-actions": 1,
  "resume-open": 1,
  "resume-copy": 1,
  "resume-back": 1,
  "resume-close-session": 1,
  "clipboard-clear": 1,
  "interrupt-session-actions": 1,
  "interrupt-open": 1,
  "interrupt-confirm": 1,
  "interrupt-done": 1,
  "host-session-actions": 1,
  "host-open-nested": 1,
  "revoke-open": 1,
  "revoke-confirm": 1,
  "host-lock-open": 1,
  "host-lock-confirm": 1,
  "host-nested-close": 1,
  "host-detail-back": 1,
  "dashboard-detail-back": 1,
  "unlocked-session-open": 1,
  "profile-away-refresh": 1,
  "profile-return-refresh": 1,
  "archive-session-open": 1,
  "archive-session-actions": 1,
  "archive-open": 1,
  "archive-confirm": 1,
  "archive-result-back": 1,
  "self-revoke-open": 1,
  "self-revoke-confirm": 1,
  "self-global-open": 1,
  "profile-global-open": 1,
  "profile-global-close": 1,
  "runtime-incompatible-open": 1,
  "runtime-incompatible-close": 1,
  "runtime-supported-open": 1,
  "runtime-supported-close": 1,
  "talkback-open-session": 1,
  "talkback-model-open": 1,
  "talkback-model-close": 1,
  "talkback-detail-back": 1,
  "recovery-ready-open": 1,
  "recovery-ready-close": 1,
  "recovery-return-open": 1,
  "recovery-return-close": 1,
  "remote-check-nested": 1,
  "remote-check-profile": 1,
  "remote-check-runtime-incompatible": 1,
  "remote-check-runtime-supported": 1,
  "remote-check-recovery-ready": 1,
  "remote-check-recovery-return": 1,
  "prompt-open-session": 1,
  "prompt-editor": 1,
  "prompt-send": 1,
  "external-selected-clipboard": 1,
  "external-selected-not-found": 1,
  "stream-recovery-observe": 0,
  "stream-reconnect-observe": 0,
  "profile-switch-away": 0,
  "profile-switch-return": 0,
  "local-unlock": 0
} satisfies Record<PhysicalAggregateActionId, 0 | 1>);

function physicalAggregateMaximumTapsForAction(
  actionId: PhysicalAggregateActionId
): 0 | 1 {
  return physicalAggregateMaximumTapsByAction[actionId];
}

const physicalAggregateTalkBackActionIds = Object.freeze([
  "talkback-open-session",
  "talkback-model-open",
  "talkback-model-close",
  "talkback-detail-back"
] satisfies readonly PhysicalAggregateActionId[]);

function physicalAggregateDriverForAction(
  actionId: PhysicalAggregateActionId
): PhysicalAggregateActionDriver {
  if (physicalAggregateTalkBackActionIds.some((candidate) => candidate === actionId)) {
    return "talkback";
  }
  return physicalAggregateMaximumTapsForAction(actionId) === 0
    ? "observation"
    : "android_node";
}



function physicalAggregateNodeMatches(
  left: AndroidUiNode,
  right: AndroidUiNode
): boolean {
  return (
    left.bounds.left === right.bounds.left &&
    left.bounds.top === right.bounds.top &&
    left.bounds.right === right.bounds.right &&
    left.bounds.bottom === right.bounds.bottom &&
    left.className === right.className &&
    left.resourceId === right.resourceId &&
    left.text === right.text &&
    left.description === right.description &&
    left.clickable === right.clickable &&
    left.checked === right.checked &&
    left.enabled === right.enabled &&
    left.focused === right.focused &&
    left.selected === right.selected
  );
}

function physicalAggregateCounterSnapshotIsBounded(
  snapshot: Readonly<Record<string, number>>
): boolean {
  return Object.entries(snapshot).every(
    ([key, value]) =>
      key.length >= 1 &&
      key.length <= 128 &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= 1_000_000
  ) && Object.keys(snapshot).length > 0;
}

function physicalAggregateSelectorOwner(
  context: PhysicalAggregateOwnerContext
): AndroidUiNode {
  const matches = context.currentNodes.filter((node) =>
    physicalAggregateNodeMatches(node, context.node)
  );
  requireCondition(
    matches.length === 1,
    `Physical aggregate action ${context.actionId} lost its unique selected node.`
  );
  const driver = physicalAggregateDriverForAction(context.actionId);
  requireCondition(
    driver === "observation"
      ? physicalAggregateObservationNodeMatches(context.node, context.actionId)
      : context.node.clickable && context.node.enabled !== false,
    `Physical aggregate action ${context.actionId} selected an invalid owner node.`
  );
  const selected = matches[0];
  requireCondition(
    selected !== undefined,
    `Physical aggregate action ${context.actionId} selected no node.`
  );
  return selected;
}

function physicalAggregateObservationOwnerNode(
  actionId: PhysicalAggregateActionId
): AndroidUiNode {
  return Object.freeze({
    bounds: Object.freeze({ bottom: 1, left: 0, right: 1, top: 0 }),
    className: "hostdeck.physical.Observation",
    clickable: false,
    description: actionId,
    resourceId: "",
    text: ""
  });
}

function physicalAggregateObservationNodeMatches(
  node: AndroidUiNode,
  actionId: PhysicalAggregateActionId
): boolean {
  return (
    node.className === "hostdeck.physical.Observation" &&
    !node.clickable &&
    node.enabled !== false &&
    node.description === actionId &&
    node.resourceId === "" &&
    node.text === "" &&
    node.bounds.left === 0 &&
    node.bounds.top === 0 &&
    node.bounds.right === 1 &&
    node.bounds.bottom === 1
  );
}

function physicalAggregateCounterOwner(
  context: PhysicalAggregateOwnerContext
): Readonly<Record<string, number>> {
  requireCondition(
    physicalAggregateCounterSnapshotIsBounded(context.counterSnapshot),
    `Physical aggregate action ${context.actionId} observed an invalid counter snapshot.`
  );
  return context.counterSnapshot;
}

function physicalAggregateDiagnosticOwner(
  context: PhysicalAggregateOwnerContext
): string {
  const diagnostic =
    `action=${context.actionId};route=${context.routeOwner};` +
    `node=${androidUiNodeGeometry(context.node)}`;
  requireCondition(
    Buffer.byteLength(diagnostic, "utf8") <= 4_096,
    `Physical aggregate action ${context.actionId} exceeded its diagnostic bound.`
  );
  return diagnostic;
}

function physicalAggregateTransitionExecutor(
  context: PhysicalAggregateTransitionContext
): boolean | Promise<boolean> {
  requireCondition(
    physicalAggregateNodeMatches(context.selectorResult, context.node),
    `Physical aggregate action ${context.actionId} did not retain its selected node.`
  );
  requireCondition(
    context.counterBefore === context.counterSnapshot &&
      physicalAggregateCounterSnapshotIsBounded(context.counterSnapshot),
    `Physical aggregate action ${context.actionId} rebased or invalidated its counter snapshot.`
  );
  requireCondition(
    typeof context.diagnostic === "string" &&
      Buffer.byteLength(context.diagnostic, "utf8") >= 1 &&
      Buffer.byteLength(context.diagnostic, "utf8") <= 4_096,
    `Physical aggregate action ${context.actionId} did not retain a bounded diagnostic.`
  );
  requireCondition(
    physicalAggregateCompletionIsGuarded(context.completed),
    `Physical aggregate action ${context.actionId} used an unguarded completion callback.`
  );
  return context.completed();
}

function physicalAggregateCompletionIsGuarded(
  completed: () => boolean | Promise<boolean>
): boolean {
  const source = Function.prototype.toString.call(completed);
  return (
    !/^\s*(?:async\s*)?(?:\(\s*\)|[A-Za-z_$][\w$]*)\s*=>\s*(?:true|Boolean\(\s*(?:true|1)\s*\)|1\s*===\s*1)\s*;?\s*$/u.test(
      source
    ) &&
    !/^\s*function\s*\(\s*\)\s*\{\s*return\s+(?:true|Boolean\(\s*(?:true|1)\s*\)|1\s*===\s*1)\s*;?\s*\}\s*$/u.test(
      source
    )
  );
}

const physicalAggregateActionDefinitions: readonly PhysicalAggregateActionDefinition[] =
  Object.freeze(
    physicalAggregateReachableActionIds.map((actionId) =>
      Object.freeze({
        actionId,
        canonicalInteractionIds: Object.freeze(
          physicalAggregateCanonicalIdsForAction(actionId)
        ),
        counterOracle: physicalAggregateCounterOwner,
        diagnosticOwner: physicalAggregateDiagnosticOwner,
        driver: physicalAggregateDriverForAction(actionId),
        maximumTaps: physicalAggregateMaximumTapsForAction(actionId),
        routeOwner: physicalAggregateRouteForAction(actionId),
        selectorWaiter: physicalAggregateSelectorOwner,
        task: physicalAggregateTaskForAction(actionId),
        transitionExecutor: physicalAggregateTransitionExecutor
      })
    )
  );

function physicalAggregateActionRegistryIsExact(
  definitions: readonly PhysicalAggregateActionDefinition[] =
    physicalAggregateActionDefinitions
): boolean {
  if (definitions.length !== physicalAggregateReachableActionIds.length) {
    return false;
  }
  if (!physicalAggregateCanonicalActionMapIsExact()) return false;
  const seen = new Set<PhysicalAggregateActionId>();
  for (const [index, entry] of definitions.entries()) {
    const expected = physicalAggregateReachableActionIds[index];
    if (
      expected === undefined ||
      entry.actionId !== expected ||
      seen.has(entry.actionId) ||
      !Object.isFrozen(entry) ||
      !Object.isFrozen(entry.canonicalInteractionIds) ||
      entry.canonicalInteractionIds.length !==
        physicalAggregateCanonicalIdsForAction(entry.actionId).length ||
      entry.canonicalInteractionIds.some(
        (interactionId, canonicalIndex) =>
          interactionId !==
          physicalAggregateCanonicalIdsForAction(entry.actionId)[canonicalIndex]
      ) ||
      entry.counterOracle !== physicalAggregateCounterOwner ||
      entry.diagnosticOwner !== physicalAggregateDiagnosticOwner ||
      entry.driver !== physicalAggregateDriverForAction(entry.actionId) ||
      entry.selectorWaiter !== physicalAggregateSelectorOwner ||
      entry.transitionExecutor !== physicalAggregateTransitionExecutor ||
      entry.maximumTaps !== physicalAggregateMaximumTapsForAction(entry.actionId) ||
      entry.routeOwner !== physicalAggregateRouteForAction(entry.actionId) ||
      entry.task !== physicalAggregateTaskForAction(entry.actionId) ||
      typeof entry.counterOracle !== "function" ||
      typeof entry.diagnosticOwner !== "function" ||
      typeof entry.selectorWaiter !== "function" ||
      typeof entry.transitionExecutor !== "function"
    ) {
      return false;
    }
    seen.add(entry.actionId);
  }
  return (
    seen.size === physicalAggregateReachableActionIds.length &&
    definitions.every(
      (entry) =>
        entry.selectorWaiter === physicalAggregateSelectorOwner &&
        entry.counterOracle === physicalAggregateCounterOwner &&
        entry.diagnosticOwner === physicalAggregateDiagnosticOwner &&
        entry.transitionExecutor === physicalAggregateTransitionExecutor
    )
  );
}

const physicalAggregateBaseExpectedActionIds = Object.freeze([
  "pairing-continue",
  "dashboard-bootstrap"
] satisfies readonly PhysicalAggregateActionId[]);
const physicalAggregatePairingExpectedActionIds = Object.freeze([
  ...physicalAggregateBaseExpectedActionIds,
  "pairing-open-host",
  "pairing-close-host"
] satisfies readonly PhysicalAggregateActionId[]);
const physicalAggregatePromptExpectedActionIds = Object.freeze([
  ...physicalAggregateBaseExpectedActionIds,
  "prompt-open-session",
  "prompt-editor",
  "prompt-send"
] satisfies readonly PhysicalAggregateActionId[]);
const physicalAggregateDashboardPromptExpectedActionIds = Object.freeze([
  "pairing-continue",
  "dashboard-bootstrap",
  "dashboard-expand-quiet",
  "dashboard-open-session",
  "approval-open",
  "approval-submit",
  "event-open-boundary",
  "event-close-boundary",
  "event-open-complete",
  "event-close-complete",
  "event-open-redacted",
  "event-close-redacted",
  "prompt-editor",
  "prompt-send"
] satisfies readonly PhysicalAggregateActionId[]);
const physicalAggregateRecoveryExpectedActionIds = Object.freeze([
  ...physicalAggregateBaseExpectedActionIds,
  "recovery-ready-open",
  "remote-check-recovery-ready",
  "recovery-ready-close",
  "profile-switch-away",
  "profile-away-refresh",
  "profile-switch-return",
  "profile-return-refresh",
  "recovery-return-open",
  "remote-check-recovery-return",
  "recovery-return-close"
] satisfies readonly PhysicalAggregateActionId[]);
const physicalAggregateDashboardExpectedActionPrefix = Object.freeze([
  ...physicalAggregateDashboardPromptExpectedActionIds,
  "stream-recovery-observe",
  "stream-reconnect-observe"
] satisfies readonly PhysicalAggregateActionId[]);

interface PhysicalAggregateDashboardExpectedActionOptions {
  readonly archiveQuietExpanded: boolean;
  readonly clipboardOutcome: "copied" | "unavailable";
  readonly detailQuietExpanded: boolean;
}

function physicalAggregateDashboardExpectedActionIdsFor(
  options: PhysicalAggregateDashboardExpectedActionOptions
): readonly PhysicalAggregateActionId[] {
  const resumeActions =
    options.clipboardOutcome === "copied"
      ? ([
          "resume-session-actions",
          "resume-open",
          "resume-copy",
          "clipboard-clear",
          "external-selected-clipboard"
        ] as const)
      : ([
          "resume-session-actions",
          "resume-open",
          "resume-copy",
          "resume-back",
          "resume-close-session"
        ] as const);
  return Object.freeze([
    ...physicalAggregateDashboardExpectedActionPrefix,
    ...(options.detailQuietExpanded
      ? (["detail-expand-quiet"] as const)
      : ([] as const)),
    "external-selected-not-found",
    "model-open",
    "model-select",
    "model-submit",
    "model-close",
    "model-reopen",
    "model-close-reopen",
    "goal-open",
    "goal-editor",
    "goal-save",
    "goal-close",
    "plan-open",
    "plan-select",
    "plan-submit",
    "plan-close",
    "plan-reopen",
    "plan-close-reopen",
    "utilities-open",
    "usage-open",
    "usage-back",
    "compact-open",
    "compact-begin",
    "compact-confirm",
    "compact-check",
    "compact-back",
    "skills-open",
    "skills-search",
    "skills-back",
    "utilities-close",
    ...resumeActions,
    "interrupt-session-actions",
    "interrupt-open",
    "interrupt-confirm",
    "interrupt-done",
    "host-session-actions",
    "host-open-nested",
    "remote-check-nested",
    "revoke-open",
    "revoke-confirm",
    "host-lock-open",
    "host-lock-confirm",
    "host-nested-close",
    "host-detail-back",
    "local-unlock",
    "unlocked-session-open",
    "dashboard-detail-back",
    "profile-switch-away",
    "profile-away-refresh",
    "profile-switch-return",
    "profile-return-refresh",
    "profile-global-open",
    "remote-check-profile",
    "profile-global-close",
    "runtime-incompatible-open",
    "remote-check-runtime-incompatible",
    "runtime-incompatible-close",
    "runtime-supported-open",
    "remote-check-runtime-supported",
    "runtime-supported-close",
    "talkback-open-session",
    "talkback-model-open",
    "talkback-model-close",
    "talkback-detail-back",
    ...(options.archiveQuietExpanded
      ? (["archive-expand-quiet"] as const)
      : ([] as const)),
    "archive-session-open",
    "archive-session-actions",
    "archive-open",
    "archive-confirm",
    "archive-result-back",
    "self-global-open",
    "self-revoke-open",
    "self-revoke-confirm"
  ] as readonly PhysicalAggregateActionId[]);
}

function createPhysicalAggregateActionRegistry(
  options: PhysicalAggregateActionRegistryOptions = {}
): PhysicalAggregateActionRegistry {
  requireCondition(
    physicalAggregateActionRegistryIsExact(),
    "Physical aggregate action registry definition was not exact."
  );
  const definitions = new Map(
    physicalAggregateActionDefinitions.map((entry) => [entry.actionId, entry])
  );
  const consumed = new Map<PhysicalAggregateActionId, number>();
  const tapped = new Map<PhysicalAggregateActionId, number>();
  const consumedOrder: PhysicalAggregateActionId[] = [];
  const readCounterSnapshot = (): Readonly<Record<string, number>> =>
    Object.freeze({
      registry_observation: 0,
      ...(options.counterSnapshot?.() ?? {})
    });
  const recordConsumedAction = (actionId: PhysicalAggregateActionId): void => {
    const count = (consumed.get(actionId) ?? 0) + 1;
    requireCondition(
      count <= 1,
      `Physical aggregate action ${actionId} exceeded its one-tap boundary.`
    );
    consumed.set(actionId, count);
    consumedOrder.push(actionId);
  };
  const consume = (
    actionId: PhysicalAggregateActionId,
    completed: () => boolean,
    message: string
  ): void => {
    const entry = definitions.get(actionId);
    requireCondition(entry !== undefined, "Unregistered physical aggregate action.");
    requireCondition(
      entry.driver === "observation" && entry.maximumTaps === 0,
      `Physical aggregate action ${actionId} requires a physical tap.`
    );
    requireCondition(
      (consumed.get(actionId) ?? 0) === 0,
      `Physical aggregate action ${actionId} exceeded its one-tap boundary.`
    );
    const node = physicalAggregateObservationOwnerNode(actionId);
    const context: PhysicalAggregateOwnerContext = Object.freeze({
      actionId,
      counterSnapshot: readCounterSnapshot(),
      currentNodes: Object.freeze([node]),
      node,
      routeOwner: entry.routeOwner
    });
    const selectorResult = entry.selectorWaiter(context);
    const counterBefore = entry.counterOracle(context);
    const diagnostic = entry.diagnosticOwner(context);
    const result = entry.transitionExecutor(
      Object.freeze({
        ...context,
        completed,
        counterBefore,
        diagnostic,
        selectorResult
      })
    );
    requireCondition(
      typeof result === "boolean" && result,
      `${message} (${diagnostic}).`
    );
    recordConsumedAction(actionId);
  };
  return Object.freeze({
    activate: async (
      actionId: PhysicalAggregateActionId,
      node: AndroidUiNode,
      activateOnce: () => void,
      completed: () => boolean | Promise<boolean>,
      message: string,
      timeoutMs = 30_000
    ) => {
      const definition = definitions.get(actionId);
      requireCondition(
        definition !== undefined &&
          definition.driver === "talkback" &&
          definition.maximumTaps === 1,
        `Physical aggregate action ${actionId} was not a registered TalkBack activation.`
      );
      requireCondition(
        (tapped.get(actionId) ?? 0) === 0,
        `Physical aggregate action ${actionId} exceeded its one-tap boundary.`
      );
      tapped.set(actionId, 1);
      const context: PhysicalAggregateOwnerContext = Object.freeze({
        actionId,
        counterSnapshot: readCounterSnapshot(),
        currentNodes: Object.freeze([node]),
        node,
        routeOwner: definition.routeOwner
      });
      const selectorResult = definition.selectorWaiter(context);
      requireCondition(
        physicalAggregateNodeMatches(selectorResult, node),
        `Physical aggregate action ${actionId} selector waiter did not retain the selected node.`
      );
      const counterBefore = definition.counterOracle(context);
      const diagnostic = definition.diagnosticOwner(context);
      const completeTransition = () =>
        definition.transitionExecutor(
          Object.freeze({
            ...context,
            completed,
            counterBefore,
            diagnostic,
            selectorResult
          })
        );
      activateOnce();
      await waitFor(completeTransition, timeoutMs, `${message} (${diagnostic}).`);
      recordConsumedAction(actionId);
    },
    consume,
    assertConsumed: (
      expectedActionIds?: readonly PhysicalAggregateActionId[]
    ) => {
      const expected = expectedActionIds ?? options.expectedActionIds;
      requireCondition(
        expected !== undefined && expected.length > 0,
        "Physical aggregate action registry expected-action contract was absent."
      );
      const expectedSet = new Set<PhysicalAggregateActionId>(expected);
      requireCondition(
        expectedSet.size === expected.length &&
          expected.every((actionId) => definitions.has(actionId)),
        "Physical aggregate action registry expected-action contract was invalid."
      );
      requireCondition(
        consumed.size === expectedSet.size &&
          [...expectedSet].every((actionId) => consumed.get(actionId) === 1) &&
          [...consumed.keys()].every((actionId) => expectedSet.has(actionId)),
        "Physical aggregate action registry consumption was invalid."
      );
      requireCondition(
        consumedOrder.length === expected.length &&
          consumedOrder.every((actionId, index) => actionId === expected[index]),
        "Physical aggregate action registry execution order was invalid."
      );
      requireCondition(
        [...tapped.entries()].every(([actionId, count]) => {
          const definition = definitions.get(actionId);
          return definition !== undefined &&
            definition.driver !== "observation" &&
            definition.maximumTaps === 1 &&
            count === definition.maximumTaps &&
            expectedSet.has(actionId);
        }),
        "Physical aggregate action registry tap multiplicity was invalid."
      );
    },
    tap: async (
      actionId: PhysicalAggregateActionId,
      node: AndroidUiNode,
      completed: () => boolean | Promise<boolean>,
      message: string | (() => string),
      candidateOptions: number | PhysicalAggregateTapOptions = 30_000
    ) => {
      const tapOptions: PhysicalAggregateTapOptions =
        typeof candidateOptions === "number"
          ? Object.freeze({ timeoutMs: candidateOptions })
          : candidateOptions;
      const timeoutMs = tapOptions.timeoutMs ?? 30_000;
      requireCondition(
        Number.isSafeInteger(timeoutMs) && timeoutMs > 0,
        `Physical aggregate action ${actionId} had an invalid timeout.`
      );
      const definition = definitions.get(actionId);
      requireCondition(
        definition !== undefined &&
          definition.driver === "android_node" &&
          definition.maximumTaps === 1,
        `Physical aggregate action ${actionId} was not a registered tap.`
      );
      requireCondition(
        (tapped.get(actionId) ?? 0) === 0,
        `Physical aggregate action ${actionId} exceeded its one-tap boundary.`
      );
      tapped.set(actionId, 1);
      const currentNodes =
        options.readNodes === undefined
          ? Object.freeze([node])
          : Object.freeze([...(await options.readNodes())]);
      const context: PhysicalAggregateOwnerContext = Object.freeze({
        actionId,
        counterSnapshot: readCounterSnapshot(),
        currentNodes,
        node,
        routeOwner: definition.routeOwner
      });
      const selectorResult = definition.selectorWaiter(context);
      requireCondition(
        physicalAggregateNodeMatches(selectorResult, node),
        `Physical aggregate action ${actionId} selector waiter did not retain the selected node.`
      );
      const counterBefore = definition.counterOracle(context);
      const diagnostic = definition.diagnosticOwner(context);
      const completeTransition = () => {
        const transitionContext: PhysicalAggregateTransitionContext =
          Object.freeze({
            ...context,
            completed,
            counterBefore,
            diagnostic,
            selectorResult
          });
        return definition.transitionExecutor(transitionContext);
      };
      if (tapOptions.beforeTap !== undefined) {
        const result = tapOptions.beforeTap(context);
        requireCondition(
          result === undefined,
          `Physical aggregate action ${actionId} used an asynchronous pre-tap guard.`
        );
      }
      if (options.tapNodeOnceAndWait === undefined) {
        await tapAndroidNodeOnceAndWait(
          node,
          completeTransition,
          message,
          timeoutMs
        );
      } else {
        await options.tapNodeOnceAndWait(
          node,
          completeTransition,
          message,
          timeoutMs
        );
      }
      recordConsumedAction(actionId);
    }
  });
}

function physicalAggregateImplementationSource(source: string): string | null {
  const marker = "\ninterface PairingRenderCapture {\n";
  const start = source.lastIndexOf(marker);
  return start < 0 ? null : source.slice(start + 1);
}

function physicalAggregateCallGraphIsExact(source: string): boolean {
  const implementation = physicalAggregateImplementationSource(source);
  if (implementation === null) return false;
  const directUiTapCalls = [...implementation.matchAll(/\btapAndroidUiNode\(/gu)];
  const oneTapHelperCalls = [
    ...implementation.matchAll(/\btapAndroidNodeOnceAndWait\(/gu)
  ];
  const rawAndroidTapCalls = [
    ...implementation.matchAll(
      /adb\(\[\s*"shell"\s*,\s*"input"\s*,\s*"tap"\s*,/gu
    )
  ];
  const talkBackDoubleTapCalls = [
    ...implementation.matchAll(/\brunPhysicalTalkBackDoubleTap\(/gu)
  ];
  const oneTapHelperStart = implementation.indexOf(
    "async function tapAndroidNodeOnceAndWait" + "(\n"
  );
  const oneTapHelperEnd = implementation.indexOf(
    "\nasync function closePhysicalDialog" + "(\n",
    oneTapHelperStart
  );
  const oneTapHelper =
    oneTapHelperStart < 0 || oneTapHelperEnd <= oneTapHelperStart
      ? ""
      : implementation.slice(oneTapHelperStart, oneTapHelperEnd);
  const talkBackActivationHelperStart = implementation.indexOf(
    "async function activatePhysicalTalkBackFocus" + "(\n"
  );
  const talkBackActivationHelperEnd = implementation.indexOf(
    "\nfunction physicalTalkBackClickMatchesFocus" + "(\n",
    talkBackActivationHelperStart
  );
  const talkBackActivationHelper =
    talkBackActivationHelperStart < 0 ||
      talkBackActivationHelperEnd <= talkBackActivationHelperStart
      ? ""
      : implementation.slice(
          talkBackActivationHelperStart,
          talkBackActivationHelperEnd
        );
  return (
    directUiTapCalls.length === 2 &&
    oneTapHelperCalls.length === 1 &&
    rawAndroidTapCalls.length === 1 &&
    talkBackDoubleTapCalls.length === 2 &&
    oneTapHelper.includes("tapAndroidUiNode(node);") &&
    talkBackActivationHelper.match(/\brunPhysicalTalkBackDoubleTap\(/gu)
      ?.length === 1 &&
    /function tapAndroidUiNode\(node: AndroidUiNode\): void/u.test(
      implementation
    ) &&
    !/\(\s*\)\s*=>\s*(?:true|Boolean\(\s*(?:true|1)\s*\)|1\s*===\s*1)(?=\s*[,;)\n])/u.test(
      implementation
    ) &&
    !/\b(?:[A-Za-z]+Requests|[A-Za-z]+Subscribers|[A-Za-z]+Calls)\s*(?:>=|<=|>|<)\s*\d/u.test(
      implementation
    )
  );
}

interface PairingRenderCapture {
  link: string | null;
  qrImage: Buffer | null;
}

interface PhysicalRuntimeContext {
  readonly remote: HostDeckRemoteIngressLifecycle;
}

interface PhysicalGatedClaimAdmissionRemote {
  readonly control: Readonly<{
    readonly readStatus: () => Promise<unknown>;
  }>;
  readonly readAdmission: () => Readonly<{
    readonly admission: "closed" | "open";
    readonly external_origin: string | null;
    readonly generation: number;
  }>;
  readonly requestAuthority: Readonly<{
    readonly snapshot: () => Readonly<{
      readonly active_leases: number;
      readonly generation: number;
      readonly invalidations: number;
      readonly phase: "closed" | "open";
      readonly signaled_leases: number;
    }>;
  }>;
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

async function refreshPhysicalGatedClaimAdmission(input: Readonly<{
  readonly expectedExternalOrigin: string;
  readonly remote: PhysicalGatedClaimAdmissionRemote;
}>): Promise<void> {
  const before = input.remote.requestAuthority.snapshot();
  requireCondition(
    before.phase === "open" && before.active_leases === 1,
    physicalGatedClaimAdmissionFailure
  );
  try {
    await input.remote.control.readStatus();
  } catch (error) {
    throw new Error(physicalGatedClaimRefreshFailure, { cause: error });
  }
  const admission = input.remote.readAdmission();
  const after = input.remote.requestAuthority.snapshot();
  requireCondition(
    admission.admission === "open" &&
      admission.external_origin === input.expectedExternalOrigin &&
      admission.generation === before.generation &&
      after.phase === "open" &&
      after.active_leases === 1 &&
      after.generation === before.generation &&
      after.invalidations === before.invalidations &&
      after.signaled_leases === before.signaled_leases,
    physicalGatedClaimAdmissionFailure
  );
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

interface PhysicalDashboardPackageIdentity {
  readonly content_entry_count: number;
  readonly content_tree_sha256: string;
  readonly manifest_sha256: string;
  readonly output_file_count: number;
  readonly output_tree_sha256: string;
  readonly package_schema_version: 4;
  readonly package_version: "0.0.0";
  readonly source_file_count: number;
  readonly source_tree_sha256: string;
  readonly web_manifest_sha256: string;
  readonly web_tree_sha256: string;
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
    if (
      request.method === "GET" &&
      request.url === `/api/v1/sessions/${physicalUiSessionId}/skills`
    ) {
      inspection.skillsRequests += 1;
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
    if (
      request.method === "GET" &&
      request.url === `/api/v1/sessions/${physicalUiSessionId}/skills`
    ) {
      recordPhysicalResponseStatus(
        inspection.skillsResponseStatuses,
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
        timeout: physicalTailscaleCommandTimeoutMs,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        const rawExitCode = error === null ? 0 : Reflect.get(error, "code");
        if (typeof rawExitCode !== "number") {
          reject(new Error(physicalTailscaleCommandFailureMessage(error)));
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

function physicalTailscaleCommandFailureMessage(error: unknown): string {
  return error !== null &&
    typeof error === "object" &&
    Reflect.get(error, "killed") === true
    ? "Physical Tailscale command timed out."
    : "Physical Tailscale command failed.";
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
    const completion = await adbAsync(ping, "tailnet_ping");
    return physicalAsyncAdbTailnetPingPassed(completion);
  }, 30_000, "Physical Android could not establish a cellular Tailscale peer path.");
  await waitFor(async () => {
    const completion = await adbAsync(probe, "private_https_probe");
    return physicalAsyncAdbPrivateHttpsProbePassed(completion);
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

function adbAsync(
  args: readonly string[],
  operation: PhysicalAsyncAdbOperation
): Promise<PhysicalAsyncAdbCompletion> {
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
        try {
          resolve(
            classifyPhysicalAsyncAdbCompletion(
              operation,
              error,
              stdout,
              stderr
            )
          );
        } catch (failure) {
          reject(failure);
        }
      }
    );
  });
}

function classifyPhysicalAsyncAdbCompletion(
  operation: PhysicalAsyncAdbOperation,
  error: PhysicalAsyncAdbErrorShape | null,
  stdout: string,
  stderr: string
): PhysicalAsyncAdbCompletion {
  const label = physicalAsyncAdbOperationLabels[operation];
  requireCondition(
    typeof label === "string",
    "Physical asynchronous ADB operation was invalid."
  );
  requireCondition(
    Buffer.byteLength(stdout, "utf8") <= 512 * 1024 &&
      Buffer.byteLength(stderr, "utf8") <= 512 * 1024 &&
      !stdout.includes("\u0000") &&
      !stderr.includes("\u0000"),
    `Physical asynchronous ADB ${label} output was invalid or private.`
  );
  if (error !== null && physicalAsyncAdbTransportFailed(stderr)) {
    throw new Error(`Physical asynchronous ADB ${label} lost device transport.`);
  }
  requireCondition(
    [...deviceForbiddenValues].every(
      (value) => !stdout.includes(value) && !stderr.includes(value)
    ),
    `Physical asynchronous ADB ${label} output was invalid or private.`
  );
  if (error === null) {
    return Object.freeze({ operation, status: 0, stdout });
  }
  if (error.killed === true || error.signal !== null && error.signal !== undefined) {
    throw new Error(`Physical asynchronous ADB ${label} was terminated.`);
  }
  if (
    typeof error.code === "number" &&
    Number.isSafeInteger(error.code) &&
    error.code >= 1 &&
    error.code <= 255
  ) {
    return Object.freeze({ operation, status: error.code, stdout });
  }
  if (typeof error.code === "string") {
    throw new Error(`Physical asynchronous ADB ${label} could not start.`);
  }
  throw new Error(
    `Physical asynchronous ADB ${label} returned an invalid completion.`
  );
}

function physicalAsyncAdbTransportFailed(stderr: string): boolean {
  return /(?:^|\n)(?:adb:|error:)\s+(?:device(?:\s+'[^'\r\n]{1,128}')?\s+(?:not found|offline|unauthorized)|more than one device\/emulator|no devices\/emulators found)(?:\.|\r?$)/imu.test(
    stderr
  );
}

function physicalAsyncAdbTailnetPingPassed(
  completion: PhysicalAsyncAdbCompletion
): boolean {
  return (
    completion.operation === "tailnet_ping" &&
    completion.status === 0 &&
    Buffer.byteLength(completion.stdout, "utf8") <= 16 * 1024 &&
    completion.stdout.includes("1 received")
  );
}

function physicalAsyncAdbPrivateHttpsProbePassed(
  completion: PhysicalAsyncAdbCompletion
): boolean {
  return (
    completion.operation === "private_https_probe" &&
    completion.status === 0 &&
    completion.stdout === ""
  );
}

function physicalAsyncAdbUiHierarchyOutput(
  completion: PhysicalAsyncAdbCompletion
): string {
  requireCondition(
    completion.operation === "ui_hierarchy" && completion.status === 0,
    "Physical asynchronous ADB UI hierarchy read exited unsuccessfully."
  );
  return completion.stdout;
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
  const result = adbWithStatus(["shell", "ps", "-A", "-o", "NAME"]);
  return readChromePackageProcessState(
    result.status,
    result.stdout,
    result.stderr
  ) === "stopped";
}

async function stopPhysicalAndroidChrome(): Promise<void> {
  adb(physicalAndroidChromeStopCommandPlan[0]);
  await new Promise((resolve) => setTimeout(resolve, 250));
  adb(physicalAndroidChromeStopCommandPlan[1]);
  await waitForSettledChromeAbsence();
}

interface PhysicalChromeAbsenceRuntime {
  readonly now: () => number;
  readonly observe: () => boolean;
  readonly sleep: (delayMs: number) => Promise<void>;
}

async function waitForSettledChromeAbsence(
  runtime: PhysicalChromeAbsenceRuntime = {
    now: () => performance.now(),
    observe: () => isChromeStopped(),
    sleep: (delayMs) =>
      new Promise((resolve) => setTimeout(resolve, delayMs))
  }
): Promise<void> {
  const startedAt = runtime.now();
  const deadline = startedAt + physicalAndroidChromeStopTimeoutMs;
  let absentSince: number | null = null;
  let previousNow = startedAt;
  while (true) {
    const now = runtime.now();
    requireCondition(
      Number.isFinite(now) && now >= previousNow,
      "Physical Android Chrome cleanup clock was invalid."
    );
    previousNow = now;
    if (runtime.observe()) {
      absentSince ??= now;
      if (now - absentSince >= physicalAndroidChromeAbsenceSettleMs) return;
    } else {
      absentSince = null;
    }
    if (now >= deadline) break;
    await runtime.sleep(
      Math.min(physicalAndroidChromeProcessPollMs, deadline - now)
    );
  }
  throw new Error(
    "Physical Android Chrome did not remain fully stopped for 30 continuous seconds."
  );
}

function readChromePackageProcessState(
  status: number,
  stdout: string,
  stderr: string
): "running" | "stopped" {
  const output = stdout.trimEnd();
  const error = stderr.trim();
  const lines = output.split(/\r?\n/u).map((line) => line.trim());
  requireCondition(
    status === 0 &&
      error === "" &&
      output.length <= 256 * 1024 &&
      lines.length >= 2 &&
      lines.length <= 4_096 &&
      lines[0] === "NAME" &&
      lines.slice(1).every(
        (name) =>
          name.length >= 1 &&
          name.length <= 256 &&
          !hasControlCharacters(name)
      ),
    "Android Chrome process state was invalid."
  );
  return lines.slice(1).some(
    (name) =>
      name === "com.android.chrome" ||
      name.startsWith("com.android.chrome:")
  )
    ? "running"
    : "stopped";
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
  readonly checked?: true;
  readonly clickable: boolean;
  readonly description: string;
  readonly enabled?: false;
  readonly focused?: true;
  readonly resourceId: string;
  readonly selected?: true;
  readonly text: string;
}

interface PhysicalApprovalRespondingDialogOwner {
  readonly action: AndroidUiNode;
  readonly approve: AndroidUiNode;
  readonly cancel: AndroidUiNode;
  readonly close: AndroidUiNode;
  readonly reason: AndroidUiNode;
  readonly risk: AndroidUiNode;
  readonly scope: AndroidUiNode;
  readonly status: AndroidUiNode;
  readonly title: AndroidUiNode;
}

interface PhysicalApprovalTerminalOwner {
  readonly action: AndroidUiNode;
  readonly detail: AndroidUiNode;
  readonly scope: AndroidUiNode;
  readonly status: AndroidUiNode;
}

interface PhysicalApprovalCheckpointInput {
  readonly actualNavigation: PhysicalSessionNavigationSnapshot;
  readonly approvalCalls: number;
  readonly approvalCallsBefore: number;
  readonly expectedNavigation: PhysicalSessionNavigationSnapshot;
  readonly nodes: readonly AndroidUiNode[];
  readonly pending: boolean;
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

interface PhysicalEventDiagnosticAuthoritySnapshot {
  readonly navigation: PhysicalSessionNavigationSnapshot;
  readonly sessionEventRequests: number;
}

interface PhysicalEventDiagnosticWaitSource {
  readonly readAuthority: () => PhysicalEventDiagnosticAuthoritySnapshot;
  readonly readNodes: () => Promise<readonly AndroidUiNode[]>;
  readonly swipe: (
    nodes: readonly AndroidUiNode[],
    direction: AndroidVerticalRevealDirection
  ) => void;
}

interface PhysicalEventDiagnosticWaitOptions {
  readonly now?: (() => number) | undefined;
  readonly sleep?: ((milliseconds: number) => Promise<void>) | undefined;
}

type PhysicalEventDiagnosticSheetState =
  | "absent"
  | "current"
  | "failure"
  | "invalid"
  | "loading"
  | "local_only"
  | "open"
  | "retained";

interface PhysicalEventDiagnosticOutcomeInput {
  readonly actualAuthority: PhysicalEventDiagnosticAuthoritySnapshot;
  readonly baselineAuthority: PhysicalEventDiagnosticAuthoritySnapshot;
  readonly heading: string;
  readonly limitation: string;
  readonly nodes: readonly AndroidUiNode[];
  readonly target: PhysicalEventDiagnosticTarget;
  readonly timelineLabel: string;
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
  readonly actionRegistry: PhysicalAggregateActionRegistry;
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

  const accessTrigger = await waitForPhysicalSelectedNode(
    (nodes) => selectPhysicalMissionControlAction(nodes, "Open Host and access"),
    30_000,
    "Production Host and access trigger was unavailable on Android."
  );
  await input.actionRegistry.tap(
    "pairing-open-host",
    accessTrigger,
    async () => selectPhysicalHostAccessCloseAction(await readAndroidUiNodes(), "global") !== null,
    "Production Host and access sheet did not open on Android."
  );
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

  const closeAccess = await waitForPhysicalSelectedNode(
    (nodes) => selectPhysicalHostAccessCloseAction(nodes, "global"),
    30_000,
    "Production Host and access close control was unavailable on Android."
  );
  await input.actionRegistry.tap(
    "pairing-close-host",
    closeAccess,
    async () => {
      const nodes = await readAndroidUiNodes();
      return (
        selectPhysicalHostAccessContentRegion(nodes, "global") === null &&
        selectPhysicalMissionControlDestination(nodes) !== null
      );
    },
    "Production Host and access sheet did not close on Android."
  );
  const requestsBeforeReload = Object.freeze({
    access: input.requestInspection.accessRequests,
    csrf: input.requestInspection.csrfRequests,
    host: input.requestInspection.hostStatusRequests,
    sessions: input.requestInspection.sessionListRequests
  });
  adb(["shell", "input", "keyevent", "KEYCODE_REFRESH"]);
  await waitForPhysicalMissionControlReloadSettlement(
    {
      readNodes: readAndroidUiNodes,
      readRequests: () =>
        readPhysicalMissionControlRequestSnapshot(input.requestInspection)
    },
    Object.freeze({
      accessRequests: requestsBeforeReload.access,
      hostStatusRequests: requestsBeforeReload.host,
      sessionListRequests: requestsBeforeReload.sessions
    }),
    45_000,
    "Fragment-free Android reload did not restore ordinary app authority."
  );
  requireCondition(
    input.requestInspection.claimRequests === 1 &&
      input.requestInspection.csrfRequests === requestsBeforeReload.csrf + 1 &&
      input.requestInspection.accessRequests === requestsBeforeReload.access + 1 &&
      input.requestInspection.hostStatusRequests === requestsBeforeReload.host + 1 &&
      input.requestInspection.sessionListRequests === requestsBeforeReload.sessions + 1 &&
      input.requestInspection.noReferrerApiRequests === 3 &&
      input.requestInspection.fragmentLeaks === 0,
    "Production Android reload repeated pairing or produced unbounded route work."
  );
  await capturePhysicalScreenshot(
    join(input.screenshotDirectory, "fe013-04-reloaded.png")
  );

  await cleanProductionUiAuthority(input);
  input.actionRegistry.assertConsumed(physicalAggregatePairingExpectedActionIds);
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
  } catch (error) {
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
      }),
      { cause: error }
    );
  }
  await waitForPhysicalSelectedNode(
    (nodes) =>
      selectPhysicalChromePageText(nodes, "Phone paired") === null
        ? null
        : selectPhysicalChromePageAction(nodes, "text", "Open Mission Control"),
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
  const requestsBeforeContinue = readPhysicalMissionControlRequestSnapshot(
    input.requestInspection
  );
  const stableContinueButton = await waitForStablePhysicalPairingContinuation(
    Object.freeze({
      readNodes: readAndroidUiNodes,
      readRequests: () =>
        readPhysicalMissionControlRequestSnapshot(input.requestInspection)
    }),
    requestsBeforeContinue,
    30_000,
    "Production pairing continuation did not remain stable after evidence capture."
  );
  await continueFromPairingUi(
    input.actionRegistry,
    stableContinueButton,
    input.requestInspection,
    requestsBeforeContinue
  );
  try {
    await waitForPhysicalMissionControlRouteReady(
      input.requestInspection,
      requestsBeforeContinue,
      "Production Mission Control did not load its authenticated route data."
    );
  } catch (error) {
    throw new Error(
      missionControlRouteFailure(
        input.requestInspection,
        input.readProxyRejection()
      ),
      { cause: error }
    );
  }
  try {
    await waitForPhysicalSelectedNode(
      initialViewport === "dashboard_attention"
        ? (nodes) =>
            selectPhysicalChromePageText(
              nodes,
              missionControlInitialViewportText(initialViewport)
            )
        : selectPhysicalMissionControlSession,
      30_000,
      "Production Mission Control did not render its authenticated first viewport."
    );
  } catch (error) {
    throw new Error(
      missionControlRouteFailure(
        input.requestInspection,
        input.readProxyRejection()
      ),
      { cause: error }
    );
  }
  const missionControlNodes = await readAndroidUiNodes();
  input.actionRegistry.consume(
    "dashboard-bootstrap",
    () =>
      physicalMissionControlRequestOpened(
        readPhysicalMissionControlRequestSnapshot(input.requestInspection),
        requestsBeforeContinue
      ) &&
      selectPhysicalMissionControlDestination(missionControlNodes) !== null &&
      (initialViewport === "dashboard_attention"
        ? selectPhysicalChromePageText(
            missionControlNodes,
            missionControlInitialViewportText(initialViewport)
          ) !== null
        : selectPhysicalMissionControlSession(missionControlNodes) !== null),
    "Production Mission Control bootstrap did not retain one exact loaded shell generation."
  );
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

function physicalQuietQueueDisclosureState(
  nodes: readonly AndroidUiNode[]
): "collapsed" | "expanded" {
  const collapsed = nodes.filter(
    (node) =>
      matchesAndroidUiNode(
        node,
        "description",
        physicalQuietQueueDisclosureLabel(false)
      ) &&
      node.clickable &&
      node.enabled !== false
  );
  const expanded = nodes.filter(
    (node) =>
      matchesAndroidUiNode(
        node,
        "description",
        physicalQuietQueueDisclosureLabel(true)
      ) &&
      node.clickable &&
      node.enabled !== false
  );
  requireCondition(
    collapsed.length + expanded.length === 1,
    "Physical quiet-session disclosure state was invalid."
  );
  return collapsed.length === 1 ? "collapsed" : "expanded";
}

type PhysicalNodeSelector = (
  nodes: readonly AndroidUiNode[]
) => AndroidUiNode | null;

async function waitForPhysicalSelectedNode(
  selector: PhysicalNodeSelector,
  timeoutMs: number,
  message: string,
  summary: (nodes: readonly AndroidUiNode[], selected: AndroidUiNode | null) => string = (
    nodes,
    selected
  ) =>
    `matches=${selected === null ? "none" : androidUiNodeGeometry(selected)};` +
    `nodes=${Math.min(nodes.length, 64)}`
): Promise<AndroidUiNode> {
  let selected: AndroidUiNode | null = null;
  const observations: string[] = [];
  try {
    await waitFor(async () => {
      const nodes = await readAndroidUiNodes();
      selected = selector(nodes);
      const observation = summary(nodes, selected);
      if (observations.at(-1) !== observation && observations.length < 6) {
        observations.push(observation);
      }
      return selected !== null;
    }, timeoutMs, message);
  } catch (error) {
    throw new Error(`${message} (states=${observations.join("||") || "none"}).`, {
      cause: error
    });
  }
  requireCondition(selected !== null, message);
  return selected;
}

function selectPhysicalChromePageAction(
  nodes: readonly AndroidUiNode[],
  field: AndroidUiNodeField,
  value: string
): AndroidUiNode | null {
  let page: PhysicalScreenshotRegion;
  try {
    page = selectChromePageViewport(nodes);
  } catch {
    return null;
  }
  const matches = nodes.filter((node) => matchesAndroidUiNode(node, field, value));
  if (matches.length !== 1) return null;
  const node = matches[0];
  return node?.clickable &&
    node.enabled !== false &&
    androidUiNodeIsFullyInsideRegion(node, page)
    ? node
    : null;
}

function selectPhysicalChromePageText(
  nodes: readonly AndroidUiNode[],
  text: string
): AndroidUiNode | null {
  let page: PhysicalScreenshotRegion;
  try {
    page = selectChromePageViewport(nodes);
  } catch {
    return null;
  }
  const matches = nodes.filter(
    (node) =>
      node.text === text &&
      !node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsFullyInsideRegion(node, page)
  );
  return matches.length === 1 ? matches[0] ?? null : null;
}

function selectPhysicalMissionControlShell(
  nodes: readonly AndroidUiNode[]
): PhysicalScreenshotRegion | null {
  let page: PhysicalScreenshotRegion;
  try {
    page = selectChromePageViewport(nodes);
  } catch {
    return null;
  }
  const titles = nodes.filter(
    (node) =>
      node.text === "Mission Control" &&
      !node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsFullyInsideRegion(node, page)
  );
  if (titles.length !== 1) return null;
  const actionDescriptions = [
    "Open Host and access",
    "Refresh sessions"
  ] as const;
  if (
    actionDescriptions.some(
      (description) =>
        nodes.filter(
          (node) =>
            node.description === description &&
            node.clickable &&
            node.enabled !== false &&
            androidUiNodeIsFullyInsideRegion(node, page)
        ).length !== 1
    )
  ) {
    return null;
  }
  const quietDisclosureMatches = nodes.filter(
    (node) =>
      (node.description === physicalQuietQueueDisclosureLabel(false) ||
        node.description === physicalQuietQueueDisclosureLabel(true)) &&
      node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsFullyInsideRegion(node, page)
  );
  if (quietDisclosureMatches.length !== 1) return null;
  return page;
}

function selectPhysicalMissionControlDestination(
  nodes: readonly AndroidUiNode[]
): PhysicalScreenshotRegion | null {
  const shell = selectPhysicalMissionControlShell(nodes);
  if (shell === null) return null;
  const retainedControlDescriptions = new Set([
    "Back to Mission Control",
    "Close session actions",
    "Back to session actions",
    "Back to session utilities",
    "Back to sessions",
    "Done"
  ]);
  const structuralSheetTitles = new Set([
    ...physicalFixedSheetOwnerTitles,
    "Confirm context compaction",
    "Interrupt active turn?",
    "Lock remote writes?",
    "Revoke paired device?",
    "Revoke this phone?"
  ]);
  if (
    nodes.some(
      (node) =>
        structuralSheetTitles.has(node.text) &&
        androidUiNodeIsFullyInsideRegion(node, shell)
    )
  ) {
    return null;
  }
  const terminalMarkers = new Set([
    "Turn interrupted",
    "Session archived",
    "Done"
  ]);
  const retainedControls = nodes.filter(
    (node) =>
      retainedControlDescriptions.has(node.description) &&
      androidUiNodeIsFullyInsideRegion(node, shell)
  );
  const terminalActions = nodes.filter(
    (node) =>
      node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsFullyInsideRegion(node, shell) &&
      (node.text === "Back to sessions" ||
        node.text === "Done" ||
        terminalMarkers.has(node.description))
  );
  const terminalMarker = nodes.some(
    (node) =>
      terminalMarkers.has(node.text) &&
      !node.clickable &&
      androidUiNodeIsFullyInsideRegion(node, shell)
  );
  return retainedControls.length === 0 &&
    !(terminalMarker && terminalActions.length > 0)
    ? shell
    : null;
}

function selectPhysicalMissionControlAction(
  nodes: readonly AndroidUiNode[],
  description: string
): AndroidUiNode | null {
  const page = selectPhysicalMissionControlDestination(nodes);
  return page === null
    ? null
    : selectPhysicalChromePageAction(nodes, "description", description);
}

function selectPhysicalMissionControlSession(
  nodes: readonly AndroidUiNode[]
): AndroidUiNode | null {
  return selectPhysicalMissionControlAction(nodes, physicalUiSessionName);
}

function selectPhysicalMissionControlRefresh(
  nodes: readonly AndroidUiNode[]
): AndroidUiNode | null {
  return selectPhysicalMissionControlAction(nodes, "Refresh sessions");
}

function selectPhysicalQuietQueueDisclosure(
  nodes: readonly AndroidUiNode[],
  open: boolean
): AndroidUiNode | null {
  if (selectPhysicalMissionControlDestination(nodes) === null) return null;
  return selectPhysicalChromePageAction(
    nodes,
    "description",
    physicalQuietQueueDisclosureLabel(open)
  );
}

function selectPhysicalSessionDockAction(
  nodes: readonly AndroidUiNode[],
  activeSubscribers: number,
  description: string
): AndroidUiNode | null {
  if (selectPhysicalSessionActionsTrigger(nodes, activeSubscribers) === null) {
    return null;
  }
  return selectPhysicalChromePageAction(nodes, "description", description);
}

function selectPhysicalSessionDetailBack(
  nodes: readonly AndroidUiNode[],
  activeSubscribers: number
): AndroidUiNode | null {
  if (selectPhysicalSessionActionsTrigger(nodes, activeSubscribers) === null) {
    return null;
  }
  return selectPhysicalChromePageAction(nodes, "description", "Back to Mission Control");
}

function selectPhysicalSessionActionsMenuAction(
  nodes: readonly AndroidUiNode[],
  description: string
): AndroidUiNode | null {
  const header = selectPhysicalFixedSheetHeader(nodes, "Session actions");
  if (header === null) return null;
  const selected = nodes.filter(
    (node) =>
      node.description === description &&
      node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsFullyInsideRegion(node, header.body)
  );
  return selected.length === 1 ? selected[0] ?? null : null;
}

function selectPhysicalSessionActionsMenuRoot(
  nodes: readonly AndroidUiNode[]
): AndroidUiNode | null {
  return selectPhysicalFixedSheetHeader(nodes, "Session actions")?.title ?? null;
}

interface PhysicalFixedSheetHeader {
  readonly body: PhysicalScreenshotRegion;
  readonly close: AndroidUiNode;
  readonly page: PhysicalScreenshotRegion;
  readonly title: AndroidUiNode;
}

const physicalFixedSheetCloseDescriptions: Readonly<Record<string, string>> =
  Object.freeze({
    "/goal": "Close goal control",
    "/model": "Close model control",
    "/plan": "Close Plan control",
    "Event details": "Close event details",
    "Session actions": "Close session actions",
    "Session utilities": "Close session utilities"
  });

const physicalFixedSheetOwnerTitles = new Set([
  "/goal",
  "/model",
  "/plan",
  "/compact",
  "/skills",
  "/usage",
  "Archive result",
  "Archive session?",
  "Event details",
  "Host & access",
  "Interrupt result",
  "Resume on laptop",
  "Session actions",
  "Session utilities"
]);

const physicalSessionActionsModeTitles = new Set([
  "Archive blocked",
  "Archive not completed",
  "Archive outcome not confirmed",
  "Archive session",
  "Archive session?",
  "Archive state inconsistent",
  "Interrupt active turn",
  "Interrupt active turn?",
  "Interrupt blocked",
  "Interrupt state inconsistent",
  "Outcome not confirmed",
  "Secure archive setup unavailable",
  "Secure interrupt setup unavailable",
  "Session archived",
  "Turn completed",
  "Turn ended as interrupted",
  "Turn failed",
  "Turn interrupted"
]);

const physicalModalConfirmationTitles = new Set([
  "Lock remote writes?",
  "Revoke paired device?",
  "Revoke this phone?"
]);

const physicalOwnedHeaderTitles = new Set([
  ...physicalFixedSheetOwnerTitles,
  ...physicalSessionActionsModeTitles,
  ...physicalModalConfirmationTitles
]);

const physicalOwnedHeaderCloseDescriptions = new Set([
  ...Object.values(physicalFixedSheetCloseDescriptions),
  "Close Compact utility",
  "Close Host and access",
  "Close Skills utility",
  "Close Usage utility",
  "Close device revocation",
  "Close remote write lock confirmation"
]);

const physicalOwnedHeaderBackDescriptions = new Set([
  "Back to session actions",
  "Back to session utilities"
]);

function selectPhysicalFixedSheetHeader(
  nodes: readonly AndroidUiNode[],
  ownerTitle: string
): PhysicalFixedSheetHeader | null {
  const closeDescription = physicalFixedSheetCloseDescriptions[ownerTitle];
  if (closeDescription === undefined) return null;
  let page: PhysicalScreenshotRegion;
  try {
    page = selectChromePageViewport(nodes);
  } catch {
    return null;
  }
  const titles = nodes.filter(
    (node) =>
      node.text === ownerTitle &&
      !node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsWebText(node) &&
      androidUiNodeWidth(node) >= 48 &&
      androidUiNodeHeight(node) >= 16 &&
      androidUiNodeIsFullyInsideRegion(node, page)
  );
  const closes = nodes.filter(
    (node) =>
      node.description === closeDescription &&
      node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsFullyInsideRegion(node, page)
  );
  if (titles.length !== 1 || closes.length !== 1) return null;
  const title = titles[0];
  const close = closes[0];
  if (title === undefined || close === undefined) return null;
  const competingTitles = nodes.filter(
    (node) =>
      node.text !== ownerTitle &&
      physicalOwnedHeaderTitles.has(node.text) &&
      physicalOwnedHeaderTitleIsEligible(node, page) &&
      physicalOwnedHeaderIsCoherent(node, null, close)
  );
  const competingCloses = nodes.filter(
    (node) =>
      node.description !== closeDescription &&
      physicalOwnedHeaderCloseDescriptions.has(node.description) &&
      node.clickable &&
      androidUiNodeIsFullyInsideRegion(node, page)
  );
  if (competingTitles.length !== 0 || competingCloses.length !== 0) return null;
  const titleCenterX = Math.floor((title.bounds.left + title.bounds.right) / 2);
  const closeCenterX = Math.floor((close.bounds.left + close.bounds.right) / 2);
  const titleCenterY = Math.floor((title.bounds.top + title.bounds.bottom) / 2);
  const closeCenterY = Math.floor((close.bounds.top + close.bounds.bottom) / 2);
  if (
    titleCenterX >= closeCenterX ||
    Math.abs(titleCenterY - closeCenterY) > 128 ||
    close.bounds.top > title.bounds.bottom + 128 ||
    title.bounds.top < page.top ||
    close.bounds.top < page.top
  ) {
    return null;
  }
  const bodyTop =
    Math.max(title.bounds.bottom, close.bounds.bottom) + physicalSessionOverlayGapPx;
  const bodyBottom = page.top + page.height;
  if (bodyBottom - bodyTop < 320) return null;
  return Object.freeze({
    body: Object.freeze({
      height: bodyBottom - bodyTop,
      left: page.left,
      top: bodyTop,
      width: page.width
    }),
    close,
    page,
    title
  });
}

function selectPhysicalSheetAction(
  nodes: readonly AndroidUiNode[],
  field: AndroidUiNodeField,
  value: string,
  ownerTitle: string
): AndroidUiNode | null {
  const header = selectPhysicalFixedSheetHeader(nodes, ownerTitle);
  if (header === null) return null;
  const matches = nodes.filter(
    (node) =>
      matchesAndroidUiNode(node, field, value) &&
      node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsFullyInsideRegion(node, header.body)
  );
  return matches.length === 1 ? matches[0] ?? null : null;
}

function physicalFixedSheetTextVisible(
  nodes: readonly AndroidUiNode[],
  ownerTitle: string,
  text: string
): boolean {
  const header = selectPhysicalFixedSheetHeader(nodes, ownerTitle);
  if (header === null) return false;
  const matches = nodes.filter(
    (node) =>
      node.text === text &&
      !node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsFullyInsideRegion(node, header.body)
  );
  return matches.length === 1;
}

function physicalSheetChoiceSelected(
  nodes: readonly AndroidUiNode[],
  ownerTitle: "/model" | "/plan",
  value: string
): boolean {
  const header = selectPhysicalFixedSheetHeader(nodes, ownerTitle);
  if (header === null) return false;
  const selectedSemantic = `${value}, selected`;
  const choiceSelected = (node: AndroidUiNode, label: string): boolean =>
    matchesAndroidUiNode(node, "semantic", `${label}, selected`) ||
    (matchesAndroidUiNode(node, "semantic", label) &&
      androidUiNodeIsSelected(node));
  const selected = nodes.filter(
    (node) =>
      (matchesAndroidUiNode(node, "semantic", selectedSemantic) ||
        (matchesAndroidUiNode(node, "semantic", value) &&
          androidUiNodeIsSelected(node))) &&
      node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsFullyInsideRegion(node, header.body)
  );
  const selectedOptions = nodes.filter(
    (node) =>
      node.clickable &&
      node.enabled !== false &&
      (ownerTitle !== "/model" ||
        physicalModelChoiceLabels.some((label) =>
          choiceSelected(node, label)
        )) &&
      (ownerTitle === "/model"
        ? true
        : choiceSelected(node, "Default") || choiceSelected(node, "Plan")) &&
      androidUiNodeIsFullyInsideRegion(node, header.body)
  );
  return selected.length === 1 && selectedOptions.length === 1;
}

function physicalGoalCurrentTruthVisible(
  nodes: readonly AndroidUiNode[]
): boolean {
  return physicalFixedSheetTextVisible(nodes, "/goal", "No goal set");
}

function physicalGoalTerminalTruthVisible(
  nodes: readonly AndroidUiNode[]
): boolean {
  const header = selectPhysicalFixedSheetHeader(nodes, "/goal");
  if (header === null) return false;
  const labels = ["Paused goal created", "No turn was started."];
  return labels.every((label) => {
    const matches = nodes.filter(
      (node) =>
        node.text === label &&
        !node.clickable &&
        node.enabled !== false &&
        androidUiNodeIsFullyInsideRegion(node, header.body)
    );
    return matches.length === 1;
  });
}

function physicalMissionControlAwayTruthVisible(
  nodes: readonly AndroidUiNode[]
): boolean {
  const shell = selectPhysicalMissionControlDestination(nodes);
  if (shell === null) return false;
  const count = (text: string): number =>
    nodes.filter((node) => node.text === text).length;
  return (
    count("HostDeck is unreachable") === 1 &&
    count("Remote ready") === 0 &&
    count("Write") === 0 &&
    count("Remote writes locked") === 0
  );
}

function readPhysicalProfileAwaySnapshot(
  input: PhysicalProfileSnapshotInput
): PhysicalProfileAwaySnapshot {
  return Object.freeze({
    foreignServe: Object.freeze({ ...input.foreignServe }),
    managerAttempts: input.managerAttempts,
    mission: readPhysicalMissionControlRequestSnapshot(input.requestInspection),
    remoteBrowserMutationRequests:
      input.requestInspection.remoteBrowserMutationRequests,
    remoteBrowserStatusRequests:
      input.requestInspection.remoteBrowserStatusRequests,
    remoteDisableRequests: input.requestInspection.remoteDisableRequests,
    remoteEnableRequests: input.requestInspection.remoteEnableRequests,
    remoteStatusRequests: input.requestInspection.remoteStatusRequests
  });
}

function readPhysicalProfileReturnSnapshot(
  input: PhysicalProfileSnapshotInput
): PhysicalProfileReturnSnapshot {
  const away = readPhysicalProfileAwaySnapshot(input);
  return Object.freeze({
    claimRequests: input.requestInspection.claimRequests,
    foreignServe: away.foreignServe,
    managerAttempts: away.managerAttempts,
    mission: away.mission,
    remoteBrowserMutationRequests: away.remoteBrowserMutationRequests,
    remoteBrowserStatusRequests: away.remoteBrowserStatusRequests,
    remoteDisableRequests: away.remoteDisableRequests,
    remoteEnableRequests: away.remoteEnableRequests,
    remoteStatusRequests: away.remoteStatusRequests
  });
}

function physicalProfileAwaySwitchBoundaryIsExact(
  before: PhysicalProfileAwaySnapshot,
  after: PhysicalProfileAwaySnapshot
): boolean {
  return (
    physicalMissionControlRequestSnapshotMatches(after.mission, before.mission) &&
    after.foreignServe.bytes === before.foreignServe.bytes &&
    after.foreignServe.sha256 === before.foreignServe.sha256 &&
    after.managerAttempts === before.managerAttempts &&
    after.remoteBrowserMutationRequests === before.remoteBrowserMutationRequests &&
    after.remoteBrowserStatusRequests === before.remoteBrowserStatusRequests &&
    after.remoteDisableRequests === before.remoteDisableRequests &&
    after.remoteEnableRequests === before.remoteEnableRequests &&
    after.remoteStatusRequests === before.remoteStatusRequests + 1
  );
}

function physicalProfileReturnSwitchBoundaryIsExact(
  before: PhysicalProfileReturnSnapshot,
  after: PhysicalProfileReturnSnapshot
): boolean {
  return (
    physicalMissionControlRequestSnapshotMatches(after.mission, before.mission) &&
    after.claimRequests === before.claimRequests &&
    after.foreignServe.bytes === before.foreignServe.bytes &&
    after.foreignServe.sha256 === before.foreignServe.sha256 &&
    after.managerAttempts === before.managerAttempts &&
    after.remoteBrowserMutationRequests === before.remoteBrowserMutationRequests &&
    after.remoteBrowserStatusRequests === before.remoteBrowserStatusRequests &&
    after.remoteDisableRequests === before.remoteDisableRequests &&
    after.remoteEnableRequests === before.remoteEnableRequests &&
    after.remoteStatusRequests === before.remoteStatusRequests
  );
}

function physicalProfileAwayTruthMatches(
  input: Readonly<{
    readonly prompt?: PhysicalPromptRuntime;
    readonly remote: HostDeckRemoteIngressLifecycle;
    readonly requestInspection: RequestInspection;
  }> & PhysicalProfileExternalStateSource,
  before: PhysicalProfileAwaySnapshot,
  nodes: readonly AndroidUiNode[]
): Promise<boolean> {
  return physicalProfileAwayTruthMatchesWithExternalState(input, before, nodes);
}

async function physicalProfileAwayTruthMatchesWithExternalState(
  input: Readonly<{
    readonly prompt?: PhysicalPromptRuntime;
    readonly remote: HostDeckRemoteIngressLifecycle;
    readonly requestInspection: RequestInspection;
  }> & PhysicalProfileExternalStateSource,
  before: PhysicalProfileAwaySnapshot,
  nodes: readonly AndroidUiNode[]
): Promise<boolean> {
  const current = readPhysicalProfileAwaySnapshot({
    foreignServe: await input.readForeignServe(),
    managerAttempts: input.readManagerAttempts(),
    requestInspection: input.requestInspection
  });
  return (
    input.remote.readAdmission().admission === "closed" &&
    input.remote.snapshot().active_control_operations === 0 &&
    physicalMissionControlRequestSnapshotMatches(current.mission, before.mission) &&
    current.foreignServe.bytes === before.foreignServe.bytes &&
    current.foreignServe.sha256 === before.foreignServe.sha256 &&
    current.managerAttempts === before.managerAttempts &&
    current.remoteBrowserMutationRequests === before.remoteBrowserMutationRequests &&
    current.remoteBrowserStatusRequests === before.remoteBrowserStatusRequests &&
    current.remoteDisableRequests === before.remoteDisableRequests &&
    current.remoteEnableRequests === before.remoteEnableRequests &&
    current.remoteStatusRequests === before.remoteStatusRequests &&
    (input.prompt?.subscribers.snapshot().active_subscribers ?? 0) === 0 &&
    physicalMissionControlAwayTruthVisible(nodes)
  );
}

function physicalProfileReturnTruthMatches(
  input: Readonly<{
    readonly prompt?: PhysicalPromptRuntime;
    readonly remote: HostDeckRemoteIngressLifecycle;
    readonly requestInspection: RequestInspection;
  }> & PhysicalProfileExternalStateSource,
  before: PhysicalProfileReturnSnapshot,
  nodes: readonly AndroidUiNode[]
): Promise<boolean> {
  return physicalProfileReturnTruthMatchesWithExternalState(input, before, nodes);
}

async function physicalProfileReturnTruthMatchesWithExternalState(
  input: Readonly<{
    readonly prompt?: PhysicalPromptRuntime;
    readonly remote: HostDeckRemoteIngressLifecycle;
    readonly requestInspection: RequestInspection;
  }> & PhysicalProfileExternalStateSource,
  before: PhysicalProfileReturnSnapshot,
  nodes: readonly AndroidUiNode[]
): Promise<boolean> {
  const current = readPhysicalProfileReturnSnapshot({
    foreignServe: await input.readForeignServe(),
    managerAttempts: input.readManagerAttempts(),
    requestInspection: input.requestInspection
  });
  return (
    input.remote.readAdmission().admission === "open" &&
    input.remote.snapshot().active_control_operations === 0 &&
    physicalMissionControlRequestOpened(current.mission, before.mission) &&
    current.claimRequests === before.claimRequests &&
    current.foreignServe.bytes === before.foreignServe.bytes &&
    current.foreignServe.sha256 === before.foreignServe.sha256 &&
    current.managerAttempts === before.managerAttempts &&
    current.remoteBrowserMutationRequests === before.remoteBrowserMutationRequests &&
    current.remoteBrowserStatusRequests === before.remoteBrowserStatusRequests &&
    current.remoteDisableRequests === before.remoteDisableRequests &&
    current.remoteEnableRequests === before.remoteEnableRequests &&
    current.remoteStatusRequests === before.remoteStatusRequests &&
    (input.prompt?.subscribers.snapshot().active_subscribers ?? 0) === 0 &&
    physicalMissionControlWriteReady(nodes, 0, false) &&
    selectPhysicalMissionControlDestination(nodes) !== null
  );
}

async function waitForStablePhysicalProfileAwayTruth(
  input: Readonly<{
    readonly prompt?: PhysicalPromptRuntime;
    readonly remote: HostDeckRemoteIngressLifecycle;
    readonly requestInspection: RequestInspection;
  }> & PhysicalProfileExternalStateSource,
  before: PhysicalProfileAwaySnapshot,
  message: string,
  timeoutMs = 30_000
): Promise<void> {
  let stableSince: number | null = null;
  let stableObservation: string | null = null;
  await waitFor(async () => {
    let nodes: readonly AndroidUiNode[];
    try {
      nodes = await readAndroidUiNodes();
    } catch {
      stableSince = null;
      stableObservation = null;
      return false;
    }
    try {
      if (!(await physicalProfileAwayTruthMatches(input, before, nodes))) {
        stableSince = null;
        stableObservation = null;
        return false;
      }
    } catch {
      stableSince = null;
      stableObservation = null;
      return false;
    }
    const shell = selectPhysicalMissionControlDestination(nodes);
    if (shell === null) {
      stableSince = null;
      stableObservation = null;
      return false;
    }
    const observation = `${physicalRegionGeometry(shell)};` +
      `requests=${before.mission.accessRequests}/${before.mission.hostStatusRequests}/${before.mission.sessionListRequests};` +
      `active=${input.prompt?.subscribers.snapshot().active_subscribers ?? 0}`;
    if (stableSince === null || stableObservation !== observation) {
      stableSince = performance.now();
      stableObservation = observation;
      return false;
    }
    return performance.now() - stableSince >= 2_000;
  }, timeoutMs, message);
}

async function waitForStablePhysicalProfileReturnTruth(
  input: Readonly<{
    readonly prompt?: PhysicalPromptRuntime;
    readonly remote: HostDeckRemoteIngressLifecycle;
    readonly requestInspection: RequestInspection;
  }> & PhysicalProfileExternalStateSource,
  before: PhysicalProfileReturnSnapshot,
  message: string,
  timeoutMs = 30_000
): Promise<void> {
  let stableSince: number | null = null;
  let stableObservation: string | null = null;
  await waitFor(async () => {
    let nodes: readonly AndroidUiNode[];
    try {
      nodes = await readAndroidUiNodes();
    } catch {
      stableSince = null;
      stableObservation = null;
      return false;
    }
    let current: PhysicalProfileReturnSnapshot;
    try {
      if (!(await physicalProfileReturnTruthMatches(input, before, nodes))) {
        stableSince = null;
        stableObservation = null;
        return false;
      }
      current = readPhysicalProfileReturnSnapshot({
        foreignServe: await input.readForeignServe(),
        managerAttempts: input.readManagerAttempts(),
        requestInspection: input.requestInspection
      });
    } catch {
      stableSince = null;
      stableObservation = null;
      return false;
    }
    const observation =
      `${physicalRegionGeometry(selectPhysicalMissionControlDestination(nodes) as PhysicalScreenshotRegion)};` +
      `requests=${current.mission.accessRequests}/${current.mission.hostStatusRequests}/${current.mission.sessionListRequests};` +
      `claim=${current.claimRequests};browser=${current.remoteBrowserStatusRequests}/${current.remoteBrowserMutationRequests}`;
    const now = performance.now();
    if (stableSince === null || stableObservation !== observation) {
      stableSince = now;
      stableObservation = observation;
      return false;
    }
    return now - stableSince >= 2_000;
  }, timeoutMs, message);
}

function selectPhysicalSessionUtilityAction(
  nodes: readonly AndroidUiNode[],
  field: AndroidUiNodeField,
  value: string
): AndroidUiNode | null {
  const ownerRegion =
    selectPhysicalFixedSheetHeader(nodes, "Session utilities")?.body ?? null;
  if (ownerRegion === null) return null;
  const selected = nodes.filter(
    (node) =>
      matchesAndroidUiNode(node, field, value) &&
      node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsFullyInsideRegion(node, ownerRegion)
  );
  return selected.length === 1 ? selected[0] ?? null : null;
}

function selectPhysicalUtilityPageBody(
  nodes: readonly AndroidUiNode[],
  pageTitle: "/compact" | "/skills" | "/usage"
): PhysicalScreenshotRegion | null {
  const closeDescription = pageTitle === "/usage"
    ? "Close Usage utility"
    : pageTitle === "/compact"
      ? "Close Compact utility"
      : "Close Skills utility";
  return selectPhysicalOwnedHeaderBody(
    nodes,
    pageTitle,
    closeDescription,
    "Back to session utilities",
    false
  )?.body ?? null;
}

function physicalUtilityPageTextVisible(
  nodes: readonly AndroidUiNode[],
  pageTitle: "/compact" | "/skills" | "/usage",
  text: string
): boolean {
  const body = selectPhysicalUtilityPageBody(nodes, pageTitle);
  if (body === null) return false;
  return nodes.filter(
    (node) =>
      node.text === text &&
      !node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsFullyInsideRegion(node, body)
  ).length === 1;
}

function selectPhysicalUtilityPageAction(
  nodes: readonly AndroidUiNode[],
  pageTitle: "/compact" | "/skills" | "/usage",
  field: AndroidUiNodeField,
  value: string
): AndroidUiNode | null {
  const body = selectPhysicalUtilityPageBody(nodes, pageTitle);
  if (body === null) return null;
  const matches = nodes.filter(
    (node) =>
      matchesAndroidUiNode(node, field, value) &&
      node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsFullyInsideRegion(node, body)
  );
  return matches.length === 1 ? matches[0] ?? null : null;
}

function selectPhysicalSheetEditor(
  nodes: readonly AndroidUiNode[],
  ownerTitle: "/goal",
  label: string
): AndroidUiNode | null {
  const header = selectPhysicalFixedSheetHeader(nodes, ownerTitle);
  if (header === null) return null;
  const labels = nodes.filter(
    (node) =>
      matchesAndroidUiNode(node, "semantic", label) &&
      node.enabled !== false &&
      androidUiNodeIsFullyInsideRegion(node, header.body)
  );
  if (labels.length < 1 || labels.length > 2) return null;
  const editors = nodes.filter(
    (node) =>
      node.className === androidEditTextClass &&
      node.clickable &&
      node.enabled !== false &&
      androidUiNodeWidth(node) >= 120 &&
      androidUiNodeHeight(node) >= 36 &&
      androidUiNodeIsFullyInsideRegion(node, header.body) &&
      labels.some((labelNode) => promptEditorIsNearLabel(node, labelNode))
  );
  return editors.length === 1 ? editors[0] ?? null : null;
}

function selectPhysicalResumePageBody(
  nodes: readonly AndroidUiNode[]
): Readonly<{
  readonly body: PhysicalScreenshotRegion;
  readonly bodyText: AndroidUiNode;
  readonly page: PhysicalScreenshotRegion;
  readonly title: AndroidUiNode;
}> | null {
  let page: PhysicalScreenshotRegion;
  try {
    page = selectChromePageViewport(nodes);
  } catch {
    return null;
  }
  const owner = selectPhysicalOwnedHeaderBody(
    nodes,
    "Resume on laptop",
    "Close session actions",
    "Back to session actions",
    false
  );
  if (owner === null || owner.title === null) return null;
  const bodyTexts = nodes.filter(
    (node) =>
      node.text === "Laptop terminal only" &&
      !node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsFullyInsideRegion(node, owner.body)
  );
  if (bodyTexts.length !== 1) return null;
  const title = owner.title;
  const bodyText = bodyTexts[0];
  if (bodyText === undefined) return null;
  if (bodyText.bounds.top < title.bounds.bottom) return null;
  const bodyTop = bodyText.bounds.bottom;
  const body = Object.freeze({
    height: page.top + page.height - bodyTop,
    left: page.left,
    top: bodyTop,
    width: page.width
  });
  return body.height > 0
    ? Object.freeze({ body, bodyText, page, title })
    : null;
}

function physicalResumeCopyOutcome(
  nodes: readonly AndroidUiNode[]
): "copied" | "unavailable" | null {
  const owner = selectPhysicalResumePageBody(nodes);
  if (owner === null) return null;
  const outcomes = nodes.filter(
    (node) =>
      (node.text === "Command copied" || node.text === "Copy failed") &&
      !node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsFullyInsideRegion(node, owner.page)
  );
  if (outcomes.length !== 1) return null;
  const outcome = outcomes[0];
  if (outcome === undefined || !androidUiNodeIsFullyInsideRegion(outcome, owner.body)) {
    return null;
  }
  return outcome.text === "Command copied" ? "copied" : "unavailable";
}

function selectPhysicalUtilityBackAction(
  nodes: readonly AndroidUiNode[],
  pageTitle: "/usage" | "/compact" | "/skills"
): AndroidUiNode | null {
  if (selectPhysicalUtilityPageBody(nodes, pageTitle) === null) return null;
  let page: PhysicalScreenshotRegion;
  try {
    page = selectChromePageViewport(nodes);
  } catch {
    return null;
  }
  const titles = nodes.filter(
    (node) =>
      node.text === pageTitle &&
      !node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsFullyInsideRegion(node, page)
  );
  const backs = nodes.filter(
    (node) =>
      node.description === "Back to session utilities" &&
      node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsFullyInsideRegion(node, page)
  );
  if (titles.length !== 1 || backs.length !== 1) return null;
  const title = titles[0];
  const back = backs[0];
  const titleCenterX = title === undefined
    ? null
    : Math.floor((title.bounds.left + title.bounds.right) / 2);
  const backCenterX = back === undefined
    ? null
    : Math.floor((back.bounds.left + back.bounds.right) / 2);
  const titleCenterY = title === undefined
    ? null
    : Math.floor((title.bounds.top + title.bounds.bottom) / 2);
  const backCenterY = back === undefined
    ? null
    : Math.floor((back.bounds.top + back.bounds.bottom) / 2);
  return title !== undefined &&
    back !== undefined &&
    titleCenterX !== null &&
    backCenterX !== null &&
    titleCenterY !== null &&
    backCenterY !== null &&
    backCenterX < titleCenterX &&
    Math.abs(backCenterY - titleCenterY) <= 96 &&
    back.bounds.top >= page.top &&
    title.bounds.top >= page.top
    ? back
    : null;
}

function selectPhysicalResumeCopyAction(
  nodes: readonly AndroidUiNode[]
): AndroidUiNode | null {
  const owner = selectPhysicalResumePageBody(nodes);
  if (owner === null) return null;
  const copy = nodes.filter(
    (node) =>
      node.text === "Copy command" &&
      node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsFullyInsideRegion(node, owner.body)
  );
  return copy.length === 1 ? copy[0] ?? null : null;
}

function selectPhysicalResumeBackAction(
  nodes: readonly AndroidUiNode[]
): AndroidUiNode | null {
  const owner = selectPhysicalResumePageBody(nodes);
  if (owner === null) return null;
  const backs = nodes.filter(
    (node) =>
      node.description === "Back to session actions" &&
      node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsFullyInsideRegion(node, owner.page)
  );
  if (backs.length !== 1) return null;
  const title = owner.title;
  const back = backs[0];
  const titleCenterX = title === undefined
    ? null
    : Math.floor((title.bounds.left + title.bounds.right) / 2);
  const backCenterX = back === undefined
    ? null
    : Math.floor((back.bounds.left + back.bounds.right) / 2);
  const titleCenterY = title === undefined
    ? null
    : Math.floor((title.bounds.top + title.bounds.bottom) / 2);
  const backCenterY = back === undefined
    ? null
    : Math.floor((back.bounds.top + back.bounds.bottom) / 2);
  return title !== undefined && back !== undefined &&
    titleCenterX !== null && backCenterX !== null &&
    titleCenterY !== null && backCenterY !== null &&
    backCenterX < titleCenterX &&
    Math.abs(backCenterY - titleCenterY) <= 96 &&
    back.bounds.top >= owner.page.top &&
    title.bounds.top >= owner.page.top
    ? back
    : null;
}


function physicalClipboardClearedTruthVisible(
  nodes: readonly AndroidUiNode[]
): boolean {
  const owner = selectPhysicalExternalPageOwner(nodes);
  if (owner === null) return false;
  const result = nodes.filter(
    (node) =>
      node.text === "Clipboard cleared" &&
      !node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsFullyInsideRegion(node, owner.body)
  );
  const detail = nodes.filter(
    (node) =>
      node.text === "The temporary laptop command was removed." &&
      !node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsFullyInsideRegion(node, owner.body)
  );
  const staleReadyState = nodes.filter(
    (node) =>
      node.text === "Clear copied command" &&
      !node.clickable &&
      androidUiNodeIsFullyInsideRegion(node, owner.body)
  );
  const clearAction = nodes.filter(
    (node) => node.text === "Clear clipboard" || node.description === "Clear clipboard"
  );
  if (
    result.length !== 1 ||
    detail.length !== 1 ||
    staleReadyState.length !== 0 ||
    clearAction.length !== 0
  ) {
    return false;
  }
  const resultNode = result[0];
  const detailNode = detail[0];
  return resultNode !== undefined && detailNode !== undefined &&
    resultNode.bounds.top >= owner.title.bounds.bottom &&
    detailNode.bounds.top >= resultNode.bounds.bottom;
}

function selectPhysicalDialogCloseAction(
  nodes: readonly AndroidUiNode[],
  description: string
): AndroidUiNode | null {
  const ownerTitles: Readonly<Record<string, string>> = {
    "Close Plan control": "/plan",
    "Close goal control": "/goal",
    "Close model control": "/model",
    "Close event details": "Event details",
    "Close session actions": "Session actions",
    "Close session utilities": "Session utilities"
  };
  const ownerTitle = ownerTitles[description];
  if (ownerTitle === undefined) return null;
  const header = selectPhysicalFixedSheetHeader(nodes, ownerTitle);
  return header?.close.description === description ? header.close : null;
}

function selectPhysicalExternalPageAction(
  nodes: readonly AndroidUiNode[],
  text: string
): AndroidUiNode | null {
  if (text !== "Clear clipboard") return null;
  const owner = selectPhysicalExternalPageOwner(nodes);
  if (owner === null) return null;
  const states = nodes.filter(
    (node) =>
      node.text === "Clear copied command" &&
      !node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsFullyInsideRegion(node, owner.body)
  );
  const details = nodes.filter(
    (node) =>
      node.text === "Remove the temporary laptop command from this phone." &&
      !node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsFullyInsideRegion(node, owner.body)
  );
  if (states.length !== 1 || details.length !== 1) return null;
  const state = states[0];
  const detail = details[0];
  if (
    state === undefined ||
    detail === undefined ||
    state.bounds.top < owner.title.bounds.bottom ||
    detail.bounds.top < state.bounds.bottom
  ) {
    return null;
  }
  const actions = nodes.filter(
    (node) =>
      node.text === text &&
      node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsFullyInsideRegion(node, owner.body) &&
      node.bounds.top >= detail.bounds.bottom
  );
  return actions.length === 1 ? actions[0] ?? null : null;
}

interface PhysicalExternalPageOwner {
  readonly body: PhysicalScreenshotRegion;
  readonly title: AndroidUiNode;
}

function selectPhysicalExternalPageOwner(
  nodes: readonly AndroidUiNode[]
): PhysicalExternalPageOwner | null {
  let page: PhysicalScreenshotRegion;
  try {
    page = selectChromePageViewport(nodes);
  } catch {
    return null;
  }
  const brands = nodes.filter(
    (node) =>
      node.text === "HostDeck" &&
      !node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsWebText(node) &&
      androidUiNodeIsFullyInsideRegion(node, page)
  );
  const titles = nodes.filter(
    (node) =>
      node.text === "Remote access check" &&
      !node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsWebText(node) &&
      androidUiNodeWidth(node) >= 96 &&
      androidUiNodeHeight(node) >= 24 &&
      androidUiNodeIsFullyInsideRegion(node, page)
  );
  if (brands.length !== 1 || titles.length !== 1) return null;
  const brand = brands[0];
  const title = titles[0];
  if (
    brand === undefined ||
    title === undefined ||
    title.bounds.top < brand.bounds.bottom
  ) {
    return null;
  }
  const competingHeaders = nodes.filter(
    (node) =>
      (physicalOwnedHeaderTitles.has(node.text) || node.text === "Mission Control") &&
      !node.clickable &&
      androidUiNodeIsFullyInsideRegion(node, page)
  );
  const competingControls = nodes.filter(
    (node) =>
      (physicalOwnedHeaderCloseDescriptions.has(node.description) ||
        node.description === "Back to Mission Control" ||
        node.description === "Back to session actions" ||
        node.description === "Back to session utilities") &&
      node.clickable &&
      androidUiNodeIsFullyInsideRegion(node, page)
  );
  if (competingHeaders.length !== 0 || competingControls.length !== 0) return null;
  const bodyTop = title.bounds.bottom + physicalSessionOverlayGapPx;
  const body = Object.freeze({
    height: page.top + page.height - bodyTop,
    left: page.left,
    top: bodyTop,
    width: page.width
  });
  return body.height >= 320 ? Object.freeze({ body, title }) : null;
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
  const accessTarget = await waitForPhysicalSelectedNode(
    (nodes) => selectPhysicalMissionControlAction(nodes, "Open Host and access"),
    30_000,
    "Physical Mission Control omitted Host and access."
  );
  measure(accessTarget, "open-host-access");
  assertPhysicalMissionControlGeometry(await readAndroidUiNodes());

  const requestsBeforeReload = readPhysicalMissionControlRequestSnapshot(
    input.requestInspection
  );
  adb(["shell", "input", "keyevent", "KEYCODE_REFRESH"]);
  await waitForPhysicalMissionControlWriteReady(
    input,
    requestsBeforeReload,
    "Physical dashboard fragment-free reload did not restore exact Mission Control authority.",
    { requireSelectedSession: false }
  );
  const quietDisclosure = await waitForPhysicalSelectedNode(
    (nodes) => selectPhysicalQuietQueueDisclosure(nodes, false),
    45_000,
    "Physical dashboard reload omitted the collapsed quiet-session control."
  );
  measure(quietDisclosure, "expand-quiet-sessions");
  await input.actionRegistry.tap(
    "dashboard-expand-quiet",
    quietDisclosure,
    async () => physicalQuietQueueDisclosureState(await readAndroidUiNodes()) === "expanded",
    "Physical dashboard quiet-session control did not expand."
  );
  const sessionTarget = await waitForPhysicalSelectedNode(
    selectPhysicalMissionControlSession,
    30_000,
    "Physical dashboard fragment-free reload lost paired authority.",
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
  const navigationBeforeOpen = readPhysicalSessionNavigationSnapshot(input);
  await input.actionRegistry.tap(
    "dashboard-open-session",
    sessionTarget,
    () => physicalSessionNavigationOpened(
      readPhysicalSessionNavigationSnapshot(input),
      navigationBeforeOpen
    ),
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
  await revealPhysicalSessionContentNode(
    "text",
    "Current",
    "backward",
    30_000,
    "Physical Session Detail did not reveal current replay-to-live truth."
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
    "event-open-boundary",
    "backward",
    "Earlier activity unavailable",
    "Replay boundary",
    "Content truncated",
    "fe090-08-event-boundary.png"
  );
  await runPhysicalEventDiagnostic(
    input,
    capture,
    "event-open-complete",
    "forward",
    "Physical dashboard event complete",
    "Message event",
    "Bounded event summary",
    "fe090-09-event-complete.png"
  );
  await runPhysicalEventDiagnostic(
    input,
    capture,
    "event-open-redacted",
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
    actionRegistryScope: "dashboard",
    captureScreenshots: false,
    cleanup: false,
    openMissionControl: false,
    sessionAlreadyOpen: true
  });
  await capture("fe090-11-prompt-completed.png");
  await runPhysicalStreamRecovery(input, capture);
  const detailQuietExpanded = await runPhysicalDetailFailureStates(input, capture);
  await runPhysicalModelControl(input, capture, measure);
  await runPhysicalGoalControl(input, capture, measure);
  await runPhysicalPlanControl(input, capture, measure);
  await runPhysicalSessionUtilities(input, capture, measure);
  const clipboardOutcome = await runPhysicalLaptopResume(input, capture, measure);
  const sessionActionsHandoff = await runPhysicalInterruptControl(
    input,
    capture,
    measure
  );
  await runPhysicalHostAccessControls(
    input,
    capture,
    measure,
    sessionActionsHandoff
  );

  await returnPhysicalDashboardToMissionControl(input);
  await runPhysicalDashboardProfileSwitch(input, capture);
  await runPhysicalRuntimeCompatibilityState(input, capture);
  const talkBack = await runPhysicalTalkBackTraversal(
    input,
    input.talkBackArtifacts
  );
  const archiveQuietExpanded = await runPhysicalArchiveControl(
    input,
    capture,
    measure
  );
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
      input.requestInspection.skillsRequests === 1 &&
      JSON.stringify(input.requestInspection.skillsResponseStatuses) ===
        "[200]" &&
      input.readProxyRejection() === null,
    "Physical dashboard control counters or terminal truth were inconsistent."
  );
  requireCondition(
    screenshotNames.length >= 20 &&
      new Set(screenshotNames).size === screenshotNames.length &&
      targetMeasurements.length >= 15,
    "Physical dashboard evidence inventory was incomplete."
  );
  input.actionRegistry.assertConsumed(
    physicalAggregateDashboardExpectedActionIdsFor({
      archiveQuietExpanded,
      clipboardOutcome,
      detailQuietExpanded
    })
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

async function waitForPhysicalSessionActions(
  source: PhysicalSessionActionsWaitSource,
  timeoutMs: number,
  message: string,
  options: PhysicalSessionActionsWaitOptions = {}
): Promise<AndroidUiNode> {
  requireCondition(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0,
    "Physical Session Actions waiter timeout was invalid."
  );
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const baseline = options.baseline ?? source.readNavigation();
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  requireCondition(
    Number.isFinite(startedAt) &&
      Number.isFinite(deadline) &&
      deadline > startedAt,
    "Physical Session Actions waiter clock or deadline was invalid."
  );
  const observations: string[] = [];
  let stableSince: number | null = null;
  let stableObservation: string | null = null;
  let previousNow = startedAt;

  while (true) {
    const currentNow = now();
    requireCondition(
      Number.isFinite(currentNow) && currentNow >= previousNow,
      "Physical Session Actions waiter clock moved backwards."
    );
    previousNow = currentNow;
    if (currentNow >= deadline) break;

    let navigation: PhysicalSessionNavigationSnapshot;
    try {
      navigation = source.readNavigation();
    } catch {
      retainPhysicalSessionActionsObservation(
        observations,
        `authority-read-error;authority=${physicalSessionNavigationSummary(baseline)}`
      );
      stableSince = null;
      stableObservation = null;
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await sleep(Math.min(physicalSessionActionsPollMs, remaining));
      continue;
    }

    if (!physicalSessionNavigationMatches(navigation, baseline)) {
      throw new Error(
        `${message} (navigation-drift;states=${
          observations.length === 0 ? "none" : observations.join("||")
        }).`
      );
    }

    let nodes: readonly AndroidUiNode[];
    try {
      nodes = await source.readNodes();
    } catch {
      retainPhysicalSessionActionsObservation(
        observations,
        `read-error;authority=${physicalSessionNavigationSummary(navigation)}`
      );
      stableSince = null;
      stableObservation = null;
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await sleep(Math.min(physicalSessionActionsPollMs, remaining));
      continue;
    }

    let afterReadNavigation: PhysicalSessionNavigationSnapshot;
    try {
      afterReadNavigation = source.readNavigation();
    } catch {
      retainPhysicalSessionActionsObservation(
        observations,
        `authority-read-error;authority=${physicalSessionNavigationSummary(baseline)}`
      );
      stableSince = null;
      stableObservation = null;
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await sleep(Math.min(physicalSessionActionsPollMs, remaining));
      continue;
    }
    if (!physicalSessionNavigationMatches(afterReadNavigation, baseline)) {
      throw new Error(
        `${message} (navigation-drift;states=${
          observations.length === 0 ? "none" : observations.join("||")
        }).`
      );
    }

    const selected = selectPhysicalSessionActionsTrigger(
      nodes,
      afterReadNavigation.activeSubscribers
    );
    const observation =
      `${physicalSessionActionsStateSummary(nodes, afterReadNavigation.activeSubscribers, selected)};` +
      `authority=${physicalSessionNavigationSummary(afterReadNavigation)}`;
    retainPhysicalSessionActionsObservation(observations, observation);
    if (selected === null) {
      stableSince = null;
      stableObservation = null;
    } else {
      const observedAt = now();
      requireCondition(
        Number.isFinite(observedAt) && observedAt >= previousNow,
        "Physical Session Actions waiter clock moved backwards."
      );
      previousNow = observedAt;
      if (stableSince === null || stableObservation !== observation) {
        stableSince = observedAt;
        stableObservation = observation;
      }
      if (observedAt - stableSince >= physicalSessionActionsStableWindowMs) {
        return selected;
      }
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(physicalSessionActionsPollMs, remaining));
  }

  throw new Error(
    `${message} (states=${
      observations.length === 0 ? "none" : observations.join("||")
    }).`
  );
}

function createPhysicalSessionActionsAdmissionWindow(
  source: PhysicalSessionActionsWaitSource,
  timeoutMs: number,
  options: PhysicalSessionActionsAdmissionWindowOptions = {}
): PhysicalSessionActionsAdmissionWindow {
  const now = options.now ?? (() => performance.now());
  const sleep =
    options.sleep ??
    ((milliseconds: number): Promise<void> =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const baseline = source.readNavigation();
  return Object.freeze({
    baseline,
    wait: (message: string) =>
      waitForPhysicalSessionActions(source, timeoutMs, message, {
        baseline,
        now,
        sleep
      })
  });
}

function physicalSessionNavigationSummary(
  navigation: PhysicalSessionNavigationSnapshot
): string {
  return (
    `active=${navigation.activeSubscribers};` +
    `missing=${navigation.missingDetailRequests};` +
    `opened=${navigation.openedSubscribers};` +
    `detail=${navigation.selectedDetailRequests};` +
    `stream=${navigation.streamRequests}`
  );
}

function retainPhysicalSessionActionsObservation(
  observations: string[],
  observation: string
): void {
  requireCondition(
    Buffer.byteLength(observation, "utf8") >= 1 &&
      Buffer.byteLength(observation, "utf8") <= 4_096,
    "Physical Session Actions observation exceeded its private-safe bound."
  );
  if (observations.at(-1) === observation) return;
  observations.push(observation);
  if (observations.length > 6) observations.shift();
}

async function tapPhysicalSessionActionsOnceAndWait(
  actionRegistry: PhysicalAggregateActionRegistry,
  actionId: PhysicalAggregateActionId,
  node: AndroidUiNode,
  completed: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 30_000
): Promise<void> {
  await actionRegistry.tap(actionId, node, completed, message, timeoutMs);
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
  } catch (error) {
    let summary = "hierarchy=unavailable";
    try {
      summary = androidUiStateSummary(await readAndroidUiNodes(), node);
    } catch {
      // The bounded fallback still reports unavailable post-tap hierarchy.
    }
    const resolvedMessage = typeof message === "string" ? message : message();
    throw new Error(`${resolvedMessage} (${summary}).`, { cause: error });
  }
}

async function closePhysicalDialog(
  actionRegistry: PhysicalAggregateActionRegistry,
  actionId: PhysicalAggregateActionId,
  description: string,
  navigationStable: (() => boolean) | undefined = undefined
): Promise<void> {
  const close = await waitForPhysicalSelectedNode(
    (nodes) => selectPhysicalDialogCloseAction(nodes, description),
    30_000,
    `Physical dialog close control ${description} was unavailable.`
  );
  await actionRegistry.tap(
    actionId,
    close,
    async () =>
      (navigationStable === undefined || navigationStable()) &&
      physicalDialogClosedOnSessionDetail(await readAndroidUiNodes(), description),
    `Physical dialog ${description} did not close.`
  );
}

function physicalDialogClosedOnSessionDetail(
  nodes: readonly AndroidUiNode[],
  description: string
): boolean {
  const ownerTitles: Readonly<Record<string, string>> = {
    "Close Plan control": "/plan",
    "Close event details": "Event details",
    "Close goal control": "/goal",
    "Close model control": "/model",
    "Close session actions": "Session actions",
    "Close session utilities": "Session utilities"
  };
  const ownerTitle = ownerTitles[description];
  if (ownerTitle === undefined) return false;
  const ownerRemaining = nodes.filter(
    (node) => node.text === ownerTitle && !node.clickable
  );
  const closeRemaining = nodes.filter(
    (node) => node.description === description && node.clickable
  );
  const backToMission = nodes.filter(
    (node) =>
      node.description === "Back to Mission Control" &&
      node.clickable &&
      node.enabled !== false
  );
  const remainingModalControls = nodes.filter(
    (node) =>
      node.clickable &&
      node.enabled !== false &&
      (Object.values(physicalFixedSheetCloseDescriptions).includes(
        node.description
      ) ||
        node.description === "Close Host and access" ||
        node.description === "Back to session actions" ||
        node.description === "Back to session utilities")
  );
  return (
    ownerRemaining.length === 0 &&
    closeRemaining.length === 0 &&
    backToMission.length === 1 &&
    remainingModalControls.length === 0
  );
}

async function runPhysicalEventDiagnostic(
  input: ProductionUiEntryInput & { readonly prompt: PhysicalPromptRuntime },
  capture: PhysicalDashboardCapture,
  actionId: PhysicalAggregateActionId,
  direction: AndroidVerticalRevealDirection,
  timelineLabel: string,
  heading: string,
  limitation: string,
  screenshot: string
): Promise<void> {
  const source: PhysicalEventDiagnosticWaitSource = Object.freeze({
    readAuthority: () => readPhysicalEventDiagnosticAuthoritySnapshot(input),
    readNodes: readAndroidUiNodes,
    swipe: swipeAndroidViewportAbovePhysicalSessionControls
  });
  const authorityBefore = source.readAuthority();
  const target = await revealPhysicalEventDiagnosticTarget(
    source,
    authorityBefore,
    timelineLabel,
    direction,
    30_000,
    `Physical ${heading} row had no stable unobscured diagnostic action.`
  );
  const observations: string[] = [];
  await input.actionRegistry.tap(
    actionId,
    target.action,
    async () => {
      let actualAuthority: PhysicalEventDiagnosticAuthoritySnapshot;
      let nodes: readonly AndroidUiNode[];
      try {
        nodes = await source.readNodes();
        actualAuthority = source.readAuthority();
      } catch {
        retainPhysicalEventDiagnosticObservation(
          observations,
          "hierarchy-or-authority-read-error"
        );
        return false;
      }
      const outcome: PhysicalEventDiagnosticOutcomeInput = Object.freeze({
        actualAuthority,
        baselineAuthority: authorityBefore,
        heading,
        limitation,
        nodes,
        target,
        timelineLabel
      });
      retainPhysicalEventDiagnosticObservation(
        observations,
        physicalEventDiagnosticOutcomeSummary(outcome)
      );
      const requestDelta =
        actualAuthority.sessionEventRequests -
        authorityBefore.sessionEventRequests;
      if (
        !physicalSessionNavigationMatches(
          actualAuthority.navigation,
          authorityBefore.navigation
        ) ||
        requestDelta < 0 ||
        requestDelta > 1
      ) {
        throw new Error("Physical event diagnostic authority became impossible.");
      }
      const sheetState = physicalEventDiagnosticSheetState(nodes);
      if (
        sheetState === "failure" ||
        sheetState === "local_only" ||
        sheetState === "retained"
      ) {
        throw new Error(
          `Physical event diagnostic reached unexpected ${sheetState} truth.`
        );
      }
      return physicalEventDiagnosticCurrentOutcomeVisible(outcome);
    },
    () =>
      `Physical ${heading} diagnostic did not reach one current read;states=${
        observations.join("||") || "none"
      }`,
    Object.freeze({
      beforeTap: (context: PhysicalAggregateOwnerContext) =>
        requirePhysicalEventDiagnosticAuthorityBeforeTap(
          source,
          authorityBefore,
          context,
          target,
          timelineLabel
        )
    })
  );
  await capture(screenshot);
  await closePhysicalDialog(
    input.actionRegistry,
    `event-close-${actionId.replace("event-open-", "")}` as PhysicalAggregateActionId,
    "Close event details",
    () => physicalSessionNavigationMatches(
      readPhysicalSessionNavigationSnapshot(input),
      authorityBefore.navigation
    )
  );
}

async function revealPhysicalEventDiagnosticTarget(
  source: PhysicalEventDiagnosticWaitSource,
  baselineAuthority: PhysicalEventDiagnosticAuthoritySnapshot,
  timelineLabel: string,
  direction: AndroidVerticalRevealDirection,
  timeoutMs: number,
  message: string,
  options: PhysicalEventDiagnosticWaitOptions = {}
): Promise<PhysicalEventDiagnosticTarget> {
  requireCondition(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0,
    "Physical event-diagnostic waiter timeout was invalid."
  );
  const now = options.now ?? (() => performance.now());
  const sleep =
    options.sleep ??
    ((milliseconds: number): Promise<void> =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let previousNow = Number.NEGATIVE_INFINITY;
  const readNow = (): number => {
    const value = now();
    requireCondition(
      Number.isFinite(value) && value >= previousNow,
      "Physical event-diagnostic waiter clock moved backwards."
    );
    previousNow = value;
    return value;
  };
  const startedAt = readNow();
  const deadline = startedAt + timeoutMs;
  requireCondition(
    Number.isFinite(deadline) && deadline > startedAt,
    "Physical event-diagnostic waiter deadline was invalid."
  );
  const pause = async (maximumMs: number): Promise<boolean> => {
    const remaining = deadline - readNow();
    if (remaining <= 0) return false;
    await sleep(Math.min(maximumMs, remaining));
    return true;
  };
  let swipeCount = 0;
  const observations: string[] = [];
  let stableSince: number | null = null;
  let stableTarget: PhysicalEventDiagnosticTarget | null = null;

  while (readNow() < deadline) {
    let authorityBeforeRead: PhysicalEventDiagnosticAuthoritySnapshot;
    try {
      authorityBeforeRead = source.readAuthority();
    } catch {
      retainPhysicalEventDiagnosticObservation(
        observations,
        "authority-read-error"
      );
      stableSince = null;
      stableTarget = null;
      if (!(await pause(physicalEventDiagnosticPollMs))) break;
      continue;
    }
    if (
      !physicalEventDiagnosticAuthorityMatches(
        authorityBeforeRead,
        baselineAuthority
      )
    ) {
      retainPhysicalEventDiagnosticObservation(
        observations,
        physicalEventDiagnosticAuthoritySummary(
          authorityBeforeRead,
          baselineAuthority
        )
      );
      stableSince = null;
      stableTarget = null;
      if (!(await pause(physicalEventDiagnosticPollMs))) break;
      continue;
    }

    let nodes: readonly AndroidUiNode[];
    try {
      nodes = await source.readNodes();
    } catch {
      retainPhysicalEventDiagnosticObservation(
        observations,
        "hierarchy-read-error"
      );
      stableSince = null;
      stableTarget = null;
      if (!(await pause(physicalEventDiagnosticPollMs))) break;
      continue;
    }

    let authorityAfterRead: PhysicalEventDiagnosticAuthoritySnapshot;
    try {
      authorityAfterRead = source.readAuthority();
    } catch {
      retainPhysicalEventDiagnosticObservation(
        observations,
        "authority-read-error"
      );
      stableSince = null;
      stableTarget = null;
      if (!(await pause(physicalEventDiagnosticPollMs))) break;
      continue;
    }
    const found = selectPhysicalEventDiagnosticTarget(nodes, timelineLabel);
    retainPhysicalEventDiagnosticObservation(
      observations,
      physicalEventDiagnosticAdmissionSummary(
        nodes,
        timelineLabel,
        found,
        authorityAfterRead,
        baselineAuthority
      )
    );
    if (
      !physicalEventDiagnosticAuthorityMatches(
        authorityAfterRead,
        baselineAuthority
      )
    ) {
      stableSince = null;
      stableTarget = null;
      if (!(await pause(physicalEventDiagnosticPollMs))) break;
      continue;
    }

    if (found === null) {
      stableSince = null;
      stableTarget = null;
      if (swipeCount < physicalEventDiagnosticMaximumSwipes) {
        try {
          source.swipe(nodes, direction);
        } catch (error) {
          throw new Error(
            `${message} (swipe-geometry-invalid;direction=${direction};swipes=${swipeCount}).`,
            { cause: error }
          );
        }
        swipeCount += 1;
        if (!(await pause(physicalEventDiagnosticSwipeSettleMs))) break;
        continue;
      }
    } else {
      const observedAt = readNow();
      const retainedSameTarget =
        stableTarget !== null &&
        physicalAggregateNodeMatches(stableTarget.action, found.action) &&
        physicalAggregateNodeMatches(stableTarget.label, found.label);
      if (stableSince === null || !retainedSameTarget) {
        stableSince = observedAt;
        stableTarget = found;
      } else if (
        observedAt - stableSince >= physicalEventDiagnosticStableWindowMs
      ) {
        return found;
      }
    }
    if (!(await pause(physicalEventDiagnosticPollMs))) break;
  }

  const diagnostic =
    `${message} (direction=${direction};swipes=${swipeCount};states=${
      observations.join("||") || "none"
    }).`;
  requireCondition(
    Buffer.byteLength(diagnostic, "utf8") <= 4_096,
    "Physical event-diagnostic timeout exceeded its private-safe bound."
  );
  throw new Error(diagnostic);
}

function readPhysicalEventDiagnosticAuthoritySnapshot(
  input: Readonly<{
    readonly prompt: PhysicalPromptRuntime;
    readonly requestInspection: RequestInspection;
  }>
): PhysicalEventDiagnosticAuthoritySnapshot {
  requireCondition(
    Number.isSafeInteger(input.requestInspection.sessionEventRequests) &&
      input.requestInspection.sessionEventRequests ===
        Math.abs(input.requestInspection.sessionEventRequests),
    "Physical event-diagnostic request authority was invalid."
  );
  return Object.freeze({
    navigation: readPhysicalSessionNavigationSnapshot(input),
    sessionEventRequests: input.requestInspection.sessionEventRequests
  });
}

function physicalEventDiagnosticAuthorityMatches(
  actual: PhysicalEventDiagnosticAuthoritySnapshot,
  expected: PhysicalEventDiagnosticAuthoritySnapshot
): boolean {
  return (
    actual.sessionEventRequests === expected.sessionEventRequests &&
    physicalSessionNavigationMatches(actual.navigation, expected.navigation)
  );
}

function physicalEventDiagnosticAuthoritySummary(
  actual: PhysicalEventDiagnosticAuthoritySnapshot,
  baseline: PhysicalEventDiagnosticAuthoritySnapshot
): string {
  return (
    `authority=${
      physicalEventDiagnosticAuthorityMatches(actual, baseline) ? "match" : "drift"
    };event_delta=${
      actual.sessionEventRequests - baseline.sessionEventRequests
    };navigation=${
      physicalSessionNavigationMatches(actual.navigation, baseline.navigation)
        ? "match"
        : "drift"
    };actual=${physicalSessionNavigationSummary(actual.navigation)};` +
    `baseline=${physicalSessionNavigationSummary(baseline.navigation)}`
  );
}

function retainPhysicalEventDiagnosticObservation(
  observations: string[],
  observation: string
): void {
  requireCondition(
    Buffer.byteLength(observation, "utf8") >= 1 &&
      Buffer.byteLength(observation, "utf8") <=
        physicalEventDiagnosticObservationMaxBytes,
    "Physical event-diagnostic observation exceeded its private-safe bound."
  );
  if (observations.at(-1) === observation) return;
  observations.push(observation);
  if (observations.length > 6) observations.shift();
}

function physicalEventDiagnosticAdmissionSummary(
  nodes: readonly AndroidUiNode[],
  timelineLabel: string,
  target: PhysicalEventDiagnosticTarget | null,
  actualAuthority: PhysicalEventDiagnosticAuthoritySnapshot,
  baselineAuthority: PhysicalEventDiagnosticAuthoritySnapshot
): string {
  const actions = nodes.filter(
    (node) => node.description === "View event details"
  );
  const labels = nodes.filter((node) => node.text === timelineLabel);
  const backCount = nodes.filter(
    (node) => node.description === "Back to Mission Control"
  ).length;
  const dockCounts = physicalSessionControlDescriptions.map(
    (description) =>
      nodes.filter((node) => node.description === description).length
  );
  let content = "blocked";
  try {
    const region = selectPhysicalSessionContentRegion(nodes);
    if (region !== null) content = physicalRegionGeometry(region);
  } catch {
    content = "invalid";
  }
  return (
    `target=${target === null ? "blocked" : "admitted"};` +
    `action=${actions.length}:${
      target?.action === undefined
        ? actions[0] === undefined
          ? "none"
          : privateFreeAndroidUiNodeGeometry(actions[0])
        : privateFreeAndroidUiNodeGeometry(target.action)
    };label=${labels.length}:${
      target?.label === undefined
        ? labels[0] === undefined
          ? "none"
          : privateFreeAndroidUiNodeGeometry(labels[0])
        : privateFreeAndroidUiNodeGeometry(target.label)
    };back=${backCount};dock=${dockCounts.join("/")};content=${content};` +
    physicalEventDiagnosticAuthoritySummary(
      actualAuthority,
      baselineAuthority
    )
  );
}

function requirePhysicalEventDiagnosticAuthorityBeforeTap(
  source: PhysicalEventDiagnosticWaitSource,
  baseline: PhysicalEventDiagnosticAuthoritySnapshot,
  context: PhysicalAggregateOwnerContext,
  target: PhysicalEventDiagnosticTarget,
  timelineLabel: string
): void {
  const selected = selectPhysicalEventDiagnosticTarget(
    context.currentNodes,
    timelineLabel
  );
  requireCondition(
    context.routeOwner === "Event details" &&
      context.node === target.action &&
      selected !== null &&
      physicalAggregateNodeMatches(selected.action, target.action) &&
      physicalAggregateNodeMatches(selected.label, target.label) &&
      context.counterSnapshot.session_event_requests ===
        baseline.sessionEventRequests,
    "Physical event-diagnostic owner or counter drifted before its only tap."
  );
  let actual: PhysicalEventDiagnosticAuthoritySnapshot;
  try {
    actual = source.readAuthority();
  } catch (error) {
    throw new Error(
      "Physical event-diagnostic authority was unreadable before its only tap.",
      { cause: error }
    );
  }
  requireCondition(
    physicalEventDiagnosticAuthorityMatches(actual, baseline),
    `Physical event-diagnostic authority drifted before its only tap (${physicalEventDiagnosticAuthoritySummary(
      actual,
      baseline
    )}).`
  );
}

function physicalEventDiagnosticOwnedTextCount(
  nodes: readonly AndroidUiNode[],
  text: string
): number {
  const header = selectPhysicalFixedSheetHeader(nodes, "Event details");
  if (header === null) return 0;
  return nodes.filter(
    (node) =>
      node.text === text &&
      !node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsFullyInsideRegion(node, header.body)
  ).length;
}

function physicalEventDiagnosticSheetState(
  nodes: readonly AndroidUiNode[]
): PhysicalEventDiagnosticSheetState {
  const titles = nodes.filter(
    (node) => node.text === "Event details" && !node.clickable
  );
  const closes = nodes.filter(
    (node) => node.description === "Close event details" && node.clickable
  );
  const header = selectPhysicalFixedSheetHeader(nodes, "Event details");
  if (header === null) {
    return titles.length === 0 && closes.length === 0 ? "absent" : "invalid";
  }
  const statusRows = [
    ["loading", "Verifying event"],
    ["current", "Event details current"],
    ["failure", "Event verification failed"],
    ["local_only", "Local evidence only"],
    ["retained", "Retained event detail"]
  ] as const;
  const present = statusRows
    .map(([state, text]) => ({
      count: physicalEventDiagnosticOwnedTextCount(nodes, text),
      state
    }))
    .filter((row) => row.count > 0);
  if (present.length === 0) return "open";
  return present.length === 1 && present[0]?.count === 1
    ? present[0].state
    : "invalid";
}

function physicalEventDiagnosticTargetState(
  nodes: readonly AndroidUiNode[],
  target: PhysicalEventDiagnosticTarget,
  timelineLabel: string
): "absent" | "duplicate" | "moved" | "same" {
  const semanticActions = nodes.filter(
    (node) => node.description === "View event details"
  );
  const semanticLabels = nodes.filter((node) => node.text === timelineLabel);
  const sameActions = semanticActions.filter((node) =>
    physicalAggregateNodeMatches(node, target.action)
  );
  const sameLabels = semanticLabels.filter((node) =>
    physicalAggregateNodeMatches(node, target.label)
  );
  if (semanticActions.length > 1 || semanticLabels.length > 1) return "duplicate";
  if (sameActions.length === 1 && sameLabels.length === 1) return "same";
  return semanticActions.length === 0 && semanticLabels.length === 0
    ? "absent"
    : "moved";
}

function physicalEventDiagnosticOutcomeSummary(
  input: PhysicalEventDiagnosticOutcomeInput
): string {
  const actions = input.nodes.filter(
    (node) => node.description === "View event details"
  );
  const labels = input.nodes.filter((node) => node.text === input.timelineLabel);
  const titleCount = input.nodes.filter(
    (node) => node.text === "Event details" && !node.clickable
  ).length;
  const closeCount = input.nodes.filter(
    (node) => node.description === "Close event details" && node.clickable
  ).length;
  const header = selectPhysicalFixedSheetHeader(input.nodes, "Event details");
  const actionGeometry = actions
    .slice(0, 2)
    .map(privateFreeAndroidUiNodeGeometry)
    .join("|");
  const labelGeometry = labels
    .slice(0, 2)
    .map(privateFreeAndroidUiNodeGeometry)
    .join("|");
  return (
    `target=${physicalEventDiagnosticTargetState(
      input.nodes,
      input.target,
      input.timelineLabel
    )};actions=${actions.length}:${actionGeometry || "none"};` +
    `labels=${labels.length}:${labelGeometry || "none"};` +
    `request_delta=${
      input.actualAuthority.sessionEventRequests -
      input.baselineAuthority.sessionEventRequests
    };navigation=${
      physicalSessionNavigationMatches(
        input.actualAuthority.navigation,
        input.baselineAuthority.navigation
      )
        ? "match"
        : "drift"
    };owner=${header === null ? "blocked" : "admitted"};` +
    `title=${titleCount};close=${closeCount};` +
    `heading=${physicalEventDiagnosticOwnedTextCount(
      input.nodes,
      input.heading
    )};limitation=${physicalEventDiagnosticOwnedTextCount(
      input.nodes,
      input.limitation
    )};sheet=${physicalEventDiagnosticSheetState(input.nodes)}`
  );
}

function physicalEventDiagnosticCurrentOutcomeVisible(
  input: PhysicalEventDiagnosticOutcomeInput
): boolean {
  return (
    physicalSessionNavigationMatches(
      input.actualAuthority.navigation,
      input.baselineAuthority.navigation
    ) &&
    input.actualAuthority.sessionEventRequests ===
      input.baselineAuthority.sessionEventRequests + 1 &&
    physicalEventDiagnosticSheetState(input.nodes) === "current" &&
    physicalEventDiagnosticOwnedTextCount(input.nodes, input.heading) === 1 &&
    physicalEventDiagnosticOwnedTextCount(input.nodes, input.limitation) === 1
  );
}

async function runPhysicalStreamRecovery(
  input: ProductionUiEntryInput & { readonly prompt: PhysicalPromptRuntime },
  capture: PhysicalDashboardCapture
): Promise<void> {
  const navigationBefore = readPhysicalSessionNavigationSnapshot(input);
  requireCondition(
    navigationBefore.activeSubscribers === 1,
    "Physical stream recovery did not begin with one selected-session subscriber."
  );
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
          physicalSessionNavigationRecoveryHolding(
            readPhysicalSessionNavigationSnapshot(input),
            navigationBefore
          )
        );
      },
      30_000,
      "Physical Session Detail did not enter one bounded reconnect attempt."
    );
    await waitForStablePhysicalPromptRecoveryTruth(
      input,
      "reconnecting",
      navigationBefore,
      "Physical Session Detail did not expose stable reconnecting write-block truth."
    );
    const recoveryHoldingNodes = await readAndroidUiNodes();
    input.actionRegistry.consume(
      "stream-recovery-observe",
      () => {
        const recovery = input.prompt.recoverySnapshot();
        const navigation = readPhysicalSessionNavigationSnapshot(input);
        return (
          recovery.state === "holding" &&
          recovery.held_requests === 1 &&
          input.prompt.streamFailureCount === 1 &&
          JSON.stringify(input.prompt.streamFailureCodes) === '["source_failed"]' &&
          physicalSessionNavigationRecoveryHolding(
            navigation,
            navigationBefore
          ) &&
          physicalPromptRecoveryHoldingVisible(
            recoveryHoldingNodes,
            navigation.activeSubscribers
          )
        );
      },
      "Physical stream-recovery observation did not retain its exact transition."
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
        physicalSessionNavigationRecoveryCompleted(
          readPhysicalSessionNavigationSnapshot(input),
          navigationBefore
        ),
      45_000,
      "Physical Session Detail did not reconnect exactly once after stream loss."
    );
    await waitForStablePhysicalPromptRecoveryTruth(
      input,
      "completed",
      navigationBefore,
      "Physical Session Detail did not restore stable current completed-composer truth."
    );
    const recoveryCompletedNodes = await readAndroidUiNodes();
    input.actionRegistry.consume(
      "stream-reconnect-observe",
      () => {
        const recovery = input.prompt.recoverySnapshot();
        const navigation = readPhysicalSessionNavigationSnapshot(input);
        return (
          recovery.state === "released" &&
          recovery.held_requests === 1 &&
          input.prompt.streamFailureCount === 1 &&
          JSON.stringify(input.prompt.streamFailureCodes) === '["source_failed"]' &&
          physicalSessionNavigationRecoveryCompleted(
            navigation,
            navigationBefore
          ) &&
          physicalPromptCompletionRestored(
            recoveryCompletedNodes,
            navigation.activeSubscribers
          )
        );
      },
      "Physical stream-reconnect observation did not retain its exact transition."
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
): Promise<boolean> {
  input.controls.markSessionStale();
  const staleNavigationBefore = readPhysicalSessionNavigationSnapshot(input);
  adb(["shell", "input", "keyevent", "KEYCODE_REFRESH"]);
  await waitForPhysicalSessionReloadSettlement(
    {
      readNavigation: () => readPhysicalSessionNavigationSnapshot(input),
      readNodes: readAndroidUiNodes
    },
    staleNavigationBefore,
    "stale",
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
  const currentNavigationBefore = readPhysicalSessionNavigationSnapshot(input);
  adb(["shell", "input", "keyevent", "KEYCODE_REFRESH"]);
  await waitForPhysicalSessionReloadSettlement(
    {
      readNavigation: () => readPhysicalSessionNavigationSnapshot(input),
      readNodes: readAndroidUiNodes
    },
    currentNavigationBefore,
    "current",
    45_000,
    "Physical Session Detail did not recover current projection truth."
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
  let quietExpanded = false;
  try {
    await waitForPhysicalSessionMissingSettlement(
      {
        readNavigation: () => readPhysicalSessionNavigationSnapshot(input),
        readNodes: readAndroidUiNodes
      },
      navigationWhileMissing,
      30_000,
      "Physical Session Detail did not render not-found truth."
    );
    await capture("fe090-50-detail-not-found.png");

    quietExpanded = await returnPhysicalExternalPageToSelectedSession(
      input,
      navigationWhileMissing,
      "not-found",
      "external-selected-not-found"
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
  return quietExpanded;
}

type PhysicalExternalPageReturnContext = "archive" | "clipboard" | "not-found";

async function returnPhysicalExternalPageToSelectedSession(
  input: ProductionUiEntryInput & { readonly prompt: PhysicalPromptRuntime },
  externalNavigation: PhysicalSessionNavigationSnapshot,
  context: PhysicalExternalPageReturnContext,
  selectedActionId: PhysicalAggregateActionId
): Promise<boolean> {
  requireCondition(
    externalNavigation.activeSubscribers === 1 &&
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        externalNavigation
      ),
    `Physical ${context} return did not begin with exact selected-session authority.`
  );
  const navigationWhileBackgrounded = Object.freeze({
    ...externalNavigation,
    activeSubscribers: 0
  });
  adb([...physicalAndroidChromeCloseExternalTabCommand]);
  await waitFor(
    () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        navigationWhileBackgrounded
      ),
    15_000,
    `Physical ${context} Back did not close only the selected-session stream.`
  );
  const missionRequestsBefore = readPhysicalMissionControlRequestSnapshot(
    input.requestInspection
  );
  openChromePath(input.externalOrigin, physicalMissionControlPath);
  await waitForPhysicalMissionControlWriteReady(
    input,
    missionRequestsBefore,
    `Physical ${context} return did not settle current Mission Control authority.`,
    { requireSelectedSession: false }
  );
  requireCondition(
    physicalSessionNavigationMatches(
      readPhysicalSessionNavigationSnapshot(input),
      navigationWhileBackgrounded
    ),
    `Physical ${context} Mission Control return changed selected-session authority.`
  );
  const quietExpanded = await ensurePhysicalQuietSessionQueueExpanded(
    context,
    input,
    context === "not-found" ? "detail-expand-quiet" : "archive-expand-quiet"
  );
  const selected = await waitForPhysicalSelectedNode(
    selectPhysicalMissionControlSession,
    30_000,
    `Physical ${context} return omitted the selected session.`
  );
  const navigationBeforeSelectedReturn =
    readPhysicalSessionNavigationSnapshot(input);
  await input.actionRegistry.tap(
    selectedActionId,
    selected,
    () =>
      physicalSessionNavigationOpened(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBeforeSelectedReturn
      ),
    `Physical ${context} return did not open exactly one selected-session stream.`
  );
  await waitForPhysicalSessionWriteReady(
    input,
    `Physical ${context} return did not restore current Session Detail authority.`
  );
  return quietExpanded;
}

async function ensurePhysicalQuietSessionQueueExpanded(
  context: PhysicalExternalPageReturnContext,
  input: ProductionUiEntryInput & { readonly prompt: PhysicalPromptRuntime },
  actionId: PhysicalAggregateActionId
): Promise<boolean> {
  const current = await readAndroidUiNodes();
  if (selectPhysicalQuietQueueDisclosure(current, true) !== null) {
    return false;
  }
  const countersBefore = readPhysicalAggregateCounterSnapshot(
    input.requestInspection
  );
  const navigationBefore = readPhysicalSessionNavigationSnapshot(input);
  const quietDisclosure = await waitForPhysicalSelectedNode(
    (nodes) => selectPhysicalQuietQueueDisclosure(nodes, false),
    30_000,
    `Physical ${context} return omitted the collapsed quiet-session control.`
  );
  await input.actionRegistry.tap(
    actionId,
    quietDisclosure,
    async () => {
      const countersAfter = readPhysicalAggregateCounterSnapshot(
        input.requestInspection
      );
      return (
        selectPhysicalQuietQueueDisclosure(await readAndroidUiNodes(), true) !==
          null &&
        physicalExactNumericTransition(countersBefore, countersAfter, {}) &&
        physicalSessionNavigationMatches(
          readPhysicalSessionNavigationSnapshot(input),
          navigationBefore
        )
      );
    },
    `Physical ${context} return did not expand quiet sessions.`
  );
  return true;
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

function physicalSessionNavigationReloaded(
  actual: PhysicalSessionNavigationSnapshot,
  before: PhysicalSessionNavigationSnapshot
): boolean {
  return (
    before.activeSubscribers === 1 &&
    actual.activeSubscribers === 1 &&
    actual.missingDetailRequests === before.missingDetailRequests &&
    actual.openedSubscribers === before.openedSubscribers + 1 &&
    actual.selectedDetailRequests === before.selectedDetailRequests + 1 &&
    actual.streamRequests === before.streamRequests + 1
  );
}

function physicalSessionNavigationRecoveryHolding(
  actual: PhysicalSessionNavigationSnapshot,
  before: PhysicalSessionNavigationSnapshot
): boolean {
  return (
    before.activeSubscribers === 1 &&
    actual.activeSubscribers === 0 &&
    actual.missingDetailRequests === before.missingDetailRequests &&
    actual.openedSubscribers === before.openedSubscribers &&
    actual.selectedDetailRequests === before.selectedDetailRequests &&
    actual.streamRequests === before.streamRequests + 1
  );
}

function physicalSessionNavigationRecoveryCompleted(
  actual: PhysicalSessionNavigationSnapshot,
  before: PhysicalSessionNavigationSnapshot
): boolean {
  return (
    before.activeSubscribers === 1 &&
    actual.activeSubscribers === 1 &&
    actual.missingDetailRequests === before.missingDetailRequests &&
    actual.openedSubscribers === before.openedSubscribers + 1 &&
    actual.selectedDetailRequests === before.selectedDetailRequests &&
    actual.streamRequests === before.streamRequests + 1
  );
}

function physicalSessionReloadTruthVisible(
  nodes: readonly AndroidUiNode[],
  activeSubscribers: number,
  truth: PhysicalSessionReloadTruth
): boolean {
  const count = (value: string): number =>
    nodes.filter((node) => matchesAndroidUiNode(node, "semantic", value)).length;
  const writableTruthCount =
    count("Ready to send") + count("Turn completed");
  return (
    activeSubscribers === 1 &&
    (truth === "stale"
      ? count("Prompt unavailable") === 1 &&
        count("Session state is stale. Refresh before sending.") === 1 &&
        writableTruthCount === 0 &&
        count("Showing stale session state") <= 1
      : writableTruthCount === 1 &&
        count("Showing stale session state") === 0 &&
        count("Prompt unavailable") === 0 &&
        count("Session state is stale. Refresh before sending.") === 0) &&
    count("Activity stream reconnecting") === 0 &&
    count("Session activity is reconnecting.") === 0
  );
}

function physicalSessionReloadTruthSummary(
  nodes: readonly AndroidUiNode[],
  activeSubscribers: number,
  truth: PhysicalSessionReloadTruth
): string {
  const count = (value: string): number =>
    nodes.filter((node) => matchesAndroidUiNode(node, "semantic", value)).length;
  return [
    `active=${activeSubscribers}`,
    `truth=${truth}`,
    `stale=${count("Showing stale session state")}`,
    `ready=${count("Ready to send")}`,
    `completed=${count("Turn completed")}`,
    `reconnecting=${count("Session activity is reconnecting.")}`,
    `unavailable=${count("Prompt unavailable")}`,
    `stale_reason=${count("Session state is stale. Refresh before sending.")}`
  ].join(",");
}

async function waitForPhysicalSessionReloadSettlement(
  source: PhysicalSessionReloadWaitSource,
  before: PhysicalSessionNavigationSnapshot,
  truth: PhysicalSessionReloadTruth,
  timeoutMs: number,
  message: string,
  options: PhysicalSessionReloadWaitOptions = {}
): Promise<void> {
  const now = options.now ?? (() => performance.now());
  const sleep =
    options.sleep ??
    ((milliseconds: number): Promise<void> =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let stableSince: number | null = null;
  let stableObservation: string | null = null;
  const observations: string[] = [];
  while (now() < deadline) {
    let navigation: PhysicalSessionNavigationSnapshot;
    let nodes: readonly AndroidUiNode[];
    try {
      navigation = source.readNavigation();
      nodes = await source.readNodes();
    } catch {
      stableSince = null;
      stableObservation = null;
      if (observations.at(-1) !== "hierarchy-read-error" && observations.length < 6) {
        observations.push("hierarchy-read-error");
      }
      await sleep(Math.min(physicalSessionActionsPollMs, deadline - now()));
      continue;
    }
    const exactNavigation = physicalSessionNavigationReloaded(navigation, before);
    const visible = physicalSessionReloadTruthVisible(
      nodes,
      navigation.activeSubscribers,
      truth
    );
    const observation = `${physicalSessionNavigationSummary(navigation)};${physicalSessionReloadTruthSummary(nodes, navigation.activeSubscribers, truth)}`;
    if (observations.at(-1) !== observation && observations.length < 6) {
      observations.push(observation);
    }
    if (!exactNavigation || !visible) {
      stableSince = null;
      stableObservation = null;
    } else if (stableSince === null || stableObservation !== observation) {
      stableSince = now();
      stableObservation = observation;
    } else if (now() - stableSince >= physicalSessionActionsStableWindowMs) {
      return;
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(physicalSessionActionsPollMs, remaining));
  }
  throw new Error(`${message} (states=${observations.join("||") || "none"}).`);
}

async function waitForPhysicalSessionMissingSettlement(
  source: PhysicalSessionReloadWaitSource,
  expectedNavigation: PhysicalSessionNavigationSnapshot,
  timeoutMs: number,
  message: string,
  options: PhysicalSessionReloadWaitOptions = {}
): Promise<void> {
  const now = options.now ?? (() => performance.now());
  const sleep =
    options.sleep ??
    ((milliseconds: number): Promise<void> =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + timeoutMs;
  let stableSince: number | null = null;
  let stableObservation: string | null = null;
  const observations: string[] = [];
  while (now() < deadline) {
    let navigation: PhysicalSessionNavigationSnapshot;
    let nodes: readonly AndroidUiNode[];
    try {
      navigation = source.readNavigation();
      nodes = await source.readNodes();
    } catch {
      stableSince = null;
      stableObservation = null;
      if (observations.at(-1) !== "hierarchy-or-authority-read-error" && observations.length < 6) {
        observations.push("hierarchy-or-authority-read-error");
      }
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await sleep(Math.min(physicalSessionActionsPollMs, remaining));
      continue;
    }
    const missing = physicalSessionMissingTruthVisible(nodes);
    const exactNavigation = physicalSessionNavigationMatches(
      navigation,
      expectedNavigation
    );
    const observation = `${physicalSessionNavigationSummary(navigation)};${physicalSessionMissingTruthSummary(nodes)}`;
    if (observations.at(-1) !== observation && observations.length < 6) {
      observations.push(observation);
    }
    if (!exactNavigation || !missing) {
      stableSince = null;
      stableObservation = null;
    } else if (stableSince === null || stableObservation !== observation) {
      stableSince = now();
      stableObservation = observation;
    } else if (now() - stableSince >= physicalSessionActionsStableWindowMs) {
      return;
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(physicalSessionActionsPollMs, remaining));
  }
  throw new Error(`${message} (states=${observations.join("||") || "none"}).`);
}

function physicalSessionMissingTruthVisible(
  nodes: readonly AndroidUiNode[]
): boolean {
  const counts = physicalSessionMissingTruthCounts(nodes);
  return (
    counts !== null &&
    counts.unavailable === 2 &&
    counts.reason === 1 &&
    counts.ready === 0 &&
    counts.reconnecting === 0 &&
    counts.promptUnavailable === 0
  );
}

function physicalSessionMissingTruthSummary(
  nodes: readonly AndroidUiNode[]
): string {
  const counts = physicalSessionMissingTruthCounts(nodes);
  return counts === null
    ? "missing=invalid-page"
    : `missing=${physicalSessionMissingTruthVisible(nodes) ? "yes" : "no"},` +
        `unavailable=${counts.unavailable},reason=${counts.reason},` +
        `ready=${counts.ready},reconnecting=${counts.reconnecting},` +
        `prompt=${counts.promptUnavailable}`;
}

function physicalSessionMissingTruthCounts(
  nodes: readonly AndroidUiNode[]
): Readonly<{
  readonly promptUnavailable: number;
  readonly ready: number;
  readonly reason: number;
  readonly reconnecting: number;
  readonly unavailable: number;
}> | null {
  let page: PhysicalScreenshotRegion;
  try {
    page = selectChromePageViewport(nodes);
  } catch {
    return null;
  }
  const count = (value: string): number =>
    nodes.filter(
      (node) =>
        node.text === value &&
        !node.clickable &&
        node.enabled !== false &&
        androidUiNodeIsFullyInsideRegion(node, page)
    ).length;
  return Object.freeze({
    promptUnavailable: count("Prompt unavailable"),
    ready: count("Ready to send"),
    reason: count("This session was not found or is no longer active."),
    reconnecting: count("Session activity is reconnecting."),
    unavailable: count("Session unavailable")
  });
}

function physicalSessionNavigationBackgrounded(
  actual: PhysicalSessionNavigationSnapshot,
  before: PhysicalSessionNavigationSnapshot
): boolean {
  return (
    before.activeSubscribers === 1 &&
    actual.activeSubscribers === 0 &&
    actual.missingDetailRequests === before.missingDetailRequests &&
    actual.openedSubscribers === before.openedSubscribers &&
    actual.selectedDetailRequests === before.selectedDetailRequests &&
    actual.streamRequests === before.streamRequests
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
  const navigationBefore = readPhysicalSessionNavigationSnapshot(input);
  const approvalCallsBefore = physicalDashboardControlCallCount(
    input.controls,
    "respond_approval"
  );
  requireCondition(
    navigationBefore.activeSubscribers === 1 && approvalCallsBefore === 0,
    "Physical approval did not begin with exact selected-session and mutation authority."
  );
  await revealPhysicalSessionContentNode(
    "text",
    "Review & approve",
    "forward",
    30_000,
    "Physical pending approval action was unavailable outside the session dock.",
    true
  );
  await waitForAndroidUiText(
    physicalApprovalAction,
    30_000,
    "Physical pending approval request was unavailable."
  );
  await waitForAndroidUiText(
    physicalApprovalScope,
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
    await input.actionRegistry.tap(
      "approval-open",
      review,
      async () => {
        const nodes = await readAndroidUiNodes();
        return (
          physicalSessionNavigationMatches(
            readPhysicalSessionNavigationSnapshot(input),
            navigationBefore
          ) &&
          physicalDashboardControlCallCount(input.controls, "respond_approval") ===
            approvalCallsBefore &&
          selectPhysicalApprovalConfirmationAction(nodes) !== null
        );
      },
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
  await input.actionRegistry.tap(
    "approval-submit",
    approve,
    () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBefore
      ) &&
      input.controls.hasPendingApproval() &&
      physicalDashboardControlCallCount(input.controls, "respond_approval") ===
        approvalCallsBefore + 1,
    "Physical approval response did not enter one pending request."
  );
  await waitForPhysicalApprovalResponding(
    input,
    navigationBefore,
    approvalCallsBefore,
    30_000,
    "Physical approval did not render owner-local responding truth."
  );
  await capture("fe090-06-approval-responding.png");
  input.controls.releaseApproval();
  await waitForPhysicalApprovalTerminal(
    input,
    navigationBefore,
    approvalCallsBefore,
    30_000,
    "Physical approval did not render exact terminal approved truth."
  );
  await capture("fe090-07-approval-approved.png");
}

async function waitForPhysicalApprovalResponding(
  input: ProductionUiEntryInput & {
    readonly controls: PhysicalDashboardControls;
    readonly prompt: PhysicalPromptRuntime;
  },
  expectedNavigation: PhysicalSessionNavigationSnapshot,
  approvalCallsBefore: number,
  timeoutMs: number,
  message: string
): Promise<void> {
  const observations: string[] = [];
  try {
    await waitFor(async () => {
      try {
        const nodes = await readAndroidUiNodes();
        const checkpoint: PhysicalApprovalCheckpointInput = Object.freeze({
          actualNavigation: readPhysicalSessionNavigationSnapshot(input),
          approvalCalls: physicalDashboardControlCallCount(
            input.controls,
            "respond_approval"
          ),
          approvalCallsBefore,
          expectedNavigation,
          nodes,
          pending: input.controls.hasPendingApproval()
        });
        retainPhysicalApprovalObservation(
          observations,
          physicalApprovalCheckpointSummary(
            checkpoint,
            selectPhysicalApprovalRespondingDialogOwner(nodes) !== null
          )
        );
        return physicalApprovalRespondingCheckpointMatches(checkpoint);
      } catch {
        retainPhysicalApprovalObservation(observations, "read-error");
        return false;
      }
    }, timeoutMs, message);
  } catch {
    throw new Error(
      `${message} (states=${observations.join("||") || "none"}). ` +
        physicalPromptStreamDiagnostic(input)
    );
  }
}

async function waitForPhysicalApprovalTerminal(
  input: ProductionUiEntryInput & {
    readonly controls: PhysicalDashboardControls;
    readonly prompt: PhysicalPromptRuntime;
  },
  expectedNavigation: PhysicalSessionNavigationSnapshot,
  approvalCallsBefore: number,
  timeoutMs: number,
  message: string
): Promise<void> {
  const observations: string[] = [];
  try {
    await waitFor(async () => {
      try {
        const nodes = await readAndroidUiNodes();
        const checkpoint: PhysicalApprovalCheckpointInput = Object.freeze({
          actualNavigation: readPhysicalSessionNavigationSnapshot(input),
          approvalCalls: physicalDashboardControlCallCount(
            input.controls,
            "respond_approval"
          ),
          approvalCallsBefore,
          expectedNavigation,
          nodes,
          pending: input.controls.hasPendingApproval()
        });
        retainPhysicalApprovalObservation(
          observations,
          physicalApprovalCheckpointSummary(
            checkpoint,
            selectPhysicalApprovalTerminalOwner(nodes) !== null
          )
        );
        return physicalApprovalTerminalCheckpointMatches(checkpoint);
      } catch {
        retainPhysicalApprovalObservation(observations, "read-error");
        return false;
      }
    }, timeoutMs, message);
  } catch {
    throw new Error(
      `${message} (states=${observations.join("||") || "none"}). ` +
        physicalPromptStreamDiagnostic(input)
    );
  }
}

async function waitForPhysicalMissionControlWriteReady(
  input: Readonly<{
    readonly prompt?: PhysicalPromptRuntime;
    readonly requestInspection: RequestInspection;
  }>,
  before: PhysicalMissionControlRequestSnapshot,
  message: string,
  options: Readonly<{ readonly requireSelectedSession?: boolean }> = {}
): Promise<void> {
  const observations: string[] = [];
  let stableSince: number | null = null;
  let stableObservation: string | null = null;
  try {
    await waitFor(async () => {
      const nodes = await readAndroidUiNodes();
      const activeSubscribers =
        input.prompt?.subscribers.snapshot().active_subscribers ?? 0;
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
        physicalMissionControlRequestOpened(
          readPhysicalMissionControlRequestSnapshot(input.requestInspection),
          before
        ) &&
        selectPhysicalMissionControlDestination(nodes) !== null &&
        physicalMissionControlWriteReady(
          nodes,
          activeSubscribers,
          options.requireSelectedSession ?? true
        );
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
      }) ${input.prompt === undefined ? "(prompt=not-configured)" : physicalPromptStreamDiagnostic({ prompt: input.prompt, requestInspection: input.requestInspection })}`,
      { cause: error }
    );
  }
}

async function waitForPhysicalMissionControlRouteReady(
  inspection: RequestInspection,
  before: PhysicalMissionControlRequestSnapshot,
  message: string
): Promise<void> {
  const observations: string[] = [];
  let stableSince: number | null = null;
  let stableObservation: string | null = null;
  try {
    await waitFor(async () => {
      const nodes = await readAndroidUiNodes();
      const observation = [
        `requests=${inspection.accessRequests - before.accessRequests}/` +
          `${inspection.hostStatusRequests - before.hostStatusRequests}/` +
          `${inspection.sessionListRequests - before.sessionListRequests}`,
        physicalMissionControlWriteSummary(nodes, 0),
        `shell=${selectPhysicalMissionControlDestination(nodes) === null ? "blocked" : "ready"}`
      ].join(";");
      if (observations.at(-1) !== observation && observations.length < 6) {
        observations.push(observation);
      }
      const ready =
        physicalMissionControlRequestOpened(
          readPhysicalMissionControlRequestSnapshot(inspection),
          before
        ) &&
        physicalMissionControlWriteReady(nodes, 0, false) &&
        selectPhysicalMissionControlDestination(nodes) !== null;
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
      `${message} (states=${observations.join("||") || "none"}).`,
      { cause: error }
    );
  }
}

async function waitForPhysicalMissionControlReloadSettlement(
  source: PhysicalMissionControlReloadWaitSource,
  before: PhysicalMissionControlRequestSnapshot,
  timeoutMs: number,
  message: string,
  options: PhysicalMissionControlReloadWaitOptions = {}
): Promise<void> {
  requireCondition(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0,
    "Physical Mission Control reload waiter timeout was invalid."
  );
  const now = options.now ?? (() => performance.now());
  const sleep =
    options.sleep ??
    ((milliseconds: number): Promise<void> =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  requireCondition(
    Number.isFinite(startedAt) && Number.isFinite(deadline) && deadline > startedAt,
    "Physical Mission Control reload waiter clock or deadline was invalid."
  );
  let stableSince: number | null = null;
  let stableObservation: string | null = null;
  const observations: string[] = [];
  while (now() < deadline) {
    let current: PhysicalMissionControlRequestSnapshot;
    let nodes: readonly AndroidUiNode[];
    try {
      current = source.readRequests();
      nodes = await source.readNodes();
    } catch {
      stableSince = null;
      stableObservation = null;
      if (observations.at(-1) !== "hierarchy-or-request-read-error" && observations.length < 6) {
        observations.push("hierarchy-or-request-read-error");
      }
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await sleep(Math.min(physicalSessionActionsPollMs, remaining));
      continue;
    }
    const shell = selectPhysicalMissionControlDestination(nodes);
    const exactRequests = physicalMissionControlRequestOpened(current, before);
    const ready =
      exactRequests &&
      shell !== null &&
      selectPhysicalMissionControlSession(nodes) !== null &&
      physicalMissionControlWriteReady(nodes, 0, false);
    const observation =
      `requests=${current.accessRequests - before.accessRequests}/` +
      `${current.hostStatusRequests - before.hostStatusRequests}/` +
      `${current.sessionListRequests - before.sessionListRequests};` +
      `shell=${shell === null ? "blocked" : physicalRegionGeometry(shell)};` +
      physicalMissionControlWriteSummary(nodes, 0);
    if (observations.at(-1) !== observation && observations.length < 6) {
      observations.push(observation);
    }
    if (!ready) {
      stableSince = null;
      stableObservation = null;
    } else if (stableSince === null || stableObservation !== observation) {
      stableSince = now();
      stableObservation = observation;
    } else if (now() - stableSince >= 2_000) {
      return;
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(physicalSessionActionsPollMs, remaining));
  }
  throw new Error(`${message} (states=${observations.join("||") || "none"}).`);
}

function physicalMissionControlWriteReady(
  nodes: readonly AndroidUiNode[],
  activeSubscribers: number,
  requireSelectedSession = true
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
    (!requireSelectedSession ||
      descriptionCount(physicalUiSessionName) === 1) &&
    textCount("Remote writes locked") === 0 &&
    textCount("Locked") === 0 &&
    textCount("Access stale") === 0 &&
    textCount("Reconnecting") === 0
  );
}

function readPhysicalMissionControlRequestSnapshot(
  inspection: RequestInspection
): PhysicalMissionControlRequestSnapshot {
  return Object.freeze({
    accessRequests: inspection.accessRequests,
    hostStatusRequests: inspection.hostStatusRequests,
    sessionListRequests: inspection.sessionListRequests
  });
}

function physicalMissionControlRequestOpened(
  current: PhysicalMissionControlRequestSnapshot,
  before: PhysicalMissionControlRequestSnapshot
): boolean {
  return (
    current.accessRequests === before.accessRequests + 1 &&
    current.hostStatusRequests === before.hostStatusRequests + 1 &&
    current.sessionListRequests === before.sessionListRequests + 1
  );
}

function physicalMissionControlRequestSnapshotMatches(
  current: PhysicalMissionControlRequestSnapshot,
  expected: PhysicalMissionControlRequestSnapshot
): boolean {
  return (
    current.accessRequests === expected.accessRequests &&
    current.hostStatusRequests === expected.hostStatusRequests &&
    current.sessionListRequests === expected.sessionListRequests
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

async function waitForPhysicalMissionControlShell(
  input: Readonly<{
    readonly prompt: PhysicalPromptRuntime;
    readonly requestInspection: RequestInspection;
  }>,
  expectedNavigation: PhysicalSessionNavigationSnapshot,
  message: string,
  timeoutMs = 30_000
): Promise<void> {
  let stableSince: number | null = null;
  let stableObservation: string | null = null;
  await waitFor(async () => {
    const nodes = await readAndroidUiNodes();
    const navigation = readPhysicalSessionNavigationSnapshot(input);
    const shell = selectPhysicalMissionControlDestination(nodes);
    const observation = `${shell === null ? "shell=blocked" : `shell=${physicalRegionGeometry(shell)}`};` +
      `navigation=${physicalSessionNavigationSummary(navigation)}`;
    if (
      shell === null ||
      !physicalSessionNavigationMatches(navigation, expectedNavigation)
    ) {
      stableSince = null;
      stableObservation = null;
      return false;
    }
    const now = performance.now();
    if (stableSince === null || stableObservation !== observation) {
      stableSince = now;
      stableObservation = observation;
      return false;
    }
    return now - stableSince >= 2_000;
  }, timeoutMs, message);
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
  } catch (error) {
    throw new Error(`${message} ${physicalPromptStreamDiagnostic(input)}`, {
      cause: error
    });
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
    count("Ready to send") + count("Turn completed") === 1 &&
    count("Activity stream reconnecting") === 0 &&
    count("Session activity is reconnecting.") === 0 &&
    count("Prompt unavailable") === 0 &&
    count("Showing stale session state") === 0 &&
    count("Session state is stale. Refresh before sending.") === 0
  );
}

function physicalPromptRecoveryHoldingVisible(
  nodes: readonly AndroidUiNode[],
  activeSubscribers: number
): boolean {
  const count = (value: string): number =>
    nodes.filter((node) => matchesAndroidUiNode(node, "semantic", value)).length;
  return (
    activeSubscribers === 0 &&
    count("Session activity is reconnecting.") === 1 &&
    count("Ready to send") === 0 &&
    count("Prompt unavailable") === 1
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

type PhysicalPromptRecoveryTruth = "reconnecting" | "completed";

async function waitForStablePhysicalPromptRecoveryTruth(
  input: Readonly<{
    readonly prompt: PhysicalPromptRuntime;
    readonly requestInspection: RequestInspection;
  }>,
  truth: PhysicalPromptRecoveryTruth,
  navigationBefore: PhysicalSessionNavigationSnapshot,
  message: string,
  timeoutMs = 30_000
): Promise<void> {
  let stableSince: number | null = null;
  let stableObservation: string | null = null;
  const observations: string[] = [];
  try {
    await waitFor(async () => {
      let nodes: readonly AndroidUiNode[];
      try {
        nodes = await readAndroidUiNodes();
      } catch {
        stableSince = null;
        stableObservation = null;
        if (
          observations.at(-1) !== "hierarchy-read-error" &&
          observations.length < 6
        ) {
          observations.push("hierarchy-read-error");
        }
        return false;
      }
      const subscribers = input.prompt.subscribers.snapshot();
      const active = subscribers.active_subscribers;
      const navigation = readPhysicalSessionNavigationSnapshot(input);
      const recovery = input.prompt.recoverySnapshot();
      const reconnecting = physicalPromptRecoveryHoldingVisible(nodes, active);
      const completed = physicalPromptCompletionRestored(nodes, active);
      const visible = truth === "reconnecting" ? reconnecting : completed;
      const exactNavigation =
        truth === "reconnecting"
          ? physicalSessionNavigationRecoveryHolding(navigation, navigationBefore)
          : physicalSessionNavigationRecoveryCompleted(navigation, navigationBefore);
      const exactRecovery =
        recovery.held_requests === 1 &&
        recovery.state === (truth === "reconnecting" ? "holding" : "released") &&
        input.prompt.streamFailureCount === 1 &&
        JSON.stringify(input.prompt.streamFailureCodes) === '["source_failed"]';
      const observation =
        `truth=${truth};visible=${visible ? "yes" : "no"};` +
        `${physicalSessionNavigationSummary(navigation)};` +
        `recovery=${recovery.state}/${recovery.held_requests};` +
        `failures=${input.prompt.streamFailureCount}`;
      if (observations.at(-1) !== observation && observations.length < 6) {
        observations.push(observation);
      }
      if (!visible || !exactNavigation || !exactRecovery) {
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
    }, timeoutMs, message);
  } catch (error) {
    throw new Error(
      `${message} (states=${observations.join("||") || "none"}).`,
      { cause: error }
    );
  }
}

async function runPhysicalModelControl(
  input: ProductionUiEntryInput & {
    readonly controls: PhysicalDashboardControls;
    readonly prompt: PhysicalPromptRuntime;
  },
  capture: PhysicalDashboardCapture,
  measure: PhysicalDashboardMeasure
): Promise<void> {
  const navigationBefore = readPhysicalSessionNavigationSnapshot(input);
  requireCondition(
    navigationBefore.activeSubscribers === 1,
    "Physical /model flow did not begin with one selected-session subscriber."
  );
  const modelCallsBefore = physicalDashboardControlCallCount(
    input.controls,
    "select_model"
  );
  requireCondition(
    modelCallsBefore === 0,
    "Physical /model flow started with a prechanged mutation count."
  );
  const triggerLabel = `/model for ${physicalUiSessionName}`;
  const trigger = await waitForPhysicalSelectedNode(
    (nodes) => selectPhysicalSessionDockAction(nodes, 1, triggerLabel),
    30_000,
    "Physical /model trigger was unavailable."
  );
  measure(trigger, "open-model");
  await input.actionRegistry.tap(
    "model-open",
    trigger,
    async () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBefore
      ) &&
      physicalSheetChoiceSelected(
        await readAndroidUiNodes(),
        "/model",
        "Codex Current",
      ),
    "Physical /model did not show current model truth."
  );
  const fast = await waitForPhysicalSelectedNode(
    (nodes) =>
      selectPhysicalSheetAction(nodes, "semantic", "Codex Fast", "/model"),
    30_000,
    "Physical /model omitted the supported Codex Fast choice."
  );
  await input.actionRegistry.tap(
    "model-select",
    fast,
    async () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBefore
      ) &&
      physicalSheetChoiceSelected(
        await readAndroidUiNodes(),
        "/model",
        "Codex Fast"
      ),
    "Physical /model choice did not settle as a local selection."
  );
  const submit = await waitForPhysicalSelectedNode(
    (nodes) =>
      selectPhysicalSheetAction(nodes, "text", "Set for next turn", "/model"),
    30_000,
    "Physical /model submit action was unavailable."
  );
  measure(submit, "set-model-next-turn");
  requireCondition(
    physicalDashboardControlCallCount(input.controls, "select_model") ===
      modelCallsBefore,
    "Physical /model selection observed a prechanged mutation count."
  );
  await input.actionRegistry.tap(
    "model-submit",
    submit,
    () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBefore
      ) &&
      input.controls.hasPendingModel() &&
      physicalDashboardControlCallCount(input.controls, "select_model") ===
        modelCallsBefore + 1,
    "Physical /model selection did not enter one pending request."
  );
  await waitFor(
    async () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBefore
      ) &&
      physicalFixedSheetTextVisible(
        await readAndroidUiNodes(),
        "/model",
        "Saving next-turn model"
      ),
    30_000,
    "Physical /model did not render its submitting state."
  );
  await capture("fe090-12-model-submitting.png");
  input.controls.releaseModel();
  await waitFor(
    async () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBefore
      ) &&
      physicalFixedSheetTextVisible(
        await readAndroidUiNodes(),
        "/model",
        "Model staged for next turn"
      ),
    30_000,
    "Physical /model did not render accepted next-turn truth."
  );
  await capture("fe090-13-model-staged.png");
  input.controls.applyModel();
  await closePhysicalDialog(
    input.actionRegistry,
    "model-close",
    "Close model control",
    () => physicalSessionNavigationMatches(
      readPhysicalSessionNavigationSnapshot(input),
      navigationBefore
    )
  );

  const reopened = await waitForPhysicalSelectedNode(
    (nodes) => selectPhysicalSessionDockAction(nodes, 1, triggerLabel),
    30_000,
    "Physical /model trigger was unavailable after close."
  );
  await input.actionRegistry.tap(
    "model-reopen",
    reopened,
    async () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBefore
      ) &&
      selectPhysicalDialogCloseAction(
        await readAndroidUiNodes(),
        "Close model control"
      ) !== null,
    "Physical /model did not reopen with current state."
  );
  await waitFor(
    async () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBefore
      ) &&
      physicalSheetChoiceSelected(
        await readAndroidUiNodes(),
        "/model",
        "Codex Fast"
      ),
    30_000,
    "Physical /model did not retain the applied selection."
  );
  await capture("fe090-14-model-applied.png");
  await closePhysicalDialog(
    input.actionRegistry,
    "model-close-reopen",
    "Close model control",
    () => physicalSessionNavigationMatches(
      readPhysicalSessionNavigationSnapshot(input),
      navigationBefore
    )
  );
}

async function runPhysicalGoalControl(
  input: ProductionUiEntryInput & {
    readonly controls: PhysicalDashboardControls;
    readonly prompt: PhysicalPromptRuntime;
  },
  capture: PhysicalDashboardCapture,
  measure: PhysicalDashboardMeasure
): Promise<void> {
  const navigationBefore = readPhysicalSessionNavigationSnapshot(input);
  requireCondition(
    navigationBefore.activeSubscribers === 1,
    "Physical /goal flow did not begin with one selected-session subscriber."
  );
  const goalCallsBefore = physicalDashboardControlCallCount(
    input.controls,
    "mutate_goal"
  );
  requireCondition(
    goalCallsBefore === 0,
    "Physical /goal flow started with a prechanged mutation count."
  );
  const trigger = await waitForPhysicalSelectedNode(
    (nodes) => selectPhysicalSessionDockAction(nodes, 1, `/goal for ${physicalUiSessionName}`),
    30_000,
    "Physical /goal trigger was unavailable."
  );
  measure(trigger, "open-goal");
  await input.actionRegistry.tap(
    "goal-open",
    trigger,
    async () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBefore
      ) && physicalGoalCurrentTruthVisible(await readAndroidUiNodes()),
    "Physical /goal did not render current objective truth."
  );
  await capture("fe090-15-goal-current.png");
  const editor = await waitForPhysicalSelectedNode(
    (nodes) => selectPhysicalSheetEditor(nodes, "/goal", "Goal objective"),
    30_000,
    "Physical Goal objective editor was unavailable."
  );
  await input.actionRegistry.tap(
    "goal-editor",
    editor,
    () =>
      isAndroidKeyboardVisible() &&
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBefore
      ) &&
      physicalDashboardControlCallCount(input.controls, "mutate_goal") ===
        goalCallsBefore,
    "Physical Goal objective editor did not open the keyboard."
  );
  enterPhysicalSingleLineText(physicalGoalObjective);
  await waitFor(
    async () => {
      const edited = selectPhysicalSheetEditor(
        await readAndroidUiNodes(),
        "/goal",
        "Goal objective"
      );
      return (
        edited?.text === physicalGoalObjective &&
        physicalSessionNavigationMatches(
          readPhysicalSessionNavigationSnapshot(input),
          navigationBefore
        ) &&
        physicalDashboardControlCallCount(input.controls, "mutate_goal") ===
          goalCallsBefore
      );
    },
    15_000,
    "Physical Goal objective did not retain owner-local edited text."
  );
  adb(["shell", "input", "keyevent", "KEYCODE_BACK"]);
  await waitFor(
    () => !isAndroidKeyboardVisible(),
    10_000,
    "Physical Goal objective keyboard did not close."
  );
  const save = await waitForPhysicalSelectedNode(
    (nodes) =>
      selectPhysicalSheetAction(nodes, "text", "Create paused goal", "/goal"),
    30_000,
    "Physical Goal save action was unavailable."
  );
  measure(save, "create-paused-goal");
  requireCondition(
    physicalDashboardControlCallCount(input.controls, "mutate_goal") ===
      goalCallsBefore,
    "Physical Goal flow observed a prechanged mutation count."
  );
  await input.actionRegistry.tap(
    "goal-save",
    save,
    () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBefore
      ) &&
      input.controls.hasPendingGoal() &&
      physicalDashboardControlCallCount(input.controls, "mutate_goal") ===
        goalCallsBefore + 1,
    "Physical Goal mutation did not enter one pending request."
  );
  await waitFor(
    async () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBefore
      ) &&
      physicalFixedSheetTextVisible(
        await readAndroidUiNodes(),
        "/goal",
        "Saving paused goal"
      ),
    30_000,
    "Physical Goal did not render accepted transition truth."
  );
  await capture("fe090-16-goal-submitting.png");
  input.controls.releaseGoal();
  await waitFor(
    async () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBefore
      ) && physicalGoalTerminalTruthVisible(await readAndroidUiNodes()),
    30_000,
    "Physical Goal did not render terminal paused truth."
  );
  await capture("fe090-17-goal-created.png");
  await closePhysicalDialog(
    input.actionRegistry,
    "goal-close",
    "Close goal control",
    () => physicalSessionNavigationMatches(
      readPhysicalSessionNavigationSnapshot(input),
      navigationBefore
    )
  );
}

async function runPhysicalPlanControl(
  input: ProductionUiEntryInput & {
    readonly controls: PhysicalDashboardControls;
    readonly prompt: PhysicalPromptRuntime;
  },
  capture: PhysicalDashboardCapture,
  measure: PhysicalDashboardMeasure
): Promise<void> {
  const navigationBefore = readPhysicalSessionNavigationSnapshot(input);
  requireCondition(
    navigationBefore.activeSubscribers === 1,
    "Physical /plan flow did not begin with one selected-session subscriber."
  );
  const planCallsBefore = physicalDashboardControlCallCount(
    input.controls,
    "select_plan"
  );
  requireCondition(
    planCallsBefore === 0,
    "Physical /plan flow started with a prechanged mutation count."
  );
  const triggerLabel = `/plan for ${physicalUiSessionName}`;
  const trigger = await waitForPhysicalSelectedNode(
    (nodes) => selectPhysicalSessionDockAction(nodes, 1, triggerLabel),
    30_000,
    "Physical /plan trigger was unavailable."
  );
  measure(trigger, "open-plan");
  await openPhysicalPlanSheet(
    input.actionRegistry,
    "plan-open",
    trigger,
    input.requestInspection,
    "Default",
    () => physicalSessionNavigationMatches(
      readPhysicalSessionNavigationSnapshot(input),
      navigationBefore
    )
  );
  await waitForAndroidUiText(
    "Default",
    30_000,
    "Physical /plan omitted the current Default mode."
  );
  await capture("fe090-18-plan-current.png");
  const plan = await waitForPhysicalSelectedNode(
    (nodes) => selectPhysicalSheetAction(nodes, "semantic", "Plan", "/plan"),
    30_000,
    "Physical /plan omitted the supported Plan choice."
  );
  await input.actionRegistry.tap(
    "plan-select",
    plan,
    async () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBefore
      ) &&
      physicalSheetChoiceSelected(
        await readAndroidUiNodes(),
        "/plan",
        "Plan"
      ),
    "Physical /plan choice did not settle as a local selection."
  );
  const submit = await waitForPhysicalSelectedNode(
    (nodes) => selectPhysicalSheetAction(nodes, "text", "Set for next turn", "/plan"),
    30_000,
    "Physical /plan submit action was unavailable."
  );
  measure(submit, "set-plan-next-turn");
  requireCondition(
    physicalDashboardControlCallCount(input.controls, "select_plan") ===
      planCallsBefore,
    "Physical /plan selection observed a prechanged mutation count."
  );
  await input.actionRegistry.tap(
    "plan-submit",
    submit,
    () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBefore
      ) &&
      input.controls.hasPendingPlan() &&
      physicalDashboardControlCallCount(input.controls, "select_plan") ===
        planCallsBefore + 1,
    "Physical /plan selection did not enter one pending request."
  );
  await waitFor(
    async () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBefore
      ) && physicalPlanSubmittingTruthVisible(await readAndroidUiNodes()),
    30_000,
    "Physical /plan did not render its submitting state."
  );
  await capture("fe090-19-plan-submitting.png");
  input.controls.releasePlan();
  await waitFor(
    async () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBefore
      ) && physicalPlanStagedTruthVisible(await readAndroidUiNodes()),
    30_000,
    "Physical /plan did not render accepted next-turn truth."
  );
  await capture("fe090-20-plan-staged.png");
  input.controls.applyPlan();
  await closePhysicalDialog(
    input.actionRegistry,
    "plan-close",
    "Close Plan control",
    () => physicalSessionNavigationMatches(
      readPhysicalSessionNavigationSnapshot(input),
      navigationBefore
    )
  );
  const reopened = await waitForPhysicalSelectedNode(
    (nodes) => selectPhysicalSessionDockAction(nodes, 1, triggerLabel),
    30_000,
    "Physical /plan trigger was unavailable after close."
  );
  await openPhysicalPlanSheet(
    input.actionRegistry,
    "plan-reopen",
    reopened,
    input.requestInspection,
    "Plan",
    () => physicalSessionNavigationMatches(
      readPhysicalSessionNavigationSnapshot(input),
      navigationBefore
    )
  );
  await capture("fe090-21-plan-applied.png");
  await closePhysicalDialog(
    input.actionRegistry,
    "plan-close-reopen",
    "Close Plan control",
    () => physicalSessionNavigationMatches(
      readPhysicalSessionNavigationSnapshot(input),
      navigationBefore
    )
  );
}

async function openPhysicalPlanSheet(
  actionRegistry: PhysicalAggregateActionRegistry,
  actionId: PhysicalAggregateActionId,
  trigger: AndroidUiNode,
  inspection: RequestInspection,
  expectedCurrentMode: "Default" | "Plan",
  navigationStable: (() => boolean) | undefined = undefined
): Promise<void> {
  const readsBefore = inspection.planReadRequests;
  await actionRegistry.tap(
    actionId,
    trigger,
    async () =>
      (navigationStable === undefined || navigationStable()) &&
      physicalPlanCurrentTruthVisible(
        await readAndroidUiNodes(),
        expectedCurrentMode
      ),
    "Physical /plan did not render visible current-mode truth."
  );
  requireCondition(
    inspection.planReadRequests === readsBefore + 1,
    "Physical /plan did not issue exactly one current-mode read."
  );
}

function physicalPlanCurrentTruthVisible(
  nodes: readonly AndroidUiNode[],
  expectedCurrentMode: "Default" | "Plan"
): boolean {
  const header = selectPhysicalFixedSheetHeader(nodes, "/plan");
  if (header === null) return false;
  return (
    physicalPlanModeOwnsRailAndOption(nodes, expectedCurrentMode) &&
    physicalSheetChoiceSelected(nodes, "/plan", expectedCurrentMode) &&
    ["No pending change", "No observed Plan execution"].every((label) =>
      nodes.filter(
        (node) =>
          node.text === label &&
          !node.clickable &&
          node.enabled !== false &&
          androidUiNodeIsFullyInsideRegion(node, header.body)
      ).length === 1
    )
  );
}

function physicalPlanSubmittingTruthVisible(
  nodes: readonly AndroidUiNode[]
): boolean {
  return physicalFixedSheetTextVisible(
    nodes,
    "/plan",
    "A Plan selection is already being saved."
  );
}

function physicalPlanStagedTruthVisible(nodes: readonly AndroidUiNode[]): boolean {
  const header = selectPhysicalFixedSheetHeader(nodes, "/plan");
  if (header === null) return false;
  return (
    physicalPlanModeOwnsRailAndOption(nodes, "Plan") &&
    physicalSheetChoiceSelected(nodes, "/plan", "Plan") &&
    [
      "Pending next turn: Staged in HostDeck",
      "No observed Plan execution"
    ].every((label) =>
      nodes.filter(
        (node) =>
          node.text === label &&
          !node.clickable &&
          node.enabled !== false &&
          androidUiNodeIsFullyInsideRegion(node, header.body)
      ).length === 1
    )
  );
}

function physicalPlanModeOwnsRailAndOption(
  nodes: readonly AndroidUiNode[],
  value: "Default" | "Plan"
): boolean {
  const header = selectPhysicalFixedSheetHeader(nodes, "/plan");
  if (header === null) return false;
  const ownedLabels = nodes.filter(
    (node) =>
      node.text === value &&
      !node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsFullyInsideRegion(node, header.body)
  );
  return (
    ownedLabels.length === 2 &&
    ownedLabels[0] !== undefined &&
    ownedLabels[1] !== undefined &&
    ownedLabels[1].bounds.top > ownedLabels[0].bounds.bottom
  );
}

async function runPhysicalSessionUtilities(
  input: ProductionUiEntryInput & {
    readonly controls: PhysicalDashboardControls;
    readonly prompt: PhysicalPromptRuntime;
  },
  capture: PhysicalDashboardCapture,
  measure: PhysicalDashboardMeasure
): Promise<void> {
  const navigationBefore = readPhysicalSessionNavigationSnapshot(input);
  requireCondition(
    navigationBefore.activeSubscribers === 1,
    "Physical session utilities did not begin with one selected-session subscriber."
  );
  const compactCallsBefore = physicalDashboardControlCallCount(
    input.controls,
    "start_compact"
  );
  const more = await waitForPhysicalSelectedNode(
    (nodes) =>
      selectPhysicalSessionDockAction(
        nodes,
        1,
        `More session utilities for ${physicalUiSessionName}`
      ),
    30_000,
    "Physical session utilities trigger was unavailable."
  );
  measure(more, "open-session-utilities");
  await input.actionRegistry.tap(
    "utilities-open",
    more,
    async () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBefore
      ) &&
      selectPhysicalDialogCloseAction(
        await readAndroidUiNodes(),
        "Close session utilities"
      ) !== null,
    "Physical session utilities did not open."
  );
  await capture("fe090-22-utilities-menu.png");

  const usage = await waitForPhysicalSelectedNode(
    (nodes) =>
      selectPhysicalSessionUtilityAction(
        nodes,
        "description",
        "Open /usage"
      ),
    30_000,
    "Physical /usage utility was unavailable."
  );
  measure(usage, "open-usage");
  await input.actionRegistry.tap(
    "usage-open",
    usage,
    async () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBefore
      ) &&
      selectPhysicalUtilityBackAction(
        await readAndroidUiNodes(),
        "/usage"
      ) !== null,
    "Physical /usage did not render current bounded usage."
  );
  await waitFor(
    async () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBefore
      ) &&
      physicalUtilityPageTextVisible(
        await readAndroidUiNodes(),
        "/usage",
        "Lifetime tokens"
      ),
    30_000,
    "Physical /usage omitted owned account totals."
  );
  await capture("fe090-23-usage.png");
  await returnToPhysicalSessionUtilities(
    input.actionRegistry,
    "usage-back",
    "/usage",
    () => physicalSessionNavigationMatches(
      readPhysicalSessionNavigationSnapshot(input),
      navigationBefore
    )
  );

  const compact = await waitForPhysicalSelectedNode(
    (nodes) =>
      selectPhysicalSessionUtilityAction(
        nodes,
        "description",
        "Open /compact"
      ),
    30_000,
    "Physical /compact utility was unavailable."
  );
  measure(compact, "open-compact");
  const compactReadsBeforeOpen = physicalDashboardControlCallCount(
    input.controls,
    "read_compact"
  );
  await input.actionRegistry.tap(
    "compact-open",
    compact,
    async () => {
      const nodes = await readAndroidUiNodes();
      return (
        physicalSessionNavigationMatches(
          readPhysicalSessionNavigationSnapshot(input),
          navigationBefore
        ) &&
        selectPhysicalUtilityPageAction(
          nodes,
          "/compact",
          "description",
          "Check Compact progress"
        ) === null &&
        selectPhysicalUtilityPageAction(
          nodes,
          "/compact",
          "text",
          "Compact context"
        ) !== null
        && physicalDashboardControlCallCount(input.controls, "read_compact") ===
          compactReadsBeforeOpen + 1
      );
    },
    "Physical /compact did not render current progress truth."
  );
  const begin = await waitForPhysicalSelectedNode(
    (nodes) =>
      selectPhysicalUtilityPageAction(
        nodes,
        "/compact",
        "text",
        "Compact context"
      ),
    30_000,
    "Physical /compact action was unavailable."
  );
  measure(begin, "compact-context");
  await input.actionRegistry.tap(
    "compact-begin",
    begin,
    async () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBefore
      ) &&
      selectPhysicalConfirmationFooterAction(
        await readAndroidUiNodes(),
        "Confirm context compaction",
        "Confirm compact"
      ) !== null,
    "Physical /compact confirmation did not open."
  );
  await capture("fe090-24-compact-confirmation.png");
  const confirm = await waitForPhysicalConfirmationAction(
    "Confirm context compaction",
    "Confirm compact",
    30_000,
    "Physical /compact final confirmation was unavailable."
  );
  measure(confirm, "confirm-compact");
  requireCondition(
    physicalDashboardControlCallCount(input.controls, "start_compact") ===
      compactCallsBefore &&
    compactCallsBefore === 0,
    "Physical /compact confirmation started with a prechanged mutation count."
  );
  await input.actionRegistry.tap(
    "compact-confirm",
    confirm,
    () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBefore
      ) &&
      input.controls.hasPendingCompact() &&
      physicalDashboardControlCallCount(input.controls, "start_compact") ===
        compactCallsBefore + 1,
    "Physical /compact did not enter one pending request."
  );
  await waitFor(
    async () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBefore
      ) &&
      physicalUtilityPageTextVisible(
        await readAndroidUiNodes(),
        "/compact",
        "Submitting compaction"
      ),
    30_000,
    "Physical /compact omitted submitting truth."
  );
  await capture("fe090-25-compact-submitting.png");
  input.controls.releaseCompact();
  await waitFor(
    async () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBefore
      ) &&
      physicalUtilityPageTextVisible(
        await readAndroidUiNodes(),
        "/compact",
        "Compaction accepted"
      ),
    30_000,
    "Physical /compact omitted accepted truth."
  );
  await capture("fe090-26-compact-accepted.png");
  input.controls.completeCompact();
  const compactReadsBeforeCheck = physicalDashboardControlCallCount(
    input.controls,
    "read_compact"
  );
  const check = await waitForPhysicalSelectedNode(
    (nodes) =>
      selectPhysicalUtilityPageAction(
        nodes,
        "/compact",
        "description",
        "Check Compact progress"
      ),
    30_000,
    "Physical /compact progress check was unavailable."
  );
  await input.actionRegistry.tap(
    "compact-check",
    check,
    async () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBefore
      ) &&
      selectPhysicalUtilityBackAction(
        await readAndroidUiNodes(),
        "/compact"
      ) !== null &&
      physicalDashboardControlCallCount(input.controls, "read_compact") ===
        compactReadsBeforeCheck + 1,
    "Physical /compact omitted terminal completion truth."
  );
  await capture("fe090-27-compact-completed.png");
  await returnToPhysicalSessionUtilities(
    input.actionRegistry,
    "compact-back",
    "/compact",
    () => physicalSessionNavigationMatches(
      readPhysicalSessionNavigationSnapshot(input),
      navigationBefore
    )
  );

  const skills = await waitForPhysicalSelectedNode(
    (nodes) =>
      selectPhysicalSessionUtilityAction(
        nodes,
        "description",
        "Open /skills"
      ),
    30_000,
    "Physical /skills utility was unavailable."
  );
  measure(skills, "open-skills");
  const skillsReadsBefore = physicalDashboardControlCallCount(
    input.controls,
    "read_skills"
  );
  const skillsRequestsBefore = input.requestInspection.skillsRequests;
  const skillsResponseStatusesBefore =
    input.requestInspection.skillsResponseStatuses.length;
  requireCondition(
    skillsReadsBefore === 0 &&
      skillsRequestsBefore === 0 &&
      skillsResponseStatusesBefore === 0,
    "Physical /skills had an unexpected prior read."
  );
  let skillsTransitionState = "unobserved";
  await input.actionRegistry.tap(
    "skills-open",
    skills,
    async () => {
      const nodes = await readAndroidUiNodes();
      skillsTransitionState = physicalSkillsUiStateSummary(
        nodes,
        input.controls,
        physicalSkillsRouteDiagnostic(
          input,
          skillsRequestsBefore,
          skillsResponseStatusesBefore
        )
      );
      return (
        physicalSessionNavigationMatches(
          readPhysicalSessionNavigationSnapshot(input),
          navigationBefore
        ) &&
        selectPhysicalUtilityPageBody(nodes, "/skills") !== null &&
        physicalDashboardControlCallCount(input.controls, "read_skills") ===
          skillsReadsBefore + 1 &&
        input.requestInspection.skillsRequests === skillsRequestsBefore + 1 &&
        input.requestInspection.skillsResponseStatuses.length ===
          skillsResponseStatusesBefore + 1
      );
    },
    () =>
      `Physical /skills did not enter its one-read surface (${skillsTransitionState}).`
  );
  const search = await revealPhysicalSkillsSearch(input.controls);
  await input.actionRegistry.tap(
    "skills-search",
    search,
    () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBefore
      ) && isAndroidKeyboardVisible(),
    "Physical Skills search did not open the keyboard."
  );
  enterPhysicalSingleLineText(physicalSkillSearch);
  await waitFor(
    async () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBefore
      ) &&
      selectPhysicalUtilityPageAction(
        await readAndroidUiNodes(),
        "/skills",
        "text",
        physicalSkillSearch
      ) !== null,
    15_000,
    "Physical Skills search did not retain its owned local filter."
  );
  adb(["shell", "input", "keyevent", "KEYCODE_BACK"]);
  await waitFor(
    () => !isAndroidKeyboardVisible(),
    10_000,
    "Physical Skills search keyboard did not close."
  );
  await waitFor(
    async () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBefore
      ) &&
      physicalUtilityPageTextVisible(
        await readAndroidUiNodes(),
        "/skills",
        "1 matching"
      ),
    15_000,
    "Physical Skills search did not render its owned one matching result."
  );
  await capture("fe090-28-skills.png");
  await returnToPhysicalSessionUtilities(
    input.actionRegistry,
    "skills-back",
    "/skills",
    () => physicalSessionNavigationMatches(
      readPhysicalSessionNavigationSnapshot(input),
      navigationBefore
    )
  );
  await closePhysicalDialog(
    input.actionRegistry,
    "utilities-close",
    "Close session utilities",
    () => physicalSessionNavigationMatches(
      readPhysicalSessionNavigationSnapshot(input),
      navigationBefore
    )
  );
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
  } catch (error) {
    throw new Error(
      `Physical Skills search was unavailable (swipes=${swipeCount};states=${
        observations.length === 0 ? "none" : observations.join("||")
      }).`,
      { cause: error }
    );
  }
  requireCondition(found !== null, "Physical Skills search was unavailable.");
  return found;
}

function physicalSkillsUiStateSummary(
  nodes: readonly AndroidUiNode[],
  controls: PhysicalDashboardControls,
  route: PhysicalSkillsRouteDiagnostic | null = null
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
    `route_requests=${route?.requests ?? 0}`,
    `route_statuses=${
      route === null || route.responseStatuses.length === 0
        ? "none"
        : route.responseStatuses.join(",")
    }`,
    `proxy_rejection=${route?.proxyRejection ?? "none"}`,
    ...state,
    `editors=${pageEditors.length}:${
      pageEditors
        .slice(0, 2)
        .map(privateFreeAndroidUiNodeGeometry)
        .join("|") || "none"
    }`
  ].join(";");
}

function physicalSkillsRouteDiagnostic(
  input: ProductionUiEntryInput,
  requestsBefore: number,
  responseStatusesBefore: number
): PhysicalSkillsRouteDiagnostic {
  const requests = input.requestInspection.skillsRequests - requestsBefore;
  const responseStatuses = input.requestInspection.skillsResponseStatuses.slice(
    responseStatusesBefore
  );
  requireCondition(
    Number.isSafeInteger(requests) &&
      requests >= 0 &&
      requests <= 4 &&
      responseStatuses.length <= 4,
    "Physical Skills route diagnostic exceeded its bounded contract."
  );
  return Object.freeze({
    proxyRejection: input.readProxyRejection(),
    requests,
    responseStatuses: Object.freeze(responseStatuses)
  });
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

function physicalExactNumericTransition(
  before: Readonly<Record<string, number>>,
  current: Readonly<Record<string, number>>,
  expectedDelta: Readonly<Record<string, number>>
): boolean {
  const keys = new Set([
    ...Object.keys(before),
    ...Object.keys(current),
    ...Object.keys(expectedDelta)
  ]);
  return (
    keys.size > 0 &&
    [...keys].every((key) => {
      const beforeValue = before[key];
      const currentValue = current[key];
      const delta = expectedDelta[key] ?? 0;
      return (
        typeof beforeValue === "number" &&
        typeof currentValue === "number" &&
        Number.isSafeInteger(beforeValue) &&
        Number.isSafeInteger(currentValue) &&
        Number.isSafeInteger(delta) &&
        delta >= 0 &&
        currentValue === beforeValue + delta
      );
    })
  );
}

function physicalSelfRevokeBaselineIsExact(
  counter: Readonly<{ readonly revoke_requests: number; readonly revoked_devices: number }>
): boolean {
  const keys = Object.keys(counter).sort();
  return (
    keys.length === 2 &&
    keys.includes("revoke_requests") &&
    keys.includes("revoked_devices") &&
    counter.revoke_requests === 1 &&
    counter.revoked_devices === 1
  );
}

async function returnToPhysicalSessionUtilities(
  actionRegistry: PhysicalAggregateActionRegistry,
  actionId: PhysicalAggregateActionId,
  pageTitle: "/usage" | "/compact" | "/skills",
  navigationStable: (() => boolean) | undefined = undefined
): Promise<void> {
  const back = await waitForPhysicalSelectedNode(
    (nodes) =>
      selectPhysicalUtilityBackAction(
        nodes,
        pageTitle
      ),
    30_000,
    "Physical utility back action was unavailable."
  );
  await actionRegistry.tap(
    actionId,
    back,
    async () =>
      (navigationStable === undefined || navigationStable()) &&
      selectPhysicalDialogCloseAction(
        await readAndroidUiNodes(),
        "Close session utilities"
      ) !== null,
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
  const navigationBefore = readPhysicalSessionNavigationSnapshot(input);
  requireCondition(
    navigationBefore.activeSubscribers === 1,
    "Physical laptop Resume did not begin with one selected-session subscriber."
  );
  const actions = await waitForPhysicalSessionActions(
    {
      readNavigation: () => readPhysicalSessionNavigationSnapshot(input),
      readNodes: readAndroidUiNodes
    },
    30_000,
    "Physical session actions trigger was unavailable.",
    { baseline: navigationBefore }
  );
  measure(actions, "open-session-actions");
  await tapPhysicalSessionActionsOnceAndWait(
    input.actionRegistry,
    "resume-session-actions",
    actions,
    async () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBefore
      ) && selectPhysicalSessionActionsMenuRoot(await readAndroidUiNodes()) !== null,
    "Physical session actions did not open."
  );
  const resume = await waitForPhysicalSelectedNode(
    (nodes) => selectPhysicalSessionActionsMenuAction(nodes, "Open Resume on laptop"),
    30_000,
    "Physical laptop Resume action was unavailable."
  );
  measure(resume, "resume-on-laptop");
  await input.actionRegistry.tap(
    "resume-open",
    resume,
    async () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBefore
      ) && selectPhysicalResumeCopyAction(await readAndroidUiNodes()) !== null,
    "Physical laptop Resume metadata did not render."
  );
  await capture("fe090-29-laptop-resume.png");
  const copy = await waitForPhysicalSelectedNode(
    selectPhysicalResumeCopyAction,
    30_000,
    "Physical laptop Resume copy action was unavailable."
  );
  measure(copy, "copy-resume-command");
  let outcome: "copied" | "unavailable" | null = null;
  await input.actionRegistry.tap(
    "resume-copy",
    copy,
    async () => {
      const nodes = await readAndroidUiNodes();
      const settled = physicalResumeCopyOutcome(nodes);
      if (
        settled === null ||
        !physicalSessionNavigationMatches(
          readPhysicalSessionNavigationSnapshot(input),
          navigationBefore
        )
      ) return false;
      outcome = settled;
      return true;
    },
    "Physical laptop Resume copy outcome was unavailable."
  );
  requireCondition(outcome !== null, "Physical laptop Resume copy did not settle.");
  if (outcome === "copied") {
    await clearPhysicalAndroidClipboard(input);
    return outcome;
  }
  const back = await waitForPhysicalSelectedNode(
    selectPhysicalResumeBackAction,
    30_000,
    "Physical laptop Resume back action was unavailable."
  );
  await input.actionRegistry.tap(
    "resume-back",
    back,
    async () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBefore
      ) && selectPhysicalSessionActionsMenuRoot(await readAndroidUiNodes()) !== null,
    "Physical laptop Resume did not return to session actions."
  );
  await closePhysicalDialog(
    input.actionRegistry,
    "resume-close-session",
    "Close session actions",
    () => physicalSessionNavigationMatches(
      readPhysicalSessionNavigationSnapshot(input),
      navigationBefore
    )
  );
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
    const clear = await waitForPhysicalSelectedNode(
      (nodes) => selectPhysicalExternalPageAction(nodes, "Clear clipboard"),
      30_000,
      "Physical clipboard cleanup action was unavailable."
    );
    await input.actionRegistry.tap(
      "clipboard-clear",
      clear,
      async () =>
        physicalSessionNavigationMatches(
          readPhysicalSessionNavigationSnapshot(input),
          navigationBefore
        ) && physicalClipboardClearedTruthVisible(await readAndroidUiNodes()),
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

    await returnPhysicalExternalPageToSelectedSession(
      input,
      navigationBefore,
      "clipboard",
      "external-selected-clipboard"
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
): Promise<PhysicalSessionActionsHandoff> {
  const interruptCallsBeforeConfirmation = physicalDashboardControlCallCount(
    input.controls,
    "interrupt_turn"
  );
  const interruptCounterBefore = Object.freeze({
    interrupt_turn: interruptCallsBeforeConfirmation
  });
  requireCondition(
    interruptCallsBeforeConfirmation === 0,
    "Physical interrupt flow started with a prechanged mutation count."
  );
  const navigationBeforeRefresh = readPhysicalSessionNavigationSnapshot(input);
  input.controls.beginInterruptibleTurn();
  input.prompt.publishInterruptTurn(
    input.controls.interruptTurnId,
    "in_progress"
  );
  adb(["shell", "input", "keyevent", "KEYCODE_REFRESH"]);
  await waitFor(
    () =>
      physicalSessionNavigationReloaded(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBeforeRefresh
      ),
    45_000,
    "Physical Session Detail did not reconnect once for interrupt truth."
  );
  const admission = createPhysicalSessionActionsAdmissionWindow(
    {
      readNavigation: () => readPhysicalSessionNavigationSnapshot(input),
      readNodes: readAndroidUiNodes
    },
    30_000
  );
  const navigationBeforeAction = admission.baseline;
  const actions = await admission.wait("Physical interrupt session actions were unavailable.");
  await tapPhysicalSessionActionsOnceAndWait(
    input.actionRegistry,
    "interrupt-session-actions",
    actions,
    async () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBeforeAction
      ) &&
      selectPhysicalSessionActionsMenuRoot(await readAndroidUiNodes()) !== null,
    "Physical interrupt action did not open."
  );
  const interrupt = await waitForPhysicalSelectedNode(
    (nodes) => selectPhysicalSessionActionsMenuAction(nodes, "Open Interrupt active turn"),
    30_000,
    "Physical interrupt action was unavailable."
  );
  measure(interrupt, "interrupt-active-turn");
  await input.actionRegistry.tap(
    "interrupt-open",
    interrupt,
    async () => {
      const nodes = await readAndroidUiNodes();
      return (
        selectPhysicalConfirmationFooterAction(
          nodes,
          "Interrupt active turn?",
          "Interrupt turn"
        ) !== null &&
        physicalSessionNavigationMatches(
          readPhysicalSessionNavigationSnapshot(input),
          navigationBeforeAction
        ) &&
        physicalExactNumericTransition(
          interruptCounterBefore,
          Object.freeze({
            interrupt_turn: physicalDashboardControlCallCount(
              input.controls,
              "interrupt_turn"
            )
          }),
          { interrupt_turn: 0 }
        )
      );
    },
    "Physical interrupt confirmation did not open."
  );
  requireCondition(
    physicalExactNumericTransition(
      interruptCounterBefore,
      Object.freeze({
        interrupt_turn: physicalDashboardControlCallCount(
          input.controls,
          "interrupt_turn"
        )
      }),
      { interrupt_turn: 0 }
    ),
    "Physical interrupt confirmation entry dispatched a mutation."
  );
  await capture("fe090-30-interrupt-confirmation.png");
  const confirm = await waitForPhysicalConfirmationAction(
    "Interrupt active turn?",
    "Interrupt turn",
    30_000,
    "Physical interrupt final action was unavailable."
  );
  measure(confirm, "confirm-interrupt");
  requireCondition(
    physicalExactNumericTransition(
      interruptCounterBefore,
      Object.freeze({
        interrupt_turn: physicalDashboardControlCallCount(
          input.controls,
          "interrupt_turn"
        )
      }),
      { interrupt_turn: 0 }
    ),
    "Physical interrupt final action observed an intervening mutation."
  );
  await input.actionRegistry.tap(
    "interrupt-confirm",
    confirm,
    async () =>
      selectPhysicalResultAction(
        await readAndroidUiNodes(),
        ["Turn interrupted"],
        "Done"
      ) !== null &&
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBeforeAction
      ) &&
      physicalExactNumericTransition(
        interruptCounterBefore,
        Object.freeze({
          interrupt_turn: physicalDashboardControlCallCount(
            input.controls,
            "interrupt_turn"
          )
        }),
        { interrupt_turn: 1 }
      ),
    "Physical interrupt did not render terminal truth."
  );
  input.controls.finishInterrupt();
  requireCondition(
    physicalExactNumericTransition(
      interruptCounterBefore,
      Object.freeze({
        interrupt_turn: physicalDashboardControlCallCount(
          input.controls,
          "interrupt_turn"
        )
      }),
      { interrupt_turn: 1 }
    ),
    "Physical interrupt final action did not issue exactly one local mutation."
  );
  input.prompt.publishInterruptTurn(
    input.controls.interruptTurnId,
    "interrupted"
  );
  await capture("fe090-31-turn-interrupted.png");
  const done = await waitForPhysicalInterruptResultDone(
    30_000,
    "Physical interrupt result action was unavailable."
  );
  await input.actionRegistry.tap(
    "interrupt-done",
    done,
    async () => {
      const nodes = await readAndroidUiNodes();
      return (
        physicalSessionWriteReady(
          nodes,
          readPhysicalSessionNavigationSnapshot(input).activeSubscribers
        ) &&
        physicalSessionNavigationMatches(
          readPhysicalSessionNavigationSnapshot(input),
          navigationBeforeAction
        ) &&
        selectPhysicalSessionActionsMenuRoot(nodes) === null &&
        selectPhysicalChromePageText(nodes, "Turn interrupted") === null
      );
    },
    "Physical interrupt result did not restore Session Detail."
  );
  const hostActions = await admission.wait(
    "Physical interrupt result did not settle Session Actions admission."
  );
  return Object.freeze({ admission, node: hostActions });
}

async function runPhysicalHostAccessControls(
  input: ProductionUiEntryInput & {
    readonly env: Readonly<Record<string, string>>;
    readonly manager: TailscaleServeManager;
    readonly prompt: PhysicalPromptRuntime;
  },
  capture: PhysicalDashboardCapture,
  measure: PhysicalDashboardMeasure,
  handoff: PhysicalSessionActionsHandoff
): Promise<void> {
  const managerAttempts = input.manager.snapshot().command_attempts;
  const selectedNavigation = handoff.admission.baseline;
  requireCondition(
    selectedNavigation.activeSubscribers === 1 &&
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        selectedNavigation
      ),
    "Physical Host and access did not begin with retained selected-session authority."
  );
  const actions = handoff.node;
  await tapPhysicalSessionActionsOnceAndWait(
    input.actionRegistry,
    "host-session-actions",
    actions,
    async () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        selectedNavigation
      ) &&
      selectPhysicalSessionActionsMenuRoot(await readAndroidUiNodes()) !== null,
    "Physical Host and access session actions did not open."
  );
  const hostAccess = await waitForPhysicalSelectedNode(
    (nodes) => selectPhysicalSessionActionsMenuAction(nodes, "Open Host and access"),
    30_000,
    "Physical Host and access action was unavailable in Session actions."
  );
  measure(hostAccess, "open-session-host-access");
  await input.actionRegistry.tap(
    "host-open-nested",
    hostAccess,
    async () => {
      const nodes = await readAndroidUiNodes();
      return (
        physicalSessionNavigationMatches(
          readPhysicalSessionNavigationSnapshot(input),
          selectedNavigation
        ) &&
        selectPhysicalHostAccessContentRegion(nodes, "nested") !== null &&
        selectPhysicalHostAccessCloseAction(nodes, "nested") !== null
      );
    },
    "Physical Host and access did not open from Session actions."
  );
  await revealPhysicalHostAccessContentNode(
    "text",
    "Remote access ready",
    "forward",
    30_000,
    "Physical Host and access omitted remote-ready truth."
  );
  await runOneProductionRemoteCheck(input.actionRegistry, "remote-check-nested", input.requestInspection, { context: "nested" });
  requireCondition(
    physicalSessionNavigationMatches(
      readPhysicalSessionNavigationSnapshot(input),
      selectedNavigation
    ),
    "Physical nested remote check changed selected-session authority."
  );
  await revealPhysicalHostAccessContentNode(
    "text",
    "Read & write",
    "backward",
    30_000,
    "Physical Host and access omitted paired permission."
  );
  await capturePhysicalHostAccessEvidence(capture, "fe090-32-host-access.png");

  const officeRevoke = await revealPhysicalHostAccessContentNode(
    "description",
    "Revoke Office browser, Device 2",
    "forward",
    30_000,
    "Physical paired-device list omitted Office browser.",
    true
  );
  measure(officeRevoke, "revoke-office-device");
  const revokeRequestsBeforeConfirmation = input.requestInspection.revokeRequests;
  const revokedDevicesBeforeConfirmation = countMatchingRows(
    input.db,
    "auth_devices",
    "revoked_at IS NOT NULL"
  );
  const revokeCounterBefore = Object.freeze({
    revoke_requests: revokeRequestsBeforeConfirmation,
    revoked_devices: revokedDevicesBeforeConfirmation
  });
  requireCondition(
    revokeRequestsBeforeConfirmation === 0 &&
      revokedDevicesBeforeConfirmation === 0,
    "Physical Office browser revoke started with prechanged authority counters."
  );
  await input.actionRegistry.tap(
    "revoke-open",
    officeRevoke,
    async () => {
      const nodes = await readAndroidUiNodes();
      return (
        selectPhysicalConfirmationFooterAction(
          nodes,
          "Revoke paired device?",
          "Revoke device"
        ) !== null &&
        physicalSessionNavigationMatches(
          readPhysicalSessionNavigationSnapshot(input),
          selectedNavigation
        ) &&
        input.requestInspection.revokeRequests === revokeRequestsBeforeConfirmation &&
        countMatchingRows(input.db, "auth_devices", "revoked_at IS NOT NULL") ===
          revokedDevicesBeforeConfirmation
      );
    },
    "Physical Office browser revoke confirmation did not open."
  );
  await capturePhysicalHostAccessEvidence(
    capture,
    "fe090-33-revoke-confirmation.png"
  );
  const confirmRevoke = await waitForPhysicalConfirmationAction(
    "Revoke paired device?",
    "Revoke device",
    30_000,
    "Physical Office browser revoke action was unavailable."
  );
  measure(confirmRevoke, "confirm-office-revoke");
  requireCondition(
    revokedDevicesBeforeConfirmation === 0,
    "Physical Office browser revoke started with a prechanged local authority count."
  );
  requireCondition(
    physicalExactNumericTransition(
      revokeCounterBefore,
      Object.freeze({
        revoke_requests: input.requestInspection.revokeRequests,
        revoked_devices: countMatchingRows(
          input.db,
          "auth_devices",
          "revoked_at IS NOT NULL"
        )
      }),
      { revoke_requests: 0, revoked_devices: 0 }
    ),
    "Physical Office browser revoke confirmation entry changed its request count."
  );
  requireCondition(
    countMatchingRows(input.db, "auth_devices", "revoked_at IS NOT NULL") ===
      revokedDevicesBeforeConfirmation,
    "Physical Office browser revoke observed an intervening authority mutation."
  );
  await input.actionRegistry.tap(
    "revoke-confirm",
    confirmRevoke,
    async () => {
      const nodes = await readAndroidUiNodes();
      return (
        physicalHostAccessTextVisible(nodes, "nested", "Device revoked") &&
        physicalSessionNavigationMatches(
          readPhysicalSessionNavigationSnapshot(input),
          selectedNavigation
        ) &&
        physicalExactNumericTransition(
          revokeCounterBefore,
          Object.freeze({
            revoke_requests: input.requestInspection.revokeRequests,
            revoked_devices: countMatchingRows(
              input.db,
              "auth_devices",
              "revoked_at IS NOT NULL"
            )
          }),
          { revoke_requests: 1, revoked_devices: 1 }
        )
      );
    },
    "Physical Office browser revoke did not render terminal truth."
  );
  requireCondition(
    physicalExactNumericTransition(
      revokeCounterBefore,
      Object.freeze({
        revoke_requests: input.requestInspection.revokeRequests,
        revoked_devices: countMatchingRows(
          input.db,
          "auth_devices",
          "revoked_at IS NOT NULL"
        )
      }),
      { revoke_requests: 1, revoked_devices: 1 }
    ),
    "Physical Office browser revoke did not revoke exactly one authority."
  );
  await capturePhysicalHostAccessEvidence(capture, "fe090-34-device-revoked.png");

  const lockAuditsBefore = countPhysicalAuditRows(input.db, "lock");
  const lockCounterBefore = Object.freeze({ lock_audits: lockAuditsBefore });
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
  await input.actionRegistry.tap(
    "host-lock-open",
    lock,
    async () =>
      selectPhysicalHostLockConfirmationAction(await readAndroidUiNodes()) !== null &&
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        selectedNavigation
      ) &&
      physicalExactNumericTransition(
        lockCounterBefore,
        Object.freeze({ lock_audits: countPhysicalAuditRows(input.db, "lock") }),
        { lock_audits: 0 }
      ),
    "Physical host-lock confirmation did not open."
  );
  requireCondition(
    physicalExactNumericTransition(
      lockCounterBefore,
      Object.freeze({ lock_audits: countPhysicalAuditRows(input.db, "lock") }),
      { lock_audits: 0 }
    ),
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
  requireCondition(
    physicalExactNumericTransition(
      lockCounterBefore,
      Object.freeze({ lock_audits: countPhysicalAuditRows(input.db, "lock") }),
      { lock_audits: 0 }
    ),
    "Physical Host-lock final action observed an intervening audit mutation."
  );
  await input.actionRegistry.tap(
    "host-lock-confirm",
    confirmLock,
    async () => {
      const nodes = await readAndroidUiNodes();
      return (
        physicalHostAccessTextVisible(
          nodes,
          "nested",
          "Remote writes locked",
          "codexdeck unlock"
        ) &&
        physicalSessionNavigationMatches(
          readPhysicalSessionNavigationSnapshot(input),
          selectedNavigation
        ) &&
        physicalExactNumericTransition(
          lockCounterBefore,
          Object.freeze({ lock_audits: countPhysicalAuditRows(input.db, "lock") }),
          { lock_audits: 2 }
        )
      );
    },
    "Physical host lock did not render locked truth."
  );
  requireCondition(
    physicalExactNumericTransition(
      lockCounterBefore,
      Object.freeze({ lock_audits: countPhysicalAuditRows(input.db, "lock") }),
      { lock_audits: 2 }
    ),
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
  const closeNestedHostAccess = await waitForPhysicalSelectedNode(
    (nodes) => selectPhysicalHostAccessCloseAction(nodes, "nested"),
    30_000,
    "Physical nested Host and access close control was unavailable."
  );
  await input.actionRegistry.tap(
    "host-nested-close",
    closeNestedHostAccess,
    async () => {
      const nodes = await readAndroidUiNodes();
      return (
        physicalSessionNavigationMatches(
          readPhysicalSessionNavigationSnapshot(input),
          selectedNavigation
        ) &&
        selectPhysicalHostAccessContentRegion(nodes, "nested") === null &&
        selectPhysicalSessionActionsMenuRoot(nodes) !== null
      );
    },
    "Physical nested Host and access did not close."
  );
  const navigationBeforeMissionBack = readPhysicalSessionNavigationSnapshot(input);
  requireCondition(
    physicalSessionNavigationMatches(
      navigationBeforeMissionBack,
      selectedNavigation
    ),
    "Physical nested Host and access return rebased selected-session authority."
  );
  const missionBack = await waitForPhysicalSelectedNode(
    (nodes) =>
      selectPhysicalSessionDetailBack(
        nodes,
        navigationBeforeMissionBack.activeSubscribers
      ),
    30_000,
    "Physical locked Session Detail back action was unavailable."
  );
  await input.actionRegistry.tap(
    "host-detail-back",
    missionBack,
    () =>
      physicalSessionNavigationBackgrounded(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBeforeMissionBack
      ),
    "Physical locked Session Detail did not return to Mission Control."
  );
  await waitForPhysicalMissionControlShell(
    input,
    readPhysicalSessionNavigationSnapshot(input),
    "Physical locked Session Detail did not settle Mission Control authority."
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
  input.actionRegistry.consume(
    "local-unlock",
    () =>
      localUnlock.status === 200 &&
      localUnlock.locked === false &&
      input.manager.snapshot().command_attempts === managerAttempts,
    "Physical local unlock observation did not retain exact local-only truth."
  );
  const reloadBefore = readPhysicalMissionControlRequestSnapshot(
    input.requestInspection
  );
  adb(["shell", "input", "keyevent", "KEYCODE_REFRESH"]);
  await waitForPhysicalMissionControlWriteReady(
    input,
    reloadBefore,
    "Physical Mission Control did not settle current write authority after local unlock."
  );
  const navigationBefore = readPhysicalSessionNavigationSnapshot(input);
  const selected = await waitForPhysicalSelectedNode(
    selectPhysicalMissionControlSession,
    30_000,
    "Physical unlocked selected session was unavailable."
  );
  await input.actionRegistry.tap(
    "unlocked-session-open",
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
  const navigationBefore = readPhysicalSessionNavigationSnapshot(input);
  const back = await waitForPhysicalSelectedNode(
    (nodes) => selectPhysicalSessionDetailBack(nodes, navigationBefore.activeSubscribers),
    30_000,
    "Physical Session Detail back action was unavailable."
  );
  await input.actionRegistry.tap(
    "dashboard-detail-back",
    back,
    () =>
      physicalSessionNavigationBackgrounded(
        readPhysicalSessionNavigationSnapshot(input),
        navigationBefore
      ),
    "Physical Session Detail did not navigate back to Mission Control."
  );
  await waitForPhysicalMissionControlShell(
    input,
    readPhysicalSessionNavigationSnapshot(input),
    "Physical Session Detail back navigation did not settle Mission Control authority.",
    15_000
  );
}

async function runPhysicalDashboardProfileSwitch(
  input: ProductionUiEntryInput & {
    readonly env: Readonly<Record<string, string>>;
    readonly foreignServeBefore: ServeStatusFingerprint;
    readonly manager: TailscaleServeManager;
    readonly prompt: PhysicalPromptRuntime;
    readonly profileSwitch: ProfileSwitchInput;
    readonly remote: HostDeckRemoteIngressLifecycle;
    readonly setSelectedProfile: (profile: "away" | "dedicated") => void;
  },
  capture: PhysicalDashboardCapture
): Promise<void> {
  const managerAttempts = input.manager.snapshot().command_attempts;
  const profileExternalState: PhysicalProfileExternalStateSource = Object.freeze({
    readForeignServe: readServeStatusFingerprint,
    readManagerAttempts: () => input.manager.snapshot().command_attempts
  });
  const profileAwaySwitchBefore = readPhysicalProfileAwaySnapshot({
    foreignServe: input.foreignServeBefore,
    managerAttempts,
    requestInspection: input.requestInspection
  });
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
  const profileAwayBefore = readPhysicalProfileAwaySnapshot({
    foreignServe: await readServeStatusFingerprint(),
    managerAttempts: input.manager.snapshot().command_attempts,
    requestInspection: input.requestInspection
  });
  requireCondition(
    physicalProfileAwaySwitchBoundaryIsExact(
      profileAwaySwitchBefore,
      profileAwayBefore
    ),
    "Physical dashboard profile-away rebased unexpected browser or mutation traffic."
  );
  input.actionRegistry.consume(
    "profile-switch-away",
    () =>
      input.remote.readAdmission().admission === "closed" &&
      input.remote.snapshot().active_control_operations === 0 &&
      physicalProfileAwaySwitchBoundaryIsExact(
        profileAwaySwitchBefore,
        profileAwayBefore
      ),
    "Physical dashboard profile-away observation was not exact."
  );
  const refreshAway = await waitForPhysicalSelectedNode(
    selectPhysicalMissionControlRefresh,
    30_000,
    "Physical dashboard refresh was unavailable before profile-away observation."
  );
  await input.actionRegistry.tap(
    "profile-away-refresh",
    refreshAway,
    async () =>
      physicalProfileAwayTruthMatches(
        { ...input, ...profileExternalState },
        profileAwayBefore,
        await readAndroidUiNodes()
      ),
    "Physical dashboard did not render generic profile-away failure.",
    45_000
  );
  await waitForStablePhysicalProfileAwayTruth(
    { ...input, ...profileExternalState },
    profileAwayBefore,
    "Physical dashboard profile-away truth was not stable while admission stayed closed."
  );
  await capture("fe090-38-profile-away.png");

  const profileReturnBefore = readPhysicalProfileReturnSnapshot({
    foreignServe: input.foreignServeBefore,
    managerAttempts,
    requestInspection: input.requestInspection
  });
  await switchSavedProfile(input.profileSwitch.dedicatedProfileId);
  input.setSelectedProfile("dedicated");
  await waitFor(
    () =>
      input.remote.readAdmission().admission === "open" &&
      input.remote.snapshot().active_control_operations === 0,
    15_000,
    "Physical dashboard profile return did not reopen by observation."
  );
  const profileReturnSwitchAfter = readPhysicalProfileReturnSnapshot({
    foreignServe: await readServeStatusFingerprint(),
    managerAttempts: input.manager.snapshot().command_attempts,
    requestInspection: input.requestInspection
  });
  input.actionRegistry.consume(
    "profile-switch-return",
    () =>
      input.remote.readAdmission().admission === "open" &&
      input.remote.snapshot().active_control_operations === 0 &&
      physicalProfileReturnSwitchBoundaryIsExact(
        profileReturnBefore,
        profileReturnSwitchAfter
      ),
    "Physical dashboard profile-return observation rebased browser or mutation traffic."
  );
  const refreshReturn = await waitForPhysicalSelectedNode(
    selectPhysicalMissionControlRefresh,
    30_000,
    "Physical dashboard refresh was unavailable after profile return."
  );
  await input.actionRegistry.tap(
    "profile-return-refresh",
    refreshReturn,
    async () =>
      physicalProfileReturnTruthMatches(
        { ...input, ...profileExternalState },
        profileReturnBefore,
        await readAndroidUiNodes()
      ),
    "Physical dashboard profile return did not refresh session truth.",
    45_000
  );
  await waitForStablePhysicalProfileReturnTruth(
    { ...input, ...profileExternalState },
    profileReturnBefore,
    "Physical dashboard profile return did not recover without re-pairing.",
  );
  await waitForPhysicalSelectedNode(
    selectPhysicalMissionControlSession,
    30_000,
    "Physical dashboard profile return did not restore the selected session."
  );
  await openProductionHostAccessSheet(input.actionRegistry, "profile-global-open");
  await revealPhysicalHostAccessContentNode(
    "text",
    "Remote access ready",
    "forward",
    30_000,
    "Physical dashboard profile return omitted remote-ready truth.",
    false,
    "global"
  );
  await runOneProductionRemoteCheck(input.actionRegistry, "remote-check-profile", input.requestInspection);
  await capturePhysicalHostAccessEvidence(
    capture,
    "fe090-39-profile-recovered.png"
  );
  await closeProductionHostAccessSheet(input.actionRegistry, "profile-global-close");
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
  await openProductionHostAccessSheet(input.actionRegistry, "runtime-incompatible-open");
  await revealPhysicalHostAccessContentNode(
    "text",
    "Remote access ready",
    "forward",
    30_000,
    "Physical runtime compatibility check lost remote-ready truth.",
    false,
    "global"
  );
  await runOneProductionRemoteCheck(input.actionRegistry, "remote-check-runtime-incompatible", input.requestInspection, {
    expectedRuntime: "incompatible"
  });
  await closeProductionHostAccessSheet(input.actionRegistry, "runtime-incompatible-close");
  await waitForPhysicalMissionRuntimeState(
    input.prompt,
    "incompatible",
    "Physical Mission Control did not render incompatible runtime truth."
  );
  await capture("fe090-51-runtime-incompatible.png");

  input.setRuntimeCompatible(true);
  await openProductionHostAccessSheet(input.actionRegistry, "runtime-supported-open");
  await revealPhysicalHostAccessContentNode(
    "text",
    "Remote access ready",
    "forward",
    30_000,
    "Physical runtime recovery check lost remote-ready truth.",
    false,
    "global"
  );
  await runOneProductionRemoteCheck(input.actionRegistry, "remote-check-runtime-supported", input.requestInspection, {
    expectedRuntime: "supported"
  });
  await closeProductionHostAccessSheet(input.actionRegistry, "runtime-supported-close");
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

function selectPhysicalMissionRuntimeStateNode(
  nodes: readonly AndroidUiNode[],
  expectation: PhysicalRuntimeExpectation
): AndroidUiNode | null {
  if (selectPhysicalMissionControlDestination(nodes) === null) return null;
  return selectPhysicalChromePageText(
    nodes,
    expectation === "incompatible"
      ? physicalRuntimeIncompatibleTitle
      : "Mission Control"
  );
}

async function waitForPhysicalMissionRuntimeState(
  prompt: PhysicalPromptRuntime,
  expectation: PhysicalRuntimeExpectation,
  message: string
): Promise<void> {
  await waitForPhysicalSelectedNode(
    (nodes) => selectPhysicalMissionRuntimeStateNode(nodes, expectation),
    30_000,
    message
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
  input: ProductionUiEntryInput & { readonly prompt: PhysicalPromptRuntime },
  artifacts: PhysicalTalkBackArtifacts
): Promise<PhysicalTalkBackResult> {
  const service = requireAndroidTalkBackService();
  requireCondition(
    new URL(input.externalOrigin).protocol === "https:",
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
    const navigationBeforeSessionOpen = readPhysicalSessionNavigationSnapshot(input);
    requireCondition(
      navigationBeforeSessionOpen.activeSubscribers === 0,
      "TalkBack selected-session traversal retained a background stream."
    );
    const selectedSessionClick = await activatePhysicalTalkBackFocus(
      observer,
      selectedSession,
      input.actionRegistry,
      "talkback-open-session",
      async () => {
        const navigation = readPhysicalSessionNavigationSnapshot(input);
        return (
          physicalSessionNavigationOpened(navigation, navigationBeforeSessionOpen) &&
          physicalSessionWriteReady(
            await readAndroidUiNodes(),
            navigation.activeSubscribers
          )
        );
      },
      "TalkBack did not activate the selected session with double-tap-anywhere."
    );
    await waitForAndroidUiText(
      "Ready to send",
      30_000,
      "TalkBack did not open Session Detail."
    );
    const sessionNavigation = readPhysicalSessionNavigationSnapshot(input);
    requireCondition(
      physicalSessionNavigationOpened(
        sessionNavigation,
        navigationBeforeSessionOpen
      ),
      "TalkBack selected-session activation did not retain exact navigation truth."
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
      input.actionRegistry,
      "talkback-model-open",
      async () =>
        physicalSessionNavigationMatches(
          readPhysicalSessionNavigationSnapshot(input),
          sessionNavigation
        ) &&
        physicalFixedSheetTextVisible(
          await readAndroidUiNodes(),
          "/model",
          "Model control ready"
        ),
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
      input.actionRegistry,
      "talkback-model-close",
      async () =>
        physicalSessionNavigationMatches(
          readPhysicalSessionNavigationSnapshot(input),
          sessionNavigation
        ) &&
        physicalDialogClosedOnSessionDetail(
          await readAndroidUiNodes(),
          "Close model control"
        ),
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
      input.actionRegistry,
      "talkback-detail-back",
      async () =>
        physicalSessionNavigationBackgrounded(
          readPhysicalSessionNavigationSnapshot(input),
          sessionNavigation
        ) &&
        selectPhysicalMissionControlDestination(await readAndroidUiNodes()) !==
          null,
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
  actionRegistry: PhysicalAggregateActionRegistry,
  actionId: PhysicalAggregateActionId,
  completed: () => boolean | Promise<boolean>,
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
  const node = physicalTalkBackFocusOwnerNode(focus);
  let click: PhysicalTalkBackObserverEvent | null = null;
  await actionRegistry.activate(
    actionId,
    node,
    () => runPhysicalTalkBackDoubleTap(point.x, point.y),
    async () => {
      const matchingClick = runtime.events.find(
        (event) =>
          event.sequence > checkpoint &&
          physicalTalkBackClickMatchesFocus(event, focus)
      );
      if (matchingClick === undefined || !(await completed())) return false;
      click = matchingClick;
      return true;
    },
    message
  );
  requireCondition(click !== null, message);
  return click;
}

function physicalTalkBackClickMatchesFocus(
  event: PhysicalTalkBackObserverEvent,
  focus: PhysicalTalkBackObserverEvent
): boolean {
  return (
    event.kind === "click" &&
    event.category === focus.category &&
    event.bounds.left === focus.bounds.left &&
    event.bounds.top === focus.bounds.top &&
    event.bounds.right === focus.bounds.right &&
    event.bounds.bottom === focus.bounds.bottom
  );
}

function physicalTalkBackFocusOwnerNode(
  focus: PhysicalTalkBackObserverEvent
): AndroidUiNode {
  const className = (() => {
    switch (focus.className) {
      case "button":
        return "android.widget.Button";
      case "edit":
        return "android.widget.EditText";
      case "text":
        return "android.widget.TextView";
      case "other":
      case "view":
        return "android.view.View";
    }
  })();
  return Object.freeze({
    bounds: Object.freeze({ ...focus.bounds }),
    className,
    clickable: focus.clickable,
    description: `TalkBack focus ${focus.category}`,
    focused: true,
    resourceId: "",
    text: ""
  });
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
): Promise<boolean> {
  const archiveCallsBefore = physicalDashboardControlCallCount(
    input.controls,
    "archive_session"
  );
  const archiveCounterBefore = Object.freeze({
    archive_session: archiveCallsBefore
  });
  requireCondition(
    archiveCallsBefore === 0,
    "Physical Archive session started with a prechanged local mutation count."
  );
  await waitFor(
    () => input.prompt.subscribers.snapshot().active_subscribers === 0,
    15_000,
    "Physical archive began before TalkBack Session Detail transport closed."
  );
  const quietExpanded = await ensurePhysicalQuietSessionQueueExpanded(
    "archive",
    input,
    "archive-expand-quiet"
  );
  const navigationBefore = readPhysicalSessionNavigationSnapshot(input);
  const session = await waitForPhysicalSelectedNode(
    selectPhysicalMissionControlSession,
    30_000,
    "Physical archive target session was unavailable."
  );
  await input.actionRegistry.tap(
    "archive-session-open",
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
  const selectedNavigation = readPhysicalSessionNavigationSnapshot(input);
  requireCondition(
    selectedNavigation.activeSubscribers === 1,
    "Physical Archive session did not retain one selected-session subscriber."
  );
  const actions = await waitForPhysicalSessionActions(
    {
      readNavigation: () => readPhysicalSessionNavigationSnapshot(input),
      readNodes: readAndroidUiNodes
    },
    30_000,
    "Physical archive session actions were unavailable."
  );
  await tapPhysicalSessionActionsOnceAndWait(
    input.actionRegistry,
    "archive-session-actions",
    actions,
    async () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        selectedNavigation
      ) && selectPhysicalSessionActionsMenuRoot(await readAndroidUiNodes()) !== null,
    "Physical archive action did not open."
  );
  const archive = await waitForPhysicalSelectedNode(
    (nodes) => selectPhysicalSessionActionsMenuAction(nodes, "Open Archive session"),
    30_000,
    "Physical Archive session action was unavailable."
  );
  measure(archive, "archive-session");
  await input.actionRegistry.tap(
    "archive-open",
    archive,
    async () =>
      selectPhysicalArchiveConfirmationAction(await readAndroidUiNodes()) !== null &&
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        selectedNavigation
      ) &&
      physicalExactNumericTransition(
        archiveCounterBefore,
        Object.freeze({
          archive_session: physicalDashboardControlCallCount(
            input.controls,
            "archive_session"
          )
        }),
        { archive_session: 0 }
      ),
    "Physical Archive session confirmation did not open."
  );
  await capture("fe090-40-archive-confirmation.png");
  const confirm = await waitForPhysicalArchiveConfirmationAction(
    30_000,
    "Physical Archive session final action was unavailable."
  );
  measure(confirm, "confirm-archive");
  requireCondition(
    physicalExactNumericTransition(
      archiveCounterBefore,
      Object.freeze({
        archive_session: physicalDashboardControlCallCount(
          input.controls,
          "archive_session"
        )
      }),
      { archive_session: 0 }
    ),
    "Physical Archive confirmation entry dispatched a mutation."
  );
  requireCondition(
    physicalExactNumericTransition(
      archiveCounterBefore,
      Object.freeze({
        archive_session: physicalDashboardControlCallCount(
          input.controls,
          "archive_session"
        )
      }),
      { archive_session: 0 }
    ),
    "Physical Archive final action observed an intervening mutation."
  );
  await input.actionRegistry.tap(
    "archive-confirm",
    confirm,
    async () => {
      const nodes = await readAndroidUiNodes();
      return (
        selectPhysicalResultAction(
          nodes,
          ["Session archived"],
          "Back to sessions"
        ) !== null &&
        physicalSessionNavigationMatches(
          readPhysicalSessionNavigationSnapshot(input),
          selectedNavigation
        ) &&
        physicalExactNumericTransition(
          archiveCounterBefore,
          Object.freeze({
            archive_session: physicalDashboardControlCallCount(
              input.controls,
              "archive_session"
            )
          }),
          { archive_session: 1 }
        )
      );
    },
    "Physical Archive session did not render terminal truth."
  );
  await capture("fe090-41-session-archived.png");
  const back = await waitForPhysicalSelectedNode(
    (nodes) => selectPhysicalResultAction(nodes, ["Session archived"], "Back to sessions"),
    30_000,
    "Physical archived-session result did not expose Back to sessions."
  );
  const navigationBeforeBack = readPhysicalSessionNavigationSnapshot(input);
  requireCondition(
    physicalSessionNavigationMatches(navigationBeforeBack, selectedNavigation),
    "Physical archived-session result changed Session Detail authority before its explicit return."
  );
  const navigationAfterBack = Object.freeze({
    ...navigationBeforeBack,
    activeSubscribers: 0
  });
  await input.actionRegistry.tap(
    "archive-result-back",
    back,
    async () => {
      const nodes = await readAndroidUiNodes();
      return (
        selectPhysicalMissionControlDestination(nodes) !== null &&
        physicalSessionNavigationMatches(
          readPhysicalSessionNavigationSnapshot(input),
          navigationAfterBack
        )
      );
    },
    "Physical archived-session result did not return to Mission Control."
  );
  await waitForPhysicalMissionControlShell(
    input,
    navigationAfterBack,
    "Physical archived-session Mission Control return did not settle.",
    15_000
  );
  return quietExpanded;
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
  } catch (error) {
    throw new Error(
      `${message} (states=${
        observations.length === 0 ? "none" : observations.join("||")
      }).`,
      { cause: error }
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
  const selfRevokeRequestsBeforeConfirmation = input.requestInspection.revokeRequests;
  const selfRevokedDevicesBeforeConfirmation = countMatchingRows(
    input.db,
    "auth_devices",
    "revoked_at IS NOT NULL"
  );
  const selfRevokeCounterBefore = Object.freeze({
    revoke_requests: selfRevokeRequestsBeforeConfirmation,
    revoked_devices: selfRevokedDevicesBeforeConfirmation
  });
  requireCondition(
    physicalSelfRevokeBaselineIsExact(selfRevokeCounterBefore),
    "Physical self-revoke did not begin after exactly one Office-device revoke."
  );
  await openProductionHostAccessSheet(input.actionRegistry, "self-global-open");
  const self = await revealPhysicalHostAccessActionContaining(
    "Revoke Physical Android Chrome",
    "forward",
    30_000,
    "Physical paired-device list omitted the current phone.",
    "global"
  );
  measure(self, "revoke-this-phone");
  await input.actionRegistry.tap(
    "self-revoke-open",
    self,
    async () =>
      selectPhysicalConfirmationFooterAction(
        await readAndroidUiNodes(),
        "Revoke this phone?",
        "Revoke this phone"
      ) !== null &&
      physicalExactNumericTransition(
        selfRevokeCounterBefore,
        Object.freeze({
          revoke_requests: input.requestInspection.revokeRequests,
          revoked_devices: countMatchingRows(
            input.db,
            "auth_devices",
            "revoked_at IS NOT NULL"
          )
        }),
        { revoke_requests: 0, revoked_devices: 0 }
      ),
    "Physical self-revoke confirmation did not open."
  );
  requireCondition(
    physicalExactNumericTransition(
      selfRevokeCounterBefore,
      Object.freeze({
        revoke_requests: input.requestInspection.revokeRequests,
        revoked_devices: countMatchingRows(
          input.db,
          "auth_devices",
          "revoked_at IS NOT NULL"
        )
      }),
      { revoke_requests: 0, revoked_devices: 0 }
    ),
    "Physical self-revoke confirmation entry dispatched a mutation."
  );
  await capture("fe090-42-self-revoke-confirmation.png");
  const confirm = await waitForPhysicalConfirmationAction(
    "Revoke this phone?",
    "Revoke this phone",
    30_000,
    "Physical self-revoke final action was unavailable."
  );
  measure(confirm, "confirm-self-revoke");
  requireCondition(
    physicalExactNumericTransition(
      selfRevokeCounterBefore,
      Object.freeze({
        revoke_requests: input.requestInspection.revokeRequests,
        revoked_devices: countMatchingRows(
          input.db,
          "auth_devices",
          "revoked_at IS NOT NULL"
        )
      }),
      { revoke_requests: 0, revoked_devices: 0 }
    ),
    "Physical self-revoke final action observed an intervening mutation."
  );
  await input.actionRegistry.tap(
    "self-revoke-confirm",
    confirm,
    async () => {
      const nodes = await readAndroidUiNodes();
      return (
        physicalHostAccessTextVisible(
          nodes,
          "global",
          "This phone was revoked",
          "Create a new pairing link on the laptop before using HostDeck here again."
        ) &&
        physicalExactNumericTransition(
          selfRevokeCounterBefore,
          Object.freeze({
            revoke_requests: input.requestInspection.revokeRequests,
            revoked_devices: countMatchingRows(
              input.db,
              "auth_devices",
              "revoked_at IS NOT NULL"
            )
          }),
          { revoke_requests: 1, revoked_devices: 1 }
        )
      );
    },
    "Physical self-revoke did not render terminal loss of authority."
  );
  await waitFor(
    () => input.prompt.subscribers.snapshot().active_subscribers === 0,
    15_000,
    "Physical self-revoke retained an SSE subscriber."
  );
  requireCondition(
    countRows(input.db, "auth_devices") === 2 &&
      physicalExactNumericTransition(
        selfRevokeCounterBefore,
        Object.freeze({
          revoke_requests: input.requestInspection.revokeRequests,
          revoked_devices: countMatchingRows(
            input.db,
            "auth_devices",
            "revoked_at IS NOT NULL"
          )
        }),
        { revoke_requests: 1, revoked_devices: 1 }
      ) &&
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

function selectPhysicalHostAccessContainingAction(
  nodes: readonly AndroidUiNode[],
  value: string,
  context: PhysicalHostAccessContext = "nested",
): AndroidUiNode | null {
  const region = selectPhysicalHostAccessContentRegion(nodes, context);
  if (region === null) return null;
  const matches = nodes.filter(
    (node) =>
      node.description.includes(value) &&
      node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsFullyInsideRegion(node, region)
  );
  return matches.length === 1 ? matches[0] ?? null : null;
}

async function revealPhysicalHostAccessActionContaining(
  value: string,
  direction: AndroidVerticalRevealDirection,
  timeoutMs: number,
  message: string,
  context: PhysicalHostAccessContext = "nested"
): Promise<AndroidUiNode> {
  let found: AndroidUiNode | null = null;
  let swipeCount = 0;
  const observations: string[] = [];
  try {
    await waitFor(async () => {
      const nodes = await readAndroidUiNodes();
      found = selectPhysicalHostAccessContainingAction(nodes, value, context);
      const region = selectPhysicalHostAccessContentRegion(nodes, context);
      const observation =
        `matches=${nodes.filter((node) => node.description.includes(value)).length};` +
        `region=${region === null ? "blocked" : physicalRegionGeometry(region)};` +
        `selected=${found === null ? "none" : androidUiNodeGeometry(found)}`;
      if (observations.at(-1) !== observation && observations.length < 6) {
        observations.push(observation);
      }
      if (found !== null) return true;
      if (
        swipeCount < 4 &&
        swipePhysicalHostAccessContent(nodes, direction, context)
      ) {
        swipeCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      return false;
    }, timeoutMs, message);
  } catch (error) {
    throw new Error(
      `${message} (swipes=${swipeCount};states=${observations.join("||") || "none"}).`,
      { cause: error }
    );
  }
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
  const profileExternalState: PhysicalProfileExternalStateSource = Object.freeze({
    readForeignServe: readServeStatusFingerprint,
    readManagerAttempts: () => input.manager.snapshot().command_attempts
  });
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

  await openProductionHostAccessSheet(input.actionRegistry, "recovery-ready-open");
  await revealPhysicalHostAccessContentNode(
    "text",
    "Remote access ready",
    "forward",
    30_000,
    "Production recovery UI did not show current ready truth.",
    false,
    "global"
  );
  await runOneProductionRemoteCheck(input.actionRegistry, "remote-check-recovery-ready", input.requestInspection);
  requireCondition(
    input.requestInspection.remoteBrowserStatusRequests === 1 &&
      input.requestInspection.remoteBrowserMutationRequests === 0 &&
      input.manager.snapshot().command_attempts === managerAttemptsBeforeSwitch,
    "The first production recovery check mutated external state or used the wrong route " +
      recoveryRequestSummary(input.requestInspection, input.manager)
  );
  await closeProductionHostAccessSheet(input.actionRegistry, "recovery-ready-close");
  await waitForPhysicalSelectedNode(
    (nodes) => selectPhysicalChromePageText(nodes, "Mission Control"),
    30_000,
    "Production recovery ready capture lost Mission Control."
  );
  await capturePrivateFreeProductionScreenshot(
    join(input.screenshotDirectory, "fe034-01-ready.png"),
    input.externalOrigin
  );

  const profileAwaySwitchBefore = readPhysicalProfileAwaySnapshot({
    foreignServe: input.foreignServeBefore,
    managerAttempts: managerAttemptsBeforeSwitch,
    requestInspection: input.requestInspection
  });
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

  const profileAwayBefore = readPhysicalProfileAwaySnapshot({
    foreignServe: await readServeStatusFingerprint(),
    managerAttempts: input.manager.snapshot().command_attempts,
    requestInspection: input.requestInspection
  });
  requireCondition(
    physicalProfileAwaySwitchBoundaryIsExact(
      profileAwaySwitchBefore,
      profileAwayBefore
    ),
    "Production recovery profile-away rebased unexpected browser or mutation traffic."
  );
  input.actionRegistry.consume(
    "profile-switch-away",
    () =>
      input.remote.readAdmission().admission === "closed" &&
      input.remote.snapshot().active_control_operations === 0 &&
      physicalProfileAwaySwitchBoundaryIsExact(
        profileAwaySwitchBefore,
        profileAwayBefore
      ),
    "Production recovery profile-away observation was not exact."
  );

  const refreshAway = await waitForPhysicalSelectedNode(
    selectPhysicalMissionControlRefresh,
    30_000,
    "Production recovery refresh control was unavailable before profile-away observation."
  );
  await input.actionRegistry.tap(
    "profile-away-refresh",
    refreshAway,
    async () =>
      physicalProfileAwayTruthMatches(
        { ...input, ...profileExternalState },
        profileAwayBefore,
        await readAndroidUiNodes()
      ),
    "Production recovery did not render generic loaded-browser failure.",
    45_000
  );
  await waitForStablePhysicalProfileAwayTruth(
    { ...input, ...profileExternalState },
    profileAwayBefore,
    "Production recovery profile-away truth was not stable while admission stayed closed."
  );
  await capturePrivateFreeProductionScreenshot(
    join(input.screenshotDirectory, "fe034-02-profile-away.png"),
    input.externalOrigin
  );

  const profileReturnBefore = readPhysicalProfileReturnSnapshot({
    foreignServe: input.foreignServeBefore,
    managerAttempts: managerAttemptsBeforeSwitch,
    requestInspection: input.requestInspection
  });
  await switchSavedProfile(input.profileSwitch.dedicatedProfileId);
  input.setSelectedProfile("dedicated");
  await waitFor(
    () =>
      input.remote.readAdmission().admission === "open" &&
      input.remote.snapshot().active_control_operations === 0,
    15_000,
    "Production recovery profile return did not reopen by observation."
  );
  const profileReturnSwitchAfter = readPhysicalProfileReturnSnapshot({
    foreignServe: await readServeStatusFingerprint(),
    managerAttempts: input.manager.snapshot().command_attempts,
    requestInspection: input.requestInspection
  });
  input.actionRegistry.consume(
    "profile-switch-return",
    () =>
      input.remote.readAdmission().admission === "open" &&
      input.remote.snapshot().active_control_operations === 0 &&
      physicalProfileReturnSwitchBoundaryIsExact(
        profileReturnBefore,
        profileReturnSwitchAfter
      ),
    "Production recovery profile-return observation rebased browser or mutation traffic."
  );
  const refreshRecovered = await waitForPhysicalSelectedNode(
    selectPhysicalMissionControlRefresh,
    30_000,
    "Production recovery refresh control was unavailable after profile return."
  );
  await input.actionRegistry.tap(
    "profile-return-refresh",
    refreshRecovered,
    async () =>
      physicalProfileReturnTruthMatches(
        { ...input, ...profileExternalState },
        profileReturnBefore,
        await readAndroidUiNodes()
      ),
    "Production recovery did not refresh lifecycle-owned host truth after profile return.",
    45_000
  );
  await waitForStablePhysicalProfileReturnTruth(
    { ...input, ...profileExternalState },
    profileReturnBefore,
    "Production recovery did not restore stable writable Mission Control without re-pairing.",
    45_000
  );
  await openProductionHostAccessSheet(input.actionRegistry, "recovery-return-open");
  await revealPhysicalHostAccessContentNode(
    "text",
    "Remote access ready",
    "forward",
    30_000,
    "Production recovery did not restore current detailed ready truth.",
    false,
    "global"
  );
  await runOneProductionRemoteCheck(input.actionRegistry, "remote-check-recovery-return", input.requestInspection);
  await closeProductionHostAccessSheet(input.actionRegistry, "recovery-return-close");
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
  input.actionRegistry.assertConsumed(physicalAggregateRecoveryExpectedActionIds);
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

async function openProductionHostAccessSheet(
  actionRegistry: PhysicalAggregateActionRegistry,
  actionId: PhysicalAggregateActionId
): Promise<void> {
  const trigger = await waitForPhysicalSelectedNode(
    (nodes) => selectPhysicalMissionControlAction(nodes, "Open Host and access"),
    30_000,
    "Production Host and access trigger was unavailable on Android."
  );
  await actionRegistry.tap(
    actionId,
    trigger,
    async () =>
      selectPhysicalHostAccessContentRegion(await readAndroidUiNodes(), "global") !==
      null,
    "Production Host and access sheet did not open on Android."
  );
}

async function closeProductionHostAccessSheet(
  actionRegistry: PhysicalAggregateActionRegistry,
  actionId: PhysicalAggregateActionId
): Promise<void> {
  const close = await waitForPhysicalSelectedNode(
    (nodes) => selectPhysicalHostAccessCloseAction(nodes, "global"),
    30_000,
    "Production Host and access close control was unavailable on Android."
  );
  await actionRegistry.tap(
    actionId,
    close,
    async () => {
      const nodes = await readAndroidUiNodes();
      return (
        selectPhysicalHostAccessContentRegion(nodes, "global") === null &&
        selectPhysicalMissionControlDestination(nodes) !== null
      );
    },
    "Production Host and access sheet did not close on Android."
  );
}

async function runOneProductionRemoteCheck(
  actionRegistry: PhysicalAggregateActionRegistry,
  actionId: PhysicalAggregateActionId,
  inspection: RequestInspection,
  options: Readonly<{
    readonly expectedRuntime?: PhysicalRuntimeExpectation;
    readonly context?: PhysicalHostAccessContext;
  }> = {}
): Promise<void> {
  const before = readPhysicalRemoteCheckBoundary(inspection);
  const check = await revealPhysicalHostAccessContentNode(
    "text",
    "Check again",
    "forward",
    30_000,
    "Production remote check action was unavailable on Android.",
    true,
    options.context ?? "global"
  );
  try {
    await settlePhysicalRemoteCheckAfterOneTap(
      check,
      before,
      () => readPhysicalRemoteCheckBoundary(inspection),
      (node, completed, message, timeoutMs) =>
        actionRegistry.tap(actionId, node, completed, message, timeoutMs)
    );
  } catch (error) {
    throw new Error(
      `Production remote check failed (${physicalRemoteCheckBoundarySummary(
        before,
        readPhysicalRemoteCheckBoundary(inspection)
      )}).`,
      { cause: error }
    );
  }
  await revealPhysicalHostAccessContentNode(
    "text",
    "Remote access ready",
    "backward",
    30_000,
    "Production remote check did not return to current ready truth.",
    false,
    options.context ?? "global"
  );
  if (options.expectedRuntime !== undefined) {
    await revealPhysicalHostAccessContentNode(
      "text",
      options.expectedRuntime === "incompatible"
        ? physicalRuntimeIncompatibleTitle
        : physicalRuntimeSupportedTitle,
      "forward",
      30_000,
      "Production remote check did not render exact compatibility truth.",
      false,
      options.context ?? "global"
    );
  }
}

type PhysicalRemoteCheckTapBoundary = (
  node: AndroidUiNode,
  completed: () => boolean | Promise<boolean>,
  message: string | (() => string),
  timeoutMs?: number
) => Promise<void>;

async function settlePhysicalRemoteCheckAfterOneTap(
  check: AndroidUiNode,
  before: PhysicalRemoteCheckBoundary,
  readCurrent: () => PhysicalRemoteCheckBoundary,
  tapBoundary: PhysicalRemoteCheckTapBoundary
): Promise<void> {
  await tapBoundary(
    check,
    () => physicalRemoteCheckSettled(before, readCurrent()),
    "Production remote check did not complete its exact successful status-then-refresh sequence.",
    physicalRemoteCheckResponseTimeoutMs
  );
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
  const responseDelta =
    current.hostResponseCount - before.hostResponseCount;
  return (
    `remote_requests=${current.remoteBrowserRequests - before.remoteBrowserRequests};` +
    `host_requests=${current.hostRequests - before.hostRequests};` +
    `host_responses=${responseDelta};` +
    `new_host_status=${
      responseDelta > 0 ? (current.hostResponseStatus ?? "none") : "none"
    }`
  );
}

async function capturePrivateFreeProductionScreenshot(
  path: string,
  externalOrigin: string,
  options: Readonly<{ readonly redactProductOrigin?: boolean }> = {}
): Promise<void> {
  const selection = await waitForPrivateFreeProductionScreenshotEvidence(
    externalOrigin,
    options
  );
  await capturePhysicalScreenshot(
    path,
    selection.region,
    selection.redactions
  );
}

async function waitForPrivateFreeProductionScreenshotEvidence(
  externalOrigin: string,
  options: Readonly<{ readonly redactProductOrigin?: boolean }> = {}
): Promise<PrivateFreeProductionScreenshotSelection> {
  let selection: PrivateFreeProductionScreenshotSelection | null = null;
  let stableObservation: string | null = null;
  let stableReads = 0;
  await waitFor(async () => {
    const nodes = await readAndroidUiNodes();
    const candidate = selectPrivateFreeProductionScreenshotEvidenceForPolling(
      nodes,
      externalOrigin,
      options
    );
    if (candidate === null) {
      selection = null;
      stableObservation = null;
      stableReads = 0;
      return false;
    }
    const observation = privateFreeProductionScreenshotSelectionGeometry(candidate);
    if (observation === stableObservation) {
      stableReads += 1;
    } else {
      stableObservation = observation;
      stableReads = 1;
    }
    selection = candidate;
    return stableReads >= physicalScreenshotSelectionStableReads;
  }, physicalScreenshotSelectionTimeoutMs, "Physical screenshot viewport did not settle.");
  requireCondition(
    selection !== null,
    "Physical screenshot viewport settled without evidence authority."
  );
  return selection;
}

function selectPrivateFreeProductionScreenshotEvidenceForPolling(
  nodes: readonly AndroidUiNode[],
  externalOrigin: string,
  options: Readonly<{ readonly redactProductOrigin?: boolean }> = {}
): PrivateFreeProductionScreenshotSelection | null {
  const compositorCount = nodes.filter(
    (node) => node.resourceId === chromeCompositorResourceId
  ).length;
  if (compositorCount === 0) return null;
  requireCondition(
    compositorCount === 1,
    "Physical evidence could not isolate the Chrome compositor."
  );
  const selection = selectPrivateFreeProductionScreenshotEvidence(
    nodes,
    externalOrigin,
    options
  );
  const hasPageContent = nodes.some(
    (node) =>
      node.resourceId === "" &&
      (node.text !== "" || node.description !== "") &&
      androidUiNodeIsFullyInsideRegion(node, selection.region)
  );
  return hasPageContent ? selection : null;
}

function privateFreeProductionScreenshotSelectionGeometry(
  selection: PrivateFreeProductionScreenshotSelection
): string {
  return [
    physicalRegionGeometry(selection.region),
    ...selection.redactions.map(physicalRegionGeometry)
  ].join("|");
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
        node.clickable &&
        node.enabled !== false
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
    owner.distance > physicalEventActionMaxDistancePx ||
    nodes.filter((node) => physicalAggregateNodeMatches(node, owner.node)).length !== 1
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

type PhysicalHostAccessContext = "global" | "nested";

function selectPhysicalHostAccessContentRegion(
  nodes: readonly AndroidUiNode[],
  context: PhysicalHostAccessContext = "nested"
): PhysicalScreenshotRegion | null {
  let page: PhysicalScreenshotRegion;
  try {
    page = selectChromePageViewport(nodes);
  } catch {
    return null;
  }
  const titles = nodes.filter((node) => node.text === "Host & access");
  const backButtons = nodes.filter(
    (node) =>
      node.description === "Back to session actions" &&
      node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsFullyInsideRegion(node, page)
  );
  const closeButtons = nodes.filter(
    (node) =>
      (context === "global"
        ? node.description === "Close Host and access"
        : node.description === "Close session actions") &&
      node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsFullyInsideRegion(node, page)
  );
  if (
    titles.length !== 1 ||
    (context === "nested" ? backButtons.length !== 1 : backButtons.length !== 0) ||
    closeButtons.length !== 1
  ) {
    return null;
  }
  const title = titles[0];
  const back = backButtons[0];
  const close = closeButtons[0];
  if (
    title === undefined ||
    close === undefined ||
    !physicalHostAccessTitleIsEligible(title, page) ||
    !physicalHostAccessHeaderButtonIsEligible(close, page) ||
    (context === "nested" &&
      (back === undefined ||
        !physicalHostAccessHeaderButtonIsEligible(back, page) ||
        !physicalHostAccessHeaderIsCoherent(title, back, close))) ||
    (context === "global" && !physicalHostAccessGlobalHeaderIsCoherent(title, close))
  ) {
    return null;
  }
  const top =
    Math.max(
      title.bounds.bottom,
      ...(context === "nested" && back !== undefined
        ? [back.bounds.bottom]
        : []),
      close.bounds.bottom
    ) + physicalHostAccessHeaderGapPx;
  const bottom = page.top + page.height;
  if (!Number.isSafeInteger(top) || bottom - top < 320) return null;
  return Object.freeze({
    height: bottom - top,
    left: page.left,
    top,
    width: page.width
  });
}

function physicalHostAccessTextVisible(
  nodes: readonly AndroidUiNode[],
  context: PhysicalHostAccessContext,
  ...texts: readonly string[]
): boolean {
  const region = selectPhysicalHostAccessContentRegion(nodes, context);
  return (
    region !== null &&
    texts.length > 0 &&
    texts.every(
      (text) =>
        nodes.filter(
          (node) =>
            node.text === text &&
            !node.clickable &&
            node.enabled !== false &&
            androidUiNodeIsFullyInsideRegion(node, region)
        ).length === 1
    )
  );
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

function physicalHostAccessGlobalHeaderIsCoherent(
  title: AndroidUiNode,
  close: AndroidUiNode
): boolean {
  const centerX = (node: AndroidUiNode) =>
    Math.floor((node.bounds.left + node.bounds.right) / 2);
  const centerY = (node: AndroidUiNode) =>
    Math.floor((node.bounds.top + node.bounds.bottom) / 2);
  return (
    centerX(title) < centerX(close) &&
    Math.abs(centerY(title) - centerY(close)) <= 128 &&
    Math.max(title.bounds.bottom, close.bounds.bottom) -
      Math.min(title.bounds.top, close.bounds.top) <= 256
  );
}

function selectPhysicalHostAccessContentNode(
  nodes: readonly AndroidUiNode[],
  field: AndroidUiNodeField,
  value: string,
  requireClickable: boolean,
  context: PhysicalHostAccessContext = "nested"
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
  const region = selectPhysicalHostAccessContentRegion(nodes, context);
  return region !== null && androidUiNodeIsFullyInsideRegion(node, region)
    ? node
    : null;
}

function selectPhysicalHostAccessCloseAction(
  nodes: readonly AndroidUiNode[],
  context: PhysicalHostAccessContext = "global"
): AndroidUiNode | null {
  let page: PhysicalScreenshotRegion;
  try {
    page = selectChromePageViewport(nodes);
  } catch {
    return null;
  }
  const titles = nodes.filter(
    (node) =>
      node.text === "Host & access" &&
      physicalHostAccessTitleIsEligible(node, page)
  );
  const closes = nodes.filter(
    (node) =>
      node.description ===
        (context === "global" ? "Close Host and access" : "Close session actions") &&
      physicalHostAccessHeaderButtonIsEligible(node, page)
  );
  const backs = nodes.filter(
    (node) =>
      node.description === "Back to session actions" &&
      physicalHostAccessHeaderButtonIsEligible(node, page)
  );
  if (
    titles.length !== 1 ||
    closes.length !== 1 ||
    (context === "nested" ? backs.length !== 1 : backs.length !== 0) ||
    titles[0] === undefined ||
    closes[0] === undefined ||
    (context === "nested" && backs[0] === undefined) ||
    (context === "nested"
      ? !physicalHostAccessHeaderIsCoherent(
          titles[0],
          backs[0] as AndroidUiNode,
          closes[0]
        )
      : !physicalHostAccessGlobalHeaderIsCoherent(titles[0], closes[0]))
  ) {
    return null;
  }
  return closes[0];
}

function selectPhysicalHostAccessContentSwipe(
  nodes: readonly AndroidUiNode[],
  direction: AndroidVerticalRevealDirection = "forward",
  context: PhysicalHostAccessContext = "nested"
): Readonly<{ readonly endY: number; readonly startY: number; readonly x: number }> | null {
  const region = selectPhysicalHostAccessContentRegion(nodes, context);
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
  direction: AndroidVerticalRevealDirection,
  context: PhysicalHostAccessContext = "nested"
): boolean {
  const gesture = selectPhysicalHostAccessContentSwipe(nodes, direction, context);
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

function selectPhysicalSessionActionsTrigger(
  nodes: readonly AndroidUiNode[],
  activeSubscribers: number
): AndroidUiNode | null {
  if (activeSubscribers !== 1) return null;
  let page: PhysicalScreenshotRegion;
  try {
    page = selectChromePageViewport(nodes);
  } catch {
    return null;
  }
  const isEligible = (node: AndroidUiNode): boolean =>
    node.clickable &&
    node.enabled !== false &&
    androidUiNodeIsFullyInsideRegion(node, page);
  const backButtons = nodes.filter(
    (node) => node.description === "Back to Mission Control"
  );
  if (
    backButtons.length !== 1 ||
    backButtons[0] === undefined ||
    !isEligible(backButtons[0])
  ) {
    return null;
  }
  const dockControls = physicalSessionControlDescriptions.map((description) =>
    nodes.filter((node) => node.description === description)
  );
  if (
    dockControls.some(
      (matches) => matches.length !== 1 || matches[0] === undefined || !isEligible(matches[0])
    )
  ) {
    return null;
  }
  const dockNodes = dockControls.map((matches) => matches[0] as AndroidUiNode);
  const dockTop = Math.min(...dockNodes.map((node) => node.bounds.top));
  if (
    !Number.isSafeInteger(dockTop) ||
    Math.max(...dockNodes.map((node) => node.bounds.top)) - dockTop > 64
  ) {
    return null;
  }
  const triggers = nodes.filter(
    (node) => node.description === physicalSessionActionsTriggerDescription
  );
  if (
    triggers.length !== 1 ||
    triggers[0] === undefined ||
    !isEligible(triggers[0])
  ) {
    return null;
  }
  if (physicalSessionActionsOverlayIsOpen(nodes, page)) {
    return null;
  }
  return triggers[0];
}

function physicalSessionActionsOverlayMarkerValues(): ReadonlySet<string> {
  return new Set([
    ...physicalSessionActionsOverlayMarkers,
    ...physicalFixedSheetOwnerTitles,
    "Confirm context compaction",
    "Lock remote writes?",
    "Revoke paired device?",
    "Revoke this phone?"
  ]);
}

function physicalSessionActionsOverlayIsOpen(
  nodes: readonly AndroidUiNode[],
  page: PhysicalScreenshotRegion
): boolean {
  let content: PhysicalScreenshotRegion;
  try {
    content = selectPhysicalSessionContentRegion(nodes) ?? {
      height: 0,
      left: 0,
      top: 0,
      width: 0
    };
  } catch {
    return true;
  }
  const overlayMarkerValues = physicalSessionActionsOverlayMarkerValues();
  const markers = nodes.filter((node) =>
    [...overlayMarkerValues].some((marker) =>
      matchesAndroidUiNode(node, "semantic", marker)
    )
  );
  if (markers.length === 0) return false;

  const structuralDescriptions = new Set([
    ...Object.values(physicalFixedSheetCloseDescriptions),
    "Back to session actions",
    "Back to session utilities",
    "Close Host and access"
  ]);
  const structuralAnchors = nodes.filter(
    (node) =>
      structuralDescriptions.has(node.description) &&
      node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsFullyInsideRegion(node, page)
  );
  const structuralActionTexts = new Set([
    "Archive session",
    "Back to sessions",
    "Cancel",
    "Confirm compact",
    "Done",
    "Interrupt turn",
    "Lock writes",
    "Revoke device",
    "Revoke this phone"
  ]);
  const structuralActions = nodes.filter(
    (node) =>
      structuralActionTexts.has(node.text) &&
      node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsFullyInsideRegion(node, page)
  );
  return markers.some((marker) => {
    if (!androidUiNodeIsFullyInsideRegion(marker, content)) return true;
    return (
      structuralAnchors.some((anchor) =>
        physicalAndroidNodesAreNear(anchor, marker, 640)
      ) ||
      structuralActions.some((action) =>
        physicalAndroidNodesAreNear(action, marker, 640)
      )
    );
  });
}

function physicalAndroidNodesAreNear(
  left: AndroidUiNode,
  right: AndroidUiNode,
  maxDistance: number
): boolean {
  const leftX = Math.floor((left.bounds.left + left.bounds.right) / 2);
  const leftY = Math.floor((left.bounds.top + left.bounds.bottom) / 2);
  const rightX = Math.floor((right.bounds.left + right.bounds.right) / 2);
  const rightY = Math.floor((right.bounds.top + right.bounds.bottom) / 2);
  return (
    Math.abs(leftX - rightX) <= maxDistance &&
    Math.abs(leftY - rightY) <= maxDistance
  );
}

function physicalSessionActionsStateSummary(
  nodes: readonly AndroidUiNode[],
  activeSubscribers: number,
  selected: AndroidUiNode | null = null
): string {
  let page: PhysicalScreenshotRegion | null = null;
  try {
    page = selectChromePageViewport(nodes);
  } catch {
    // The bounded summary reports invalid Chrome geometry without raw hierarchy data.
  }
  const eligible = (node: AndroidUiNode): boolean =>
    page !== null &&
    node.clickable &&
    node.enabled !== false &&
    androidUiNodeIsFullyInsideRegion(node, page);
  const geometry = (node: AndroidUiNode | undefined): string =>
    node === undefined ? "none" : privateFreeAndroidUiNodeGeometry(node);
  const backButtons = nodes.filter(
    (node) => node.description === "Back to Mission Control"
  );
  const dock = physicalSessionControlDescriptions.map((description) => {
    const matches = nodes.filter((node) => node.description === description);
    return `${matches.length}/${matches.filter(eligible).length}:${geometry(matches[0])}`;
  });
  const triggers = nodes.filter(
    (node) => node.description === physicalSessionActionsTriggerDescription
  );
  const overlays = nodes.filter((node) =>
    [...physicalSessionActionsOverlayMarkerValues()].some((marker) =>
      matchesAndroidUiNode(node, "semantic", marker)
    )
  );
  const dockTops = physicalSessionControlDescriptions.flatMap((description) =>
    nodes
      .filter((node) => node.description === description)
      .map((node) => node.bounds.top)
  );
  const dockAligned =
    dockTops.length === physicalSessionControlDescriptions.length &&
    Math.max(...dockTops) - Math.min(...dockTops) <= 64;
  return [
    `page=${page === null ? "invalid" : physicalRegionGeometry(page)}`,
    `active=${Number.isSafeInteger(activeSubscribers) ? activeSubscribers : "invalid"}`,
    `back=${backButtons.length}/${backButtons.filter(eligible).length}:${geometry(backButtons[0])}`,
    `dock=${dock.join("|")};aligned=${dockAligned ? "yes" : "no"}`,
    `trigger=${triggers.length}/${triggers.filter(eligible).length}:${geometry(triggers[0])}`,
    `overlays=${overlays.length}`,
    `admitted=${selected === null ? "no" : "yes"}`
  ].join(";");
}

function physicalPairingContinueFixtureNodes(
  verticalOffset = 0
): readonly AndroidUiNode[] {
  return parseAndroidUiNodes(
    '<hierarchy><node text="" class="android.view.ViewGroup" ' +
      `resource-id="${chromeToolbarResourceId}" bounds="[0,80][1080,240]" />` +
      '<node text="" class="android.widget.FrameLayout" ' +
      `resource-id="${chromeCompositorResourceId}" bounds="[0,80][1080,2400]" />` +
      '<node text="Phone paired" class="android.view.View" ' +
      'bounds="[80,420][760,540]" />' +
      '<node text="Read &amp; write" class="android.view.View" ' +
      'bounds="[80,760][760,840]" />' +
      '<node text="Open Mission Control" class="android.widget.Button" ' +
      'clickable="true" enabled="true" ' +
      `bounds="[98,${1_700 + verticalOffset}][990,${1_827 + verticalOffset}]" />` +
      '</hierarchy>'
  );
}

function physicalSessionActionsFixtureNodes(): readonly AndroidUiNode[] {
  const dock = physicalSessionControlDescriptions
    .map(
      (description, index) =>
        `<node text="" class="android.widget.Button" ` +
        `content-desc="${description}" clickable="true" enabled="true" ` +
        `bounds="[${index * 270},2100][${(index + 1) * 270},2240]" />`
    )
    .join("");
  return parseAndroidUiNodes(
    '<hierarchy><node text="" class="android.view.ViewGroup" ' +
      `resource-id="${chromeToolbarResourceId}" bounds="[0,80][1080,240]" />` +
      '<node text="" class="android.widget.FrameLayout" ' +
      `resource-id="${chromeCompositorResourceId}" bounds="[0,80][1080,2400]" />` +
      '<node text="" class="android.widget.Button" ' +
      'content-desc="Back to Mission Control" clickable="true" enabled="true" ' +
      'bounds="[32,300][180,424]" />' +
      '<node text="" class="android.widget.Button" ' +
      `content-desc="${physicalSessionActionsTriggerDescription}" clickable="true" enabled="true" ` +
      'bounds="[200,700][880,840]" />' +
      dock +
      '</hierarchy>'
  );
}

function physicalEventDiagnosticFixtureNodes(
  timelineLabel: string,
  verticalOffset = 0
): readonly AndroidUiNode[] {
  const dock = physicalSessionControlDescriptions
    .map(
      (description, index) =>
        `<node text="" class="android.widget.Button" ` +
        `content-desc="${description}" clickable="true" enabled="true" ` +
        `bounds="[${index * 270},1760][${(index + 1) * 270},1900]" />`
    )
    .join("");
  return parseAndroidUiNodes(
    '<hierarchy><node text="" class="android.view.ViewGroup" ' +
      `resource-id="${chromeToolbarResourceId}" bounds="[0,80][1080,240]" />` +
      '<node text="" class="android.widget.FrameLayout" ' +
      `resource-id="${chromeCompositorResourceId}" bounds="[0,80][1080,2400]" />` +
      '<node text="" class="android.widget.Button" ' +
      'content-desc="Back to Mission Control" clickable="true" enabled="true" ' +
      'bounds="[0,250][160,390]" />' +
      '<node text="" class="android.widget.Button" ' +
      'content-desc="View event details" clickable="true" enabled="true" ' +
      `bounds="[900,${985 + verticalOffset}][1040,${1115 + verticalOffset}]" />` +
      `<node text="${timelineLabel}" class="android.view.View" ` +
      `bounds="[80,${1200 + verticalOffset}][820,${1300 + verticalOffset}]" />` +
      dock +
      '</hierarchy>'
  );
}

function physicalEventDiagnosticSheetFixtureNodes(
  status: "Event details current" | "Event verification failed" | "Local evidence only" | "Retained event detail" | "Verifying event",
  heading = "Replay boundary",
  limitation = "Content truncated"
): readonly AndroidUiNode[] {
  return parseAndroidUiNodes(
    '<hierarchy><node text="" class="android.view.ViewGroup" ' +
      `resource-id="${chromeToolbarResourceId}" bounds="[0,80][1080,240]" />` +
      '<node text="" class="android.widget.FrameLayout" ' +
      `resource-id="${chromeCompositorResourceId}" bounds="[0,80][1080,2400]" />` +
      '<node text="Event details" class="android.view.View" ' +
      'bounds="[80,300][720,400]" />' +
      '<node text="" class="android.widget.Button" ' +
      'content-desc="Close event details" clickable="true" enabled="true" ' +
      'bounds="[916,292][1040,416]" />' +
      `<node text="${heading}" class="android.view.View" bounds="[80,560][820,640]" />` +
      `<node text="${limitation}" class="android.view.View" bounds="[80,700][820,780]" />` +
      `<node text="${status}" class="android.view.View" bounds="[80,1880][820,1960]" />` +
      '</hierarchy>'
  );
}

function physicalApprovalRespondingFixtureNodes(): readonly AndroidUiNode[] {
  return parseAndroidUiNodes(
    '<hierarchy><node text="" class="android.view.ViewGroup" ' +
      `resource-id="${chromeToolbarResourceId}" bounds="[0,80][1080,240]" />` +
      '<node text="" class="android.widget.FrameLayout" ' +
      `resource-id="${chromeCompositorResourceId}" bounds="[0,80][1080,2400]" />` +
      `<node text="${physicalApprovalAction}" class="android.view.View" ` +
      'bounds="[280,250][1000,290]" />' +
      `<node text="${physicalApprovalScope}" class="android.view.View" ` +
      'bounds="[280,295][1000,330]" />' +
      `<node text="${physicalApprovalConfirmationReason}" class="android.view.View" ` +
      'bounds="[280,335][1000,350]" />' +
      `<node text="${physicalApprovalConfirmationTitle}" class="android.view.View" ` +
      'bounds="[40,360][800,440]" />' +
      `<node text="" content-desc="${physicalApprovalCloseAction}" ` +
      'class="android.widget.Button" clickable="true" enabled="false" ' +
      'bounds="[920,340][1040,460]" />' +
      `<node text="${physicalApprovalRisk}" class="android.view.View" ` +
      'bounds="[40,500][600,580]" />' +
      `<node text="${physicalApprovalAction}" class="android.view.View" ` +
      'bounds="[280,680][1000,760]" />' +
      `<node text="${physicalApprovalScope}" class="android.view.View" ` +
      'bounds="[280,800][1000,880]" />' +
      `<node text="${physicalApprovalConfirmationReason}" class="android.view.View" ` +
      'bounds="[280,920][1000,1040]" />' +
      `<node text="${physicalApprovalRespondingStatus}" class="android.view.View" ` +
      'bounds="[40,1160][1000,1240]" />' +
      `<node text="${physicalApprovalCancelAction}" class="android.widget.Button" ` +
      'clickable="true" enabled="false" bounds="[40,1900][500,2040]" />' +
      `<node text="" content-desc="${physicalApprovalConfirmationAction}" ` +
      'class="android.widget.Button" clickable="true" enabled="false" ' +
      'bounds="[540,1900][1040,2040]" />' +
      '</hierarchy>'
  );
}

function physicalApprovalTerminalFixtureNodes(): readonly AndroidUiNode[] {
  const terminal = parseAndroidUiNodes(
    '<hierarchy>' +
      `<node text="${physicalApprovalTerminalStatus}" class="android.view.View" ` +
      'bounds="[72,600][500,680]" />' +
      `<node text="${physicalApprovalTerminalDetail}" class="android.view.View" ` +
      'bounds="[72,700][900,780]" />' +
      `<node text="${physicalApprovalAction}" class="android.view.View" ` +
      'bounds="[280,900][1000,980]" />' +
      `<node text="${physicalApprovalScope}" class="android.view.View" ` +
      'bounds="[280,1040][1000,1120]" />' +
      '</hierarchy>'
  );
  return Object.freeze([...physicalSessionActionsFixtureNodes(), ...terminal]);
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

type ProductionPromptUiSequenceOptions = Readonly<
  | {
      readonly actionRegistryScope?: "standalone";
      readonly captureScreenshots?: boolean;
      readonly cleanup: boolean;
      readonly openMissionControl: boolean;
      readonly sessionAlreadyOpen?: false;
    }
  | {
      readonly actionRegistryScope: "dashboard";
      readonly captureScreenshots: false;
      readonly cleanup: false;
      readonly openMissionControl: false;
      readonly sessionAlreadyOpen: true;
    }
>;

function physicalAggregatePromptExpectedActionIdsFor(
  options: ProductionPromptUiSequenceOptions
): readonly PhysicalAggregateActionId[] {
  const scope = options.actionRegistryScope ?? "standalone";
  if (scope === "dashboard") {
    requireCondition(
      options.captureScreenshots === false &&
        options.cleanup === false &&
        options.openMissionControl === false &&
        options.sessionAlreadyOpen === true,
      "Physical prompt dashboard registry scope used an invalid embedding shape."
    );
    return physicalAggregateDashboardPromptExpectedActionIds;
  }
  requireCondition(
    options.sessionAlreadyOpen !== true,
    "Physical prompt standalone registry scope cannot inherit an open session."
  );
  return physicalAggregatePromptExpectedActionIds;
}

async function runProductionPromptUiSequence(
  input: ProductionUiEntryInput & {
    readonly prompt: PhysicalPromptRuntime;
  },
  options: ProductionPromptUiSequenceOptions = Object.freeze({
    cleanup: true,
    openMissionControl: true
  })
): Promise<PhysicalPromptSequenceResult> {
  const expectedActionIds = physicalAggregatePromptExpectedActionIdsFor(options);
  if (options.openMissionControl) {
    await openProductionMissionControl(input, {
      missionControl: "fe020-02-mission-control.png",
      paired: "fe020-01-paired.png"
    }, "single_session");
  }
  const inputLabel = `Prompt for ${physicalUiSessionName}`;
  const sendLabel = `Send prompt to ${physicalUiSessionName}`;
  const navigationBeforeOpen = readPhysicalSessionNavigationSnapshot(input);
  if (options.sessionAlreadyOpen !== true) {
    const sessionLink = await waitForPhysicalSelectedNode(
      selectPhysicalMissionControlSession,
      30_000,
      "Physical prompt session link was unavailable on Android."
    );
    await input.actionRegistry.tap(
      "prompt-open-session",
      sessionLink,
      () =>
        physicalSessionNavigationOpened(
          readPhysicalSessionNavigationSnapshot(input),
          navigationBeforeOpen
        ),
      "Production Session Detail did not open exactly once on Android."
    );
  } else {
    requireCondition(
      navigationBeforeOpen.activeSubscribers === 1,
      "Physical prompt sequence was marked already open without one active stream."
    );
  }
  await waitForPhysicalSessionWriteReady(
    input,
    "Physical prompt detail did not establish one current production stream."
  );
  const selectedNavigation = readPhysicalSessionNavigationSnapshot(input);
  const promptRequestsAtEntry = input.requestInspection.promptRequests;
  const promptCallsAtEntry = input.prompt.startCalls.length;
  requireCondition(
    selectedNavigation.activeSubscribers === 1 &&
      promptRequestsAtEntry === 0 &&
      promptCallsAtEntry === 0,
    "Physical prompt did not begin with exact selected-session and dispatch authority."
  );
  const textarea = await waitForAndroidPromptEditor(
    inputLabel,
    30_000,
    "Physical prompt textarea was unavailable on Android."
  );
  await input.actionRegistry.tap(
    "prompt-editor",
    textarea,
    () =>
      isAndroidKeyboardVisible() &&
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        selectedNavigation
      ) &&
      input.requestInspection.promptRequests === promptRequestsAtEntry &&
      input.prompt.startCalls.length === promptCallsAtEntry,
    "Physical prompt textarea did not open the Android keyboard."
  );
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
    promptTargetVisible &&
      promptEditorVisible &&
      promptSendVisible &&
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        selectedNavigation
      ),
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
  const send = await waitForPhysicalSelectedNode(
    (nodes) => selectPhysicalChromePageAction(nodes, "description", sendLabel),
    15_000,
    "Physical prompt send action was unavailable on Android."
  );
  const promptRequestsBefore = input.requestInspection.promptRequests;
  await input.actionRegistry.tap(
    "prompt-send",
    send,
    () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        selectedNavigation
      ) &&
      input.requestInspection.promptRequests === promptRequestsBefore + 1 &&
      input.prompt.startCalls.length === promptCallsAtEntry + 1,
    "Physical prompt send did not issue exactly one protected request."
  );
  await waitFor(
    async () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        selectedNavigation
      ) &&
      selectPhysicalChromePageText(await readAndroidUiNodes(), "New turn accepted") !==
        null,
    30_000,
    "Physical prompt accepted state did not render on Android with retained authority."
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
    physicalSessionNavigationMatches(
      readPhysicalSessionNavigationSnapshot(input),
      selectedNavigation
    ) &&
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
  await waitFor(
    async () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        selectedNavigation
      ) &&
      selectPhysicalChromePageText(await readAndroidUiNodes(), "Turn running") !== null,
    30_000,
    "Physical prompt running event did not render with retained authority on Android."
  );
  if (options.captureScreenshots !== false) {
    await capturePhysicalScreenshot(
      join(input.screenshotDirectory, "fe020-05-running.png")
    );
  }
  await input.prompt.advance("completed");
  await waitFor(
    async () =>
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        selectedNavigation
      ) &&
      selectPhysicalChromePageText(await readAndroidUiNodes(), "Turn completed") !==
        null,
    30_000,
    "Physical prompt completion event did not render with retained authority on Android."
  );
  if (options.captureScreenshots !== false) {
    await capturePhysicalScreenshot(
      join(input.screenshotDirectory, "fe020-06-completed.png")
    );
  }
  requireCondition(
    input.requestInspection.promptRequests === 1 &&
      input.prompt.startCalls.length === 1 &&
      input.prompt.streamFailureCount === 0 &&
      physicalSessionNavigationMatches(
        readPhysicalSessionNavigationSnapshot(input),
        selectedNavigation
      ),
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
  input.actionRegistry.assertConsumed(expectedActionIds);
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
    physicalAsyncAdbUiHierarchyOutput(
      await adbAsync(
        ["exec-out", "uiautomator", "dump", "/dev/tty"],
        "ui_hierarchy"
      )
    )
  );
}

function parseAndroidUiNodes(output: string): readonly AndroidUiNode[] {
  const hierarchy = /<hierarchy\b[^>]*>[\s\S]*<\/hierarchy>/u.exec(output)?.[0];
  requireCondition(
    Buffer.byteLength(output, "utf8") > 0 &&
      Buffer.byteLength(output, "utf8") <= 512 * 1024 &&
      !output.includes("\u0000") &&
      !output.includes(selectedPairingFragmentPrefix) &&
      hierarchy !== undefined,
    "Android UI hierarchy was invalid or retained pairing material."
  );
  const nodes: AndroidUiNode[] = [];
  for (const match of hierarchy.matchAll(/<node\b([^>]*)\/?\s*>/gu)) {
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
    const checkedAttribute = attributes.get("checked");
    const enabledAttribute = attributes.get("enabled");
    const focusedAttribute = attributes.get("focused");
    const selectedAttribute = attributes.get("selected");
    requireCondition(
      clickableAttribute === undefined ||
        clickableAttribute === "true" ||
        clickableAttribute === "false",
      "Android UI hierarchy clickable state was invalid."
    );
    requireCondition(
      checkedAttribute === undefined ||
        checkedAttribute === "true" ||
        checkedAttribute === "false",
      "Android UI hierarchy checked state was invalid."
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
    requireCondition(
      selectedAttribute === undefined ||
        selectedAttribute === "true" ||
        selectedAttribute === "false",
      "Android UI hierarchy selected state was invalid."
    );
    const clickable = clickableAttribute === "true";
    const checked = checkedAttribute === "true";
    const enabled = enabledAttribute !== "false";
    const focused = focusedAttribute === "true";
    const selected = selectedAttribute === "true";
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
        ...(checked ? { checked: true as const } : {}),
        clickable,
        description,
        ...(enabled ? {} : { enabled: false as const }),
        ...(focused ? { focused: true as const } : {}),
        resourceId,
        ...(selected ? { selected: true as const } : {}),
        text
      })
    );
  }
  requireCondition(
    nodes.length <= 2_048,
    "Android UI hierarchy exceeded its semantic node limit."
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
  const body = selectPhysicalUtilityPageBody(nodes, "/skills");
  if (body === null) return null;
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
  const editors = nodes.filter(
    (node) =>
      node.className === androidEditTextClass &&
      node.clickable &&
      androidUiNodeWidth(node) >= 120 &&
      androidUiNodeHeight(node) >= 36 &&
      androidUiNodeIsFullyInsideRegion(node, body) &&
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

function androidUiNodeIsSelected(node: AndroidUiNode): boolean {
  return node.checked === true || node.selected === true;
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
  } catch (error) {
    throw new Error(
      `${message} (direction=${direction};swipes=${swipeCount};states=${
        observations.length === 0 ? "none" : observations.join(" -> ")
      }).`,
      { cause: error }
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
  requireClickable = false,
  context: PhysicalHostAccessContext = "nested"
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
        requireClickable,
        context
      );
      const observation = physicalHostAccessContentSummary(
        nodes,
        field,
        value,
        found,
        context
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
        swipePhysicalHostAccessContent(nodes, direction, context)
      ) {
        swipeCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      return false;
    }, timeoutMs, message);
  } catch (error) {
    throw new Error(
      `${message} (swipes=${swipeCount};states=${
        observations.length === 0 ? "none" : observations.join("||")
      }).`,
      { cause: error }
    );
  }
  requireCondition(found !== null, message);
  return found;
}

function physicalHostAccessContentSummary(
  nodes: readonly AndroidUiNode[],
  field: AndroidUiNodeField,
  value: string,
  selected: AndroidUiNode | null,
  context: PhysicalHostAccessContext = "nested"
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
    (node) =>
      node.description ===
      (context === "global" ? "Close Host and access" : "Close session actions")
  );
  const region = selectPhysicalHostAccessContentRegion(nodes, context);
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
  } catch (error) {
    throw new Error(
      `${message} (states=${
        observations.length === 0 ? "none" : observations.join("||")
      }).`,
      { cause: error }
    );
  }
  requireCondition(found !== null, message);
  return found;
}

async function waitForPhysicalConfirmationAction(
  titleText: string,
  actionText: string,
  timeoutMs: number,
  message: string
): Promise<AndroidUiNode> {
  let found: AndroidUiNode | null = null;
  const observations: string[] = [];
  try {
    await waitFor(async () => {
      const nodes = await readAndroidUiNodes();
      found = selectPhysicalConfirmationFooterAction(
        nodes,
        titleText,
        actionText
      );
      const observation = physicalConfirmationSummary(nodes, titleText, actionText, found);
      if (observations.at(-1) !== observation && observations.length < 6) {
        observations.push(observation);
      }
      return found !== null;
    }, timeoutMs, message);
  } catch (error) {
    throw new Error(
      `${message} (states=${observations.join("||") || "none"}).`,
      { cause: error }
    );
  }
  requireCondition(found !== null, message);
  return found;
}

async function waitForPhysicalInterruptResultDone(
  timeoutMs: number,
  message: string
): Promise<AndroidUiNode> {
  let found: AndroidUiNode | null = null;
  const observations: string[] = [];
  try {
    await waitFor(async () => {
      const nodes = await readAndroidUiNodes();
      found = selectPhysicalResultAction(nodes, ["Turn interrupted"], "Done");
      const observation = physicalResultActionSummary(nodes, ["Turn interrupted"], "Done", found);
      if (observations.at(-1) !== observation && observations.length < 6) {
        observations.push(observation);
      }
      return found !== null;
    }, timeoutMs, message);
  } catch (error) {
    throw new Error(
      `${message} (states=${observations.join("||") || "none"}).`,
      { cause: error }
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
  const owner = selectPhysicalConfirmationOwner(nodes, titleText);
  if (owner === null) return null;
  const titles = nodes.filter(
    (node) =>
      node.text === titleText &&
      !node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsFullyInsideRegion(node, owner.body)
  );
  const cancels = nodes.filter(
    (node) =>
      node.text === "Cancel" &&
      node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsFullyInsideRegion(node, owner.body)
  );
  const inlineTitle = owner.title === null ? titles[0] : owner.title;
  if (
    (owner.title === null ? titles.length !== 1 : titles.length !== 0) ||
    cancels.length !== 1
  ) {
    return null;
  }
  const title = inlineTitle;
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
      !androidUiNodeIsFullyInsideRegion(node, owner.body) ||
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

function selectPhysicalResultAction(
  nodes: readonly AndroidUiNode[],
  resultMarkers: readonly string[],
  actionText: string
): AndroidUiNode | null {
  if (resultMarkers.length !== 1) return null;
  const resultTitle = resultMarkers[0];
  const expectedAction = resultTitle === "Turn interrupted"
    ? "Done"
    : resultTitle === "Session archived"
      ? "Back to sessions"
      : null;
  if (resultTitle === undefined || actionText !== expectedAction) return null;
  const owner = selectPhysicalOwnedHeaderBody(
    nodes,
    resultTitle,
    "Close session actions",
    null,
    true
  );
  if (owner === null) return null;
  const markers = nodes.filter(
    (node) =>
      node.text === resultTitle &&
      !node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsFullyInsideRegion(node, owner.body)
  );
  const actions = nodes.filter(
    (node) =>
      node.text === actionText &&
      node.clickable &&
      node.enabled !== false &&
      androidUiNodeIsFullyInsideRegion(node, owner.body)
  );
  if (markers.length !== 1 || actions.length !== 1) return null;
  const marker = markers[0];
  const action = actions[0];
  if (marker === undefined || action === undefined) return null;
  return action.bounds.top >= marker.bounds.bottom &&
    androidUiNodeWidth(action) >= 72 &&
    androidUiNodeHeight(action) >= 36
    ? action
    : null;
}

interface PhysicalActionOwner {
  readonly body: PhysicalScreenshotRegion;
  readonly title: AndroidUiNode | null;
}

function selectPhysicalConfirmationOwner(
  nodes: readonly AndroidUiNode[],
  titleText: string
): PhysicalActionOwner | null {
  if (titleText === "Confirm context compaction") {
    const body = selectPhysicalUtilityPageBody(nodes, "/compact");
    if (body === null) return null;
    const titles = nodes.filter(
      (node) =>
        node.text === titleText &&
        !node.clickable &&
        node.enabled !== false &&
        androidUiNodeIsWebText(node) &&
        androidUiNodeWidth(node) >= 48 &&
        androidUiNodeHeight(node) >= 16 &&
        androidUiNodeIsFullyInsideRegion(node, body)
    );
    return titles.length === 1
      ? Object.freeze({ body, title: null })
      : null;
  }
  if (titleText === "Interrupt active turn?" || titleText === "Archive session?") {
    return selectPhysicalOwnedHeaderBody(
      nodes,
      titleText,
      "Close session actions",
      "Back to session actions",
      false
    );
  }
  if (titleText === "Lock remote writes?") {
    return selectPhysicalOwnedHeaderBody(
      nodes,
      titleText,
      "Close remote write lock confirmation",
      null,
      false
    );
  }
  if (titleText === "Revoke paired device?" || titleText === "Revoke this phone?") {
    return selectPhysicalOwnedHeaderBody(
      nodes,
      titleText,
      "Close device revocation",
      null,
      false
    );
  }
  return null;
}

function selectPhysicalOwnedHeaderBody(
  nodes: readonly AndroidUiNode[],
  titleText: string,
  closeDescription: string,
  backDescription: string | null,
  allowDisabledClose: boolean
): PhysicalActionOwner | null {
  let page: PhysicalScreenshotRegion;
  try {
    page = selectChromePageViewport(nodes);
  } catch {
    return null;
  }
  const closes = nodes.filter(
    (node) =>
      node.description === closeDescription &&
      physicalOwnedHeaderButtonIsEligible(node, page, allowDisabledClose)
  );
  const ownedBacks = nodes.filter(
    (node) =>
      physicalOwnedHeaderBackDescriptions.has(node.description) &&
      physicalOwnedHeaderButtonIsEligible(node, page, false)
  );
  const backs = backDescription === null
    ? []
    : ownedBacks.filter((node) => node.description === backDescription);
  if (
    closes.length !== 1 ||
    (backDescription === null
      ? ownedBacks.length !== 0
      : backs.length !== 1 || ownedBacks.length !== 1)
  ) {
    return null;
  }
  const close = closes[0];
  const back = backs[0];
  if (close === undefined || (backDescription !== null && back === undefined)) {
    return null;
  }
  const titleCandidates = nodes.filter(
    (node) =>
      node.text === titleText &&
      physicalOwnedHeaderTitleIsEligible(node, page) &&
      physicalOwnedHeaderIsCoherent(node, backDescription === null ? null : back, close)
  );
  if (titleCandidates.length !== 1) return null;
  const title = titleCandidates[0];
  if (title === undefined) return null;
  const competingCloses = nodes.filter(
    (node) =>
      node.description !== closeDescription &&
      physicalOwnedHeaderCloseDescriptions.has(node.description) &&
      node.clickable &&
      androidUiNodeIsFullyInsideRegion(node, page)
  );
  const competingTitles = nodes.filter(
    (node) =>
      node.text !== titleText &&
      physicalOwnedHeaderTitles.has(node.text) &&
      physicalOwnedHeaderTitleIsEligible(node, page) &&
      physicalOwnedHeaderIsCoherent(node, backDescription === null ? null : back, close)
  );
  if (competingCloses.length !== 0 || competingTitles.length !== 0) return null;
  const bodyTop = Math.max(
    title.bounds.bottom,
    close.bounds.bottom,
    ...(backDescription === null || back === undefined ? [] : [back.bounds.bottom])
  ) + physicalSessionOverlayGapPx;
  const body = Object.freeze({
    height: page.top + page.height - bodyTop,
    left: page.left,
    top: bodyTop,
    width: page.width
  });
  return body.height >= 320 ? Object.freeze({ body, title }) : null;
}

function physicalOwnedHeaderTitleIsEligible(
  node: AndroidUiNode,
  page: PhysicalScreenshotRegion
): boolean {
  return (
    !node.clickable &&
    node.enabled !== false &&
    androidUiNodeIsWebText(node) &&
    androidUiNodeWidth(node) >= 48 &&
    androidUiNodeWidth(node) <= Math.floor(page.width * 0.8) &&
    androidUiNodeHeight(node) >= 16 &&
    androidUiNodeHeight(node) <= 160 &&
    androidUiNodeIsFullyInsideRegion(node, page)
  );
}

function physicalOwnedHeaderButtonIsEligible(
  node: AndroidUiNode,
  page: PhysicalScreenshotRegion,
  allowDisabled: boolean
): boolean {
  return (
    node.clickable &&
    (allowDisabled || node.enabled !== false) &&
    androidUiNodeWidth(node) >= 24 &&
    androidUiNodeWidth(node) <= 256 &&
    androidUiNodeHeight(node) >= 24 &&
    androidUiNodeHeight(node) <= 256 &&
    androidUiNodeIsFullyInsideRegion(node, page)
  );
}

function physicalOwnedHeaderIsCoherent(
  title: AndroidUiNode,
  back: AndroidUiNode | null | undefined,
  close: AndroidUiNode
): boolean {
  const centerX = (node: AndroidUiNode) =>
    Math.floor((node.bounds.left + node.bounds.right) / 2);
  const centerY = (node: AndroidUiNode) =>
    Math.floor((node.bounds.top + node.bounds.bottom) / 2);
  const nodes = back === null || back === undefined
    ? [title, close]
    : [back, title, close];
  return (
    centerX(title) < centerX(close) &&
    (back === null || back === undefined || centerX(back) < centerX(title)) &&
    Math.max(...nodes.map(centerY)) - Math.min(...nodes.map(centerY)) <= 128 &&
    Math.max(...nodes.map((node) => node.bounds.bottom)) -
      Math.min(...nodes.map((node) => node.bounds.top)) <= 256
  );
}

function physicalConfirmationSummary(
  nodes: readonly AndroidUiNode[],
  titleText: string,
  actionText: string,
  selected: AndroidUiNode | null
): string {
  return (
    `title=${nodes.filter((node) => node.text === titleText).length};` +
    `cancel=${nodes.filter((node) => node.text === "Cancel").length};` +
    `action=${nodes.filter((node) => node.text === actionText).length};` +
    `selected=${selected === null ? "none" : androidUiNodeGeometry(selected)}`
  );
}

function physicalResultActionSummary(
  nodes: readonly AndroidUiNode[],
  resultMarkers: readonly string[],
  actionText: string,
  selected: AndroidUiNode | null
): string {
  return (
    `markers=${nodes.filter((node) => resultMarkers.includes(node.text)).length};` +
    `action=${nodes.filter((node) => node.text === actionText).length};` +
    `selected=${selected === null ? "none" : androidUiNodeGeometry(selected)}`
  );
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

async function waitForStablePhysicalPairingContinuation(
  source: PhysicalPairingContinueWaitSource,
  baseline: PhysicalMissionControlRequestSnapshot,
  timeoutMs: number,
  message: string,
  options: PhysicalPairingContinueWaitOptions = {}
): Promise<AndroidUiNode> {
  requireCondition(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0,
    "Physical pairing-continuation timeout was invalid."
  );
  const now = options.now ?? (() => performance.now());
  const sleep =
    options.sleep ??
    ((milliseconds: number): Promise<void> =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let previousNow = Number.NEGATIVE_INFINITY;
  const readNow = (): number => {
    const value = now();
    requireCondition(
      Number.isFinite(value) && value >= previousNow,
      "Physical pairing-continuation clock moved backwards."
    );
    previousNow = value;
    return value;
  };
  const startedAt = readNow();
  const deadline = startedAt + timeoutMs;
  requireCondition(
    Number.isFinite(deadline) && deadline > startedAt,
    "Physical pairing-continuation deadline was invalid."
  );
  const observations: string[] = [];
  let stableSince: number | null = null;
  let stableNode: AndroidUiNode | null = null;

  while (readNow() < deadline) {
    const requestsBeforeRead = source.readRequests();
    requireCondition(
      physicalMissionControlRequestSnapshotMatches(requestsBeforeRead, baseline),
      `${message} (request-drift;${physicalMissionControlRequestDeltaSummary(
        requestsBeforeRead,
        baseline
      )}).`
    );
    let nodes: readonly AndroidUiNode[];
    try {
      nodes = await source.readNodes();
    } catch {
      retainPhysicalPairingContinueObservation(
        observations,
        "hierarchy-read-error"
      );
      stableSince = null;
      stableNode = null;
      const remaining = deadline - readNow();
      if (remaining <= 0) break;
      await sleep(Math.min(physicalPairingContinuePollMs, remaining));
      continue;
    }
    const requestsAfterRead = source.readRequests();
    requireCondition(
      physicalMissionControlRequestSnapshotMatches(requestsAfterRead, baseline),
      `${message} (request-drift;${physicalMissionControlRequestDeltaSummary(
        requestsAfterRead,
        baseline
      )}).`
    );
    let selected: AndroidUiNode | null = null;
    try {
      selected =
        selectPhysicalChromePageText(nodes, "Phone paired") === null
          ? null
          : selectPhysicalChromePageAction(
              nodes,
              "text",
              "Open Mission Control"
            );
    } catch {
      selected = null;
    }
    retainPhysicalPairingContinueObservation(
      observations,
      `owner=${
        nodes.filter((node) => node.text === "Phone paired").length
      };action=${selected === null ? "blocked" : androidUiNodeGeometry(selected)};` +
        physicalMissionControlRequestDeltaSummary(requestsAfterRead, baseline)
    );
    const observedAt = readNow();
    if (selected === null) {
      stableSince = null;
      stableNode = null;
    } else if (
      stableSince === null ||
      stableNode === null ||
      !physicalAggregateNodeMatches(stableNode, selected)
    ) {
      stableSince = observedAt;
      stableNode = selected;
    } else if (
      observedAt - stableSince >= physicalPairingContinueStableWindowMs
    ) {
      return selected;
    }
    const remaining = deadline - readNow();
    if (remaining <= 0) break;
    await sleep(Math.min(physicalPairingContinuePollMs, remaining));
  }

  throw new Error(
    `${message} (states=${observations.join("||") || "none"}).`
  );
}

function physicalMissionControlRequestDeltaSummary(
  current: PhysicalMissionControlRequestSnapshot,
  baseline: PhysicalMissionControlRequestSnapshot
): string {
  return (
    `access=${current.accessRequests - baseline.accessRequests};` +
    `host=${current.hostStatusRequests - baseline.hostStatusRequests};` +
    `sessions=${current.sessionListRequests - baseline.sessionListRequests}`
  );
}

function retainPhysicalPairingContinueObservation(
  observations: string[],
  observation: string
): void {
  requireCondition(
    Buffer.byteLength(observation, "utf8") >= 1 &&
      Buffer.byteLength(observation, "utf8") <= 512,
    "Physical pairing-continuation observation exceeded its private-safe bound."
  );
  if (observations.at(-1) === observation) return;
  observations.push(observation);
  if (observations.length > 6) observations.shift();
}

async function continueFromPairingUi(
  actionRegistry: PhysicalAggregateActionRegistry,
  initialButton: AndroidUiNode,
  inspection: RequestInspection,
  before: PhysicalMissionControlRequestSnapshot
): Promise<void> {
  await actionRegistry.tap(
    "pairing-continue",
    initialButton,
    () =>
      physicalMissionControlRequestOpened(
        readPhysicalMissionControlRequestSnapshot(inspection),
        before
      ),
    () =>
      "Production pairing continuation did not issue exactly one Mission Control request set " +
      `(${physicalMissionControlRequestDeltaSummary(
        readPhysicalMissionControlRequestSnapshot(inspection),
        before
      )}).`
  );
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

function selectPhysicalApprovalRespondingDialogOwner(
  nodes: readonly AndroidUiNode[]
): PhysicalApprovalRespondingDialogOwner | null {
  const semanticMatches = (value: string): readonly AndroidUiNode[] =>
    nodes.filter((node) => matchesAndroidUiNode(node, "semantic", value));
  const titleNodes = semanticMatches(physicalApprovalConfirmationTitle);
  const riskNodes = semanticMatches(physicalApprovalRisk);
  const statusNodes = semanticMatches(physicalApprovalRespondingStatus);
  const actionNodes = semanticMatches(physicalApprovalAction);
  const scopeNodes = semanticMatches(physicalApprovalScope);
  const reasonNodes = semanticMatches(physicalApprovalConfirmationReason);
  const approveNodes = semanticMatches(physicalApprovalConfirmationAction);
  const cancelNodes = semanticMatches(physicalApprovalCancelAction);
  const closeNodes = semanticMatches(physicalApprovalCloseAction);
  if (
    titleNodes.length !== 1 ||
    riskNodes.length !== 1 ||
    statusNodes.length !== 1 ||
    actionNodes.length < 1 ||
    actionNodes.length > 2 ||
    scopeNodes.length < 1 ||
    scopeNodes.length > 2 ||
    reasonNodes.length < 1 ||
    reasonNodes.length > 2 ||
    approveNodes.length !== 1 ||
    cancelNodes.length !== 1 ||
    closeNodes.length !== 1 ||
    semanticMatches(physicalApprovalConfirmationStatus).length !== 0 ||
    semanticMatches(physicalApprovalTerminalStatus).length !== 0
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
  const risk = riskNodes[0];
  const status = statusNodes[0];
  const approve = approveNodes[0];
  const cancel = cancelNodes[0];
  const close = closeNodes[0];
  if (
    title === undefined ||
    risk === undefined ||
    status === undefined ||
    approve === undefined ||
    cancel === undefined ||
    close === undefined
  ) {
    return null;
  }
  const textIsEligible = (node: AndroidUiNode): boolean =>
    androidUiNodeIsWebText(node) &&
    !node.clickable &&
    node.enabled !== false &&
    androidUiNodeIsFullyInsideRegion(node, page);
  const disabledButtonIsEligible = (node: AndroidUiNode): boolean =>
    node.className === "android.widget.Button" &&
    node.enabled === false &&
    androidUiNodeWidth(node) >= 24 &&
    androidUiNodeHeight(node) >= 24 &&
    androidUiNodeIsFullyInsideRegion(node, page);
  if (
    !textIsEligible(title) ||
    !textIsEligible(risk) ||
    !textIsEligible(status) ||
    !disabledButtonIsEligible(approve) ||
    !disabledButtonIsEligible(cancel) ||
    !disabledButtonIsEligible(close) ||
    !physicalOwnedHeaderIsCoherent(title, null, close)
  ) {
    return null;
  }

  const headerBottom = Math.max(title.bounds.bottom, close.bounds.bottom);
  const footerTop = Math.min(cancel.bounds.top, approve.bounds.top);
  const footerCenter = (node: AndroidUiNode): number =>
    Math.floor((node.bounds.top + node.bounds.bottom) / 2);
  if (
    footerTop - headerBottom < 240 ||
    cancel.bounds.left >= approve.bounds.left ||
    cancel.bounds.right > approve.bounds.left ||
    Math.abs(footerCenter(cancel) - footerCenter(approve)) > 128 ||
    Math.max(cancel.bounds.bottom, approve.bounds.bottom) -
        Math.min(cancel.bounds.top, approve.bounds.top) >
      256
  ) {
    return null;
  }
  const inDialogBody = (node: AndroidUiNode): boolean =>
    textIsEligible(node) &&
    node.bounds.top >= headerBottom &&
    node.bounds.bottom <= footerTop;
  const selectOneBodyNode = (
    candidates: readonly AndroidUiNode[]
  ): AndroidUiNode | null => {
    const owned = candidates.filter(inDialogBody);
    return owned.length === 1 ? owned[0] ?? null : null;
  };
  const action = selectOneBodyNode(actionNodes);
  const scope = selectOneBodyNode(scopeNodes);
  const reason = selectOneBodyNode(reasonNodes);
  if (
    action === null ||
    scope === null ||
    reason === null ||
    !inDialogBody(risk) ||
    !inDialogBody(status) ||
    risk.bounds.bottom > action.bounds.top ||
    action.bounds.bottom > scope.bounds.top ||
    scope.bounds.bottom > reason.bounds.top ||
    reason.bounds.bottom > status.bounds.top
  ) {
    return null;
  }

  return Object.freeze({
    action,
    approve,
    cancel,
    close,
    reason,
    risk,
    scope,
    status,
    title
  });
}

function selectPhysicalApprovalTerminalOwner(
  nodes: readonly AndroidUiNode[]
): PhysicalApprovalTerminalOwner | null {
  const semanticMatches = (value: string): readonly AndroidUiNode[] =>
    nodes.filter((node) => matchesAndroidUiNode(node, "semantic", value));
  if (
    semanticMatches(physicalApprovalConfirmationTitle).length !== 0 ||
    semanticMatches(physicalApprovalConfirmationStatus).length !== 0 ||
    semanticMatches(physicalApprovalRespondingStatus).length !== 0 ||
    semanticMatches(physicalApprovalConfirmationAction).length !== 0 ||
    semanticMatches(physicalApprovalCancelAction).length !== 0 ||
    semanticMatches(physicalApprovalCloseAction).length !== 0
  ) {
    return null;
  }
  const statusNodes = semanticMatches(physicalApprovalTerminalStatus);
  const detailNodes = semanticMatches(physicalApprovalTerminalDetail);
  const actionNodes = semanticMatches(physicalApprovalAction);
  const scopeNodes = semanticMatches(physicalApprovalScope);
  if (
    statusNodes.length !== 1 ||
    detailNodes.length !== 1 ||
    actionNodes.length !== 1 ||
    scopeNodes.length !== 1
  ) {
    return null;
  }
  const status = statusNodes[0];
  const detail = detailNodes[0];
  const action = actionNodes[0];
  const scope = scopeNodes[0];
  let region: PhysicalScreenshotRegion | null = null;
  try {
    region = selectPhysicalSessionContentRegion(nodes);
  } catch {
    return null;
  }
  if (
    status === undefined ||
    detail === undefined ||
    action === undefined ||
    scope === undefined ||
    region === null
  ) {
    return null;
  }
  const eligible = (node: AndroidUiNode): boolean =>
    androidUiNodeIsWebText(node) &&
    !node.clickable &&
    node.enabled !== false &&
    androidUiNodeIsFullyInsideRegion(node, region);
  const centerY = (node: AndroidUiNode): number =>
    Math.floor((node.bounds.top + node.bounds.bottom) / 2);
  if (
    ![status, detail, action, scope].every(eligible) ||
    centerY(status) >= centerY(detail) ||
    centerY(detail) >= centerY(action) ||
    centerY(action) >= centerY(scope)
  ) {
    return null;
  }
  return Object.freeze({ action, detail, scope, status });
}

function physicalApprovalRespondingCheckpointMatches(
  input: PhysicalApprovalCheckpointInput
): boolean {
  return (
    physicalApprovalCheckpointAuthorityMatches(input) &&
    input.pending &&
    selectPhysicalApprovalRespondingDialogOwner(input.nodes) !== null
  );
}

function physicalApprovalTerminalCheckpointMatches(
  input: PhysicalApprovalCheckpointInput
): boolean {
  return (
    physicalApprovalCheckpointAuthorityMatches(input) &&
    !input.pending &&
    selectPhysicalApprovalTerminalOwner(input.nodes) !== null
  );
}

function physicalApprovalCheckpointAuthorityMatches(
  input: PhysicalApprovalCheckpointInput
): boolean {
  const navigationValues = [
    ...Object.values(input.actualNavigation),
    ...Object.values(input.expectedNavigation)
  ];
  return (
    navigationValues.every(
      (value) => Number.isSafeInteger(value) && value >= 0
    ) &&
    Number.isSafeInteger(input.approvalCallsBefore) &&
    input.approvalCallsBefore >= 0 &&
    Number.isSafeInteger(input.approvalCalls) &&
    input.approvalCalls === input.approvalCallsBefore + 1 &&
    physicalSessionNavigationMatches(
      input.actualNavigation,
      input.expectedNavigation
    )
  );
}

function physicalApprovalCheckpointSummary(
  input: PhysicalApprovalCheckpointInput,
  ownerSelected: boolean
): string {
  return (
    `navigation=${physicalSessionNavigationSummary(input.actualNavigation)};` +
    `expected=${physicalSessionNavigationSummary(input.expectedNavigation)};` +
    `calls=${input.approvalCallsBefore}/${input.approvalCalls};` +
    `pending=${input.pending ? "yes" : "no"};` +
    `owner=${ownerSelected ? "yes" : "no"};` +
    `dialog=${physicalApprovalRespondingContextSummary(input.nodes)};` +
    `terminal=${physicalApprovalTerminalContextSummary(input.nodes)}`
  );
}

function retainPhysicalApprovalObservation(
  observations: string[],
  observation: string
): void {
  requireCondition(
    Buffer.byteLength(observation, "utf8") >= 1 &&
      Buffer.byteLength(observation, "utf8") <= 4_096,
    "Physical approval observation exceeded its private-safe bound."
  );
  if (observations.at(-1) === observation) return;
  observations.push(observation);
  if (observations.length > 6) observations.shift();
}

function physicalApprovalRespondingContextSummary(
  nodes: readonly AndroidUiNode[]
): string {
  const observation = (value: string): string => {
    const matches = nodes.filter((node) =>
      matchesAndroidUiNode(node, "semantic", value)
    );
    return (
      `${matches.length}:` +
      `${matches
        .slice(0, 2)
        .map(
          (node) =>
            `${privateFreeAndroidUiNodeGeometry(node)},` +
            `${node.enabled === false ? "disabled" : "enabled"}`
        )
        .join("|") || "none"}`
    );
  };
  return [
    `title=${observation(physicalApprovalConfirmationTitle)}`,
    `facts=${observation(physicalApprovalRisk)}/` +
      `${observation(physicalApprovalAction)}/` +
      `${observation(physicalApprovalScope)}/` +
      `${observation(physicalApprovalConfirmationReason)}`,
    `status=${observation(physicalApprovalRespondingStatus)}`,
    `footer=${observation(physicalApprovalCancelAction)}/` +
      `${observation(physicalApprovalConfirmationAction)}/` +
      `${observation(physicalApprovalCloseAction)}`,
    `premature=${observation(physicalApprovalTerminalStatus)}`,
    `selected=${
      selectPhysicalApprovalRespondingDialogOwner(nodes) === null ? "no" : "yes"
    }`
  ].join(";");
}

function physicalApprovalTerminalContextSummary(
  nodes: readonly AndroidUiNode[]
): string {
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
  return [
    `dialog=${observation(physicalApprovalConfirmationTitle)}`,
    `status=${observation(physicalApprovalTerminalStatus)}`,
    `detail=${observation(physicalApprovalTerminalDetail)}`,
    `facts=${observation(physicalApprovalAction)}/` +
      observation(physicalApprovalScope),
    `selected=${selectPhysicalApprovalTerminalOwner(nodes) === null ? "no" : "yes"}`
  ].join(";");
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
      inspection.accessRequests === 3 &&
      inspection.hostStatusRequests === 2 &&
      inspection.sessionListRequests === 2 &&
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
      inspection.accessRequests === 4 &&
      inspection.hostStatusRequests === 4 &&
      inspection.sessionListRequests === 4 &&
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
      inspection.accessRequests === 2 &&
      inspection.hostStatusRequests === 1 &&
      inspection.sessionListRequests === 1 &&
      inspection.sessionDetailRequests === 1 &&
      inspection.sessionEventRequests === 0 &&
      inspection.sessionStreamRequests === 1 &&
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
  readonly packageIdentity: PhysicalDashboardPackageIdentity;
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
    package: input.packageIdentity,
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

function buildPhysicalDashboardPackageIdentity(): PhysicalDashboardPackageIdentity {
  const outputRoot = join(process.cwd(), "dist", "hostdeck");
  const buildResult = parsePhysicalPackageBuildOutput(
    execFileSync(
      process.execPath,
      [join(process.cwd(), "scripts", "build-production-package.mjs")],
      { ...commandOptions(), maxBuffer: 128 * 1024, timeout: 5 * 60_000 }
    )
  );
  const packageManifest = JSON.parse(
    readFileSync(join(outputRoot, "hostdeck-package.json"), "utf8")
  ) as unknown;
  const verification = parsePhysicalPackageVerificationOutput(
    execFileSync(
      process.execPath,
      [
        join(process.cwd(), "scripts", "verify-production-package.mjs"),
        outputRoot
      ],
      { ...commandOptions(), maxBuffer: 128 * 1024, timeout: 60_000 }
    )
  );
  const browserManifest = JSON.parse(
    readFileSync(
      join(process.cwd(), "tests", "browser", "supported-browser-manifest.json"),
      "utf8"
    )
  ) as unknown;
  return parsePhysicalDashboardPackageIdentity({
    browserManifest,
    buildResult,
    packageManifest,
    verification
  });
}

function parsePhysicalDashboardPackageIdentity(input: Readonly<{
  readonly browserManifest: unknown;
  readonly buildResult: unknown;
  readonly packageManifest: unknown;
  readonly verification: unknown;
}>): PhysicalDashboardPackageIdentity {
  const manifest = physicalPackageIdentityRecord(input.packageManifest);
  const source = physicalPackageIdentityRecord(manifest.source);
  const output = physicalPackageIdentityRecord(manifest.output);
  const content = physicalPackageIdentityRecord(manifest.content);
  const web = physicalPackageIdentityRecord(manifest.web);
  const build = physicalPackageIdentityRecord(input.buildResult);
  const verified = physicalPackageIdentityRecord(input.verification);
  const browser = physicalPackageIdentityRecord(input.browserManifest);
  const browserPackage = physicalPackageIdentityRecord(browser.package);
  const hashes = [
    source.sha256,
    output.sha256,
    content.sha256,
    manifest.manifestSha256,
    web.sha256,
    web.manifestSha256
  ];
  requireCondition(
    manifest.schemaVersion === 4 &&
      manifest.packageVersion === "0.0.0" &&
      source.count === 620 &&
      output.count === 1_247 &&
      Number.isSafeInteger(content.entryCount) &&
      (content.entryCount as number) >= 1_000 &&
      (content.entryCount as number) <= 10_000 &&
      Number.isSafeInteger(content.bytes) &&
      (content.bytes as number) >= 1_000_000 &&
      (content.bytes as number) <= 128 * 1024 * 1024 &&
      web.fileCount === 3 &&
      Number.isSafeInteger(web.bytes) &&
      (web.bytes as number) >= 100_000 &&
      (web.bytes as number) <= 8 * 1024 * 1024 &&
      hashes.every(
        (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)
      ) &&
      build.sourceCount === source.count &&
      build.outputCount === output.count &&
      build.entryCount === content.entryCount &&
      build.contentSha256 === content.sha256 &&
      build.packageVersion === manifest.packageVersion &&
      build.webBytes === web.bytes &&
      build.webFileCount === web.fileCount &&
      build.webSha256 === web.sha256 &&
      verified.outputCount === output.count &&
      verified.entryCount === content.entryCount &&
      verified.contentSha256 === content.sha256 &&
      verified.webBytes === web.bytes &&
      verified.webFileCount === web.fileCount &&
      verified.webSha256 === web.sha256 &&
      browserPackage.package_version === manifest.packageVersion &&
      browserPackage.content_sha256 === content.sha256 &&
      browserPackage.manifest_sha256 === manifest.manifestSha256 &&
      browserPackage.web_sha256 === web.sha256 &&
      browserPackage.web_manifest_sha256 === web.manifestSha256,
    "Physical dashboard package and browser identities did not match."
  );
  return Object.freeze({
    content_entry_count: content.entryCount as number,
    content_tree_sha256: content.sha256 as string,
    manifest_sha256: manifest.manifestSha256 as string,
    output_file_count: output.count as number,
    output_tree_sha256: output.sha256 as string,
    package_schema_version: 4,
    package_version: "0.0.0",
    source_file_count: source.count as number,
    source_tree_sha256: source.sha256 as string,
    web_manifest_sha256: web.manifestSha256 as string,
    web_tree_sha256: web.sha256 as string
  });
}

function parsePhysicalPackageBuildOutput(
  output: string
): Readonly<Record<string, unknown>> {
  const match = output.match(
    /^HostDeck package built: (\d+) sources, (\d+) owned outputs, (\d+) entries, (\d+) web files \((\d+) bytes, sha256:([a-f0-9]{64})\), package sha256:([a-f0-9]{64})\.\r?\n$/u
  );
  requireCondition(match !== null, "Physical dashboard package build output was invalid.");
  return Object.freeze({
    contentSha256: match[7],
    entryCount: Number(match[3]),
    outputCount: Number(match[2]),
    packageVersion: "0.0.0",
    sourceCount: Number(match[1]),
    webBytes: Number(match[5]),
    webFileCount: Number(match[4]),
    webSha256: match[6]
  });
}

function parsePhysicalPackageVerificationOutput(
  output: string
): Readonly<Record<string, unknown>> {
  const match = output.match(
    /^HostDeck package verified: (\d+) entries, (\d+) owned outputs, (\d+) web files \((\d+) bytes, sha256:([a-f0-9]{64})\), package sha256:([a-f0-9]{64})\.\r?\n$/u
  );
  requireCondition(
    match !== null,
    "Physical dashboard package verification output was invalid."
  );
  return Object.freeze({
    contentSha256: match[6],
    entryCount: Number(match[1]),
    outputCount: Number(match[2]),
    webBytes: Number(match[4]),
    webFileCount: Number(match[3]),
    webSha256: match[5]
  });
}

function physicalPackageIdentityRecord(
  value: unknown
): Readonly<Record<string, unknown>> {
  requireCondition(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Physical dashboard package and browser identities did not match."
  );
  return value as Readonly<Record<string, unknown>>;
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
  const port: PhysicalServeCleanupPort = Object.freeze({
    async disable() {
      const attemptsBefore = manager.snapshot().command_attempts;
      let result: Awaited<ReturnType<TailscaleServeManager["disable"]>> | null =
        null;
      try {
        result = await manager.disable({
          expected_profile_key: fallback.expectedProfileKey,
          expected_serve: fallback.expectedServe
        });
      } catch {
        // The command-attempt counter below distinguishes preflight failure
        // from an uncertain mutation without retaining the private cause.
      }
      const attemptDelta = manager.snapshot().command_attempts - attemptsBefore;
      requireCondition(
        (attemptDelta === 0 || attemptDelta === 1) &&
          (result === null ||
            (attemptDelta === 1) === result.command_attempted),
        "Physical Serve cleanup mutation accounting was invalid."
      );
      return Object.freeze({
        after: result?.after ?? null,
        commandAttempted: attemptDelta === 1
      });
    },
    observe: () =>
      observer.observeConfigured({
        expected_profile_key: fallback.expectedProfileKey,
        expected_serve: fallback.expectedServe
      })
  });
  await reconcilePhysicalServeCleanup(port, {
    attempts: physicalServeCleanupObservationAttempts,
    sleep: () =>
      new Promise((resolve) =>
        setTimeout(resolve, physicalServeCleanupObservationDelayMs)
      )
  });
}

async function reconcilePhysicalServeCleanup(
  port: PhysicalServeCleanupPort,
  schedule: PhysicalServeCleanupSchedule
): Promise<void> {
  requireCondition(
    Number.isSafeInteger(schedule.attempts) &&
      schedule.attempts >= 1 &&
      schedule.attempts <= physicalServeCleanupObservationAttempts,
    "Physical Serve cleanup schedule was invalid."
  );
  let mutationAttempted = false;
  for (let attempt = 0; attempt < schedule.attempts; attempt += 1) {
    let observation: RemoteIngressObservationSnapshot | null = null;
    try {
      observation = await port.observe();
    } catch {
      // A bounded read-only retry may outlive a transient local Tailscale read.
    }
    if (observation !== null) {
      const state = physicalServeCleanupObservationState(observation);
      requireCondition(
        state !== "unsafe",
        "Physical pairing cannot prove ownership-safe Serve cleanup."
      );
      if (state === "absent") return;
      if (state === "exact" && !mutationAttempted) {
        const mutation = await port.disable();
        mutationAttempted ||= mutation.commandAttempted;
        if (mutation.after !== null) {
          const afterState = physicalServeCleanupObservationState(
            mutation.after
          );
          requireCondition(
            afterState !== "unsafe",
            "Physical pairing cannot prove ownership-safe Serve cleanup."
          );
          if (afterState === "absent") return;
        }
      }
    }
    if (attempt + 1 < schedule.attempts) {
      try {
        await schedule.sleep();
      } catch {
        throw new Error("Physical Serve cleanup reconciliation wait failed.");
      }
    }
  }
  throw new Error(
    mutationAttempted
      ? "Physical pairing could not prove owned Serve removal after its single mutation."
      : "Physical pairing could not obtain a conclusive owned Serve cleanup observation."
  );
}

function physicalServeCleanupObservationState(
  snapshot: RemoteIngressObservationSnapshot
): "absent" | "exact" | "transient" | "unsafe" {
  if (
    snapshot.client === "error" ||
    (snapshot.client === "available" &&
      snapshot.failure === "profile_changed")
  ) {
    return "transient";
  }
  if (
    snapshot.client !== "available" ||
    snapshot.failure !== null ||
    snapshot.profile.state !== "dedicated" ||
    snapshot.profile.comparison.relation !== "match"
  ) {
    return "unsafe";
  }
  if (snapshot.serve === "absent") return "absent";
  if (snapshot.serve === "exact") return "exact";
  return "unsafe";
}

function physicalServeCleanupFixture(
  state: "absent" | "exact" | "foreign" | "transient" | "wrong_profile"
): RemoteIngressObservationSnapshot {
  const expectedProfileKey = `sha256:${"a".repeat(64)}`;
  const otherProfileKey = `sha256:${"b".repeat(64)}`;
  const observedAt = "2026-08-01T00:00:00.000Z";
  if (state === "transient") {
    return remoteIngressObservationSnapshotSchema.parse({
      schema_version: 1,
      client: "error",
      profile: {
        state: "unknown",
        comparison: {
          relation: "unknown",
          expected_profile_key: expectedProfileKey,
          active_profile_key: null
        }
      },
      serve: null,
      external_origin: null,
      failure: "command_timeout",
      observed_at: observedAt
    });
  }
  if (state === "wrong_profile") {
    return remoteIngressObservationSnapshotSchema.parse({
      schema_version: 1,
      client: "available",
      profile: {
        state: "other",
        comparison: {
          relation: "different",
          expected_profile_key: expectedProfileKey,
          active_profile_key: otherProfileKey
        }
      },
      serve: null,
      external_origin: null,
      failure: null,
      observed_at: observedAt
    });
  }
  return remoteIngressObservationSnapshotSchema.parse({
    schema_version: 1,
    client: "available",
    profile: {
      state: "dedicated",
      comparison: {
        relation: "match",
        expected_profile_key: expectedProfileKey,
        active_profile_key: expectedProfileKey
      }
    },
    serve: state,
    external_origin:
      state === "exact" ? "https://hostdeck.example.ts.net" : null,
    failure: null,
    observed_at: observedAt
  });
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
  requireCondition(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0,
    "Physical poll timeout was invalid."
  );
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await predicate()) return;
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
