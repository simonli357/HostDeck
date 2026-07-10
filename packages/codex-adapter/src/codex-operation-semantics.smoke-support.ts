import { Buffer } from "node:buffer";
import type { HostDeckCodexAdapterError } from "./errors.js";
import type {
  CodexTextTransport,
  CodexTransportEvent,
  CodexTransportListener,
  CodexTransportState,
  UnsubscribeCodexTransport
} from "./transport.js";

export type CodexSemanticWireDirection = "client_to_server" | "server_to_client";
export type CodexSemanticWireKind =
  | "client_notification"
  | "client_request"
  | "client_response"
  | "invalid_json"
  | "server_notification"
  | "server_request"
  | "server_response"
  | "unknown_envelope";

export type CodexSemanticWireShape =
  | { readonly type: "array"; readonly count: number; readonly items: readonly CodexSemanticWireShape[] }
  | { readonly type: "boolean" }
  | { readonly type: "identifier" }
  | { readonly type: "null" }
  | { readonly type: "number" }
  | { readonly type: "object"; readonly fields: Readonly<Record<string, CodexSemanticWireShape>> }
  | { readonly type: "redacted_string"; readonly utf8_bytes: number }
  | { readonly type: "string" }
  | { readonly type: "truncated" };

export interface CodexSemanticWireSample {
  readonly sequence: number;
  readonly direction: CodexSemanticWireDirection;
  readonly kind: CodexSemanticWireKind;
  readonly method: string | null;
  readonly correlation: string | null;
  readonly shape: CodexSemanticWireShape;
  readonly tags: Readonly<Record<string, readonly string[]>>;
}

export interface CodexSemanticWireAggregate {
  readonly direction: CodexSemanticWireDirection;
  readonly kind: CodexSemanticWireKind;
  readonly method: string | null;
  readonly count: number;
  readonly first_sequence: number;
  readonly last_sequence: number;
  readonly sample: Omit<CodexSemanticWireSample, "sequence">;
}

export interface CodexSemanticWireSnapshot {
  readonly schema_version: 1;
  readonly total_frames: number;
  readonly total_utf8_bytes: number;
  readonly malformed_frames: number;
  readonly timeline_limit: number;
  readonly timeline_dropped: number;
  readonly timeline: readonly CodexSemanticWireSample[];
  readonly aggregates: readonly CodexSemanticWireAggregate[];
}

export interface CodexSemanticRecordingTransport {
  readonly transport: CodexTextTransport;
  readonly snapshot: () => CodexSemanticWireSnapshot;
  readonly dispose: () => void;
}

export interface CodexSemanticRecordingOptions {
  readonly timeline_limit?: number;
}

const defaultTimelineLimit = 256;
const maximumTimelineLimit = 1_024;
const maximumShapeDepth = 10;
const maximumShapeFields = 96;
const maximumArraySamples = 2;

const semanticTagKeys = new Set([
  "approvalPolicy",
  "approvalsReviewer",
  "classification",
  "decision",
  "effort",
  "errorCode",
  "historyMode",
  "kind",
  "mode",
  "model",
  "modelProvider",
  "outcome",
  "reasoning_effort",
  "retrySafe",
  "source",
  "status",
  "type"
]);

const highVolumeMethodPattern = /(?:\/delta$|\/outputDelta$|reasoning\/|rawResponseItem\/)/u;
const redactedStringKeyPattern =
  /(?:auth|command|content|cwd|delta|description|instruction|message|name|objective|output|path|preview|prompt|reason|secret|summary|text|token|url)/iu;
const identifierKeyPattern = /(?:^id$|Id$|_id$|Ids$|_ids$)/u;
const safeTagValuePattern = /^[A-Za-z0-9_.:/-]{1,100}$/u;

