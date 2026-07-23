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
  defaultResourceBudget,
  type RemoteIngressObservationSnapshot,
  type RemoteServeDescriptor,
  remoteProxyTrustRejectionReasons,
  remoteServeDescriptorSchema,
  selectedHostLockStateResponseSchema,
  selectedPairingFragmentPrefix,
  selectedPairingLinkSchema,
  selectedProjectionEventSchema,
  selectedRequestAuthenticationContextSchema
} from "@hostdeck/contracts";
import {
  createHostDeckCsrfPolicy,
  createHostDeckCsrfRouteRegistration,
  createHostDeckDeviceRevokeRouteRegistration,
  createHostDeckHealthRouteRegistration,
  createHostDeckHostHealthService,
  createHostDeckHostLockPolicy,
  createHostDeckHostLockRouteRegistration,
  createHostDeckPairingPolicy,
  createHostDeckPairingRouteRegistration,
  createHostDeckRemoteIngressLifecycle,
  createHostDeckRemoteIngressRouteRegistration,
  createHostDeckRequestAuthenticationPolicy,
  createHostDeckSelectedWriteAdmissionPolicy,
  createHostDeckSessionReadRouteRegistration,
  createHostDeckSseTransportRegistration,
  createHostDeckStaticBoundaryRegistration,
  createRemoteIngressControlService,
  createSecurityMutationAuditExecutor,
  createTailscaleObserver,
  createTailscaleServeManager,
  type HostDeckFastifyInstance,
  type HostDeckFastifyLifecycle,
  type HostDeckRemoteIngressLifecycle,
  type HostDeckRoutePluginRegistration,
  hostDeckLocalHealthComponents,
  hostDeckNoStoreRouteConfig,
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
  createSettingsRepository,
  openMigratedDatabase
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
const requirePairingUiAcceptance =
  process.env.HOSTDECK_REQUIRE_PAIRING_ANDROID_SMOKE === "1" &&
  !requireRemoteAndroidAcceptance;
const requirePhysicalPairing =
  requirePairingUiAcceptance || requireRemoteAndroidAcceptance;
const describePhysical = requirePhysicalPairing ? describe : describe.skip;
const overallTimeoutMs = requireRemoteAndroidAcceptance
  ? 20 * 60_000
  : 10 * 60_000;
const claimTimeoutMs = 5 * 60_000;
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
      const states = createRemoteIngressStateRepository(opened.db);
      const proofs = createRemoteIngressAdmissionProofRepository(opened.db);
      const observer = createTailscaleObserver({ signal: controller.signal });
      const manager = createTailscaleServeManager({
        observer,
        signal: controller.signal
      });
      const secrets = createSecretRegistry();
      const requestInspection: RequestInspection = {
        accessRequests: 0,
        claimRequests: 0,
        csrfRequests: 0,
        deletionCookieObserved: false,
        fragmentLeaks: 0,
        hardenedCookieObserved: false,
        hostStatusRequests: 0,
        noReferrerApiRequests: 0,
        protectedReadRejections: 0,
        protectedReadRequests: 0,
        protectedReadSuccesses: 0,
        rejectedRevokedCheckpoints: 0,
        revokedCheckpointRequests: 0,
        revokeRequests: 0,
        sessionListRequests: 0
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
      const acceptanceStartedAt = requireRemoteAndroidAcceptance
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
      let initialWifiEnabled: boolean | null = null;
      let initialStayAwakeSetting: number | null = null;
      let selectedProfile: "away" | "dedicated" = "dedicated";
      let internalErrorCount = 0;

      try {
        adbCommandCount = 0;
        deviceForbiddenValues.clear();
        if (requirePairingUiAcceptance || requireRemoteAndroidAcceptance) {
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
        const productionBuildRoot = requirePairingUiAcceptance
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
        if (requirePairingUiAcceptance) {
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
              states
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
        const sessionReads = requirePairingUiAcceptance
          ? createPhysicalSessionReads(opened.db, now)
          : null;
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
          ...(requirePairingUiAcceptance && sessionReads !== null
            ? [
                createHostDeckHealthRouteRegistration({ health }),
                createHostDeckSessionReadRouteRegistration({
                  sessions: sessionReads
                })
              ]
            : []),
          physicalProtectedRoute(),
          physicalDriverRoute(driverRuntime)
        ];
        const staticRoutes = requirePairingUiAcceptance
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
            [physicalSseRoute(sseRuntime)],
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
        await assertTrustedPhysicalPage(candidate.externalOrigin);
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

        display = await startQrDisplay(qrImage as Buffer);
        rendered.link = null;
        rendered.qrImage = null;

        adb(["shell", "am", "force-stop", "com.android.chrome"]);
        openDefaultCamera();
        await waitFor(
          () =>
            countRows(opened.db, "auth_devices") === 1 ||
            firstProxyRejection(
              (host as HostDeckFastifyLifecycle<PhysicalRuntimeContext>).app
            ) !== null ||
            selectedRemote.snapshot().phase !== "running",
          claimTimeoutMs,
          "The physical phone did not claim the private QR in time."
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
        await closeQrDisplay(display);
        display = null;

        requireChromeRunning();
        if (requirePairingUiAcceptance) {
          await runProductionPairingUiSequence({
            db: opened.db,
            driver: driverRuntime,
            externalOrigin: candidate.externalOrigin,
            requestInspection,
            screenshotDirectory
          });
          assertPairingUiRuntimeTruth(opened.db, requestInspection);
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
        assertPairingAudit(opened.db);
        assertSecretsAbsentFromDatabase(dbPath, secrets.values());

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
        } else if (!requirePairingUiAcceptance) {
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
        requireNoAdbApplicationTunnels();
        requireCondition(
          adbCommandCount > 0 &&
            internalErrorCount === 0 &&
            sseRuntime.active === 0,
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
  claimRequests: number;
  csrfRequests: number;
  deletionCookieObserved: boolean;
  fragmentLeaks: number;
  hardenedCookieObserved: boolean;
  hostStatusRequests: number;
  noReferrerApiRequests: number;
  protectedReadRejections: number;
  protectedReadRequests: number;
  protectedReadSuccesses: number;
  rejectedRevokedCheckpoints: number;
  revokedCheckpointRequests: number;
  revokeRequests: number;
  sessionListRequests: number;
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

function createPhysicalSessionReads(
  db: ReturnType<typeof openMigratedDatabase>["db"],
  now: () => Date
): ReturnType<typeof createSelectedSessionReadRepository> {
  const createdAt = now().toISOString();
  const updatedAt = now().toISOString();
  db.prepare(
    `
      INSERT INTO selected_sessions (
        id, name, codex_thread_id, cwd, runtime_source, runtime_version,
        disposition, created_at, updated_at, archived_at
      ) VALUES (
        'sess_physical_pairing_ui', 'Physical pairing review',
        'thread-physical-pairing-ui', '/workspace/hostdeck',
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
        'sess_physical_pairing_ui', 'active', 'idle', 'none', 'current',
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
  return createSelectedSessionReadRepository(db);
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

async function assertTrustedPhysicalPage(origin: string): Promise<void> {
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
    response.status === 200 &&
      response.body.includes("HostDeck pairing acceptance") &&
      response.body.includes("/__physical/checkpoint/"),
    "Physical HTTPS page preflight was invalid."
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
    "The scanned pairing link did not open in Android Chrome."
  );
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

async function runProductionPairingUiSequence(input: {
  readonly db: ReturnType<typeof openMigratedDatabase>["db"];
  readonly driver: PhysicalDriverRuntime;
  readonly externalOrigin: string;
  readonly requestInspection: RequestInspection;
  readonly screenshotDirectory: string;
}): Promise<void> {
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
      readAndroidUiNodes(),
      input.requestInspection
    ),
    "Production pairing confirmation disclosed protected state or repeated startup work."
  );
  await capturePhysicalScreenshot(
    join(input.screenshotDirectory, "fe013-01-paired.png")
  );
  tapAndroidUiNode(continueButton);

  await waitFor(
    () =>
      input.requestInspection.accessRequests >= 1 &&
      input.requestInspection.hostStatusRequests >= 1 &&
      input.requestInspection.sessionListRequests >= 1,
    30_000,
    "Production Mission Control did not load its authenticated route data."
  );
  await waitForAndroidUiNode(
    "text",
    "Mission Control",
    30_000,
    "Production Mission Control did not render on Android."
  );
  await waitForAndroidUiNode(
    "text",
    "Physical pairing review",
    30_000,
    "Production Mission Control did not render the authenticated session."
  );
  await capturePhysicalScreenshot(
    join(input.screenshotDirectory, "fe013-02-mission-control.png")
  );

  const accessTrigger = await waitForAndroidUiNode(
    "description",
    "Open Host and access",
    30_000,
    "Production Host and access trigger was unavailable on Android."
  );
  tapAndroidUiNode(accessTrigger);
  await waitForAndroidUiNode(
    "text",
    "Host & access",
    30_000,
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

  const closeAccess = await waitForAndroidUiNode(
    "description",
    "Close Host and access",
    30_000,
    "Production Host and access close control was unavailable on Android."
  );
  tapAndroidUiNode(closeAccess);
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
    "Physical pairing review",
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

function readAndroidUiNodes(): readonly AndroidUiNode[] {
  return parseAndroidUiNodes(
    adb(["exec-out", "uiautomator", "dump", "/dev/tty"])
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
  await waitFor(() => {
    const matches = readAndroidUiNodes().filter(
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

function tapAndroidUiNode(node: AndroidUiNode): void {
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
  const bytes = execFileSync("adb", ["exec-out", "screencap", "-p"], {
    encoding: null,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    maxBuffer: 4 * 1024 * 1024,
    timeout: 15_000
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
  db: ReturnType<typeof openMigratedDatabase>["db"]
): void {
  const rows = db
    .prepare(
      "SELECT action, phase, outcome, COUNT(*) AS count " +
        "FROM selected_audit_events " +
        "WHERE action IN ('pair_request','pair_claim','csrf_bootstrap') " +
        "GROUP BY action, phase, outcome ORDER BY action, phase, outcome"
    )
    .all();
  requireCondition(
    JSON.stringify(rows) ===
      JSON.stringify([
        { action: "csrf_bootstrap", phase: "accepted", outcome: "accepted", count: 1 },
        { action: "csrf_bootstrap", phase: "terminal", outcome: "succeeded", count: 1 },
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
