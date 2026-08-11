import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import { release as osRelease } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  win32
} from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  verifyWindowsCodexSpikeEvidenceFile,
  windowsCodexSpikeRuntimePolicy,
  writeWindowsCodexSpikeEvidence
} from "./windows-codex-spike-evidence.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = realpathSync(resolve(scriptDirectory, ".."));
const requireFromAdapter = createRequire(
  join(repositoryRoot, "packages", "codex-adapter", "package.json")
);
const requireFromRoot = createRequire(join(repositoryRoot, "package.json"));
const WebSocket = requireFromAdapter("ws");
const ansiEscapePattern = new RegExp(
  `${String.fromCharCode(27)}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${String.fromCharCode(7)}]*(?:${String.fromCharCode(7)}|${String.fromCharCode(27)}\\\\))`,
  "gu"
);
const fakeApiCredential = "hostdeck-ci-fixture-not-a-key";
const resumeCredentialEnvironment = "HOSTDECK_CODEX_REMOTE_AUTH";
const maximumCaptureBytes = 128 * 1024;
const requestTimeoutMs = 10_000;

async function main() {
  const outputPath = parseArguments(process.argv.slice(2));
  requireCondition(realpathSync(process.cwd()) === repositoryRoot, "Spike must run from the repository root.");
  requireCondition(
    process.platform === "win32" && process.arch === "x64",
    "Windows Codex transport spike requires native Windows x64."
  );
  requireCondition(process.versions.node === "22.22.2", "Spike Node version is invalid.");
  requireCondition(
    process.env.HOSTDECK_NATIVE_RUNNER_LABEL === "windows-2022",
    "Spike runner label is invalid."
  );
  const runnerTemp = requiredAbsoluteDirectory(process.env.RUNNER_TEMP, "RUNNER_TEMP");
  requireInside(outputPath, runnerTemp, "Spike output must stay inside RUNNER_TEMP.");

  const runtime = inspectExactCodexRuntime();
  const root = mkdtempSync(join(runnerTemp, "hostdeck-windows-codex-spike-"));
  const captures = [];
  let appServer = null;
  let firstClient = null;
  let secondClient = null;
  let resumeProbe = null;
  let listenerPort = null;
  let processExited = false;
  let listenerClosed = false;
  let credentialFileRemoved = false;
  let forbiddenCredentials = [];
  let primaryError = null;
  const cleanupErrors = [];
  let observations = null;

  try {
    secureCurrentUserOnly(root, "directory");
    const codexHome = join(root, "codex-home");
    const project = join(root, "hostdeck-spike-project");
    mkdirSync(codexHome);
    mkdirSync(project);
    const websocketCredentialPath = join(root, "websocket-credential");
    const websocketCredential = randomBytes(48).toString("base64url");
    forbiddenCredentials = [websocketCredential, fakeApiCredential];
    writeFileSync(websocketCredentialPath, `${websocketCredential}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    writeFileSync(
      join(codexHome, "auth.json"),
      `${JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: fakeApiCredential }, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 }
    );
    writeFileSync(
      join(codexHome, "config.toml"),
      [
        "check_for_update_on_startup = false",
        `[projects.${JSON.stringify(project)}]`,
        'trust_level = "trusted"',
        ""
      ].join("\n"),
      { encoding: "utf8", flag: "wx", mode: 0o600 }
    );
    for (const path of [codexHome, project, websocketCredentialPath]) {
      secureCurrentUserOnly(path, lstatSync(path).isDirectory() ? "directory" : "file");
    }
    const credentialAcl = inspectCurrentUserOnlyAcl(websocketCredentialPath);
    requireCondition(credentialAcl, "WebSocket credential ACL is not current-user-only.");

    const environment = codexEnvironment(runtime, codexHome);
    appServer = spawn(
      runtime.executable,
      [
        "app-server",
        "--strict-config",
        "--listen",
        "ws://127.0.0.1:0",
        "--ws-auth",
        "capability-token",
        "--ws-token-file",
        websocketCredentialPath
      ],
      {
        cwd: project,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      }
    );
    const appCapture = captureChild(appServer, "app-server");
    captures.push(appCapture);
    const endpoint = await waitForLoopbackEndpoint(appServer, appCapture);
    listenerPort = endpoint.port;

    const commandLine = inspectProcessCommandLine(appServer.pid);
    captures.push(commandLine);
    requireCondition(commandLine.includes("app-server"), "App-server process command line is incomplete.");
    requireCondition(commandLine.includes("--ws-token-file"), "App-server credential source is missing.");
    requireCondition(!commandLine.includes(websocketCredential), "App-server command line contains credential material.");
    const listeners = await inspectProcessListeners(appServer.pid, listenerPort);
    requireCondition(
      listeners.length === 1 &&
        listeners[0].address === "127.0.0.1" &&
        listeners[0].port === listenerPort,
      "App-server listener is not one exact IPv4 loopback endpoint."
    );

    const missingStatus = await rejectedUpgradeStatus(endpoint.url, {});
    const invalidStatus = await rejectedUpgradeStatus(endpoint.url, {
      Authorization: `Bearer ${randomBytes(48).toString("base64url")}`
    });
    const originStatus = await rejectedUpgradeStatus(endpoint.url, {
      Authorization: `Bearer ${websocketCredential}`,
      Origin: "https://hostdeck.invalid"
    });
    requireCondition(missingStatus === 401, "Missing WebSocket credential was not rejected.");
    requireCondition(invalidStatus === 401, "Invalid WebSocket credential was not rejected.");
    requireCondition(originStatus === 403, "Origin-bearing WebSocket upgrade was not rejected.");

    firstClient = await RpcClient.connect(endpoint.url, websocketCredential, captures);
    secondClient = await RpcClient.connect(endpoint.url, websocketCredential, captures);
    const firstHandshake = await initializeClient(firstClient, codexHome);
    const secondHandshake = await initializeClient(secondClient, codexHome);
    requireCondition(
      firstHandshake.userAgent === secondHandshake.userAgent,
      "Initialized client identities disagree."
    );
    requireCondition(
      firstHandshake.modes.join(",") === "default,plan" &&
        secondHandshake.modes.join(",") === "default,plan",
      "Required collaboration modes are unavailable."
    );

    await firstClient.close();
    firstClient = null;
    await assertModeCatalog(secondClient);
    const started = requireRecord(
      await secondClient.request("thread/start", {
        cwd: project,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        ephemeral: false
      }),
      "thread/start result"
    );
    const startedThread = requireRecord(started.thread, "thread/start thread");
    const threadId = requireUuid(startedThread.id, "thread/start thread id");
    requireCondition(
      requireString(started.cwd, "thread/start cwd").toLowerCase() === project.toLowerCase(),
      "Thread started in the wrong project."
    );
    requireCondition(readTurns(startedThread).length === 0, "No-model thread unexpectedly contains turns.");

    resumeProbe = await startResumeProbe({
      captures,
      codexHome,
      endpoint: endpoint.url,
      environment,
      executable: runtime.executable,
      project,
      threadId,
      websocketCredential
    });
    requireCondition(resumeProbe.rendered, "Windows TUI resume did not render the selected thread.");
    await resumeProbe.close();
    resumeProbe = null;

    const readAfterResume = requireRecord(
      await secondClient.request("thread/read", { threadId, includeTurns: true }),
      "thread/read result"
    );
    const resumedThread = requireRecord(readAfterResume.thread, "thread/read thread");
    const turnCount = readTurns(resumedThread).length;
    requireCondition(turnCount === 0, "TUI resume triggered model work.");
    await assertModeCatalog(secondClient);

    observations = {
      authentication: {
        accepted: true,
        invalid_status: invalidStatus,
        missing_status: missingStatus,
        origin_status: originStatus
      },
      capabilities: {
        collaboration_modes: firstHandshake.modes,
        experimental_api: true
      },
      initialization: {
        client_name: "hostdeck-windows-spike",
        platform_family: firstHandshake.platformFamily,
        platform_os: firstHandshake.platformOs,
        version_corroborated: true
      },
      multi_client: { initialized_clients: 2, survived_peer_close: true },
      process: {
        address: listeners[0].address,
        argv_clean: true,
        credential_acl: "current-user-only",
        listener_count: listeners.length
      },
      resume: {
        credential_via_environment: true,
        rendered_thread: true,
        thread_turn_count: turnCount
      },
      privacy: { capture_scanned: true, credential_value_found: false },
      shutdown: {
        credential_file_removed: true,
        listener_closed: true,
        process_exited: true
      }
    };
  } catch (error) {
    primaryError = error;
  } finally {
    if (resumeProbe !== null) await collectCleanupError(resumeProbe.close(), cleanupErrors);
    if (firstClient !== null) await collectCleanupError(firstClient.close(), cleanupErrors);
    if (secondClient !== null) await collectCleanupError(secondClient.close(), cleanupErrors);
    if (appServer !== null) {
      await collectCleanupError(stopProcess(appServer), cleanupErrors);
      processExited = appServer.exitCode !== null || appServer.signalCode !== null;
    }
    if (listenerPort !== null) {
      try {
        await waitForClosedPort(listenerPort);
        listenerClosed = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      rmSync(root, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 });
      credentialFileRemoved = !existsSync(root);
      if (!credentialFileRemoved) cleanupErrors.push(new Error("Spike temporary root remained after cleanup."));
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (primaryError !== null && cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      "Windows Codex spike and cleanup failed."
    );
  }
  if (primaryError !== null) throw primaryError;
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Windows Codex spike cleanup failed.");
  }
  assertCapturePrivacy(captures, forbiddenCredentials);

  requireCondition(observations !== null, "Spike observations were not completed.");
  requireCondition(processExited, "App-server process did not exit.");
  requireCondition(listenerClosed, "App-server listener remained reachable.");
  requireCondition(credentialFileRemoved, "WebSocket credential file remained after cleanup.");
  observations.shutdown = {
    credential_file_removed: credentialFileRemoved,
    listener_closed: listenerClosed,
    process_exited: processExited
  };
  writeWindowsCodexSpikeEvidence(outputPath, {
    generated_at: new Date().toISOString(),
    workflow: {
      run_attempt: parsePositiveInteger(requiredEnvironment("GITHUB_RUN_ATTEMPT")),
      run_id: requiredEnvironment("GITHUB_RUN_ID")
    },
    source: {
      commit: requiredEnvironment("GITHUB_SHA"),
      lockfile_sha256: sha256File(join(repositoryRoot, "pnpm-lock.yaml"))
    },
    runner: {
      architecture: process.arch,
      image_version: requiredEnvironment("ImageVersion"),
      label: "windows-2022",
      node_platform: process.platform,
      os_release: osRelease()
    },
    runtime: { ...windowsCodexSpikeRuntimePolicy },
    observations
  });
  verifyWindowsCodexSpikeEvidenceFile(outputPath);
  process.stdout.write("Windows Codex 0.144.0 transport spike passed.\n");
}

