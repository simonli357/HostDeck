import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, copyFile, lstat, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexBindingDescriptor } from "./binding.js";
import { parseCodexCliVersionOutput } from "./compatibility.js";
import { createCodexAppServerConnection } from "./connection.js";
import { createCodexThreadClient } from "./thread-client.js";
import { createCodexUnixWebSocketTransport } from "./transport.js";
import { buildCodexTuiResumeCommand } from "./tui-resume.js";

const requireSmoke = process.env.HOSTDECK_REQUIRE_CODEX_THREAD_SMOKE === "1";
const codexBin = process.env.HOSTDECK_CODEX_BIN ?? "codex";

describe.skipIf(!requireSmoke)("installed Codex managed-thread lifecycle smoke", () => {
  it(
    "starts, lists, reads, resumes, and archives one exact no-turn thread",
    async () => {
      const version = parseCodexCliVersionOutput(
        execFileSync(codexBin, ["--version"], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 })
      );
      expect(version).toBe(codexBindingDescriptor.codex_version);

      const root = await mkdtemp(join(tmpdir(), "hostdeck-thread-smoke-"));
      const runtimeDirectory = join(root, "runtime");
      const codexHome = join(root, "codex-home");
      const projectDirectory = join(root, "project");
      const socketPath = join(runtimeDirectory, "app.sock");
      const tuiSocketPath = join(runtimeDirectory, "tui-tmux.sock");
      await Promise.all([
        mkdir(runtimeDirectory, { mode: 0o700 }),
        mkdir(codexHome, { mode: 0o700 }),
        mkdir(projectDirectory, { mode: 0o700 })
      ]);
      try {
        await seedCodexAuthentication(codexHome);
        execFileSync("git", ["init", "-q", "-b", "main", projectDirectory], { timeout: 10_000 });
      } catch (error) {
        await rm(root, { recursive: true, force: true });
        throw error;
      }

      const child = spawn(codexBin, ["app-server", "--listen", `unix://${socketPath}`], {
        env: { ...process.env, CODEX_HOME: codexHome },
        stdio: ["ignore", "ignore", "pipe"]
      });
      let appServerStderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        appServerStderr = boundedOutput(appServerStderr, chunk);
      });

      const observedNotificationMethods: string[] = [];
      const connection = createCodexAppServerConnection({
        transport: createCodexUnixWebSocketTransport({ socket_path: socketPath }),
        observed_version: version,
        on_notification: (message) => observedNotificationMethods.push(message.method)
      });
      let tui: TuiProbe | null = null;
      let lifecycleError: Error | null = null;
      try {
        await waitForSocket(socketPath, child, () => appServerStderr);
        expect((await stat(runtimeDirectory)).mode & 0o077).toBe(0);
        expect((await stat(codexHome)).mode & 0o077).toBe(0);
        expect((await lstat(socketPath)).isSocket()).toBe(true);
        await connection.connect();

        const threads = createCodexThreadClient(connection);
        const operationId = "op_real_thread_smoke_0001";
        const started = await threads.start({ operation_id: operationId, cwd: projectDirectory });
        expect(started).toMatchObject({
          thread: {
            cwd: projectDirectory,
            source: "vscode",
            thread_source: `hostdeck:${operationId}`,
            archived: null
          }
        });
        await expect(threads.findByOperationId(operationId)).resolves.toMatchObject([
          {
            id: started.thread.id,
            cwd: projectDirectory,
            thread_source: `hostdeck:${operationId}`,
            archived: null
          }
        ]);
        await expect(
          threads.ensureMaterialized({
            thread_id: started.thread.id,
            operation_id: operationId,
            cwd: projectDirectory,
            name: "hostdeck-lifecycle-smoke"
          })
        ).resolves.toMatchObject({
          id: started.thread.id,
          cwd: projectDirectory,
          name: "hostdeck-lifecycle-smoke",
          thread_source: null,
          archived: false
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
        const materializedRead = await connection.request({
          method: "thread/read",
          params: { threadId: started.thread.id, includeTurns: true },
          kind: "read"
        });
        expect(materializedRead).toMatchObject({
          thread: { id: started.thread.id, status: { type: "idle" }, turns: [] }
        });
        expect(observedNotificationMethods).not.toContain("turn/started");
        expect(observedNotificationMethods).not.toContain("thread/tokenUsage/updated");
        expect(observedNotificationMethods).not.toContain("item/agentMessage/delta");
        const activeBeforeResume = await threads.list({ archived: false, limit: 100 });
        expect(activeBeforeResume.data.filter((thread) => thread.id === started.thread.id)).toHaveLength(1);
        await expect(threads.read(started.thread.id)).resolves.toMatchObject({
          id: started.thread.id,
          cwd: projectDirectory,
          name: "hostdeck-lifecycle-smoke",
          thread_source: null
        });

        const command = buildCodexTuiResumeCommand({
          socket_path: socketPath,
          thread_id: started.thread.id,
          codex_bin: codexBin
        });
        tui = await startAndInspectTui(command, codexHome, projectDirectory, tuiSocketPath);
        expect(tui.output).toContain("OpenAI Codex");
        expect(tui.output).toContain(basename(projectDirectory));
        await tui.close();
        tui = null;
        await expect(threads.read(started.thread.id)).resolves.toMatchObject({ id: started.thread.id });
        const activeAfterResume = await threads.list({ archived: false, limit: 100 });
        expect(activeAfterResume.data.filter((thread) => thread.id === started.thread.id)).toHaveLength(1);

        await threads.archive(started.thread.id);
        expect((await threads.list({ archived: false, limit: 100 })).data.some((thread) => thread.id === started.thread.id)).toBe(false);
        expect((await threads.list({ archived: true, limit: 100 })).data.filter((thread) => thread.id === started.thread.id)).toHaveLength(1);
      } catch (error) {
        lifecycleError = new Error(
          `Real Codex thread lifecycle failed (app_server_exit=${child.exitCode ?? "running"}, stderr=${appServerStderr || "empty"}).`,
          { cause: error }
        );
      }
      const cleanupErrors: unknown[] = [];
      if (tui !== null) await collectCleanupError(tui.close(), cleanupErrors);
      await collectCleanupError(connection.close("HostDeck thread lifecycle smoke completed."), cleanupErrors);
      await collectCleanupError(stopChild(child), cleanupErrors);
      await collectCleanupError(rm(root, { recursive: true, force: true }), cleanupErrors);
      if (lifecycleError !== null && cleanupErrors.length > 0) {
        throw new AggregateError([lifecycleError, ...cleanupErrors], "Codex thread lifecycle and cleanup failed.");
      }
      if (lifecycleError !== null) throw lifecycleError;
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Codex thread lifecycle cleanup failed.");
    },
    30_000
  );
});

