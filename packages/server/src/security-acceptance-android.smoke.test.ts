import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { createServer as createTcpServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkServerIdentity } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSecurityAcceptanceHarness,
  type SecurityAcceptanceHarness
} from "./security-acceptance-harness.js";

const requireAndroidAcceptance =
  process.env.HOSTDECK_REQUIRE_ANDROID_SECURITY_ACCEPTANCE === "1";
const evidencePath =
  process.env.HOSTDECK_ANDROID_SECURITY_EVIDENCE_PATH ??
  "/tmp/hostdeck-ifc-v1-033-android-evidence.json";
const publicCertificateName = "HostDeck-Local-CA.cer";
const deviceCertificatePath = `/sdcard/Download/${publicCertificateName}`;
const driverTitle = "HostDeck Security Acceptance";
const overallTimeoutMs = 15 * 60_000;
const temporaryDirectories: string[] = [];
const openedHarnesses: SecurityAcceptanceHarness[] = [];
const openedServers: Server[] = [];
const openedDialogs: ChildProcess[] = [];
const adbForwards: number[] = [];
const cdpClients: CdpClient[] = [];

describe("Android security acceptance ADB discovery", () => {
  it.each([
    [
      "tab-separated output",
      "List of devices attached\n8c98bb96\tdevice product:haotian\n"
    ],
    [
      "space-aligned output",
      "List of devices attached\n8c98bb96               device product:haotian\n"
    ]
  ])("accepts exactly one authorized device from %s", (_name, output) => {
    expect(hasExactlyOneAuthorizedAdbDevice(output)).toBe(true);
  });

  it.each([
    ["no device", "List of devices attached\n\n"],
    [
      "unauthorized device",
      "List of devices attached\n8c98bb96 unauthorized usb:4-1\n"
    ],
    ["offline device", "List of devices attached\n8c98bb96 offline usb:4-1\n"],
    [
      "multiple devices",
      "List of devices attached\n8c98bb96 device usb:4-1\nemulator-5554 device\n"
    ],
    ["missing header", "8c98bb96 device usb:4-1\n"],
    ["malformed row", "List of devices attached\n8c98bb96\n"]
  ])("rejects %s", (_name, output) => {
    expect(hasExactlyOneAuthorizedAdbDevice(output)).toBe(false);
  });
});