function inspectExactCodexRuntime() {
  const mainPackagePath = requireFromRoot.resolve("@openai/codex/package.json");
  const mainPackage = parseJsonFile(mainPackagePath, "Codex package manifest");
  requireCondition(mainPackage.name === "@openai/codex", "Codex package name is invalid.");
  requireCondition(mainPackage.version === "0.144.0", "Codex package version is invalid.");
  requireCondition(mainPackage.license === "Apache-2.0", "Codex package license is invalid.");
  const requireFromCodex = createRequire(mainPackagePath);
  const nativePackagePath = requireFromCodex.resolve(
    "@openai/codex-win32-x64/package.json"
  );
  const nativePackage = parseJsonFile(nativePackagePath, "Codex Windows package manifest");
  requireCondition(
    nativePackage.name === "@openai/codex" &&
      nativePackage.version === "0.144.0-win32-x64" &&
      nativePackage.license === "Apache-2.0" &&
      JSON.stringify(nativePackage.os) === '["win32"]' &&
      JSON.stringify(nativePackage.cpu) === '["x64"]',
    "Codex Windows package identity is invalid."
  );
  const nativeRoot = realpathSync(dirname(nativePackagePath));
  const vendorRoot = join(nativeRoot, "vendor", windowsCodexSpikeRuntimePolicy.target);
  const packageLayout = parseJsonFile(
    join(vendorRoot, "codex-package.json"),
    "Codex native layout manifest"
  );
  requireCondition(
    JSON.stringify(packageLayout) ===
      JSON.stringify({
        layoutVersion: 1,
        version: "0.144.0",
        target: windowsCodexSpikeRuntimePolicy.target,
        variant: "codex",
        entrypoint: "bin/codex.exe",
        resourcesDir: "codex-resources",
        pathDir: "codex-path"
      }),
    "Codex native layout is invalid."
  );
  const executable = realpathSync(join(vendorRoot, "bin", "codex.exe"));
  requireInside(executable, nativeRoot, "Codex executable escaped its package root.");
  requireCondition(lstatSync(executable).isFile(), "Codex executable is not a regular file.");
  requireCondition(
    sha256File(executable) === windowsCodexSpikeRuntimePolicy.native_binary_sha256,
    "Codex Windows executable digest is invalid."
  );
  const lock = parseYaml(readFileSync(join(repositoryRoot, "pnpm-lock.yaml"), "utf8"));
  requireCondition(
    lock?.packages?.["@openai/codex@0.144.0"]?.resolution?.integrity ===
      windowsCodexSpikeRuntimePolicy.package_integrity &&
      lock?.packages?.["@openai/codex@0.144.0-win32-x64"]?.resolution?.integrity ===
        windowsCodexSpikeRuntimePolicy.native_package_integrity,
    "Codex package lock integrity is invalid."
  );
  const binding = parseJsonFile(
    join(repositoryRoot, "packages", "codex-adapter", "binding-manifest.json"),
    "Codex binding manifest"
  );
  requireCondition(
    binding.codexVersion === "0.144.0" &&
      binding.bindingId === windowsCodexSpikeRuntimePolicy.binding_id,
    "Codex binding identity is invalid."
  );
  const version = spawnSync(executable, ["--version"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: baseWindowsEnvironment(),
    maxBuffer: 64 * 1024,
    shell: false,
    timeout: 10_000,
    windowsHide: true
  });
  requireCondition(
    version.error === undefined &&
      version.status === 0 &&
      version.signal === null &&
      version.stderr === "" &&
      /^codex-cli 0\.144\.0\r?\n$/u.test(version.stdout),
    "Codex Windows executable version output is invalid."
  );
  return Object.freeze({
    executable,
    managedPackageRoot: realpathSync(dirname(mainPackagePath)),
    pathDirectory: join(vendorRoot, packageLayout.pathDir)
  });
}

