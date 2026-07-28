import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBrowserMatrixAggregate,
  parseBrowserMatrixProjectReport,
  publishBrowserMatrixEvidence,
  readBrowserMatrixEvidence,
  validateBuiltPackageIdentity
} from "../scripts/browser-matrix-evidence.mjs";
import { readSupportedBrowserManifest } from "../scripts/browser-support-manifest.mjs";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("supported browser matrix evidence", () => {
  it("validates the exact package and project report identity", () => {
    const manifest = readSupportedBrowserManifest();
    expect(validateBuiltPackageIdentity({
      packageVersion: manifest.package.package_version,
      manifestSha256: manifest.package.manifest_sha256,
      content: { bytes: 1, sha256: manifest.package.content_sha256 },
      web: {
        fileCount: 3,
        sha256: manifest.package.web_sha256,
        manifestSha256: manifest.package.web_manifest_sha256
      }
    }, manifest)).toEqual(manifest.package);
    const report = validReport(manifest.projects[0]?.id ?? "");
    expect(parseBrowserMatrixProjectReport(
      report,
      manifest,
      manifest.projects[0]?.id ?? ""
    )).toMatchObject({ status: "passed", scenario_count: 19 });
  });

  it("rejects partial, misattributed, diagnostic, and secret-bearing evidence", () => {
    const manifest = readSupportedBrowserManifest();
    const projectId = manifest.projects[0]?.id ?? "";
    const valid = validReport(projectId);
    const mutations = [
      { ...valid, unexpected: true },
      { ...valid, scenarios: valid.scenarios.slice(1) },
      {
        ...valid,
        scenarios: valid.scenarios.map((scenario, index) =>
          index === 0 ? { ...scenario, interactions: [] } : scenario
        )
      },
      {
        ...valid,
        scenarios: valid.scenarios.map((scenario, index) =>
          index === 0 ? { ...scenario, request_count: scenario.request_count + 1 } : scenario
        )
      },
      {
        ...valid,
        scenarios: valid.scenarios.map((scenario, index) =>
          index === 0
            ? { ...scenario, observations: { css_platform_features: true } }
            : scenario
        )
      },
      {
        ...valid,
        diagnostics: { ...valid.diagnostics, page_errors: 1 }
      },
      {
        ...valid,
        scenarios: valid.scenarios.map((scenario, index) =>
          index === 0
            ? { ...scenario, observations: { leaked: "#pair=not-allowed" } }
            : scenario
        )
      }
    ];
    for (const mutation of mutations) {
      expect(() => parseBrowserMatrixProjectReport(mutation, manifest, projectId))
        .toThrow(TypeError);
    }
  });

  it("requires all four reports and publishes one complete aggregate directory", () => {
    const manifest = readSupportedBrowserManifest();
    const evidenceRoot = makeTemporaryRoot("hostdeck-browser-matrix-run-evidence-test-");
    for (const project of manifest.projects) {
      writeFileSync(
        join(evidenceRoot, `${project.id}.json`),
        `${JSON.stringify(validReport(project.id), null, 2)}\n`,
        "utf8"
      );
    }
    const missingPath = join(evidenceRoot, "firefox-phone.json");
    const missingText = readFileSync(missingPath, "utf8");
    rmSync(missingPath);
    expect(() => readBrowserMatrixEvidence(evidenceRoot, manifest)).toThrow(TypeError);
    writeFileSync(missingPath, missingText, "utf8");
    const bundle = readBrowserMatrixEvidence(evidenceRoot, manifest);
    const aggregate = createBrowserMatrixAggregate(bundle, {
      web_servers_stopped: true,
      temporary_root_removed: true,
      playwright_output_removed: true
    });
    const publishParent = makeTemporaryRoot("hostdeck-browser-evidence-publish-test-");
    const artifactRoot = join(publishParent, "evidence");
    mkdirSync(artifactRoot);
    writeFileSync(join(artifactRoot, "stale-report.json"), "stale\n", "utf8");
    publishBrowserMatrixEvidence(bundle, aggregate, artifactRoot);

    expect(readdirSync(artifactRoot).sort()).toEqual([
      "chromium-desktop.json",
      "chromium-phone.json",
      "firefox-desktop.json",
      "firefox-phone.json",
      "manifest.json"
    ]);
    expect(JSON.parse(readFileSync(join(artifactRoot, "manifest.json"), "utf8")))
      .toMatchObject({ status: "passed", project_count: 4 });
  });
});