async function startAndInspectTui(
  command: ReturnType<typeof buildCodexTuiResumeCommand>,
  codexHome: string,
  projectDirectory: string,
  tmuxSocketPath: string
): Promise<TuiProbe> {
  const threadId = command.args.at(-1);
  if (threadId === undefined) throw new Error("TUI resume command is missing its exact thread id.");
  const args = [...command.args.slice(0, -1), "--no-alt-screen", threadId];
  const shellCommand = [command.executable, ...args].map(shellQuote).join(" ");
  const environment = { ...process.env, CODEX_HOME: codexHome, TERM: "xterm-256color" };
  let output = "";
  let running = false;
  try {
    await runFile(
      "tmux",
      [
        "-S",
        tmuxSocketPath,
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-x",
        "120",
        "-y",
        "40",
        "-s",
        "hostdeck-tui"
      ],
      { cwd: projectDirectory, env: environment }
    );
    running = true;
    await runFile("tmux", ["-S", tmuxSocketPath, "set-option", "-g", "remain-on-exit", "on"], {
      env: environment
    });
    await runFile(
      "tmux",
      ["-S", tmuxSocketPath, "respawn-pane", "-k", "-t", "hostdeck-tui:0.0", shellCommand],
      { cwd: projectDirectory, env: environment }
    );
    await waitFor(
      async () => {
        output = (
          await runFile(
            "tmux",
            ["-S", tmuxSocketPath, "capture-pane", "-p", "-t", "hostdeck-tui:0.0", "-S", "-1000"],
            { env: environment }
          )
        ).stdout;
        const pane = (
          await runFile(
            "tmux",
            ["-S", tmuxSocketPath, "display-message", "-p", "-t", "hostdeck-tui:0.0", "#{pane_dead} #{pane_dead_status}"],
            { env: environment }
          )
        ).stdout.trim();
        if (pane.startsWith("1 ")) throw new Error(`Codex TUI exited (${pane}): ${output || "empty"}`);
        return output.includes("OpenAI Codex") && output.includes(basename(projectDirectory));
      },
      8_000,
      () => `TUI did not render the expected thread view before timeout: ${output || "empty"}`
    );
    return {
      output,
      async close() {
        if (!running) return;
        await stopTmuxServer(tmuxSocketPath, environment);
        running = false;
      }
    };
  } catch (error) {
    try {
      if (running) await stopTmuxServer(tmuxSocketPath, environment);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Codex TUI inspection and cleanup both failed.");
    }
    throw error;
  }
}