class RpcClient {
  constructor(socket, transcript) {
    this.socket = socket;
    this.transcript = transcript;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    socket.on("message", (data, isBinary) => this.receive(data, isBinary));
    socket.on("close", () => this.rejectAll(new Error("Codex WebSocket closed.")));
    socket.on("error", (error) => this.rejectAll(new Error("Codex WebSocket failed.", { cause: error })));
  }

  static async connect(url, credential, captures) {
    const transcript = { value: "" };
    captures.push(transcript);
    const socket = new WebSocket(url, {
      followRedirects: false,
      handshakeTimeout: 5_000,
      headers: { Authorization: `Bearer ${credential}` },
      maxPayload: 4 * 1024 * 1024,
      perMessageDeflate: false
    });
    await new Promise((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => rejectOpen(new Error("Codex WebSocket open timed out.")), 5_000);
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("open", onOpen);
        socket.off("error", onError);
        socket.off("unexpected-response", onUnexpectedResponse);
      };
      const onOpen = () => {
        cleanup();
        resolveOpen();
      };
      const onError = (error) => {
        cleanup();
        rejectOpen(new Error("Codex authenticated WebSocket failed.", { cause: error }));
      };
      const onUnexpectedResponse = (_request, response) => {
        response.resume();
        cleanup();
        rejectOpen(new Error("Codex authenticated WebSocket was rejected."));
      };
      socket.once("open", onOpen);
      socket.once("error", onError);
      socket.once("unexpected-response", onUnexpectedResponse);
    });
    return new RpcClient(socket, transcript);
  }

  request(method, params) {
    requireCondition(!this.closed, "Codex RPC client is closed.");
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`Codex request ${method} timed out.`));
      }, requestTimeoutMs);
      this.pending.set(id, {
        method,
        reject(error) {
          clearTimeout(timer);
          rejectRequest(error);
        },
        resolve(value) {
          clearTimeout(timer);
          resolveRequest(value);
        }
      });
      this.socket.send(JSON.stringify({ id, method, params }), { binary: false }, (error) => {
        if (error === undefined || error === null) return;
        const pending = this.pending.get(id);
        this.pending.delete(id);
        pending?.reject(new Error(`Codex request ${method} could not be sent.`, { cause: error }));
      });
    });
  }

  notify(method) {
    requireCondition(!this.closed, "Codex RPC client is closed.");
    this.socket.send(JSON.stringify({ method }), { binary: false });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new Error("Codex RPC client closed."));
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise((resolveClosed) => this.socket.once("close", resolveClosed));
    this.socket.close(1000, "HostDeck Windows spike completed.");
    if (await settlesWithin(closed, 2_000)) return;
    this.socket.terminate();
    await closed;
  }

  receive(data, isBinary) {
    if (isBinary) {
      this.socket.terminate();
      this.rejectAll(new Error("Codex emitted a binary WebSocket frame."));
      return;
    }
    const text = data.toString("utf8");
    this.transcript.value = boundedCapture(this.transcript.value, text);
    let message;
    try {
      message = JSON.parse(text);
    } catch (error) {
      this.socket.terminate();
      this.rejectAll(new Error("Codex emitted invalid JSON.", { cause: error }));
      return;
    }
    if (message === null || typeof message !== "object" || Array.isArray(message)) return;
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    this.pending.delete(message.id);
    if (message.error !== undefined) {
      pending.reject(new Error(`Codex request ${pending.method} returned an error.`));
    } else {
      pending.resolve(message.result);
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

async function initializeClient(client, codexHome) {
  const initialized = requireRecord(
    await client.request("initialize", {
      clientInfo: {
        name: "hostdeck-windows-spike",
        title: "HostDeck Windows Spike",
        version: "0.0.0"
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: []
      }
    }),
    "initialize result"
  );
  const userAgent = requireString(initialized.userAgent, "initialize userAgent");
  const platformFamily = requireString(
    initialized.platformFamily,
    "initialize platformFamily"
  );
  const platformOs = requireString(initialized.platformOs, "initialize platformOs");
  const observedCodexHome = requireString(initialized.codexHome, "initialize codexHome");
  requireCondition(
    userAgent.startsWith("hostdeck-windows-spike/0.144.0 "),
    "Initialized Codex version does not match the exact binary."
  );
  requireCondition(
    platformFamily === "windows" && platformOs === "windows",
    "Initialized Codex platform identity is invalid."
  );
  requireCondition(
    win32.normalize(observedCodexHome).toLowerCase() === win32.normalize(codexHome).toLowerCase(),
    "Initialized Codex home is invalid."
  );
  client.notify("initialized");
  const modes = await assertModeCatalog(client);
  return Object.freeze({ modes, platformFamily, platformOs, userAgent });
}

async function assertModeCatalog(client) {
  const catalog = requireRecord(
    await client.request("collaborationMode/list", {}),
    "collaborationMode/list result"
  );
  requireCondition(Array.isArray(catalog.data), "Collaboration mode catalog is invalid.");
  const modes = [...new Set(catalog.data.map((entry) => requireString(requireRecord(entry, "collaboration mode").name, "collaboration mode name").trim().toLowerCase()))]
    .filter((name) => name === "default" || name === "plan")
    .sort();
  requireCondition(modes.join(",") === "default,plan", "Plan and Default modes are required.");
  return Object.freeze(modes);
}

async function startResumeProbe(input) {
  const winpty = locateWinpty();
  const resumeEnvironment = {
    ...input.environment,
    [resumeCredentialEnvironment]: input.websocketCredential,
    TERM: "xterm-256color"
  };
  const child = spawn(
    winpty,
    [
      "-Xallow-non-tty",
      "-Xplain",
      input.executable,
      "resume",
      "--remote",
      input.endpoint,
      "--remote-auth-token-env",
      resumeCredentialEnvironment,
      "--no-alt-screen",
      input.threadId
    ],
    {
      cwd: input.project,
      env: resumeEnvironment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    }
  );
  const capture = captureChild(child, "Codex resume TUI");
  input.captures.push(capture);
  try {
    await waitFor(
      () => {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error("Codex resume TUI exited before rendering.");
        }
        const output = stripTerminalControl(`${capture.stdout}\n${capture.stderr}`);
        return output.includes("OpenAI Codex") && output.includes(basename(input.project));
      },
      15_000,
      "Codex resume TUI did not render before timeout."
    );
    const processTree = inspectProcessTreeCommandLines(child.pid);
    input.captures.push(processTree);
    requireCondition(
      !processTree.includes(input.websocketCredential) &&
        processTree.includes("--remote-auth-token-env") &&
        processTree.includes(resumeCredentialEnvironment),
      "Codex resume process tree did not keep credential material environment-only."
    );
    let closed = false;
    return Object.freeze({
      rendered: true,
      async close() {
        if (closed) return;
        closed = true;
        await stopProcessTree(child);
      }
    });
  } catch (error) {
    await stopProcessTree(child).catch(() => undefined);
    throw error;
  }
}

function locateWinpty() {
  const candidates = [
    "C:\\Program Files\\Git\\usr\\bin\\winpty.exe",
    "C:\\Program Files\\Git\\mingw64\\bin\\winpty.exe"
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && lstatSync(candidate).isFile()) return realpathSync(candidate);
  }
  throw new Error("Pinned Windows runner has no reviewed winpty harness.");
}

