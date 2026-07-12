import { z } from "zod";
import { selectedDeviceIdSchema } from "./device-revocation.js";
import { isoTimestampSchema, positiveSafeIntegerSchema } from "./scalars.js";

export const selectedRequestAuthenticationStates = [
  "local_admin",
  "unpaired",
  "invalid_device",
  "expired_device",
  "revoked_device",
  "paired_device"
] as const;

export const selectedRequestAuthenticationContextSchema = z
  .object({
    state: z.enum(selectedRequestAuthenticationStates),
    configured_origin: z.string().url().max(512),
    network_mode: z.enum(["loopback", "lan"]),
    origin_kind: z.enum(["same_origin", "safe_no_origin", "local_non_browser"]),
    transport: z.enum(["http", "https"]),
    device_id: selectedDeviceIdSchema.nullable(),
    permission: z.enum(["local_admin", "read", "write"]).nullable(),
    csrf_generation: positiveSafeIntegerSchema.nullable(),
    last_used_at: isoTimestampSchema.nullable(),
    expires_at: isoTimestampSchema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    let configuredOrigin: URL | null = null;
    try {
      configuredOrigin = new URL(value.configured_origin);
    } catch {
      // The base URL validator reports the field-level issue.
    }
    if (
      configuredOrigin === null ||
      configuredOrigin.origin !== value.configured_origin ||
      configuredOrigin.protocol !== `${value.transport}:`
    ) {
      context.addIssue({
        code: "custom",
        message: "Request authentication origin must be canonical and match transport.",
        path: ["configured_origin"]
      });
    }
    if (value.network_mode === "lan" && value.transport !== "https") {
      context.addIssue({
        code: "custom",
        message: "LAN request authentication requires HTTPS.",
        path: ["transport"]
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
export type SelectedRequestAuthenticationContext = z.infer<
  typeof selectedRequestAuthenticationContextSchema
>;