interface TuiProbe {
  readonly output: string;
  readonly close: () => Promise<void>;
}

async function stopTmuxServer(tmuxSocketPath: string, environment: NodeJS.ProcessEnv): Promise<void> {
  await runFile("tmux", ["-S", tmuxSocketPath, "kill-server"], { env: environment });
}

async function waitForSocket(socketPath: string, child: ChildProcess, readStderr: () => string): Promise<void> {
  await waitFor(
    async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Codex app-server exited before creating its Unix socket: ${readStderr()}`);
      }
      try {
        return (await lstat(socketPath)).isSocket();
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        return false;
      }
    },
    5_000,
    () => `Codex app-server did not create its Unix socket: ${readStderr()}`
  );
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  timeoutMessage: () => string
): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error(timeoutMessage());
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").then(() => undefined);
  child.kill("SIGTERM");
  if (await settlesWithin(exited, 2_000)) return;
  child.kill("SIGKILL");
  if (!(await settlesWithin(exited, 1_000))) throw new Error("Codex app-server did not exit after SIGKILL.");
}

async function settlesWithin(promise: Promise<void>, milliseconds: number): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  const expired = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), milliseconds);
    timeout.unref();
  });
  const settled = await Promise.race([promise.then(() => true as const), expired]);
  if (timeout !== undefined) clearTimeout(timeout);
  return settled;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function boundedOutput(current: string, chunk: Buffer): string {
  return `${current}${chunk.toString("utf8")}`.slice(-32_000);
}

async function seedCodexAuthentication(codexHome: string): Promise<void> {
  const sourceHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const source = join(sourceHome, "auth.json");
  const sourceMetadata = await lstat(source);
  if (!sourceMetadata.isFile() || (sourceMetadata.mode & 0o077) !== 0) {
    throw new Error("Installed Codex authentication must be a private regular auth.json file for the TUI smoke.");
  }
  const destination = join(codexHome, "auth.json");
  await copyFile(source, destination);
  await chmod(destination, 0o600);
  const destinationMetadata = await lstat(destination);
  if (!destinationMetadata.isFile() || (destinationMetadata.mode & 0o077) !== 0) {
    throw new Error("Temporary Codex authentication copy is not private.");
  }
}

async function runFile(
  executable: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv }
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
      settled = true;
      reject(new Error(`${executable} timed out.`));
    }, 5_000);
    timeout.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = boundedOutput(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = boundedOutput(stderr, chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`Unable to start ${executable}.`, { cause: error }));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${executable} exited with ${code ?? signal ?? "unknown"}: ${stderr || stdout || "empty"}`));
    });
  });
}

async function collectCleanupError(operation: Promise<unknown>, errors: unknown[]): Promise<void> {
  try {
    await operation;
  } catch (error) {
    errors.push(error);
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
