import type { NormalizedCodexEvent } from "@hostdeck/codex-adapter";
import type { CodexApprovalControlService } from "./codex-approval-control-service.js";
import type { CodexCompactControlService } from "./codex-compact-control-service.js";
import type { CodexGoalControlService } from "./codex-goal-control-service.js";
import type { CodexInterruptControlService } from "./codex-interrupt-control-service.js";
import type { CodexPlanControlService } from "./codex-plan-control-service.js";
import type { CodexPromptControlService } from "./codex-prompt-control-service.js";
import type { CodexUsageControlService } from "./codex-usage-control-service.js";

export const codexControlEventObserverNames = Object.freeze([
  "plan_and_model",
  "goal",
  "compact",
  "usage",
  "approval",
  "interrupt",
  "prompt"
] as const);

export type CodexControlEventObserverName = (typeof codexControlEventObserverNames)[number];
export type CodexControlEventObserverErrorCode = "invalid_event" | "invalid_generation" | "observer_failed";

export class HostDeckCodexControlEventObserverError extends Error {
  constructor(
    readonly code: CodexControlEventObserverErrorCode,
    readonly observer: CodexControlEventObserverName | null,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostDeckCodexControlEventObserverError";
  }
}

export interface CodexControlEventObserverOptions {
  readonly plans: Pick<CodexPlanControlService, "observeEvent">;
  readonly goals: Pick<CodexGoalControlService, "observeGoal">;
  readonly compact: Pick<CodexCompactControlService, "observe">;
  readonly usage: Pick<CodexUsageControlService, "observe">;
  readonly approvals: Pick<CodexApprovalControlService, "observeEvent">;
  readonly interrupts: Pick<CodexInterruptControlService, "observeEvent">;
  readonly prompts: Pick<CodexPromptControlService, "observeEvent">;
}

export interface CodexControlEventObservationReceipt {
  readonly sequence: number;
  readonly method: NormalizedCodexEvent["method"];
  readonly connection_generation: number;
  readonly observers: readonly CodexControlEventObserverName[];
}

export interface CodexControlEventObserver {
  readonly observe: (
    event: NormalizedCodexEvent,
    connection_generation: number
  ) => Promise<CodexControlEventObservationReceipt>;
}

export function createCodexControlEventObserver(
  options: CodexControlEventObserverOptions
): CodexControlEventObserver {
  const parsed = parseOptions(options);
  return Object.freeze({
    observe: (event: NormalizedCodexEvent, generation: number) => observeEvent(parsed, event, generation)
  });
}

async function observeEvent(
  options: CodexControlEventObserverOptions,
  event: NormalizedCodexEvent,
  generation: number
): Promise<CodexControlEventObservationReceipt> {
  if (
    event === null ||
    typeof event !== "object" ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence < 1 ||
    typeof event.method !== "string" ||
    event.method.length === 0
  ) {
    throw observerError("invalid_event", null, "Normalized Codex control observation is invalid.");
  }
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw observerError("invalid_generation", null, "Codex control observation generation is invalid.");
  }

  await invoke("plan_and_model", () => options.plans.observeEvent(event));
  await invoke("goal", () => options.goals.observeGoal(event));
  await invoke("compact", () => options.compact.observe(event, generation));
  await invoke("usage", () => options.usage.observe(event, generation));
  await invoke("approval", () => options.approvals.observeEvent(event));
  await invoke("interrupt", () => options.interrupts.observeEvent(event));
  await invoke("prompt", () => options.prompts.observeEvent(event));

  return Object.freeze({
    sequence: event.sequence,
    method: event.method,
    connection_generation: generation,
    observers: codexControlEventObserverNames
  });
}

async function invoke(observer: CodexControlEventObserverName, operation: () => unknown): Promise<void> {
  try {
    await operation();
  } catch (error) {
    throw observerError(
      "observer_failed",
      observer,
      `Codex ${observer} control observer failed after normalized event acceptance.`,
      error
    );
  }
}

function parseOptions(candidate: unknown): CodexControlEventObserverOptions {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    (Object.getPrototypeOf(candidate) !== Object.prototype && Object.getPrototypeOf(candidate) !== null)
  ) {
    throw new TypeError("Codex control event observer options must be a plain object.");
  }
  const value = candidate as Readonly<Record<string, unknown>>;
  const expected = ["approvals", "compact", "goals", "interrupts", "plans", "prompts", "usage"];
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected)) {
    throw new TypeError("Codex control event observer option fields are invalid.");
  }
  const methods = [
    [value.plans, "observeEvent"],
    [value.goals, "observeGoal"],
    [value.compact, "observe"],
    [value.usage, "observe"],
    [value.approvals, "observeEvent"],
    [value.interrupts, "observeEvent"],
    [value.prompts, "observeEvent"]
  ] as const;
  if (
    methods.some(
      ([port, method]) => port === null || typeof port !== "object" || typeof (port as Record<string, unknown>)[method] !== "function"
    )
  ) {
    throw new TypeError("Codex control event observer requires every exact control observation port.");
  }
  return Object.freeze(value as unknown as CodexControlEventObserverOptions);
}

function observerError(
  code: CodexControlEventObserverErrorCode,
  observer: CodexControlEventObserverName | null,
  message: string,
  cause?: unknown
): HostDeckCodexControlEventObserverError {
  return new HostDeckCodexControlEventObserverError(code, observer, message, { cause });
}
