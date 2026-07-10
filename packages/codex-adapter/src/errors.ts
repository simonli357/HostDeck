export type CodexAdapterErrorCode =
  | "broker_closed"
  | "broker_overloaded"
  | "handshake_failed"
  | "invalid_protocol_message"
  | "invalid_transport_config"
  | "protocol_violation"
  | "remote_error"
  | "request_aborted"
  | "request_timeout"
  | "transport_aborted"
  | "transport_closed"
  | "transport_connect_failed"
  | "transport_not_open"
  | "transport_overloaded"
  | "transport_send_failed"
  | "unknown_outcome"
  | "unsupported_method";

export type CodexOperationOutcome = "not_applicable" | "not_sent" | "remote_rejected" | "unknown";

export interface CodexAdapterErrorOptions extends ErrorOptions {
  readonly outcome?: CodexOperationOutcome;
  readonly retry_safe?: boolean;
  readonly rpc_code?: number | null;
}

export class HostDeckCodexAdapterError extends Error {
  readonly outcome: CodexOperationOutcome;
  readonly retry_safe: boolean;
  readonly rpc_code: number | null;

  constructor(
    readonly code: CodexAdapterErrorCode,
    message: string,
    options: CodexAdapterErrorOptions = {}
  ) {
    super(boundedProtocolText(message), options);
    this.name = "HostDeckCodexAdapterError";
    this.outcome = options.outcome ?? "not_applicable";
    this.retry_safe = options.retry_safe ?? false;
    this.rpc_code = options.rpc_code ?? null;
  }
}

export function boundedProtocolText(value: string, fallback = "Codex adapter failed without a usable reason."): string {
  let printable = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charAt(index);
    const code = character.charCodeAt(0);
    printable += code <= 31 || code === 127 ? " " : character;
  }
  const normalized = printable.replace(/\s+/gu, " ").trim() || fallback;
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`;
}
