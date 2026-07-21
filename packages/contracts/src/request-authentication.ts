import { z } from "zod";
import { selectedDeviceIdSchema } from "./device-revocation.js";
import {
  hostDeckLoopbackOriginSchema,
  remoteExternalOriginSchema,
  remoteSourceKeySchema
} from "./remote-ingress.js";
import {
  isoTimestampSchema,
  nonNegativeSafeIntegerSchema,
  positiveSafeIntegerSchema
} from "./scalars.js";

export const selectedRequestAuthenticationStates = [
  "local_admin",
  "unpaired",
  "invalid_device",
  "expired_device",
  "revoked_device",
  "paired_device"
] as const;

export const selectedRequestNetworkModes = ["loopback", "remote"] as const;
export const selectedRequestOriginKinds = [
  "same_origin",
  "safe_no_origin",
  "local_non_browser"
] as const;

export const selectedRequestAuthenticationIngressContextSchema = z
  .object({
    configured_origin: z.string().url().max(512),
    network_mode: z.enum(selectedRequestNetworkModes),
    origin_kind: z.enum(selectedRequestOriginKinds),
    transport: z.enum(["http", "https"]),
    source_key: remoteSourceKeySchema.nullable(),
    remote_generation: nonNegativeSafeIntegerSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    validateCanonicalOrigin(value.configured_origin, value.transport, context);
    if (value.network_mode === "remote") {
      if (
        value.transport !== "https" ||
        value.origin_kind === "local_non_browser" ||
        value.source_key === null ||
        value.remote_generation === null ||
        !remoteExternalOriginSchema.safeParse(value.configured_origin).success
      ) {
        context.addIssue({
          code: "custom",
          message: "Remote request authentication ingress is incomplete or contradictory."
        });
      }
      return;
    }
    if (
      value.transport !== "http" ||
      value.source_key !== null ||
      value.remote_generation !== null ||
      !hostDeckLoopbackOriginSchema.safeParse(value.configured_origin).success
    ) {
      context.addIssue({
        code: "custom",
        message: "Loopback request authentication ingress requires canonical IPv4 loopback HTTP without remote provenance."
      });
    }
  });

export const selectedRequestAuthenticationContextSchema = z
  .object({
    state: z.enum(selectedRequestAuthenticationStates),
    configured_origin: z.string().url().max(512),
    network_mode: z.enum(selectedRequestNetworkModes),
    origin_kind: z.enum(selectedRequestOriginKinds),
    transport: z.enum(["http", "https"]),
    device_id: selectedDeviceIdSchema.nullable(),
    permission: z.enum(["local_admin", "read", "write"]).nullable(),
    csrf_generation: positiveSafeIntegerSchema.nullable(),
    last_used_at: isoTimestampSchema.nullable(),
    expires_at: isoTimestampSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    validateCanonicalOrigin(value.configured_origin, value.transport, context);
    if (
      value.network_mode === "remote" &&
      (value.transport !== "https" ||
        value.origin_kind === "local_non_browser" ||
        !remoteExternalOriginSchema.safeParse(value.configured_origin).success)
    ) {
      context.addIssue({
        code: "custom",
        message: "Remote request authentication requires canonical browser HTTPS trust."
      });
    }
    if (
      value.network_mode === "loopback" &&
      (value.transport !== "http" ||
        !hostDeckLoopbackOriginSchema.safeParse(value.configured_origin).success)
    ) {
      context.addIssue({
        code: "custom",
        message: "Loopback request authentication requires canonical IPv4 loopback HTTP."
      });
    }
    const deviceFieldsAreNull =
      value.device_id === null &&
      value.csrf_generation === null &&
      value.last_used_at === null &&
      value.expires_at === null;

    if (value.state === "local_admin") {
      if (!deviceFieldsAreNull || value.permission !== "local_admin") {
        context.addIssue({
          code: "custom",
          message: "Local-admin authentication cannot contain device authority."
        });
      }
      if (value.origin_kind !== "local_non_browser") {
        context.addIssue({
          code: "custom",
          message: "Local-admin authentication requires local non-browser request trust.",
          path: ["origin_kind"]
        });
      }
      if (value.network_mode !== "loopback") {
        context.addIssue({
          code: "custom",
          message: "Only loopback request authentication can grant local-admin authority.",
          path: ["network_mode"]
        });
      }
      return;
    }

    if (value.state === "paired_device") {
      if (
        value.device_id === null ||
        (value.permission !== "read" && value.permission !== "write") ||
        value.csrf_generation === null ||
        value.last_used_at === null
      ) {
        context.addIssue({
          code: "custom",
          message: "Paired-device authentication requires complete non-secret authority metadata."
        });
      }
      if (
        value.last_used_at !== null &&
        value.expires_at !== null &&
        Date.parse(value.last_used_at) >= Date.parse(value.expires_at)
      ) {
        context.addIssue({
          code: "custom",
          message: "Paired-device authentication cannot occur at or after expiry.",
          path: ["last_used_at"]
        });
      }
      return;
    }

    if (!deviceFieldsAreNull || value.permission !== null) {
      context.addIssue({
        code: "custom",
        message: "Unauthenticated device states cannot expose authority metadata."
      });
    }
  });

export type SelectedRequestAuthenticationState =
  (typeof selectedRequestAuthenticationStates)[number];
export type SelectedRequestNetworkMode = (typeof selectedRequestNetworkModes)[number];
export type SelectedRequestOriginKind = (typeof selectedRequestOriginKinds)[number];
export type SelectedRequestAuthenticationIngressContext = z.infer<
  typeof selectedRequestAuthenticationIngressContextSchema
>;
export type SelectedRequestAuthenticationContext = z.infer<
  typeof selectedRequestAuthenticationContextSchema
>;

function validateCanonicalOrigin(
  candidate: string,
  transport: "http" | "https",
  context: z.RefinementCtx
): void {
  let configuredOrigin: URL | null = null;
  try {
    configuredOrigin = new URL(candidate);
  } catch {
    // The base URL validator reports the field-level issue.
  }
  if (
    configuredOrigin === null ||
    configuredOrigin.origin !== candidate ||
    configuredOrigin.protocol !== `${transport}:`
  ) {
    context.addIssue({
      code: "custom",
      message: "Request authentication origin must be canonical and match transport.",
      path: ["configured_origin"]
    });
  }
}
