import { z } from "zod";
import { exactDataObject } from "./exact-data-object.js";

export const supportedHostTargets = Object.freeze(["linux-x64", "windows-x64"] as const);
export const supportedNodePlatforms = Object.freeze(["linux", "win32"] as const);
export const hostPathFamilies = Object.freeze(["posix", "windows"] as const);
export const hostPathSecurityKinds = Object.freeze(["uid_mode", "current_user_acl"] as const);
export const codexLocalEndpointKinds = Object.freeze([
  "unix_socket",
  "authenticated_loopback_websocket"
] as const);
export const hostServiceLifecycleKinds = Object.freeze(["systemd_user", "windows_user_agent"] as const);
export const hostPublicPackageKinds = Object.freeze(["linux_archive", "windows_msix"] as const);

const runtimeVersionSchema = z.string().min(1).max(64).regex(/^\d+\.\d+\.\d+$/u);
const nodeAbiSchema = z.string().min(1).max(8).regex(/^[1-9]\d{0,7}$/u);

const hostRuntimeIdentitySchema = exactDataObject(
  z
    .object({
      node_version: runtimeVersionSchema,
      node_abi: nodeAbiSchema
    })
    .strict()
);

const targetProfiles = Object.freeze({
  "linux-x64": Object.freeze({
    node_platform: "linux",
    architecture: "x64",
    path_family: "posix",
    path_security: "uid_mode",
    codex_endpoint: "unix_socket",
    service_lifecycle: "systemd_user",
    executable_suffix: "",
    tailscale_command: "tailscale",
    public_package_kind: "linux_archive"
  }),
  "windows-x64": Object.freeze({
    node_platform: "win32",
    architecture: "x64",
    path_family: "windows",
    path_security: "current_user_acl",
    codex_endpoint: "authenticated_loopback_websocket",
    service_lifecycle: "windows_user_agent",
    executable_suffix: ".exe",
    tailscale_command: "tailscale.exe",
    public_package_kind: "windows_msix"
  })
} as const);

const hostPlatformCapabilityDataSchema = z
  .object({
    schema_version: z.literal(1),
    target: z.enum(supportedHostTargets),
    node_platform: z.enum(supportedNodePlatforms),
    architecture: z.literal("x64"),
    path_family: z.enum(hostPathFamilies),
    path_security: z.enum(hostPathSecurityKinds),
    codex_endpoint: z.enum(codexLocalEndpointKinds),
    service_lifecycle: z.enum(hostServiceLifecycleKinds),
    executable_suffix: z.enum(["", ".exe"]),
    tailscale_command: z.enum(["tailscale", "tailscale.exe"]),
    public_package_kind: z.enum(hostPublicPackageKinds),
    runtime: hostRuntimeIdentitySchema
  })
  .strict()
  .superRefine((value, context) => {
    const profile = targetProfiles[value.target];
    for (const key of profileKeys) {
      if (value[key] !== profile[key]) {
        context.addIssue({
          code: "custom",
          message: "Host platform capability fields do not match the selected target.",
          path: [key]
        });
      }
    }
  });

export const hostPlatformCapabilitySchema = exactDataObject(hostPlatformCapabilityDataSchema);

export type HostPlatformCapability = z.infer<typeof hostPlatformCapabilitySchema>;
export type SupportedHostTarget = HostPlatformCapability["target"];

export type HostPlatformCapabilityErrorCode =
  | "invalid_input"
  | "invalid_runtime_identity"
  | "platform_contract_mismatch"
  | "unsupported_architecture"
  | "unsupported_platform";

export class HostPlatformCapabilityError extends Error {
  constructor(readonly code: HostPlatformCapabilityErrorCode, options?: ErrorOptions) {
    super("Host platform capability validation failed.", options);
    this.name = "HostPlatformCapabilityError";
  }
}

const resolverInputSchema = exactDataObject(
  z
    .object({
      platform: z.string().min(1).max(32),
      architecture: z.string().min(1).max(32),
      node_version: z.string().min(1).max(64),
      node_abi: z.string().min(1).max(8)
    })
    .strict()
);

const profileKeys = Object.freeze([
  "node_platform",
  "architecture",
  "path_family",
  "path_security",
  "codex_endpoint",
  "service_lifecycle",
  "executable_suffix",
  "tailscale_command",
  "public_package_kind"
] as const);

export function resolveHostPlatformCapability(input: unknown): HostPlatformCapability {
  const parsedInput = resolverInputSchema.safeParse(input);
  if (!parsedInput.success) throw capabilityError("invalid_input", parsedInput.error);

  if (parsedInput.data.platform !== "linux" && parsedInput.data.platform !== "win32") {
    throw capabilityError("unsupported_platform");
  }
  if (parsedInput.data.architecture !== "x64") {
    throw capabilityError("unsupported_architecture");
  }
  const runtime = hostRuntimeIdentitySchema.safeParse({
    node_version: parsedInput.data.node_version,
    node_abi: parsedInput.data.node_abi
  });
  if (!runtime.success) throw capabilityError("invalid_runtime_identity", runtime.error);

  const target: SupportedHostTarget = parsedInput.data.platform === "linux" ? "linux-x64" : "windows-x64";
  const profile = targetProfiles[target];
  return freezeCapability(
    hostPlatformCapabilitySchema.parse({
      schema_version: 1,
      target,
      ...profile,
      runtime: runtime.data
    })
  );
}

export function parseHostPlatformCapability(input: unknown): HostPlatformCapability {
  const parsed = hostPlatformCapabilitySchema.safeParse(input);
  if (!parsed.success) throw capabilityError("platform_contract_mismatch", parsed.error);
  return freezeCapability(parsed.data);
}

function freezeCapability(capability: HostPlatformCapability): HostPlatformCapability {
  return Object.freeze({
    ...capability,
    runtime: Object.freeze({ ...capability.runtime })
  });
}

function capabilityError(code: HostPlatformCapabilityErrorCode, cause?: unknown): HostPlatformCapabilityError {
  return new HostPlatformCapabilityError(code, cause === undefined ? undefined : { cause });
}
