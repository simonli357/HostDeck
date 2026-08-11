import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { HostDeckCodexAdapterError } from "./errors.js";
import {
  codexRemoteAuthEnvironmentVariable,
  createCodexUnixSocketEndpoint,
  describeCodexLocalEndpoint,
  formatCodexLocalRemoteAddress,
  formatCodexUnixRemoteAddress,
  parseCodexLocalEndpoint,
  parseCodexUnixSocketPath,
  resolveCodexEndpointConnection
} from "./transport-endpoint.js";

const credential = "A".repeat(64);
const windowsEndpoint = Object.freeze({
  schema_version: 1 as const,
  target: "windows-x64" as const,
  kind: "authenticated_loopback_websocket" as const,
  address: "ws://127.0.0.1:43871",
  port_allocation: "ephemeral_random" as const,
  credential_source: "protected_environment" as const
});

describe("Codex local endpoint contract", () => {
  it("normalizes immutable canonical endpoints and separates remote from display addresses", () => {
    const unixEndpoint = parseCodexLocalEndpoint({
      schema_version: 1,
      target: "linux-x64",
      kind: "unix_socket",
      address: "unix:///run/user/1000/hostdeck/codex.sock",
      credential_source: "none"
    });
    const parsedWindowsEndpoint = parseCodexLocalEndpoint(windowsEndpoint);

    expect(unixEndpoint).toEqual({
      schema_version: 1,
      target: "linux-x64",
      kind: "unix_socket",
      address: "unix:///run/user/1000/hostdeck/codex.sock",
      credential_source: "none"
    });
    expect(parsedWindowsEndpoint).toEqual(windowsEndpoint);
    expect(Object.isFrozen(unixEndpoint)).toBe(true);
    expect(Object.isFrozen(parsedWindowsEndpoint)).toBe(true);
    expect(formatCodexLocalRemoteAddress(unixEndpoint)).toBe(
      "unix:///run/user/1000/hostdeck/codex.sock"
    );
    expect(formatCodexLocalRemoteAddress(parsedWindowsEndpoint)).toBe(
      "ws://127.0.0.1:43871"
    );
    expect(describeCodexLocalEndpoint(unixEndpoint)).toBe("unix://<private>");
    expect(describeCodexLocalEndpoint(parsedWindowsEndpoint)).toBe(
      "ws://127.0.0.1:<ephemeral>"
    );
  });

  it("accepts the complete nonprivileged port domain without changing address identity", () => {
    const ports = new Set([1_024, 1_025, 49_152, 65_534, 65_535]);
    let state = 0x5eed1234;
    for (let index = 0; index < 512; index += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      ports.add(1_024 + (state % (65_535 - 1_024 + 1)));
    }

    for (const port of ports) {
      const address = `ws://127.0.0.1:${port}`;
      expect(
        parseCodexLocalEndpoint({ ...windowsEndpoint, address }).address
      ).toBe(address);
    }
  });

  it.each([
    null,
    {},
    { ...windowsEndpoint, schema_version: 2 },
    { ...windowsEndpoint, target: "linux-x64" },
    { ...windowsEndpoint, credential_source: "none" },
    { ...windowsEndpoint, port_allocation: "fixed" },
    { ...windowsEndpoint, address: "ws://localhost:43871" },
    { ...windowsEndpoint, address: "ws://127.0.0.2:43871" },
    { ...windowsEndpoint, address: "ws://[::1]:43871" },
    { ...windowsEndpoint, address: "wss://127.0.0.1:43871" },
    { ...windowsEndpoint, address: "ws://127.0.0.1:80" },
    { ...windowsEndpoint, address: "ws://127.0.0.1:1023" },
    { ...windowsEndpoint, address: "ws://127.0.0.1:65536" },
    { ...windowsEndpoint, address: "ws://127.0.0.1:043871" },
    { ...windowsEndpoint, address: "ws://127.0.0.1:43871/" },
    { ...windowsEndpoint, address: "ws://127.0.0.1:43871?token=value" },
    { ...windowsEndpoint, address: "ws://user@127.0.0.1:43871" },
    { ...windowsEndpoint, extra: true },
    {
      schema_version: 1,
      target: "linux-x64",
      kind: "unix_socket",
      address: "unix://relative.sock",
      credential_source: "none"
    },
    {
      schema_version: 1,
      target: "linux-x64",
      kind: "unix_socket",
      address: "unix:///tmp/hostdeck/../codex.sock",
      credential_source: "none"
    },
    {
      schema_version: 1,
      target: "linux-x64",
      kind: "unix_socket",
      address: "unix:///tmp//codex.sock",
      credential_source: "none"
    },
    {
      schema_version: 1,
      target: "linux-x64",
      kind: "unix_socket",
      address: "unix:///tmp/codex.sock/",
      credential_source: "none"
    },
    {
      schema_version: 1,
      target: "linux-x64",
      kind: "unix_socket",
      address: "unix:///tmp/codex:bad.sock",
      credential_source: "none"
    },
    {
      schema_version: 1,
      target: "linux-x64",
      kind: "unix_socket",
      address: "unix:///tmp/codex%2fsocket.sock",
      credential_source: "none"
    },
    {
      schema_version: 1,
      target: "linux-x64",
      kind: "unix_socket",
      address: "unix:///tmp/codex\n.sock",
      credential_source: "none"
    },
    Object.assign(Object.create(null), windowsEndpoint, {
      [Symbol("hidden")]: true
    })
  ])("rejects ambiguous, mixed-target, or noncanonical endpoint %#", (candidate) => {
    expectAdapterError(() => parseCodexLocalEndpoint(candidate));
  });

  it("bounds Unix paths by normalized POSIX UTF-8 bytes on every host", () => {
    const exact = `/tmp/${"x".repeat(102)}`;
    expect(Buffer.byteLength(exact, "utf8")).toBe(107);
    expect(parseCodexUnixSocketPath(exact)).toBe(exact);
    expect(createCodexUnixSocketEndpoint(exact).address).toBe(`unix://${exact}`);
    expect(formatCodexUnixRemoteAddress(exact)).toBe(`unix://${exact}`);
    expectAdapterError(() => parseCodexUnixSocketPath(`${exact}x`));
    expectAdapterError(() =>
      parseCodexUnixSocketPath(`/tmp/${"e".repeat(101)}\u00e9`)
    );
  });

  it("converts accessor and proxy failures into bounded endpoint errors", () => {
    const canary = "endpoint-private-canary";
    let accessorReads = 0;
    const accessor = {
      ...windowsEndpoint,
      get kind(): never {
        accessorReads += 1;
        throw new Error(canary);
      }
    };
    const proxy = new Proxy(windowsEndpoint, {
      ownKeys(): never {
        throw new Error(canary);
      }
    });

    assertErrorDoesNotContain(
      captureAdapterError(() => parseCodexLocalEndpoint(accessor)),
      canary
    );
    assertErrorDoesNotContain(
      captureAdapterError(() => parseCodexLocalEndpoint(proxy)),
      canary
    );
    expect(accessorReads).toBe(0);
  });
});

