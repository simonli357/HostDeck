import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { chmod, copyFile, lstat, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { cliExitCodes, type HostDeckResumeLauncher, runCli } from "@hostdeck/cli";
import {
  type CodexAppServerConnection,
  codexBindingDescriptor,
  createCodexAppServerConnection,
  createCodexNativeSessionClient,
  createCodexUnixWebSocketTransport,
  parseCodexCliVersionOutput
} from "@hostdeck/codex-adapter";
import {
  nativeSessionAdoptResponseSchema,
  nativeSessionDiscoveryResponseSchema,
  nativeSessionUnmanageResponseSchema,
  promptDispatchResponseSchema,
  resolveResourceBudget,
  type SelectedProjectionEvent,
  selectedEventPageResponseSchema,
  selectedProjectionEventSchema,
  selectedResumeLaunchSchema,
  selectedSessionDetailResponseSchema,
  selectedSessionListResponseSchema
} from "@hostdeck/contracts";
import {
  type HostDeckProductionServiceServe,
  hostDeckDeviceCookieName,
  hostDeckProductionBrowserRoutes,
  startHostDeckProductionServiceServe
} from "@hostdeck/server";
import {
  createAuthDeviceRepository,
  openMigratedDatabase
} from "@hostdeck/storage";
import { describe, expect, it } from "vitest";
import { writeProductionWebTestFixture } from "../../server/src/production-web-assets.test-support.js";

const requireSmoke =
  process.env.HOSTDECK_REQUIRE_NATIVE_SESSION_INTEROPERABILITY_SMOKE === "1";
const nativeMarker = "HOSTDECK_NATIVE_READY";
const hostDeckMarker = "HOSTDECK_MANAGED_READY";
const rawDeviceToken = "W".repeat(43);
const rawCsrfToken = "C".repeat(43);
const adoptOperationId = "op_native_interop_adopt_001";
const hostDeckOperationId = "op_native_interop_prompt_001";
const unmanageOperationId = "op_native_interop_unmanage_001";

describe.skipIf(!requireSmoke)(
  "exact native Codex session interoperability",
  () => {
    it(
      "adopts one standalone thread through the production phone and laptop lifecycle without changing native ownership",
      async () => {
        const codexBin = requireExactCodexBinary(
          process.env.HOSTDECK_CODEX_BIN
        );
        requireTmux();
        const sourceCodexHome =
          process.env.CODEX_HOME ?? join(homedir(), ".codex");
        const root = mkdtempSync(join(homedir(), ".hostdeck-native-interop-"));
        chmodSync(root, 0o700);
        const configDir = join(root, "config");
        const stateDir = join(root, "state");
        const runtimeDir = join(root, "runtime");
        const codexHome = join(root, "codex-home");
        const projectDirectory = join(root, "project");
        const buildRoot = join(root, "build");
        const databasePath = join(stateDir, "hostdeck.sqlite");
        const appServerSocketPath = join(runtimeDir, "app-server.sock");
        const nativeTuiSocketPath = join(root, "native-tui.sock");
        const resumedTuiSocketPath = join(root, "resumed-tui.sock");
        const previousCodexHome = process.env.CODEX_HOME;
        let serve: HostDeckProductionServiceServe | null = null;
        let appServer: ChildProcess | null = null;
        let directConnection: CodexAppServerConnection | null = null;
        let primary: unknown = null;
        const cleanupErrors: unknown[] = [];

        try {
          mkdirSync(codexHome, { mode: 0o700 });
          writeFileSync(
            join(codexHome, "config.toml"),
            "check_for_update_on_startup = false\n",
            { mode: 0o600 }
          );
          mkdirSync(projectDirectory, { mode: 0o700 });
          await seedCodexAuthentication(sourceCodexHome, codexHome);
          initializeGitProject(projectDirectory);
          process.env.CODEX_HOME = codexHome;

          const threadId = await createStandaloneNativeThread({
            codexBin,
            codexHome,
            marker: nativeMarker,
            projectDirectory,
            tmuxSocketPath: nativeTuiSocketPath
          });
          createProductionWebFixture(buildRoot);
          const port = await availableLoopbackPort();
          seedPhoneAuthority(databasePath);
          mkdirSync(runtimeDir, { mode: 0o700 });
          const serviceAppServer = startServiceAppServer({
            codexBin,
            codexHome,
            socketPath: appServerSocketPath
          });
          appServer = serviceAppServer;
          await waitForAppServerSocket(
            appServerSocketPath,
            serviceAppServer
          );
          const appServerSocketIdentity = socketIdentity(appServerSocketPath);
          const startServe = () =>
            startHostDeckProductionServiceServe(
              {
                browser_routes: hostDeckProductionBrowserRoutes,
                codex_bin: codexBin,
                config_dir: configDir,
                database_path: databasePath,
                loopback_port: port,
                observe_issue: () => undefined,
                resource_budget: resolveResourceBudget({
                  sse_heartbeat_interval_ms: 1_000
                }),
                runtime_dir: runtimeDir,
                state_dir: stateDir,
                static_build_root: buildRoot,
                static_package_version: "0.0.0"
              },
              {
                subscribe_termination_signals: () => () => undefined
              }
            );

          serve = await startServe();
          expect(serve.snapshot()).toMatchObject({
            phase: "ready",
            listener_health: "ready",
            application: {
              phase: "runtime_ready",
              reconnect: { phase: "ready" },
              reconciliation: { phase: "ready" }
            }
          });
          const origin = serve.local_origin;
          const discovered = await waitForDiscovery(origin, threadId);
          expect(discovered.threads).toHaveLength(1);
          expect(discovered.threads[0]).toMatchObject({
            thread_id: threadId,
            cwd: projectDirectory,
            source: "cli",
            runtime_version: codexBindingDescriptor.codex_version,
            archived: false,
            ephemeral: false,
            parent_thread_id: null,
            forked_from_id: null
          });

          const adoptedCli = await runCli(
            [
              "--api-url",
              origin,
              "adopt",
              threadId,
              "--name",
              "native-interoperability",
              "--confirm-handoff",
              "--json"
            ],
            {
              env: {},
              createNativeAdoptOperationId: () => adoptOperationId
            }
          );
          expect(adoptedCli).toMatchObject({
            exitCode: cliExitCodes.ok,
            stderr: ""
          });
          const adopted = nativeSessionAdoptResponseSchema.parse(
            JSON.parse(adoptedCli.stdout)
          );
          const sessionId = adopted.session.id;
          expect(adopted).toMatchObject({
            operation_id: adoptOperationId,
            session: {
              codex_thread_id: threadId,
              name: "native-interoperability",
              session_state: "active",
              freshness: "current"
            }
          });

          const list = await readPhoneSessionList(origin);
          expect(list.access.mode).toBe("paired_write");
          expect(list.sessions).toHaveLength(1);
          expect(list.sessions[0]?.session).toMatchObject({
            id: sessionId,
            codex_thread_id: threadId,
            cwd: projectDirectory,
            session_state: "active",
            freshness: "current"
          });
          const detail = await readPhoneSessionDetail(origin, sessionId);
          expect(detail.session.session.codex_thread_id).toBe(threadId);
          const adoptionEvents = await readPhoneEventPage(origin, sessionId);
          expect(adoptionEvents.events[0]).toMatchObject({
            type: "replay_boundary",
            reason: "adoption"
          });
          expect(
            adoptionEvents.events.some(
              (event) =>
                event.type === "message" &&
                event.role === "agent" &&
                event.phase === "completed" &&
                event.text.includes(nativeMarker)
            )
          ).toBe(true);

          const streamController = new AbortController();
          const streamResponse = await withTimeout(
            fetch(
              `${origin}/api/v1/sessions/${encodeURIComponent(sessionId)}/events/stream?after=${adoptionEvents.next_cursor}`,
              {
                headers: phoneReadHeaders("text/event-stream"),
                signal: streamController.signal
              }
            ),
            10_000,
            "Phone event stream did not open."
          );
          expect(streamResponse.status).toBe(200);
          expect(streamResponse.headers.get("content-type")).toContain(
            "text/event-stream"
          );

          const promptCli = await runCli(
            [
              "--api-url",
              origin,
              "send",
              sessionId,
              `Reply with exactly ${hostDeckMarker}.`,
              "--json"
            ],
            {
              env: {},
              createPromptOperationId: () => hostDeckOperationId
            }
          );
          expect(promptCli).toMatchObject({
            exitCode: cliExitCodes.ok,
            stderr: ""
          });
          const promptResponse = promptDispatchResponseSchema.parse(
            JSON.parse(promptCli.stdout)
          );
          expect(promptResponse).toMatchObject({
            operation_id: hostDeckOperationId,
            state: "accepted",
            action: "start",
            target: {
              session_id: sessionId,
              codex_thread_id: threadId
            }
          });
          const streamed = await withTimeout(
            readTurnFromSse({
              after: adoptionEvents.next_cursor,
              marker: hostDeckMarker,
              response: streamResponse,
              sessionId,
              turnId: promptResponse.turn_id
            }),
            120_000,
            "Phone event stream did not observe the completed HostDeck turn."
          ).finally(() => streamController.abort());
          expect(streamed.turnStates).toContain("in_progress");
          expect(streamed.turnStates.at(-1)).toBe("completed");
          expect(streamed.agentMarkerSeen).toBe(true);
          expect(streamed.cursors.every((cursor, index) => {
            const previous = streamed.cursors[index - 1];
            return previous === undefined || cursor > previous;
          })).toBe(true);

          const completedDetail = await readPhoneSessionDetail(
            origin,
            sessionId
          );
          expect(completedDetail.session.session).toMatchObject({
            codex_thread_id: threadId,
            turn_state: "completed",
            freshness: "current"
          });

          await serve.close();
          serve = null;
          expect(serviceAppServer.exitCode).toBeNull();
          expect(serviceAppServer.signalCode).toBeNull();
          expect(socketIdentity(appServerSocketPath)).toBe(
            appServerSocketIdentity
          );
          serve = await startServe();
          expect(serve.snapshot()).toMatchObject({
            phase: "ready",
            listener_health: "ready",
            application: {
              reconnect: { phase: "ready" },
              reconciliation: {
                phase: "ready",
                durable_session_count: 1,
                recoverable_session_count: 1,
                ready_count: 1
              }
            }
          });
          const restartedOrigin = serve.local_origin;
          const restartedDetail = await readPhoneSessionDetail(
            restartedOrigin,
            sessionId
          );
          expect(restartedDetail.session.session).toMatchObject({
            id: sessionId,
            codex_thread_id: threadId,
            turn_state: "completed",
            freshness: "current"
          });
          expect(serviceAppServer.exitCode).toBeNull();
          expect(socketIdentity(appServerSocketPath)).toBe(
            appServerSocketIdentity
          );

          let resumeLaunchObserved = false;
          let resumeLaunchError: unknown = null;
          const resumeLauncher: HostDeckResumeLauncher = Object.freeze({
            async launch(
              candidate: Parameters<HostDeckResumeLauncher["launch"]>[0]
            ) {
              const launch = selectedResumeLaunchSchema.parse(candidate);
              expect(launch.executable).toBe(codexBin);
              expect(launch.args.at(-1)).toBe(threadId);
              expect(launch.args[1]).toBe("--remote");
              expect(launch.args[2]).toBe(`unix://${appServerSocketPath}`);
              try {
                await inspectResumedTui({
                  codexHome,
                  expectedText: hostDeckMarker,
                  launch,
                  projectDirectory,
                  tmuxSocketPath: resumedTuiSocketPath
                });
                resumeLaunchObserved = true;
              } catch (error) {
                resumeLaunchError = error;
                throw error;
              }
            }
          });
          const resumedCli = await runCli(
            ["--api-url", restartedOrigin, "resume", sessionId],
            { env: {}, resumeLauncher }
          );
          if (resumeLaunchError !== null) throw resumeLaunchError;
          expect(resumedCli).toEqual({
            exitCode: cliExitCodes.ok,
            stdout: "",
            stderr: ""
          });
          expect(resumeLaunchObserved).toBe(true);

          const unmanagedCli = await runCli(
            [
              "--api-url",
              restartedOrigin,
              "unmanage",
              sessionId,
              "--confirm",
              "--json"
            ],
            {
              env: {},
              createNativeUnmanageOperationId: () => unmanageOperationId
            }
          );
          expect(unmanagedCli).toMatchObject({
            exitCode: cliExitCodes.ok,
            stderr: ""
          });
          expect(
            nativeSessionUnmanageResponseSchema.parse(
              JSON.parse(unmanagedCli.stdout)
            )
          ).toMatchObject({
            operation_id: unmanageOperationId,
            session_id: sessionId,
            codex_thread_id: threadId
          });
          expect((await readPhoneSessionList(restartedOrigin)).sessions).toEqual(
            []
          );
          const removedDetail = await fetch(
            `${restartedOrigin}/api/v1/sessions/${encodeURIComponent(sessionId)}`,
            { headers: phoneReadHeaders() }
          );
          expect(removedDetail.status).toBe(404);

          directConnection = createCodexAppServerConnection({
            transport: createCodexUnixWebSocketTransport({
              socket_path: appServerSocketPath
            }),
            observed_version: codexBindingDescriptor.codex_version
          });
          await directConnection.connect();
          const fixedDirectConnection = directConnection;
          const native = createCodexNativeSessionClient({
            get compatibility() {
              return fixedDirectConnection.compatibility;
            },
            request(input) {
              return fixedDirectConnection.request(input);
            }
          });
          const nativeAfterUnmanage =
            await native.readAdoptionSnapshot(threadId);
          expect(nativeAfterUnmanage.thread).toMatchObject({
            thread_id: threadId,
            cwd: projectDirectory,
            source: "cli",
            archived: false,
            ephemeral: false
          });
          expect(nativeAfterUnmanage.turns.length).toBeGreaterThanOrEqual(2);
          const nativeTexts = nativeAfterUnmanage.turns.flatMap((turn) =>
            turn.messages.map((message) => message.text)
          );
          expect(nativeTexts.some((text) => text.includes(nativeMarker))).toBe(
            true
          );
          expect(
            nativeTexts.some((text) => text.includes(hostDeckMarker))
          ).toBe(true);
          await expect(native.resume(threadId)).resolves.toMatchObject({
            thread: {
              thread_id: threadId,
              cwd: projectDirectory,
              source: "cli"
            }
          });
          expect((await readPhoneSessionList(restartedOrigin)).sessions).toEqual(
            []
          );
        } catch (error) {
          primary = new Error(
            "Exact native Codex session interoperability smoke failed.",
            { cause: error }
          );
        } finally {
          if (directConnection !== null) {
            await collectCleanup(
              directConnection.close(
                "Native session interoperability smoke completed."
              ),
              cleanupErrors
            );
          }
          if (serve !== null) {
            await collectCleanup(serve.close(), cleanupErrors);
          }
          if (appServer !== null) {
            await collectCleanup(
              stopServiceAppServer(appServer, appServerSocketPath),
              cleanupErrors
            );
          }
          await collectCleanup(
            closeTmux(nativeTuiSocketPath, codexHome),
            cleanupErrors
          );
          await collectCleanup(
            closeTmux(resumedTuiSocketPath, codexHome),
            cleanupErrors
          );
          if (previousCodexHome === undefined) {
            delete process.env.CODEX_HOME;
          } else {
            process.env.CODEX_HOME = previousCodexHome;
          }
          try {
            rmSync(root, { recursive: true, force: true });
          } catch (error) {
            cleanupErrors.push(error);
          }
        }

        if (primary !== null && cleanupErrors.length === 0) throw primary;
        if (primary !== null || cleanupErrors.length > 0) {
          throw new AggregateError(
            primary === null ? cleanupErrors : [primary, ...cleanupErrors],
            "Native session interoperability smoke cleanup failed."
          );
        }
        expect(existsSync(root)).toBe(false);
      },
      240_000
    );
  }
);

function requireExactCodexBinary(candidate: string | undefined): string {
  if (candidate === undefined || !isAbsolute(candidate)) {
    throw new TypeError(
      "Native interoperability smoke requires an absolute Codex binary."
    );
  }
  const path = resolve(candidate);
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(path);
    accessSync(path, constants.X_OK);
  } catch {
    throw new TypeError(
      "Native interoperability smoke Codex binary is unavailable."
    );
  }
  if (
    realpathSync(path) !== path ||
    !metadata.isFile() ||
    metadata.isSymbolicLink()
  ) {
    throw new TypeError(
      "Native interoperability smoke Codex binary is insecure."
    );
  }
  const version = parseCodexCliVersionOutput(
    execFileSync(path, ["--version"], {
      cwd: "/",
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1_024
    })
  );
  if (version !== codexBindingDescriptor.codex_version) {
    throw new TypeError(
      "Native interoperability smoke Codex version is unsupported."
    );
  }
  return path;
}