function validReport(projectId: string) {
  const manifest = readSupportedBrowserManifest();
  const project = manifest.projects.find(({ id }) => id === projectId);
  if (project === undefined) throw new TypeError("Evidence test project is invalid.");
  const engine = manifest.engines.find(
    ({ browser_name }) => browser_name === project.browser_name
  );
  if (engine === undefined) throw new TypeError("Evidence test engine is invalid.");
  const scenarios = manifest.scenarios.map(({ id, interaction_ids }) => {
    const evidence = validScenarioEvidence(project, id);
    return {
      id,
      status: "passed",
      interactions: interaction_ids,
      request_count: evidence.request_count,
      mutation_count: evidence.mutation_count,
      duration_ms: 10,
      observations: evidence.observations
    };
  });
  return {
    schema_version: 1,
    task_id: manifest.task_id,
    status: "passed",
    project_id: project.id,
    engine: {
      browser_name: engine.browser_name,
      browser_version: engine.browser_version,
      revision: engine.revision
    },
    playwright_version: manifest.playwright_version,
    platform: manifest.platform,
    architecture: manifest.architecture,
    regime: project.regime,
    viewport: project.viewport,
    has_touch: project.has_touch,
    is_mobile: project.is_mobile,
    input_modes: project.input_modes,
    package: {
      version: manifest.package.package_version,
      content_sha256: manifest.package.content_sha256,
      manifest_sha256: manifest.package.manifest_sha256,
      web_sha256: manifest.package.web_sha256,
      web_manifest_sha256: manifest.package.web_manifest_sha256
    },
    scenario_count: scenarios.length,
    interaction_ids: [...manifest.automated_interaction_ids].sort(),
    total_request_count: scenarios.reduce((total, scenario) =>
      total + scenario.request_count, 0),
    total_mutation_count: scenarios.reduce((total, scenario) =>
      total + scenario.mutation_count, 0),
    duration_ms: 200,
    diagnostics: {
      cache_entries: 0,
      expected_http_failures: 1,
      console_errors: 0,
      csp_violations: 0,
      external_requests: 0,
      indexeddb_databases: 0,
      unexpected_network_failures: 0,
      page_errors: 0,
      pending_request_overflow: 0,
      service_workers: 0,
      storage_entries: 0
    },
    limitations: {
      physical_mobile_device_proven: false,
      firefox_android_proven: false,
      tailscale_serve_certificate_trust_proven: false,
      tailscale_serve_routing_proven: false,
      safari_ios_supported: false
    },
    scenarios
  };
}

function validScenarioEvidence(
  project: ReturnType<typeof readSupportedBrowserManifest>["projects"][number],
  id: string
) {
  const staticPolicies: Readonly<Record<string, Readonly<{
    request_count: number;
    mutation_count: number;
    observations: Readonly<Record<string, string | number | boolean>>;
  }>>> = {
    stream_continuity: policy(2, 0, {
      duplicate_events: false,
      highest_cursor: 3,
      reconnect_visible: true,
      resumed_after_cursor: 3
    }),
    prompt: policy(1, 1, { duplicate_submit: false, event_confirmed: true }),
    model_control: policy(2, 1, {
      has_selector_applied: true,
      native_radio_keyboard: true
    }),
    goal_control: policy(2, 1, { paused_without_turn: true }),
    plan_control: policy(2, 1, { native_radio_keyboard: true }),
    usage_utility: policy(1, 0, { utility_focus_restored: true }),
    compact_utility: policy(2, 1, { confirmation_required: true }),
    skills_utility: policy(1, 0, { local_search: true }),
    approval: policy(4, 1, { duplicate_response: false, terminal_confirmed: true }),
    event_diagnostics: policy(1, 0, { bounded_projection: true }),
    interrupt: policy(1, 1, { exact_turn_confirmed: true }),
    archive: policy(1, 1, { retained_history_not_deleted: true }),
    device_revoke: policy(2, 1, { confirmation_required: true }),
    host_lock: policy(1, 1, { local_unlock_only: true, writes_purged: true }),
    remote_recovery: policy(14, 0, {
      automatic_profile_switch: false,
      polling: false,
      profile_return_observed: true
    }),
    https_cookie: policy(13, 1, {
      certificate_trust_proven: false,
      credential_storage_entries: 0,
      cross_site_suppressed: true,
      http_only: true,
      host_only: true,
      javascript_invisible: true,
      packaged_document: true,
      reload_persistent: true,
      same_site_strict: true,
      secure: true
    })
  };
  if (id === "package_navigation") {
    return policy(20, 0, {
      css_platform_features: true,
      desktop_split: project.regime === "desktop",
      primary_activation: project.regime === "phone" ? "touch" : "keyboard",
      reduced_motion: true
    });
  }
  if (id === "pairing_reload") {
    return policy(project.browser_name === "firefox" ? 9 : 7, 2, {
      claim_replayed: false,
      fragment_scrubbed: true,
      history_back_steps: project.browser_name === "firefox" ? 2 : 1,
      history_preserved: true
    });
  }
  if (id === "laptop_resume") {
    return policy(1, 0, {
      clipboard_outcome: project.browser_name === "firefox" ? "copied" : "unavailable"
    });
  }
  const selected = staticPolicies[id];
  if (selected === undefined) throw new TypeError(`Unknown evidence scenario: ${id}`);
  return selected;
}

function policy(
  requestCount: number,
  mutationCount: number,
  observations: Readonly<Record<string, string | number | boolean>>
) {
  return {
    request_count: requestCount,
    mutation_count: mutationCount,
    observations
  };
}

function makeTemporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}
