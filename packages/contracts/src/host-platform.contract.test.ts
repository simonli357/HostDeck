import { describe, expect, it } from "vitest";
import {
  codexLocalEndpointKinds,
  HostPlatformCapabilityError,
  hostPathFamilies,
  hostPathSecurityKinds,
  hostPlatformCapabilitySchema,
  hostPublicPackageKinds,
  hostServiceLifecycleKinds,
  parseHostPlatformCapability,
  resolveHostPlatformCapability,
  supportedHostTargets,
  supportedNodePlatforms
} from "./host-platform.js";

const runtime = {
  node_version: "22.22.2",
  node_abi: "127"
} as const;

describe("host platform capability contract", () => {
  it("owns frozen, unique platform vocabularies", () => {
    for (const values of [
      supportedHostTargets,
      supportedNodePlatforms,
      hostPathFamilies,
      hostPathSecurityKinds,
      codexLocalEndpointKinds,
      hostServiceLifecycleKinds,
      hostPublicPackageKinds
    ]) {
      expect(Object.isFrozen(values)).toBe(true);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it("resolves one immutable coherent capability for each supported runtime", () => {
    const linux = resolveHostPlatformCapability({
      platform: "linux",
      architecture: "x64",
      ...runtime
    });
    const windows = resolveHostPlatformCapability({
      platform: "win32",
      architecture: "x64",
      ...runtime
    });

    expect(linux).toEqual({
      schema_version: 1,
      target: "linux-x64",
      node_platform: "linux",
      architecture: "x64",
      path_family: "posix",
      path_security: "uid_mode",
      codex_endpoint: "unix_socket",
      service_lifecycle: "systemd_user",
      executable_suffix: "",
      tailscale_command: "tailscale",
      public_package_kind: "linux_archive",
      runtime
    });
    expect(windows).toEqual({
      schema_version: 1,
      target: "windows-x64",
      node_platform: "win32",
      architecture: "x64",
      path_family: "windows",
      path_security: "current_user_acl",
      codex_endpoint: "authenticated_loopback_websocket",
      service_lifecycle: "windows_user_agent",
      executable_suffix: ".exe",
      tailscale_command: "tailscale.exe",
      public_package_kind: "windows_msix",
      runtime
    });
    for (const capability of [linux, windows]) {
      expect(Object.isFrozen(capability)).toBe(true);
      expect(Object.isFrozen(capability.runtime)).toBe(true);
      expect(parseHostPlatformCapability(capability)).toEqual(capability);
    }
  });

  it("rejects every mixed target field and unknown or secret-bearing data", () => {
    const linux = resolveHostPlatformCapability({
      platform: "linux",
      architecture: "x64",
      ...runtime
    });
    const windows = resolveHostPlatformCapability({
      platform: "win32",
      architecture: "x64",
      ...runtime
    });
    const mixedFields = [
      "node_platform",
      "path_family",
      "path_security",
      "codex_endpoint",
      "service_lifecycle",
      "executable_suffix",
      "tailscale_command",
      "public_package_kind"
    ] as const;

    for (const field of mixedFields) {
      expect(
        hostPlatformCapabilitySchema.safeParse({
          ...linux,
          [field]: windows[field]
        }).success,
        field
      ).toBe(false);
    }
    for (const candidate of [
      { ...linux, target: "macos-x64" },
      { ...linux, architecture: "arm64" },
      { ...linux, endpoint_path: "/private/app-server.sock" },
      { ...windows, endpoint_token: "private-token" },
      { ...windows, runtime: { ...runtime, private_path: "C:\\private" } },
      { ...windows, schema_version: 2 }
    ]) {
      expect(hostPlatformCapabilitySchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("fails unsupported and malformed runtime identities with bounded non-reflecting errors", () => {
    const cases = [
      ["unsupported_platform", { platform: "private-platform", architecture: "x64", ...runtime }],
      ["unsupported_architecture", { platform: "linux", architecture: "arm64", ...runtime }],
      ["invalid_runtime_identity", { platform: "linux", architecture: "x64", ...runtime, node_abi: "secret" }],
      ["invalid_input", { platform: "linux", architecture: "x64", ...runtime, endpoint_token: "private-token" }]
    ] as const;

    for (const [code, candidate] of cases) {
      expect(() => resolveHostPlatformCapability(candidate)).toThrowError(
        expect.objectContaining({ code, message: "Host platform capability validation failed." })
      );
      try {
        resolveHostPlatformCapability(candidate);
      } catch (error) {
        expect(error).toBeInstanceOf(HostPlatformCapabilityError);
        expect(JSON.stringify({ name: (error as Error).name, message: (error as Error).message })).not.toMatch(
          /private|secret|token/u
        );
      }
    }
  });

  it("rejects non-data objects without invoking accessors", () => {
    let reads = 0;
    const candidate = {
      platform: "linux",
      architecture: "x64",
      node_version: runtime.node_version,
      get node_abi() {
        reads += 1;
        return runtime.node_abi;
      }
    };
    expect(() => resolveHostPlatformCapability(candidate)).toThrowError(
      expect.objectContaining({ code: "invalid_input" })
    );
    expect(reads).toBe(0);
  });
});
