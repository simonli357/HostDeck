import { execFile, execFileSync } from "node:child_process";
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
  selectedPairingFragmentPrefix,
  selectedPairingLinkSchema,
  selectedProjectionEventSchema,
  selectedRequestAuthenticationContextSchema
} from "@hostdeck/contracts";
import {
  createHostDeckCsrfPolicy,
  createHostDeckCsrfRouteRegistration,
  createHostDeckDeviceRevokeRouteRegistration,
  createHostDeckHostHealthService,
  createHostDeckHostLockPolicy,
  createHostDeckHostLockRouteRegistration,
  createHostDeckPairingPolicy,
  createHostDeckPairingRouteRegistration,
  createHostDeckRemoteIngressLifecycle,
  createHostDeckRemoteIngressRouteRegistration,
  createHostDeckRequestAuthenticationPolicy,
  createHostDeckSelectedWriteAdmissionPolicy,
  createHostDeckSseTransportRegistration,
  createRemoteIngressControlService,
  createSecurityMutationAuditExecutor,
  createTailscaleObserver,
  createTailscaleServeManager,
  type HostDeckFastifyInstance,
  type HostDeckFastifyLifecycle,
  type HostDeckRemoteIngressLifecycle,
  type HostDeckRoutePluginRegistration,
  hostDeckLocalAdminRequestHeaderName,
  hostDeckLocalAdminRequestHeaderValue,
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
  createSettingsRepository,
  openMigratedDatabase
} from "@hostdeck/storage";
import { type Browser, type BrowserContext, chromium, type Page } from "@playwright/test";
import QRCode from "qrcode";
import { build as viteBuild } from "vite";
import { describe, it } from "vitest";
import { cliExitCodes } from "./exit-codes.js";
import { runCli } from "./shell.js";

const requireRemoteAndroidAcceptance =
  process.env.HOSTDECK_REQUIRE_REMOTE_ANDROID_ACCEPTANCE === "1";
const requirePhysicalPairing =
  process.env.HOSTDECK_REQUIRE_PAIRING_ANDROID_SMOKE === "1" ||
  requireRemoteAndroidAcceptance;
const describePhysical = requirePhysicalPairing ? describe : describe.skip;
const overallTimeoutMs = requireRemoteAndroidAcceptance
  ? 20 * 60_000
  : 10 * 60_000;
