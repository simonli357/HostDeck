import {
  type AbsoluteCwd,
  type OutputCursor,
  parseAbsoluteCwd,
  parseOutputCursor,
  parseSessionId,
  parseSessionName,
  type SessionId,
  type SessionName
} from "@hostdeck/core";
import { describe, expect, it } from "vitest";
import { createFakeTmuxAdapter, HostDeckTmuxAdapterError, type TmuxAdapterErrorCode } from "./index.js";

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
      tmuxSession: "hostdeck-tmux-fake-01",
      tmuxWindow: "codex",
      tmuxPane: "%1",
      lifecycleState: "running"
    });
    expect(second.tmuxPane).toBe("%2");
    expect((await adapter.listTargets()).map((target) => target.sessionId)).toEqual([sessionId("sess_tmux_fake_01"), sessionId("sess_tmux_fake_02")]);

    await expect(adapter.attachMetadata({ sessionId: first.sessionId })).resolves.toMatchObject({
      command: ["tmux", "attach-session", "-t", "hostdeck-tmux-fake-01"],
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

function fixedNow(): Date {
  return new Date("2026-07-08T22:00:00.000Z");
}