afterEach(async () => {
  for (const dialog of openedDialogs.splice(0).reverse()) dialog.kill("SIGTERM");
  for (const client of cdpClients.splice(0).reverse()) client.close();
  for (const port of adbForwards.splice(0).reverse()) {
    try {
      adb(["forward", "--remove", `tcp:${port}`]);
    } catch {
      // Cleanup continues through every owned resource.
    }
  }
  try {
    adb(["shell", "rm", "-f", deviceCertificatePath]);
  } catch {
    // The device may have disconnected after evidence capture.
  }
  for (const server of openedServers.splice(0).reverse()) {
    await closeServer(server);
  }
  for (const harness of openedHarnesses.splice(0).reverse()) {
    await harness.close();
  }
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe.skipIf(!requireAndroidAcceptance)(
  "IFC-V1-033 physical Android browser security acceptance",
  () => {
    it(
      "proves pairing, reload, cross-origin, lock, SSE revoke, privacy, and cleanup on Chrome",
      async () => {
        const metadata = readAndroidMetadata();
        const network = selectPhoneAndHostAddresses();
        expect(
          adb(["shell", "ping", "-c", "1", "-W", "2", network.hostIp])
        ).toMatch(/1 packets transmitted, 1 (?:packets )?received/iu);
        rmSync(evidencePath, { force: true });

        const rootDirectory = mkdtempSync(
          join(tmpdir(), "hostdeck-ifc-v1-033-android-")
        );
        temporaryDirectories.push(rootDirectory);
        const bindPort = await reservePort(network.hostIp);
        const harness = await createSecurityAcceptanceHarness({
          bindHost: network.hostIp,
          bindPort,
          initialNow: new Date(),
          rootDirectory
        });
        openedHarnesses.push(harness);
        const commit = git(["rev-parse", "HEAD"]).trim();
        const driverUrl = `${harness.driverUrl}?run=${commit.slice(0, 12)}-${Date.now()}`;
        await verifyPhysicalDriverPreflight(harness, driverUrl);
        const certificatePath = join(rootDirectory, publicCertificateName);
        writeFileSync(certificatePath, harness.enrollment.certificate_der, {
          mode: 0o600
        });
        adb(["push", certificatePath, deviceCertificatePath]);
        const deviceCertificateHash = adb([
          "shell",
          "sha256sum",
          deviceCertificatePath
        ])
          .trim()
          .split(/\s+/u)[0];
        expect(deviceCertificateHash).toBe(
          normalizeFingerprint(harness.enrollment.fingerprint_sha256)
        );

        adb(["shell", "am", "start", "-a", "android.settings.SECURITY_SETTINGS"]);
        await showBlockingDialog(
          "Install the CA certificate on the connected phone from Downloads/" +
            publicCertificateName +
            ". Android requires Settings > Security & privacy > More security & privacy > Encryption & credentials > Install a certificate > CA certificate. HyperOS may label the first step Fingerprints, face data & screen lock. Confirm the Android warning, and close this dialog only after installation.\n\n" +
            "Expected SHA-256 fingerprint:\n" +
            harness.enrollment.fingerprint_sha256 +
            "\n\nDo not screenshot this workflow.",
          "HostDeck phone trust"
        );

        launchColdChrome(driverUrl);
        const forwardPort = createChromeForward();
        const target = await waitForChromeTarget(
          forwardPort,
          (candidate) => candidate.url.startsWith(harness.driverUrl),
          30_000
        );
        const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
        cdpClients.push(cdp);
        await cdp.send("Runtime.enable");
        await cdp.send("Page.enable");
        await waitForDriver(cdp);

        const unpairedRead = await cdp.evaluate<number>(
          "fetch('/__acceptance/v1/read',{credentials:'include',cache:'no-store'}).then((response)=>response.status)"
        );
        expect(unpairedRead).toBe(401);
        expect(await cdp.evaluate<number>("window.__hostDeckAcceptance.refresh()"))
          .toBe(200);
        expect(
          await cdp.evaluate<string>("document.querySelector('#status').textContent")
        ).toContain("unpaired");

        await cdp.send("Page.navigate", {
          url: `http://${network.hostIp}:${bindPort}/?plaintext=${Date.now()}`
        });
        await waitFor(
          async () =>
            (await cdp.evaluate<string>("typeof window.__hostDeckAcceptance")) ===
            "undefined",
          20_000,
          "Chrome loaded the HostDeck driver over plaintext."
        );
        expect(harness.snapshot().sentinel_write_dispatches).toBe(0);
        await cdp.send("Page.navigate", { url: driverUrl });
        await waitForDriver(cdp);

        let pairingCode: string | null = await issuePhysicalPairingCode(harness);
        const pairingDialog = showNonBlockingDialog(
          "Type the following one-time code directly into the HostDeck page on the phone, tap Pair writer, then leave the phone on that page.\n\n" +
            pairingCode +
            "\n\nDo not copy it through ADB and do not screenshot it.",
          "HostDeck pairing"
        );
        await waitFor(
          () => harness.snapshot().pairing_claim_successes === 1,
          5 * 60_000,
          "Physical pairing did not complete."
        );
        pairingDialog.kill("SIGTERM");
        const pairingDialogIndex = openedDialogs.indexOf(pairingDialog);
        if (pairingDialogIndex >= 0) openedDialogs.splice(pairingDialogIndex, 1);
        pairingCode = null;
        expect(pairingCode).toBeNull();

        const operationIds = new Set<string>();
        const pairedSnapshot = await waitForDriverSnapshot(cdp, (snapshot) =>
          snapshot.deviceId !== null
        );
        collectOperationIds(operationIds, pairedSnapshot);
        expect(harness.snapshot()).toMatchObject({
          cookie_response_observations: 1,
          pairing_cookie_metadata_observed: true
        });
        const browserPrivacy = await inspectBrowserPrivacy(cdp);
        expect(browserPrivacy).toEqual({
          cacheCount: 0,
          cookieVisibleToScript: false,
          indexedDbCount: 0,
          inputEmpty: true,
          localStorageCount: 0,
          serviceWorkerCount: 0,
          sessionStorageCount: 0,
          urlContainsCredential: false
        });

        await cdp.send("Page.reload", { ignoreCache: true });
        await waitForDriver(cdp);
        const reloadedBeforeBootstrap = await driverSnapshot(cdp);
        expect(reloadedBeforeBootstrap.csrfGeneration).toBeNull();
        expect(await cdp.evaluate<number>("window.__hostDeckAcceptance.bootstrap()"))
          .toBe(200);
        const reloadedAfterBootstrap = await driverSnapshot(cdp);
        expect(reloadedAfterBootstrap.csrfGeneration).toBeGreaterThan(0);
        collectOperationIds(operationIds, reloadedAfterBootstrap);
        expect(await cdp.evaluate<number>("window.__hostDeckAcceptance.stale()"))
          .toBe(403);
        collectOperationIds(operationIds, await driverSnapshot(cdp));
        expect(harness.snapshot().sentinel_write_dispatches).toBe(0);

        const foreignPort = await reservePort(network.hostIp);
        const foreignServer = await startForeignOriginServer(harness, foreignPort);
        openedServers.push(foreignServer);
        await cdp.send("Page.navigate", {
          url: `https://${network.hostIp}:${foreignPort}/?run=${Date.now()}`
        });
        await waitFor(
          async () =>
            (await cdp.evaluate<string>("document.title")) ===
            "HostDeck foreign origin blocked",
          20_000,
          "Foreign-origin credentialed fetch was not blocked."
        );
        expect(harness.snapshot().sentinel_write_dispatches).toBe(0);
        await closeServer(foreignServer);
        const foreignServerIndex = openedServers.indexOf(foreignServer);
        if (foreignServerIndex >= 0) openedServers.splice(foreignServerIndex, 1);

        await cdp.send("Page.navigate", {
          url: `${harness.driverUrl}?run=return-${Date.now()}`
        });
        await waitForDriver(cdp);
        expect(await cdp.evaluate<number>("window.__hostDeckAcceptance.refresh()"))
          .toBe(200);
        expect(await cdp.evaluate<number>("window.__hostDeckAcceptance.bootstrap()"))
          .toBe(200);
        expect(await cdp.evaluate<number>("window.__hostDeckAcceptance.write()"))
          .toBe(200);
        expect(harness.snapshot().sentinel_write_dispatches).toBe(1);
        expect(await cdp.evaluate<number>("window.__hostDeckAcceptance.lock()"))
          .toBe(200);
        expect(await cdp.evaluate<number>("window.__hostDeckAcceptance.write()"))
          .toBe(423);
        expect(harness.snapshot().sentinel_write_dispatches).toBe(1);
        expect(
          await localAdminJson(harness, "/api/v1/access/unlock", {
            operation_id: "op_physical_local_unlock_0001",
            confirmed: true
          })
        ).toBe(200);
        expect(await cdp.evaluate<number>("window.__hostDeckAcceptance.write()"))
          .toBe(200);
        expect(harness.snapshot().sentinel_write_dispatches).toBe(2);

        await cdp.evaluate("window.__hostDeckAcceptance.openSse()");
        await waitFor(
          () => harness.snapshot().active_sse_sources === 1,
          10_000,
          "Physical SSE source did not become active."
        );
        expect(await cdp.evaluate<number>("window.__hostDeckAcceptance.selfRevoke()"))
          .toBe(200);
        await waitFor(
          () => harness.snapshot().active_sse_sources === 0,
          10_000,
          "Physical SSE source remained active after revoke."
        );
        expect(harness.snapshot()).toMatchObject({
          closed_sse_sources: 1,
          cookie_response_observations: 2,
          deletion_cookie_metadata_observed: true
        });
        expect(
          await cdp.evaluate<number>(
            "fetch('/__acceptance/v1/read',{credentials:'include',cache:'no-store'}).then((response)=>response.status)"
          )
        ).toBe(401);
        expect(await cdp.evaluate<number>("window.__hostDeckAcceptance.bootstrap()"))
          .toBe(401);
        expect(await cdp.evaluate<number>("window.__hostDeckAcceptance.write()"))
          .toBe(401);
        const finalSnapshot = await driverSnapshot(cdp);
        collectOperationIds(operationIds, finalSnapshot);
        expect(await inspectBrowserPrivacy(cdp)).toMatchObject({
          cookieVisibleToScript: false,
          localStorageCount: 0,
          sessionStorageCount: 0
        });

        let auditedPhysicalOperations = 0;
        let preAdmissionPhysicalOperations = 0;
        for (const operationId of operationIds) {
          if (!/_(?:pair|csrf|lock|revoke)_/u.test(operationId)) continue;
          const trail = harness.audit.get(operationId);
          if (trail === null) {
            preAdmissionPhysicalOperations += 1;
            continue;
          }
          auditedPhysicalOperations += 1;
          expect(trail).toMatchObject({
            state: "terminal",
            records: [
              { phase: "accepted", outcome: "accepted" },
              { phase: "terminal", outcome: "succeeded" }
            ]
          });
        }
        expect(auditedPhysicalOperations).toBeGreaterThanOrEqual(5);
        expect(preAdmissionPhysicalOperations).toBeGreaterThanOrEqual(1);
        for (const operationId of [
          "op_physical_pair_issue_0001",
          "op_physical_local_unlock_0001"
        ]) {
          expect(harness.audit.require(operationId)).toMatchObject({
            state: "terminal",
            records: [
              { phase: "accepted", outcome: "accepted" },
              { phase: "terminal", outcome: "succeeded" }
            ]
          });
        }
        expect(harness.settings.require().locked).toBe(false);
        expect(harness.internalErrors).toEqual([]);
        const privacy = harness.scanPrivacy();
        expect(privacy.leaks_found).toBe(0);
        expect(privacy.secrets_checked).toBeGreaterThanOrEqual(3);
        expect(await countListeningSockets(bindPort)).toBe(1);
        expect(cdp.consoleCalls).toBe(0);

        adb(["shell", "rm", "-f", deviceCertificatePath]);
        expect(deviceFileExists(deviceCertificatePath)).toBe(false);
        adb(["shell", "am", "start", "-a", "android.settings.SECURITY_SETTINGS"]);
        await showBlockingDialog(
          "Remove the HostDeck Local CA from the phone's user trusted credentials. Match the fingerprint below, then close this dialog only after removal.\n\n" +
            harness.enrollment.fingerprint_sha256,
          "HostDeck phone cleanup"
        );
        launchColdChrome(
          `${harness.driverUrl}?run=trust-removed-${Date.now()}`
        );
        await waitFor(
          async () => {
            const candidates = await readChromeTargets(forwardPort);
            return candidates.some(
              (candidate) =>
                candidate.type === "page" &&
                candidate.title !== driverTitle &&
                (candidate.url.startsWith(harness.driverUrl) ||
                  candidate.url.startsWith("chrome-error://"))
            );
          },
          20_000,
          "Chrome still loaded the trusted HostDeck page after CA cleanup."
        );

        adb(["shell", "am", "force-stop", "com.android.chrome"]);
        cdp.close();
        const cdpIndex = cdpClients.indexOf(cdp);
        if (cdpIndex >= 0) cdpClients.splice(cdpIndex, 1);
        adb(["forward", "--remove", `tcp:${forwardPort}`]);
        const forwardIndex = adbForwards.indexOf(forwardPort);
        if (forwardIndex >= 0) adbForwards.splice(forwardIndex, 1);
        await harness.close();
        const harnessIndex = openedHarnesses.indexOf(harness);
        if (harnessIndex >= 0) openedHarnesses.splice(harnessIndex, 1);
        expect(await countListeningSockets(bindPort)).toBe(0);
        rmSync(rootDirectory, { force: true, recursive: true });
        const rootIndex = temporaryDirectories.indexOf(rootDirectory);
        if (rootIndex >= 0) temporaryDirectories.splice(rootIndex, 1);

        const evidence = {
          schema_version: 1,
          captured_at: new Date().toISOString(),
          commit,
          device: metadata,
          network: {
            host_private_ip: network.hostIp,
            phone_private_ip: network.phoneIp,
            origin: harness.origin
          },
          certificate: {
            fingerprint_sha256: harness.enrollment.fingerprint_sha256,
            public_transfer_hash_matched: true,
            trusted_for_run: true,
            removed_after_run: true
          },
          browser: {
            cold_start: true,
            cache_busting: true,
            console_calls: cdp.consoleCalls,
            credential_requested_over_adb: false,
            screenshots_retained: false
          },
          matrix: {
            unpaired_denial: "pass",
            writer_pairing: "pass",
            reload_csrf_bootstrap: "pass",
            stale_csrf_denial: "pass",
            foreign_origin_denial: "pass",
            physical_plaintext_refusal: "pass",
            lock_and_local_unlock: "pass",
            active_sse_revoke: "pass",
            self_revoke_cookie_deletion: "pass",
            post_revoke_denial: "pass",
            plaintext_refusal: "pass"
          },
          inspection: {
            audited_physical_operation_count: auditedPhysicalOperations,
            operation_count: operationIds.size,
            pre_admission_physical_operation_count:
              preAdmissionPhysicalOperations,
            privacy,
            active_authority_leases: harness.snapshot().active_authority_leases,
            active_sse_sources: harness.snapshot().active_sse_sources,
            listening_socket_count_after_cleanup:
              await countListeningSockets(bindPort)
          },
          cleanup: {
            adb_forward_removed: true,
            browser_test_target_cold_stopped: true,
            public_certificate_file_removed: true,
            temporary_host_state_removed: true
          }
        } as const;
        mkdirSync(dirname(evidencePath), { recursive: true });
        writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
          mode: 0o600
        });
      },
      overallTimeoutMs
    );
  }
);