function requireTmux(): void {
  const output = execFileSync("tmux", ["-V"], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 4_096
  });
  if (!/^tmux \d/u.test(output)) {
    throw new TypeError("Native interoperability smoke requires tmux.");
  }
}

async function seedCodexAuthentication(
  sourceCodexHome: string,
  codexHome: string
): Promise<void> {
  const source = join(sourceCodexHome, "auth.json");
  const sourceMetadata = await lstat(source);
  if (!sourceMetadata.isFile() || (sourceMetadata.mode & 0o077) !== 0) {
    throw new Error("Codex auth source must be a private regular file.");
  }
  const destination = join(codexHome, "auth.json");
  await copyFile(source, destination);
  await chmod(destination, 0o600);
  const destinationMetadata = await stat(destination);
  if (
    !destinationMetadata.isFile() ||
    (destinationMetadata.mode & 0o077) !== 0
  ) {
    throw new Error("Temporary Codex authentication is not private.");
  }
}

function initializeGitProject(projectDirectory: string): void {
  writeFileSync(join(projectDirectory, ".gitkeep"), "", { mode: 0o600 });
  execFileSync("git", ["init", "-q", "-b", "main", projectDirectory], {
    timeout: 10_000
  });
  execFileSync(
    "git",
    ["-C", projectDirectory, "config", "user.email", "hostdeck@example.invalid"],
    { timeout: 10_000 }
  );
  execFileSync(
    "git",
    ["-C", projectDirectory, "config", "user.name", "HostDeck Smoke"],
    { timeout: 10_000 }
  );
  execFileSync("git", ["-C", projectDirectory, "add", ".gitkeep"], {
    timeout: 10_000
  });
  execFileSync("git", ["-C", projectDirectory, "commit", "-q", "-m", "init"], {
    timeout: 10_000
  });
}

