import {
  type ChildProcess,
  execFile,
  execFileSync,
  spawn
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
import { type AddressInfo, createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
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
import { cliExitCodes } from "./exit-codes.js";
import { createBoundedLoopbackFetch } from "./loopback-http.js";
import { runCli } from "./shell.js";

const requireRemoteAndroidAcceptance =
  process.env.HOSTDECK_REQUIRE_REMOTE_ANDROID_ACCEPTANCE === "1";
const requirePromptUiAcceptance =
  process.env.HOSTDECK_REQUIRE_PROMPT_ANDROID_SMOKE === "1" &&
  !requireRemoteAndroidAcceptance;
const requirePairingUiAcceptance =
  process.env.HOSTDECK_REQUIRE_PAIRING_ANDROID_SMOKE === "1" &&
  !requireRemoteAndroidAcceptance &&
  !requirePromptUiAcceptance;
const requireProductionUiAcceptance =
  requirePairingUiAcceptance || requirePromptUiAcceptance;
const requirePhysicalPairing =
  requireProductionUiAcceptance || requireRemoteAndroidAcceptance;
const describePhysical = requirePhysicalPairing ? describe : describe.skip;
const overallTimeoutMs = requireRemoteAndroidAcceptance
  ? 20 * 60_000
  : requirePromptUiAcceptance
    ? 12 * 60_000
    : 10 * 60_000;
const claimTimeoutMs = 5 * 60_000;
const automatedClaimTimeoutMs = 45_000;
const androidTailscaleComponent = "com.tailscale.ipn/.MainActivity";
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
const physicalUiSessionId = "sess_physical_pairing_ui";
const physicalUiSessionName = "physical-pairing-review";
const physicalUiThreadId = "thread-physical-pairing-ui";
const physicalPromptTurnId = "turn-physical-prompt-001";
const physicalPromptText = "FE020_android_line_one\nFE020_android_line_two";
const deviceForbiddenValues = new Set<string>();
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
    expect(bundle).toContain("/__physical/cleanup");
    expect(bundle).toContain("requestFullscreen");
    expect(bundle).not.toMatch(
      /chrome_devtools|Runtime\.evaluate|webSocketDebuggerUrl|__hostDeckPhysical/iu
    );
  });

  it("builds the real production browser app for pairing-only acceptance", async () => {
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
  });

  it("seeds one repository-valid production pairing session", () => {
    const directory = mkdtempSync(join(tmpdir(), "hostdeck-pairing-session-"));
    const opened = openMigratedDatabase(join(directory, "hostdeck.sqlite"));
    try {
      const fixture = createPhysicalSessionReads(
        opened.db,
        increasingWallClock(),
        false
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
        true
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

  it("parses bounded Android semantic nodes without retaining pairing material", () => {
    const nodes = parseAndroidUiNodes(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<hierarchy rotation="0">' +
        '<node text="Host &amp; access" content-desc="" bounds="[0,80][720,180]" />' +
        '<node text="" content-desc="Open Host and access" bounds="[620,80][720,180]" />' +
        "</hierarchy>"
    );

    expect(nodes).toEqual([
      {
        bounds: { bottom: 180, left: 0, right: 720, top: 80 },
        description: "",
        text: "Host & access"
      },
      {
        bounds: { bottom: 180, left: 620, right: 720, top: 80 },
        description: "Open Host and access",
        text: ""
      }
    ]);
    expect(Object.isFrozen(nodes)).toBe(true);
    expect(nodes.every(Object.isFrozen)).toBe(true);
    expect(() =>
      parseAndroidUiNodes(
        `<hierarchy><node text="${selectedPairingFragmentPrefix}secret" ` +
          'content-desc="" bounds="[0,0][100,100]" /></hierarchy>'
      )
    ).toThrow("retained pairing material");
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
});

describePhysical("selected remote-ingress physical Android acceptance", () => {
  it(
    "pairs through private HTTPS and proves lifecycle authority, recovery, revocation, and cleanup",
    async () => {
      requireOneAuthorizedDevice();
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
        csrfRequests: 0,
        deletionCookieObserved: false,
        fragmentLeaks: 0,
        hardenedCookieObserved: false,
        hostStatusRequests: 0,
        hostStatusResponseStatuses: [],
        noReferrerApiRequests: 0,
        promptNoReferrerRequests: 0,
        promptRequests: 0,
        promptResponseStatuses: [],
        protectedReadRejections: 0,
        protectedReadRequests: 0,
        protectedReadSuccesses: 0,
        rejectedRevokedCheckpoints: 0,
        revokedCheckpointRequests: 0,
        revokeRequests: 0,
        sessionDetailRequests: 0,
        sessionEventRequests: 0,
        sessionListRequests: 0,
        sessionListResponseStatuses: [],
        sessionStreamRequests: 0
      };
      const driverRuntime = createPhysicalDriverRuntime();
      const sseRuntime: PhysicalSseRuntime = {
        active: 0,
        closed: 0,
        maxActive: 0,
        opened: 0
      };
      const profileSwitch = requireRemoteAndroidAcceptance
        ? requireProfileSwitchInput()
        : null;
      const acceptanceStartedAt =
        requireRemoteAndroidAcceptance || requirePromptUiAcceptance
        ? new Date().toISOString()
        : null;
      const screenshotDirectory = join(directory, "device-evidence");
      mkdirSync(screenshotDirectory, { mode: 0o700 });
      let host: HostDeckFastifyLifecycle<PhysicalRuntimeContext> | null = null;
      let lifecycleManager: TailscaleServeManager | null = null;
      let display: QrDisplay | null = null;
      let remoteEnabled = false;
      let fallbackCleanup: CleanupTarget | null = null;
      let externalOrigin: string | null = null;
      let localOrigin: string | null = null;
      let env: Readonly<Record<string, string>> | null = null;
      let foreignServeBefore: ServeStatusFingerprint | null = null;
      let environmentFacts: PhysicalEnvironmentFacts | null = null;
      let fullResult: PhysicalSequenceResult | null = null;
      let promptResult: PhysicalPromptSequenceResult | null = null;
      let promptRuntime: PhysicalPromptRuntime | null = null;
      let promptSubscribers: ReturnType<
        typeof createProjectionSubscriberStreamService
      > | null = null;
      let initialWifiEnabled: boolean | null = null;
      let initialStayAwakeSetting: number | null = null;
      let selectedProfile: "away" | "dedicated" = "dedicated";
      let internalErrorCount = 0;

      try {
        adbCommandCount = 0;
        deviceForbiddenValues.clear();
        if (requireProductionUiAcceptance || requireRemoteAndroidAcceptance) {
          requireCleanAcceptanceWorktree();
          requireNoAdbApplicationTunnels();
          initialStayAwakeSetting = readAndroidStayAwakeSetting();
          await enforceAndroidAwakeAndUnlocked(initialStayAwakeSetting);
          initialWifiEnabled = readAndroidWifiEnabled();
          await enforceUnrelatedAndroidNetwork(initialWifiEnabled);
          environmentFacts = readPhysicalEnvironmentFacts();
        }
        if (requireRemoteAndroidAcceptance) {
          requireCondition(
            (await readSelectedSavedProfileId()) ===
              profileSwitch?.dedicatedProfileId,
            "Physical acceptance must start on the dedicated saved profile."
          );
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
        const health = createHostDeckHostHealthService({ now });
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
            claim: (input) => pairing.claim(input)
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
              requirePromptUiAcceptance
            )
          : null;
        const sessionReads = sessionFixture?.reads ?? null;
        const selectedStates = requirePromptUiAcceptance
          ? createSelectedStateRepository(opened.db)
          : null;
        const promptAuditExecutor = requirePromptUiAcceptance
          ? createHostDeckSelectedWriteAuditExecutor({
              repository: audit,
              now: () => now().toISOString(),
              create_record_id: () => `audit:physical:prompt:${++auditIndex}`
            })
          : null;
        const promptApiRoutes: HostDeckRoutePluginRegistration[] = [];
        const promptSseRoutes: HostDeckRoutePluginRegistration[] = [];
        if (requirePromptUiAcceptance) {
          requireCondition(
            selectedStates !== null &&
              promptAuditExecutor !== null &&
              sessionFixture !== null &&
              sessionFixture.promptSeedEvent !== null,
            "Physical prompt state or audit owner was unavailable."
          );
          promptRuntime = createPhysicalPromptRuntime(
            selectedStates,
            now,
            sessionFixture.promptSeedEvent
          );
          promptSubscribers = promptRuntime.subscribers;
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
        const apiRoutes = [
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
                createHostDeckHealthRouteRegistration({ health }),
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
                id: "physical-production-browser"
              }),
              physicalPageRoute(browserBundle, {
                id: "physical-production-cleanup-page",
                path: "/__physical/cleanup"
              })
            ]
          : [physicalPageRoute(browserBundle)];
        const sseRoutes = [
          physicalSseRoute(sseRuntime),
          ...promptSseRoutes
        ];
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
            secrets
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

        requireChromeRunning();
        if (requirePairingUiAcceptance) {
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
        assertPairingAudit(opened.db, {
          successfulCsrfBootstrapCount: requirePairingUiAcceptance
            ? 3
            : requirePromptUiAcceptance
              ? 2
              : 1,
          deviceRevokeCount: requireProductionUiAcceptance ? 1 : 0
        });
        if (requirePromptUiAcceptance) {
          assertPhysicalPromptAudit(opened.db);
        }
        assertSecretsAbsentFromDatabase(
          dbPath,
          requirePromptUiAcceptance
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
        if (requireRemoteAndroidAcceptance) {
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
          await capturePhysicalScreenshot(
            join(screenshotDirectory, "04-revoked-cleaned.png")
          );
          assertFullPhysicalAudit(opened.db);
          assertSecretsAbsentFromDatabase(dbPath, secrets.values());
        }
        fallbackCleanup = null;
        adb(["shell", "am", "force-stop", "com.android.chrome"]);
        adb(["shell", "input", "keyevent", "KEYCODE_HOME"]);
        await waitFor(
          () => isChromeStopped(),
          10_000,
          "Physical acceptance retained the Android Chrome process."
        );
        if (requirePromptUiAcceptance) {
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
            (!requirePromptUiAcceptance ||
              (promptRuntime?.streamFailureCount === 0 &&
                promptSubscriberSnapshot?.active_subscribers === 0)),
          "Physical acceptance retained an internal error or active device resource."
        );
        const screenshotBytes = requireRemoteAndroidAcceptance
          ? readPhysicalScreenshots(screenshotDirectory)
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
        } else if (requirePromptUiAcceptance) {
          await restoreAndroidWifi(initialWifiEnabled as boolean);
          initialWifiEnabled = null;
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
      } finally {
        try {
          adb(["shell", "am", "force-stop", "com.android.chrome"]);
          adb(["shell", "input", "keyevent", "KEYCODE_HOME"]);
        } catch {
          // A disconnected phone is reported by the main physical assertion.
        }
        if (display !== null) await closeQrDisplay(display).catch(() => undefined);
        if (requireRemoteAndroidAcceptance && profileSwitch !== null) {
          try {
            if (
              (await readSelectedSavedProfileId()) !==
              profileSwitch.dedicatedProfileId
            ) {
              await switchSavedProfile(profileSwitch.dedicatedProfileId);
            }
            selectedProfile = "dedicated";
          } catch {
            // The failed acceptance retains this cleanup uncertainty.
          }
        }
        if (
          remoteEnabled &&
          env !== null &&
          host !== null &&
          externalOrigin !== null &&
          localOrigin !== null &&
          selectedProfile === "dedicated"
        ) {
          try {
            assertRemoteCliResult(
              await runCli(["remote", "disable", "--json"], {
                createOperationId: () => "op_physical_remote_disable_cleanup_0001",
                env
              }),
              "disabled"
            );
            remoteEnabled = false;
          } catch {
            // The exact manager fallback below still proves or restores absence.
          }
        }
        try {
          if (fallbackCleanup !== null) {
            await proveOrRestoreAbsent(observer, manager, fallbackCleanup);
          }
        } finally {
          controller.abort();
          if (host !== null) await host.close().catch(() => undefined);
          if (opened.db.open) opened.db.close();
          rmSync(directory, { force: true, recursive: true });
          if (initialWifiEnabled !== null) {
            await restoreAndroidWifi(initialWifiEnabled).catch(() => undefined);
          }
          if (initialStayAwakeSetting !== null) {
            await restoreAndroidStayAwake(initialStayAwakeSetting).catch(
              () => undefined
            );
          }
          deviceForbiddenValues.clear();
        }
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
  csrfRequests: number;
  deletionCookieObserved: boolean;
  fragmentLeaks: number;
  hardenedCookieObserved: boolean;
  hostStatusRequests: number;
  hostStatusResponseStatuses: number[];
  noReferrerApiRequests: number;
  promptNoReferrerRequests: number;
  promptRequests: number;
  promptResponseStatuses: number[];
  protectedReadRejections: number;
  protectedReadRequests: number;
  protectedReadSuccesses: number;
  rejectedRevokedCheckpoints: number;
  revokedCheckpointRequests: number;
  revokeRequests: number;
  sessionDetailRequests: number;
  sessionEventRequests: number;
  sessionListRequests: number;
  sessionListResponseStatuses: number[];
  sessionStreamRequests: number;
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
  readonly chrome_version: string;
  readonly commit: string;
  readonly host_os: string;
  readonly node_version: string;
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
  readonly recordStreamFailure: (failure: unknown) => void;
  readonly service: CodexPromptControlService;
  readonly startCalls: readonly PhysicalPromptStartInput[];
  readonly streamFailureCount: number;
  readonly streamFailureCodes: readonly string[];
  readonly subscribers: ReturnType<
    typeof createProjectionSubscriberStreamService
  >;
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

function requireProductionBuildRoot(candidate: string | null): string {
  requireCondition(
    typeof candidate === "string" && candidate.length > 0,
    "Physical production browser build root was unavailable."
  );
  return candidate;
}

interface PhysicalSessionReadFixture {
  readonly promptSeedEvent: SelectedProjectionEvent | null;
  readonly reads: ReturnType<typeof createSelectedSessionReadRepository>;
}

function createPhysicalSessionReads(
  db: ReturnType<typeof openMigratedDatabase>["db"],
  now: () => Date,
  seedPromptEvent: boolean
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
  let promptSeedEvent: SelectedProjectionEvent | null = null;
  if (seedPromptEvent) {
    promptSeedEvent = physicalPromptSeedEvent(updatedAt);
    const states = createSelectedStateRepository(db);
    const current = states.require(physicalUiSessionId);
    const record = Object.freeze({
      byte_length: selectedProjectedEventByteLength(promptSeedEvent),
      event: promptSeedEvent
    });
    states.appendEvent(
      record,
      {
        ...current.projection,
        session: {
          ...current.projection.session,
          last_activity_at: updatedAt,
          last_event_cursor: promptSeedEvent.cursor,
          recent_summary:
            promptSeedEvent.type === "message"
              ? promptSeedEvent.text
              : current.projection.session.recent_summary,
          updated_at: updatedAt
        },
        earliest_retained_cursor: promptSeedEvent.cursor,
        retained_event_bytes: record.byte_length,
        retained_event_count: 1
      },
      selectedStateRevision(current)
    );
  }
  return Object.freeze({
    promptSeedEvent,
    reads: createSelectedSessionReadRepository(db)
  });
}

function createPhysicalPromptRuntime(
  states: ReturnType<typeof createSelectedStateRepository>,
  now: () => Date,
  promptSeedEvent: SelectedProjectionEvent
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
  const handoff = new PhysicalPromptHandoffService([promptSeedEvent]);
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
      const cursor = state === "in_progress" ? 2 : 3;
      handoff.publish(
        physicalPromptTurnEvent(cursor, state, capturedAt)
      );
      phase = state;
    },
    recordStreamFailure,
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
    this.events = [...events];
  }

  publish(event: SelectedProjectionEvent): void {
    const previous = this.events.at(-1);
    requireCondition(
      event.session_id === physicalUiSessionId &&
        (previous === undefined || event.cursor === previous.cursor + 1),
      "Physical prompt event cursor was invalid."
    );
    this.events.push(event);
    for (const entry of [...this.live.values()]) entry.sink(event);
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
      truncated: false
    });
  }
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
  secrets: ReturnType<typeof createSecretRegistry>
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
      installRequestInspection(app, inspection, secrets);
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
      (options.path === "/" || options.path === "/__physical/cleanup"),
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
  secrets: ReturnType<typeof createSecretRegistry>
): void {
  app.addHook("onRequest", async (request) => {
    const referrer = request.headers.referer;
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
    if (
      request.url === "/api/v1/sessions" ||
      request.url.startsWith("/api/v1/sessions?")
    ) {
      inspection.sessionListRequests += 1;
    }
    if (request.url === `/api/v1/sessions/${physicalUiSessionId}`) {
      inspection.sessionDetailRequests += 1;
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
  app.addHook("onResponse", async (request, reply) => {
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
  initiallyEnabled: boolean
): Promise<void> {
  if (initiallyEnabled) {
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
      if (Buffer.byteLength(connectivity, "utf8") > 512 * 1024) return false;
      return connectivity.split(/\r?\n/u).some(
        (line) =>
          line.includes("NetworkAgentInfo") &&
          /\bVPN CONNECTED\b/iu.test(line) &&
          /\bVPN:com\.tailscale\.ipn\b/iu.test(line) &&
          /Transports:[^\]]*\bCELLULAR\b/iu.test(line) &&
          /Transports:[^\]]*\bVPN\b/iu.test(line) &&
          /\bVALIDATED\b/iu.test(line)
      );
    },
    30_000,
    "Physical acceptance requires active cellular and Tailscale VPN transport."
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

async function enforceAndroidAwakeAndUnlocked(
  initialSetting: number
): Promise<void> {
  const requiredSetting = initialSetting | 2;
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
  if (initiallyEnabled && !readAndroidWifiEnabled()) {
    adb(["shell", "svc", "wifi", "enable"]);
  }
  await waitFor(
    () => readAndroidWifiEnabled() === initiallyEnabled,
    15_000,
    "Physical acceptance could not restore Android Wi-Fi state."
  );
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
  const marketName = readOptionalAdbProperty("ro.product.marketname");
  const model = marketName ?? readRequiredAdbProperty("ro.product.model");
  const androidApi = readRequiredAdbProperty("ro.build.version.sdk");
  const androidRelease = readRequiredAdbProperty("ro.build.version.release");
  requireCondition(
    /^[0-9a-f]{40}$/u.test(commit) &&
      tailscaleVersion === "1.98.8" &&
      typeof chromeVersion === "string" &&
      /^[A-Za-z0-9._+-]{1,80}$/u.test(chromeVersion) &&
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
    chrome_version: chromeVersion,
    commit,
    host_os: hostOs,
    node_version: process.version,
    tailscale_version: tailscaleVersion
  });
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
  const values = [...output.matchAll(
    /\b(?:mInputShown|mIsInputViewShown|isInputViewShown)=((?:true|false))\b/gu
  )].map((match) => match[1]);
  requireCondition(
    values.length >= 1 && values.length <= 32,
    "Android input-method visibility was unavailable."
  );
  return values.includes("true");
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
  return adb(["shell", "pidof", "com.android.chrome"]).trim() === "";
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
  readonly description: string;
  readonly text: string;
}

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
  });

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
  await waitForAndroidUiNode(
    "text",
    physicalUiSessionName,
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
    readonly missionControl: string;
    readonly paired: string;
  }>
): Promise<void> {
  const paired = await waitForAndroidUiNode(
    "text",
    "Phone paired",
    30_000,
    "Production pairing confirmation did not render on Android."
  );
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
  await capturePhysicalScreenshot(
    join(input.screenshotDirectory, screenshots.paired)
  );
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
      "text",
      physicalUiSessionName,
      30_000,
      "Production Mission Control did not render the authenticated session."
    );
  } catch {
    throw new Error(
      missionControlRouteFailure(
        input.requestInspection,
        input.readProxyRejection()
      )
    );
  }
  await capturePhysicalScreenshot(
    join(input.screenshotDirectory, screenshots.missionControl)
  );
}

async function runProductionPromptUiSequence(
  input: ProductionUiEntryInput & {
    readonly prompt: PhysicalPromptRuntime;
  }
): Promise<PhysicalPromptSequenceResult> {
  await openProductionMissionControl(input, {
    missionControl: "fe020-02-mission-control.png",
    paired: "fe020-01-paired.png"
  });
  const inputLabel = `Prompt for ${physicalUiSessionName}`;
  const sendLabel = `Send prompt to ${physicalUiSessionName}`;
  const sessionLink = await waitForAndroidUiNode(
    "text",
    physicalUiSessionName,
    30_000,
    "Physical prompt session link was unavailable on Android."
  );
  await performVerifiedAndroidTap({
    initialTrigger: sessionLink,
    triggerField: "text",
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
  try {
    await waitFor(
      () =>
        input.requestInspection.sessionDetailRequests >= 1 &&
        input.requestInspection.sessionEventRequests >= 1 &&
        input.requestInspection.sessionStreamRequests >= 1 &&
        input.prompt.subscribers.snapshot().active_subscribers === 1,
      45_000,
      "Physical prompt detail did not establish one current production stream."
    );
  } catch {
    const snapshot = input.prompt.subscribers.snapshot();
    const failures = input.prompt.streamFailureCodes;
    throw new Error(
      "Physical prompt detail did not establish one current production stream " +
        `(requests=${input.requestInspection.sessionStreamRequests};` +
        `active=${snapshot.active_subscribers};opened=${snapshot.opened_subscribers};` +
        `aborted=${snapshot.aborted_subscribers};explicit=${snapshot.explicit_closures};` +
        `source_failed=${snapshot.source_failed_subscribers};` +
        `open_failed=${snapshot.source_open_failures};` +
        `failures=${failures.length === 0 ? "none" : failures.join("|")}).`
    );
  }
  await waitForAndroidUiNode(
    "text",
    "Ready to send",
    30_000,
    "Physical prompt composer did not become writable on Android."
  );
  const textarea = await waitForAndroidUiNode(
    "description",
    inputLabel,
    30_000,
    "Physical prompt textarea was unavailable on Android."
  );
  await performVerifiedAndroidTap({
    initialTrigger: textarea,
    triggerField: "description",
    triggerValue: inputLabel,
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
  requireCondition(
    keyboardNodes.some((node) => node.text === "Prompt target") &&
      keyboardNodes.some((node) => node.description === inputLabel) &&
      keyboardNodes.some((node) => node.description === sendLabel),
    "Physical prompt controls were not all visible above the Android keyboard."
  );
  await capturePhysicalScreenshot(
    join(input.screenshotDirectory, "fe020-03-keyboard-open.png")
  );

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
  const acceptedTextareas = acceptedNodes.filter(
    (node) => node.description === inputLabel
  );
  requireCondition(
    acceptedTextareas.length === 1 &&
      promptLines.every(
        (line) => !acceptedTextareas[0]?.text.includes(line)
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
  await capturePhysicalScreenshot(
    join(input.screenshotDirectory, "fe020-04-accepted.png")
  );

  await input.prompt.advance("in_progress");
  await waitForAndroidUiNode(
    "text",
    "Turn running",
    30_000,
    "Physical prompt running event did not render on Android."
  );
  await capturePhysicalScreenshot(
    join(input.screenshotDirectory, "fe020-05-running.png")
  );
  await input.prompt.advance("completed");
  await waitForAndroidUiNode(
    "text",
    "Turn completed",
    30_000,
    "Physical prompt completion event did not render on Android."
  );
  await capturePhysicalScreenshot(
    join(input.screenshotDirectory, "fe020-06-completed.png")
  );
  requireCondition(
    input.requestInspection.promptRequests === 1 &&
      input.prompt.startCalls.length === 1 &&
      input.prompt.streamFailureCount === 0,
    "Physical prompt progress introduced a duplicate dispatch or stream failure."
  );

  await cleanProductionUiAuthority(input);
  await waitFor(
    () => input.prompt.subscribers.snapshot().active_subscribers === 0,
    15_000,
    "Physical prompt cleanup retained a production stream subscriber."
  );
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
    if (text === "" && description === "") continue;
    nodes.push(
      Object.freeze({
        bounds: Object.freeze({ bottom, left, right, top }),
        description,
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

async function waitForAndroidUiNode(
  field: "description" | "text",
  value: string,
  timeoutMs: number,
  message: string
): Promise<AndroidUiNode> {
  let found: AndroidUiNode | null = null;
  await waitFor(async () => {
    const matches = (await readAndroidUiNodes()).filter(
      (node) => node[field] === value
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
  readonly terminalFailureMessage: string;
  readonly triggerField: "description" | "text";
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
        (node) => node[input.triggerField] === input.triggerValue
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
      const reacquired = matches[0];
      if (reacquired === undefined) {
        throw new Error(
          `${input.reacquireFailureMessage} (${androidUiStateSummary(nodes, trigger)}).`
        );
      }
      trigger = reacquired;
    }
  }
  throw new Error(input.terminalFailureMessage);
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
  return (
    `bounds=${trigger.bounds.left},${trigger.bounds.top},` +
    `${trigger.bounds.right},${trigger.bounds.bottom};` +
    `known=${visible.length === 0 ? "none" : visible.join("|")}`
  );
}

function tapAndroidUiNode(node: AndroidUiNode): void {
  requireChromeForeground();
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
  adb([
    "shell",
    "am",
    "start",
    "-W",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    target.toString(),
    "-p",
    "com.android.chrome"
  ]);
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

async function capturePhysicalScreenshot(path: string): Promise<void> {
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
  requireCondition(
    Buffer.isBuffer(bytes) &&
      bytes.length >= 1_024 &&
      bytes.length <= 4 * 1024 * 1024 &&
      bytes.subarray(0, 8).equals(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
      ),
    "Physical screenshot bytes were invalid."
  );
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
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
      inspection.sessionEventRequests >= 1 &&
      inspection.sessionEventRequests <= 2 &&
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
      saved_profile_restored: true,
      sse_active: 0,
      temporary_state_present: false
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
