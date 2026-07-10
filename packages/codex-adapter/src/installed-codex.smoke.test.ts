import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { codexBindingDescriptor } from "./binding.js";
import { assessCodexCompatibility, parseCodexCliVersionOutput } from "./compatibility.js";

const requireSmoke = process.env.HOSTDECK_REQUIRE_CODEX_COMPATIBILITY_SMOKE === "1";
const codexBin = process.env.HOSTDECK_CODEX_BIN ?? "codex";

describe.skipIf(!requireSmoke)("installed Codex compatibility smoke", () => {
  it(
    "starts the pinned app-server, initializes experimental API, and advertises plan modes",
    async () => {
      const version = parseCodexCliVersionOutput(
        execFileSync(codexBin, ["--version"], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 })
      );
      expect(version).toBe(codexBindingDescriptor.codex_version);

      const client = createStdioClient();
      try {
        const initialized = await client.request(1, "initialize", {
          clientInfo: { name: "hostdeck", title: "HostDeck", version: "0.0.0" },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
            optOutNotificationMethods: []
          }
        });
        client.notify("initialized");
        const catalog = await client.request(2, "collaborationMode/list", {});
        const modes = readModeNames(catalog);

        expect(
          assessCodexCompatibility({
            observed_version: version,
            checked_at: new Date().toISOString(),
            handshake: {
              state: "initialized",
              user_agent: readString(initialized, "userAgent"),
              platform_family: readString(initialized, "platformFamily"),
              platform_os: readString(initialized, "platformOs"),
              collaboration_modes: modes
            }
          })
        ).toMatchObject({ state: "ready", mutation_policy: "allowed" });
        expect(modes.map((mode) => mode.toLowerCase())).toEqual(expect.arrayContaining(["plan", "default"]));
      } finally {
        await client.close();
      }
    },
    20_000
  );
});

interface StdioClient {
  readonly request: (id: number, method: string, params: unknown) => Promise<unknown>;
  readonly notify: (method: string) => void;
  readonly close: () => Promise<void>;
}

function createStdioClient(): StdioClient {
  const child = spawn(codexBin, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }>();
  let buffer = "";
  let stderr = "";
  let closing = false;

  child.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_000);
  });
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) receiveLine(line, pending);
    }
  });
  child.on("error", (error) => rejectAll(pending, new Error(`Unable to start Codex app-server: ${error.message}`)));
  child.stdin.on("error", (error) => {
    if (!closing) rejectAll(pending, new Error(`Codex app-server stdin failed: ${error.message}`));
  });
  child.on("exit", (code, signal) => {
    if (!closing) rejectAll(pending, new Error(`Codex app-server exited before response (${code ?? signal ?? "unknown"}): ${stderr}`));
  });

  return {
    request(id, method, params) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Codex app-server request ${method} timed out: ${stderr}`));
        }, 10_000);
        pending.set(id, {
          resolve(value) {
            clearTimeout(timeout);
            resolve(value);
          },
          reject(error) {
            clearTimeout(timeout);
            reject(error);
          }
        });
        send(child, { method, id, params });
      });
    },
    notify(method) {
      send(child, { method });
    },
    async close() {
      closing = true;
      rejectAll(pending, new Error("Codex app-server client closed."));
      child.kill("SIGTERM");
      await waitForExit(child);
    }
  };
}

function receiveLine(
  line: string,
  pending: Map<number, { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }>
): void {
  let message: unknown;
  try {
    message = JSON.parse(line) as unknown;
  } catch (error) {
    rejectAll(pending, new Error("Codex app-server emitted invalid JSON.", { cause: error }));
    return;
  }
  if (message === null || typeof message !== "object" || Array.isArray(message)) return;
  const value = message as Record<string, unknown>;
  if (typeof value.id !== "number") return;
  const request = pending.get(value.id);
  if (request === undefined) return;
  pending.delete(value.id);
  if (value.error !== undefined) request.reject(new Error(`Codex app-server returned an error: ${JSON.stringify(value.error)}`));
  else request.resolve(value.result);
}

function send(child: ChildProcessWithoutNullStreams, message: unknown): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function rejectAll(
  pending: Map<number, { readonly reject: (error: Error) => void }>,
  error: Error
): void {
  for (const request of pending.values()) request.reject(error);
  pending.clear();
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").then(() => undefined);
  if (await settledWithin(exited, 2_000)) return;
  child.kill("SIGKILL");
  if (!(await settledWithin(exited, 1_000))) throw new Error("Codex app-server did not exit after SIGKILL.");
}

async function settledWithin(promise: Promise<void>, milliseconds: number): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  const expired = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), milliseconds);
    timeout.unref();
  });
  const settled = await Promise.race([promise.then(() => true as const), expired]);
  if (timeout !== undefined) clearTimeout(timeout);
  return settled;
}

function readModeNames(candidate: unknown): readonly string[] {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("Plan catalog result is invalid.");
  const data = (candidate as { readonly data?: unknown }).data;
  if (!Array.isArray(data)) throw new Error("Plan catalog data is invalid.");
  return data.map((entry) => readString(entry, "name"));
}

function readString(candidate: unknown, key: string): string {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error(`Codex response ${key} owner is invalid.`);
  }
  const value = (candidate as Record<string, unknown>)[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`Codex response ${key} is invalid.`);
  return value;
}
