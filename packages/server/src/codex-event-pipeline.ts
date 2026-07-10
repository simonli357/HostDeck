import {
  type CodexConnectionNotification,
  type CodexEventNormalizerOptions,
  type CodexOptionalNotificationDiagnostic,
  type CodexUnmanagedThreadObservation,
  createCodexEventNormalizer
} from "@hostdeck/codex-adapter";
import { defaultResourceBudget } from "@hostdeck/contracts";
import type { CodexThreadId } from "@hostdeck/core";
import type { ProductionProjectionAppendPort, SelectedStateRepository } from "@hostdeck/storage";
import { type CodexProjectionResult, type CodexProjectionService, createCodexProjectionService } from "./codex-projection-service.js";

export type CodexEventPipelineErrorCode = "pipeline_capacity_exceeded" | "pipeline_stopped" | "thread_scope_changed";

export class HostDeckCodexEventPipelineError extends Error {
  constructor(
    readonly code: CodexEventPipelineErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostDeckCodexEventPipelineError";
  }
}

export type CodexEventPipelineResult =
  | Exclude<CodexProjectionResult, { readonly kind: "unmanaged_observation" }>
  | {
      readonly kind: "optional_diagnostic";
      readonly sequence: number;
      readonly diagnostic: CodexOptionalNotificationDiagnostic;
    }
  | {
      readonly kind: "unmanaged_observation";
      readonly sequence: number;
      readonly thread_id: CodexThreadId;
      readonly method: string;
      readonly source: "identity_gate";
      readonly total_count: number;
    };

export interface CodexEventPipelineOptions {
  readonly repository: SelectedStateRepository;
  readonly append_port: ProductionProjectionAppendPort;
  readonly normalizer?: Omit<CodexEventNormalizerOptions, "is_managed_thread">;
  readonly is_managed_thread?: (thread_id: CodexThreadId) => boolean;
  readonly max_pending_notifications?: number;
}

export interface CodexEventPipeline {
  readonly consume: (notification: CodexConnectionNotification) => Promise<CodexEventPipelineResult>;
  readonly failure: Error | null;
  readonly last_sequence: number;
  readonly pending_count: number;
}

const defaultMaxPendingNotifications = defaultResourceBudget.protocol_max_pending_notifications;

class DefaultCodexEventPipeline implements CodexEventPipeline {
  private tail: Promise<void> = Promise.resolve();
  private currentFailure: Error | null = null;
  private currentPendingCount = 0;

  constructor(
    private readonly normalizer: ReturnType<typeof createCodexEventNormalizer>,
    private readonly projector: CodexProjectionService,
    private readonly maxPendingNotifications: number
  ) {}

  get failure(): Error | null {
    return this.currentFailure;
  }

  get last_sequence(): number {
    return this.normalizer.last_sequence;
  }

  get pending_count(): number {
    return this.currentPendingCount;
  }

  consume(notification: CodexConnectionNotification): Promise<CodexEventPipelineResult> {
    if (this.currentFailure !== null) return Promise.reject(this.stoppedError());
    if (this.currentPendingCount >= this.maxPendingNotifications) {
      const error = new HostDeckCodexEventPipelineError(
        "pipeline_capacity_exceeded",
        `Codex event pipeline exceeded ${this.maxPendingNotifications} pending notifications.`
      );
      this.currentFailure = error;
      return Promise.reject(error);
    }
    this.currentPendingCount += 1;
    const operation = this.tail.then(() => {
      if (this.currentFailure !== null) {
        throw this.stoppedError();
      }
      return this.consumeOne(notification);
    });
    const tracked = operation.finally(() => {
      this.currentPendingCount -= 1;
    });
    this.tail = tracked.then(
      () => undefined,
      (error: unknown) => {
        if (this.currentFailure === null) this.currentFailure = asError(error);
      }
    );
    return tracked;
  }

  private async consumeOne(notification: CodexConnectionNotification): Promise<CodexEventPipelineResult> {
    const normalized = this.normalizer.normalize(notification);
    if (normalized.kind === "diagnostic") {
      return {
        kind: "optional_diagnostic",
        sequence: normalized.diagnostic.sequence,
        diagnostic: normalized.diagnostic
      };
    }
    if (normalized.kind === "unmanaged") return identityGateObservation(normalized.observation);

    const projected = await this.projector.project(normalized.event);
    if (projected.kind !== "unmanaged_observation") return projected;
    throw new HostDeckCodexEventPipelineError(
      "thread_scope_changed",
      "Codex thread mapping changed between identity classification and durable projection."
    );
  }

  private stoppedError(): HostDeckCodexEventPipelineError {
    return new HostDeckCodexEventPipelineError(
      "pipeline_stopped",
      "Codex event pipeline stopped after an earlier normalization, storage, publication, or capacity failure.",
      { cause: this.currentFailure ?? undefined }
    );
  }
}

export function createCodexEventPipeline(options: CodexEventPipelineOptions): CodexEventPipeline {
  if (
    options === null ||
    typeof options !== "object" ||
    typeof options.repository?.getByThreadId !== "function" ||
    typeof options.append_port?.append !== "function" ||
    (options.is_managed_thread !== undefined && typeof options.is_managed_thread !== "function") ||
    (options.max_pending_notifications !== undefined && !validCapacity(options.max_pending_notifications))
  ) {
    throw new TypeError("Codex event pipeline requires selected-state, production append, and valid thread-scope ports.");
  }

  const classifyThread =
    options.is_managed_thread ??
    ((threadId: CodexThreadId) => {
      const state = options.repository.getByThreadId(threadId);
      return state !== null && state.mapping.archived_at === null;
    });
  const normalizer = createCodexEventNormalizer({
    ...(options.normalizer ?? {}),
    is_managed_thread: classifyThread
  });
  const projector = createCodexProjectionService({ repository: options.repository, append_port: options.append_port });
  const pipeline = new DefaultCodexEventPipeline(
    normalizer,
    projector,
    options.max_pending_notifications ?? defaultMaxPendingNotifications
  );
  return Object.freeze({
    consume: (notification: CodexConnectionNotification) => pipeline.consume(notification),
    get failure() {
      return pipeline.failure;
    },
    get last_sequence() {
      return pipeline.last_sequence;
    },
    get pending_count() {
      return pipeline.pending_count;
    }
  });
}

function identityGateObservation(observation: CodexUnmanagedThreadObservation): CodexEventPipelineResult {
  return {
    kind: "unmanaged_observation",
    sequence: observation.sequence,
    thread_id: observation.thread_id,
    method: observation.method,
    source: "identity_gate",
    total_count: observation.total_count
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function validCapacity(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 100_000;
}