function codexEnvironment(runtime, codexHome) {
  return {
    ...baseWindowsEnvironment(),
    CODEX_HOME: codexHome,
    CODEX_MANAGED_BY_PNPM: "1",
    CODEX_MANAGED_PACKAGE_ROOT: runtime.managedPackageRoot,
    NO_COLOR: "1",
    PATH: `${runtime.pathDirectory};${requiredEnvironment("PATH")}`
  };
}

function baseWindowsEnvironment() {
  const allowed = [
    "APPDATA",
    "COMSPEC",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "PATH",
    "PATHEXT",
    "PROGRAMDATA",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "WINDIR"
  ];
  const environment = {};
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return { ...environment, CI: "true", NO_COLOR: "1", TZ: "UTC" };
}

function secureCurrentUserOnly(path, kind) {
  const identity = runBoundedCommand(
    "whoami.exe",
    [],
    10_000,
    "current-identity"
  ).stdout.trim();
  requireCondition(identity.length >= 3 && identity.length <= 256, "Current Windows identity is invalid.");
  const inheritance = kind === "directory" ? "(OI)(CI)F" : "F";
  runBoundedCommand(
    "icacls.exe",
    [path, "/inheritance:r", "/grant:r", `${identity}:${inheritance}`],
    10_000,
    "acl-update"
  );
  requireCondition(inspectCurrentUserOnlyAcl(path), "Windows path ACL hardening failed.");
}

