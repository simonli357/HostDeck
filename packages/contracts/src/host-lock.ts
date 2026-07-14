import { z } from "zod";
import { selectedDeviceIdSchema } from "./device-revocation.js";
import { remoteExternalOriginSchema } from "./remote-ingress.js";
import {
  type SelectedRequestAuthenticationState,
  selectedRequestAuthenticationStates,
  selectedRequestNetworkModes
} from "./request-authentication.js";
import { isoTimestampSchema } from "./scalars.js";
import { clientOperationIdSchema } from "./selected-runtime.js";

const hostLockRequestShape = {
  operation_id: clientOperationIdSchema,
  confirmed: z.literal(true)
} as const;

export const selectedHostLockRequestSchema = z
  .object(hostLockRequestShape)
  .strict();

export const selectedHostUnlockRequestSchema = z
  .object(hostLockRequestShape)
  .strict();

function createHostAccessStateResponseSchema() {
  return z
    .object({
      authentication_state: z.enum(selectedRequestAuthenticationStates),
      device_id: selectedDeviceIdSchema.nullable(),
      permission: z.enum(["local_admin", "read", "write"]).nullable(),
      device_expires_at: isoTimestampSchema.nullable(),
      configured_origin: z.string().url().max(512),
      network_mode: z.enum(selectedRequestNetworkModes),
      transport: z.enum(["http", "https"]),
      locked: z.boolean(),
      can_read_sessions: z.boolean(),
      can_write_sessions: z.boolean(),
      can_lock: z.boolean(),
      can_unlock: z.boolean()
    })
    .strict()
    .superRefine((value, context) => {
      let origin: URL | null = null;
      try {
        origin = new URL(value.configured_origin);
      } catch {
        // The field URL validator owns the basic syntax issue.
      }
      if (
        origin === null ||
        origin.origin !== value.configured_origin ||
        origin.protocol !== `${value.transport}:`
      ) {
        context.addIssue({
          code: "custom",
          message: "Access-state origin must be canonical and match transport.",
          path: ["configured_origin"]
        });
      }
      if (value.network_mode === "lan" && value.transport !== "https") {
        context.addIssue({
          code: "custom",
          message: "LAN access state requires HTTPS.",
          path: ["transport"]
        });
      }
      if (value.network_mode === "remote" && value.transport !== "https") {
        context.addIssue({
          code: "custom",
          message: "Remote access state requires HTTPS.",
          path: ["transport"]
        });
      }
      if (
        value.network_mode === "remote" &&
        !remoteExternalOriginSchema.safeParse(value.configured_origin).success
      ) {
        context.addIssue({
          code: "custom",
          message: "Remote access state requires one canonical private Tailscale origin.",
          path: ["configured_origin"]
        });
      }
      if (value.network_mode === "remote" && value.authentication_state === "local_admin") {
        context.addIssue({
          code: "custom",
          message: "Remote access state cannot grant local-admin authority.",
          path: ["authentication_state"]
        });
      }

      const paired = value.authentication_state === "paired_device";
      const localAdmin = value.authentication_state === "local_admin";
      const pairedWriter = paired && value.permission === "write";
      if (localAdmin) {
        if (
          value.device_id !== null ||
          value.permission !== "local_admin" ||
          value.device_expires_at !== null
        ) {
          context.addIssue({
            code: "custom",
            message: "Local-admin access state cannot expose device authority."
          });
        }
      } else if (paired) {
        if (
          value.device_id === null ||
          (value.permission !== "read" && value.permission !== "write")
        ) {
          context.addIssue({
            code: "custom",
            message: "Paired access state requires device identity and permission."
          });
        }
      } else if (
        value.device_id !== null ||
        value.permission !== null ||
        value.device_expires_at !== null
      ) {
        context.addIssue({
          code: "custom",
          message: "Unauthenticated access state cannot expose device authority."
        });
      }

      const expectedCanRead =
        localAdmin ||
        paired ||
        (value.authentication_state === "unpaired" &&
          value.network_mode === "loopback");
      const expectedCanWrite = (localAdmin || pairedWriter) && !value.locked;
      const expectedCanLock = localAdmin || pairedWriter;
      if (value.can_read_sessions !== expectedCanRead) {
        addCapabilityIssue(context, "can_read_sessions");
      }
      if (value.can_write_sessions !== expectedCanWrite) {
        addCapabilityIssue(context, "can_write_sessions");
      }
      if (value.can_lock !== expectedCanLock) {
        addCapabilityIssue(context, "can_lock");
      }
      if (value.can_unlock !== localAdmin) {
        addCapabilityIssue(context, "can_unlock");
      }
    });
}

export const selectedAccessStateResponseSchema =
  createHostAccessStateResponseSchema();
export const selectedHostLockStateResponseSchema =
  createHostAccessStateResponseSchema();

function addCapabilityIssue(
  context: z.RefinementCtx,
  field:
    | "can_lock"
    | "can_read_sessions"
    | "can_unlock"
    | "can_write_sessions"
): void {
  context.addIssue({
    code: "custom",
    message: "Access-state capability does not match selected authority.",
    path: [field]
  });
}

export type SelectedHostLockRequest = z.infer<
  typeof selectedHostLockRequestSchema
>;
export type SelectedHostUnlockRequest = z.infer<
  typeof selectedHostUnlockRequestSchema
>;
export type SelectedAccessStateResponse = z.infer<
  typeof selectedAccessStateResponseSchema
>;
export type SelectedHostLockStateResponse = z.infer<
  typeof selectedHostLockStateResponseSchema
>;
export type SelectedHostAccessAuthenticationState =
  SelectedRequestAuthenticationState;
