import { HostDeckCodexAdapterError } from "./errors.js";
import type {
  CodexTextTransport,
  CodexTransportEvent,
  CodexTransportListener,
  CodexTransportState,
  UnsubscribeCodexTransport
} from "./transport.js";

export interface ScriptedCodexTransportOptions {
  readonly max_frame_bytes?: number;
  readonly on_send?: (text: string, transport: ScriptedCodexTransport) => void | Promise<void>;
}

export class ScriptedCodexTransport implements CodexTextTransport {
  readonly sent_frames: string[] = [];
  readonly max_frame_bytes: number;
  private readonly listeners = new Set<CodexTransportListener>();
  private currentState: CodexTransportState = "idle";
  private currentGeneration = 0;

  constructor(private readonly options: ScriptedCodexTransportOptions = {}) {
    this.max_frame_bytes = options.max_frame_bytes ?? 1_048_576;
  }

  get state(): CodexTransportState {
    return this.currentState;
  }

  get generation(): number {
    return this.currentGeneration;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) {
      throw new HostDeckCodexAdapterError("transport_aborted", "Scripted Codex transport connection was aborted.", {
        outcome: "not_sent",
        retry_safe: true
      });
    }
    if (["connecting", "open", "closing"].includes(this.currentState)) {
      throw new HostDeckCodexAdapterError("transport_connect_failed", "Scripted Codex transport is already active.", {
        outcome: "not_sent",
        retry_safe: true
      });
    }
    this.currentState = "open";
    this.currentGeneration += 1;
    this.emit({ type: "open", generation: this.currentGeneration });
  }

  async sendText(text: string): Promise<void> {
    if (this.currentState !== "open") {
      throw new HostDeckCodexAdapterError("transport_not_open", "Scripted Codex transport is not open.", {
        outcome: "not_sent",
        retry_safe: true
      });
    }
    this.sent_frames.push(text);
    await this.options.on_send?.(text, this);
  }

  async close(reason: string): Promise<void> {
    if (this.currentState === "closed") return;
    this.currentState = "closed";
    this.emit({ type: "close", generation: this.currentGeneration, code: 1000, reason, clean: true });
  }

  terminate(error: HostDeckCodexAdapterError): void {
    this.emit({ type: "error", generation: this.currentGeneration, error });
    this.currentState = "closed";
    this.emit({ type: "close", generation: this.currentGeneration, code: 1006, reason: error.message, clean: false });
  }

  subscribe(listener: CodexTransportListener): UnsubscribeCodexTransport {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  receive(text: string): void {
    if (this.currentState !== "open") throw new Error("Scripted Codex transport must be open before receiving a frame.");
    this.emit({ type: "message", generation: this.currentGeneration, text });
  }

  receiveFromGeneration(text: string, generation: number): void {
    if (this.currentState !== "open") throw new Error("Scripted Codex transport must be open before receiving a frame.");
    this.emit({ type: "message", generation, text });
  }

  disconnect(reason = "scripted disconnect"): void {
    if (this.currentState !== "open") return;
    this.currentState = "closed";
    this.emit({ type: "close", generation: this.currentGeneration, code: 1006, reason, clean: false });
  }

  clearSentFrames(): void {
    this.sent_frames.length = 0;
  }

  private emit(event: CodexTransportEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}