function inspectCurrentUserOnlyAcl(path) {
  const script = [
    `$path = ${powershellLiteral(path)}`,
    "$acl = Get-Acl -LiteralPath $path",
    "$identity = [Security.Principal.WindowsIdentity]::GetCurrent()",
    "$current = $identity.User",
    "$allowed = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object AccessControlType -eq 'Allow' | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)",
    "[pscustomobject]@{ owner = ($acl.Owner -ieq $identity.Name); current = ($allowed.Count -eq 1 -and $allowed[0] -eq $current.Value) } | ConvertTo-Json -Compress"
  ].join("; ");
  const value = runPowerShellJson(script, "acl");
  return (
    value !== null &&
    typeof value === "object" &&
    value.owner === true &&
    value.current === true
  );
}

function inspectProcessCommandLine(pid) {
  const script = [
    `$process = Get-CimInstance Win32_Process -Filter ${powershellLiteral(`ProcessId = ${pid}`)}`,
    "if ($null -eq $process) { throw 'missing process' }",
    "[Console]::Out.Write($process.CommandLine)"
  ].join("; ");
  return runPowerShell(script, "process-command-line").stdout;
}

function inspectProcessTreeCommandLines(pid) {
  const script = [
    `$root = ${pid}`,
    "$all = @(Get-CimInstance Win32_Process)",
    "$ids = @($root)",
    "do { $before = $ids.Count; $ids += @($all | Where-Object { $ids -contains $_.ParentProcessId } | ForEach-Object ProcessId); $ids = @($ids | Sort-Object -Unique) } while ($ids.Count -gt $before)",
    "$lines = @($all | Where-Object { $ids -contains $_.ProcessId } | ForEach-Object CommandLine)",
    "[Console]::Out.Write(($lines -join \"`n\"))"
  ].join("; ");
  return runPowerShell(script, "process-tree").stdout;
}