async function createStandaloneNativeThread(input: {
  readonly codexBin: string;
  readonly codexHome: string;
  readonly marker: string;
  readonly projectDirectory: string;
  readonly tmuxSocketPath: string;
}): Promise<string> {
  const environment = codexEnvironment(input.codexHome);
  const command = [
    input.codexBin,
    "--no-alt-screen",
    "-a",
    "never",
    "-s",
    "read-only",
    "-C",
    input.projectDirectory,
    `Reply with exactly ${input.marker}.`
  ]
    .map(shellQuote)
    .join(" ");
  await runFile(
    "tmux",
    [
      "-S",
      input.tmuxSocketPath,
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-x",
      "140",
      "-y",
      "50",
      "-s",
      "native",
      command
    ],
    { cwd: input.projectDirectory, env: environment }
  );
  await runFile(
    "tmux",
    ["-S", input.tmuxSocketPath, "set-option", "-g", "remain-on-exit", "on"],
    { env: environment }
  );
  let trustAccepted = false;
  let output = "";
  await waitFor(
    async () => {
      output = await captureTmux(
        input.tmuxSocketPath,
        "native:0.0",
        environment
      );
      await assertTmuxPaneAlive(
        input.tmuxSocketPath,
        "native:0.0",
        environment,
        output
      );
      if (
        output.includes("Do you trust the contents of this directory?") &&
        !trustAccepted
      ) {
        trustAccepted = true;
        await runFile(
          "tmux",
          ["-S", input.tmuxSocketPath, "send-keys", "-t", "native:0.0", "Enter"],
          { env: environment }
        );
        return false;
      }
      return (
        output.includes("OpenAI Codex") &&
        countOccurrences(output, input.marker) >= 2 &&
        output.slice(output.lastIndexOf(input.marker)).includes("\n\n› ")
      );
    },
    90_000,
    () =>
      `Standalone Codex turn did not complete (bytes=${Buffer.byteLength(output, "utf8")}, trust=${String(trustAccepted)}).`
  );
  const threadId = await waitForNativeThreadId(input.codexHome);
  await stopInteractiveTmux(
    input.tmuxSocketPath,
    "native:0.0",
    environment
  );
  return threadId;
}

