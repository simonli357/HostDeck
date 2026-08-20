import { realpathSync } from "node:fs";
import { join } from "node:path";
import {
  type SharedCodexEndpoint,
  sharedCodexEndpointSchema,
  sharedCodexRuntimeVersion
} from "@hostdeck/contracts";
import {
  HostDeckSharedCodexBrokerError,
  type SharedCodexBrokerAttachment
} from "@hostdeck/server";
import { describe, expect, it, vi } from "vitest";
import {
  formatBrokerHostFailure,
  runHostDeckBrokerHost
} from "./broker-host.js";

describe("IFC-V1-113 shared Codex broker service host", () => {
  it("stops a broker it owns when the service is stopped", async () => {
    const controller = new AbortController();
    const startBroker = vi.fn(async () => attachment("owned", 7));
    const stopBroker = vi.fn(async () => absentEndpoint());
    const output: string[] = [];

    await expect(
      runHostDeckBrokerHost([], {
        ...baseOptions(controller.signal),
        sleep: async () => {
          controller.abort(new Error("stop"));
        },
        startBroker,
        stopBroker,
        writeReady: (value) => output.push(value)
      })
    ).resolves.toBe("");

    expect(output).toEqual(["HostDeck Codex broker ready (owned).\n"]);
    expect(startBroker).toHaveBeenCalledOnce();
    expect(stopBroker).toHaveBeenCalledOnce();
  });

  it("never stops an external broker when its service wrapper exits", async () => {
    const controller = new AbortController();
    const stopBroker = vi.fn(async () => absentEndpoint());

    await runHostDeckBrokerHost([], {
      ...baseOptions(controller.signal),
      sleep: async () => {
        controller.abort(new Error("stop"));
      },
      startBroker: vi.fn(async () => attachment("attached", 3)),
      stopBroker
    });

    expect(stopBroker).not.toHaveBeenCalled();
  });

  it("cleans proven stale ownership and fails for systemd restart after a crash", async () => {
    const startBroker = vi
      .fn()
      .mockResolvedValueOnce(attachment("owned", 11))
      .mockRejectedValueOnce(brokerError("ownership_ambiguous"));
    const stopBroker = vi.fn(async () => absentEndpoint());

    await expect(
      runHostDeckBrokerHost([], {
        ...baseOptions(new AbortController().signal),
        sleep: async () => undefined,
        startBroker,
        stopBroker
      })
    ).rejects.toThrow("stopped unexpectedly");
    expect(stopBroker).toHaveBeenCalledOnce();
  });

  it("clears proven stale ownership before starting after a supervisor restart", async () => {
    const controller = new AbortController();
    const startBroker = vi
      .fn()
      .mockRejectedValueOnce(brokerError("ownership_ambiguous"))
      .mockResolvedValueOnce(attachment("owned", 12));
    const stopBroker = vi.fn(async () => absentEndpoint());

    await runHostDeckBrokerHost([], {
      ...baseOptions(controller.signal),
      sleep: async () => {
        controller.abort(new Error("stop"));
      },
      startBroker,
      stopBroker
    });

    expect(startBroker).toHaveBeenCalledTimes(2);
    expect(stopBroker).toHaveBeenCalledTimes(2);
  });

  it("restarts supervision when an attached external broker disappears", async () => {
    const startBroker = vi
      .fn()
      .mockResolvedValueOnce(attachment("attached", 4))
      .mockRejectedValueOnce(brokerError("broker_absent"));
    const stopBroker = vi.fn(async () => absentEndpoint());

    await expect(
      runHostDeckBrokerHost([], {
        ...baseOptions(new AbortController().signal),
        sleep: async () => undefined,
        startBroker,
        stopBroker
      })
    ).rejects.toMatchObject({ code: "broker_absent" });
    expect(stopBroker).not.toHaveBeenCalled();
  });

  it("treats an explicit owner-safe broker stop as a clean non-restarting exit", async () => {
    const startBroker = vi
      .fn()
      .mockResolvedValueOnce(attachment("owned", 11))
      .mockRejectedValueOnce(brokerError("broker_absent"));
    const stopBroker = vi.fn(async () => {
      throw brokerError("broker_not_owned");
    });

    await expect(
      runHostDeckBrokerHost([], {
        ...baseOptions(new AbortController().signal),
        sleep: async () => undefined,
        startBroker,
        stopBroker
      })
    ).resolves.toBe("HostDeck Codex broker ready (owned).\n");
    expect(stopBroker).toHaveBeenCalledOnce();
  });

  it("treats cancellation during a supervision probe as a clean service stop", async () => {
    const controller = new AbortController();
    const startBroker = vi
      .fn()
      .mockResolvedValueOnce(attachment("owned", 11))
      .mockImplementationOnce(async () => {
        controller.abort(new Error("stop"));
        throw brokerError("aborted");
      });
    const stopBroker = vi.fn(async () => absentEndpoint());

    await expect(
      runHostDeckBrokerHost([], {
        ...baseOptions(controller.signal),
        sleep: async () => undefined,
        startBroker,
        stopBroker
      })
    ).resolves.toBe("HostDeck Codex broker ready (owned).\n");
    expect(startBroker).toHaveBeenCalledTimes(2);
    expect(stopBroker).toHaveBeenCalledOnce();
  });

  it("waits boundedly for broker readiness before the dependent unit starts", async () => {
    const startBroker = vi
      .fn()
      .mockRejectedValueOnce(brokerError("broker_absent"))
      .mockRejectedValueOnce(brokerError("ownership_ambiguous"))
      .mockRejectedValueOnce(brokerError("socket_stale"))
      .mockRejectedValueOnce(brokerError("socket_changed"))
      .mockResolvedValueOnce(attachment("attached", 2));
    const sleep = vi.fn(async () => undefined);

    await expect(
      runHostDeckBrokerHost(["--check-ready"], {
        ...baseOptions(new AbortController().signal),
        sleep,
        startBroker
      })
    ).resolves.toBe("");
    expect(startBroker).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledTimes(4);
  });

  it("fails closed for version drift and invalid internal arguments", async () => {
    await expect(
      runHostDeckBrokerHost([], {
        ...baseOptions(new AbortController().signal),
        probeVersion: async () => "0.149.0"
      })
    ).rejects.toThrow("unsupported");
    await expect(
      runHostDeckBrokerHost(["--unknown"], baseOptions(new AbortController().signal))
    ).rejects.toThrow("arguments");
  });

  it("reports only bounded lifecycle classification on service failure", () => {
    expect(formatBrokerHostFailure(brokerError("ownership_ambiguous"))).toBe(
      "HostDeck Codex broker service failed (ownership_ambiguous/readiness).\n"
    );
    expect(formatBrokerHostFailure(new Error("secret /private/path"))).toBe(
      "HostDeck Codex broker service failed.\n"
    );
  });
});

