export const browserSseResourceRanges = Object.freeze({
  connectTimeoutMs: Object.freeze({
    minimum: 1_000,
    defaultValue: 35_000,
    maximum: 180_000
  }),
  idleTimeoutMs: Object.freeze({
    minimum: 5_000,
    defaultValue: 45_000,
    maximum: 300_000
  }),
  errorResponseMaxBytes: Object.freeze({
    minimum: 1_024,
    defaultValue: 65_536,
    maximum: 1_048_576
  }),
  eventMaxBytes: Object.freeze({
    minimum: 1_024,
    defaultValue: 65_536,
    maximum: 262_144
  }),
  reconnectInitialDelayMs: Object.freeze({
    minimum: 50,
    defaultValue: 500,
    maximum: 5_000
  }),
  reconnectMaxDelayMs: Object.freeze({
    minimum: 100,
    defaultValue: 10_000,
    maximum: 60_000
  }),
  maxReconnectAttempts: Object.freeze({
    minimum: 1,
    defaultValue: 8,
    maximum: 32
  }),
  maxConcurrentStreams: Object.freeze({
    minimum: 1,
    defaultValue: 2,
    maximum: 32
  })
} as const);

export interface BrowserSseClientLimits {
  readonly connectTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly errorResponseMaxBytes: number;
  readonly eventMaxBytes: number;
  readonly reconnectInitialDelayMs: number;
  readonly reconnectMaxDelayMs: number;
  readonly maxReconnectAttempts: number;
  readonly maxConcurrentStreams: number;
}

export const defaultBrowserSseClientLimits: BrowserSseClientLimits =
  Object.freeze({
    connectTimeoutMs: browserSseResourceRanges.connectTimeoutMs.defaultValue,
    idleTimeoutMs: browserSseResourceRanges.idleTimeoutMs.defaultValue,
    errorResponseMaxBytes:
      browserSseResourceRanges.errorResponseMaxBytes.defaultValue,
    eventMaxBytes: browserSseResourceRanges.eventMaxBytes.defaultValue,
    reconnectInitialDelayMs:
      browserSseResourceRanges.reconnectInitialDelayMs.defaultValue,
    reconnectMaxDelayMs:
      browserSseResourceRanges.reconnectMaxDelayMs.defaultValue,
    maxReconnectAttempts:
      browserSseResourceRanges.maxReconnectAttempts.defaultValue,
    maxConcurrentStreams:
      browserSseResourceRanges.maxConcurrentStreams.defaultValue
  });
