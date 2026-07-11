export type StartupMaintenanceClockStopReason = "aborted" | "clock_failure" | "timeout";

export interface StartupMaintenanceClockCheck {
  readonly failure_code: "invalid_monotonic_clock" | null;
  readonly reason: StartupMaintenanceClockStopReason | null;
}

export interface StartupMaintenanceClockFinish {
  readonly duration_ms: number;
  readonly failure_code: "invalid_monotonic_clock" | null;
  readonly reason: "clock_failure" | "timeout" | null;
}

export interface StartupMaintenanceClock {
  readonly check: () => StartupMaintenanceClockCheck;
  readonly finish: () => StartupMaintenanceClockFinish;
}

export interface CreateStartupMaintenanceClockInput {
  readonly clock: () => number;
  readonly invalid_config: (message: string, cause?: unknown) => Error;
  readonly label: string;
  readonly signal: AbortSignal | null;
  readonly timeout_ms: number;
}

export function createStartupMaintenanceClock(input: CreateStartupMaintenanceClockInput): StartupMaintenanceClock {
  let startedAt: number;
  try {
    startedAt = input.clock();
  } catch (error) {
    throw input.invalid_config(`${input.label} monotonic clock failed before maintenance.`, error);
  }
  if (!Number.isFinite(startedAt) || startedAt < 0) {
    throw input.invalid_config(`${input.label} monotonic clock must return a finite non-negative number.`);
  }
  const deadline = startedAt + input.timeout_ms;
  if (!Number.isFinite(deadline)) {
    throw input.invalid_config(`${input.label} monotonic deadline is outside the finite clock range.`);
  }
  let lastTime = startedAt;

  return Object.freeze({
    check(): StartupMaintenanceClockCheck {
      if (input.signal?.aborted === true) {
        return Object.freeze({ failure_code: null, reason: "aborted" });
      }
      const reading = readClock(input.clock, lastTime);
      lastTime = reading.time;
      if (reading.failed) {
        return Object.freeze({ failure_code: "invalid_monotonic_clock", reason: "clock_failure" });
      }
      if (lastTime >= deadline) return Object.freeze({ failure_code: null, reason: "timeout" });
      return Object.freeze({ failure_code: null, reason: null });
    },
    finish(): StartupMaintenanceClockFinish {
      const reading = readClock(input.clock, lastTime);
      lastTime = reading.time;
      return Object.freeze({
        duration_ms: Math.max(0, lastTime - startedAt),
        failure_code: reading.failed ? "invalid_monotonic_clock" : null,
        reason: reading.failed ? "clock_failure" : lastTime >= deadline ? "timeout" : null
      });
    }
  });
}

function readClock(clock: () => number, priorTime: number): { readonly failed: boolean; readonly time: number } {
  try {
    const time = clock();
    if (!Number.isFinite(time) || time < priorTime) return { failed: true, time: priorTime };
    return { failed: false, time };
  } catch {
    return { failed: true, time: priorTime };
  }
}