const claimTimeoutMs = 5 * 60_000;
const tailscaleDnsServer = "100.100.100.100";
const physicalPageMaxBytes = defaultResourceBudget.cli_response_max_bytes;
const physicalEvidenceDirectory = join(
  process.cwd(),
  "artifacts",
  "ifc-v1-079-device"
);
const deviceForbiddenValues = new Set<string>();
let adbCommandCount = 0;

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
        claimRequests: 0,
        csrfRequests: 0,
        deletionCookieObserved: false,
        fragmentLeaks: 0,
        hardenedCookieObserved: false,
        noReferrerApiRequests: 0,
        revokeRequests: 0
      };
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
      let displayBrowser: Browser | null = null;
      let displayContext: BrowserContext | null = null;
      let displayPage: Page | null = null;
      let cdp: CdpClient | null = null;
      let forwardPort: number | null = null;
      let remoteEnabled = false;
      let fallbackCleanup: CleanupTarget | null = null;
      let externalOrigin: string | null = null;
      let localOrigin: string | null = null;
      let env: Readonly<Record<string, string>> | null = null;
      let foreignServeBefore: ServeStatusFingerprint | null = null;
      let environmentFacts: PhysicalEnvironmentFacts | null = null;
      let fullResult: PhysicalSequenceResult | null = null;
      let initialWifiEnabled: boolean | null = null;
      let selectedProfile: "away" | "dedicated" = "dedicated";
      let internalErrorCount = 0;

      try {
        adbCommandCount = 0;
        deviceForbiddenValues.clear();
        if (requireRemoteAndroidAcceptance) {
          requireCleanAcceptanceWorktree();
          requireNoAdbApplicationTunnels();
          initialWifiEnabled = readAndroidWifiEnabled();
          await enforceUnrelatedAndroidNetwork(initialWifiEnabled);
          environmentFacts = readPhysicalEnvironmentFacts();
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
        const candidate = requireDedicatedAbsentCandidate(
          await observer.observeCandidate()
        );
        await closeExistingChromeOriginTabs(candidate.externalOrigin);
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
            read: () => settings.require(),
            transition: (input) => settings.transitionHostLock(input)
          },
          now
        });
        const writeAdmission = createHostDeckSelectedWriteAdmissionPolicy({
          resourceBudget: defaultResourceBudget,
          now: () => performance.now()
        });
        const revocations = createDeviceRevocationRepository(opened.db);
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
          physicalProtectedRoute()
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
            [physicalSseRoute(sseRuntime)],
            requestInspection,
            secrets
          ),
          composePhysicalRouteRegistration(
            "physical-remote-page",
            "static",
            [physicalPageRoute(browserBundle)],
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
        if (requireRemoteAndroidAcceptance) {
          await assertUnpairedAndroidAccess(candidate.externalOrigin);
          requireNoAdbApplicationTunnels();
        }

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
              rendered.qrImage = await QRCode.toDataURL(link, {
                errorCorrectionLevel: "M",
                margin: 4,
                type: "image/png",
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
            typeof qrImage === "string" &&
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
            !qrImage.includes(pairingCode),
          "Physical pairing link did not match the selected contract."
        );
        deviceForbiddenValues.add(pairingLink);
        pairResult = null;

        display = await startQrDisplay(qrImage);
        rendered.link = null;
        rendered.qrImage = null;
        displayBrowser = await chromium.launch({ headless: false });
        displayContext = await displayBrowser.newContext({
          viewport: { width: 760, height: 860 }
        });
        displayPage = await displayContext.newPage();
        await displayPage.goto(display.url, { waitUntil: "load" });
        await displayPage.bringToFront();
        await displayPage.locator("img").waitFor({ state: "visible" });
        display.clear();

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
        await displayPage.locator("#status").evaluate((element) => {
          element.textContent = "Pairing accepted. Inspecting the phone...";
        });
        await displayContext.close();
        displayContext = null;
        await displayBrowser.close();
        displayBrowser = null;
        await closeServer(display.server);
        display = null;
        displayPage = null;

        requireChromeRunning();
        forwardPort = createChromeForward();
        const target = await waitForChromeTarget(
          forwardPort,
          candidate.externalOrigin,
          30_000
        );
        cdp = await CdpClient.connect(
          target.webSocketDebuggerUrl,
          deviceForbiddenValues
        );
        await cdp.send("Runtime.enable");
        await cdp.send("Page.enable");
        await waitFor(
          async () =>
            (await readPhoneSnapshot(cdp as CdpClient)).state === "paired",
          30_000,
          "Physical Chrome did not publish paired browser state."
        );
        const initialPhone = await readPhoneSnapshot(cdp);
        assertPairedPhoneSnapshot(initialPhone);
        requireCondition(
          (await cdp.evaluate<number>(protectedReadExpression)) === 200,
          "Physical paired cookie did not authorize a protected read."
        );
        assertPairingRuntimeTruth(opened.db, requestInspection);
        assertPairingAudit(opened.db);
        assertSecretsAbsentFromDatabase(dbPath, secrets.values());

        await cdp.send("Page.reload", { ignoreCache: true });
        await waitFor(
          async () =>
            (await readPhoneSnapshot(cdp as CdpClient)).state === "no_fragment",
          30_000,
          "Physical Chrome reload did not reach the fragment-free state."
        );
        const reloadedPhone = await readPhoneSnapshot(cdp);
        assertReloadedPhoneSnapshot(reloadedPhone);
        requireCondition(
          (await cdp.evaluate<number>(protectedReadExpression)) === 200,
          "Physical reload lost the HttpOnly device authority."
        );
        assertPairingRuntimeTruth(opened.db, requestInspection);

        if (requireRemoteAndroidAcceptance) {
          fullResult = await runPhysicalSecuritySequence({
            cdp,
            db: opened.db,
            env,
            foreignServeBefore: foreignServeBefore as ServeStatusFingerprint,
            manager: requireLifecycleManager(lifecycleManager),
            origin: candidate.externalOrigin,
            profileSwitch: profileSwitch as ProfileSwitchInput,
            remote: selectedRemote,
            requestInspection,
            screenshotDirectory,
            setSelectedProfile(profile) {
              selectedProfile = profile;
            },
            sseRuntime
          });
        }

        await cdp.send("Storage.clearDataForOrigin", {
          origin: candidate.externalOrigin,
          storageTypes:
            "cookies,local_storage,session_storage,indexeddb,cache_storage,service_workers"
        });
        requireCondition(
          (await cdp.evaluate<number>(protectedReadExpression)) === 401,
          "Physical HostDeck site-data cleanup did not remove device authority."
        );
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
          await renderPhysicalState(cdp, {
            detail: "Device authority removed. Private ingress is absent.",
            state: "revoked_cleaned",
            title: "Revoked and cleaned"
          });
          await capturePhysicalScreenshot(
            cdp,
            join(screenshotDirectory, "04-revoked-cleaned.png")
          );
          assertFullPhysicalAudit(opened.db);
          assertSecretsAbsentFromDatabase(dbPath, secrets.values());
        }
        fallbackCleanup = null;
        await cdp.send("Page.close").catch(() => undefined);
        cdp.close();
        cdp = null;
        adb(["forward", "--remove", `tcp:${forwardPort}`]);
        forwardPort = null;
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
        if (cdp !== null) cdp.close();
        if (forwardPort !== null) {
          try {
            adb(["forward", "--remove", `tcp:${forwardPort}`]);
          } catch {
            // Continue through ownership-safe host cleanup.
          }
        }
        try {
          adb(["shell", "am", "force-stop", "com.android.chrome"]);
          adb(["shell", "input", "keyevent", "KEYCODE_HOME"]);
        } catch {
          // A disconnected phone is reported by the main physical assertion.
        }
        if (displayContext !== null) await displayContext.close().catch(() => undefined);
        if (displayBrowser !== null) await displayBrowser.close().catch(() => undefined);
        if (display !== null) await closeServer(display.server).catch(() => undefined);
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
  claimRequests: number;
  csrfRequests: number;
  deletionCookieObserved: boolean;
  fragmentLeaks: number;
  hardenedCookieObserved: boolean;
  noReferrerApiRequests: number;
  revokeRequests: number;
}