async function inspectProcessListeners(pid, expectedPort) {
  let lastError = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const script = [
        `$connections = @(Get-NetTCPConnection -State Listen -OwningProcess ${pid} -ErrorAction Stop)`,
        "$connections | Select-Object @{Name='address';Expression={$_.LocalAddress}}, @{Name='port';Expression={$_.LocalPort}} | ConvertTo-Json -Compress"
      ].join("; ");
      const parsed = runPowerShellJson(script, "listeners");
      const rows = parsed === null ? [] : Array.isArray(parsed) ? parsed : [parsed];
      const listeners = rows.map((row) => ({
        address: requireString(requireRecord(row, "listener").address, "listener address"),
        port: requirePort(requireRecord(row, "listener").port, "listener port")
      }));
      if (listeners.some((entry) => entry.port === expectedPort)) return listeners;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error("Windows listener inspection did not observe the app-server endpoint.", {
    cause: lastError
  });
}

async function rejectedUpgradeStatus(url, headers) {
  return await new Promise((resolveStatus, rejectStatus) => {
    const socket = new WebSocket(url, {
      followRedirects: false,
      handshakeTimeout: 5_000,
      headers,
      perMessageDeflate: false
    });
    const timer = setTimeout(() => {
      socket.terminate();
      rejectStatus(new Error("Rejected WebSocket probe timed out."));
    }, 5_000);
    socket.once("open", () => {
      clearTimeout(timer);
      socket.terminate();
      rejectStatus(new Error("Rejected WebSocket probe unexpectedly opened."));
    });
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      const status = response.statusCode;
      response.resume();
      resolveStatus(status);
    });
    socket.once("error", (error) => {
      if (/Unexpected server response/iu.test(error.message)) return;
      clearTimeout(timer);
      rejectStatus(new Error("Rejected WebSocket probe failed.", { cause: error }));
    });
  });
}

