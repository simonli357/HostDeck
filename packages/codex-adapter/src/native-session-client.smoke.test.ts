import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexBindingDescriptor } from "./binding.js";
import type { CodexRequestInput } from "./broker.js";
import { parseCodexCliVersionOutput } from "./compatibility.js";
import { createCodexAppServerConnection } from "./connection.js";
import { createCodexNativeSessionClient } from "./native-session-client.js";
import { createCodexUnixWebSocketTransport } from "./transport.js";

const requireSmoke = process.env.HOSTDECK_REQUIRE_NATIVE_SESSION_ADAPTER_SMOKE === "1";
const configuredCodexBin = process.env.HOSTDECK_CODEX_BIN ?? join(process.cwd(), "node_modules", ".bin", "codex");
const fakeAuthenticationFixture = process.env.HOSTDECK_CODEX_FAKE_AUTH_FIXTURE;

describe.skipIf(!requireSmoke)("installed Codex native-session adapter smoke", () => {
  it(
    "reads and resumes one closed shell-only native CLI thread by unchanged id without a model turn",
    async () => {
      const codexBin = resolveCodexExecutable(configuredCodexBin);
      const version = parseCodexCliVersionOutput(
        execFileSync(codexBin, ["--version"], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 })
      );
      expect(version).toBe(codexBindingDescriptor.codex_version);

      const root = await mkdtemp(join(tmpdir(), "hostdeck-native-adapter-smoke-"));
      const runtimeDirectory = join(root, "runtime");
      const codexHome = join(root, "codex-home");
      const projectDirectory = join(root, "project");
      const socketPath = join(runtimeDirectory, "app.sock");
      const tmuxSocketPath = join(runtimeDirectory, "native-tui.sock");
      let appServer: ChildProcess | null = null;
      let connection: ReturnType<typeof createCodexAppServerConnection> | null = null;
      let tuiStarted = false;
      const cleanupErrors: unknown[] = [];
      let smokeError: Error | null = null;

      try {
        await Promise.all([
          mkdir(runtimeDirectory, { mode: 0o700 }),
          mkdir(codexHome, { mode: 0o700 }),
          mkdir(projectDirectory, { mode: 0o700 })
        ]);
        await seedCodexAuthentication(codexHome);
        execFileSync("git", ["init", "-q", "-b", "main", projectDirectory], { timeout: 10_000 });
        await startNativeTui(codexBin, codexHome, projectDirectory, tmuxSocketPath);
        tuiStarted = true;
        const threadId = await waitForNativeThreadId(codexHome);
        await stopNativeTui(tmuxSocketPath, codexHome);
        tuiStarted = false;

        appServer = spawn(codexBin, ["app-server", "--listen", `unix://${socketPath}`], {
          env: { ...process.env, CODEX_HOME: codexHome },
          stdio: ["ignore", "ignore", "pipe"]
        });
        let stderr = "";
        appServer.stderr?.on("data", (chunk: Buffer) => {
          stderr = boundedOutput(stderr, chunk);
        });
        await waitForSocket(socketPath, appServer, () => stderr);
        connection = createCodexAppServerConnection({
          transport: createCodexUnixWebSocketTransport({ socket_path: socketPath }),
          observed_version: version
        });
        await connection.connect();

        const requests: CodexRequestInput[] = [];
        const native = createCodexNativeSessionClient({
          get compatibility() {
            return connection?.compatibility ?? (() => { throw new Error("Connection unavailable."); })();
          },
          async request(input) {
            requests.push(input);
            if (connection === null) throw new Error("Connection unavailable.");
            return connection.request(input);
          }
        });
        const discovery = await native.discover({ limit: 100 });
        expect(discovery.threads.some((thread) => thread.thread_id === threadId)).toBe(false);
        await expect(native.readIdentity(threadId)).resolves.toMatchObject({
          thread_id: threadId,
          cwd: projectDirectory,
          source: "cli",
          runtime_version: version,
          archived: false,
          ephemeral: false,
          parent_thread_id: null,
          forked_from_id: null
        });
        await expect(native.resume(threadId)).resolves.toMatchObject({
          thread: { thread_id: threadId, cwd: projectDirectory, source: "cli" }
        });
        expect(requests.map(({ method }) => method)).toEqual([
          "thread/list",
          "thread/read",
          "thread/resume"
        ]);
        expect(requests.every(({ kind }) => kind === "read")).toBe(true);
      } catch (error) {
        smokeError = new Error("Real native Codex session adapter smoke failed.", { cause: error });
      }

      if (tuiStarted) await collectCleanupError(stopNativeTui(tmuxSocketPath, codexHome), cleanupErrors);
      if (connection !== null) {
        await collectCleanupError(connection.close("Native session adapter smoke completed."), cleanupErrors);
      }
      if (appServer !== null) await collectCleanupError(stopChild(appServer), cleanupErrors);
      await collectCleanupError(waitForSocketRemoval(socketPath), cleanupErrors);
      await collectCleanupError(rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }), cleanupErrors);
      if (smokeError !== null && cleanupErrors.length > 0) {
        throw new AggregateError([smokeError, ...cleanupErrors], "Native adapter smoke and cleanup failed.");
      }
      if (smokeError !== null) throw smokeError;
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Native adapter smoke cleanup failed.");
    },
    30_000
  );
});

