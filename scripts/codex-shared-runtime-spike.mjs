import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const requireFromAdapter = createRequire(join(repositoryRoot, "packages", "codex-adapter", "package.json"));
const WebSocket = requireFromAdapter("ws");

const expectedCodexVersion = "0.147.0";
const requestTimeoutMs = 10_000;
const processTimeoutMs = 15_000;

async function main() {
  requireCondition(process.platform === "linux" && process.arch === "x64", "Spike requires Linux x64.");
  for (const command of ["script", "strace", "timeout"]) requireExecutable(command);

  const codexBin = resolveCodexBin();
  const version = run(codexBin, ["--version"]);
  requireCondition(version.stdout.trim() === `codex-cli ${expectedCodexVersion}`, "Codex version is not exactly 0.147.0.");

  const root = mkdtempSync(join(tmpdir(), "hostdeck-shared-codex-"));
  const codexHome = join(root, "codex-home");
  const project = join(root, "project");
  const controlDirectory = join(codexHome, "app-server-control");
  const socketPath = join(controlDirectory, "app-server-control.sock");
  const captures = [];
  let appServer = null;
  let nativeClient = null;
  let hostDeckClient = null;

  try {
    mkdirSync(codexHome, { mode: 0o700 });
    mkdirSync(project, { mode: 0o700 });
    chmodSync(codexHome, 0o700);
    chmodSync(project, 0o700);
    writeFileSync(
      join(codexHome, "auth.json"),
      `${JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "hostdeck-spike-not-a-key" })}\n`,
      { mode: 0o600 }
    );
    writeFileSync(
      join(codexHome, "config.toml"),
      [
        "check_for_update_on_startup = false",
        "[features]",
        "plugins = false",
        `[projects.${JSON.stringify(project)}]`,
        'trust_level = "trusted"',
        ""
      ].join("\n"),
      { mode: 0o600 }
    );

    const environment = {
      ...process.env,
      CODEX_HOME: codexHome,
      NO_COLOR: "1",
      TERM: "xterm-256color"
    };
    appServer = spawn(codexBin, ["app-server", "--listen", "unix://"], {
      cwd: project,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const appCapture = captureChild(appServer);
    captures.push(appCapture);
    await waitForSocket(socketPath, appServer, appCapture);
    requireCondition(mode(controlDirectory) === 0o700, "Codex control directory is not owner-only.");
    requireCondition(mode(socketPath) === 0o600, "Codex control socket is not owner-only.");

    nativeClient = await RpcClient.connect(socketPath);
    await nativeClient.initialize("hostdeck-shared-spike-native", codexHome);
    const unmaterializedBefore = await startThread(nativeClient, project);
    const loadedBefore = await startThread(nativeClient, project);
    await materializeWithoutTurn(nativeClient, loadedBefore);

    hostDeckClient = await RpcClient.connect(socketPath);
    await hostDeckClient.initialize("hostdeck-shared-spike-hostdeck", codexHome);
    const loadedBeforeIds = await loadedThreadIds(hostDeckClient);
    requireCondition(
      [unmaterializedBefore, loadedBefore].every((threadId) => loadedBeforeIds.includes(threadId)),
      "HostDeck client did not observe every thread loaded before it connected."
    );

    const pendingMetadata = await readThread(hostDeckClient, unmaterializedBefore, false);
    requireCondition(pendingMetadata.id === unmaterializedBefore, "Metadata-only read returned the wrong thread.");
    await requireRequestFailure(
      hostDeckClient,
      "thread/resume",
      { threadId: unmaterializedBefore, excludeTurns: true },
      "no rollout found"
    );
    await materializeWithoutTurn(nativeClient, unmaterializedBefore);
    const pendingResume = requireRecord(
      await hostDeckClient.request("thread/resume", { threadId: unmaterializedBefore, excludeTurns: true }),
      "pending thread/resume result"
    );
    requireCondition(
      threadTurnCount(requireRecord(pendingResume.thread, "pending thread/resume thread")) === 0,
      "Pending thread retry unexpectedly started a turn."
    );

    const metadataResume = requireRecord(
      await hostDeckClient.request("thread/resume", { threadId: loadedBefore, excludeTurns: true }),
      "thread/resume result"
    );
    const metadataThread = requireRecord(metadataResume.thread, "thread/resume thread");
    requireCondition(
      threadTurnCount(metadataThread) === 0,
      "Metadata-only resume returned an unexpected turn."
    );
    await delay(100);
    requireCondition(
      !hostDeckClient.hasNotification("turn/started", (params) => notificationThreadId(params) === loadedBefore),
      "Metadata-only resume unexpectedly started a turn."
    );

    const createdAfterNotification = hostDeckClient.waitForNotification(
      "thread/started",
      (params) => threadIdFromNotification(params) !== loadedBefore
    );
    const createdAfter = await startThread(nativeClient, project);
    const notification = await createdAfterNotification;
    requireCondition(
      threadIdFromNotification(notification.params) === createdAfter,
      "HostDeck client received the wrong created-after notification."
    );
    requireCondition(
      (await loadedThreadIds(hostDeckClient)).includes(createdAfter),
      "HostDeck client did not observe a thread created after it connected."
    );

    const plainStartNotification = hostDeckClient.waitForNotification(
      "thread/started",
      (params) => ![unmaterializedBefore, loadedBefore, createdAfter].includes(threadIdFromNotification(params))
    );
    const plainStartTrace = runTuiTrace({
      args: ["--no-alt-screen"],
      codexBin,
      environment,
      label: "plain-start",
      project,
      root
    });
    requireSocketConnect(plainStartTrace, socketPath, "Plain codex");
    const plainStarted = threadIdFromNotification((await plainStartNotification).params);
    requireCondition(
      (await loadedThreadIds(hostDeckClient)).includes(plainStarted),
      "HostDeck client did not observe the plain TUI thread."
    );

    const plainResumeTrace = runTuiTrace({
      args: ["resume", loadedBefore, "--no-alt-screen"],
      codexBin,
      environment,
      label: "plain-resume",
      project,
      root
    });
    requireSocketConnect(plainResumeTrace, socketPath, "Plain codex resume");
    requireCondition(
      threadTurnCount(await readThread(hostDeckClient, loadedBefore)) === 0,
      "Plain TUI resume unexpectedly started a turn."
    );
    requireCondition(
      (await loadedThreadIds(nativeClient)).includes(plainStarted),
      "The first RPC client stopped working while HostDeck and TUI clients were connected."
    );

    await nativeClient.close();
    nativeClient = null;
    requireCondition(
      (await loadedThreadIds(hostDeckClient)).includes(loadedBefore),
      "HostDeck client did not survive peer disconnect."
    );
    await hostDeckClient.close();
    hostDeckClient = null;

    await stopChild(appServer, "SIGTERM");
    appServer = null;
    await waitFor(() => !existsSync(socketPath), "Codex control socket was not removed during shutdown.");

    process.stdout.write(
      `${JSON.stringify(
        {
          codex_version: expectedCodexVersion,
          control_directory_mode: "0700",
          control_socket_mode: "0600",
          created_after_observed: true,
          loaded_before_observed: true,
          metadata_resume_turn_count: 0,
          multi_client: true,
          unmaterialized_loaded_thread_retry: true,
          plain_codex_standard_socket: true,
          plain_resume_standard_socket: true,
          socket: "$CODEX_HOME/app-server-control/app-server-control.sock"
        },
        null,
        2
      )}\n`
    );
  } finally {
    await closeQuietly(nativeClient);
    await closeQuietly(hostDeckClient);
    if (appServer !== null) await stopChild(appServer, "SIGKILL").catch(() => undefined);
    rmSync(root, { force: true, recursive: true });
    requireCondition(!existsSync(root), "Spike temporary directory was not removed.");
    scanCaptures(captures);
  }
}

class RpcClient {
  constructor(socket) {
    this.socket = socket;
    this.closed = false;
    this.nextId = 1;
    this.notifications = [];
    this.notificationWaiters = new Set();
    this.pending = new Map();
    socket.on("message", (data, isBinary) => this.receive(data, isBinary));
    socket.on("close", () => this.rejectAll(new Error("Codex WebSocket closed.")));
    socket.on("error", (error) => this.rejectAll(error));
  }

  static async connect(socketPath) {
    const socket = new WebSocket(`ws+unix:${socketPath}`, {
      followRedirects: false,
      handshakeTimeout: 5_000,
      maxPayload: 4 * 1024 * 1024,
      perMessageDeflate: false
    });
    await new Promise((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => rejectOpen(new Error("Codex WebSocket open timed out.")), 5_000);
      socket.once("open", () => {
        clearTimeout(timer);
        resolveOpen();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        rejectOpen(error);
      });
    });
    return new RpcClient(socket);
  }

  async initialize(name, codexHome) {
    const result = requireRecord(
      await this.request("initialize", {
        clientInfo: { name, title: "HostDeck shared runtime spike", version: "0.0.0" },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: []
        }
      }),
      "initialize result"
    );
    requireCondition(
      typeof result.userAgent === "string" && result.userAgent.includes(`/${expectedCodexVersion} `),
      `Initialize response did not corroborate Codex 0.147.0: ${JSON.stringify(result.userAgent)}`
    );
    requireCondition(resolve(result.codexHome) === resolve(codexHome), "Initialize response returned the wrong CODEX_HOME.");
    this.notify("initialized");
  }

  request(method, params) {
    requireCondition(!this.closed, "Codex RPC client is closed.");
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`Codex request ${method} timed out.`));
      }, requestTimeoutMs);
      this.pending.set(id, { method, reject: rejectRequest, resolve: resolveRequest, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  notify(method) {
    this.socket.send(JSON.stringify({ method }));
  }

  waitForNotification(method, predicate = () => true) {
    const existing = this.notifications.find((message) => message.method === method && predicate(message.params));
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolveNotification, rejectNotification) => {
      const waiter = { method, predicate, resolve: resolveNotification, reject: rejectNotification, timer: null };
      waiter.timer = setTimeout(() => {
        this.notificationWaiters.delete(waiter);
        rejectNotification(new Error(`Codex notification ${method} timed out.`));
      }, requestTimeoutMs);
      this.notificationWaiters.add(waiter);
    });
  }

  hasNotification(method, predicate = () => true) {
    return this.notifications.some((message) => message.method === method && predicate(message.params));
  }

  receive(data, isBinary) {
    requireCondition(!isBinary, "Codex emitted a binary frame.");
    const message = JSON.parse(data.toString("utf8"));
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) {
        pending.reject(new Error(`Codex request ${pending.method} failed: ${JSON.stringify(message.error)}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== "string") return;
    this.notifications.push(message);
    for (const waiter of this.notificationWaiters) {
      if (waiter.method !== message.method || !waiter.predicate(message.params)) continue;
      this.notificationWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.notificationWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.notificationWaiters.clear();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise((resolveClosed) => this.socket.once("close", resolveClosed));
    this.socket.close(1000, "Spike completed.");
    if (await settlesWithin(closed, 2_000)) return;
    this.socket.terminate();
    await closed;
  }
}

async function startThread(client, cwd) {
  const result = requireRecord(
    await client.request("thread/start", {
      approvalPolicy: "never",
      cwd,
      ephemeral: false,
      sandbox: "danger-full-access"
    }),
    "thread/start result"
  );
  const thread = requireRecord(result.thread, "thread/start thread");
  requireCondition(threadTurnCount(thread) === 0, "No-prompt thread/start returned an unexpected turn.");
  return requireUuid(thread.id, "thread/start thread id");
}

async function materializeWithoutTurn(client, threadId) {
  await client.request("thread/goal/set", {
    threadId,
    objective: "Verify shared Codex runtime semantics without model work.",
    status: "paused"
  });
  await client.request("thread/goal/clear", { threadId });
  requireCondition(
    threadTurnCount(await readThread(client, threadId)) === 0,
    "Metadata materialization unexpectedly started a turn."
  );
}

async function loadedThreadIds(client) {
  const ids = [];
  let cursor;
  do {
    const result = requireRecord(
      await client.request("thread/loaded/list", { ...(cursor === undefined ? {} : { cursor }), limit: 2 }),
      "thread/loaded/list result"
    );
    requireCondition(Array.isArray(result.data), "thread/loaded/list data is invalid.");
    ids.push(...result.data.map((value) => requireUuid(value, "loaded thread id")));
    cursor = result.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return ids;
}

async function readThread(client, threadId, includeTurns = true) {
  const result = requireRecord(
    await client.request("thread/read", { threadId, includeTurns }),
    "thread/read result"
  );
  return requireRecord(result.thread, "thread/read thread");
}

async function requireRequestFailure(client, method, params, expectedMessage) {
  try {
    await client.request(method, params);
  } catch (error) {
    requireCondition(
      error instanceof Error && error.message.includes(expectedMessage),
      `${method} failed with an unexpected error.`
    );
    return;
  }
  throw new Error(`${method} unexpectedly succeeded.`);
}

function threadTurnCount(thread) {
  requireCondition(Array.isArray(thread.turns), "Thread turns are invalid.");
  return thread.turns.length;
}

function threadIdFromNotification(params) {
  return requireUuid(requireRecord(params, "thread/started params").thread?.id, "thread/started thread id");
}

function notificationThreadId(params) {
  const value = requireRecord(params, "thread notification params").threadId;
  return typeof value === "string" ? value : null;
}

function runTuiTrace(input) {
  const tracePrefix = join(input.root, `${input.label}.strace`);
  const command = [
    "timeout",
    "--signal=INT",
    "--kill-after=2s",
    "5s",
    "strace",
    "-ff",
    "-e",
    "trace=connect",
    "-s",
    "256",
    "-o",
    shellQuote(tracePrefix),
    shellQuote(input.codexBin),
    ...input.args.map(shellQuote)
  ].join(" ");
  const result = spawnSync("script", ["-qefc", command, "/dev/null"], {
    cwd: input.project,
    encoding: "utf8",
    env: input.environment,
    input: "",
    maxBuffer: 2 * 1024 * 1024,
    timeout: processTimeoutMs
  });
  requireCondition(result.error === undefined, `${input.label} trace process failed to run.`);
  requireCondition([0, 124, 130].includes(result.status), `${input.label} exited unexpectedly (${String(result.status)}).`);
  const traceFiles = readdirSync(input.root)
    .filter((name) => name.startsWith(`${basename(tracePrefix)}.`))
    .map((name) => join(input.root, name));
  requireCondition(traceFiles.length > 0, `${input.label} emitted no strace files.`);
  return traceFiles.map((path) => readFileSync(path, "utf8")).join("\n");
}

function requireSocketConnect(trace, socketPath, label) {
  requireCondition(
    trace.includes("AF_UNIX") && trace.includes(`sun_path="${socketPath}"`) && trace.includes("= 0"),
    `${label} did not connect to the standard Codex socket.`
  );
}

function resolveCodexBin() {
  if (process.env.CODEX_BIN !== undefined) {
    const candidate = realpathSync(resolve(process.env.CODEX_BIN));
    requireCondition(existsSync(candidate) && lstatSync(candidate).isFile(), "CODEX_BIN is not a file.");
    return candidate;
  }
  const located = spawnSync("sh", ["-c", "command -v codex"], { encoding: "utf8", timeout: 5_000 });
  requireCondition(located.status === 0 && located.stdout.trim() !== "", "Codex executable was not found.");
  return resolve(located.stdout.trim());
}

function requireExecutable(command) {
  const result = spawnSync("sh", ["-c", `command -v ${shellQuote(command)}`], { encoding: "utf8", timeout: 5_000 });
  requireCondition(result.status === 0, `Required command ${command} is unavailable.`);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024, timeout: 10_000 });
  requireCondition(result.error === undefined && result.status === 0, `${command} ${args.join(" ")} failed.`);
  return result;
}

function captureChild(child) {
  const capture = { stderr: "", stdout: "" };
  child.stdout?.on("data", (chunk) => {
    capture.stdout = bounded(capture.stdout + chunk.toString("utf8"));
  });
  child.stderr?.on("data", (chunk) => {
    capture.stderr = bounded(capture.stderr + chunk.toString("utf8"));
  });
  return capture;
}

async function waitForSocket(socketPath, child, capture) {
  await waitFor(() => {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Codex app-server exited before readiness: ${bounded(capture.stderr)}`);
    }
    return existsSync(socketPath) && lstatSync(socketPath).isSocket();
  }, "Codex standard socket did not become ready.");
}

async function waitFor(predicate, failureMessage, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(failureMessage);
}

async function stopChild(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill(signal);
  requireCondition(await settlesWithin(exited, 5_000), `Codex process did not exit after ${signal}.`);
}

async function closeQuietly(client) {
  if (client === null) return;
  await client.close().catch(() => undefined);
}

async function settlesWithin(promise, timeoutMs) {
  return await Promise.race([promise.then(() => true), delay(timeoutMs).then(() => false)]);
}

function mode(path) {
  return lstatSync(path).mode & 0o777;
}

function bounded(value) {
  return value.slice(-64 * 1024);
}

function scanCaptures(captures) {
  const text = captures.map((capture) => `${capture.stdout}\n${capture.stderr}`).join("\n");
  requireCondition(!text.includes("hostdeck-spike-not-a-key"), "Spike output captured credential material.");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function requireRecord(value, label) {
  requireCondition(value !== null && typeof value === "object" && !Array.isArray(value), `${label} is invalid.`);
  return value;
}

function requireUuid(value, label) {
  requireCondition(
    typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value),
    `${label} is invalid.`
  );
  return value;
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

await main();
