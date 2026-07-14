import {
  apiRouteErrorBodySchema,
  defaultResourceBudget,
  remoteExternalOriginSchema,
  type SelectedCsrfBootstrapResponse,
  type SelectedPairClaimResponse,
  selectedCsrfBootstrapRequestSchema,
  selectedCsrfBootstrapResponseSchema,
  selectedPairClaimRequestSchema,
  selectedPairClaimResponseSchema,
  selectedPairingBrowserPath,
  selectedPairingFragmentPrefix,
  selectedPairingFragmentSchema
} from "@hostdeck/contracts";

export const browserPairClaimPath = "/api/v1/access/pairing-claims" as const;
export const browserCsrfBootstrapPath = "/api/v1/access/csrf" as const;
export const browserPairingRequestMaxBytes = defaultResourceBudget.http_body_max_bytes;
export const browserPairingResponseMaxBytes = defaultResourceBudget.http_body_max_bytes;

export type BrowserPairingOperation = "pair_claim" | "csrf_bootstrap";

export interface BrowserPairingLocationPort {
  readonly origin: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
}

export interface BrowserPairingHistoryPort {
  readonly state: unknown;
  readonly replaceState: (data: unknown, unused: string, url: string) => void;
}

export interface BrowserPairingHeadersPort {
  readonly get: (name: string) => string | null;
}

export interface BrowserPairingBodyReaderPort {
  readonly read: () => Promise<{
    readonly done: boolean;
    readonly value?: Uint8Array;
  }>;
  readonly cancel: (reason?: unknown) => Promise<void>;
  readonly releaseLock: () => void;
}

export interface BrowserPairingBodyPort {
  readonly getReader: () => BrowserPairingBodyReaderPort;
}

export interface BrowserPairingResponsePort {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: BrowserPairingHeadersPort;
  readonly body: BrowserPairingBodyPort | null;
}

export interface BrowserPairingRequestInit {
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  body: string;
  readonly cache: "no-store";
  readonly credentials: "include";
  readonly mode: "same-origin";
  readonly redirect: "error";
  readonly referrerPolicy: "no-referrer";
}

export type BrowserPairingFetchPort = (
  path: typeof browserPairClaimPath | typeof browserCsrfBootstrapPath,
  init: BrowserPairingRequestInit
) => Promise<BrowserPairingResponsePort>;

export interface BootstrapBrowserPairingOptions {
  readonly location: BrowserPairingLocationPort;
  readonly history: BrowserPairingHistoryPort;
  readonly fetch: BrowserPairingFetchPort;
  readonly createOperationId: (operation: BrowserPairingOperation) => string;
}

interface PairedDeviceResult {
  readonly device_id: string;
  readonly permission: "read" | "write";
  readonly client_label: string | null;
  readonly device_expires_at: string;
}

interface BrowserPairingResponseSnapshot {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: BrowserPairingHeadersPort;
  readonly body: BrowserPairingBodyPort | null;
}

export type BrowserPairingBootstrapResult =
  | Readonly<{ readonly state: "no_fragment" }>
  | Readonly<{
      readonly state: "entry_rejected";
      readonly reason: "history_unavailable" | "invalid_fragment" | "invalid_origin" | "invalid_route";
    }>
  | Readonly<{
      readonly state: "claim_rejected";
      readonly reason: "not_accepted" | "origin_rejected";
    }>
  | Readonly<{ readonly state: "claim_rate_limited" }>
  | Readonly<{ readonly state: "claim_unavailable" }>
  | Readonly<{ readonly state: "claim_unknown" }>
  | Readonly<PairedDeviceResult & {
      readonly state: "paired_csrf_unavailable";
      readonly reason: "bootstrap_rejected" | "bootstrap_unavailable" | "bootstrap_unknown";
    }>
  | Readonly<PairedDeviceResult & {
      readonly state: "paired";
      readonly csrf_token: string;
      readonly csrf_generation: number;
      readonly csrf_rotated_at: string;
    }>;

const noFragmentResult = Object.freeze({ state: "no_fragment" } as const);

