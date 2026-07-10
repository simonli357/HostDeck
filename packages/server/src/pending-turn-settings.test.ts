import { describe, expect, it } from "vitest";
import {
  combinePendingTurnSettingsReaders,
  type PendingTurnSettingsReader
} from "./pending-turn-settings.js";

const target = {
  type: "managed_session",
  session_id: "sess_pending_settings" as never,
  codex_thread_id: "thread-pending-settings" as never
} as const;

describe("pending turn setting composition", () => {
  it("combines one model and one Plan owner without losing revisions", () => {
    const combined = combinePendingTurnSettingsReaders([
      reader({ control: "model", revision: 2, phase: "pending" }),
      reader({ control: "plan", revision: 5, phase: "awaiting_confirmation" })
    ]);
    expect(combined.readPendingSettings(target)).toEqual([
      { control: "model", revision: 2, phase: "pending" },
      { control: "plan", revision: 5, phase: "awaiting_confirmation" }
    ]);
  });

  it("rejects missing readers and duplicate control ownership", () => {
    expect(() => combinePendingTurnSettingsReaders([])).toThrow();
    const combined = combinePendingTurnSettingsReaders([
      reader({ control: "model", revision: 1, phase: "pending" }),
      reader({ control: "model", revision: 2, phase: "conflict" })
    ]);
    expect(() => combined.readPendingSettings(target)).toThrow();
    const invalid = combinePendingTurnSettingsReaders([
      { readPendingSettings: () => [{ control: "model", revision: 0, phase: "pending" }] }
    ]);
    expect(() => invalid.readPendingSettings(target)).toThrow();
  });
});

function reader(setting: {
  readonly control: "model" | "plan";
  readonly revision: number;
  readonly phase: "awaiting_confirmation" | "conflict" | "pending";
}): PendingTurnSettingsReader {
  return { readPendingSettings: () => [setting] };
}