async function startNativeTui(
  codexBin: string,
  codexHome: string,
  projectDirectory: string,
  tmuxSocketPath: string
): Promise<void> {
  const environment = { ...process.env, CODEX_HOME: codexHome, TERM: "xterm-256color" };
  let lastOutput = "";
  let lastPane = "unknown";
  let trustAccepted = false;
  let shellOutput = "";
  await runFile("tmux", ["-S", tmuxSocketPath, "-f", "/dev/null", "new-session", "-d", "-x", "120", "-y", "40", "-s", "native"], {
    cwd: projectDirectory,
    env: environment
  });
  await runFile("tmux", ["-S", tmuxSocketPath, "set-option", "-g", "remain-on-exit", "on"], { env: environment });
  const command = [codexBin, "--no-alt-screen", "-C", projectDirectory].map(shellQuote).join(" ");
  await runFile("tmux", ["-S", tmuxSocketPath, "respawn-pane", "-k", "-t", "native:0.0", command], {
    cwd: projectDirectory,
    env: environment
  });
  await waitFor(
    async () => {
      lastOutput = (await runFile("tmux", ["-S", tmuxSocketPath, "capture-pane", "-p", "-t", "native:0.0", "-S", "-200"], {
        env: environment
      })).stdout;
      lastPane = (await runFile("tmux", ["-S", tmuxSocketPath, "display-message", "-p", "-t", "native:0.0", "#{pane_dead} #{pane_dead_status}"], {
        env: environment
      })).stdout.trim();
      if (lastPane.startsWith("1 ")) throw new Error(`Native Codex TUI exited (${lastPane}): ${lastOutput || "empty"}`);
      if (lastOutput.includes("Do you trust the contents of this directory?") && !trustAccepted) {
        trustAccepted = true;
        await runFile("tmux", ["-S", tmuxSocketPath, "send-keys", "-t", "native:0.0", "Enter"], { env: environment });
        return false;
      }
      return trustAccepted && lastOutput.includes("OpenAI Codex") && lastOutput.includes("/project");
    },
    8_000,
    () => `Native Codex TUI did not render before timeout (pane=${lastPane}): ${lastOutput || "empty"}`
  );
  for (const key of "!pwd") {
    await runFile("tmux", ["-S", tmuxSocketPath, "send-keys", "-l", "-t", "native:0.0", key], {
      env: environment
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await waitFor(
    async () => {
      shellOutput = (await runFile("tmux", ["-S", tmuxSocketPath, "capture-pane", "-p", "-t", "native:0.0", "-S", "-200"], {
        env: environment
      })).stdout;
      return shellOutput.includes("! pwd") && shellOutput.includes("Shell mode");
    },
    5_000,
    () => `Native Codex local shell command did not render before timeout: ${shellOutput || "empty"}`
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  await runFile("tmux", ["-S", tmuxSocketPath, "send-keys", "-t", "native:0.0", "Enter"], {
    env: environment
  });
  await waitFor(
    async () => {
      shellOutput = (await runFile("tmux", ["-S", tmuxSocketPath, "capture-pane", "-p", "-t", "native:0.0", "-S", "-200"], {
        env: environment
      })).stdout;
      return shellOutput.includes("You ran pwd");
    },
    5_000,
    () => `Native Codex local shell action did not complete before timeout: ${shellOutput || "empty"}`
  );
}

async function stopNativeTui(tmuxSocketPath: string, codexHome: string): Promise<void> {
  const environment = { ...process.env, CODEX_HOME: codexHome, TERM: "xterm-256color" };
  await runFile("tmux", ["-S", tmuxSocketPath, "kill-server"], { env: environment });
}

async function waitForNativeThreadId(codexHome: string): Promise<string> {
  let found: string | null = null;
  await waitFor(
    async () => {
      const sessions = join(codexHome, "sessions");
      try {
        const entries = await readdir(sessions, { recursive: true });
        const ids = entries
          .map((entry) => /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/u.exec(entry)?.[1] ?? null)
          .filter((entry): entry is string => entry !== null);
        if (ids.length !== 1) return false;
        found = ids[0] as string;
        return true;
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        return false;
      }
    },
    5_000,
    () => "Native Codex TUI did not persist exactly one thread."
  );
  if (found === null) throw new Error("Native Codex thread id was not found.");
  return found;
}

function resolveCodexExecutable(candidate: string): string {
  const resolved = isAbsolute(candidate) ? candidate : execFileSync("which", [candidate], { encoding: "utf8" }).trim();
  if (!isAbsolute(resolved)) throw new Error("Codex smoke executable must resolve to an absolute path.");
  return resolved;
}

async function seedCodexAuthentication(codexHome: string): Promise<void> {
  if (fakeAuthenticationFixture !== undefined && fakeAuthenticationFixture !== "1") {
    throw new Error("Codex smoke fake-auth fixture setting is invalid.");
  }
  const destination = join(codexHome, "auth.json");
  if (fakeAuthenticationFixture === "1") {
    await writeFile(destination, `${JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "hostdeck-ci-fixture-not-a-key" })}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
  } else {
    const source = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
    const metadata = await lstat(source);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) throw new Error("Codex auth source must be a private regular file.");
    await copyFile(source, destination);
    await chmod(destination, 0o600);
  }
  const metadata = await stat(destination);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) throw new Error("Temporary Codex auth copy is not private.");
}

async function waitForSocket(socketPath: string, child: ChildProcess, readStderr: () => string): Promise<void> {
  await waitFor(
    async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Codex app-server exited before socket creation: ${readStderr() || "empty"}`);
      }
      try {
        return (await lstat(socketPath)).isSocket();
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        return false;
      }
    },
    5_000,
    () => `Codex app-server did not create its socket: ${readStderr() || "empty"}`
  );
}

async function waitForSocketRemoval(socketPath: string): Promise<void> {
  await waitFor(
    async () => {
      try {
        await lstat(socketPath);
        return false;
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        return true;
      }
    },
    10_000,
    () => "Codex app-server did not remove its socket."
  );
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").then(() => undefined);
  child.kill("SIGTERM");
  if (await settlesWithin(exited, 2_000)) return;
  child.kill("SIGKILL");
  if (!(await settlesWithin(exited, 1_000))) throw new Error("Codex app-server did not exit after SIGKILL.");
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
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${executable} timed out.`));
    }, 5_000);
    timeout.unref();
    child.stdout.on("data", (chunk: Buffer) => { stdout = boundedOutput(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = boundedOutput(stderr, chunk); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
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

async function collectCleanupError(operation: Promise<unknown>, errors: unknown[]): Promise<void> {
  try {
    await operation;
  } catch (error) {
    errors.push(error);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function boundedOutput(current: string, chunk: Buffer): string {
  return `${current}${chunk.toString("utf8")}`.slice(-16_000);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
