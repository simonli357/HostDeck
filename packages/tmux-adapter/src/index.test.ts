import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type AbsoluteCwd,
  type IsoTimestamp,
  type OutputCursor,
  parseAbsoluteCwd,
  parseIsoTimestamp,
  parseOutputCursor,
  parseSessionId,
  parseSessionName,
  type SessionId,
  type SessionName
} from "@hostdeck/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakeTmuxAdapter,
  createRealTmuxAdapter,
  createRealTmuxPipePaneController,
  createRealTmuxTargetDiscovery,
  HostDeckTmuxAdapterError,
  parseSessionIdFromTmuxSessionName,
  type TmuxAdapter,
  type TmuxAdapterErrorCode,
  tmuxSessionNameForSession
} from "./index.js";

const tempDirs: string[] = [];
const tmuxSockets: string[] = [];

afterEach(() => {
  for (const socketName of tmuxSockets.splice(0)) {
    killTmuxServer(socketName);
  }

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("fake tmux adapter", () => {
  it("starts, lists, and exposes deterministic attach metadata", async () => {
    const adapter = createFakeTmuxAdapter({ now: fixedNow });

    const first = await adapter.startSession({
      sessionId: sessionId("sess_tmux_fake_01"),
      sessionName: sessionName("fake-one"),
      cwd: absoluteCwd("/work/fake-one"),
      command: ["codex"]
    });
    const second = await adapter.startSession({
      sessionId: sessionId("sess_tmux_fake_02"),
      sessionName: sessionName("fake-two"),
      cwd: absoluteCwd("/work/fake-two"),
      command: ["codex", "--model", "gpt-5"]
    });

    expect(first).toMatchObject({
      tmuxSession: "hostdeck_sess_tmux_fake_01",
      tmuxWindow: "codex",
      tmuxPane: "%1",
      lifecycleState: "running"
    });
    expect(second.tmuxPane).toBe("%2");
    expect((await adapter.listTargets()).map((target) => target.sessionId)).toEqual([sessionId("sess_tmux_fake_01"), sessionId("sess_tmux_fake_02")]);

    await expect(adapter.attachMetadata({ sessionId: first.sessionId })).resolves.toMatchObject({
      command: ["tmux", "attach-session", "-t", "hostdeck_sess_tmux_fake_01"],
      tmuxPane: "%1"
    });
  });

  it("records selected-session sends and provides cursor-based fake output", async () => {
    const adapter = createFakeTmuxAdapter({ now: fixedNow });
    const sessionIdValue = sessionId("sess_tmux_send_01");
    await adapter.startSession({
      sessionId: sessionIdValue,
      sessionName: sessionName("send-demo"),
      cwd: absoluteCwd("/work/send-demo"),
      command: ["codex"]
    });

    await expect(adapter.sendInput({ sessionId: sessionIdValue, text: "/plan" })).resolves.toMatchObject({
      sessionId: sessionIdValue,
      text: "/plan",
      enter: true,
      tmuxPane: "%1"
    });
    await adapter.appendOutput({ sessionId: sessionIdValue, text: "first line" });
    await adapter.appendOutput({ sessionId: sessionIdValue, text: "second line" });

    expect(adapter.sentInputs().map((input) => input.text)).toEqual(["/plan"]);
    await expect(adapter.readOutput({ sessionId: sessionIdValue, after: outputCursor(1) })).resolves.toMatchObject([
      {
        cursor: 2,
        text: "second line"
      }
    ]);
  });

  it("stops targets explicitly and rejects later writes or attaches", async () => {
    const adapter = createFakeTmuxAdapter({ now: fixedNow });
    const sessionIdValue = sessionId("sess_tmux_stop_01");
    await adapter.startSession({
      sessionId: sessionIdValue,
      sessionName: sessionName("stop-demo"),
      cwd: absoluteCwd("/work/stop-demo"),
      command: ["codex"]
    });

    await expect(adapter.stopSession({ sessionId: sessionIdValue })).resolves.toMatchObject({
      lifecycleState: "stopped",
      tmuxPane: "%1"
    });
    await expect(adapter.listTargets()).resolves.toEqual([]);
    await expectAdapterError(() => adapter.sendInput({ sessionId: sessionIdValue, text: "hello" }), "missing_target");
    await expectAdapterError(() => adapter.attachMetadata({ sessionId: sessionIdValue }), "missing_target");
  });

  it("simulates stale targets and missing-target failures", async () => {
    const adapter = createFakeTmuxAdapter({ now: fixedNow });
    const sessionIdValue = sessionId("sess_tmux_stale_01");
    await adapter.startSession({
      sessionId: sessionIdValue,
      sessionName: sessionName("stale-demo"),
      cwd: absoluteCwd("/work/stale-demo"),
      command: ["codex"]
    });

    await expect(adapter.markStale({ sessionId: sessionIdValue, reason: "tmux target missing" })).resolves.toMatchObject({
      lifecycleState: "stale",
      staleReason: "tmux target missing"
    });
    await expectAdapterError(() => adapter.sendInput({ sessionId: sessionIdValue, text: "hello" }), "stale_target");
    await expectAdapterError(() => adapter.attachMetadata({ sessionId: sessionIdValue }), "stale_target");
    await expectAdapterError(() => adapter.readOutput({ sessionId: sessionId("sess_tmux_missing_01") }), "missing_target");
  });

  it("rejects invalid starts, duplicate ids, duplicate names, and invalid output requests", async () => {
    const adapter = createFakeTmuxAdapter({ now: fixedNow });
    const sessionIdValue = sessionId("sess_tmux_dupe_01");
    await adapter.startSession({
      sessionId: sessionIdValue,
      sessionName: sessionName("dupe-demo"),
      cwd: absoluteCwd("/work/dupe-demo"),
      command: ["codex"]
    });

    await expectAdapterError(
      () =>
        adapter.startSession({
          sessionId: sessionIdValue,
          sessionName: sessionName("other-demo"),
          cwd: absoluteCwd("/work/other-demo"),
          command: ["codex"]
        }),
      "duplicate_session"
    );
    await expectAdapterError(
      () =>
        adapter.startSession({
          sessionId: sessionId("sess_tmux_dupe_02"),
          sessionName: sessionName("dupe-demo"),
          cwd: absoluteCwd("/work/dupe-demo-two"),
          command: ["codex"]
        }),
      "duplicate_session_name"
    );
    await expectAdapterError(
      () =>
        adapter.startSession({
          sessionId: sessionId("sess_tmux_badcmd_01"),
          sessionName: sessionName("bad-command"),
          cwd: absoluteCwd("/work/bad-command"),
          command: []
        }),
      "invalid_start_command"
    );
    await expectAdapterError(() => adapter.readOutput({ sessionId: sessionIdValue, limit: 0 }), "invalid_output_cursor");
  });
});

describe("real tmux target naming", () => {
  it("uses deterministic HostDeck-only session names", () => {
    const id = sessionId("sess_real_tmux_01");

    expect(tmuxSessionNameForSession(id)).toBe("hostdeck_sess_real_tmux_01");
    expect(parseSessionIdFromTmuxSessionName("hostdeck_sess_real_tmux_01")).toBe(id);
    expect(parseSessionIdFromTmuxSessionName("regular-user-session")).toBeNull();
    expect(parseSessionIdFromTmuxSessionName("hostdeck_not_a_valid_session")).toBeNull();
  });

  it("fails loudly when the tmux binary is unavailable", async () => {
    const discovery = createRealTmuxTargetDiscovery({ tmuxBinary: "/tmp/hostdeck-missing-tmux-binary" });

    await expectAdapterError(() => discovery.listTargets(), "tmux_unavailable");
  });
});

const requireTmuxSmoke = process.env.HOSTDECK_REQUIRE_TMUX_SMOKE === "1";
const tmuxAvailable = hasTmuxBinary();
const describeRealTmux = requireTmuxSmoke && tmuxAvailable ? describe : describe.skip;

if (requireTmuxSmoke && !tmuxAvailable) {
  describe("real tmux requirements", () => {
    it("has a tmux binary", () => {
      throw new Error("tmux is not available on PATH.");
    });
  });
}

describeRealTmux("real tmux target discovery", () => {
  it("lists only HostDeck targets and reconciles live, missing, and unmanaged targets", async () => {
    const socketName = nextSocketName();
    const cwd = tempDir();
    const first = sessionId("sess_real_tmux_11");
    const unmanaged = sessionId("sess_real_tmux_12");
    const missing = sessionId("sess_real_tmux_13");
    const discovery = createRealTmuxTargetDiscovery({ socketName });

    startTmuxSession(socketName, tmuxSessionNameForSession(first), cwd, "codex");
    startTmuxSession(socketName, tmuxSessionNameForSession(unmanaged), cwd, "codex");
    startTmuxSession(socketName, "regular-user-session", cwd, "codex");
    startTmuxSession(socketName, "hostdeck_not_a_valid_session", cwd, "codex");

    const listed = await discovery.listTargets();
    expect(listed.map((target) => target.sessionId)).toEqual([first, unmanaged]);
    expect(listed.every((target) => target.currentPath === cwd)).toBe(true);

    const found = await discovery.getTargetBySessionId(first);
    expect(found).toMatchObject({
      sessionId: first,
      tmuxSession: "hostdeck_sess_real_tmux_11",
      tmuxWindow: "codex"
    });
    await expect(discovery.getTargetBySessionId(missing)).resolves.toBeNull();

    const reconciled = await discovery.reconcileTargets([
      {
        sessionId: first,
        sessionName: sessionName("real-one"),
        cwd,
        tmuxWindow: "codex",
        tmuxPane: found?.tmuxPane ?? null,
        createdAt: isoTimestamp("2026-07-08T22:00:00.000Z")
      },
      {
        sessionId: missing,
        sessionName: sessionName("missing-one"),
        cwd
      }
    ]);

    expect(reconciled.liveTargets).toHaveLength(1);
    expect(reconciled.liveTargets[0]).toMatchObject({
      sessionId: first,
      sessionName: sessionName("real-one"),
      lifecycleState: "running",
      staleReason: null,
      tmuxSession: "hostdeck_sess_real_tmux_11"
    });
    expect(reconciled.staleTargets).toEqual([
      {
        sessionId: missing,
        sessionName: sessionName("missing-one"),
        cwd,
        tmuxSession: "hostdeck_sess_real_tmux_13",
        staleReason: "tmux target missing"
      }
    ]);
    expect(reconciled.unmanagedTargets.map((target) => target.sessionId)).toEqual([unmanaged]);
  });

  it("marks mismatched stored tmux metadata stale instead of importing the target", async () => {
    const socketName = nextSocketName();
    const cwd = tempDir();
    const id = sessionId("sess_real_tmux_21");
    const discovery = createRealTmuxTargetDiscovery({ socketName });

    startTmuxSession(socketName, tmuxSessionNameForSession(id), cwd, "codex");

    await expect(discovery.reconcileTargets([{ sessionId: id, sessionName: sessionName("pane-mismatch"), cwd, tmuxPane: "%999" }])).resolves.toMatchObject({
      liveTargets: [],
      staleTargets: [
        {
          sessionId: id,
          staleReason: "tmux pane metadata mismatch"
        }
      ],
      unmanagedTargets: []
    });
  });
});

describeRealTmux("real tmux adapter start", () => {
  it("starts a managed fake Codex command and exposes live target metadata", async () => {
    const socketName = nextSocketName();
    const cwd = tempDir();
    const id = sessionId("sess_real_start_01");
    const adapter = createRealTmuxAdapter({ socketName });
    const command = fakeCodexCommand();

    const target = await adapter.startSession({
      sessionId: id,
      sessionName: sessionName("real-start"),
      cwd,
      command: [command, "--model", "fake-model"]
    });

    expect(target).toMatchObject({
      sessionId: id,
      sessionName: sessionName("real-start"),
      cwd,
      tmuxSession: "hostdeck_sess_real_start_01",
      tmuxWindow: "codex",
      lifecycleState: "running",
      staleReason: null
    });
    expect(target.tmuxPane).toMatch(/^%\d+$/u);
    await expect(adapter.getTarget(id)).resolves.toMatchObject({
      sessionId: id,
      tmuxSession: "hostdeck_sess_real_start_01"
    });
    await expect(adapter.listTargets()).resolves.toHaveLength(1);
    const output = await waitForAdapterOutput(adapter, id, "fake codex ready");
    expect(output[0]).toMatchObject({
      sessionId: id,
      cursor: 1,
      text: "fake codex ready"
    });
    const lastCursor = output.at(-1)?.cursor;

    if (lastCursor === undefined) {
      throw new Error("Expected captured output cursor.");
    }

    await expect(adapter.readOutput({ sessionId: id, after: lastCursor })).resolves.toEqual([]);
  });

  it("sends literal input to exactly one real pane, exposes attach metadata, and stops explicitly", async () => {
    const socketName = nextSocketName();
    const cwd = tempDir();
    const adapter = createRealTmuxAdapter({ socketName });
    const command = fakeCodexCommand('while IFS= read -r line; do printf "%s\\n" "$line" >> "$1"; done\n');
    const firstOutput = join(tempDir(), "first.log");
    const secondOutput = join(tempDir(), "second.log");
    const first = sessionId("sess_real_send_01");
    const second = sessionId("sess_real_send_02");

    await adapter.startSession({
      sessionId: first,
      sessionName: sessionName("send-first"),
      cwd,
      command: [command, firstOutput]
    });
    const secondTarget = await adapter.startSession({
      sessionId: second,
      sessionName: sessionName("send-second"),
      cwd,
      command: [command, secondOutput]
    });

    await expect(adapter.attachMetadata({ sessionId: second })).resolves.toMatchObject({
      sessionId: second,
      tmuxSession: "hostdeck_sess_real_send_02",
      tmuxPane: secondTarget.tmuxPane,
      command: ["tmux", "-L", socketName, "attach-session", "-t", "hostdeck_sess_real_send_02"]
    });
    await expect(adapter.sendInput({ sessionId: second, text: "only second" })).resolves.toMatchObject({
      sessionId: second,
      tmuxPane: secondTarget.tmuxPane,
      text: "only second",
      enter: true
    });
    await waitForFileText(secondOutput, "only second\n");
    expect(readTextIfExists(firstOutput)).toBe("");
    await expectAdapterError(() => adapter.sendInput({ sessionId: second, text: "" }), "invalid_target");

    await expect(adapter.stopSession({ sessionId: second })).resolves.toMatchObject({
      sessionId: second,
      lifecycleState: "stopped",
      staleReason: null
    });
    await expect(adapter.getTarget(second)).resolves.toBeNull();
    await expectAdapterError(() => adapter.sendInput({ sessionId: second, text: "after stop" }), "missing_target");
    await expect(adapter.listTargets()).resolves.toHaveLength(1);
  });

  it("pipes live pane output to a file for ingestion", async () => {
    const socketName = nextSocketName();
    const cwd = tempDir();
    const adapter = createRealTmuxAdapter({ socketName });
    const pipe = createRealTmuxPipePaneController({ socketName });
    const command = fakeCodexCommand("sleep 0.2\nprintf 'live one\\n'\nprintf 'live two\\n'\nsleep 60\n");
    const pipeFile = join(tempDir(), "pipe.log");

    const target = await adapter.startSession({
      sessionId: sessionId("sess_real_pipe_01"),
      sessionName: sessionName("pipe-live"),
      cwd,
      command: [command]
    });

    await pipe.armOutputPipe({ target, outputPath: pipeFile });
    await waitForFileContaining(pipeFile, "live one\nlive two\n");
    await pipe.disarmOutputPipe({ target });
  });

  it(
    "keeps only new output when bounded capture contains the retained suffix",
    async () => {
      const socketName = nextSocketName();
      const cwd = tempDir();
      const adapter = createRealTmuxAdapter({ socketName });
      const command = fakeCodexCommand(
        "stty -echo\n" +
          "i=1\n" +
          "while [ \"$i\" -le 260 ]; do printf 'line-%03d\\n' \"$i\"; i=$((i + 1)); done\n" +
          "while IFS= read -r line; do printf 'ack-%s\\n' \"$line\"; done\n"
      );
      const id = sessionId("sess_real_suffix_01");

      await adapter.startSession({
        sessionId: id,
        sessionName: sessionName("suffix-output"),
        cwd,
        command: [command]
      });

      await waitForAdapterOutput(adapter, id, "line-260");
      const baseline = await adapter.readOutput({ sessionId: id, limit: 1_000 });
      const lastCursor = baseline.at(-1)?.cursor;

      if (lastCursor === undefined) {
        throw new Error("Expected baseline output before suffix hardening assertion.");
      }

      await adapter.sendInput({ sessionId: id, text: "line-261" });
      const appended = await waitForAdapterOutputAfter(adapter, id, lastCursor, "ack-line-261");

      expect(appended.map((event) => event.text)).toEqual(["ack-line-261"]);
    },
    10_000
  );

  it("cleans up repeated real start and stop cycles", async () => {
    const socketName = nextSocketName();
    const cwd = tempDir();
    const adapter = createRealTmuxAdapter({ socketName });

    for (const index of [1, 2, 3]) {
      const id = sessionId(`sess_real_cycle_0${index}`);
      await adapter.startSession({
        sessionId: id,
        sessionName: sessionName(`cycle-${index}`),
        cwd,
        command: [fakeCodexCommand()]
      });
      await expect(adapter.listTargets()).resolves.toHaveLength(1);
      await expect(adapter.stopSession({ sessionId: id })).resolves.toMatchObject({
        sessionId: id,
        lifecycleState: "stopped"
      });
      await expect(adapter.getTarget(id)).resolves.toBeNull();
      await expect(adapter.listTargets()).resolves.toEqual([]);
      await expectAdapterError(() => adapter.sendInput({ sessionId: id, text: "after stop" }), "missing_target");
      await expectAdapterError(() => adapter.attachMetadata({ sessionId: id }), "missing_target");
    }
  });

  it("rejects missing and stale real targets for send and attach", async () => {
    const socketName = nextSocketName();
    const cwd = tempDir();
    const adapter = createRealTmuxAdapter({ socketName });
    const id = sessionId("sess_real_stale_01");

    await expectAdapterError(() => adapter.attachMetadata({ sessionId: id }), "missing_target");
    await expectAdapterError(() => adapter.sendInput({ sessionId: id, text: "hello" }), "missing_target");

    await adapter.startSession({
      sessionId: id,
      sessionName: sessionName("stale-real"),
      cwd,
      command: [fakeCodexCommand()]
    });
    killTmuxServer(socketName);

    await expectAdapterError(() => adapter.attachMetadata({ sessionId: id }), "stale_target");
    await expectAdapterError(() => adapter.sendInput({ sessionId: id, text: "hello" }), "stale_target");
    await expectAdapterError(() => adapter.readOutput({ sessionId: id }), "stale_target");
  });

  it("rejects duplicate real session ids and in-process duplicate names", async () => {
    const socketName = nextSocketName();
    const cwd = tempDir();
    const adapter = createRealTmuxAdapter({ socketName });
    const command = fakeCodexCommand();
    const id = sessionId("sess_real_dupe_01");

    await adapter.startSession({
      sessionId: id,
      sessionName: sessionName("duplicate-real"),
      cwd,
      command: [command]
    });

    await expectAdapterError(
      () =>
        adapter.startSession({
          sessionId: id,
          sessionName: sessionName("duplicate-other"),
          cwd,
          command: [command]
        }),
      "duplicate_session"
    );
    await expectAdapterError(
      () =>
        adapter.startSession({
          sessionId: sessionId("sess_real_dupe_02"),
          sessionName: sessionName("duplicate-real"),
          cwd,
          command: [command]
        }),
      "duplicate_session_name"
    );
  });

  it("fails before tmux launch for invalid cwd and missing command binaries", async () => {
    const socketName = nextSocketName();
    const cwd = tempDir();
    const adapter = createRealTmuxAdapter({ socketName });
    const discovery = createRealTmuxTargetDiscovery({ socketName });
    const command = fakeCodexCommand();

    await expectAdapterError(
      () =>
        adapter.startSession({
          sessionId: sessionId("sess_real_badcwd_01"),
          sessionName: sessionName("bad-cwd"),
          cwd: absoluteCwd(join(cwd, "missing")),
          command: [command]
        }),
      "invalid_cwd"
    );
    await expectAdapterError(
      () =>
        adapter.startSession({
          sessionId: sessionId("sess_real_missing_cmd_01"),
          sessionName: sessionName("missing-command"),
          cwd,
          command: [join(cwd, "missing-codex")]
        }),
      "command_unavailable"
    );
    await expect(discovery.listTargets()).resolves.toEqual([]);
  });

  it("lists no targets after the last managed session is externally killed", async () => {
    const socketName = nextSocketName();
    const cwd = tempDir();
    const adapter = createRealTmuxAdapter({ socketName });
    const discovery = createRealTmuxTargetDiscovery({ socketName });
    const target = await adapter.startSession({
      sessionId: sessionId("sess_real_killed_last_01"),
      sessionName: sessionName("killed-last"),
      cwd,
      command: [fakeCodexCommand()]
    });

    execFileSync("tmux", ["-L", socketName, "kill-session", "-t", target.tmuxSession], { stdio: "ignore" });

    await expect(discovery.listTargets()).resolves.toEqual([]);
  });

  it("fails loudly when tmux is unavailable during real start", async () => {
    const cwd = tempDir();
    const command = fakeCodexCommand();
    const adapter = createRealTmuxAdapter({ tmuxBinary: "/tmp/hostdeck-missing-tmux-binary" });

    await expectAdapterError(
      () =>
        adapter.startSession({
          sessionId: sessionId("sess_real_missing_tmux_01"),
          sessionName: sessionName("missing-tmux"),
          cwd,
          command: [command]
        }),
      "tmux_unavailable"
    );
  });

  it("cleans up when the launched command exits before verification", async () => {
    const socketName = nextSocketName();
    const cwd = tempDir();
    const adapter = createRealTmuxAdapter({ socketName, startupVerifyDelayMs: 50 });
    const discovery = createRealTmuxTargetDiscovery({ socketName });
    const command = fakeCodexCommand("exit 42\n");

    await expectAdapterError(
      () =>
        adapter.startSession({
          sessionId: sessionId("sess_real_fail_01"),
          sessionName: sessionName("launch-fails"),
          cwd,
          command: [command]
        }),
      "start_failed"
    );
    await expect(discovery.listTargets()).resolves.toEqual([]);
  });
});

async function expectAdapterError(fn: () => Promise<unknown>, code: TmuxAdapterErrorCode): Promise<void> {
  await expect(fn()).rejects.toBeInstanceOf(HostDeckTmuxAdapterError);

  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckTmuxAdapterError);
    expect((error as HostDeckTmuxAdapterError).code).toBe(code);
    return;
  }

  throw new Error(`Expected HostDeckTmuxAdapterError ${code}.`);
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

function outputCursor(value: number): OutputCursor {
  const result = parseOutputCursor(value);

  if (!result.ok) {
    throw new Error(result.message);
  }

  return result.value;
}

function isoTimestamp(value: string): IsoTimestamp {
  const result = parseIsoTimestamp(value);

  if (!result.ok) {
    throw new Error(result.message);
  }

  return result.value;
}

function fixedNow(): Date {
  return new Date("2026-07-08T22:00:00.000Z");
}

function hasTmuxBinary(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function nextSocketName(): string {
  const socketName = `hostdeck-test-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  tmuxSockets.push(socketName);
  return socketName;
}

function tempDir(): AbsoluteCwd {
  const dir = mkdtempSync(join(tmpdir(), "hostdeck-tmux-adapter-"));
  tempDirs.push(dir);
  return absoluteCwd(dir);
}

function fakeCodexCommand(body = "printf 'fake codex ready\\n'\nsleep 60\n"): string {
  const dir = tempDir();
  const file = join(dir, "codex");
  writeFileSync(file, `#!/bin/sh\n${body}`, { mode: 0o700 });
  chmodSync(file, 0o700);
  return file;
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

async function waitForFileContaining(path: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (readTextIfExists(path).replace(/\r/gu, "").includes(expected)) {
      return;
    }

    await delay(25);
  }

  expect(readTextIfExists(path).replace(/\r/gu, "")).toContain(expected);
}

async function waitForAdapterOutput(adapter: Pick<TmuxAdapter, "readOutput">, sessionId: SessionId, expectedText: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const output = await adapter.readOutput({ sessionId });

    if (output.some((event) => event.text === expectedText)) {
      return output;
    }

    await delay(25);
  }

  return adapter.readOutput({ sessionId });
}

async function waitForAdapterOutputAfter(adapter: Pick<TmuxAdapter, "readOutput">, sessionId: SessionId, after: OutputCursor, expectedText: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const output = await adapter.readOutput({ sessionId, after, limit: 1_000 });

    if (output.some((event) => event.text === expectedText)) {
      return output;
    }

    await delay(25);
  }

  return adapter.readOutput({ sessionId, after, limit: 1_000 });
}

function readTextIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function startTmuxSession(socketName: string, tmuxSession: string, cwd: AbsoluteCwd, windowName: string): void {
  execFileSync("tmux", ["-L", socketName, "new-session", "-d", "-s", tmuxSession, "-c", cwd, "-n", windowName, "sleep 60"], {
    stdio: "pipe"
  });
}

function killTmuxServer(socketName: string): void {
  try {
    execFileSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore" });
  } catch {
    // The test may fail before the server is created.
  }
}