export function createCodexSemanticRecordingTransport(
  inner: CodexTextTransport,
  options: CodexSemanticRecordingOptions = {}
): CodexSemanticRecordingTransport {
  const timelineLimit = parseTimelineLimit(options.timeline_limit);
  const recorder = new CodexSemanticWireRecorder(timelineLimit);
  const transport = new RecordingCodexTextTransport(inner, recorder);
  return {
    transport,
    snapshot: () => recorder.snapshot(),
    dispose: () => transport.dispose()
  };
}

class RecordingCodexTextTransport implements CodexTextTransport {
  private readonly listeners = new Set<CodexTransportListener>();
  private readonly unsubscribeInner: UnsubscribeCodexTransport;
  private disposed = false;

  constructor(
    private readonly inner: CodexTextTransport,
    private readonly recorder: CodexSemanticWireRecorder
  ) {
    this.unsubscribeInner = inner.subscribe((event) => this.receiveInnerEvent(event));
  }

  get state(): CodexTransportState {
    return this.inner.state;
  }

  get generation(): number {
    return this.inner.generation;
  }

  get max_frame_bytes(): number {
    return this.inner.max_frame_bytes;
  }

  connect(signal?: AbortSignal): Promise<void> {
    return this.inner.connect(signal);
  }

  async sendText(text: string): Promise<void> {
    this.assertNotDisposed();
    this.recorder.record("client_to_server", text);
    await this.inner.sendText(text);
  }

  close(reason: string): Promise<void> {
    return this.inner.close(reason);
  }

  terminate(error: HostDeckCodexAdapterError): void {
    this.inner.terminate(error);
  }

  subscribe(listener: CodexTransportListener): UnsubscribeCodexTransport {
    this.assertNotDisposed();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeInner();
    this.listeners.clear();
  }

  private receiveInnerEvent(event: CodexTransportEvent): void {
    if (this.disposed) return;
    if (event.type === "message") this.recorder.record("server_to_client", event.text);
    for (const listener of [...this.listeners]) listener(event);
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error("Codex semantic recording transport is disposed.");
  }
}

class CodexSemanticWireRecorder {
  private sequence = 0;
  private totalUtf8Bytes = 0;
  private malformedFrames = 0;
  private timelineDropped = 0;
  private readonly timeline: CodexSemanticWireSample[] = [];
  private readonly aggregates = new Map<string, MutableAggregate>();
  private readonly clientRequests = new Map<string, string>();
  private readonly serverRequests = new Map<string, string>();
  private nextClientRequest = 1;
  private nextServerRequest = 1;

  constructor(private readonly timelineLimit: number) {}

  record(direction: CodexSemanticWireDirection, frame: string): void {
    this.sequence += 1;
    this.totalUtf8Bytes += Buffer.byteLength(frame, "utf8");

    let candidate: unknown;
    try {
      candidate = JSON.parse(frame) as unknown;
    } catch {
      this.malformedFrames += 1;
      this.recordSample({
        sequence: this.sequence,
        direction,
        kind: "invalid_json",
        method: null,
        correlation: null,
        shape: { type: "redacted_string", utf8_bytes: Buffer.byteLength(frame, "utf8") },
        tags: {}
      });
      return;
    }

    const envelope = classifyEnvelope(direction, candidate, this.clientRequests, this.serverRequests, {
      nextClient: () => `client_request_${this.nextClientRequest++}`,
      nextServer: () => `server_request_${this.nextServerRequest++}`
    });
    this.recordSample({
      sequence: this.sequence,
      direction,
      kind: envelope.kind,
      method: envelope.method,
      correlation: envelope.correlation,
      shape: describeShape(candidate),
      tags: collectSemanticTags(candidate)
    });
  }

  snapshot(): CodexSemanticWireSnapshot {
    return Object.freeze({
      schema_version: 1,
      total_frames: this.sequence,
      total_utf8_bytes: this.totalUtf8Bytes,
      malformed_frames: this.malformedFrames,
      timeline_limit: this.timelineLimit,
      timeline_dropped: this.timelineDropped,
      timeline: Object.freeze(this.timeline.map((entry) => freezeSample(entry))),
      aggregates: Object.freeze(
        [...this.aggregates.values()]
          .sort((left, right) => left.first_sequence - right.first_sequence)
          .map((entry) =>
            Object.freeze({
              direction: entry.sample.direction,
              kind: entry.sample.kind,
              method: entry.sample.method,
              count: entry.count,
              first_sequence: entry.first_sequence,
              last_sequence: entry.last_sequence,
              sample: freezeSampleWithoutSequence(entry.sample)
            })
          )
      )
    });
  }

