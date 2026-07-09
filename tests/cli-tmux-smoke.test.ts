import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliExitCodes, type HostDeckApiClient, runCli } from "../packages/cli/src/index.js";
import type { ApiSession, StartSessionResponse, WriteResponse } from "../packages/contracts/src/index.js";
import { type AbsoluteCwd, parseAbsoluteCwd, parseSessionId, parseSessionName, type SessionId, type SessionName } from "../packages/core/src/index.js";
import { createRealTmuxAdapter, type TmuxAdapter, type TmuxTarget } from "../packages/tmux-adapter/src/index.js";

const smokeEnabled = process.env.HOSTDECK_REQUIRE_TMUX_SMOKE === "1";
const describeSmoke = smokeEnabled ? describe : describe.skip;
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describeSmoke("CLI real tmux smoke", () => {
  it("starts, lists, prints attach metadata, sends, and stops through a real tmux-backed client", async () => {
    const cwd = tempCwd();
    const adapter = createRealTmuxAdapter({
      socketName: `hostdeck-cli-smoke-${process.pid}-${Date.now()}`,
      startupVerifyDelayMs: 50
    });
    const client = realTmuxClient(adapter, cwd);

    try {
      const start = await runCli(["start", "--name", "cli-smoke", "--cwd", cwd], { client, env: {} });
      expect(start).toMatchObject({ exitCode: cliExitCodes.ok, stderr: "" });
      expect(start.stdout).toContain("Started session: cli-smoke");

      const list = await runCli(["list"], { client, env: {} });
      expect(list.exitCode).toBe(cliExitCodes.ok);
      expect(list.stdout).toContain("lifecycle=running");

      const attach = await runCli(["attach", "cli-smoke"], { client, env: {} });
      expect(attach.exitCode).toBe(cliExitCodes.ok);
      expect(attach.stdout).toContain("tmux attach-session -t hostdeck_sess_cli_smoke_01");

      const send = await runCli(["send", "cli-smoke", "hello from cli smoke"], { client, env: {} });
      expect(send.exitCode).toBe(cliExitCodes.ok);
      expect(send.stdout).toContain("prompt accepted for sess_cli_smoke_01");

      const stop = await runCli(["stop", "cli-smoke"], { client, env: {} });
      expect(stop.exitCode).toBe(cliExitCodes.ok);
      expect(stop.stdout).toContain("stop accepted for sess_cli_smoke_01");
      await expect(adapter.getTarget(sessionId("sess_cli_smoke_01"))).resolves.toBeNull();
    } finally {
      await cleanup(adapter);
    }
  });
});

function realTmuxClient(adapter: TmuxAdapter, cwd: string): HostDeckApiClient {
  const sessionIdValue = sessionId("sess_cli_smoke_01");
  let session: ApiSession | null = null;

  return {
    async getStatus() {
      return {
        version: "0.0.0",
        bind: { mode: "localhost", host: "127.0.0.1", port: 3777 },
        locked: false,
        lan_enabled: false,
        storage: { state: "ok" },
        tmux: { state: "ok" },
        stream: { state: "ok" },
        startup_checks: [{ name: "tmux", state: "ok" }],
        stale_session_count: 0,
        last_error: null
      };
    },
    async startSession(input): Promise<StartSessionResponse> {
      const target = await adapter.startSession({
        sessionId: sessionIdValue,
        sessionName: sessionName(input.name),
        cwd: absoluteCwd(cwd),
        command: [process.execPath, "-e", "process.stdin.resume();"]
      });
      session = apiSession(target);
      return { session };
    },
    async listSessions() {
      return { sessions: session === null ? [] : [session] };
    },
    async getSession(sessionIdInput) {
      if (session === null || session.id !== sessionIdInput) {
        throw new Error(`Missing smoke session ${sessionIdInput}.`);
      }

      return { session };
    },
    async sendPrompt(sessionIdInput, text): Promise<WriteResponse> {
      await adapter.sendInput({ sessionId: sessionId(sessionIdInput), text, enter: true });
      const parsedSessionId = sessionId(sessionIdInput);
      return {
        accepted: true,
        session_id: parsedSessionId,
        action: "prompt",
        audit_required: true
      };
    },
    async stopSession(sessionIdInput): Promise<WriteResponse> {
      const parsedSessionId = sessionId(sessionIdInput);
      const stopped = await adapter.stopSession({ sessionId: parsedSessionId });
      session = session === null ? null : { ...session, lifecycle_state: stopped.lifecycleState, updated_at: stopped.updatedAt };
      return {
        accepted: true,
        session_id: parsedSessionId,
        action: "stop",
        audit_required: true
      };
    }
  };
}

function apiSession(target: TmuxTarget): ApiSession {
  return {
    id: target.sessionId,
    name: target.sessionName,
    cwd: target.cwd,
    backend: {
      type: "tmux",
      tmux: {
        session_name: target.tmuxSession,
        ...(target.tmuxWindow !== null ? { window_name: target.tmuxWindow } : {}),
        pane_id: target.tmuxPane
      }
    },
    lifecycle_state: target.lifecycleState,
    status: "unknown",
    attention: "unknown",
    created_at: target.createdAt,
    updated_at: target.updatedAt,
    last_activity_at: null,
    branch: null,
    recent_output: {
      text: "",
      cursor: null,
      line_count: 0,
      truncated: false
    }
  };
}

async function cleanup(adapter: TmuxAdapter): Promise<void> {
  for (const target of await adapter.listTargets()) {
    try {
      await adapter.stopSession({ sessionId: target.sessionId });
    } catch {
      // Smoke cleanup should not hide the primary assertion failure.
    }
  }
}

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-cli-tmux-smoke-cwd-"));
  tempDirs.push(dir);
  return dir;
}

function sessionId(value: string): SessionId {
  const result = parseSessionId(value);

  if (!result.ok) {
    throw new Error(result.message);
  }

  return result.value;
}

function sessionName(value: string): SessionName {
  const result = parseSessionName(value);

  if (!result.ok) {
    throw new Error(result.message);
  }

  return result.value;
}

function absoluteCwd(value: string): AbsoluteCwd {
  const result = parseAbsoluteCwd(value);

  if (!result.ok) {
    throw new Error(result.message);
  }

  return result.value;
}