async function inspectResumedTui(input: {
  readonly codexHome: string;
  readonly expectedText: string;
  readonly launch: ReturnType<typeof selectedResumeLaunchSchema.parse>;
  readonly projectDirectory: string;
  readonly tmuxSocketPath: string;
}): Promise<void> {
  const environment = codexEnvironment(input.codexHome);
  const threadId = input.launch.args.at(-1);
  if (threadId === undefined) {
    throw new Error("Resume launch descriptor lost its native thread id.");
  }
  const args = [
    ...input.launch.args.slice(0, -1),
    "--no-alt-screen",
    threadId
  ];
  const command = [input.launch.executable, ...args]
    .map(shellQuote)
    .join(" ");
  await runFile(
    "tmux",
    [
      "-S",
      input.tmuxSocketPath,
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-x",
      "140",
      "-y",
      "50",
      "-s",
      "resumed",
      command
    ],
    { cwd: input.projectDirectory, env: environment }
  );
  await runFile(
    "tmux",
    ["-S", input.tmuxSocketPath, "set-option", "-g", "remain-on-exit", "on"],
    { env: environment }
  );
  let output = "";
  await waitFor(
    async () => {
      output = await captureTmux(
        input.tmuxSocketPath,
        "resumed:0.0",
        environment
      );
      await assertTmuxPaneAlive(
        input.tmuxSocketPath,
        "resumed:0.0",
        environment,
        output
      );
      return (
        output.includes("OpenAI Codex") &&
        output.includes(input.expectedText) &&
        output.includes(basename(input.projectDirectory))
      );
    },
    20_000,
    () =>
      `Resumed Codex TUI did not render shared history (bytes=${Buffer.byteLength(output, "utf8")}, state=${classifyTuiDiagnostic(output, input)}).`
  );
  await stopInteractiveTmux(
    input.tmuxSocketPath,
    "resumed:0.0",
    environment
  );
}

