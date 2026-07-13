import { z } from "zod";
import { isoTimestampSchema } from "./scalars.js";
import { clientOperationIdSchema } from "./selected-runtime.js";

export const selectedLanCertificateStates = [
  "not_configured",
  "valid",
  "renewal_due",
  "not_yet_valid",
  "expired",
  "identity_mismatch",
  "unavailable"
] as const;

export const selectedLanAddressFamilies = ["ipv4", "ipv6"] as const;

export const selectedCanonicalIpHostSchema = z
  .string()
  .min(2)
  .max(45)
  .superRefine((value, context) => {
    if (canonicalIpHost(value) !== value) {
      context.addIssue({
        code: "custom",
        message: "LAN bind host must be one canonical IP address."
      });
    }
  });

const mutationShape = {
  operation_id: clientOperationIdSchema,
  confirmed: z.literal(true)
} as const;

export const selectedLanConfigureRequestSchema = exactDataObject(
  z.object({
    ...mutationShape,
    bind_host: selectedCanonicalIpHostSchema,
    bind_port: z.number().int().min(1).max(65_535),
    certificate_action: z.enum(["reuse", "issue_leaf"])
  })
    .strict()
);

export const selectedLanEnableRequestSchema = exactDataObject(
  z.object(mutationShape).strict()
);
export const selectedLanDisableRequestSchema = exactDataObject(
  z.object(mutationShape).strict()
);

const networkStateShape = {
  active_network_mode: z.enum(["loopback", "lan"]),
  active_transport: z.enum(["http", "https"]),
  active_origin: z.string().url().max(512),
  desired_mode: z.enum(["loopback", "lan"]),
  lan_enabled: z.boolean(),
  configured: z.boolean(),
  bind_host: selectedCanonicalIpHostSchema.nullable(),
  bind_port: z.number().int().min(1).max(65_535).nullable(),
  configured_origin: z.string().url().max(512).nullable(),
  address_family: z.enum(selectedLanAddressFamilies).nullable(),
  certificate_state: z.enum(selectedLanCertificateStates),
  root_fingerprint_sha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  leaf_fingerprint_sha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  leaf_valid_from: isoTimestampSchema.nullable(),
  leaf_expires_at: isoTimestampSchema.nullable(),
  enrollment_available: z.boolean(),
  can_manage_lan: z.boolean(),
  restart_required: z.boolean()
} as const;

function createNetworkStateSchema() {
  return exactDataObject(
    z
      .object(networkStateShape)
      .strict()
      .superRefine((value, context) => {
      const activeOrigin = canonicalOrigin(value.active_origin);
      if (
        activeOrigin === null ||
        activeOrigin !== value.active_origin ||
        new URL(activeOrigin).protocol !== `${value.active_transport}:`
      ) {
        addIssue(context, "active_origin", "Active origin must be canonical and match transport.");
      }
      if (value.active_network_mode === "lan" && value.active_transport !== "https") {
        addIssue(context, "active_transport", "Active LAN mode requires HTTPS.");
      }
      if (value.lan_enabled !== (value.desired_mode === "lan")) {
        addIssue(context, "lan_enabled", "LAN enabled state must match desired mode.");
      }

      const configuredValues = [
        value.bind_host,
        value.bind_port,
        value.configured_origin,
        value.address_family,
        value.root_fingerprint_sha256,
        value.leaf_fingerprint_sha256,
        value.leaf_valid_from,
        value.leaf_expires_at
      ];
      if (value.configured) {
        if (configuredValues.some((field) => field === null)) {
          context.addIssue({
            code: "custom",
            message: "Configured LAN state requires complete public configuration metadata."
          });
        } else {
          const expectedOrigin = lanOrigin(value.bind_host as string, value.bind_port as number);
          if (value.configured_origin !== expectedOrigin) {
            addIssue(context, "configured_origin", "Configured origin must match the LAN host and port.");
          }
          const expectedFamily = (value.bind_host as string).includes(":") ? "ipv6" : "ipv4";
          if (value.address_family !== expectedFamily) {
            addIssue(context, "address_family", "LAN address family must match the configured host.");
          }
          if (
            Date.parse(value.leaf_expires_at as string) <=
            Date.parse(value.leaf_valid_from as string)
          ) {
            addIssue(context, "leaf_expires_at", "Leaf certificate expiry must follow its validity start.");
          }
        }
        if (value.certificate_state === "not_configured") {
          addIssue(context, "certificate_state", "Configured LAN state requires a certificate state.");
        }
      } else {
        if (configuredValues.some((field) => field !== null)) {
          context.addIssue({
            code: "custom",
            message: "Unconfigured LAN state cannot expose configuration metadata."
          });
        }
        if (value.certificate_state !== "not_configured" || value.enrollment_available) {
          addIssue(context, "certificate_state", "Unconfigured LAN state cannot expose certificate availability.");
        }
      }
      if (value.desired_mode === "lan" && !value.configured) {
        addIssue(context, "desired_mode", "Desired LAN mode requires a complete configuration.");
      }

      const expectedRestart =
        value.active_network_mode !== value.desired_mode ||
        (value.desired_mode === "lan" &&
          (value.active_transport !== "https" ||
            value.active_origin !== value.configured_origin));
      if (value.restart_required !== expectedRestart) {
        addIssue(context, "restart_required", "Restart state must match active and desired network state.");
      }
      })
  );
}