interface AndroidMetadata {
  readonly android_api: string;
  readonly android_release: string;
  readonly build: string;
  readonly chrome_version: string;
  readonly model: string;
}

interface DriverSnapshot {
  readonly csrfGeneration: number | null;
  readonly deviceId: string | null;
  readonly operationIds: readonly string[];
  readonly sseOpen: boolean;
}

interface ChromeTarget {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly url: string;
  readonly webSocketDebuggerUrl: string;
}

function readAndroidMetadata(): AndroidMetadata {
  if (!hasExactlyOneAuthorizedAdbDevice(adb(["devices", "-l"]))) {
    throw new Error("Physical acceptance requires exactly one authorized ADB device.");
  }
  const chromeDump = adb(["shell", "dumpsys", "package", "com.android.chrome"]);
  const chromeVersion = /^\s*versionName=(\S+)\s*$/mu.exec(chromeDump)?.[1];
  if (chromeVersion === undefined) {
    throw new Error("Physical acceptance could not read the installed Chrome version.");
  }
  return Object.freeze({
    android_api: adb(["shell", "getprop", "ro.build.version.sdk"]).trim(),
    android_release: adb([
      "shell",
      "getprop",
      "ro.build.version.release"
    ]).trim(),
    build: adb(["shell", "getprop", "ro.build.version.incremental"]).trim(),
    chrome_version: chromeVersion,
    model: adb(["shell", "getprop", "ro.product.model"]).trim()
  });
}

