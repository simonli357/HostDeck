import { createHash } from "node:crypto";
import {
  defaultResourceBudget,
  type RemoteServeDescriptor,
  resolveResourceBudget
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import {
  createRealTailscaleReadCommandRunner,
  createTailscaleObserver,
  HostDeckTailscaleObserverError,
  HostDeckTailscaleReadCommandError,
  supportedTailscaleVersion,
  type TailscaleReadCommandName,
  type TailscaleReadCommandRequest,
  type TailscaleReadCommandRunner,
  tailscaleExecutablePath,
  tailscaleObserverEnvironment
} from "./tailscale-observer.js";

const observedAt = new Date("2026-07-13T19:00:00.000Z");
const rawIdentitySentinel = "raw-private-identity-sentinel";
const primaryProfile = Object.freeze({
  account: "operator@example.invalid",
  id: "profile-id-primary",
  nickname: "HostDeck",
  selected: true,
  tailnet: "example-tailnet"
});
const otherProfile = Object.freeze({
  account: "other@example.invalid",
  id: "profile-id-other",
  nickname: "Other",
  selected: true,
  tailnet: "other-tailnet"
});
const primaryProfileKey = comparisonKey(primaryProfile);
const expectedServe: RemoteServeDescriptor = Object.freeze({
  external_origin: "https://hostdeck.example.ts.net",
  https_port: 443,
  path: "/",
  proxy_origin: "http://127.0.0.1:3777",
  visibility: "private"
});
const exactServeStatus = Object.freeze({
  TCP: { "443": { HTTPS: true } },
  Web: {
    "hostdeck.example.ts.net:443": {
      Handlers: { "/": { Proxy: expectedServe.proxy_origin } }
    }
  }
});
const versionOutput = [
  supportedTailscaleVersion.short,
  `  tailscale commit: ${supportedTailscaleVersion.tailscale_commit}`,
  `  long version: ${supportedTailscaleVersion.long}`,
  `  other commit: ${supportedTailscaleVersion.other_commit}`,
  `  go version: ${supportedTailscaleVersion.go_version}`,
  ""
].join("\n");

interface SyntheticProfile {
  readonly account: string;
  readonly id: string;
  readonly nickname: string;
  readonly selected: boolean;
  readonly tailnet: string;
}

describe("bounded Tailscale observer", () => {
  it("projects one candidate profile without retaining raw identity and invokes only frozen reads", async () => {
    const harness = createHarness();
    const snapshot = await harness.observer.observeCandidate();

    expect(snapshot).toEqual({
      schema_version: 1,
      client: "available",
      profile: {
        state: "dedicated",
        comparison: {
          relation: "match",
          expected_profile_key: primaryProfileKey,
          active_profile_key: primaryProfileKey
        }
      },
      serve: "absent",
      external_origin: expectedServe.external_origin,
      failure: null,
      observed_at: observedAt.toISOString()
    });
    expect(harness.observer.poll_interval_ms).toBe(defaultResourceBudget.remote_observer_poll_interval_ms);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.profile)).toBe(true);
    expect(Object.isFrozen(snapshot.profile.comparison)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain(rawIdentitySentinel);
    expect(JSON.stringify(snapshot)).not.toContain(primaryProfile.account);
    expect(JSON.stringify(snapshot)).not.toContain(primaryProfile.id);

    expect(harness.fake.requests.map((request) => request.command)).toEqual([
      "version",
      "status",
      "profile_list",
      "serve_status",
      "funnel_status",
      "status",
      "profile_list"
    ]);
    expect(harness.fake.requests.map((request) => request.args)).toEqual([
      ["version"],
      ["status", "--json"],
      ["switch", "--list", "--json"],
      ["serve", "status", "--json"],
      ["funnel", "status", "--json"],
      ["status", "--json"],
      ["switch", "--list", "--json"]
    ]);
    for (const request of harness.fake.requests) {
      expect(request.executable).toBe(tailscaleExecutablePath);
      expect(request.cwd).toBe("/");
      expect(request.environment).toBe(tailscaleObserverEnvironment);
      expect(Object.keys(request.environment).sort()).toEqual(["LANG", "LC_ALL", "PATH", "TERM"]);
      expect(request.signal).toBe(harness.controller.signal);
      expect(request.timeout_ms).toBe(defaultResourceBudget.remote_observer_command_timeout_ms);
      expect(request.output_max_bytes).toBe(defaultResourceBudget.remote_observer_output_max_bytes);
      expect(request.args.join(" ")).not.toMatch(/\b(?:up|down|login|logout|reset|set|off)\b/u);
    }
  });

  it("classifies one configured exact private Serve mapping", async () => {
    const harness = createHarness({
      serve_status: () => exactServeStatus
    });
    await expect(
      harness.observer.observeConfigured({
        expected_profile_key: primaryProfileKey,
        expected_serve: expectedServe
      })
    ).resolves.toMatchObject({
      client: "available",
      profile: { state: "dedicated", comparison: { relation: "match" } },
      serve: "exact",
      external_origin: expectedServe.external_origin,
      failure: null
    });
  });

  it("keys signed-out and stopped truth on BackendState even when sensitive metadata remains", async () => {
    const stopped = createHarness({
      status: () => rawStatus(primaryProfile, { BackendState: "Stopped" })
    });
    await expect(stopped.observer.observeCandidate()).resolves.toMatchObject({
      client: "available",
      profile: { state: "stopped", comparison: { relation: "match" } },
      serve: "absent",
      failure: null
    });

    const signedOut = createHarness({
      status: () =>
        rawStatus(primaryProfile, {
          BackendState: "NeedsLogin",
          CertDomains: [],
          CurrentTailnet: null,
          HaveNodeKey: undefined
        })
    });
    const snapshot = await signedOut.observer.observeConfigured({
      expected_profile_key: primaryProfileKey,
      expected_serve: expectedServe
    });
    expect(snapshot).toMatchObject({
      client: "available",
      profile: {
        state: "signed_out",
        comparison: { relation: "unknown", expected_profile_key: primaryProfileKey, active_profile_key: null }
      },
      serve: null,
      external_origin: null,
      failure: null
    });
    expect(signedOut.fake.requests.map((request) => request.command)).toEqual(["version", "status"]);
    expect(JSON.stringify(snapshot)).not.toContain(rawIdentitySentinel);
  });

  it("reports another selected profile without reading that profile's Serve or Funnel state", async () => {
    const harness = createHarness({
      status: () => rawStatus(otherProfile),
      profile_list: () => [otherProfile, { ...primaryProfile, selected: false }]
    });
    const snapshot = await harness.observer.observeConfigured({
      expected_profile_key: primaryProfileKey,
      expected_serve: expectedServe
    });
    expect(snapshot).toMatchObject({
      client: "available",
      profile: {
        state: "other",
        comparison: { relation: "different", expected_profile_key: primaryProfileKey }
      },
      serve: null,
      external_origin: null,
      failure: null
    });
    expect(harness.fake.requests.map((request) => request.command)).toEqual([
      "version",
      "status",
      "profile_list",
      "status",
      "profile_list"
    ]);
  });

  it("accepts the exact stopped shape with nullable retained-status fields", async () => {
    const harness = createHarness({
      status: () =>
        rawStatus(otherProfile, {
          BackendState: "Stopped",
          CertDomains: null,
          CurrentTailnet: null,
          Peer: null,
          TailscaleIPs: null,
          User: null
        }),
      profile_list: () => [otherProfile, { ...primaryProfile, selected: false }]
    });
    await expect(
      harness.observer.observeConfigured({
        expected_profile_key: primaryProfileKey,
        expected_serve: expectedServe
      })
    ).resolves.toMatchObject({
      client: "available",
      profile: {
        state: "stopped",
        comparison: { relation: "different", expected_profile_key: primaryProfileKey }
      },
      serve: null,
      external_origin: null,
      failure: null
    });
    expect(harness.fake.requests.map((request) => request.command)).toEqual([
      "version",
      "status",
      "profile_list",
      "status",
      "profile_list"
    ]);
  });

  it.each([
    ["absent", {}, {}],
    ["exact", exactServeStatus, {}],
    [
      "colliding",
      {
        TCP: { "443": { HTTPS: true } },
        Web: {
          "hostdeck.example.ts.net:443": {
            Handlers: {
              "/": { Proxy: expectedServe.proxy_origin },
              "/foreign": { Proxy: "http://127.0.0.1:4999" }
            }
          }
        }
      },
      {}
    ],
    [
      "drifted",
      {
        TCP: { "443": { HTTPS: true } },
        Web: {
          "hostdeck.example.ts.net:443": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:3778" } }
          }
        }
      },
      {}
    ],
    ["foreign", { TCP: { "22": { TCPForward: "127.0.0.1:22" } } }, {}],
    ["public", exactServeStatus, { Web: { "public.example.invalid:443": {} } }]
  ] as const)("classifies %s Serve state", async (expectedState, serveStatus, funnelStatus) => {
    const harness = createHarness({
      serve_status: () => serveStatus,
      funnel_status: () => funnelStatus
    });
    await expect(
      harness.observer.observeConfigured({
        expected_profile_key: primaryProfileKey,
        expected_serve: expectedServe
      })
    ).resolves.toMatchObject({ serve: expectedState });
  });

  it("treats any AllowFunnel field as public instead of trusting its raw value", async () => {
    const harness = createHarness({
      serve_status: () => ({ ...exactServeStatus, AllowFunnel: false })
    });
    await expect(
      harness.observer.observeConfigured({
        expected_profile_key: primaryProfileKey,
        expected_serve: expectedServe
      })
    ).resolves.toMatchObject({ serve: "public" });
  });

  it("maps absent, unsupported, command, timeout, oversize, and schema failures without causes or raw output", async () => {
    const cases = [
      ["not_installed", "not_installed", null],
      ["command_failed", "error", "command_failed"],
      ["command_timeout", "error", "command_timeout"],
      ["output_oversized", "error", "output_oversized"],
      ["schema_invalid", "error", "schema_invalid"]
    ] as const;
    for (const [commandCode, client, failure] of cases) {
      const harness = createHarness({
        version: () => new HostDeckTailscaleReadCommandError(commandCode)
      });
      const snapshot = await harness.observer.observeConfigured({
        expected_profile_key: primaryProfileKey,
        expected_serve: expectedServe
      });
      expect(snapshot).toMatchObject({ client, failure });
      expect(snapshot.profile.state).toBe(commandCode === "not_installed" ? "absent" : "unknown");
      expect(JSON.stringify(snapshot)).not.toContain(rawIdentitySentinel);
    }

    const unsupported = createHarness({ version: () => "1.99.0\n" });
    await expect(
      unsupported.observer.observeConfigured({
        expected_profile_key: primaryProfileKey,
        expected_serve: expectedServe
      })
    ).resolves.toMatchObject({ client: "unsupported", failure: null, profile: { state: "unknown" } });

    const malformed = createHarness({ status: () => ({ ...rawStatus(primaryProfile), FutureField: true }) });
    await expect(malformed.observer.observeCandidate()).resolves.toMatchObject({
      client: "error",
      failure: "schema_invalid",
      profile: { state: "unknown" }
    });

    const daemonVersionDrift = createHarness({
      status: () => rawStatus(primaryProfile, { Version: "1.99.0-future" })
    });
    await expect(daemonVersionDrift.observer.observeCandidate()).resolves.toMatchObject({
      client: "unsupported",
      failure: null,
      profile: { state: "unknown" }
    });
    expect(daemonVersionDrift.fake.requests.map((request) => request.command)).toEqual(["version", "status"]);
  });

  it("enforces returned UTF-8 bytes even when an injected runner ignores the process cap", async () => {
    const budget = resolveResourceBudget({ remote_observer_output_max_bytes: 4_096 });
    const harness = createHarness(
      {
        version: () => "x".repeat(4_097)
      },
      budget
    );
    await expect(harness.observer.observeCandidate()).resolves.toMatchObject({
      client: "error",
      failure: "output_oversized",
      profile: { state: "unknown" }
    });
    expect(harness.fake.requests).toHaveLength(1);
  });

  it("rejects selected-profile ambiguity, status disagreement, profile-count overflow, and mid-cycle profile change", async () => {
    const ambiguous = createHarness({
      profile_list: () => [primaryProfile, { ...otherProfile, selected: true }]
    });
    await expect(ambiguous.observer.observeCandidate()).resolves.toMatchObject({
      client: "error",
      failure: "schema_invalid"
    });

    const noSelection = createHarness({
      profile_list: () => [{ ...primaryProfile, selected: false }, { ...otherProfile, selected: false }]
    });
    await expect(noSelection.observer.observeCandidate()).resolves.toMatchObject({
      client: "error",
      failure: "schema_invalid"
    });

    const duplicateIdentity = createHarness({
      profile_list: () => [primaryProfile, { ...primaryProfile, nickname: "Duplicate", selected: false }]
    });
    await expect(duplicateIdentity.observer.observeCandidate()).resolves.toMatchObject({
      client: "error",
      failure: "schema_invalid"
    });

    const multipleDomains = createHarness({
      status: () =>
        rawStatus(primaryProfile, {
          CertDomains: ["hostdeck.example.ts.net", "second.example.ts.net"]
        })
    });
    await expect(multipleDomains.observer.observeCandidate()).resolves.toMatchObject({
      client: "error",
      failure: "schema_invalid"
    });

    const disagreement = createHarness({
      profile_list: () => [{ ...primaryProfile, account: "different@example.invalid" }]
    });
    await expect(disagreement.observer.observeCandidate()).resolves.toMatchObject({
      client: "error",
      failure: "schema_invalid"
    });

    const overflow = createHarness(
      {
        profile_list: () => [primaryProfile, { ...otherProfile, selected: false }]
      },
      resolveResourceBudget({ remote_observer_max_profiles: 1 })
    );
    await expect(overflow.observer.observeCandidate()).resolves.toMatchObject({
      client: "error",
      failure: "output_oversized"
    });

    const changed = createHarness({
      status: ({ call }) => (call === 0 ? rawStatus(primaryProfile) : rawStatus(otherProfile)),
      profile_list: ({ call }) =>
        call === 0
          ? [primaryProfile, { ...otherProfile, selected: false }]
          : [otherProfile, { ...primaryProfile, selected: false }]
    });
    await expect(changed.observer.observeCandidate()).resolves.toMatchObject({
      client: "available",
      profile: { state: "unknown", comparison: { relation: "unknown" } },
      serve: null,
      external_origin: null,
      failure: "profile_changed"
    });
  });

  it("coalesces concurrent identical reads and rejects a distinct concurrent observation", async () => {
    let releaseVersion: (() => void) | undefined;
    const versionGate = new Promise<void>((resolve) => {
      releaseVersion = resolve;
    });
    const harness = createHarness({
      version: async ({ call }) => {
        if (call === 0) await versionGate;
        return versionOutput;
      }
    });

    const first = harness.observer.observeCandidate();
    const second = harness.observer.observeCandidate();
    expect(second).toBe(first);
    await Promise.resolve();
    expect(harness.fake.requests).toHaveLength(1);

    const distinct = harness.observer.observeConfigured({
      expected_profile_key: primaryProfileKey,
      expected_serve: expectedServe
    });
    expect(harness.fake.requests).toHaveLength(1);
    await expect(distinct).rejects.toMatchObject({ code: "observation_busy" });
    releaseVersion?.();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(harness.fake.requests.filter((request) => request.command === "version")).toHaveLength(1);
  });

  it("uses one lifecycle signal for pre-start and in-flight cancellation", async () => {
    const preAborted = createHarness();
    preAborted.controller.abort();
    await expect(preAborted.observer.observeCandidate()).rejects.toEqual(
      new HostDeckTailscaleObserverError("aborted")
    );
    expect(preAborted.fake.requests).toHaveLength(0);

    const inFlight = createHarness({
      version: ({ request }) =>
        new Promise<string>((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(new HostDeckTailscaleReadCommandError("aborted")),
            { once: true }
          );
        })
    });
    const pending = inFlight.observer.observeCandidate();
    await Promise.resolve();
    inFlight.controller.abort();
    const error = await pending.catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "aborted" });
    expect(error).not.toHaveProperty("cause");

    const lateController = new AbortController();
    const lateObserver = createTailscaleObserver({
      signal: lateController.signal,
      runner: {
        async run() {
          lateController.abort();
          return { stdout: versionOutput };
        }
      },
      now: () => observedAt,
      monotonicNow: () => 0
    });
    await expect(lateObserver.observeCandidate()).rejects.toEqual(
      new HostDeckTailscaleObserverError("aborted")
    );
  });

  it("enforces the aggregate cycle deadline independently of per-command success", async () => {
    const monotonicValues = [0, 0, 20_000];
    const harness = createHarness({}, defaultResourceBudget, {
      monotonicNow: () => monotonicValues.shift() ?? 20_000
    });
    await expect(harness.observer.observeCandidate()).resolves.toMatchObject({
      client: "error",
      failure: "command_timeout"
    });
    expect(harness.fake.requests.map((request) => request.command)).toEqual(["version"]);
  });

  it("fails loudly when an internal clock becomes invalid", async () => {
    const monotonicValues = [0, 0, Number.NaN];
    const harness = createHarness({}, defaultResourceBudget, {
      monotonicNow: () => monotonicValues.shift() ?? Number.NaN
    });
    await expect(harness.observer.observeCandidate()).rejects.toThrow(
      "Tailscale observer monotonic clock is invalid."
    );
    expect(harness.fake.requests.map((request) => request.command)).toEqual(["version"]);
  });

  it("derives stable domain-separated profile keys without using the mutable nickname", async () => {
    const renamed = createHarness({
      profile_list: () => [{ ...primaryProfile, nickname: "Renamed" }]
    });
    const accountChangedProfile = { ...primaryProfile, account: "replacement@example.invalid" };
    const accountChanged = createHarness({
      status: () => rawStatus(accountChangedProfile),
      profile_list: () => [accountChangedProfile]
    });

    const renamedKey = (await renamed.observer.observeCandidate()).profile.comparison.active_profile_key;
    const changedKey = (await accountChanged.observer.observeCandidate()).profile.comparison.active_profile_key;
    expect(renamedKey).toBe(primaryProfileKey);
    expect(changedKey).not.toBe(primaryProfileKey);
    expect(changedKey).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("rejects hostile configured input and command-runner output without invoking accessors", async () => {
    let getterCalls = 0;
    const hostileInput = Object.defineProperty(
      { expected_profile_key: primaryProfileKey },
      "expected_serve",
      {
        enumerable: true,
        get() {
          getterCalls += 1;
          return expectedServe;
        }
      }
    );
    const harness = createHarness();
    expect(() =>
      harness.observer.observeConfigured(
        hostileInput as unknown as {
          expected_profile_key: string;
          expected_serve: RemoteServeDescriptor;
        }
      )
    ).toThrow("Tailscale configured observation input is invalid.");
    expect(getterCalls).toBe(0);

    const hostileRunner: TailscaleReadCommandRunner = {
      run: async () =>
        Object.defineProperty({}, "stdout", {
          enumerable: true,
          get() {
            getterCalls += 1;
            return versionOutput;
          }
        }) as { stdout: string }
    };
    const hostileObserver = createTailscaleObserver({
      signal: new AbortController().signal,
      runner: hostileRunner,
      now: () => observedAt,
      monotonicNow: () => 0
    });
    await expect(hostileObserver.observeCandidate()).resolves.toMatchObject({
      client: "error",
      failure: "schema_invalid"
    });
    expect(getterCalls).toBe(0);
  });

  it("makes mutation-shaped requests impossible in the real command runner", async () => {
    const controller = new AbortController();
    const runner = createRealTailscaleReadCommandRunner();
    const request: TailscaleReadCommandRequest = {
      command: "version",
      executable: tailscaleExecutablePath,
      args: ["up"],
      cwd: "/",
      environment: tailscaleObserverEnvironment,
      timeout_ms: 1_000,
      output_max_bytes: 4_096,
      signal: controller.signal
    };
    await expect(runner.run(request)).rejects.toMatchObject({ code: "schema_invalid" });
  });
});

