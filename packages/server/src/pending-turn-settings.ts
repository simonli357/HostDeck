import type { ManagedSessionTarget, PendingModelSelection } from "@hostdeck/contracts";

export type PendingTurnSettingControl = "model" | "plan";

export interface PendingTurnSetting {
  readonly control: PendingTurnSettingControl;
  readonly revision: number;
  readonly phase: PendingModelSelection["phase"];
}

export interface PendingTurnSettingsReader {
  readonly readPendingSettings: (target: ManagedSessionTarget) => readonly PendingTurnSetting[];
}

export function combinePendingTurnSettingsReaders(
  readers: readonly PendingTurnSettingsReader[]
): PendingTurnSettingsReader {
  if (readers.length === 0 || readers.some((reader) => typeof reader?.readPendingSettings !== "function")) {
    throw new TypeError("Pending turn settings require at least one valid reader.");
  }
  return Object.freeze({
    readPendingSettings(target: ManagedSessionTarget): readonly PendingTurnSetting[] {
      const settings = readers.flatMap((reader) => reader.readPendingSettings(target));
      const controls = new Set<PendingTurnSettingControl>();
      for (const setting of settings) {
        if (
          (setting.control !== "model" && setting.control !== "plan") ||
          !Number.isSafeInteger(setting.revision) ||
          setting.revision < 1 ||
          !["pending", "dispatching", "awaiting_confirmation", "unknown", "conflict"].includes(setting.phase)
        ) {
          throw new TypeError("Pending turn setting reader returned an invalid setting.");
        }
        if (controls.has(setting.control)) throw new TypeError(`Pending turn setting ${setting.control} has multiple owners.`);
        controls.add(setting.control);
      }
      return Object.freeze(settings.map((setting) => Object.freeze({ ...setting })));
    }
  });
}