function hasExactlyOneAuthorizedAdbDevice(output: string): boolean {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return (
    lines.length === 2 &&
    lines[0] === "List of devices attached" &&
    /^\S+\s+device(?:\s|$)/u.test(lines[1] ?? "")
  );
}

function selectPhoneAndHostAddresses(): {
  readonly hostIp: string;
  readonly phoneIp: string;
} {
  const output = adb(["shell", "ip", "-4", "-o", "addr", "show", "scope", "global"]);
  const phoneAddresses = [
    ...output.matchAll(/^\d+:\s+(\S+)\s+inet\s+([0-9.]+)\/([0-9]+)\b/gmu)
  ]
    .flatMap((match) => {
      const interfaceName = match[1];
      const phoneIp = match[2];
      const prefixLength = Number(match[3]);
      if (
        interfaceName === undefined ||
        phoneIp === undefined ||
        !isPrivateIpv4(phoneIp) ||
        !Number.isInteger(prefixLength) ||
        prefixLength < 1 ||
        prefixLength > 32
      ) {
        return [];
      }
      return [{ interfaceName, phoneIp, prefixLength }];
    })
    .sort((left, right) =>
      Number(right.interfaceName.startsWith("wlan")) -
      Number(left.interfaceName.startsWith("wlan"))
    );
  for (const address of phoneAddresses) {
    let route: string;
    try {
      route = ip(["-4", "route", "get", address.phoneIp]);
    } catch {
      continue;
    }
    const hostIp = /\bsrc\s+([0-9.]+)/u.exec(route)?.[1];
    if (
      hostIp !== undefined &&
      isPrivateIpv4(hostIp) &&
      sameIpv4Subnet(hostIp, address.phoneIp, address.prefixLength)
    ) {
      return Object.freeze({ hostIp, phoneIp: address.phoneIp });
    }
  }
  throw new Error("Physical acceptance could not select a shared private phone/host network.");
}