async function waitForLoopbackEndpoint(child, capture) {
  let url = null;
  await waitFor(
    () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error("Codex app-server exited before listener readiness.");
      }
      const stripped = stripTerminalControl(capture.stderr);
      const matches = [...stripped.matchAll(/listening on:\s*(ws:\/\/127\.0\.0\.1:([0-9]{1,5}))/gu)];
      if (matches.length === 0) return false;
      requireCondition(matches.length === 1, "Codex emitted ambiguous listener readiness.");
      const port = requirePort(Number(matches[0][2]), "listener port");
      requireCondition(port >= 1_024, "Codex selected a privileged listener port.");
      url = { port, url: matches[0][1] };
      return true;
    },
    10_000,
    "Codex app-server listener did not become ready."
  );
  requireCondition(url !== null, "Codex app-server endpoint is missing.");
  return Object.freeze(url);
}

function captureChild(child, label) {
  const capture = { stderr: "", stdout: "" };
  child.stdout?.on("data", (chunk) => {
    capture.stdout = boundedCapture(capture.stdout, chunk.toString("utf8"));
  });
  child.stderr?.on("data", (chunk) => {
    capture.stderr = boundedCapture(capture.stderr, chunk.toString("utf8"));
  });
  child.on("error", (error) => {
    capture.stderr = boundedCapture(capture.stderr, `${label} process error: ${error.name}`);
  });
  return capture;
}

function assertCapturePrivacy(captures, forbiddenValues) {
  const text = captures
    .map((capture) =>
      typeof capture === "string"
        ? capture
        : Object.values(capture)
            .filter((value) => typeof value === "string")
            .join("\n")
    )
    .join("\n");
  for (const forbidden of forbiddenValues) {
    requireCondition(!text.includes(forbidden), "Spike capture contains credential material.");
  }
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGTERM");
  if (await settlesWithin(exited, 5_000)) return;
  await stopProcessTree(child);
}

async function stopProcessTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  const result = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
    encoding: "utf8",
    env: baseWindowsEnvironment(),
    maxBuffer: 64 * 1024,
    shell: false,
    timeout: 10_000,
    windowsHide: true
  });
  requireCondition(
    result.error === undefined && result.status === 0 && result.signal === null,
    "Windows process tree could not be terminated."
  );
  requireCondition(await settlesWithin(exited, 5_000), "Windows process tree did not exit.");
}

async function waitForClosedPort(port) {
  const { connect } = await import("node:net");
  await waitFor(
    async () =>
      await new Promise((resolveClosed) => {
        const socket = connect({ host: "127.0.0.1", port });
        const timer = setTimeout(() => {
          socket.destroy();
          resolveClosed(false);
        }, 250);
        socket.once("connect", () => {
          clearTimeout(timer);
          socket.destroy();
          resolveClosed(false);
        });
        socket.once("error", () => {
          clearTimeout(timer);
          socket.destroy();
          resolveClosed(true);
        });
      }),
    5_000,
    "Codex loopback listener remained reachable after shutdown."
  );
}