export async function bootstrapBrowserPairing(
  options: BootstrapBrowserPairingOptions
): Promise<BrowserPairingBootstrapResult> {
  requireEntryPorts(options);
  let rawFragment: unknown = options.location.hash;
  let rawCode: string | null = null;
  if (rawFragment === "") return noFragmentResult;

  try {
    let historyState: unknown = null;
    try {
      historyState = options.history.state;
    } catch {
      historyState = null;
    }
    options.history.replaceState(historyState, "", selectedPairingBrowserPath);
  } catch {
    rawFragment = "";
    return rejectedEntry("history_unavailable");
  }

  if (typeof rawFragment !== "string") {
    rawFragment = "";
    return rejectedEntry("invalid_fragment");
  }
  let location: Omit<BrowserPairingLocationPort, "hash">;
  try {
    location = readLocationContext(options.location);
  } catch {
    rawFragment = "";
    return rejectedEntry("invalid_route");
  }
  if (
    location.pathname !== selectedPairingBrowserPath ||
    location.search !== ""
  ) {
    rawFragment = "";
    return rejectedEntry("invalid_route");
  }
  if (!remoteExternalOriginSchema.safeParse(location.origin).success) {
    rawFragment = "";
    return rejectedEntry("invalid_origin");
  }
  const parsedFragment = selectedPairingFragmentSchema.safeParse(rawFragment);
  rawFragment = "";
  if (!parsedFragment.success) return rejectedEntry("invalid_fragment");
  if (
    typeof options.fetch !== "function" ||
    typeof options.createOperationId !== "function"
  ) {
    return Object.freeze({ state: "claim_unavailable" });
  }
  rawCode = parsedFragment.data.slice(selectedPairingFragmentPrefix.length);

  let claimRequestBody = "";
  try {
    const claimRequest = selectedPairClaimRequestSchema.safeParse({
      operation_id: createOperationId(options.createOperationId, "pair_claim"),
      code: rawCode
    });
    if (!claimRequest.success) {
      rawCode = null;
      return Object.freeze({ state: "claim_unavailable" });
    }
    claimRequestBody = JSON.stringify(claimRequest.data);
  } catch {
    rawCode = null;
    return Object.freeze({ state: "claim_unavailable" });
  }

  const claim = await postBoundedJson(
    options.fetch,
    browserPairClaimPath,
    claimRequestBody,
    () => {
      claimRequestBody = "";
      rawCode = null;
    }
  );
  claimRequestBody = "";
  rawCode = null;

  if (claim.kind === "transport_failure") {
    return Object.freeze({ state: "claim_unknown" });
  }
  if (claim.kind === "invalid_response") {
    return Object.freeze({ state: "claim_unknown" });
  }
  if (!claim.ok) return mapClaimRejection(claim.status, claim.payload);

  const parsedClaim = selectedPairClaimResponseSchema.safeParse(claim.payload);
  if (!parsedClaim.success) return Object.freeze({ state: "claim_unknown" });
  const device = pairedDeviceResult(parsedClaim.data);

  let csrfRequestBody = "";
  try {
    const csrfRequest = selectedCsrfBootstrapRequestSchema.safeParse({
      operation_id: createOperationId(options.createOperationId, "csrf_bootstrap")
    });
    if (!csrfRequest.success) {
      return pairedCsrfUnavailable(device, "bootstrap_unavailable");
    }
    csrfRequestBody = JSON.stringify(csrfRequest.data);
  } catch {
    return pairedCsrfUnavailable(device, "bootstrap_unavailable");
  }

  const csrf = await postBoundedJson(
    options.fetch,
    browserCsrfBootstrapPath,
    csrfRequestBody,
    () => {
      csrfRequestBody = "";
    }
  );
  csrfRequestBody = "";
  if (csrf.kind === "transport_failure") {
    return pairedCsrfUnavailable(device, "bootstrap_unknown");
  }
  if (csrf.kind === "invalid_response") {
    return pairedCsrfUnavailable(device, "bootstrap_unknown");
  }
  if (!csrf.ok) {
    return pairedCsrfUnavailable(device, "bootstrap_rejected");
  }
  const parsedCsrf = selectedCsrfBootstrapResponseSchema.safeParse(csrf.payload);
  if (!parsedCsrf.success) {
    return pairedCsrfUnavailable(device, "bootstrap_unknown");
  }
  return pairedResult(device, parsedCsrf.data);
}

