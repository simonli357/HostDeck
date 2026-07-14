import {
  defaultResourceBudget,
  type RemoteIngressObservationSnapshot,
  type RemoteServeDescriptor,
  remoteIngressObservationSnapshotSchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import {
  HostDeckTailscaleObserverError,
  type TailscaleObserver,
  tailscaleExecutablePath,
  tailscaleObserverEnvironment
} from "./tailscale-observer.js";
import {
  createRealTailscaleServeCommandRunner,
  createTailscaleServeManager,
  HostDeckTailscaleServeManagerError,
  type TailscaleServeCommandRequest,
  type TailscaleServeCommandResult,
  type TailscaleServeCommandRunner
} from "./tailscale-serve-manager.js";

const observedAt = "2026-07-13T21:00:00.000Z";
const expectedProfileKey = `sha256:${"a".repeat(64)}`;
const otherProfileKey = `sha256:${"b".repeat(64)}`;
const expectedServe: RemoteServeDescriptor = Object.freeze({
  external_origin: "https://hostdeck.example.ts.net",
  https_port: 443,
  path: "/",
  proxy_origin: "http://127.0.0.1:3777",
  visibility: "private"
});
const successfulCommand: TailscaleServeCommandResult = Object.freeze({
  completion: "succeeded",
  consent_required: false,
  permission_denied: false
});

describe("ownership-safe Tailscale Serve manager", () => {
  it("enables only from absent state with one exact bounded command and authoritative read-back", async () => {
    const harness = createHarness([dedicated("absent"), dedicated("exact")]);
    const result = await harness.manager.enable(input());

    expect(result).toEqual({
      action: "enable",
      outcome: "succeeded",
      serve_result: "applied",
      reason: null,
      command_attempted: true,
      before: dedicated("absent"),
      after: dedicated("exact")
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.before)).toBe(true);
    expect(Object.isFrozen(result.after)).toBe(true);
    expect(harness.observer.inputs).toEqual([input(), input()]);
    expect(harness.runner.requests).toHaveLength(1);
    expect(harness.runner.requests[0]).toMatchObject({
      command: "enable",
      executable: tailscaleExecutablePath,
      args: ["serve", "--bg", expectedServe.proxy_origin],
      cwd: "/",
      environment: tailscaleObserverEnvironment,
      timeout_ms: defaultResourceBudget.remote_observer_command_timeout_ms,
      output_max_bytes: defaultResourceBudget.remote_observer_output_max_bytes,
      signal: harness.controller.signal
    });
    expect(harness.manager.snapshot()).toEqual({
      active: false,
      busy_rejections: 0,
      command_attempts: 1,
      failed_operations: 0,
      incomplete_operations: 0,
      rejected_operations: 0,
      started_operations: 1,
      succeeded_operations: 1
    });
  });

  it("disables only an exact descriptor with the frozen path-scoped off command", async () => {
    const harness = createHarness([dedicated("exact"), dedicated("absent")]);
    await expect(harness.manager.disable(input())).resolves.toMatchObject({
      action: "disable",
      outcome: "succeeded",
      serve_result: "removed",
      reason: null
    });
    expect(harness.runner.requests.map((request) => request.args)).toEqual([
      ["serve", "--https=443", "--set-path=/", "off"]
    ]);
  });

  it.each([
    ["enable", "exact"],
    ["disable", "absent"]
  ] as const)("treats %s from %s as proven unchanged without a command", async (action, serve) => {
    const harness = createHarness([dedicated(serve)]);
    const result = await harness.manager[action](input());
    expect(result).toMatchObject({
      outcome: "succeeded",
      serve_result: "unchanged",
      reason: null,
      command_attempted: false
    });
    expect(result.after).toEqual(result.before);
    expect(harness.runner.requests).toHaveLength(0);
    expect(harness.observer.inputs).toHaveLength(1);
  });

  it.each([
    [clientFailure("not_installed"), "client_not_installed"],
    [clientFailure("unsupported"), "client_unsupported"],
    [clientFailure("error", "command_timeout"), "command_timeout"],
    [stopped(), "client_stopped"],
    [signedOut(), "client_signed_out"],
    [otherProfile(), "profile_other"],
    [unknownProfile(), "profile_unknown"],
    [dedicated("foreign"), "serve_foreign"],
    [dedicated("colliding"), "serve_colliding"],
    [dedicated("drifted"), "serve_drifted"],
    [dedicated("public"), "serve_public"],
    [dedicated("absent", "https://different.example.ts.net"), "external_origin_invalid"]
  ] as const)("rejects incompatible preflight state as %s without mutation", async (before, reason) => {
    const harness = createHarness([before]);
    await expect(harness.manager.enable(input())).resolves.toMatchObject({
      outcome: "rejected",
      serve_result: "not_attempted",
      reason,
      command_attempted: false,
      after: null
    });
    expect(harness.runner.requests).toHaveLength(0);
  });

  it.each([
    [
      { completion: "command_timeout", consent_required: true, permission_denied: false },
      "enable",
      "absent",
      "consent_required"
    ],
    [
      { completion: "command_failed", consent_required: false, permission_denied: true },
      "enable",
      "absent",
      "permission_denied"
    ],
    [
      { completion: "command_timeout", consent_required: false, permission_denied: false },
      "enable",
      "absent",
      "command_timeout"
    ],
    [
      { completion: "output_oversized", consent_required: false, permission_denied: false },
      "disable",
      "exact",
      "output_oversized"
    ],
    [
      { completion: "aborted", consent_required: false, permission_denied: false },
      "disable",
      "exact",
      "operation_aborted"
    ],
    [successfulCommand, "enable", "absent", "command_failed"]
  ] as const)(
    "maps an unchanged post-read to bounded failure %s",
    async (command, action, serve, reason) => {
      const harness = createHarness([dedicated(serve), dedicated(serve)], [command]);
      await expect(harness.manager[action](input())).resolves.toMatchObject({
        outcome: "failed",
        serve_result: "unchanged",
        reason,
        command_attempted: true
      });
      expect(harness.runner.requests).toHaveLength(1);
    }
  );

  it("lets the aggregate output bound outrank untrusted consent or permission markers", async () => {
    const harness = createHarness(
      [dedicated("absent"), dedicated("absent")],
      [{ completion: "output_oversized", consent_required: true, permission_denied: true }]
    );
    await expect(harness.manager.enable(input())).resolves.toMatchObject({
      outcome: "failed",
      serve_result: "unchanged",
      reason: "output_oversized"
    });
  });

  it("lets exact read-back prove success after a nonzero command or runner throw", async () => {
    const nonzero = createHarness(
      [dedicated("absent"), dedicated("exact")],
      [{ completion: "command_failed", consent_required: false, permission_denied: false }]
    );
    await expect(nonzero.manager.enable(input())).resolves.toMatchObject({
      outcome: "succeeded",
      serve_result: "applied",
      reason: null
    });

    const thrown = createHarness([dedicated("exact"), dedicated("absent")], [new Error("private raw sentinel")]);
    await expect(thrown.manager.disable(input())).resolves.toMatchObject({
      outcome: "succeeded",
      serve_result: "removed",
      reason: null
    });
  });

  it.each([
    [otherProfile(), "profile_changed"],
    [stopped(), "client_stopped"],
    [signedOut(), "client_signed_out"],
    [dedicated("foreign"), "serve_foreign"],
    [dedicated("colliding"), "serve_colliding"],
    [dedicated("drifted"), "serve_drifted"],
    [dedicated("public"), "serve_public"],
    [clientFailure("unsupported"), "client_unsupported"],
    [clientFailure("error", "schema_invalid"), "schema_invalid"]
  ] as const)("reports post-dispatch ambiguity as incomplete %s without compensation", async (after, reason) => {
    const harness = createHarness([dedicated("absent"), after]);
    await expect(harness.manager.enable(input())).resolves.toMatchObject({
      outcome: "incomplete",
      serve_result: "unknown",
      reason,
      command_attempted: true
    });
    expect(harness.runner.requests).toHaveLength(1);
    expect(harness.observer.inputs).toHaveLength(2);
  });

  it.each([
    new HostDeckTailscaleObserverError("observation_busy"),
    new Error("private raw post-observation sentinel"),
    {} as RemoteIngressObservationSnapshot
  ])("reports unavailable post-command observation without retaining raw failure %s", async (failure) => {
    const harness = createHarness([dedicated("absent"), failure]);
    const result = await harness.manager.enable(input());
    expect(result).toMatchObject({
      outcome: "incomplete",
      serve_result: "unknown",
      reason: "observation_failed",
      after: null
    });
    expect(JSON.stringify(result)).not.toMatch(/observation_busy|private raw|sentinel/u);
  });

  it("preserves cancellation truth when the lifecycle aborts during authoritative read-back", async () => {
    const controller = new AbortController();
    const observer = scriptedObserver([
      dedicated("absent"),
      () => {
        controller.abort();
        throw new HostDeckTailscaleObserverError("aborted");
      }
    ]);
    const manager = createTailscaleServeManager({
      observer: observer.observer,
      runner: fakeRunner([successfulCommand]).runner,
      signal: controller.signal
    });
    await expect(manager.enable(input())).resolves.toMatchObject({
      outcome: "incomplete",
      serve_result: "unknown",
      reason: "operation_aborted",
      after: null
    });
  });

  it.each([
    new HostDeckTailscaleObserverError("observation_busy"),
    new Error("private raw preflight sentinel"),
    {} as RemoteIngressObservationSnapshot
  ])("normalizes preflight observer failure without dispatch or raw retention %s", async (failure) => {
    const harness = createHarness([failure]);
    let thrown: unknown;
    try {
      await harness.manager.enable(input());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toEqual(new HostDeckTailscaleServeManagerError("preflight_failed", "not_started"));
    expect(JSON.stringify(thrown)).not.toMatch(/observation_busy|private raw|sentinel/u);
    expect(harness.runner.requests).toHaveLength(0);
  });

  it("uses one lifecycle signal and preserves unknown outcome when abort follows dispatch", async () => {
    const controller = new AbortController();
    const observer = scriptedObserver([dedicated("absent")]);
    const runner = fakeRunner([
      async (request) => {
        expect(request.signal).toBe(controller.signal);
        controller.abort();
        return { completion: "aborted", consent_required: false, permission_denied: false };
      }
    ]);
    const manager = createTailscaleServeManager({
      observer: observer.observer,
      runner: runner.runner,
      signal: controller.signal
    });
    await expect(manager.enable(input())).resolves.toMatchObject({
      outcome: "incomplete",
      serve_result: "unknown",
      reason: "operation_aborted",
      after: null
    });
    expect(observer.inputs).toHaveLength(1);

    const preAborted = new AbortController();
    preAborted.abort();
    const untouched = fakeRunner([]);
    const abortedManager = createTailscaleServeManager({
      observer: scriptedObserver([dedicated("absent")]).observer,
      runner: untouched.runner,
      signal: preAborted.signal
    });
    await expect(abortedManager.enable(input())).rejects.toEqual(
      new HostDeckTailscaleServeManagerError("aborted", "not_started")
    );
    expect(untouched.requests).toHaveLength(0);
  });

  it("rejects overlapping operations without queuing or starting another observation", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observer = scriptedObserver([
      async () => {
        await gate;
        return dedicated("exact");
      }
    ]);
    const manager = createTailscaleServeManager({
      observer: observer.observer,
      runner: fakeRunner([]).runner,
      signal: new AbortController().signal
    });
    const first = manager.enable(input());
    await Promise.resolve();
    await expect(manager.disable(input())).rejects.toEqual(
      new HostDeckTailscaleServeManagerError("operation_busy", "not_started")
    );
    expect(observer.inputs).toHaveLength(1);
    expect(manager.snapshot()).toMatchObject({ active: true, busy_rejections: 1, started_operations: 1 });
    release?.();
    await expect(first).resolves.toMatchObject({ outcome: "succeeded", serve_result: "unchanged" });
  });

  it("allows repeated explicit operations while running only necessary mutations", async () => {
    const observer = scriptedObserver([
      dedicated("absent"),
      dedicated("exact"),
      dedicated("exact"),
      dedicated("exact"),
      dedicated("absent"),
      dedicated("absent")
    ]);
    const runner = fakeRunner([successfulCommand, successfulCommand]);
    const manager = createTailscaleServeManager({
      observer: observer.observer,
      runner: runner.runner,
      signal: new AbortController().signal
    });
    await expect(manager.enable(input())).resolves.toMatchObject({ serve_result: "applied" });
    await expect(manager.enable(input())).resolves.toMatchObject({ serve_result: "unchanged" });
    await expect(manager.disable(input())).resolves.toMatchObject({ serve_result: "removed" });
    await expect(manager.disable(input())).resolves.toMatchObject({ serve_result: "unchanged" });
    expect(runner.requests.map((request) => request.command)).toEqual(["enable", "disable"]);
    expect(manager.snapshot()).toMatchObject({ started_operations: 4, succeeded_operations: 4, command_attempts: 2 });
  });

  it("rejects hostile inputs and runner results without invoking accessors or leaking raw values", async () => {
    let getterCalls = 0;
    const hostileInput = Object.defineProperty(
      { expected_profile_key: expectedProfileKey },
      "expected_serve",
      {
        enumerable: true,
        get() {
          getterCalls += 1;
          return expectedServe;
        }
      }
    );
    const harness = createHarness([dedicated("absent")]);
    expect(() => harness.manager.enable(hostileInput as never)).toThrow(
      "Tailscale Serve mutation input is invalid."
    );

    const hostileResult = Object.defineProperty(
      { completion: "succeeded", consent_required: false },
      "permission_denied",
      {
        enumerable: true,
        get() {
          getterCalls += 1;
          return false;
        }
      }
    );
    const hostile = createHarness(
      [dedicated("absent"), dedicated("absent")],
      [hostileResult as TailscaleServeCommandResult]
    );
    const result = await hostile.manager.enable(input());
    expect(result).toMatchObject({ outcome: "failed", reason: "schema_invalid" });
    expect(getterCalls).toBe(0);
    expect(JSON.stringify(result)).not.toContain("raw");
  });

  it("makes reset, Funnel, profile, and broad mutation argv impossible in the real runner", async () => {
    const runner = createRealTailscaleServeCommandRunner();
    const controller = new AbortController();
    for (const args of [
      ["serve", "reset"],
      ["funnel", "--bg", expectedServe.proxy_origin],
      ["switch", "other"],
      ["down"]
    ]) {
      await expect(
        runner.run({
          command: "enable",
          executable: tailscaleExecutablePath,
          args,
          cwd: "/",
          environment: tailscaleObserverEnvironment,
          timeout_ms: 1_000,
          output_max_bytes: 4_096,
          signal: controller.signal
        })
      ).rejects.toThrow("Tailscale Serve command request is invalid.");
    }
  });

  it("returns a bounded no-process result for a pre-aborted exact real-runner request", async () => {
    const runner = createRealTailscaleServeCommandRunner();
    const controller = new AbortController();
    controller.abort();
    await expect(
      runner.run({
        command: "enable",
        executable: tailscaleExecutablePath,
        args: ["serve", "--bg", expectedServe.proxy_origin],
        cwd: "/",
        environment: tailscaleObserverEnvironment,
        timeout_ms: defaultResourceBudget.remote_observer_command_timeout_ms,
        output_max_bytes: defaultResourceBudget.remote_observer_output_max_bytes,
        signal: controller.signal
      })
    ).resolves.toEqual({ completion: "aborted", consent_required: false, permission_denied: false });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(process.getActiveResourcesInfo()).not.toContain("ChildProcess");
  });

  it("constructs no command or observation side effect and validates exact options", () => {
    const observer = scriptedObserver([]);
    const runner = fakeRunner([]);
    const manager = createTailscaleServeManager({
      observer: observer.observer,
      runner: runner.runner,
      signal: new AbortController().signal
    });
    expect(manager.snapshot()).toMatchObject({ active: false, started_operations: 0, command_attempts: 0 });
    expect(observer.inputs).toHaveLength(0);
    expect(runner.requests).toHaveLength(0);
    expect(() => createTailscaleServeManager({ observer: observer.observer } as never)).toThrow(
      "Tailscale Serve manager requires one AbortSignal."
    );
    expect(() =>
      createTailscaleServeManager({
        observer: observer.observer,
        signal: new AbortController().signal,
        future: true
      } as never)
    ).toThrow("Expected one data object.");
  });
});

function input() {
  return {
    expected_profile_key: expectedProfileKey,
    expected_serve: expectedServe
  };
}

function dedicated(
  serve: "absent" | "exact" | "foreign" | "colliding" | "drifted" | "public",
  externalOrigin = expectedServe.external_origin
): RemoteIngressObservationSnapshot {
  return snapshot({
    schema_version: 1,
    client: "available",
    profile: {
      state: "dedicated",
      comparison: {
        relation: "match",
        expected_profile_key: expectedProfileKey,
        active_profile_key: expectedProfileKey
      }
    },
    serve,
    external_origin: externalOrigin,
    failure: null,
    observed_at: observedAt
  });
}

function stopped(): RemoteIngressObservationSnapshot {
  return snapshot({
    ...dedicated("absent"),
    profile: {
      state: "stopped",
      comparison: {
        relation: "match",
        expected_profile_key: expectedProfileKey,
        active_profile_key: expectedProfileKey
      }
    }
  });
}

function signedOut(): RemoteIngressObservationSnapshot {
  return unknownState("signed_out");
}

function unknownProfile(): RemoteIngressObservationSnapshot {
  return unknownState("unknown");
}

function unknownState(state: "signed_out" | "unknown"): RemoteIngressObservationSnapshot {
  return snapshot({
    schema_version: 1,
    client: "available",
    profile: {
      state,
      comparison: {
        relation: "unknown",
        expected_profile_key: expectedProfileKey,
        active_profile_key: null
      }
    },
    serve: null,
    external_origin: null,
    failure: null,
    observed_at: observedAt
  });
}

function otherProfile(): RemoteIngressObservationSnapshot {
  return snapshot({
    schema_version: 1,
    client: "available",
    profile: {
      state: "other",
      comparison: {
        relation: "different",
        expected_profile_key: expectedProfileKey,
        active_profile_key: otherProfileKey
      }
    },
    serve: null,
    external_origin: null,
    failure: null,
    observed_at: observedAt
  });
}

function clientFailure(
  client: "not_installed" | "unsupported" | "error",
  failure: "command_timeout" | "schema_invalid" | null = null
): RemoteIngressObservationSnapshot {
  const absent = client === "not_installed";
  return snapshot({
    schema_version: 1,
    client,
    profile: {
      state: absent ? "absent" : "unknown",
      comparison: {
        relation: absent ? "missing" : "unknown",
        expected_profile_key: expectedProfileKey,
        active_profile_key: null
      }
    },
    serve: null,
    external_origin: null,
    failure: client === "error" ? (failure ?? "schema_invalid") : null,
    observed_at: observedAt
  });
}

function snapshot(value: unknown): RemoteIngressObservationSnapshot {
  return remoteIngressObservationSnapshotSchema.parse(value);
}

type ObserverReply =
  | RemoteIngressObservationSnapshot
  | Error
  | (() => RemoteIngressObservationSnapshot | Promise<RemoteIngressObservationSnapshot>);

function scriptedObserver(replies: ObserverReply[]) {
  const inputs: unknown[] = [];
  let next = 0;
  const observer: TailscaleObserver = Object.freeze({
    poll_interval_ms: 10_000,
    observeCandidate: async () => {
      throw new TypeError("Candidate observation is not owned by this test.");
    },
    async observeConfigured(value: Parameters<TailscaleObserver["observeConfigured"]>[0]) {
      inputs.push(value);
      const reply = replies[next++];
      if (reply === undefined) throw new TypeError("Unexpected configured observation.");
      if (reply instanceof Error) throw reply;
      return typeof reply === "function" ? reply() : reply;
    }
  });
  return { inputs, observer };
}

type RunnerReply =
  | TailscaleServeCommandResult
  | Error
  | ((request: TailscaleServeCommandRequest) => TailscaleServeCommandResult | Promise<TailscaleServeCommandResult>);

function fakeRunner(replies: RunnerReply[]) {
  const requests: TailscaleServeCommandRequest[] = [];
  let next = 0;
  const runner: TailscaleServeCommandRunner = Object.freeze({
    async run(request: TailscaleServeCommandRequest) {
      requests.push(request);
      const reply = replies[next++] ?? successfulCommand;
      if (reply instanceof Error) throw reply;
      return typeof reply === "function" ? reply(request) : reply;
    }
  });
  return { requests, runner };
}

function createHarness(observations: ObserverReply[], commands: RunnerReply[] = [successfulCommand]) {
  const controller = new AbortController();
  const observer = scriptedObserver(observations);
  const runner = fakeRunner(commands);
  const manager = createTailscaleServeManager({
    observer: observer.observer,
    runner: runner.runner,
    signal: controller.signal
  });
  return { controller, manager, observer, runner };
}