interface PairingRenderCapture {
  link: string | null;
  qrImage: string | null;
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
  readonly server: HttpServer;
  readonly url: string;
  readonly clear: () => void;
}

interface ChromeTarget {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly url: string;
  readonly webSocketDebuggerUrl: string;
}

interface ChromeTargetSnapshot {
  readonly endpointAvailable: boolean;
  readonly targets: readonly ChromeTarget[];
}

interface PhoneSnapshot {
  readonly cacheCount: number;
  readonly cookieLength: number;
  readonly csrfGeneration: number | null;
  readonly domHasPairFragment: boolean;
  readonly hash: string;
  readonly indexedDbCount: number;
  readonly localStorageCount: number;
  readonly pathname: string;
  readonly permission: string | null;
  readonly referrerHasPairFragment: boolean;
  readonly resourceHasPairFragment: boolean;
  readonly search: string;
  readonly serviceWorkerCount: number;
  readonly sessionStorageCount: number;
  readonly state: string;
  readonly summaryKeys: readonly string[];
}

interface CdpMessage {
  readonly error?: unknown;
  readonly id?: number;
  readonly method?: string;
  readonly result?: unknown;
}

const protectedReadExpression =
  "fetch('/__physical/protected',{credentials:'include',cache:'no-store',referrerPolicy:'no-referrer'}).then((response)=>response.status)";

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