  private recordSample(sample: CodexSemanticWireSample): void {
    const aggregateKey = JSON.stringify([
      sample.direction,
      sample.kind,
      sample.method,
      sample.shape,
      sample.tags
    ]);
    const current = this.aggregates.get(aggregateKey);
    if (current === undefined) {
      this.aggregates.set(aggregateKey, {
        sample,
        count: 1,
        first_sequence: sample.sequence,
        last_sequence: sample.sequence
      });
    } else {
      current.count += 1;
      current.last_sequence = sample.sequence;
    }

    if (!shouldKeepInTimeline(sample)) return;
    if (this.timeline.length >= this.timelineLimit) {
      this.timelineDropped += 1;
      return;
    }
    this.timeline.push(sample);
  }
}

interface MutableAggregate {
  readonly sample: CodexSemanticWireSample;
  count: number;
  readonly first_sequence: number;
  last_sequence: number;
}

interface EnvelopeClassification {
  readonly kind: CodexSemanticWireKind;
  readonly method: string | null;
  readonly correlation: string | null;
}

function classifyEnvelope(
  direction: CodexSemanticWireDirection,
  candidate: unknown,
  clientRequests: Map<string, string>,
  serverRequests: Map<string, string>,
  labels: { readonly nextClient: () => string; readonly nextServer: () => string }
): EnvelopeClassification {
  if (!isRecord(candidate)) return { kind: "unknown_envelope", method: null, correlation: null };
  const method = typeof candidate.method === "string" ? candidate.method : null;
  const hasId = Object.hasOwn(candidate, "id");
  const key = hasId ? requestIdKey(candidate.id) : null;

  if (method !== null) {
    if (!hasId) {
      return {
        kind: direction === "client_to_server" ? "client_notification" : "server_notification",
        method,
        correlation: null
      };
    }
    if (key === null) return { kind: "unknown_envelope", method, correlation: null };
    if (direction === "client_to_server") {
      const correlation = labels.nextClient();
      clientRequests.set(key, `${correlation}:${method}`);
      return { kind: "client_request", method, correlation };
    }
    const correlation = labels.nextServer();
    serverRequests.set(key, `${correlation}:${method}`);
    return { kind: "server_request", method, correlation };
  }

  if (!hasId || key === null || (!Object.hasOwn(candidate, "result") && !Object.hasOwn(candidate, "error"))) {
    return { kind: "unknown_envelope", method: null, correlation: null };
  }
  const lookup = direction === "server_to_client" ? clientRequests.get(key) : serverRequests.get(key);
  const parsed = splitCorrelation(lookup);
  return {
    kind: direction === "server_to_client" ? "client_response" : "server_response",
    method: parsed.method,
    correlation: parsed.correlation
  };
}

function splitCorrelation(candidate: string | undefined): { readonly correlation: string | null; readonly method: string | null } {
  if (candidate === undefined) return { correlation: null, method: null };
  const separator = candidate.indexOf(":");
  if (separator < 1) return { correlation: candidate, method: null };
  return { correlation: candidate.slice(0, separator), method: candidate.slice(separator + 1) };
}

function requestIdKey(candidate: unknown): string | null {
  if (typeof candidate === "number" && Number.isSafeInteger(candidate)) return `number:${candidate}`;
  if (typeof candidate === "string") return `string:${candidate}`;
  return null;
}

