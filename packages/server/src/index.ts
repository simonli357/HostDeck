import { randomBytes } from "node:crypto";
import type { AuthDeviceRecord } from "@hostdeck/contracts";
import {
  type ApiErrorEnvelope,
  lockRequestSchema,
  type NetworkStateResponse,
  networkStateResponseSchema,
  pairClaimRequestSchema,
  type TrustState,
  trustStateSchema
} from "@hostdeck/contracts";
import { createErrorEnvelope, type ErrorCode } from "@hostdeck/core";
import {
  type AuthDeviceRepository,
  HostDeckAuthRepositoryError,
  type PairingCodeRepository,
  type SettingsRepository
} from "@hostdeck/storage";

export * from "./output-reader.js";
export * from "./read-routes.js";
export * from "./restart-reconciler.js";
export * from "./startup.js";
export * from "./stream-routes.js";

export interface BrowserAuthInput {
  readonly rawDeviceToken?: string | null;
  readonly rawCsrfToken?: string | null;
}

export interface JsonRouteResult<TBody> {
  readonly status: number;
  readonly body: TBody;
  readonly cookies?: readonly HttpCookie[];
}

export interface HttpCookie {
  readonly name: string;
  readonly value: string;
  readonly httpOnly: true;
  readonly sameSite: "lax" | "strict";
  readonly secure: boolean;
  readonly path: "/";
  readonly expiresAt: string | null;
}

export interface PairClaimRouteInput {
  readonly body: unknown;
}

export interface LockRouteInput extends BrowserAuthInput {
  readonly body: unknown;
}

export interface SecurityRouteHandlers {
  readonly claimPairingCode: (input: PairClaimRouteInput) => JsonRouteResult<TrustState | ApiRouteErrorBody>;
  readonly pairStatus: (input?: BrowserAuthInput) => JsonRouteResult<TrustState>;
  readonly securityState: (input?: BrowserAuthInput) => JsonRouteResult<TrustState>;
  readonly networkState: () => JsonRouteResult<NetworkStateResponse>;
  readonly lockFromDashboard: (input: LockRouteInput) => JsonRouteResult<TrustState | ApiRouteErrorBody>;
  readonly unlockFromDashboard: () => JsonRouteResult<ApiRouteErrorBody>;
  readonly mutateLanFromDashboard: () => JsonRouteResult<ApiRouteErrorBody>;
}

export interface ApiRouteErrorBody {
  readonly error: ApiErrorEnvelope;
}

export interface CreateSecurityRouteHandlersInput {
  readonly authDevices: AuthDeviceRepository;
  readonly pairingCodes: PairingCodeRepository;
  readonly settings: SettingsRepository;
  readonly now?: () => Date;
  readonly createDeviceId?: () => string;
  readonly createDeviceToken?: () => string;
  readonly createCsrfToken?: () => string;
}

const deviceCookieName = "hostdeck_device";

export function createSecurityRouteHandlers(input: CreateSecurityRouteHandlersInput): SecurityRouteHandlers {
  const now = input.now ?? (() => new Date());
  const createDeviceId = input.createDeviceId ?? (() => `client_${cryptoRandomPart()}`);
  const createDeviceToken = input.createDeviceToken ?? (() => `device_${cryptoRandomPart()}_${cryptoRandomPart()}`);
  const createCsrfToken = input.createCsrfToken ?? (() => `csrf_${cryptoRandomPart()}_${cryptoRandomPart()}`);

  return {
    claimPairingCode(routeInput) {
      const request = pairClaimRequestSchema.safeParse(routeInput.body);

      if (!request.success) {
        return routeError(400, "validation_error", "Pair claim request is malformed.", "body");
      }

      const rawDeviceToken = createDeviceToken();
      const rawCsrfToken = createCsrfToken();

      try {
        const claim = input.pairingCodes.claim({
          rawCode: request.data.code,
          deviceId: createDeviceId(),
          rawDeviceToken,
          rawCsrfToken,
          clientLabel: request.data.client_label ?? null,
          now: now()
        });
        const trust = parseTrustState(trustStateForDevice(input.settings, claim.device, rawCsrfToken));

        return {
          status: 200,
          body: trust,
          cookies: [
            {
              name: deviceCookieName,
              value: rawDeviceToken,
              httpOnly: true,
              sameSite: "lax",
              secure: false,
              path: "/",
              expiresAt: claim.device.expires_at
            }
          ]
        };
      } catch (error) {
        return routeErrorForAuth(error);
      }
    },
    pairStatus(routeInput = {}) {
      return {
        status: 200,
        body: currentTrustState(input.authDevices, input.settings, routeInput, now())
      };
    },
    securityState(routeInput = {}) {
      return {
        status: 200,
        body: currentTrustState(input.authDevices, input.settings, routeInput, now())
      };
    },
    networkState() {
      const settings = input.settings.require();
      return {
        status: 200,
        body: networkStateResponseSchema.parse({
          mode: settings.bind_mode,
          host: settings.bind_host,
          port: settings.bind_port,
          lan_enabled: settings.lan_enabled
        })
      };
    },
    lockFromDashboard(routeInput) {
      const request = importLockRequest(routeInput.body);

      if (!request.ok) {
        return request.error;
      }

      const authorized = authorizeBrowserWrite(input.authDevices, routeInput, now);

      if (!authorized.ok) {
        return authorized.error;
      }

      input.settings.setLocked(true, { now });
      return {
        status: 200,
        body: currentTrustState(input.authDevices, input.settings, routeInput, now())
      };
    },
    unlockFromDashboard() {
      return routeError(403, "permission_denied", "Unlock is CLI-only in V1.");
    },
    mutateLanFromDashboard() {
      return routeError(403, "permission_denied", "LAN mutation is CLI/admin-only in V1.");
    }
  };
}