function classifyTuiDiagnostic(
  output: string,
  input: {
    readonly expectedText: string;
    readonly projectDirectory: string;
  }
): string {
  const states = [
    output.trim() === "" ? "blank" : null,
    output.includes("Update available!") ? "update_prompt" : null,
    output.includes("Do you trust the contents of this directory?")
      ? "trust_prompt"
      : null,
    output.includes("OpenAI Codex") ? "tui_ready" : null,
    output.includes(input.expectedText) ? "history_marker_present" : null,
    output.includes(basename(input.projectDirectory))
      ? "cwd_label_present"
      : null
  ].filter((state): state is string => state !== null);
  return states.length === 0 ? "unclassified" : states.join(",");
}

async function stopInteractiveTmux(
  socketPath: string,
  target: string,
  environment: NodeJS.ProcessEnv
): Promise<void> {
  try {
    await runFile(
      "tmux",
      ["-S", socketPath, "send-keys", "-t", target, "C-d"],
      { env: environment }
    );
  } catch {
    // Teardown below still owns the isolated tmux server.
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  await closeTmux(socketPath, environment.CODEX_HOME ?? "");
}

async function closeTmux(
  socketPath: string,
  codexHome: string
): Promise<void> {
  if (!existsSync(socketPath)) return;
  const environment = codexEnvironment(codexHome);
  try {
    await runFile("tmux", ["-S", socketPath, "kill-server"], {
      env: environment
    });
  } catch (error) {
    if (await tmuxServerReachable(socketPath, environment)) throw error;
  }
  await waitFor(
    async () => !(await tmuxServerReachable(socketPath, environment)),
    5_000,
    () => "Isolated tmux server remained after teardown."
  );
  if (!existsSync(socketPath)) return;
  const metadata = lstatSync(socketPath);
  if (!metadata.isSocket()) {
    throw new Error("Isolated tmux socket path changed identity during teardown.");
  }
  unlinkSync(socketPath);
}

async function tmuxServerReachable(
  socketPath: string,
  environment: NodeJS.ProcessEnv
): Promise<boolean> {
  if (!existsSync(socketPath)) return false;
  try {
    await runFile("tmux", ["-S", socketPath, "list-sessions"], {
      env: environment,
      timeoutMs: 1_000
    });
    return true;
  } catch {
    return false;
  }
}

async function captureTmux(
  socketPath: string,
  target: string,
  environment: NodeJS.ProcessEnv
): Promise<string> {
  return (
    await runFile(
      "tmux",
      ["-S", socketPath, "capture-pane", "-p", "-t", target, "-S", "-1000"],
      { env: environment }
    )
  ).stdout;
}

async function assertTmuxPaneAlive(
  socketPath: string,
  target: string,
  environment: NodeJS.ProcessEnv,
  output: string
): Promise<void> {
  const pane = (
    await runFile(
      "tmux",
      ["-S", socketPath, "display-message", "-p", "-t", target, "#{pane_dead} #{pane_dead_status}"],
      { env: environment }
    )
  ).stdout.trim();
  if (pane.startsWith("1 ")) {
    throw new Error(
      `Codex TUI exited before inspection (${pane}, bytes=${Buffer.byteLength(output, "utf8")}).`
    );
  }
}

async function waitForNativeThreadId(codexHome: string): Promise<string> {
  let found: string | null = null;
  await waitFor(
    async () => {
      const sessions = join(codexHome, "sessions");
      if (!existsSync(sessions)) return false;
      const files = await listFilesRecursively(sessions);
      const ids = files
        .map(
          (file) =>
            /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/u.exec(
              file
            )?.[1] ?? null
        )
        .filter((id): id is string => id !== null);
      if (ids.length !== 1) return false;
      found = ids[0] ?? null;
      return found !== null;
    },
    10_000,
    () => "Standalone Codex TUI did not persist exactly one native thread."
  );
  if (found === null) throw new Error("Native Codex thread id was not found.");
  return found;
}

async function listFilesRecursively(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    const entries = await import("node:fs/promises").then(({ readdir }) =>
      readdir(directory, { withFileTypes: true })
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  return files;
}

function createProductionWebFixture(buildRoot: string): void {
  writeProductionWebTestFixture(buildRoot, {
    browserRoutes: hostDeckProductionBrowserRoutes,
    indexBody:
      '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content"><meta name="theme-color" content="#121313"><meta name="hostdeck-package-version" content="0.0.0"><title>HostDeck</title><script type="module" src="/assets/app-ABC123xy.js"></script></head><body><div id="root"></div>NATIVE_INTEROPERABILITY_SMOKE</body></html>\n'
  });
}

function seedPhoneAuthority(databasePath: string): void {
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const opened = openMigratedDatabase(databasePath);
  try {
    createAuthDeviceRepository(opened.db).create({
      id: "device:native:interoperability",
      rawDeviceToken,
      rawCsrfToken,
      permission: "write",
      clientLabel: "Android phone",
      createdAt: new Date()
    });
  } finally {
    opened.db.close();
  }
  chmodSync(databasePath, 0o600);
}

async function waitForDiscovery(origin: string, threadId: string) {
  let diagnostic = "not attempted";
  await waitFor(
    async () => {
      const cli = await runCli(
        ["--api-url", origin, "discover", "--limit", "20", "--json"],
        { env: {} }
      );
      diagnostic = `exit=${cli.exitCode} stderr_bytes=${Buffer.byteLength(cli.stderr, "utf8")}`;
      if (cli.exitCode !== cliExitCodes.ok) return false;
      const result = nativeSessionDiscoveryResponseSchema.parse(
        JSON.parse(cli.stdout)
      );
      return result.threads.some((thread) => thread.thread_id === threadId);
    },
    15_000,
    () => `Native Codex thread was not discoverable (${diagnostic}).`
  );
  const finalCli = await runCli(
    ["--api-url", origin, "discover", "--limit", "20", "--json"],
    { env: {} }
  );
  if (finalCli.exitCode !== cliExitCodes.ok) {
    throw new Error("Native discovery result could not be read after polling.");
  }
  const result = nativeSessionDiscoveryResponseSchema.parse(
    JSON.parse(finalCli.stdout)
  );
  return {
    ...result,
    threads: result.threads.filter((thread) => thread.thread_id === threadId)
  };
}

async function readPhoneSessionList(origin: string) {
  const response = await fetch(`${origin}/api/v1/sessions`, {
    headers: phoneReadHeaders()
  });
  expect(response.status).toBe(200);
  return selectedSessionListResponseSchema.parse(await response.json());
}

async function readPhoneSessionDetail(origin: string, sessionId: string) {
  const response = await fetch(
    `${origin}/api/v1/sessions/${encodeURIComponent(sessionId)}`,
    { headers: phoneReadHeaders() }
  );
  expect(response.status).toBe(200);
  return selectedSessionDetailResponseSchema.parse(await response.json());
}

async function readPhoneEventPage(origin: string, sessionId: string) {
  const response = await fetch(
    `${origin}/api/v1/sessions/${encodeURIComponent(sessionId)}/events?limit=100`,
    { headers: phoneReadHeaders() }
  );
  expect(response.status).toBe(200);
  return selectedEventPageResponseSchema.parse(await response.json());
}

function phoneReadHeaders(accept = "application/json") {
  return {
    accept,
    "cache-control": "no-store",
    cookie: `${hostDeckDeviceCookieName}=${rawDeviceToken}`
  };
}

async function readTurnFromSse(input: {
  readonly after: number;
  readonly marker: string;
  readonly response: Response;
  readonly sessionId: string;
  readonly turnId: string;
}): Promise<{
  readonly agentMarkerSeen: boolean;
  readonly cursors: readonly number[];
  readonly turnStates: readonly string[];
}> {
  const body = input.response.body;
  if (body === null) throw new Error("Phone event stream has no body.");
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffered = "";
  let bytes = 0;
  let previousCursor = input.after;
  let agentMarkerSeen = false;
  const cursors: number[] = [];
  const turnStates: string[] = [];
  try {
    while (cursors.length < 1_000 && bytes <= 2 * 1_024 * 1_024) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      buffered += decoder.decode(chunk.value, { stream: true });
      let boundary = buffered.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffered.slice(0, boundary).replaceAll("\r", "");
        buffered = buffered.slice(boundary + 2);
        const event = parseSseEvent(block);
        if (event !== null) {
          expect(event.session_id).toBe(input.sessionId);
          expect(event.cursor).toBeGreaterThan(previousCursor);
          previousCursor = event.cursor;
          cursors.push(event.cursor);
          if (
            event.type === "turn" &&
            event.turn_id === input.turnId
          ) {
            turnStates.push(event.state);
          }
          if (
            event.type === "message" &&
            event.role === "agent" &&
            event.phase === "completed" &&
            event.text.includes(input.marker)
          ) {
            agentMarkerSeen = true;
          }
          if (
            agentMarkerSeen &&
            turnStates.includes("in_progress") &&
            turnStates.at(-1) === "completed"
          ) {
            return { agentMarkerSeen, cursors, turnStates };
          }
        }
        boundary = buffered.indexOf("\n\n");
      }
    }
    throw new Error(
      `Phone event stream ended before turn completion (events=${cursors.length}, bytes=${bytes}).`
    );
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function parseSseEvent(block: string): SelectedProjectionEvent | null {
  if (block === "" || block.startsWith(":")) return null;
  let id: string | null = null;
  let eventType: string | null = null;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("id: ")) id = line.slice(4);
    else if (line.startsWith("event: ")) eventType = line.slice(7);
    else if (line.startsWith("data: ")) data.push(line.slice(6));
  }
  if (id === null || eventType === null || data.length === 0) {
    throw new Error("Phone event stream emitted a malformed SSE block.");
  }
  const event = selectedProjectionEventSchema.parse(JSON.parse(data.join("\n")));
  if (String(event.cursor) !== id || event.type !== eventType) {
    throw new Error("Phone event stream metadata contradicted its event body.");
  }
  return event;
}