interface FakeReplyContext {
  readonly request: TailscaleReadCommandRequest;
  readonly call: number;
}

type FakeReply = (context: FakeReplyContext) => unknown | Promise<unknown>;

function createHarness(
  replies: Partial<Record<TailscaleReadCommandName, FakeReply>> = {},
  resourceBudget = defaultResourceBudget,
  clocks: { readonly monotonicNow?: () => number } = {}
) {
  const controller = new AbortController();
  const fake = fakeRunner(replies);
  const observer = createTailscaleObserver({
    signal: controller.signal,
    resourceBudget,
    runner: fake.runner,
    now: () => observedAt,
    monotonicNow: clocks.monotonicNow ?? (() => 0)
  });
  return { controller, fake, observer };
}

function fakeRunner(replies: Partial<Record<TailscaleReadCommandName, FakeReply>>) {
  const requests: TailscaleReadCommandRequest[] = [];
  const calls = new Map<TailscaleReadCommandName, number>();
  const runner: TailscaleReadCommandRunner = Object.freeze({
    async run(request: TailscaleReadCommandRequest) {
      requests.push(request);
      const call = calls.get(request.command) ?? 0;
      calls.set(request.command, call + 1);
      const value = await (replies[request.command] ?? defaultReply(request.command))({ request, call });
      if (value instanceof Error) throw value;
      return Object.freeze({ stdout: typeof value === "string" ? value : JSON.stringify(value) });
    }
  });
  return { requests, runner };
}