function physicalPageRoute(bundle: string): HostDeckRoutePluginRegistration {
  const nonce = randomBytes(18).toString("base64url");
  const html =
    "<!doctype html><html lang=\"en\"><head>" +
    "<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<title>HostDeck pairing acceptance</title>" +
    `<style nonce="${nonce}">:root{font-family:Inter,system-ui,sans-serif;color:#17191c;background:#f4f5f6}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#f4f5f6}main{width:min(100%,420px);border-top:4px solid #167c5a;background:#fff;padding:30px 24px;box-shadow:0 10px 34px rgba(20,27,31,.12)}.brand{margin:0 0 26px;font-size:13px;font-weight:800;text-transform:uppercase;color:#525a61}.marker{width:44px;height:44px;display:grid;place-items:center;margin-bottom:22px;background:#e8f4ef;color:#116b4d;font-size:22px;font-weight:800;border-radius:6px}h1{margin:0;font-size:28px;line-height:1.15;letter-spacing:0}#status{margin:14px 0 0;font-size:17px;font-weight:700;color:#22272b}#detail{min-height:48px;margin:8px 0 0;color:#5b6268;font-size:15px;line-height:1.5}.rule{height:1px;margin:26px 0 18px;background:#dfe3e5}.foot{margin:0;font-size:12px;color:#747b81}</style></head>` +
    "<body><main><p class=\"brand\">HostDeck</p><div class=\"marker\" aria-hidden=\"true\">H</div>" +
    "<h1>Remote access check</h1><p id=\"status\">Starting</p>" +
    "<p id=\"detail\">Preparing the private connection.</p><div class=\"rule\"></div>" +
    "<p class=\"foot\">Private device acceptance</p></main>" +
    `<script type="module" nonce="${nonce}">${bundle}</script></body></html>`;
  const registration: HostDeckRoutePluginRegistration = {
    id: "physical-fragment-pairing-page",
    surface: "static",
    register(app) {
      app.get("/", async (_request, reply) => {
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
    if (
      request.url.startsWith("/api/v1/access/devices/") &&
      request.url.endsWith("/revoke")
    ) {
      inspection.revokeRequests += 1;
    }
  });
  app.addHook("onResponse", async (request, reply) => {
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
      response.body.includes("__hostDeckPhysicalPairing"),
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

async function startQrDisplay(dataUrl: string): Promise<QrDisplay> {
  requireCondition(
    /^data:image\/png;base64,[A-Za-z0-9+/=]+$/u.test(dataUrl) &&
      Buffer.byteLength(dataUrl, "utf8") <=
        defaultResourceBudget.cli_response_max_bytes * 4,
    "Physical QR image was invalid."
  );
  let html =
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<title>HostDeck private pairing QR</title>" +
    "<style>body{font-family:system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#fff;color:#111}main{text-align:center}img{width:min(70vw,560px);height:auto;image-rendering:pixelated}p{font-size:20px;max-width:34rem}</style>" +
    `</head><body><main><h1>HostDeck</h1><p id="status">Open Camera on the phone, scan this QR, and tap the private link.</p><img alt="Private HostDeck pairing QR" src="${dataUrl}"></main></body></html>`;
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff"
    });
    response.end(html);
  });
  await listen(server, 0);
  const address = server.address();
  requireCondition(
    address !== null && typeof address !== "string",
    "Physical QR display did not bind loopback."
  );
  return Object.freeze({
    server,
    url: `http://127.0.0.1:${(address as AddressInfo).port}/`,
    clear() {
      html = "<!doctype html><title>HostDeck QR consumed</title>";
    }
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
    "Physical acceptance found an ADB tunnel outside its bounded DevTools inspection."
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

function openChromeLauncher(): void {
  const resolution = adb([
    "shell",
    "cmd",
    "package",
    "resolve-activity",
    "--brief",
    "-a",
    "android.intent.action.MAIN",
    "-c",
    "android.intent.category.LAUNCHER",
    "-p",
    "com.android.chrome"
  ]);
  const component = resolution
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .findLast((line) => /^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/u.test(line));
  requireCondition(
    component !== undefined && component.length <= 256,
    "Physical pairing could not resolve Android Chrome."
  );
  adb([
    "shell",
    "am",
    "start",
    "-n",
    component,
    "-a",
    "android.intent.action.MAIN",
    "-c",
    "android.intent.category.LAUNCHER"
  ]);
}

function openChromeUrl(origin: string): void {
  const parsed = new URL(origin);
  requireCondition(
    parsed.origin === origin &&
      parsed.protocol === "https:" &&
      parsed.pathname === "/",
    "Physical Chrome URL was not one canonical HTTPS origin."
  );
  adb([
    "shell",
    "am",
    "start",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    origin,
    "-p",
    "com.android.chrome"
  ]);
}

async function assertUnpairedAndroidAccess(origin: string): Promise<void> {
  let cdp: CdpClient | null = null;
  let port: number | null = null;
  try {
    adb(["shell", "am", "force-stop", "com.android.chrome"]);
    openChromeUrl(origin);
    await waitFor(
      () => {
        requireChromeRunning();
        return true;
      },
      15_000,
      "Android Chrome did not start for the unpaired HTTPS check."
    );
    port = createChromeForward();
    const target = await waitForChromeTarget(port, origin, 30_000);
    cdp = await CdpClient.connect(
      target.webSocketDebuggerUrl,
      deviceForbiddenValues
    );
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await waitFor(
      async () => (await readPhoneSnapshot(cdp as CdpClient)).state === "no_fragment",
      30_000,
      "Android Chrome did not load the trusted unpaired HTTPS page."
    );
    assertReloadedPhoneSnapshot(await readPhoneSnapshot(cdp));
    requireCondition(
      (await cdp.evaluate<number>(protectedReadExpression)) === 401,
      "Unpaired Android Chrome reached protected HostDeck data."
    );
    await cdp.send("Storage.clearDataForOrigin", {
      origin,
      storageTypes:
        "cookies,local_storage,session_storage,indexeddb,cache_storage,service_workers"
    });
    await cdp.send("Page.close").catch(() => undefined);
  } finally {
    cdp?.close();
    if (port !== null) {
      try {
        adb(["forward", "--remove", `tcp:${port}`]);
      } catch {
        // The caller's tunnel assertion reports cleanup failure.
      }
    }
    adb(["shell", "am", "force-stop", "com.android.chrome"]);
  }
}

function requireChromeRunning(): void {
  const processes = adb(["shell", "pidof", "com.android.chrome"]).trim();
  requireCondition(
    /^\d+(?:\s+\d+)*$/u.test(processes),
    "The scanned pairing link did not open in Android Chrome."
  );
}

async function closeExistingChromeOriginTabs(expectedOrigin: string): Promise<void> {
  let port: number | null = null;
  try {
    openChromeLauncher();
    await waitFor(
      () => {
        requireChromeRunning();
        return true;
      },
      10_000,
      "Android Chrome did not start for targeted tab cleanup."
    );
    port = createChromeForward();
    const initial = await waitForChromeEndpoint(port, 10_000);
    const matching = initial.targets.filter(
      (target) => safeUrlOrigin(target.url) === expectedOrigin
    );
    requireCondition(
      matching.length <= 16 &&
        matching.every((target) => /^[A-Fa-f0-9]{1,64}$/u.test(target.id)),
      "Existing HostDeck Chrome targets exceeded the cleanup boundary."
    );
    for (const target of matching) {
      const response = await fetch(
        `http://127.0.0.1:${port}/json/close/${encodeURIComponent(target.id)}`,
        { signal: AbortSignal.timeout(2_000) }
      );
      requireCondition(response.ok, "Existing HostDeck Chrome target did not close.");
      await response.body?.cancel();
    }
    await waitFor(
      async () => {
        const current = await readChromeTargets(port as number);
        return (
          current.endpointAvailable &&
          current.targets.every(
            (target) => safeUrlOrigin(target.url) !== expectedOrigin
          )
        );
      },
      10_000,
      "Existing HostDeck Chrome targets remained after cleanup."
    );
  } finally {
    if (port !== null) {
      try {
        adb(["forward", "--remove", `tcp:${port}`]);
      } catch {
        // Continue with the targeted Chrome process cleanup.
      }
    }
    adb(["shell", "am", "force-stop", "com.android.chrome"]);
  }
}

async function waitForChromeEndpoint(
  port: number,
  timeoutMs: number
): Promise<ChromeTargetSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await readChromeTargets(port);
    if (snapshot.endpointAvailable) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Android Chrome DevTools endpoint was unavailable.");
}

function safeUrlOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function createChromeForward(): number {
  const port = Number(
    adb(["forward", "tcp:0", "localabstract:chrome_devtools_remote"]).trim()
  );
  requireCondition(
    Number.isInteger(port) && port >= 1 && port <= 65_535,
    "ADB returned an invalid Chrome DevTools forward."
  );
  return port;
}

async function waitForChromeTarget(
  port: number,
  expectedOrigin: string,
  timeoutMs: number
): Promise<ChromeTarget> {
  let selected: ChromeTarget | undefined;
  let endpointObserved = false;
  let pageTargetsObserved = 0;
  let expectedOriginTargetsObserved = 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && selected === undefined) {
    const snapshot = await readChromeTargets(port);
    endpointObserved ||= snapshot.endpointAvailable;
    pageTargetsObserved = Math.max(
      pageTargetsObserved,
      snapshot.targets.filter((target) => target.type === "page").length
    );
    const matching = snapshot.targets.filter((target) => {
      try {
        return new URL(target.url).origin === expectedOrigin;
      } catch {
        return false;
      }
    });
    expectedOriginTargetsObserved = Math.max(
      expectedOriginTargetsObserved,
      matching.length
    );
    requireCondition(
      matching.every((target) => {
        const url = new URL(target.url);
        return url.hash === "" && url.search === "" && url.pathname === "/";
      }),
      "Physical Chrome retained a pairing fragment after claim."
    );
    selected = matching.find((target) => target.type === "page");
    if (selected === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  requireCondition(
    selected !== undefined,
    `Physical Chrome target was unavailable after pairing (endpoint=${endpointObserved};pages=${pageTargetsObserved};origin=${expectedOriginTargetsObserved}).`
  );
  return selected;
}

async function readChromeTargets(port: number): Promise<ChromeTargetSnapshot> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(2_000)
    });
  } catch {
    return Object.freeze({ endpointAvailable: false, targets: [] });
  }
  if (!response.ok) {
    return Object.freeze({ endpointAvailable: false, targets: [] });
  }
  const body = await response.text();
  requireCondition(
    Buffer.byteLength(body, "utf8") <= 256 * 1024 &&
      [...deviceForbiddenValues].every((value) => !body.includes(value)),
    "Chrome DevTools target metadata retained a protected pairing value."
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new Error("Chrome DevTools target metadata was invalid JSON.");
  }
  requireCondition(Array.isArray(parsed), "Chrome DevTools target metadata was invalid.");
  const targets = parsed.map((candidate): ChromeTarget => {
    requireCondition(
      candidate !== null &&
        typeof candidate === "object" &&
        typeof candidate.id === "string" &&
        typeof candidate.title === "string" &&
        typeof candidate.type === "string" &&
        typeof candidate.url === "string" &&
        typeof candidate.webSocketDebuggerUrl === "string",
      "Chrome DevTools returned a malformed target."
    );
    return candidate as ChromeTarget;
  });
  return Object.freeze({ endpointAvailable: true, targets: Object.freeze(targets) });
}