async function issuePhysicalPairingCode(
  harness: SecurityAcceptanceHarness
): Promise<string> {
  const response = await localAdminExchange(
    harness,
    "/api/v1/access/pairing-codes",
    {
      operation_id: "op_physical_pair_issue_0001",
      permission: "write",
      client_label: "Physical Android Chrome"
    }
  );
  if (response.status !== 200) {
    throw new Error("Physical acceptance could not issue the local pairing code.");
  }
  const parsed = JSON.parse(response.body) as { readonly code?: unknown };
  if (typeof parsed.code !== "string" || !/^[A-Za-z0-9_-]{22}$/u.test(parsed.code)) {
    throw new Error("Physical acceptance received an invalid pairing-code response.");
  }
  return parsed.code;
}

async function localAdminJson(
  harness: SecurityAcceptanceHarness,
  path: string,
  payload: Readonly<Record<string, unknown>>
): Promise<number> {
  return (await localAdminExchange(harness, path, payload)).status;
}

function localAdminExchange(
  harness: SecurityAcceptanceHarness,
  path: string,
  payload: Readonly<Record<string, unknown>>
): Promise<{ readonly body: string; readonly status: number }> {
  const body = JSON.stringify(payload);
  const ca = new X509Certificate(
    Buffer.from(harness.enrollment.certificate_der)
  ).toString();
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        ca,
        checkServerIdentity: (_hostname, certificate) =>
          checkServerIdentity(harness.bindHost, certificate),
        headers: {
          accept: "application/json",
          "content-length": Buffer.byteLength(body),
          "content-type": "application/json",
          host: `${harness.bindHost}:${harness.bindPort}`
        },
        host: harness.bindHost,
        localAddress: "127.0.0.1",
        method: "POST",
        path,
        port: harness.bindPort,
        rejectUnauthorized: true,
        servername: ""
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            status: response.statusCode ?? 0
          });
        });
        response.once("error", reject);
      }
    );
    request.setTimeout(5000, () =>
      request.destroy(new Error("Physical local-admin request timed out."))
    );
    request.once("error", reject);
    request.end(body);
  });
}

