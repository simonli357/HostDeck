import { describe, expect, it } from "vitest";
import {
  createRealTailscaleReadCommandRunner,
  createTailscaleObserver,
  supportedTailscaleVersion,
  type TailscaleReadCommandRunner
} from "./tailscale-observer.js";

const requireSmoke = process.env.HOSTDECK_REQUIRE_TAILSCALE_OBSERVER_SMOKE === "1";
const smokeMode = process.env.HOSTDECK_TAILSCALE_OBSERVER_EXPECT ?? "active";
const expectedProfileKey = process.env.HOSTDECK_TAILSCALE_EXPECTED_PROFILE_KEY ?? null;
const describeSmoke = requireSmoke ? describe : describe.skip;
const fullSelectedReadCycle = [
  "version",
  "status",
  "profile_list",
  "serve_status",
  "funnel_status",
  "status",
  "profile_list"
] as const;

describeSmoke("real read-only Tailscale observer", () => {
  it("returns only one bounded normalized snapshot and leaves no command resource active", async () => {
    if (!["active", "stopped", "other"].includes(smokeMode)) {
      throw new TypeError("HOSTDECK_TAILSCALE_OBSERVER_EXPECT must be active, stopped, or other.");
    }
    if (smokeMode === "other" && !/^sha256:[a-f0-9]{64}$/u.test(expectedProfileKey ?? "")) {
      throw new TypeError("Other-profile smoke requires one bounded expected profile comparison key.");
    }

    const controller = new AbortController();
    const realRunner = createRealTailscaleReadCommandRunner();
    const versionProbes: boolean[] = [];
    const executedCommands: string[] = [];
    let actualVersionOutput: string | null = null;
    const runner: TailscaleReadCommandRunner = {
      async run(request) {
        executedCommands.push(request.command);
        const result = await realRunner.run(request);
        if (request.command === "version") {
          actualVersionOutput = result.stdout.trimEnd();
          versionProbes.push(actualVersionOutput === expectedVersionOutput());
        } else if (request.command === "status") {
          const status = JSON.parse(result.stdout) as { readonly Version?: unknown };
          versionProbes.push(status.Version === supportedTailscaleVersion.long);
        }
        return result;
      }
    };
    const observer = createTailscaleObserver({ signal: controller.signal, runner });
    const snapshot =
      smokeMode === "other"
        ? await observer.observeConfigured({
            expected_profile_key: expectedProfileKey as string,
            expected_serve: null
          })
        : await observer.observeCandidate();

    expect(actualVersionOutput).toBe(expectedVersionOutput());
    expect(versionProbes).not.toContain(false);
    expect(snapshot.failure).toBeNull();
    expect(snapshot.client).toBe("available");
    if (smokeMode === "active") {
      expect(executedCommands).toEqual(fullSelectedReadCycle);
      expect(snapshot.profile).toMatchObject({
        state: "dedicated",
        comparison: { relation: "match" }
      });
      expect(snapshot.serve).not.toBeNull();
    } else if (smokeMode === "stopped") {
      expect(executedCommands).toEqual(fullSelectedReadCycle);
      expect(snapshot.profile).toMatchObject({
        state: "stopped",
        comparison: { relation: "match" }
      });
      expect(snapshot.serve).not.toBeNull();
    } else if (snapshot.profile.state === "signed_out") {
      expect(executedCommands).toEqual(["version", "status"]);
      expect(snapshot.profile.comparison).toEqual({
        relation: "unknown",
        expected_profile_key: expectedProfileKey,
        active_profile_key: null
      });
      expect(snapshot.serve).toBeNull();
      expect(snapshot.external_origin).toBeNull();
    } else {
      expect(executedCommands).toEqual(["version", "status", "profile_list", "status", "profile_list"]);
      expect(snapshot.profile.comparison).toMatchObject({
        relation: "different",
        expected_profile_key: expectedProfileKey
      });
      expect(["other", "stopped"]).toContain(snapshot.profile.state);
      expect(snapshot.serve).toBeNull();
      expect(snapshot.external_origin).toBeNull();
    }

    expect(Object.keys(snapshot).sort()).toEqual([
      "client",
      "external_origin",
      "failure",
      "observed_at",
      "profile",
      "schema_version",
      "serve"
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(
      /(?:AuthURL|CertDomains|CurrentTailnet|HaveNodeKey|Peer|Self|TailscaleIPs|User|account|nickname|node_key|raw_output|tailnet)/u
    );

    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(process.getActiveResourcesInfo()).not.toContain("ChildProcess");
  });
});

function expectedVersionOutput(): string {
  return [
    supportedTailscaleVersion.short,
    `  tailscale commit: ${supportedTailscaleVersion.tailscale_commit}`,
    `  long version: ${supportedTailscaleVersion.long}`,
    `  other commit: ${supportedTailscaleVersion.other_commit}`,
    `  go version: ${supportedTailscaleVersion.go_version}`
  ].join("\n");
}