class CdpClient {
  readonly #pending = new Map<
    number,
    {
      readonly reject: (error: Error) => void;
      readonly resolve: (value: unknown) => void;
      readonly timeout: NodeJS.Timeout;
    }
  >();
  readonly #socket: WebSocket;
  readonly #forbidden: ReadonlySet<string>;
  #nextId = 0;

  private constructor(socket: WebSocket, forbidden: ReadonlySet<string>) {
    this.#socket = socket;
    this.#forbidden = forbidden;
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let message: CdpMessage;
      try {
        message = JSON.parse(event.data) as CdpMessage;
      } catch {
        return;
      }
      if (typeof message.id !== "number") return;
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error !== undefined) {
        pending.reject(new Error("Chrome DevTools command failed."));
      } else {
        pending.resolve(message.result);
      }
    });
    socket.addEventListener("close", () => {
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Chrome DevTools connection closed."));
      }
      this.#pending.clear();
    });
  }

  static async connect(
    url: string,
    forbidden: ReadonlySet<string>
  ): Promise<CdpClient> {
    requireCondition(
      [...forbidden].every((value) => !url.includes(value)),
      "Chrome DevTools endpoint retained a protected pairing value."
    );
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Chrome DevTools connection timed out.")),
        5_000
      );
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true }
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          reject(new Error("Chrome DevTools connection failed."));
        },
        { once: true }
      );
    });
    return new CdpClient(socket, forbidden);
  }

  send(
    method: string,
    params: Readonly<Record<string, unknown>> = {}
  ): Promise<unknown> {
    const serialized = JSON.stringify({ method, params });
    requireCondition(
      [...this.#forbidden].every((value) => !serialized.includes(value)),
      "A protected pairing value was rejected before CDP dispatch."
    );
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("Chrome DevTools command timed out."));
      }, 10_000);
      this.#pending.set(id, { reject, resolve, timeout });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const response = (await this.send("Runtime.evaluate", {
      awaitPromise: true,
      expression,
      returnByValue: true
    })) as {
      readonly exceptionDetails?: unknown;
      readonly result?: { readonly value?: unknown };
    };
    if (response.exceptionDetails !== undefined || response.result === undefined) {
      throw new Error("Chrome evaluation failed.");
    }
    return response.result.value as T;
  }

  close(): void {
    if (this.#socket.readyState < WebSocket.CLOSING) this.#socket.close();
  }
}