function runPowerShellJson(script, label) {
  const output = runPowerShell(script, label).stdout.trim();
  if (output === "") return null;
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error("PowerShell inspection returned invalid JSON.", { cause: error });
  }
}

function runPowerShell(script, label) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return runBoundedCommand(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    30_000,
    label
  );
}

function runBoundedCommand(command, args, timeout, label = "native-command") {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: baseWindowsEnvironment(),
    maxBuffer: 1024 * 1024,
    shell: false,
    timeout,
    windowsHide: true
  });
  if (result.error !== undefined || result.status !== 0 || result.signal !== null) {
    const code =
      result.error !== undefined && "code" in result.error
        ? String(result.error.code)
        : "none";
    throw new Error(
      `Native Windows inspection ${label} failed (status=${String(result.status)}, signal=${String(result.signal)}, code=${code}).`
    );
  }
  return Object.freeze({ stderr: result.stderr, stdout: result.stdout });
}

function powershellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function parseJsonFile(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid.`, { cause: error });
  }
}

function parseArguments(args) {
  if (
    args.length !== 2 ||
    args[0] !== "--output" ||
    typeof args[1] !== "string" ||
    !isAbsolute(args[1])
  ) {
    throw new TypeError(
      "Usage: node scripts/windows-codex-transport-spike.mjs --output <absolute-path>"
    );
  }
  return resolve(args[1]);
}

function requiredAbsoluteDirectory(candidate, name) {
  requireCondition(
    typeof candidate === "string" &&
      candidate.length >= 3 &&
      candidate.length <= 32_767 &&
      isAbsolute(candidate),
    `${name} is invalid.`
  );
  const path = realpathSync(candidate);
  requireCondition(lstatSync(path).isDirectory(), `${name} is not a directory.`);
  return path;
}

function requireInside(candidate, root, message) {
  const child = resolve(candidate);
  const parent = resolve(root);
  const childRelative = relative(parent, child);
  requireCondition(
    childRelative !== "" && !childRelative.startsWith("..") && !isAbsolute(childRelative),
    message
  );
}

function requireRecord(candidate, label) {
  requireCondition(
    candidate !== null && typeof candidate === "object" && !Array.isArray(candidate),
    `${label} is invalid.`
  );
  return candidate;
}

function requireString(candidate, label) {
  requireCondition(
    typeof candidate === "string" && candidate.length >= 1 && candidate.length <= 32_767,
    `${label} is invalid.`
  );
  return candidate;
}

function requireUuid(candidate, label) {
  const value = requireString(candidate, label);
  requireCondition(
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value),
    `${label} is invalid.`
  );
  return value;
}

function requirePort(candidate, label) {
  requireCondition(
    Number.isSafeInteger(candidate) && candidate >= 1 && candidate <= 65_535,
    `${label} is invalid.`
  );
  return candidate;
}

function readTurns(thread) {
  requireCondition(Array.isArray(thread.turns), "Codex thread turns are invalid.");
  return thread.turns;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  requireCondition(
    typeof value === "string" && value.length >= 1 && value.length <= 32_767,
    `Spike environment ${name} is invalid.`
  );
  return value;
}

function parsePositiveInteger(candidate) {
  requireCondition(/^[1-9][0-9]{0,3}$/u.test(candidate), "Spike integer is invalid.");
  return Number(candidate);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function boundedCapture(current, addition) {
  const value = `${current}${addition}`;
  return Buffer.byteLength(value, "utf8") <= maximumCaptureBytes
    ? value
    : value.slice(-maximumCaptureBytes);
}

function stripTerminalControl(value) {
  return value.replaceAll(ansiEscapePattern, "").replaceAll("\r", "");
}

async function waitFor(predicate, timeoutMs, timeoutMessage) {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started >= timeoutMs) throw new Error(timeoutMessage);
    await delay(50);
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function settlesWithin(promise, milliseconds) {
  let timer;
  const expired = new Promise((resolveExpired) => {
    timer = setTimeout(() => resolveExpired(false), milliseconds);
  });
  const settled = await Promise.race([promise.then(() => true), expired]);
  clearTimeout(timer);
  return settled;
}

async function collectCleanupError(promise, errors) {
  try {
    await promise;
  } catch (error) {
    errors.push(error);
  }
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Windows Codex transport spike failed."}\n`
  );
  process.exitCode = 1;
});