function defaultReply(command: TailscaleReadCommandName): FakeReply {
  switch (command) {
    case "version":
      return () => versionOutput;
    case "status":
      return () => rawStatus(primaryProfile);
    case "profile_list":
      return () => [primaryProfile, { ...otherProfile, selected: false }];
    case "serve_status":
    case "funnel_status":
      return () => ({});
  }
}

function rawStatus(
  profile: SyntheticProfile,
  overrides: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> {
  const suffix = profile.tailnet === primaryProfile.tailnet ? "example.ts.net" : "other.ts.net";
  const dnsName = profile.tailnet === primaryProfile.tailnet ? "hostdeck.example.ts.net" : "other.other.ts.net";
  const userId = 7;
  const status: Record<string, unknown> = {
    AuthURL: `https://${rawIdentitySentinel}.invalid/login`,
    BackendState: "Running",
    CertDomains: [dnsName],
    ClientVersion: null,
    CurrentTailnet: {
      MagicDNSEnabled: true,
      MagicDNSSuffix: suffix,
      Name: profile.tailnet
    },
    HaveNodeKey: true,
    Health: [],
    MagicDNSSuffix: suffix,
    Peer: { [rawIdentitySentinel]: { PublicKey: rawIdentitySentinel } },
    Self: { UserID: userId, PublicKey: rawIdentitySentinel },
    TUN: true,
    TailscaleIPs: ["100.64.0.1"],
    User: {
      [String(userId)]: {
        DisplayName: rawIdentitySentinel,
        ID: userId,
        LoginName: profile.account,
        ProfilePicURL: `https://${rawIdentitySentinel}.invalid/image`
      }
    },
    Version: supportedTailscaleVersion.long
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete status[key];
    else status[key] = value;
  }
  return status;
}

function comparisonKey(profile: Pick<SyntheticProfile, "account" | "id" | "tailnet">): string {
  const identity = JSON.stringify([
    "hostdeck-tailscale-profile-v1",
    profile.id,
    profile.account,
    profile.tailnet
  ]);
  return `sha256:${createHash("sha256").update(identity, "utf8").digest("hex")}`;
}