describe("Codex endpoint credential resolution", () => {
  it("reads the fixed protected environment source exactly once", () => {
    let reads = 0;
    const connection = resolveCodexEndpointConnection(
      windowsEndpoint,
      "windows-x64",
      {
        kind: "protected_environment",
        environment_variable: codexRemoteAuthEnvironmentVariable,
        read: (name: string) => {
          reads += 1;
          expect(name).toBe(codexRemoteAuthEnvironmentVariable);
          return credential;
        }
      }
    );

    expect(reads).toBe(1);
    expect(connection).toEqual({
      endpoint: windowsEndpoint,
      web_socket_address: windowsEndpoint.address,
      authorization_header: `Bearer ${credential}`
    });
    expect(Object.isFrozen(connection)).toBe(true);
    expect(JSON.stringify(connection.endpoint)).not.toContain(credential);
    expect(describeCodexLocalEndpoint(connection.endpoint)).not.toContain(
      credential
    );
  });

  it.each([43, 44, 64, 511, 512])(
    "accepts a base64url credential at supported length %i",
    (length) => {
      const token = `${"A".repeat(length - 2)}_-`;
      expect(
        resolveCodexEndpointConnection(
          windowsEndpoint,
          "windows-x64",
          {
            kind: "protected_environment",
            environment_variable: codexRemoteAuthEnvironmentVariable,
            read: () => token
          }
        ).authorization_header
      ).toBe(`Bearer ${token}`);
    }
  );

  it("resolves Unix transport without accepting any credential source", () => {
    const endpoint = createCodexUnixSocketEndpoint("/tmp/hostdeck.sock");
    expect(
      resolveCodexEndpointConnection(endpoint, "linux-x64", undefined)
    ).toEqual({
      endpoint,
      web_socket_address: "ws+unix:/tmp/hostdeck.sock",
      authorization_header: null
    });
    expectAdapterError(() =>
      resolveCodexEndpointConnection(endpoint, "linux-x64", {
        kind: "protected_environment",
        environment_variable: codexRemoteAuthEnvironmentVariable,
        read: () => credential
      })
    );
  });

  it.each([
    undefined,
    null,
    {},
    {
      kind: "protected_environment",
      environment_variable: "PATH",
      read: () => credential
    },
    {
      kind: "protected_environment",
      environment_variable: codexRemoteAuthEnvironmentVariable,
      read: () => undefined
    },
    {
      kind: "protected_environment",
      environment_variable: codexRemoteAuthEnvironmentVariable,
      read: () => "short"
    },
    {
      kind: "protected_environment",
      environment_variable: codexRemoteAuthEnvironmentVariable,
      read: () => "A".repeat(42)
    },
    {
      kind: "protected_environment",
      environment_variable: codexRemoteAuthEnvironmentVariable,
      read: () => `${"A".repeat(42)}+`
    },
    {
      kind: "protected_environment",
      environment_variable: codexRemoteAuthEnvironmentVariable,
      read: () => "A".repeat(513)
    },
    {
      kind: "protected_environment",
      environment_variable: codexRemoteAuthEnvironmentVariable,
      read: () => credential,
      extra: true
    }
  ])("rejects invalid protected credential source %#", (candidate) => {
    expectAdapterError(() =>
      resolveCodexEndpointConnection(
        windowsEndpoint,
        "windows-x64",
        candidate
      )
    );
  });

  it("rejects target mismatch before consulting protected authority", () => {
    let reads = 0;
    expectAdapterError(() =>
      resolveCodexEndpointConnection(windowsEndpoint, "linux-x64", {
        kind: "protected_environment",
        environment_variable: codexRemoteAuthEnvironmentVariable,
        read: () => {
          reads += 1;
          return credential;
        }
      })
    );
    expect(reads).toBe(0);
  });

  it("never carries credential material through source failures or endpoint errors", () => {
    const sourceFailure = captureAdapterError(() =>
      resolveCodexEndpointConnection(windowsEndpoint, "windows-x64", {
        kind: "protected_environment",
        environment_variable: codexRemoteAuthEnvironmentVariable,
        read: () => {
          throw new Error(`reader failed with ${credential}`);
        }
      })
    );
    const endpointFailure = captureAdapterError(() =>
      parseCodexLocalEndpoint({
        ...windowsEndpoint,
        address: `ws://127.0.0.1:43871/${credential}`
      })
    );

    assertErrorDoesNotContain(sourceFailure, credential);
    assertErrorDoesNotContain(endpointFailure, credential);
    expect(sourceFailure.cause).toBeUndefined();
    expect(endpointFailure.cause).toBeUndefined();
  });
});

function expectAdapterError(fn: () => unknown): void {
  const error = captureAdapterError(fn);
  expect(error.code).toBe("invalid_transport_config");
  expect(error.outcome).toBe("not_sent");
  expect(error.retry_safe).toBe(true);
}

function captureAdapterError(fn: () => unknown): HostDeckCodexAdapterError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckCodexAdapterError);
    return error as HostDeckCodexAdapterError;
  }
  throw new Error("Expected HostDeckCodexAdapterError.");
}

function assertErrorDoesNotContain(
  error: HostDeckCodexAdapterError,
  forbidden: string
): void {
  expect(error.message).not.toContain(forbidden);
  expect(error.stack ?? "").not.toContain(forbidden);
  expect(JSON.stringify(error)).not.toContain(forbidden);
}