function describeShape(candidate: unknown, key = "", depth = 0): CodexSemanticWireShape {
  if (candidate === null) return { type: "null" };
  if (depth >= maximumShapeDepth) return { type: "truncated" };
  if (typeof candidate === "boolean") return { type: "boolean" };
  if (typeof candidate === "number") return { type: "number" };
  if (typeof candidate === "string") {
    if (identifierKeyPattern.test(key)) return { type: "identifier" };
    if (redactedStringKeyPattern.test(key)) {
      return { type: "redacted_string", utf8_bytes: Buffer.byteLength(candidate, "utf8") };
    }
    return { type: "string" };
  }
  if (Array.isArray(candidate)) {
    const items: CodexSemanticWireShape[] = [];
    const unique = new Set<string>();
    for (const value of candidate.slice(0, maximumArraySamples)) {
      const shape = describeShape(value, key, depth + 1);
      const identity = JSON.stringify(shape);
      if (unique.has(identity)) continue;
      unique.add(identity);
      items.push(shape);
    }
    return { type: "array", count: candidate.length, items };
  }
  if (isRecord(candidate)) {
    const fields: Record<string, CodexSemanticWireShape> = {};
    const keys = Object.keys(candidate).sort();
    for (const field of keys.slice(0, maximumShapeFields)) {
      fields[field] = describeShape(candidate[field], field, depth + 1);
    }
    if (keys.length > maximumShapeFields) fields["<additional_fields>"] = { type: "number" };
    return { type: "object", fields };
  }
  return { type: "string" };
}

function collectSemanticTags(candidate: unknown): Readonly<Record<string, readonly string[]>> {
  const found = new Map<string, Set<string>>();
  visit(candidate, 0);
  return Object.freeze(
    Object.fromEntries(
      [...found.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, values]) => [key, Object.freeze([...values].sort())])
    )
  );

  function visit(value: unknown, depth: number): void {
    if (depth >= maximumShapeDepth) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, maximumArraySamples)) visit(item, depth + 1);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, item] of Object.entries(value).slice(0, maximumShapeFields)) {
      if (semanticTagKeys.has(key) && typeof item === "string" && safeTagValuePattern.test(item)) {
        const values = found.get(key) ?? new Set<string>();
        values.add(item);
        found.set(key, values);
      }
      visit(item, depth + 1);
    }
  }
}

function shouldKeepInTimeline(sample: CodexSemanticWireSample): boolean {
  if (sample.kind !== "server_notification") return true;
  return sample.method === null || !highVolumeMethodPattern.test(sample.method);
}

function freezeSample(sample: CodexSemanticWireSample): CodexSemanticWireSample {
  return Object.freeze({ ...sample, shape: freezeShape(sample.shape), tags: freezeTags(sample.tags) });
}

function freezeSampleWithoutSequence(sample: CodexSemanticWireSample): Omit<CodexSemanticWireSample, "sequence"> {
  return Object.freeze({
    direction: sample.direction,
    kind: sample.kind,
    method: sample.method,
    correlation: sample.correlation,
    shape: freezeShape(sample.shape),
    tags: freezeTags(sample.tags)
  });
}

function freezeShape(shape: CodexSemanticWireShape): CodexSemanticWireShape {
  if (shape.type === "array") {
    return Object.freeze({ ...shape, items: Object.freeze(shape.items.map((item) => freezeShape(item))) });
  }
  if (shape.type === "object") {
    return Object.freeze({
      ...shape,
      fields: Object.freeze(Object.fromEntries(Object.entries(shape.fields).map(([key, value]) => [key, freezeShape(value)])))
    });
  }
  return Object.freeze({ ...shape });
}

function freezeTags(tags: Readonly<Record<string, readonly string[]>>): Readonly<Record<string, readonly string[]>> {
  return Object.freeze(Object.fromEntries(Object.entries(tags).map(([key, values]) => [key, Object.freeze([...values])])))
}

function parseTimelineLimit(candidate: number | undefined): number {
  if (candidate === undefined) return defaultTimelineLimit;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > maximumTimelineLimit) {
    throw new TypeError(`Codex semantic recorder timeline_limit must be an integer from 1 to ${maximumTimelineLimit}.`);
  }
  return candidate;
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate);
}