function importLockRequest(body: unknown): { readonly ok: true } | { readonly ok: false; readonly error: JsonRouteResult<ApiRouteErrorBody> } {
  const request = lockRequestSchema.safeParse(body);

  if (!request.success) {
    return {
      ok: false,
      error: routeError(400, "validation_error", "Lock request is malformed.", "body")
    };
  }

  return { ok: true };
}

function currentTrustState(
  authDevices: AuthDeviceRepository,
  settings: SettingsRepository,
  input: BrowserAuthInput,
  now: Date
): TrustState {
  if (input.rawDeviceToken === undefined || input.rawDeviceToken === null) {
    return parseTrustState(untrustedState(settings));
  }

  try {
    const auth = authDevices.authenticateDeviceToken({
      rawDeviceToken: input.rawDeviceToken,
      now
    });

    if (auth.device.permission === "write" && !settings.require().locked) {
      if (input.rawCsrfToken === undefined || input.rawCsrfToken === null) {
        return parseTrustState(untrustedState(settings));
      }

      authDevices.authorizeBrowserWrite({
        rawDeviceToken: input.rawDeviceToken,
        rawCsrfToken: input.rawCsrfToken,
        now
      });

      return parseTrustState(trustStateForDevice(settings, auth.device, input.rawCsrfToken));
    }

    return parseTrustState(trustStateForDevice(settings, auth.device, null));
  } catch {
    return parseTrustState(untrustedState(settings));
  }
}

function authorizeBrowserWrite(
  authDevices: AuthDeviceRepository,
  input: BrowserAuthInput,
  now: () => Date
): { readonly ok: true; readonly device: AuthDeviceRecord } | { readonly ok: false; readonly error: JsonRouteResult<ApiRouteErrorBody> } {
  if (input.rawDeviceToken === undefined || input.rawDeviceToken === null || input.rawCsrfToken === undefined || input.rawCsrfToken === null) {
    return {
      ok: false,
      error: routeError(401, "permission_denied", "Browser writes require a paired device cookie and CSRF header.")
    };
  }

  try {
    return {
      ok: true,
      device: authDevices.authorizeBrowserWrite({
        rawDeviceToken: input.rawDeviceToken,
        rawCsrfToken: input.rawCsrfToken,
        now: now()
      })
    };
  } catch (error) {
    return {
      ok: false,
      error: routeErrorForAuth(error)
    };
  }
}

function trustStateForDevice(settingsRepository: SettingsRepository, device: AuthDeviceRecord, rawCsrfToken: string | null): TrustState {
  const settings = settingsRepository.require();
  const readOnly = device.permission === "read";
  return {
    trusted: true,
    read_only: readOnly,
    locked: settings.locked,
    lan_enabled: settings.lan_enabled,
    client_id: device.id,
    auth_transport: "http_only_cookie",
    csrf_token: !readOnly && !settings.locked ? rawCsrfToken : null
  };
}

function untrustedState(settingsRepository: SettingsRepository): TrustState {
  const settings = settingsRepository.require();
  return {
    trusted: false,
    read_only: false,
    locked: settings.locked,
    lan_enabled: settings.lan_enabled,
    client_id: null,
    auth_transport: "none",
    csrf_token: null
  };
}

function parseTrustState(state: TrustState): TrustState {
  return trustStateSchema.parse(state);
}

function routeErrorForAuth(error: unknown): JsonRouteResult<ApiRouteErrorBody> {
  if (!(error instanceof HostDeckAuthRepositoryError)) {
    return routeError(500, "storage_error", "Auth storage failed.");
  }

  const authError = error;

  switch (authError.code) {
    case "invalid_secret":
    case "invalid_auth_device":
    case "invalid_pairing_code":
      return routeError(400, "validation_error", authError.message);
    case "read_only":
      return routeError(403, "read_only", authError.message);
    case "csrf_mismatch":
      return routeError(403, "permission_denied", authError.message);
    case "device_expired":
    case "device_not_found":
    case "device_revoked":
    case "pairing_code_expired":
    case "pairing_code_not_found":
    case "pairing_code_revoked":
    case "pairing_code_used":
      return routeError(401, "permission_denied", authError.message);
    case "device_exists":
    case "duplicate_secret":
    case "pairing_code_exists":
      return routeError(500, "storage_error", authError.message);
    default:
      return routeError(500, "storage_error", authError.message);
  }
}

function routeError(status: number, code: ErrorCode, message: string, field?: string): JsonRouteResult<ApiRouteErrorBody> {
  const error = createErrorEnvelope({
    code,
    message,
    ...(field !== undefined ? { field } : {})
  });

  return {
    status,
    body: {
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.field !== undefined ? { field: error.field } : {}),
        ...(error.sessionId !== undefined ? { session_id: error.sessionId } : {}),
        ...(error.details !== undefined ? { details: error.details } : {})
      }
    }
  };
}

function cryptoRandomPart(): string {
  return randomBytes(18).toString("base64url");
}
