import {
  hostPlatformCapabilitySchema,
  parseHostPlatformCapability,
  resolveHostPlatformCapability
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import {
  hostPlatformBoundaryFixtureById,
  hostPlatformBoundaryFixtures,
  hostPlatformFixtureClasses,
  hostPlatformFixtureProfileByTarget,
  hostPlatformFixtureProfiles,
  hostPlatformFixtureSurfaces,
  requiredHostPlatformFixtureIds
} from "./host-platform.js";

describe("host platform fixture inventory", () => {
  it("contains the complete two-target, six-surface, five-class cross-product", () => {
    expect(hostPlatformFixtureProfiles.map(({ target }) => target)).toEqual([
      "linux-x64",
      "windows-x64"
    ]);
    expect(hostPlatformBoundaryFixtures.map(({ id }) => id)).toEqual(requiredHostPlatformFixtureIds);
    expect(hostPlatformBoundaryFixtures).toHaveLength(60);
    expect(new Set(requiredHostPlatformFixtureIds).size).toBe(60);

    for (const target of ["linux-x64", "windows-x64"] as const) {
      for (const surface of hostPlatformFixtureSurfaces) {
        expect(
          hostPlatformBoundaryFixtures
            .filter((fixture) => fixture.target === target && fixture.surface === surface)
            .map(({ classification }) => classification)
        ).toEqual(hostPlatformFixtureClasses);
      }
    }
  });

  it("binds each normalized profile to one coherent immutable capability and surface set", () => {
    const linux = hostPlatformFixtureProfileByTarget("linux-x64");
    const windows = hostPlatformFixtureProfileByTarget("windows-x64");

    for (const profile of [linux, windows]) {
      expect(parseHostPlatformCapability(profile.capability)).toEqual(profile.capability);
      expect(profile.package.target).toBe(profile.target);
      expect(profile.package.native_modules_target).toBe(profile.target);
      expect(profile.package.kind).toBe(profile.capability.public_package_kind);
      expect(profile.endpoint.kind).toBe(profile.capability.codex_endpoint);
      expect(profile.lifecycle.kind).toBe(profile.capability.service_lifecycle);
      expect(profile.tailscale.command).toBe(profile.capability.tailscale_command);
      expect(isDeepFrozen(profile)).toBe(true);
    }

    expect(linux.configuration).toMatchObject({ loopback_port: 3777 });
    expect(Object.values(linux.configuration).filter((value) => typeof value === "string")).toSatisfy(
      (paths: string[]) => paths.every((path) => path.startsWith("/"))
    );
    expect(linux.endpoint).toEqual({
      kind: "unix_socket",
      address: "unix:///run/user/1000/hostdeck/app-server.sock",
      credential_source: "none"
    });
    expect(windows.configuration).toMatchObject({ loopback_port: 3777 });
    expect(Object.values(windows.configuration).filter((value) => typeof value === "string")).toSatisfy(
      (paths: string[]) => paths.every((path) => /^[A-Z]:\\/u.test(path))
    );
    expect(windows.endpoint).toEqual({
      kind: "authenticated_loopback_websocket",
      address: "ws://127.0.0.1:43871",
      credential_source: "protected_environment"
    });
  });

  it("keeps valid and boundary cases accepted while every hostile class fails closed", () => {
    for (const fixture of hostPlatformBoundaryFixtures) {
      const shouldAccept = fixture.classification === "valid" || fixture.classification === "boundary";
      expect(fixture.expected, fixture.id).toBe(shouldAccept ? "accept" : "reject");
      expect(fixture.expected_reason === null, fixture.id).toBe(shouldAccept);
      expect(fixture.candidate.declared_target, fixture.id).toBe(fixture.target);
    }
  });

  it("makes mixed-platform and secret-bearing inputs explicit without leaking secret data", () => {
    const privateValue = "hostdeck-private-fixture-value";
    for (const fixture of hostPlatformBoundaryFixtures) {
      if (fixture.classification === "mixed_platform") {
        expect(fixture.candidate.surface_target, fixture.id).not.toBe(fixture.target);
        expect(fixture.expected_reason).toBe("platform_mismatch");
      }
      if (fixture.classification === "secret_bearing") {
        expect(fixture.candidate.private_credential_value, fixture.id).toBe(privateValue);
        expect(fixture.expected_reason).toBe("secret_field_rejected");
        expect(JSON.stringify({ reason: fixture.expected_reason, id: fixture.id })).not.toContain(privateValue);
      }
    }
  });

  it("provides exact invalid and boundary values for every downstream surface", () => {
    expect(hostPlatformBoundaryFixtureById("linux-x64:configuration:boundary").candidate.loopback_port).toBe(65_535);
    expect(hostPlatformBoundaryFixtureById("windows-x64:configuration:invalid").candidate.loopback_port).toBe(65_536);
    expect(hostPlatformBoundaryFixtureById("linux-x64:paths:invalid").candidate.state_root).toBe("relative/hostdeck");
    expect(hostPlatformBoundaryFixtureById("windows-x64:endpoint:invalid").candidate.address).toBe("ws://0.0.0.0:43871");
    expect(hostPlatformBoundaryFixtureById("windows-x64:lifecycle:invalid").candidate.startup_context).toBe("session_zero");
    expect(hostPlatformBoundaryFixtureById("linux-x64:package:invalid").candidate.runtime_bundled).toBe(false);
    expect(hostPlatformBoundaryFixtureById("windows-x64:tailscale:invalid").candidate.command).toBe("tailscale.cmd");
  });

  it("round-trips repeatedly without shared-state mutation or live host inspection", async () => {
    const before = JSON.stringify({ hostPlatformFixtureProfiles, hostPlatformBoundaryFixtures });
    const passes = await Promise.all(
      Array.from({ length: 32 }, async () =>
        hostPlatformFixtureProfiles.map((profile) => hostPlatformCapabilitySchema.parse(profile.capability))
      )
    );

    expect(passes).toHaveLength(32);
    expect(passes.every((pass) => pass.length === 2)).toBe(true);
    expect(JSON.stringify({ hostPlatformFixtureProfiles, hostPlatformBoundaryFixtures })).toBe(before);
    expect(isDeepFrozen(hostPlatformFixtureProfiles)).toBe(true);
    expect(isDeepFrozen(hostPlatformBoundaryFixtures)).toBe(true);
  });

  it("uses resolver inputs that are independent from the machine running the test", () => {
    expect(
      resolveHostPlatformCapability({
        platform: "linux",
        architecture: "x64",
        node_version: "22.22.2",
        node_abi: "127"
      })
    ).toEqual(hostPlatformFixtureProfileByTarget("linux-x64").capability);
    expect(
      resolveHostPlatformCapability({
        platform: "win32",
        architecture: "x64",
        node_version: "22.22.2",
        node_abi: "127"
      })
    ).toEqual(hostPlatformFixtureProfileByTarget("windows-x64").capability);
  });
});

function isDeepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every((child) => isDeepFrozen(child));
}