function baseOptions(signal: AbortSignal) {
  return {
    env: {
      CODEX_HOME: join(process.cwd(), ".broker-host-test-codex"),
      HOSTDECK_CODEX_BIN: realpathSync.native(process.execPath)
    },
    poll_interval_ms: 50,
    probeVersion: async () => sharedCodexRuntimeVersion,
    signal
  } as const;
}

function attachment(
  ownership: "attached" | "owned",
  generation: number
): SharedCodexBrokerAttachment {
  let closed = false;
  return Object.freeze({
    get closed() {
      return closed;
    },
    async close() {
      closed = true;
    },
    endpoint: sharedCodexEndpointSchema.parse({
      generation,
      kind: "standard_unix",
      observed_version: sharedCodexRuntimeVersion,
      ownership,
      reason: null,
      state: "ready"
    }),
    location: {
      codex_home: "/tmp/hostdeck-broker-host-test",
      kind: "standard_unix" as const,
      socket_path:
        "/tmp/hostdeck-broker-host-test/app-server-control/app-server-control.sock"
    }
  });
}

function absentEndpoint(): SharedCodexEndpoint {
  return sharedCodexEndpointSchema.parse({
    generation: 0,
    kind: "standard_unix",
    observed_version: null,
    ownership: "none",
    reason: null,
    state: "absent"
  });
}

function brokerError(
  code:
    | "aborted"
    | "broker_absent"
    | "broker_not_owned"
    | "ownership_ambiguous"
    | "socket_changed"
    | "socket_stale"
): HostDeckSharedCodexBrokerError {
  return new HostDeckSharedCodexBrokerError(
    code,
    code === "broker_not_owned" ? "stop" : "readiness",
    "Broker fixture failure.",
    absentEndpoint()
  );
}