function verifyPhysicalDriverPreflight(
  harness: SecurityAcceptanceHarness,
  url: string
): Promise<void> {
  const candidate = new URL(url);
  if (candidate.origin !== harness.origin) {
    throw new Error("Physical driver preflight received a foreign origin.");
  }
  const ca = new X509Certificate(
    Buffer.from(harness.enrollment.certificate_der)
  ).toString();
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        ca,
        checkServerIdentity: (_hostname, certificate) =>
          checkServerIdentity(harness.bindHost, certificate),
        headers: {
          accept: "text/html",
          host: `${harness.bindHost}:${harness.bindPort}`
        },
        host: harness.bindHost,
        localAddress: "127.0.0.1",
        method: "GET",
        path: `${candidate.pathname}${candidate.search}`,
        port: harness.bindPort,
        rejectUnauthorized: true,
        servername: ""
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bodyBytes = 0;
        response.on("data", (chunk: Buffer) => {
          bodyBytes += chunk.byteLength;
          if (bodyBytes > 128 * 1024) {
            response.destroy(
              new Error("Physical driver preflight response exceeded its limit.")
            );
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (
            response.statusCode !== 200 ||
            !body.includes(`<title>${driverTitle}</title>`) ||
            !body.includes("window.__hostDeckAcceptance")
          ) {
            reject(new Error("Physical driver HTTPS preflight failed."));
            return;
          }
          resolve();
        });
        response.once("error", reject);
      }
    );
    request.setTimeout(5000, () =>
      request.destroy(new Error("Physical driver preflight timed out."))
    );
    request.once("error", reject);
    request.end();
  });
}

async function inspectBrowserPrivacy(cdp: CdpClient): Promise<{
  readonly cacheCount: number;
  readonly cookieVisibleToScript: boolean;
  readonly indexedDbCount: number;
  readonly inputEmpty: boolean;
  readonly localStorageCount: number;
  readonly serviceWorkerCount: number;
  readonly sessionStorageCount: number;
  readonly urlContainsCredential: boolean;
}> {
  return cdp.evaluate(`(async()=>({
    cacheCount:(await caches.keys()).length,
    cookieVisibleToScript:document.cookie.length!==0,
    indexedDbCount:(await indexedDB.databases()).length,
    inputEmpty:document.querySelector('#pairing-code').value.length===0,
    localStorageCount:localStorage.length,
    serviceWorkerCount:(await navigator.serviceWorker.getRegistrations()).length,
    sessionStorageCount:sessionStorage.length,
    urlContainsCredential:/[?#&](?:code|token|csrf|cookie)=/iu.test(location.href)
  }))()`);
}

