import {
  type CodexConnectionNotification,
  type CodexEventNormalizerOptions,
  type CodexEventNormalizerReconciliation,
  type CodexOptionalNotificationDiagnostic,
  type CodexRedundantStateObservation,
  type CodexUnmanagedThreadObservation,
  createCodexEventNormalizer,
  type NormalizedCodexEvent
} from "@hostdeck/codex-adapter";
import { defaultResourceBudget } from "@hostdeck/contracts";
import type { CodexThreadId } from "@hostdeck/core";
import type { ProductionProjectionAppendPort, SelectedStateRepository } from "@hostdeck/storage";
import { type CodexProjectionResult, type CodexProjectionService, createCodexProjectionService } from "./codex-projection-service.js";

export type CodexEventPipelineErrorCode =
  | "invalid_connection_generation"
  | "pipeline_barrier_aborted"
  | "pipeline_capacity_exceeded"
  | "pipeline_stopped"
  | "thread_scope_changed";

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
      readonly kind: "redundant_observation";
      readonly sequence: number;
      readonly observation: CodexRedundantStateObservation;
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
  readonly observe_event?: (event: NormalizedCodexEvent, connection_generation: number) => void | Promise<void>;
}

export interface CodexEventPipeline {
  readonly consume: (
    notification: CodexConnectionNotification,
    connection_generation?: number
  ) => Promise<CodexEventPipelineResult>;
  readonly barrier: (signal?: AbortSignal) => Promise<CodexEventPipelineBarrier>;
  readonly reconcile: (
    threads: readonly CodexEventNormalizerReconciliation[],
    signal?: AbortSignal
  ) => Promise<CodexEventPipelineBarrier>;
  readonly failure: Error | null;
  readonly last_sequence: number;
  readonly pending_count: number;
}

export interface CodexEventPipelineBarrier {
  readonly last_sequence: number;
}

const defaultMaxPendingNotifications = defaultResourceBudget.protocol_max_pending_notifications;

class DefaultCodexEventPipeline implements CodexEventPipeline {
  private tail: Promise<void> = Promise.resolve();
  private currentFailure: Error | null = null;
  private currentPendingCount = 0;

  constructor(
    private readonly normalizer: ReturnType<typeof createCodexEventNormalizer>,
    private readonly projector: CodexProjectionService,
    private readonly maxPendingNotifications: number,
    private readonly observeEvent: CodexEventPipelineOptions["observe_event"]
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

  consume(
    notification: CodexConnectionNotification,
    connectionGeneration?: number
  ): Promise<CodexEventPipelineResult> {
    if (this.currentFailure !== null) return Promise.reject(this.stoppedError());
    if (this.observeEvent !== undefined && !validGeneration(connectionGeneration)) {
      const error = new HostDeckCodexEventPipelineError(
        "invalid_connection_generation",
        "Codex event observation requires the exact positive connection generation."
      );
      this.currentFailure = error;
      return Promise.reject(error);
    }
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
      return this.consumeOne(notification, connectionGeneration);
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

  async barrier(signal?: AbortSignal): Promise<CodexEventPipelineBarrier> {
    if (signal !== undefined && !isAbortSignal(signal)) {
      throw new TypeError("Codex event-pipeline barrier signal is invalid.");
    }
    while (true) {
      if (this.currentFailure !== null) throw this.stoppedError();
      const observedTail = this.tail;
      await settleBarrier(observedTail, signal);
      if (this.currentFailure !== null) throw this.stoppedError();
      if (observedTail === this.tail) {
        return Object.freeze({ last_sequence: this.normalizer.last_sequence });
      }
    }
  }

  reconcile(
    threads: readonly CodexEventNormalizerReconciliation[],
    signal?: AbortSignal
  ): Promise<CodexEventPipelineBarrier> {
    if (this.currentFailure !== null) return Promise.reject(this.stoppedError());
    if (signal !== undefined && !isAbortSignal(signal)) {
      return Promise.reject(new TypeError("Codex event-pipeline reconciliation signal is invalid."));
    }
    const operation = this.tail.then(() => {
      if (this.currentFailure !== null) throw this.stoppedError();
      if (signal?.aborted === true) throw barrierAborted(signal);
      this.normalizer.reconcile(threads);
      return Object.freeze({ last_sequence: this.normalizer.last_sequence });
    });
    this.tail = operation.then(
      () => undefined,
      (error: unknown) => {
        if (!isBarrierAbort(error) && this.currentFailure === null) {
          this.currentFailure = asError(error);
        }
      }
    );
    return operation;
  }

  private async consumeOne(
    notification: CodexConnectionNotification,
    connectionGeneration: number | undefined
  ): Promise<CodexEventPipelineResult> {
    const normalized = this.normalizer.normalize(notification);
    if (normalized.kind === "diagnostic") {
      return {
        kind: "optional_diagnostic",
        sequence: normalized.diagnostic.sequence,
        diagnostic: normalized.diagnostic
      };
    }
    if (normalized.kind === "redundant") {
      return {
        kind: "redundant_observation",
        sequence: normalized.observation.sequence,
        observation: normalized.observation
      };
    }
    if (normalized.kind === "unmanaged") return identityGateObservation(normalized.observation);

    const projected = await this.projector.project(normalized.event);
    if (projected.kind === "unmanaged_observation") {
      throw new HostDeckCodexEventPipelineError(
        "thread_scope_changed",
        "Codex thread mapping changed between identity classification and durable projection."
      );
    }
    if (this.observeEvent !== undefined) {
      await this.observeEvent(normalized.event, connectionGeneration as number);
    }
    return projected;
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
    (options.observe_event !== undefined && typeof options.observe_event !== "function") ||
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
    options.max_pending_notifications ?? defaultMaxPendingNotifications,
    options.observe_event
  );
  return Object.freeze({
    consume: (notification: CodexConnectionNotification, connectionGeneration?: number) =>
      pipeline.consume(notification, connectionGeneration),
    barrier: (signal?: AbortSignal) => pipeline.barrier(signal),
    reconcile: (threads: readonly CodexEventNormalizerReconciliation[], signal?: AbortSignal) =>
      pipeline.reconcile(threads, signal),
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

function settleBarrier(operation: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return operation;
  if (signal.aborted) return Promise.reject(barrierAborted(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(barrierAborted(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      () => {
        cleanup();
        resolve();
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      }
    );
  });
}

function barrierAborted(signal: AbortSignal): HostDeckCodexEventPipelineError {
  return new HostDeckCodexEventPipelineError(
    "pipeline_barrier_aborted",
    "Codex event-pipeline barrier was aborted.",
    { cause: signal.reason }
  );
}

function isBarrierAbort(error: unknown): boolean {
  return error instanceof HostDeckCodexEventPipelineError && error.code === "pipeline_barrier_aborted";
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

function validGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isAbortSignal(candidate: unknown): candidate is AbortSignal {
  return (
    candidate !== null &&
    typeof candidate === "object" &&
    typeof (candidate as AbortSignal).aborted === "boolean" &&
    typeof (candidate as AbortSignal).addEventListener === "function" &&
    typeof (candidate as AbortSignal).removeEventListener === "function"
  );
}
