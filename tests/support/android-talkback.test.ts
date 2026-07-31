import { describe, expect, it } from "vitest";
import {
  type PhysicalTalkBackObserverCategory,
  type PhysicalTalkBackObserverEvent,
  parsePhysicalTalkBackObserverLine,
  runPhysicalTalkBackCleanupPlan,
  validatePhysicalTalkBackTranscript
} from "./android-talkback.js";

describe("physical TalkBack observer protocol", () => {
  it("parses only the bounded fixed observer vocabulary", () => {
    expect(parsePhysicalTalkBackObserverLine("HOSTDECK_OBSERVER_READY")).toEqual({
      kind: "ready"
    });
    expect(
      parsePhysicalTalkBackObserverLine(
        "HOSTDECK_EVENT=17|focus|model_trigger|button|1|1|1|1|24|1800|348|1900\r"
      )
    ).toEqual({
      kind: "event",
      event: {
        bounds: { bottom: 1900, left: 24, right: 348, top: 1800 },
        category: "model_trigger",
        className: "button",
        clickable: true,
        enabled: true,
        focusable: true,
        kind: "focus",
        sequence: 17,
        visible: true
      }
    });
    expect(parsePhysicalTalkBackObserverLine("")).toBeNull();
  });

  it.each([
    "HOSTDECK_EVENT=0|focus|known_hostdeck|view|0|1|1|1|0|0|10|10",
    "HOSTDECK_EVENT=129|focus|private_session_name|view|0|1|1|1|0|0|10|10",
    "HOSTDECK_EVENT=4|focus|known_hostdeck|view|0|1|1|1|0|0|0|10",
    "HOSTDECK_EVENT=4|focus|known_hostdeck|view|0|1|1|1|-10001|0|10|10",
    "HOSTDECK_EVENT=4|focus|known_hostdeck|view|0|1|1|1|0|0|10|10|private",
    "physical-pairing-review"
  ])("rejects malformed or raw observer output: %s", (line) => {
    expect(() => parsePhysicalTalkBackObserverLine(line)).toThrow();
  });
});

describe("physical TalkBack transcript contract", () => {
  it("accepts the complete ordered focus and double-tap crossing", () => {
    const summary = validatePhysicalTalkBackTranscript(validTranscript());

    expect(summary).toMatchObject({
      clickCount: 4,
      eventCount: 18,
      firstSequence: 9,
      focusCount: 14,
      lastSequence: 26
    });
    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.isFrozen(summary.transcript)).toBe(true);
  });

  it.each([
    {
      label: "unknown focus",
      mutate: (events: PhysicalTalkBackObserverEvent[]) => {
        events[4] = event(13, "focus", "unknown");
      }
    },
    {
      label: "permission surface",
      mutate: (events: PhysicalTalkBackObserverEvent[]) => {
        events[4] = event(13, "focus", "platform_permission");
      }
    },
    {
      label: "sequence gap",
      mutate: (events: PhysicalTalkBackObserverEvent[]) => {
        events[10] = { ...events[10] as PhysicalTalkBackObserverEvent, sequence: 99 };
      }
    },
    {
      label: "reordered route",
      mutate: (events: PhysicalTalkBackObserverEvent[]) => {
        events[0] = event(9, "focus", "mission_control");
      }
    },
    {
      label: "focus escape from modal",
      mutate: (events: PhysicalTalkBackObserverEvent[]) => {
        events[9] = event(18, "focus", "known_hostdeck");
      }
    },
    {
      label: "click outside focused bounds",
      mutate: (events: PhysicalTalkBackObserverEvent[]) => {
        events[11] = event(20, "click", "model_close", {
          bottom: 400,
          left: 300,
          right: 400,
          top: 300
        });
      }
    },
    {
      label: "duplicate activation",
      mutate: (events: PhysicalTalkBackObserverEvent[]) => {
        events.splice(12, 0, event(21, "click", "model_close"));
        for (let index = 13; index < events.length; index += 1) {
          events[index] = {
            ...events[index] as PhysicalTalkBackObserverEvent,
            sequence: events[index - 1]?.sequence as number + 1
          };
        }
      }
    }
  ])("rejects $label", ({ mutate }) => {
    const events = [...validTranscript()];
    mutate(events);
    expect(() => validatePhysicalTalkBackTranscript(events)).toThrow(
      "TalkBack transcript violated its ordered acceptance contract."
    );
  });
});

describe("physical TalkBack cleanup plan", () => {
  it("runs every cleanup action and returns every failure", async () => {
    const completed: string[] = [];
    const failures = await runPhysicalTalkBackCleanupPlan([
      () => {
        completed.push("observer");
        throw new Error("observer cleanup failed");
      },
      async () => {
        completed.push("settings");
      },
      () => {
        completed.push("permissions");
        throw new Error("permission cleanup failed");
      }
    ]);

    expect(completed).toEqual(["observer", "settings", "permissions"]);
    expect(failures).toHaveLength(2);
    expect((failures[0] as Error).message).toBe("observer cleanup failed");
    expect((failures[1] as Error).message).toBe("permission cleanup failed");
    expect(Object.isFrozen(failures)).toBe(true);
  });

  it("leaves a successful operation independent from cleanup failure collection", async () => {
    const failures = await runPhysicalTalkBackCleanupPlan([
      () => undefined,
      () => {
        throw new Error("bounded cleanup failure");
      }
    ]);

    expect(failures).toHaveLength(1);
    expect((failures[0] as Error).message).toBe("bounded cleanup failure");
  });
});

function validTranscript(): readonly PhysicalTalkBackObserverEvent[] {
  return Object.freeze([
    event(9, "focus", "remote_status"),
    event(10, "focus", "mission_control"),
    event(11, "focus", "selected_session", undefined, true),
    event(12, "click", "selected_session", undefined, true),
    event(13, "focus", "session_detail"),
    event(14, "focus", "approval_result"),
    event(15, "focus", "model_trigger", undefined, true),
    event(16, "click", "model_trigger", undefined, true),
    event(17, "focus", "model_close", undefined, true),
    event(18, "focus", "model_settings"),
    event(19, "focus", "model_close", undefined, true),
    event(20, "click", "model_close", undefined, true),
    event(21, "focus", "model_trigger", undefined, true),
    event(22, "focus", "known_hostdeck"),
    event(23, "focus", "back_to_mission", undefined, true),
    event(24, "click", "back_to_mission", undefined, true),
    event(25, "focus", "mission_control"),
    event(26, "focus", "remote_status")
  ]);
}

function event(
  sequence: number,
  kind: "click" | "focus",
  category: PhysicalTalkBackObserverCategory,
  bounds: PhysicalTalkBackObserverEvent["bounds"] = Object.freeze({
    bottom: 200,
    left: 100,
    right: 200,
    top: 100
  }),
  clickable = false
): PhysicalTalkBackObserverEvent {
  return Object.freeze({
    bounds,
    category,
    className: clickable ? "button" : "view",
    clickable,
    enabled: true,
    focusable: true,
    kind,
    sequence,
    visible: true
  });
}