async function startForeignOriginServer(
  harness: SecurityAcceptanceHarness,
  port: number
): Promise<Server> {
  const tls = harness.certificates.loadTls({
    bind_host: harness.bindHost,
    bind_port: harness.bindPort
  }).tls;
  const server = createHttpsServer(
    {
      cert: tls.certificate_chain_pem,
      key: tls.private_key_pem,
      minVersion: "TLSv1.2"
    },
    (_request, response) => {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-security-policy": `default-src 'none'; script-src 'unsafe-inline'; connect-src ${harness.origin}`,
        "content-type": "text/html; charset=utf-8",
        "x-content-type-options": "nosniff"
      });
      response.end(
        `<!doctype html><title>HostDeck foreign origin pending</title><script>` +
          `fetch(${JSON.stringify(`${harness.origin}/__acceptance/v1/read`)},{credentials:'include',cache:'no-store'})` +
          `.then(()=>{document.title='HostDeck foreign origin readable'})` +
          `.catch(()=>{document.title='HostDeck foreign origin blocked'})</script>`
      );
    }
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: harness.bindHost, port }, resolve);
  });
  return server;
}

function launchColdChrome(url: string): void {
  adb(["shell", "am", "force-stop", "com.android.chrome"]);
  adb([
    "shell",
    "am",
    "start",
    "-W",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    url,
    "com.android.chrome"
  ]);
}

function createChromeForward(): number {
  const port = Number(
    adb(["forward", "tcp:0", "localabstract:chrome_devtools_remote"]).trim()
  );
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("ADB returned an invalid Chrome DevTools forward port.");
  }
  adbForwards.push(port);
  return port;
}

async function waitForChromeTarget(
  forwardPort: number,
  predicate: (candidate: ChromeTarget) => boolean,
  timeoutMs: number
): Promise<ChromeTarget> {
  let selected: ChromeTarget | undefined;
  await waitFor(
    async () => {
      const candidates = await readChromeTargets(forwardPort);
      selected = candidates.find(predicate);
      return selected !== undefined;
    },
    timeoutMs,
    "Chrome DevTools target did not become available."
  );
  if (selected === undefined) throw new Error("Chrome target selection failed.");
  return selected;
}

async function readChromeTargets(forwardPort: number): Promise<ChromeTarget[]> {
  try {
    const response = await fetch(`http://127.0.0.1:${forwardPort}/json/list`, {
      signal: AbortSignal.timeout(2000)
    });
    if (!response.ok) return [];
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > 256 * 1024) return [];
    const parsed = JSON.parse(body) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((candidate): ChromeTarget[] => {
      if (
        candidate === null ||
        typeof candidate !== "object" ||
        typeof candidate.id !== "string" ||
        typeof candidate.title !== "string" ||
        typeof candidate.type !== "string" ||
        typeof candidate.url !== "string" ||
        typeof candidate.webSocketDebuggerUrl !== "string"
      ) {
        return [];
      }
      return [candidate as ChromeTarget];
    });
  } catch {
    return [];
  }
}

async function waitForDriver(cdp: CdpClient): Promise<void> {
  try {
    await waitFor(
      async () =>
        (await cdp.evaluate<string>("document.title")) === driverTitle &&
        (await cdp.evaluate<string>("typeof window.__hostDeckAcceptance")) ===
          "object",
      20_000,
      "Trusted HostDeck phone driver did not load."
    );
  } catch {
    throw new Error(
      `Trusted HostDeck phone driver did not load (${await readDriverLoadDiagnostics(cdp)}).`
    );
  }
}

async function readDriverLoadDiagnostics(cdp: CdpClient): Promise<string> {
  let title = "unavailable";
  let securityState = "unavailable";
  let certificateError = "none";
  try {
    title = diagnosticToken(await cdp.evaluate<string>("document.title"));
  } catch {
    // The current error page may not expose an execution context.
  }
  try {
    const visibleState = (await cdp.send(
      "Security.getVisibleSecurityState"
    )) as {
      readonly certificateSecurityState?: {
        readonly certificateNetworkError?: unknown;
      };
      readonly securityState?: unknown;
    };
    securityState = diagnosticToken(visibleState.securityState);
    const networkError =
      visibleState.certificateSecurityState?.certificateNetworkError;
    if (networkError !== undefined) {
      certificateError = diagnosticToken(networkError);
    }
  } catch {
    // The diagnostic remains explicitly unavailable on unsupported Chrome builds.
  }
  return `title=${title}, security=${securityState}, certificate=${certificateError}`;
}

function diagnosticToken(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_:. -]{1,96}$/u.test(value)
    ? value
    : "unavailable";
}

function driverSnapshot(cdp: CdpClient): Promise<DriverSnapshot> {
  return cdp.evaluate<DriverSnapshot>("window.__hostDeckAcceptance.snapshot()");
}