export const selectedNetworkStateResponseSchema = createNetworkStateSchema();

export const selectedLanMutationResponseSchema = exactDataObject(
  z
    .object({
      ...networkStateShape,
      configuration_changed: z.boolean(),
      desired_mode_changed: z.boolean()
    })
    .strict()
    .superRefine((value, context) => {
      const state = Object.fromEntries(
        Object.keys(networkStateShape).map((key) => [
          key,
          value[key as keyof typeof networkStateShape]
        ])
      );
      const result = selectedNetworkStateResponseSchema.safeParse(state);
      if (!result.success) {
        for (const issue of result.error.issues) {
          context.addIssue({
            code: "custom",
            message: issue.message,
            path: issue.path
          });
        }
      }
    })
);

export function canonicalIpHost(value: string): string | null {
  try {
    const ipv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(value);
    const ipv6 = value.includes(":") && !value.includes("[") && !value.includes("]");
    if (!ipv4 && !ipv6) return null;
    const url = new URL(`https://${ipv6 ? `[${value}]` : value}/`);
    const hostname = url.hostname.replace(/^\[|\]$/gu, "");
    return hostname === value ? hostname : null;
  } catch {
    return null;
  }
}

export function lanOrigin(bindHost: string, bindPort: number): string {
  const host = bindHost.includes(":") ? `[${bindHost}]` : bindHost;
  return new URL(`https://${host}:${bindPort}/`).origin;
}

function canonicalOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    return parsed.origin === value ? parsed.origin : null;
  } catch {
    return null;
  }
}

function addIssue(context: z.RefinementCtx, field: string, message: string): void {
  context.addIssue({ code: "custom", message, path: [field] });
}

function exactDataObject<T extends z.ZodType>(schema: T) {
  return z.preprocess((input) => {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return input;
    }
    const prototype: unknown = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (
      Reflect.ownKeys(descriptors).some((key) => {
        const descriptor = descriptors[key as keyof typeof descriptors];
        return (
          typeof key !== "string" ||
          descriptor === undefined ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        );
      })
    ) {
      return null;
    }
    return input;
  }, schema);
}

export type SelectedLanConfigureRequest = z.infer<typeof selectedLanConfigureRequestSchema>;
export type SelectedLanEnableRequest = z.infer<typeof selectedLanEnableRequestSchema>;
export type SelectedLanDisableRequest = z.infer<typeof selectedLanDisableRequestSchema>;
export type SelectedNetworkStateResponse = z.infer<typeof selectedNetworkStateResponseSchema>;
export type SelectedLanMutationResponse = z.infer<typeof selectedLanMutationResponseSchema>;
export type SelectedLanCertificateState = (typeof selectedLanCertificateStates)[number];
export type SelectedLanAddressFamily = (typeof selectedLanAddressFamilies)[number];