export function bootstrapWindowPairing(): Promise<BrowserPairingBootstrapResult> {
  if (
    typeof window === "undefined" ||
    typeof window.history?.replaceState !== "function"
  ) {
    throw new TypeError("HostDeck browser pairing requires window and history APIs.");
  }
  return bootstrapBrowserPairing({
    location: window.location,
    history: {
      get state() {
        return window.history.state as unknown;
      },
      replaceState(data, unused, url) {
        window.history.replaceState(data, unused, url);
      }
    },
    fetch: async (path, init) => {
      if (typeof window.fetch !== "function") {
        throw new TypeError("HostDeck browser fetch is unavailable.");
      }
      const response = await window.fetch(path, init);
      return response as unknown as BrowserPairingResponsePort;
    },
    createOperationId: createBrowserOperationId
  });
}

function createBrowserOperationId(operation: BrowserPairingOperation): string {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new TypeError("Secure browser operation-id generation is unavailable.");
  }
  return `op_browser_${operation}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

function createOperationId(
  port: BootstrapBrowserPairingOptions["createOperationId"],
  operation: BrowserPairingOperation
): string {
  return Reflect.apply(port, undefined, [operation]) as string;
}

function requireEntryPorts(options: BootstrapBrowserPairingOptions): void {
  if (
    options === null ||
    typeof options !== "object" ||
    options.location === null ||
    typeof options.location !== "object" ||
    options.history === null ||
    typeof options.history !== "object" ||
    typeof options.history.replaceState !== "function"
  ) {
    throw new TypeError("HostDeck browser pairing options are invalid.");
  }
}

function readLocationContext(
  locationPort: BrowserPairingLocationPort
): Omit<BrowserPairingLocationPort, "hash"> {
  const location = {
    origin: locationPort.origin,
    pathname: locationPort.pathname,
    search: locationPort.search
  };
  if (
    typeof location.origin !== "string" ||
    typeof location.pathname !== "string" ||
    typeof location.search !== "string"
  ) {
    throw new TypeError("HostDeck browser pairing options are invalid.");
  }
  return Object.freeze(location);
}

type BoundedJsonResult =
  | Readonly<{
      readonly kind: "response";
      readonly status: number;
      readonly ok: boolean;
      readonly payload: unknown;
    }>
  | Readonly<{ readonly kind: "transport_failure" }>
  | Readonly<{ readonly kind: "invalid_response" }>;

async function postBoundedJson(
  fetchPort: BrowserPairingFetchPort,
  path: typeof browserPairClaimPath | typeof browserCsrfBootstrapPath,
  body: string,
  clearRequest: () => void
): Promise<BoundedJsonResult> {
  if (!requestBodyFitsSelectedLimit(body)) {
    clearRequest();
    return Object.freeze({ kind: "invalid_response" });
  }
  const init: BrowserPairingRequestInit = {
    method: "POST",
    headers: Object.freeze({
      accept: "application/json",
      "cache-control": "no-store",
      "content-type": "application/json"
    }),
    body,
    cache: "no-store",
    credentials: "include",
    mode: "same-origin",
    redirect: "error",
    referrerPolicy: "no-referrer"
  };
  let pending: Promise<BrowserPairingResponsePort>;
  try {
    pending = fetchPort(path, init);
  } catch {
    init.body = "";
    clearRequest();
    return Object.freeze({ kind: "transport_failure" });
  }
  init.body = "";
  clearRequest();

  let responseCandidate: BrowserPairingResponsePort;
  try {
    responseCandidate = await pending;
  } catch {
    return Object.freeze({ kind: "transport_failure" });
  }
  const response = snapshotBrowserResponse(responseCandidate);
  if (response === null) {
    return Object.freeze({ kind: "invalid_response" });
  }

  const payload = await readBoundedJson(response);
  if (!payload.ok) return Object.freeze({ kind: "invalid_response" });
  return Object.freeze({
    kind: "response",
    status: response.status,
    ok: response.ok,
    payload: payload.value
  });
}

function requestBodyFitsSelectedLimit(body: string): boolean {
  try {
    return new TextEncoder().encode(body).byteLength <= browserPairingRequestMaxBytes;
  } catch {
    return false;
  }
}

function snapshotBrowserResponse(candidate: unknown): BrowserPairingResponseSnapshot | null {
  if (candidate === null || typeof candidate !== "object") return null;
  try {
    const source = candidate as Partial<BrowserPairingResponsePort>;
    const status = source.status;
    const ok = source.ok;
    const headers = source.headers;
    const body = source.body;
    if (
      typeof status !== "number" ||
      !Number.isSafeInteger(status) ||
      status < 100 ||
      status > 599 ||
      typeof ok !== "boolean" ||
      ok !== (status >= 200 && status < 300) ||
      headers === null ||
      typeof headers !== "object" ||
      typeof headers.get !== "function" ||
      (body !== null &&
        (typeof body !== "object" || typeof body.getReader !== "function"))
    ) {
      return null;
    }
    return Object.freeze({ status, ok, headers, body });
  } catch {
    return null;
  }
}

async function readBoundedJson(
  response: BrowserPairingResponseSnapshot
): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false }> {
  let contentType: string | null;
  let declaredLength: string | null;
  try {
    contentType = response.headers.get("content-type");
    declaredLength = response.headers.get("content-length");
  } catch {
    return { ok: false };
  }
  if (
    typeof contentType !== "string" ||
    !/^application\/json(?:\s*;|$)/iu.test(contentType)
  ) {
    return { ok: false };
  }
  if (
    declaredLength !== null &&
    (typeof declaredLength !== "string" ||
      !/^\d+$/u.test(declaredLength) ||
      Number(declaredLength) > browserPairingResponseMaxBytes)
  ) {
    return { ok: false };
  }
  if (response.body === null) return { ok: false };

  let reader: BrowserPairingBodyReaderPort;
  try {
    reader = response.body.getReader();
  } catch {
    return { ok: false };
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let failed = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength === 0) {
        failed = true;
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > browserPairingResponseMaxBytes) {
        failed = true;
        break;
      }
      chunks.push(chunk.value);
    }
  } catch {
    failed = true;
  } finally {
    if (failed) {
      try {
        await reader.cancel();
      } catch {
        // The response is already rejected; cancellation failure cannot make it usable.
      }
    }
    try {
      reader.releaseLock();
    } catch {
      failed = true;
    }
  }
  if (failed) {
    zeroChunks(chunks);
    return { ok: false };
  }

  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  zeroChunks(chunks);
  let text = "";
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(joined);
    joined.fill(0);
    const value = JSON.parse(text) as unknown;
    text = "";
    return { ok: true, value };
  } catch {
    joined.fill(0);
    text = "";
    return { ok: false };
  }
}

function zeroChunks(chunks: readonly Uint8Array[]): void {
  for (const chunk of chunks) chunk.fill(0);
}

function mapClaimRejection(status: number, payload: unknown): BrowserPairingBootstrapResult {
  const parsed = apiRouteErrorBodySchema.safeParse(payload);
  if (!parsed.success) return Object.freeze({ state: "claim_unknown" });
  switch (parsed.data.error.code) {
    case "permission_denied":
      return Object.freeze({ state: "claim_rejected", reason: "not_accepted" });
    case "invalid_origin":
      return Object.freeze({ state: "claim_rejected", reason: "origin_rejected" });
    case "rate_limited":
      return Object.freeze({ state: "claim_rate_limited" });
    case "capability_unavailable":
    case "operation_timeout":
    case "service_overloaded":
    case "runtime_unavailable":
      return Object.freeze({ state: "claim_unavailable" });
    default:
      return status >= 400 && status < 500
        ? Object.freeze({ state: "claim_rejected", reason: "not_accepted" })
        : Object.freeze({ state: "claim_unknown" });
  }
}

function pairedDeviceResult(claim: SelectedPairClaimResponse): Readonly<PairedDeviceResult> {
  return Object.freeze({
    device_id: claim.device_id,
    permission: claim.permission,
    client_label: claim.client_label,
    device_expires_at: claim.expires_at
  });
}

function pairedCsrfUnavailable(
  device: Readonly<PairedDeviceResult>,
  reason: Extract<BrowserPairingBootstrapResult, { state: "paired_csrf_unavailable" }>["reason"]
): BrowserPairingBootstrapResult {
  return Object.freeze({ ...device, state: "paired_csrf_unavailable", reason });
}

function pairedResult(
  device: Readonly<PairedDeviceResult>,
  csrf: SelectedCsrfBootstrapResponse
): BrowserPairingBootstrapResult {
  return Object.freeze({
    ...device,
    state: "paired",
    csrf_token: csrf.csrf_token,
    csrf_generation: csrf.csrf_generation,
    csrf_rotated_at: csrf.rotated_at
  });
}

function rejectedEntry(
  reason: Extract<BrowserPairingBootstrapResult, { state: "entry_rejected" }>["reason"]
): BrowserPairingBootstrapResult {
  return Object.freeze({ state: "entry_rejected", reason });
}
