import type { HostPlatformCapability, SupportedHostTarget } from "@hostdeck/contracts";
import { resolveHostPlatformCapability } from "@hostdeck/contracts";

export const hostPlatformFixtureSurfaces = Object.freeze([
  "configuration",
  "paths",
  "endpoint",
  "lifecycle",
  "package",
  "tailscale"
] as const);
export type HostPlatformFixtureSurface = (typeof hostPlatformFixtureSurfaces)[number];

export const hostPlatformFixtureClasses = Object.freeze([
  "valid",
  "invalid",
  "boundary",
  "mixed_platform",
  "secret_bearing"
] as const);
export type HostPlatformFixtureClass = (typeof hostPlatformFixtureClasses)[number];

export type HostPlatformFixtureId =
  `${SupportedHostTarget}:${HostPlatformFixtureSurface}:${HostPlatformFixtureClass}`;

export interface HostPlatformFixtureProfile {
  readonly target: SupportedHostTarget;
  readonly capability: HostPlatformCapability;
  readonly configuration: Readonly<{
    config_root: string;
    state_root: string;
    runtime_root: string;
    database_path: string;
    loopback_port: number;
  }>;
  readonly endpoint: Readonly<{
    kind: HostPlatformCapability["codex_endpoint"];
    address: string;
    credential_source: "none" | "protected_environment";
  }>;
  readonly lifecycle: Readonly<{
    kind: HostPlatformCapability["service_lifecycle"];
    installation_scope: "current_user";
    startup_context: "user_manager" | "interactive_user";
  }>;
  readonly package: Readonly<{
    kind: HostPlatformCapability["public_package_kind"];
    target: SupportedHostTarget;
    runtime_bundled: true;
    native_modules_target: SupportedHostTarget;
  }>;
  readonly tailscale: Readonly<{
    command: HostPlatformCapability["tailscale_command"];
    executable_candidates: readonly string[];
  }>;
}

export interface HostPlatformBoundaryFixture {
  readonly id: HostPlatformFixtureId;
  readonly target: SupportedHostTarget;
  readonly surface: HostPlatformFixtureSurface;
  readonly classification: HostPlatformFixtureClass;
  readonly candidate: Readonly<Record<string, unknown>>;
  readonly expected: "accept" | "reject";
  readonly expected_reason:
    | "invalid_configuration"
    | "invalid_endpoint"
    | "invalid_lifecycle"
    | "invalid_package"
    | "invalid_path"
    | "invalid_tailscale_command"
    | "platform_mismatch"
    | "secret_field_rejected"
    | null;
}

const runtime = Object.freeze({
  node_version: "22.22.2",
  node_abi: "127"
} as const);

export const hostPlatformFixtureProfiles: readonly HostPlatformFixtureProfile[] = deepFreeze([
  {
    target: "linux-x64",
    capability: resolveHostPlatformCapability({
      platform: "linux",
      architecture: "x64",
      ...runtime
    }),
    configuration: {
      config_root: "/home/hostdeck-fixture/.config/hostdeck",
      state_root: "/home/hostdeck-fixture/.local/state/hostdeck",
      runtime_root: "/run/user/1000/hostdeck",
      database_path: "/home/hostdeck-fixture/.local/state/hostdeck/hostdeck.sqlite",
      loopback_port: 3777
    },
    endpoint: {
      kind: "unix_socket",
      address: "unix:///run/user/1000/hostdeck/app-server.sock",
      credential_source: "none"
    },
    lifecycle: {
      kind: "systemd_user",
      installation_scope: "current_user",
      startup_context: "user_manager"
    },
    package: {
      kind: "linux_archive",
      target: "linux-x64",
      runtime_bundled: true,
      native_modules_target: "linux-x64"
    },
    tailscale: {
      command: "tailscale",
      executable_candidates: ["/usr/bin/tailscale"]
    }
  },
  {
    target: "windows-x64",
    capability: resolveHostPlatformCapability({
      platform: "win32",
      architecture: "x64",
      ...runtime
    }),
    configuration: {
      config_root: "C:\\Users\\hostdeck-fixture\\AppData\\Roaming\\HostDeck",
      state_root: "C:\\Users\\hostdeck-fixture\\AppData\\Local\\HostDeck\\State",
      runtime_root: "C:\\Users\\hostdeck-fixture\\AppData\\Local\\HostDeck\\Runtime",
      database_path: "C:\\Users\\hostdeck-fixture\\AppData\\Local\\HostDeck\\State\\hostdeck.sqlite",
      loopback_port: 3777
    },
    endpoint: {
      kind: "authenticated_loopback_websocket",
      address: "ws://127.0.0.1:43871",
      credential_source: "protected_environment"
    },
    lifecycle: {
      kind: "windows_user_agent",
      installation_scope: "current_user",
      startup_context: "interactive_user"
    },
    package: {
      kind: "windows_msix",
      target: "windows-x64",
      runtime_bundled: true,
      native_modules_target: "windows-x64"
    },
    tailscale: {
      command: "tailscale.exe",
      executable_candidates: ["C:\\Program Files\\Tailscale\\tailscale.exe"]
    }
  }
]);

export const requiredHostPlatformFixtureIds: readonly HostPlatformFixtureId[] = Object.freeze(
  hostPlatformFixtureProfiles.flatMap((profile) =>
    hostPlatformFixtureSurfaces.flatMap((surface) =>
      hostPlatformFixtureClasses.map(
        (classification) => `${profile.target}:${surface}:${classification}` as HostPlatformFixtureId
      )
    )
  )
);

