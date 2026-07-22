export const browserHttpResourceRanges = Object.freeze({
  requestTimeoutMs: Object.freeze({
    minimum: 1_000,
    defaultValue: 35_000,
    maximum: 180_000
  }),
  requestBodyMaxBytes: Object.freeze({
    minimum: 1_024,
    defaultValue: 65_536,
    maximum: 1_048_576
  }),
  responseMaxBytes: Object.freeze({
    minimum: 1_024,
    defaultValue: 1_048_576,
    maximum: 8_388_608
  }),
  maxInFlightRequests: Object.freeze({
    minimum: 1,
    defaultValue: 8,
    maximum: 32
  })
} as const);

export interface BrowserHttpClientLimits {
  readonly requestTimeoutMs: number;
  readonly requestBodyMaxBytes: number;
  readonly responseMaxBytes: number;
  readonly maxInFlightRequests: number;
}

export const defaultBrowserHttpClientLimits: BrowserHttpClientLimits =
  Object.freeze({
    requestTimeoutMs: browserHttpResourceRanges.requestTimeoutMs.defaultValue,
    requestBodyMaxBytes:
      browserHttpResourceRanges.requestBodyMaxBytes.defaultValue,
    responseMaxBytes: browserHttpResourceRanges.responseMaxBytes.defaultValue,
    maxInFlightRequests:
      browserHttpResourceRanges.maxInFlightRequests.defaultValue
  });
