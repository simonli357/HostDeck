import type { NormalizedCodexEvent } from "@hostdeck/codex-adapter";
import { describe, expect, it } from "vitest";
import {
  codexControlEventObserverNames,
  createCodexControlEventObserver
} from "./codex-control-event-observer.js";

const event = {
  sequence: 9,
  method: "thread/archived",
  captured_at: "2026-07-11T15:30:00.000Z",
  upstream_at: null,
  codex_event_id: null,
  scope: "thread",
  thread_id: "thread-control-observer"
} as NormalizedCodexEvent;

describe("Codex control event observer", () => {
  it("fans one event through every observer in strict order with one generation", async () => {
    const calls: string[] = [];
    const observer = createCodexControlEventObserver(fakeOptions(calls));

    await expect(observer.observe(event, 4)).resolves.toEqual({
      sequence: 9,
      method: "thread/archived",
      connection_generation: 4,
      observers: ["plan_and_model", "goal", "compact", "usage", "approval", "interrupt", "prompt"]
    });
    expect(calls).toEqual([
      "plan_and_model:thread/archived",
      "goal:thread/archived",
      "compact:thread/archived:4",
      "usage:thread/archived:4",
      "approval:thread/archived",
      "interrupt:thread/archived",
      "prompt:thread/archived"
    ]);
    expect(Object.isFrozen(observer)).toBe(true);
    expect(Object.isFrozen(codexControlEventObserverNames)).toBe(true);
  });

  it("identifies the failed owner and does not run later observers", async () => {
    const calls: string[] = [];
    const options = fakeOptions(calls);
    const observer = createCodexControlEventObserver({
      ...options,
      compact: {
        observe() {
          calls.push("compact:failed");
          throw new Error("compact contradiction");
        }
      }
    });

    await expect(observer.observe(event, 4)).rejects.toMatchObject({
      name: "HostDeckCodexControlEventObserverError",
      code: "observer_failed",
      observer: "compact",
      cause: expect.objectContaining({ message: "compact contradiction" })
    });
    expect(calls).toEqual(["plan_and_model:thread/archived", "goal:thread/archived", "compact:failed"]);
  });

  it("rejects invalid event identity and generation before any observer", async () => {
    const calls: string[] = [];
    const observer = createCodexControlEventObserver(fakeOptions(calls));
    await expect(observer.observe({ ...event, sequence: 0 } as NormalizedCodexEvent, 4)).rejects.toMatchObject({
      code: "invalid_event",
      observer: null
    });
    await expect(observer.observe(event, 0)).rejects.toMatchObject({
      code: "invalid_generation",
      observer: null
    });
    expect(calls).toEqual([]);
  });

  it("requires one exact plain-object set of observation ports", () => {
    expect(() => createCodexControlEventObserver(null as never)).toThrow(TypeError);
    expect(() => createCodexControlEventObserver({ ...fakeOptions([]), extra: true } as never)).toThrow(TypeError);
    expect(() =>
      createCodexControlEventObserver({ ...fakeOptions([]), usage: { observe: null } } as never)
    ).toThrow(TypeError);
    expect(() => createCodexControlEventObserver(Object.create({}) as never)).toThrow(TypeError);
  });
});

function fakeOptions(calls: string[]) {
  return {
    plans: {
      async observeEvent(candidate: NormalizedCodexEvent) {
        calls.push(`plan_and_model:${candidate.method}`);
      }
    },
    goals: {
      async observeGoal(candidate: NormalizedCodexEvent) {
        calls.push(`goal:${candidate.method}`);
      }
    },
    compact: {
      async observe(candidate: NormalizedCodexEvent, generation: unknown) {
        calls.push(`compact:${candidate.method}:${String(generation)}`);
        return true;
      }
    },
    usage: {
      observe(candidate: NormalizedCodexEvent, generation: unknown) {
        calls.push(`usage:${candidate.method}:${String(generation)}`);
        return true;
      }
    },
    approvals: {
      async observeEvent(candidate: NormalizedCodexEvent) {
        calls.push(`approval:${candidate.method}`);
      }
    },
    interrupts: {
      async observeEvent(candidate: NormalizedCodexEvent) {
        calls.push(`interrupt:${candidate.method}`);
      }
    },
    prompts: {
      async observeEvent(candidate: NormalizedCodexEvent) {
        calls.push(`prompt:${candidate.method}`);
      }
    }
  };
}