export const hostPlatformBoundaryFixtures: readonly HostPlatformBoundaryFixture[] = deepFreeze(
  hostPlatformFixtureProfiles.flatMap((profile) => {
    const opposite = hostPlatformFixtureProfiles.find((candidate) => candidate.target !== profile.target);
    if (opposite === undefined) throw new TypeError("Host platform fixture matrix is incomplete.");
    return hostPlatformFixtureSurfaces.flatMap((surface) =>
      hostPlatformFixtureClasses.map((classification) =>
        boundaryFixture(profile, opposite, surface, classification)
      )
    );
  })
);

export function hostPlatformFixtureProfileByTarget(
  target: SupportedHostTarget
): HostPlatformFixtureProfile {
  const fixture = hostPlatformFixtureProfiles.find((candidate) => candidate.target === target);
  if (fixture === undefined) throw new TypeError("Host platform fixture target is unavailable.");
  return fixture;
}

export function hostPlatformBoundaryFixtureById(
  id: HostPlatformFixtureId
): HostPlatformBoundaryFixture {
  const fixture = hostPlatformBoundaryFixtures.find((candidate) => candidate.id === id);
  if (fixture === undefined) throw new TypeError("Host platform boundary fixture is unavailable.");
  return fixture;
}

function boundaryFixture(
  profile: HostPlatformFixtureProfile,
  opposite: HostPlatformFixtureProfile,
  surface: HostPlatformFixtureSurface,
  classification: HostPlatformFixtureClass
): HostPlatformBoundaryFixture {
  const accepted = classification === "valid" || classification === "boundary";
  return {
    id: `${profile.target}:${surface}:${classification}`,
    target: profile.target,
    surface,
    classification,
    candidate: candidateFor(profile, opposite, surface, classification),
    expected: accepted ? "accept" : "reject",
    expected_reason: accepted ? null : rejectionReason(surface, classification)
  };
}

function candidateFor(
  profile: HostPlatformFixtureProfile,
  opposite: HostPlatformFixtureProfile,
  surface: HostPlatformFixtureSurface,
  classification: HostPlatformFixtureClass
): Readonly<Record<string, unknown>> {
  const base = surfaceCandidate(profile, surface);
  switch (classification) {
    case "valid":
      return base;
    case "boundary":
      return boundaryCandidate(surface, base);
    case "invalid":
      return invalidCandidate(profile, surface, base);
    case "mixed_platform":
      return {
        ...surfaceCandidate(opposite, surface),
        declared_target: profile.target,
        surface_target: opposite.target
      };
    case "secret_bearing":
      return { ...base, private_credential_value: "hostdeck-private-fixture-value" };
  }
}

function surfaceCandidate(
  profile: HostPlatformFixtureProfile,
  surface: HostPlatformFixtureSurface
): Readonly<Record<string, unknown>> {
  switch (surface) {
    case "configuration":
      return { declared_target: profile.target, ...profile.configuration };
    case "paths":
      return {
        declared_target: profile.target,
        path_family: profile.capability.path_family,
        config_root: profile.configuration.config_root,
        state_root: profile.configuration.state_root,
        runtime_root: profile.configuration.runtime_root,
        database_path: profile.configuration.database_path
      };
    case "endpoint":
      return { declared_target: profile.target, ...profile.endpoint };
    case "lifecycle":
      return { declared_target: profile.target, ...profile.lifecycle };
    case "package":
      return { declared_target: profile.target, ...profile.package };
    case "tailscale":
      return { declared_target: profile.target, ...profile.tailscale };
  }
}

function boundaryCandidate(
  surface: HostPlatformFixtureSurface,
  base: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  switch (surface) {
    case "configuration":
      return { ...base, loopback_port: 65_535 };
    case "paths":
      return { ...base, component_bytes: 255 };
    case "endpoint":
      return { ...base, generation: Number.MAX_SAFE_INTEGER };
    case "lifecycle":
      return { ...base, operation: "repeat_idempotent_stop" };
    case "package":
      return { ...base, package_version: "0.0.0-0" };
    case "tailscale":
      return { ...base, output_max_bytes: 8_388_608, timeout_ms: 30_000 };
  }
}

function invalidCandidate(
  profile: HostPlatformFixtureProfile,
  surface: HostPlatformFixtureSurface,
  base: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  switch (surface) {
    case "configuration":
      return { ...base, loopback_port: 65_536 };
    case "paths":
      return { ...base, state_root: "relative/hostdeck" };
    case "endpoint":
      return {
        ...base,
        address:
          profile.target === "linux-x64"
            ? "unix://relative/app-server.sock"
            : "ws://0.0.0.0:43871"
      };
    case "lifecycle":
      return {
        ...base,
        installation_scope: "system",
        startup_context: profile.target === "linux-x64" ? "root_manager" : "session_zero"
      };
    case "package":
      return { ...base, runtime_bundled: false };
    case "tailscale":
      return {
        ...base,
        command: profile.target === "linux-x64" ? "tailscale.sh" : "tailscale.cmd"
      };
  }
}

function rejectionReason(
  surface: HostPlatformFixtureSurface,
  classification: Exclude<HostPlatformFixtureClass, "valid" | "boundary">
): NonNullable<HostPlatformBoundaryFixture["expected_reason"]> {
  if (classification === "mixed_platform") return "platform_mismatch";
  if (classification === "secret_bearing") return "secret_field_rejected";
  switch (surface) {
    case "configuration":
      return "invalid_configuration";
    case "paths":
      return "invalid_path";
    case "endpoint":
      return "invalid_endpoint";
    case "lifecycle":
      return "invalid_lifecycle";
    case "package":
      return "invalid_package";
    case "tailscale":
      return "invalid_tailscale_command";
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
