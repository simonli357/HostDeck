import type { NormalizedCodexEvent } from "@hostdeck/codex-adapter";
import type {
  CommittedProjectionAppend,
  ProductionProjectionAppendInput,
  ProductionProjectionAppendPort,
  SelectedStateRepository
} from "@hostdeck/storage";
import { selectedStateRevision } from "@hostdeck/storage";
import { reduceCodexProjectionEvent } from "./codex-projection-reducer.js";

export type CodexProjectionErrorCode =
  | "event_out_of_order"
  | "event_too_late"
  | "projection_stopped";

export class HostDeckCodexProjectionError extends Error {
  constructor(
    readonly code: CodexProjectionErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostDeckCodexProjectionError";
  }
}

export type CodexProjectionResult =
  | {
      readonly kind: "committed";
      readonly sequence: number;
      readonly committed: CommittedProjectionAppend;
    }
  | {
      readonly kind: "runtime_observation";
      readonly sequence: number;
      readonly event: Extract<NormalizedCodexEvent, { readonly scope: "runtime" }>;
    }
  | {
      readonly kind: "unmanaged_observation";
      readonly sequence: number;
      readonly thread_id: Extract<NormalizedCodexEvent, { readonly scope: "thread" }>["thread_id"];
      readonly method: string;
    };

export interface CodexProjectionServiceOptions {
  readonly repository: SelectedStateRepository;
  readonly append_port: ProductionProjectionAppendPort;
}

export interface CodexProjectionService {
  readonly project: (event: NormalizedCodexEvent) => Promise<CodexProjectionResult>;
  readonly failure: Error | null;
  readonly last_sequence: number;
}

class DefaultCodexProjectionService implements CodexProjectionService {
  private tail: Promise<void> = Promise.resolve();
  private currentFailure: Error | null = null;
  private currentLastSequence = 0;

  constructor(private readonly options: CodexProjectionServiceOptions) {}

  get failure(): Error | null {
    return this.currentFailure;
  }

  get last_sequence(): number {
    return this.currentLastSequence;
  }

  project(event: NormalizedCodexEvent): Promise<CodexProjectionResult> {
    const operation = this.tail.then(() => {
      if (this.currentFailure !== null) {
        throw new HostDeckCodexProjectionError("projection_stopped", "Codex projection stopped after an earlier failure.", {
          cause: this.currentFailure
        });
      }
      return this.projectOne(event);
    });
    this.tail = operation.then(
      () => undefined,
      (error: unknown) => {
        if (this.currentFailure === null) this.currentFailure = asError(error);
      }
    );
    return operation;
  }

  private async projectOne(event: NormalizedCodexEvent): Promise<CodexProjectionResult> {
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= this.currentLastSequence) {
      throw new HostDeckCodexProjectionError(
        "event_out_of_order",
        `Codex normalized event sequence ${event.sequence} did not advance beyond ${this.currentLastSequence}.`
      );
    }
    this.currentLastSequence = event.sequence;
    if (event.scope === "runtime") return { kind: "runtime_observation", sequence: event.sequence, event };

    const current = this.options.repository.getByThreadId(event.thread_id);
    if (current === null || current.mapping.archived_at !== null) {
      return {
        kind: "unmanaged_observation",
        sequence: event.sequence,
        thread_id: event.thread_id,
        method: event.method
      };
    }
    if (event.captured_at < current.projection.session.updated_at) {
      throw new HostDeckCodexProjectionError("event_too_late", "Codex event capture time precedes the committed session projection.");
    }
    const reduction = reduceCodexProjectionEvent(current, event);
    const input: ProductionProjectionAppendInput = {
      session_id: current.mapping.id,
      expected_revision: selectedStateRevision(current),
      event: reduction.event,
      next_session: reduction.next_session
    };
    const committed = await this.options.append_port.append(input);
    return { kind: "committed", sequence: event.sequence, committed };
  }
}

export function createCodexProjectionService(options: CodexProjectionServiceOptions): CodexProjectionService {
  if (
    options === null ||
    typeof options !== "object" ||
    typeof options.repository?.getByThreadId !== "function" ||
    typeof options.append_port?.append !== "function"
  ) {
    throw new TypeError("Codex projection service requires selected-state and production append ports.");
  }
  const service = new DefaultCodexProjectionService({
    repository: options.repository,
    append_port: options.append_port
  });
  return Object.freeze({
    project: (event: NormalizedCodexEvent) => service.project(event),
    get failure() {
      return service.failure;
    },
    get last_sequence() {
      return service.last_sequence;
    }
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
