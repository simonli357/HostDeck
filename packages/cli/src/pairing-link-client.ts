import {
  type ApiErrorEnvelope,
  apiRouteErrorBodySchema,
  createSelectedPairingLink,
  type SelectedPairingLink,
  type SelectedPairRequest,
  type SelectedPairRequestResponse,
  selectedPairRequestResponseSchema,
  selectedPairRequestSchema
} from "@hostdeck/contracts";
import {
  hostDeckLocalAdminRequestHeaderName,
  hostDeckLocalAdminRequestHeaderValue
} from "@hostdeck/server";
import type { HttpFetch, HttpResponse } from "./api-client.js";
import {
  apiFailure,
  CliFailure,
  clientOperationFailure,
  daemonUnavailableFailure,
  internalFailure
} from "./errors.js";
import {
  assertCliHttpResponse,
  createBoundedLoopbackFetch,
  readCliJsonPayload,
  requireLoopbackBaseUrl
} from "./loopback-http.js";
import { createHostDeckRemoteControlClient } from "./remote-control-client.js";

export interface PairingLinkCommandResult {
  readonly link: SelectedPairingLink;
  readonly permission: "read" | "write";
  readonly client_label: string | null;
  readonly expires_at: string;
}

export interface HostDeckPairingLinkClient {
  readonly issue: (input: SelectedPairRequest) => Promise<PairingLinkCommandResult>;
}

export interface CreateHostDeckPairingLinkClientOptions {
  readonly baseUrl: URL;
  readonly fetch?: HttpFetch;
}

const optionKeys = ["baseUrl", "fetch"] as const;

export function createHostDeckPairingLinkClient(
  input: CreateHostDeckPairingLinkClientOptions
): HostDeckPairingLinkClient {
  const values = readExactOptions(input);
  if (!(values.baseUrl instanceof URL)) {
    throw new TypeError("HostDeck pairing-link base URL is invalid.");
  }
  if (values.fetch !== undefined && typeof values.fetch !== "function") {
    throw new TypeError("HostDeck pairing-link fetch port is invalid.");
  }
  const baseUrl = new URL(values.baseUrl.toString());
  requireLoopbackBaseUrl(baseUrl);
  const fetchPort =
    values.fetch === undefined
      ? createBoundedLoopbackFetch()
      : (values.fetch as HttpFetch);
  const remoteClient = createHostDeckRemoteControlClient({
    baseUrl,
    fetch: fetchPort
  });

  return Object.freeze({
    async issue(input: SelectedPairRequest) {
      const request = parsePairRequest(input);
      const before = await remoteClient.status();
      requireReadyRemoteState(before);

      const issued = await issuePairingCode({ baseUrl, fetch: fetchPort, request });
      requireIssuedResponseMatchesRequest(issued, request);

      const after = await remoteClient.status();
      if (
        after.availability !== "ready" ||
        after.external_origin === null ||
        after.generation !== before.generation ||
        after.external_origin !== before.external_origin
      ) {
        throw clientOperationFailure(
          "operation_conflict",
          "Remote access changed while the pairing link was created. No link was revealed."
        );
      }

      let link: SelectedPairingLink;
      try {
        link = createSelectedPairingLink({
          external_origin: after.external_origin,
          code: issued.code
        });
      } catch {
        throw internalFailure("HostDeck pairing-link construction failed.");
      }

      return Object.freeze({
        link,
        permission: issued.permission,
        client_label: issued.client_label,
        expires_at: issued.expires_at
      });
    }
  });
}

async function issuePairingCode(input: {
  readonly baseUrl: URL;
  readonly fetch: HttpFetch;
  readonly request: SelectedPairRequest;
}): Promise<SelectedPairRequestResponse> {
  const url = new URL("/api/v1/access/pairing-codes", input.baseUrl);
  const body = JSON.stringify(input.request);
  let response: HttpResponse;
  try {
    response = await input.fetch(url.toString(), {
      method: "POST",
      headers: Object.freeze({
        accept: "application/json",
        "cache-control": "no-store",
        "content-type": "application/json",
        [hostDeckLocalAdminRequestHeaderName]:
          hostDeckLocalAdminRequestHeaderValue
      }),
      body
    });
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    throw daemonUnavailableFailure(input.baseUrl, error);
  }

  assertCliHttpResponse(response, "HostDeck pairing-link");
  const payload = await readCliJsonPayload(response);
  if (!response.ok) {
    const parsed = apiRouteErrorBodySchema.safeParse(payload);
    if (!parsed.success) {
      throw internalFailure(
        `HostDeck daemon returned an untyped HTTP ${response.status} pairing-link error.`
      );
    }
    throw apiFailure(response.status, sanitizePairingApiError(parsed.data.error));
  }

  const parsed = selectedPairRequestResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw internalFailure("HostDeck daemon returned an invalid pairing-code response.");
  }
  return parsed.data;
}

function parsePairRequest(candidate: unknown): SelectedPairRequest {
  const parsed = selectedPairRequestSchema.safeParse(candidate);
  if (!parsed.success) {
    throw internalFailure("HostDeck pairing-link request is invalid.");
  }
  return parsed.data;
}

function requireReadyRemoteState(state: {
  readonly availability: string;
  readonly external_origin: string | null;
}): asserts state is { readonly availability: "ready"; readonly external_origin: string } {
  if (state.availability !== "ready" || state.external_origin === null) {
    throw clientOperationFailure(
      "capability_unavailable",
      "Remote access must be ready before creating a pairing link."
    );
  }
}

function requireIssuedResponseMatchesRequest(
  issued: SelectedPairRequestResponse,
  request: SelectedPairRequest
): void {
  if (
    issued.permission !== request.permission ||
    issued.client_label !== (request.client_label ?? null)
  ) {
    throw internalFailure("HostDeck daemon returned inconsistent pairing-code metadata.");
  }
}

function sanitizePairingApiError(error: ApiErrorEnvelope): ApiErrorEnvelope {
  return Object.freeze({
    code: error.code,
    message: pairingErrorMessage(error.code),
    retryable: error.retryable
  });
}

function pairingErrorMessage(code: ApiErrorEnvelope["code"]): string {
  switch (code) {
    case "operation_conflict":
      return "Pairing conflicts with current HostDeck state.";
    case "operation_timeout":
      return "Pairing request timed out.";
    case "service_overloaded":
      return "Pairing capacity is currently exhausted.";
    case "audit_unavailable":
      return "Pairing audit is unavailable.";
    case "storage_error":
      return "Pairing storage is unavailable.";
    case "permission_denied":
    case "invalid_origin":
      return "Pairing request is not permitted.";
    default:
      return "Pairing request failed.";
  }
}

function readExactOptions(
  candidate: unknown
): Readonly<Record<(typeof optionKeys)[number], unknown>> {
  const message = "HostDeck pairing-link client options are invalid.";
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    throw new TypeError(message);
  }
  try {
    const prototype: unknown = Object.getPrototypeOf(candidate);
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.length < 1 ||
      keys.length > optionKeys.length ||
      keys.some((key) => {
        if (
          typeof key !== "string" ||
          !optionKeys.includes(key as (typeof optionKeys)[number])
        ) {
          return true;
        }
        const descriptor = descriptors[key];
        return (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        );
      }) ||
      !Object.hasOwn(descriptors, "baseUrl")
    ) {
      throw new TypeError(message);
    }
    return Object.freeze({
      baseUrl: descriptors.baseUrl?.value,
      fetch: descriptors.fetch?.value
    });
  } catch (error) {
    if (error instanceof TypeError && error.message === message) throw error;
    throw new TypeError(message);
  }
}