function codexEnvironment(codexHome: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CODEX_HOME: codexHome,
    TERM: "xterm-256color"
  };
}

function availableLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Expected an IPv4 loopback test address."));
        return;
      }
      server.close((error) => {
        if (error === undefined) resolvePort(address.port);
        else reject(error);
      });
    });
  });
}

function startServiceAppServer(input: {
  readonly codexBin: string;
  readonly codexHome: string;
  readonly socketPath: string;
}): ChildProcess {
  return spawn(
    input.codexBin,
    ["app-server", "--listen", `unix://${input.socketPath}`],
    {
      cwd: "/",
      env: codexEnvironment(input.codexHome),
      stdio: ["ignore", "ignore", "ignore"]
    }
  );
}

async function waitForAppServerSocket(
  socketPath: string,
  child: ChildProcess
): Promise<void> {
  await waitFor(
    () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error("Service-owned Codex app-server exited before readiness.");
      }
      if (!existsSync(socketPath)) return false;
      const metadata = lstatSync(socketPath);
      if (!metadata.isSocket() || metadata.nlink !== 1) {
        throw new Error("Service-owned Codex endpoint is not one Unix socket.");
      }
      return true;
    },
    20_000,
    () => "Service-owned Codex app-server socket did not become ready."
  );
}