async function waitForDriverSnapshot(
  cdp: CdpClient,
  predicate: (snapshot: DriverSnapshot) => boolean
): Promise<DriverSnapshot> {
  let selected: DriverSnapshot | undefined;
  await waitFor(
    async () => {
      selected = await driverSnapshot(cdp);
      return predicate(selected);
    },
    20_000,
    "Phone driver state did not reach the expected condition."
  );
  if (selected === undefined) throw new Error("Phone driver snapshot is unavailable.");
  return selected;
}

function collectOperationIds(
  target: Set<string>,
  snapshot: DriverSnapshot
): void {
  for (const operationId of snapshot.operationIds) {
    if (!/^op_[a-z0-9][a-z0-9_-]{7,95}$/u.test(operationId)) {
      throw new Error("Phone driver returned an invalid operation id.");
    }
    target.add(operationId);
  }
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
  #nextId = 0;
  consoleCalls = 0;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let message: CdpMessage;
      try {
        message = JSON.parse(event.data) as CdpMessage;
      } catch {
        return;
      }
      if (message.method === "Runtime.consoleAPICalled") {
        this.consoleCalls += 1;
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

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Chrome DevTools connection timed out.")),
        5000
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
    return new CdpClient(socket);
  }

  send(method: string, params: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
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

  async evaluate<T = unknown>(expression: string): Promise<T> {
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

interface CdpMessage {
  readonly error?: unknown;
  readonly id?: number;
  readonly method?: string;
  readonly result?: unknown;
}

function showNonBlockingDialog(text: string, title: string): ChildProcess {
  const dialog = spawn(
    "zenity",
    ["--text-info", `--title=${title}`, "--width=520", "--height=360"],
    { stdio: ["pipe", "ignore", "ignore"] }
  );
  openedDialogs.push(dialog);
  dialog.stdin?.end(text);
  return dialog;
}

async function showBlockingDialog(text: string, title: string): Promise<void> {
  const dialog = showNonBlockingDialog(text, title);
  await new Promise<void>((resolve, reject) => {
    dialog.once("error", () => reject(new Error("Desktop acceptance dialog failed.")));
    dialog.once("exit", () => resolve());
  });
  const index = openedDialogs.indexOf(dialog);
  if (index >= 0) openedDialogs.splice(index, 1);
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  failureMessage: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch {
      // Navigation and process restart can transiently replace the CDP execution context.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(failureMessage);
}

function reservePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.once("error", reject);
    server.listen({ host, port: 0 }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Physical acceptance port reservation failed."));
        return;
      }
      server.close((error) =>
        error === undefined ? resolve(address.port) : reject(error)
      );
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function countListeningSockets(port: number): Promise<number> {
  const output = execFileSync(
    "ss",
    ["-H", "-ltn", "sport", "=", `:${port}`],
    commandOptions()
  );
  return output.split("\n").filter((line) => line.trim().length > 0).length;
}

function isPrivateIpv4(candidate: string): boolean {
  const octets = candidate.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  const first = octets[0];
  const second = octets[1];
  return (
    first === 10 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function sameIpv4Subnet(
  left: string,
  right: string,
  prefixLength: number
): boolean {
  const leftValue = ipv4Integer(left);
  const rightValue = ipv4Integer(right);
  if (leftValue === null || rightValue === null) return false;
  const mask = prefixLength === 32 ? 0xffff_ffff : (0xffff_ffff << (32 - prefixLength)) >>> 0;
  return (leftValue & mask) === (rightValue & mask);
}

function ipv4Integer(candidate: string): number | null {
  const octets = candidate.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return null;
  }
  return octets.reduce((value, octet) => ((value << 8) | octet) >>> 0, 0);
}

function normalizeFingerprint(value: string): string {
  return value.replaceAll(":", "").toLowerCase();
}

function deviceFileExists(path: string): boolean {
  try {
    adb(["shell", "ls", path]);
    return true;
  } catch {
    return false;
  }
}

function adb(args: readonly string[]): string {
  return execFileSync("adb", [...args], commandOptions());
}

function git(args: readonly string[]): string {
  return execFileSync("git", [...args], commandOptions());
}

function ip(args: readonly string[]): string {
  return execFileSync("ip", [...args], commandOptions());
}

function commandOptions(): {
  readonly encoding: "utf8";
  readonly maxBuffer: number;
  readonly timeout: number;
} {
  return { encoding: "utf8", maxBuffer: 512 * 1024, timeout: 15_000 };
}
