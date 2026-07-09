import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseAbsoluteCwd, parseSessionId, parseSessionName, type SessionId } from "@hostdeck/core";
import { createRetentionRepository, createSessionRepository, openMigratedDatabase } from "@hostdeck/storage";
import {
  createRealTmuxAdapter,
  createRealTmuxTargetDiscovery,
  type TmuxAdapter,
  type TmuxTarget
} from "@hostdeck/tmux-adapter";
import { afterEach, describe, expect, it } from "vitest";
import { createOutputReader } from "./output-reader.js";
import { createRestartReconciler } from "./restart-reconciler.js";

const tempDirs: string[] = [];
const tmuxSockets: string[] = [];
const smokeTools = detectSmokeTools();
const describeSmoke = smokeTools.ok ? describe : describe.skip;

if (!smokeTools.ok && process.env.HOSTDECK_REQUIRE_TMUX_SMOKE === "1") {
  describe("real tmux smoke requirements", () => {
    it("has required tools", () => {
      throw new Error(smokeTools.message);
    });
  });
}

afterEach(() => {
  for (const socketName of tmuxSockets.splice(0)) {
    killTmuxServer(socketName);
  }

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describeSmoke("real tmux smoke", () => {
  it("starts sessions, attaches, sends, stops, captures output, reconciles restart, and marks stale", async () => {
    const socketName = nextSocketName();
    const cwd = tempDir();
    const command = fakeCodexCommand("printf 'ready\\n'\nwhile IFS= read -r line; do printf '%s\\n' \"$line\" >> \"$1\"; done\n");
    const firstInputLog = join(tempDir(), "first-input.log");
    const secondInputLog = join(tempDir(), "second-input.log");
    const adapter = createRealTmuxAdapter({ socketName });
    const first = await adapter.startSession({
      sessionId: parseRequiredSessionId("sess_smoke_real_01"),
      sessionName: parseRequiredSessionName("smoke-one"),
      cwd,
      command: [command, firstInputLog]
    });
    const second = await adapter.startSession({
      sessionId: parseRequiredSessionId("sess_smoke_real_02"),
      sessionName: parseRequiredSessionName("smoke-two"),
      cwd,
      command: [command, secondInputLog]
    });

    expect(await adapter.attachMetadata({ sessionId: first.sessionId })).toMatchObject({
      command: ["tmux", "-L", socketName, "attach-session", "-t", first.tmuxSession]
    });
    await adapter.sendInput({ sessionId: second.sessionId, text: "phone prompt" });
    await waitForFileText(secondInputLog, "phone prompt\n");
    expect(readTextIfExists(firstInputLog)).toBe("");
    await waitForAdapterOutput(adapter, first.sessionId, "ready");

    const open = openMigratedDatabase(join(tempDir(), "hostdeck.sqlite"), { now: fixedNow });

    try {
      const sessions = createSessionRepository(open.db);
      sessions.create(sessionRecordForTarget(first));
      sessions.create(sessionRecordForTarget(second));
      const outputReader = createOutputReader({
        retention: createRetentionRepository(open.db),
        capture: {
          async captureOutput(input) {
            const output = await adapter.readOutput({ sessionId: input.sessionId });
            return output.map((event) => event.text).join("\n");
          }
        },
        now: fixedNow
      });

      await expect(outputReader.drainSession({ sessionId: first.sessionId })).resolves.toMatchObject({
        appended: [{ payload: "ready" }]
      });

      const stopped = await adapter.stopSession({ sessionId: second.sessionId });
      sessions.update({
        ...sessions.require(second.sessionId),
        lifecycle_state: "stopped",
        updated_at: stopped.updatedAt
      });

      const readerStarts: SessionId[] = [];
      const reconciler = createRestartReconciler({
        sessions,
        discovery: createRealTmuxTargetDiscovery({ socketName }),
        now: laterNow,
        startOutputReader(target) {
          readerStarts.push(target.sessionId);
        }
      });
      await expect(reconciler.reconcile()).resolves.toMatchObject({
        staleSessionIds: [],
        unmanagedTargets: []
      });
      expect(readerStarts).toEqual([first.sessionId]);
      expect(sessions.require(second.sessionId)).toMatchObject({
        lifecycle_state: "stopped"
      });

      execFileSync("tmux", ["-L", socketName, "kill-session", "-t", first.tmuxSession], { stdio: "ignore" });
      await expect(reconciler.reconcile()).resolves.toMatchObject({
        staleSessionIds: [first.sessionId]
      });
      expect(readerStarts).toEqual([first.sessionId]);
      expect(sessions.require(first.sessionId)).toMatchObject({
        lifecycle_state: "stale",
        stale_reason: "tmux target missing"
      });
    } finally {
      open.db.close();
    }
  });
});

function sessionRecordForTarget(target: TmuxTarget) {
  return {
    id: target.sessionId,
    name: target.sessionName,
    cwd: target.cwd,
    backend: {
      type: "tmux",
      tmux_session: target.tmuxSession,
      tmux_window: target.tmuxWindow,
      tmux_pane: target.tmuxPane
    },
    lifecycle_state: target.lifecycleState,
    created_at: target.createdAt,
    updated_at: target.updatedAt,
    stale_reason: target.staleReason
  };
}

async function waitForAdapterOutput(adapter: Pick<TmuxAdapter, "readOutput">, sessionId: SessionId, text: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const output = await adapter.readOutput({ sessionId });

    if (output.some((event) => event.text === text)) {
      return;
    }

    await delay(25);
  }

  expect((await adapter.readOutput({ sessionId })).map((event) => event.text)).toContain(text);
}

async function waitForFileText(path: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (readTextIfExists(path) === expected) {
      return;
    }

    await delay(25);
  }

  expect(readTextIfExists(path)).toBe(expected);
}

function readTextIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function fakeCodexCommand(body: string): string {
  const dir = tempDir();
  const file = join(dir, "codex");
  writeFileSync(file, `#!/bin/sh\n${body}`, { mode: 0o700 });
  chmodSync(file, 0o700);
  return file;
}

function nextSocketName(): string {
  const socketName = `hostdeck-smoke-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  tmuxSockets.push(socketName);
  return socketName;
}

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-tmux-smoke-"));
  tempDirs.push(dir);
  return parseRequiredCwd(dir);
}

function parseRequiredSessionId(value: string) {
  const result = parseSessionId(value);

  if (!result.ok) {
    throw new Error(result.message);
  }

  return result.value;
}

function parseRequiredSessionName(value: string) {
  const result = parseSessionName(value);

  if (!result.ok) {
    throw new Error(result.message);
  }

  return result.value;
}

function parseRequiredCwd(value: string) {
  const result = parseAbsoluteCwd(value);

  if (!result.ok) {
    throw new Error(result.message);
  }

  return result.value;
}

function fixedNow(): Date {
  return new Date("2026-07-08T22:00:00.000Z");
}

function laterNow(): Date {
  return new Date("2026-07-08T22:05:00.000Z");
}

function killTmuxServer(socketName: string): void {
  try {
    execFileSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore" });
  } catch {
    // The smoke may fail before a server exists.
  }
}

function detectSmokeTools(): { readonly ok: true } | { readonly ok: false; readonly message: string } {
  for (const command of ["tmux", "codex"] as const) {
    try {
      execFileSync(command, ["--version"], { stdio: "ignore" });
    } catch {
      try {
        execFileSync(command, ["-V"], { stdio: "ignore" });
      } catch {
        return { ok: false, message: `${command} is not available on PATH.` };
      }
    }
  }

  return { ok: true };
}