function socketIdentity(socketPath: string): string {
  const metadata = lstatSync(socketPath);
  if (!metadata.isSocket() || metadata.nlink !== 1) {
    throw new Error("Service-owned Codex endpoint changed identity.");
  }
  return `${metadata.dev}:${metadata.ino}`;
}

async function stopServiceAppServer(
  child: ChildProcess,
  socketPath: string
): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
  }
  try {
    await waitForChildExit(child, 10_000);
  } catch {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await waitForChildExit(child, 5_000);
  }
  await waitFor(
    () => !existsSync(socketPath),
    5_000,
    () => "Service-owned Codex app-server socket remained after shutdown."
  );
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolvePromise, reject) => {
    let settled = false;
    const onClose = () => settle();
    const onError = () =>
      settle(new Error("Service-owned Codex app-server process failed."));
    const timeout = setTimeout(
      () => settle(new Error("Service-owned Codex app-server did not stop.")),
      timeoutMs
    );
    timeout.unref();
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off("close", onClose);
      child.off("error", onError);
      if (error === undefined) resolvePromise();
      else reject(error);
    };
    child.once("close", onClose);
    child.once("error", onError);
  });
}

async function runFile(
  executable: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
  } = {}
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(executable, [...args], {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${executable} timed out.`));
    }, options.timeoutMs ?? 10_000);
    timeout.unref();
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = boundedOutput(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = boundedOutput(stderr, chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        reject(
          new Error(
            `${executable} exited with ${code ?? signal ?? "unknown"} (stdout_bytes=${Buffer.byteLength(stdout, "utf8")}, stderr_bytes=${Buffer.byteLength(stderr, "utf8")}).`
          )
        );
      }
    });
  });
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  timeoutMessage: () => string
): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error(timeoutMessage());
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
        timeout.unref();
      })
    ]);
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}

async function collectCleanup(
  operation: Promise<unknown>,
  errors: unknown[]
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    errors.push(error);
  }
}

function countOccurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function boundedOutput(current: string, chunk: Buffer): string {
  const combined = current + chunk.toString("utf8");
  return combined.length <= 64 * 1_024
    ? combined
    : combined.slice(-(64 * 1_024));
}
