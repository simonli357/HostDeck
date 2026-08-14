import { describe, expect, it, vi } from "vitest";
import {
  HostDeckSharedCodexBrokerError,
  resolveSharedCodexEndpointLocation,
  type SharedCodexBrokerHostObservation,
  type SharedCodexBrokerHostPort,
  type SharedCodexBrokerHostSession,
  startSharedCodexBroker,
  stopOwnedSharedCodexBroker
} from "./shared-codex-broker-lifecycle.js";

const location = Object.freeze({
  kind: "standard_unix" as const,
  codex_home: "/home/selected/.codex",
  socket_path:
    "/home/selected/.codex/app-server-control/app-server-control.sock"
});

const attached = active("attached", "7:11", 31);
const owned = active("owned", "7:12", 32);

describe("shared Codex broker lifecycle", () => {
  it("resolves the configured or default standard endpoint without path rewriting", () => {
    expect(
      resolveSharedCodexEndpointLocation({
        home_directory: "/home/selected"
      })
    ).toEqual(location);
    expect(
      resolveSharedCodexEndpointLocation({
        home_directory: "/home/selected",
        codex_home: "/srv/codex-state"
      })
    ).toEqual({
      kind: "standard_unix",
      codex_home: "/srv/codex-state",
      socket_path:
        "/srv/codex-state/app-server-control/app-server-control.sock"
    });
    expect(() =>
      resolveSharedCodexEndpointLocation({
        home_directory: "/home/selected/../selected"
      })
    ).toThrow(HostDeckSharedCodexBrokerError);
  });

  it("attaches to one active compatible broker and close never stops it", async () => {
    const fixture = hostFixture([attached, attached]);
    const compatibilityProbe = vi.fn(async () => undefined);
    const attachment = await startSharedCodexBroker(startInput("attach_only"), {
      host: fixture.host,
      compatibilityProbe
    });

    expect(attachment.endpoint).toEqual({
      kind: "standard_unix",
      state: "ready",
      ownership: "attached",
      generation: 31,
      observed_version: "0.147.0",
      reason: null
    });
    expect(fixture.openInputs).toEqual([
      expect.objectContaining({
        access: "observe_only",
        create_control_directory: false
      })
    ]);
    expect(fixture.start).not.toHaveBeenCalled();
    expect(fixture.stopOwned).not.toHaveBeenCalled();
    expect(attachment.closed).toBe(false);
    await attachment.close();
    await attachment.close();
    expect(attachment.closed).toBe(true);
    expect(fixture.stopOwned).not.toHaveBeenCalled();
    expect(compatibilityProbe).toHaveBeenCalledOnce();
  });

  it("starts once only after an exclusive absent observation", async () => {
    const fixture = hostFixture([
      Object.freeze({ state: "absent" }),
      owned
    ], owned);
    const attachment = await startSharedCodexBroker(
      startInput("attach_or_start"),
      {
        host: fixture.host,
        compatibilityProbe: async () => undefined
      }
    );

    expect(fixture.openInputs[0]).toEqual(
      expect.objectContaining({
        access: "exclusive",
        create_control_directory: true
      })
    );
    expect(fixture.start).toHaveBeenCalledOnce();
    expect(attachment.endpoint.ownership).toBe("owned");
  });

  it("does not create or start anything in attach-only mode", async () => {
    const fixture = hostFixture([Object.freeze({ state: "absent" })]);
    await expectBrokerError(
      startSharedCodexBroker(startInput("attach_only"), {
        host: fixture.host,
        compatibilityProbe: async () => undefined
      }),
      "broker_absent"
    );
    expect(fixture.start).not.toHaveBeenCalled();
    expect(fixture.openInputs[0]).toEqual(
      expect.objectContaining({ create_control_directory: false })
    );
  });

  it("preserves the primary failure when coordination cleanup also fails", async () => {
    const fixture = hostFixture(
      [Object.freeze({ state: "absent" })],
      owned,
      new Error("release failed")
    );
    let failure: unknown;
    try {
      await startSharedCodexBroker(startInput("attach_only"), {
        host: fixture.host,
        compatibilityProbe: async () => undefined
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "broker_absent",
      cause: expect.any(AggregateError)
    });
  });

  it("reports active protocol rejection as incompatible without stopping", async () => {
    const fixture = hostFixture([attached]);
    let failure: unknown;
    try {
      await startSharedCodexBroker(startInput("attach_only"), {
        host: fixture.host,
        compatibilityProbe: async () => {
          throw new Error("protocol mismatch with /private/path");
        }
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(HostDeckSharedCodexBrokerError);
    expect(failure).toMatchObject({
      code: "broker_incompatible",
      stage: "compatibility",
      endpoint: {
        state: "incompatible",
        ownership: "attached",
        reason: "Shared broker compatibility failed."
      }
    });
    expect((failure as Error).message).not.toContain("/private/path");
    expect(fixture.stopOwned).not.toHaveBeenCalled();
  });

  it("rejects a socket replacement across compatibility admission", async () => {
    const fixture = hostFixture([
      attached,
      active("attached", "7:99", 99)
    ]);
    await expectBrokerError(
      startSharedCodexBroker(startInput("attach_only"), {
        host: fixture.host,
        compatibilityProbe: async () => undefined
      }),
      "socket_changed"
    );
  });

  it("requires exact reviewed version before touching the host", async () => {
    const fixture = hostFixture([attached]);
    await expectBrokerError(
      startSharedCodexBroker(
        { ...startInput("attach_only"), observed_version: "0.146.0" },
        { host: fixture.host, compatibilityProbe: async () => undefined }
      ),
      "invalid_input"
    );
    expect(fixture.openInputs).toHaveLength(0);
  });

  it("routes explicit stop through exclusive proof-gated ownership", async () => {
    const fixture = hostFixture([]);
    await expect(
      stopOwnedSharedCodexBroker(
        {
          location,
          stop_timeout_ms: 1_000
        },
        { host: fixture.host }
      )
    ).resolves.toEqual({
      kind: "standard_unix",
      state: "absent",
      ownership: "none",
      generation: 0,
      observed_version: null,
      reason: null
    });
    expect(fixture.stopOwned).toHaveBeenCalledOnce();
    expect(fixture.openInputs[0]).toEqual(
      expect.objectContaining({
        access: "exclusive",
        create_control_directory: false
      })
    );
  });
});

function startInput(mode: "attach_only" | "attach_or_start") {
  return {
    codex_bin: "/opt/codex/bin/codex",
    location,
    mode,
    observed_version: "0.147.0",
    startup_timeout_ms: 1_000
  } as const;
}

function active(
  ownership: "attached" | "owned",
  socketIdentity: string,
  generation: number
): SharedCodexBrokerHostObservation {
  return Object.freeze({
    state: "active",
    ownership,
    socket_identity: socketIdentity,
    generation
  });
}

function hostFixture(
  inspections: readonly SharedCodexBrokerHostObservation[],
  started: SharedCodexBrokerHostObservation = owned,
  closeFailure?: Error
) {
  const pending = [...inspections];
  const start = vi.fn(async () => started);
  const stopOwned = vi.fn(async () => "stopped" as const);
  const openInputs: Array<
    Parameters<SharedCodexBrokerHostPort["open"]>[0]
  > = [];
  const host: SharedCodexBrokerHostPort = Object.freeze({
    async open(input: Parameters<SharedCodexBrokerHostPort["open"]>[0]) {
      openInputs.push(input);
      const session: SharedCodexBrokerHostSession = Object.freeze({
        access: input.access,
        async inspect() {
          const next = pending.shift();
          if (next === undefined) {
            throw new Error("Unexpected inspection.");
          }
          return next;
        },
        start,
        stopOwned,
        close: vi.fn(() => {
          if (closeFailure !== undefined) throw closeFailure;
        })
      });
      return session;
    }
  });
  return { host, openInputs, start, stopOwned };
}

async function expectBrokerError(
  promise: Promise<unknown>,
  code: HostDeckSharedCodexBrokerError["code"]
): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(HostDeckSharedCodexBrokerError);
  expect(failure).toMatchObject({ code });
}