async function runPhysicalSecuritySequence(input: {
  readonly cdp: CdpClient;
  readonly db: ReturnType<typeof openMigratedDatabase>["db"];
  readonly env: Readonly<Record<string, string>>;
  readonly foreignServeBefore: ServeStatusFingerprint;
  readonly manager: TailscaleServeManager;
  readonly origin: string;
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

  const lock = await input.cdp.evaluate<{
    readonly bootstrap: number;
    readonly lock: number;
    readonly locked: boolean;
    readonly protectedRead: number;
    readonly unlock: number;
  }>(physicalLockExpression);
  requireCondition(
    lock.bootstrap === 200 &&
      lock.lock === 200 &&
      lock.locked &&
      lock.protectedRead === 200 &&
      lock.unlock === 403,
    "Physical writer lock or remote-unlock denial failed."
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

  requireCondition(
    await input.cdp.evaluate<boolean>(startPhysicalSseExpression),
    "Physical Chrome did not start its authenticated EventSource."
  );
  await waitFor(
    async () => {
      const state = await readPhysicalSseState(input.cdp);
      return (
        state.events >= 1 &&
        state.heartbeats >= 1 &&
        !state.streamFailure &&
        input.sseRuntime.active === 1 &&
        input.sseRuntime.maxActive >= 2
      );
    },
    defaultResourceBudget.sse_heartbeat_interval_ms + 20_000,
    "Physical EventSource did not receive one event and transport heartbeat."
  );
  const beforeAwaySse = await readPhysicalSseState(input.cdp);
  await renderPhysicalState(input.cdp, {
    detail: "Writer authority, protected reads, and live updates are ready.",
    state: "paired_ready",
    title: "Paired and ready"
  });
  await capturePhysicalScreenshot(
    input.cdp,
    join(input.screenshotDirectory, "01-paired-ready.png")
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
    async () => {
      const state = await readPhysicalSseState(input.cdp);
      return input.sseRuntime.active === 0 && state.errors >= 1;
    },
    15_000,
    "Profile-away did not close the active physical EventSource."
  );
  const awayRead = await input.cdp.evaluate<number>(unavailableReadExpression);
  requireCondition(
    awayRead !== 200,
    "Android Chrome accepted protected data while the HostDeck profile was away."
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
  await renderPhysicalState(input.cdp, {
    detail: "Private phone access is closed. Laptop-local control remains available.",
    state: "profile_away",
    title: "Saved profile away"
  });
  await capturePhysicalScreenshot(
    input.cdp,
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
    async () => {
      const state = await readPhysicalSseState(input.cdp);
      return (
        state.events > beforeAwaySse.events &&
        state.readyState === 1 &&
        input.sseRuntime.active === 1
      );
    },
    30_000,
    "Physical EventSource did not reconnect after profile return."
  );
  requireCondition(
    (await input.cdp.evaluate<number>(protectedReadExpression)) === 200,
    "Profile return did not preserve the paired device cookie."
  );
  requireCondition(
    input.manager.snapshot().command_attempts === managerAttemptsBeforeSwitch &&
      input.requestInspection.claimRequests === 1,
    "Profile return repaired Serve state or re-paired the device."
  );
  await renderPhysicalState(input.cdp, {
    detail: "Private access and live updates recovered without another pairing.",
    state: "recovered",
    title: "Connection recovered"
  });
  await capturePhysicalScreenshot(
    input.cdp,
    join(input.screenshotDirectory, "03-recovered.png")
  );

  const revoked = await input.cdp.evaluate<{
    readonly access: number;
    readonly bootstrap: number;
    readonly csrfAfter: number;
    readonly protectedAfter: number;
    readonly revoke: number;
  }>(physicalSelfRevokeExpression);
  requireCondition(
    revoked.bootstrap === 200 &&
      revoked.access === 200 &&
      revoked.revoke === 200 &&
      revoked.protectedAfter === 401 &&
      revoked.csrfAfter === 401,
    "Physical writer self-revocation did not close subsequent authority."
  );
  await waitFor(
    () => input.sseRuntime.active === 0,
    15_000,
    "Self-revocation did not close the active physical EventSource."
  );
  requireCondition(
    input.requestInspection.revokeRequests === 1 &&
      input.requestInspection.deletionCookieObserved &&
      countMatchingRows(
        input.db,
        "auth_devices",
        "revoked_at IS NOT NULL"
      ) === 1 &&
      input.manager.snapshot().command_attempts === managerAttemptsBeforeSwitch,
    "Physical self-revocation truth or cookie deletion was incomplete."
  );
  assertRemoteCliResult(
    await runRemoteStatusWhenLifecycleIdle(input.remote, input.env),
    "ready"
  );
  await input.cdp.evaluate<boolean>(closePhysicalSseExpression);
  const finalSse = await readPhysicalSseState(input.cdp);
  return Object.freeze({
    foreignServeUnchanged: true,
    lockPassed: true,
    managerAttemptsBeforeDisable: managerAttemptsBeforeSwitch,
    managerAttemptsDuringSwitch: 0,
    profileAwayClosedAuthority: true,
    profileReturnRecovered: true,
    protectedReads: 4,
    remoteUnlockDenied: true,
    selfRevoked: true,
    sseEvents: finalSse.events,
    sseHeartbeats: finalSse.heartbeats
  });
}

const physicalLockExpression = `(async()=>{
  const base={credentials:'include',cache:'no-store',referrerPolicy:'no-referrer'};
  const bootstrap=await fetch('/api/v1/access/csrf',{...base,method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operation_id:'op_physical_lock_csrf_0001'})});
  if(!bootstrap.ok)return{bootstrap:bootstrap.status,lock:0,locked:false,protectedRead:0,unlock:0};
  const secret=await bootstrap.json();
  const headers={'content-type':'application/json','x-hostdeck-csrf':secret.csrf_token,'x-hostdeck-csrf-generation':String(secret.csrf_generation)};
  const lock=await fetch('/api/v1/access/lock',{...base,method:'POST',headers,body:JSON.stringify({operation_id:'op_physical_host_lock_0001',confirmed:true})});
  const body=lock.ok?await lock.json():null;
  const protectedRead=await fetch('/__physical/protected',base);
  const unlock=await fetch('/api/v1/access/unlock',{...base,method:'POST',headers,body:JSON.stringify({operation_id:'op_physical_remote_unlock_0001',confirmed:true})});
  return{bootstrap:bootstrap.status,lock:lock.status,locked:body?.locked===true,protectedRead:protectedRead.status,unlock:unlock.status};
})()`;

const startPhysicalSseExpression = `(()=>{
  window.__hostDeckPhysicalEventSource?.close();
  window.__hostDeckPhysicalHeartbeatAbort?.abort();
  const state={errors:0,events:0,heartbeats:0,readyState:0,streamFailure:false};
  const source=new EventSource('/__physical/events',{withCredentials:true});
  window.__hostDeckPhysicalSse=state;
  window.__hostDeckPhysicalEventSource=source;
  source.onopen=()=>{state.readyState=source.readyState};
  source.onmessage=()=>{state.events+=1;state.readyState=source.readyState};
  source.onerror=()=>{state.errors+=1;state.readyState=source.readyState};
  const controller=new AbortController();
  window.__hostDeckPhysicalHeartbeatAbort=controller;
  fetch('/__physical/events',{credentials:'include',cache:'no-store',headers:{accept:'text/event-stream'},referrerPolicy:'no-referrer',signal:controller.signal}).then(async(response)=>{
    if(!response.ok||response.body===null){state.streamFailure=true;return;}
    const reader=response.body.getReader();
    const decoder=new TextDecoder();
    let retained='';
    while(true){
      const next=await reader.read();
      if(next.done)break;
      retained=(retained+decoder.decode(next.value,{stream:true})).slice(-4096);
      if(retained.includes(': heartbeat')){state.heartbeats+=1;controller.abort();return;}
    }
    state.streamFailure=state.heartbeats===0;
  }).catch(()=>{if(state.heartbeats===0)state.streamFailure=true});
  return true;
})()`;

const unavailableReadExpression =
  "fetch('/__physical/protected',{credentials:'include',cache:'no-store',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(5000)}).then((response)=>response.status).catch(()=>-1)";

const physicalSelfRevokeExpression = `(async()=>{
  const base={credentials:'include',cache:'no-store',referrerPolicy:'no-referrer'};
  const bootstrap=await fetch('/api/v1/access/csrf',{...base,method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operation_id:'op_physical_revoke_csrf_0001'})});
  if(!bootstrap.ok)return{bootstrap:bootstrap.status,access:0,revoke:0,protectedAfter:0,csrfAfter:0};
  const secret=await bootstrap.json();
  const access=await fetch('/api/v1/access',base);
  if(!access.ok)return{bootstrap:bootstrap.status,access:access.status,revoke:0,protectedAfter:0,csrfAfter:0};
  const authority=await access.json();
  const headers={'content-type':'application/json','x-hostdeck-csrf':secret.csrf_token,'x-hostdeck-csrf-generation':String(secret.csrf_generation)};
  const revoke=await fetch('/api/v1/access/devices/'+encodeURIComponent(authority.device_id)+'/revoke',{...base,method:'POST',headers,body:JSON.stringify({operation_id:'op_physical_self_revoke_0001',confirmed:true})});
  const protectedAfter=await fetch('/__physical/protected',base);
  const csrfAfter=await fetch('/api/v1/access/csrf',{...base,method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operation_id:'op_physical_revoked_csrf_0001'})});
  return{bootstrap:bootstrap.status,access:access.status,revoke:revoke.status,protectedAfter:protectedAfter.status,csrfAfter:csrfAfter.status};
})()`;

const closePhysicalSseExpression = `(()=>{
  window.__hostDeckPhysicalEventSource?.close();
  window.__hostDeckPhysicalHeartbeatAbort?.abort();
  return true;
})()`;

function readPhysicalSseState(cdp: CdpClient): Promise<{
  readonly errors: number;
  readonly events: number;
  readonly heartbeats: number;
  readonly readyState: number;
  readonly streamFailure: boolean;
}> {
  return cdp.evaluate(`(()=>{
    const state=window.__hostDeckPhysicalSse??{};
    return{
      errors:Number.isSafeInteger(state.errors)?state.errors:0,
      events:Number.isSafeInteger(state.events)?state.events:0,
      heartbeats:Number.isSafeInteger(state.heartbeats)?state.heartbeats:0,
      readyState:Number.isSafeInteger(state.readyState)?state.readyState:-1,
      streamFailure:state.streamFailure===true
    };
  })()`);
}

async function postLocalUnlock(
  env: Readonly<Record<string, string>>
): Promise<Readonly<{ locked: boolean | null; status: number }>> {
  const baseUrl = env.HOSTDECK_API_BASE_URL;
  requireCondition(
    typeof baseUrl === "string",
    "Physical local-admin base URL was unavailable."
  );
  const response = await fetch(new URL("/api/v1/access/unlock", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [hostDeckLocalAdminRequestHeaderName]:
        hostDeckLocalAdminRequestHeaderValue
    },
    body: JSON.stringify({
      operation_id: "op_physical_local_unlock_0001",
      confirmed: true
    }),
    signal: AbortSignal.timeout(10_000)
  });
  const body = (await response.json()) as unknown;
  return Object.freeze({
    locked:
      body !== null &&
      typeof body === "object" &&
      typeof (body as Record<string, unknown>).locked === "boolean"
        ? ((body as Record<string, unknown>).locked as boolean)
        : null,
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

async function renderPhysicalState(
  cdp: CdpClient,
  state: Readonly<{ detail: string; state: string; title: string }>
): Promise<void> {
  requireCondition(
    /^[a-z_]{1,32}$/u.test(state.state) &&
      state.title.length <= 64 &&
      state.detail.length <= 120,
    "Physical screenshot state was invalid."
  );
  const candidate = JSON.stringify(state);
  requireCondition(
    [...deviceForbiddenValues].every((value) => !candidate.includes(value)),
    "Physical screenshot state contained a protected value."
  );
  await cdp.evaluate(`(()=>{
    const value=${candidate};
    document.documentElement.dataset.acceptanceState=value.state;
    document.querySelector('#status').textContent=value.title;
    document.querySelector('#detail').textContent=value.detail;
    return true;
  })()`);
}

async function capturePhysicalScreenshot(
  cdp: CdpClient,
  path: string
): Promise<void> {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 2,
    height: 844,
    mobile: true,
    width: 390
  });
  const result = (await cdp.send("Page.captureScreenshot", {
    captureBeyondViewport: false,
    format: "png",
    fromSurface: true
  })) as { readonly data?: unknown };
  requireCondition(
    typeof result.data === "string" &&
      /^[A-Za-z0-9+/=]+$/u.test(result.data),
    "Physical screenshot capture was invalid."
  );
  const bytes = Buffer.from(result.data, "base64");
  requireCondition(
    bytes.length >= 1_024 &&
      bytes.length <= 4 * 1024 * 1024 &&
      bytes.subarray(0, 8).equals(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
      ),
    "Physical screenshot bytes were invalid."
  );
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
}

function readPhoneSnapshot(cdp: CdpClient): Promise<PhoneSnapshot> {
  return cdp.evaluate(`(async()=>{
    const summary=window.__hostDeckPhysicalPairing??{};
    return {
      cacheCount:(await caches.keys()).length,
      cookieLength:document.cookie.length,
      csrfGeneration:Number.isSafeInteger(summary.csrf_generation)?summary.csrf_generation:null,
      domHasPairFragment:document.body.innerText.includes('#pair='),
      hash:location.hash,
      indexedDbCount:(await indexedDB.databases()).length,
      localStorageCount:localStorage.length,
      pathname:location.pathname,
      permission:typeof summary.permission==='string'?summary.permission:null,
      referrerHasPairFragment:document.referrer.includes('#pair='),
      resourceHasPairFragment:performance.getEntriesByType('resource').some((entry)=>entry.name.includes('#pair=')),
      search:location.search,
      serviceWorkerCount:(await navigator.serviceWorker.getRegistrations()).length,
      sessionStorageCount:sessionStorage.length,
      state:typeof summary.state==='string'?summary.state:'missing',
      summaryKeys:Object.keys(summary).sort()
    };
  })()`);
}

function assertPairedPhoneSnapshot(snapshot: PhoneSnapshot): void {
  requireCondition(
    snapshot.state === "paired" &&
      snapshot.permission === "write" &&
      Number.isSafeInteger(snapshot.csrfGeneration) &&
      (snapshot.csrfGeneration as number) > 0 &&
      snapshot.hash === "" &&
      snapshot.pathname === "/" &&
      snapshot.search === "" &&
      snapshot.cookieLength === 0 &&
      snapshot.localStorageCount === 0 &&
      snapshot.sessionStorageCount === 0 &&
      snapshot.indexedDbCount === 0 &&
      snapshot.cacheCount === 0 &&
      snapshot.serviceWorkerCount === 0 &&
      !snapshot.domHasPairFragment &&
      !snapshot.referrerHasPairFragment &&
      !snapshot.resourceHasPairFragment &&
      snapshot.summaryKeys.join(",") === "csrf_generation,permission,state",
    "Physical paired Chrome state violated the fragment/privacy contract."
  );
}

function assertReloadedPhoneSnapshot(snapshot: PhoneSnapshot): void {
  requireCondition(
    snapshot.state === "no_fragment" &&
      snapshot.permission === null &&
      snapshot.csrfGeneration === null &&
      snapshot.hash === "" &&
      snapshot.search === "" &&
      snapshot.cookieLength === 0 &&
      snapshot.localStorageCount === 0 &&
      snapshot.sessionStorageCount === 0 &&
      snapshot.indexedDbCount === 0 &&
      snapshot.cacheCount === 0 &&
      snapshot.serviceWorkerCount === 0 &&
      !snapshot.domHasPairFragment &&
      !snapshot.referrerHasPairFragment &&
      !snapshot.resourceHasPairFragment,
    "Physical Chrome reload violated the no-fragment contract."
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
      inspection.fragmentLeaks === 0 &&
      inspection.hardenedCookieObserved,
    "Physical pairing runtime truth was inconsistent " +
      `(devices=${devices};used=${usedCodes};claims=${inspection.claimRequests};` +
      `csrf=${inspection.csrfRequests};no_referrer=${inspection.noReferrerApiRequests};` +
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
