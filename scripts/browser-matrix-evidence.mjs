import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readSupportedBrowserManifest,
  supportedBrowserManifestPath
} from "./browser-support-manifest.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const browserMatrixEvidenceArtifactRoot = resolve(
  scriptDirectory,
  "..",
  "artifacts",
  "fe-v1-040-supported-browser-interaction-matrix"
);
const reportMaximumBytes = 256 * 1024;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const expectedDiagnostics = Object.freeze({
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
});
const expectedLimitations = Object.freeze({
  physical_mobile_device_proven: false,
  firefox_android_proven: false,
  tailscale_serve_certificate_trust_proven: false,
  tailscale_serve_routing_proven: false,
  safari_ios_supported: false
});
const forbiddenEvidence = [
  ["pairing fragment", /#pair=/iu],
  ["CSRF material", /x-hostdeck-csrf|csrf_token/iu],
  ["raw device cookie", /__Host-hostdeck_device\s*=/iu],
  ["fixture cookie value", /fixture-only/iu],
  ["operation identifier", /\b(?:op|thread|turn)[_-][a-z0-9_-]{8,}\b/iu],
  ["private network identity", /\.ts\.net|fixture-tailnet/iu],
  ["machine path", /\/(?:home|tmp)\//u],
  ["prompt payload", /Run the supported browser interaction check/iu],
  ["goal payload", /Complete the supported browser matrix/iu]
];

export function validateBuiltPackageIdentity(packageManifest, manifest = readSupportedBrowserManifest()) {
  if (
    packageManifest === null ||
    typeof packageManifest !== "object" ||
    Array.isArray(packageManifest)
  ) {
    throw new TypeError("Supported browser package manifest is invalid.");
  }
  const candidate = packageManifest;
  const content = candidate.content;
  const web = candidate.web;
  if (
    content === null ||
    typeof content !== "object" ||
    Array.isArray(content) ||
    web === null ||
    typeof web !== "object" ||
    Array.isArray(web)
  ) {
    throw new TypeError("Supported browser package identity is missing.");
  }
  const observed = {
    package_version: candidate.packageVersion,
    content_sha256: content.sha256,
    manifest_sha256: candidate.manifestSha256,
    web_sha256: web.sha256,
    web_manifest_sha256: web.manifestSha256
  };
  if (Object.values(observed).some((value) =>
    typeof value !== "string" ||
    (value !== manifest.package.package_version && !sha256Pattern.test(value))
  )) {
    throw new TypeError("Supported browser package identity is malformed.");
  }
  if (!sameRecord(observed, manifest.package)) {
    throw new TypeError("Supported browser package identity is invalid.");
  }
  return deepFreeze(observed);
}

export function readBrowserMatrixEvidence(
  evidenceRoot,
  manifest = readSupportedBrowserManifest()
) {
  const root = resolve(evidenceRoot);
  if (!root.startsWith("/tmp/hostdeck-browser-matrix-run-")) {
    throw new TypeError("Browser matrix temporary evidence root is invalid.");
  }
  const rootStats = lstatSync(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new TypeError("Browser matrix temporary evidence root is unsafe.");
  }
  const expectedFiles = manifest.projects.map(({ id }) => `${id}.json`).sort();
  const actualFiles = readdirSync(root).sort();
  if (!sameArray(actualFiles, expectedFiles)) {
    throw new TypeError("Browser matrix evidence file set is incomplete.");
  }

  const reports = manifest.projects.map((project) => {
    const file = `${project.id}.json`;
    const path = join(root, file);
    const stats = lstatSync(path);
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.size < 2 ||
      stats.size > reportMaximumBytes
    ) {
      throw new TypeError(`Browser matrix report ${file} is unsafe.`);
    }
    const bytes = readFileSync(path);
    const text = decodeUtf8(bytes, `Browser matrix report ${file}`);
    assertEvidencePrivacy(text);
    let candidate;
    try {
      candidate = JSON.parse(text);
    } catch {
      throw new TypeError(`Browser matrix report ${file} is not valid JSON.`);
    }
    return deepFreeze({
      file,
      report: parseBrowserMatrixProjectReport(candidate, manifest, project.id),
      sha256: digest(bytes),
      text
    });
  });
  return deepFreeze({ manifest, reports });
}

export function parseBrowserMatrixProjectReport(candidate, manifest, projectId) {
  assertEvidencePrivacy(JSON.stringify(candidate));
  const report = exactRecord(candidate, [
    "schema_version",
    "task_id",
    "status",
    "project_id",
    "engine",
    "playwright_version",
    "platform",
    "architecture",
    "regime",
    "viewport",
    "has_touch",
    "is_mobile",
    "input_modes",
    "package",
    "scenario_count",
    "interaction_ids",
    "total_request_count",
    "total_mutation_count",
    "duration_ms",
    "diagnostics",
    "limitations",
    "scenarios"
  ], "browser matrix report");
  exactValue(report.schema_version, manifest.evidence_schema_version, "report schema");
  exactValue(report.task_id, manifest.task_id, "report task");
  exactValue(report.status, "passed", "report status");
  exactValue(report.project_id, projectId, "report project");
  exactValue(report.playwright_version, manifest.playwright_version, "report Playwright");
  exactValue(report.platform, manifest.platform, "report platform");
  exactValue(report.architecture, manifest.architecture, "report architecture");

  const project = manifest.projects.find(({ id }) => id === projectId);
  if (project === undefined) throw new TypeError("Browser matrix report project is unknown.");
  exactValue(report.regime, project.regime, "report regime");
  exactValue(report.has_touch, project.has_touch, "report touch option");
  exactValue(report.is_mobile, project.is_mobile, "report mobile option");
  if (!sameRecord(report.viewport, project.viewport)) {
    throw new TypeError("Browser matrix report viewport is invalid.");
  }
  if (!sameArray(report.input_modes, project.input_modes)) {
    throw new TypeError("Browser matrix report input modes are invalid.");
  }

  const expectedEngine = manifest.engines.find(
    ({ browser_name }) => browser_name === project.browser_name
  );
  if (
    expectedEngine === undefined ||
    !sameRecord(report.engine, {
      browser_name: expectedEngine.browser_name,
      browser_version: expectedEngine.browser_version,
      revision: expectedEngine.revision
    })
  ) {
    throw new TypeError("Browser matrix report engine is invalid.");
  }
  const expectedPackage = {
    version: manifest.package.package_version,
    content_sha256: manifest.package.content_sha256,
    manifest_sha256: manifest.package.manifest_sha256,
    web_sha256: manifest.package.web_sha256,
    web_manifest_sha256: manifest.package.web_manifest_sha256
  };
  if (!sameRecord(report.package, expectedPackage)) {
    throw new TypeError("Browser matrix report package is invalid.");
  }

  exactValue(report.scenario_count, manifest.scenarios.length, "report scenario count");
  const scenarios = exactArray(report.scenarios, manifest.scenarios.length, "report scenarios")
    .map((scenario, index) =>
      parseScenario(scenario, manifest.scenarios[index], index, project)
    );
  const expectedInteractions = unique(manifest.automated_interaction_ids);
  if (!sameArray(report.interaction_ids, expectedInteractions)) {
    throw new TypeError("Browser matrix report interaction coverage is invalid.");
  }
  const scenarioInteractions = unique(scenarios.flatMap(({ interactions }) => interactions));
  if (!sameArray(scenarioInteractions, expectedInteractions)) {
    throw new TypeError("Browser matrix scenario interaction coverage is invalid.");
  }
  const requestCount = scenarios.reduce((total, value) => total + value.request_count, 0);
  const mutationCount = scenarios.reduce((total, value) => total + value.mutation_count, 0);
  exactValue(report.total_request_count, requestCount, "report request total");
  exactValue(report.total_mutation_count, mutationCount, "report mutation total");
  boundedInteger(report.duration_ms, 1, 3_600_000, "report duration");
  if (!sameRecord(report.diagnostics, expectedDiagnostics)) {
    throw new TypeError("Browser matrix report diagnostics are invalid.");
  }
  if (!sameRecord(report.limitations, expectedLimitations)) {
    throw new TypeError("Browser matrix report limitations are invalid.");
  }
  return deepFreeze(report);
}

export function createBrowserMatrixAggregate(bundle, cleanup) {
  if (!sameRecord(cleanup, {
    web_servers_stopped: true,
    temporary_root_removed: true,
    playwright_output_removed: true
  })) {
    throw new TypeError("Browser matrix cleanup evidence is invalid.");
  }
  const manifestBytes = readFileSync(supportedBrowserManifestPath);
  const reports = bundle.reports.map(({ file, report, sha256 }) => ({
    project_id: report.project_id,
    report_file: file,
    report_sha256: sha256,
    browser_name: report.engine.browser_name,
    browser_version: report.engine.browser_version,
    revision: report.engine.revision,
    regime: report.regime,
    viewport: report.viewport,
    input_modes: report.input_modes,
    duration_ms: report.duration_ms,
    request_count: report.total_request_count,
    mutation_count: report.total_mutation_count
  }));
  const aggregate = {
    schema_version: 1,
    name: "hostdeck-supported-browser-interaction-matrix-evidence",
    task_id: bundle.manifest.task_id,
    status: "passed",
    evidence_schema_version: bundle.manifest.evidence_schema_version,
    support_manifest_sha256: digest(manifestBytes),
    package: bundle.manifest.package,
    project_count: reports.length,
    scenario_count_per_project: bundle.manifest.scenarios.length,
    automated_interaction_count: bundle.manifest.automated_interaction_ids.length,
    total_request_count: reports.reduce((total, report) => total + report.request_count, 0),
    total_mutation_count: reports.reduce((total, report) => total + report.mutation_count, 0),
    limitations: expectedLimitations,
    cleanup,
    projects: reports
  };
  assertEvidencePrivacy(JSON.stringify(aggregate));
  return deepFreeze(aggregate);
}

export function publishBrowserMatrixEvidence(
  bundle,
  aggregate,
  artifactRoot = browserMatrixEvidenceArtifactRoot
) {
  const target = resolve(artifactRoot);
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, ".fe-v1-040-evidence-"));
  let backup = null;
  try {
    for (const entry of bundle.reports) {
      writeFileSync(join(staging, entry.file), entry.text, { encoding: "utf8", mode: 0o644 });
      if (digest(readFileSync(join(staging, entry.file))) !== entry.sha256) {
        throw new TypeError("Browser matrix staged report identity changed.");
      }
    }
    const aggregateText = `${JSON.stringify(aggregate, null, 2)}\n`;
    assertEvidencePrivacy(aggregateText);
    writeFileSync(join(staging, "manifest.json"), aggregateText, {
      encoding: "utf8",
      mode: 0o644
    });
    if (existsSync(target)) {
      const stats = lstatSync(target);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new TypeError("Browser matrix artifact target is unsafe.");
      }
      backup = mkdtempSync(join(parent, ".fe-v1-040-evidence-backup-"));
      rmSync(backup, { recursive: true });
      renameSync(target, backup);
    }
    try {
      renameSync(staging, target);
    } catch (error) {
      if (backup !== null && existsSync(backup) && !existsSync(target)) {
        renameSync(backup, target);
        backup = null;
      }
      throw error;
    }
    if (backup !== null) rmSync(backup, { recursive: true });
    backup = null;
  } finally {
    if (existsSync(staging)) rmSync(staging, { force: true, recursive: true });
    if (backup !== null && existsSync(backup)) {
      if (!existsSync(target)) renameSync(backup, target);
      else rmSync(backup, { force: true, recursive: true });
    }
  }
}

function parseScenario(candidate, expected, index, project) {
  if (expected === undefined) throw new TypeError("Browser matrix expected scenario is missing.");
  const scenario = exactRecord(candidate, [
    "id",
    "status",
    "interactions",
    "request_count",
    "mutation_count",
    "duration_ms",
    "observations"
  ], `report.scenarios[${index}]`);
  exactValue(scenario.id, expected.id, `report.scenarios[${index}].id`);
  exactValue(scenario.status, "passed", `report.scenarios[${index}].status`);
  if (!sameArray(scenario.interactions, expected.interaction_ids)) {
    throw new TypeError(`Browser matrix scenario ${expected.id} interactions are invalid.`);
  }
  const policy = expectedScenarioEvidence(expected.id, project);
  exactValue(scenario.request_count, policy.request_count, `${expected.id} request count`);
  exactValue(scenario.mutation_count, policy.mutation_count, `${expected.id} mutation count`);
  boundedInteger(scenario.duration_ms, 0, 120_000, `${expected.id} duration`);
  if (!sameRecord(scenario.observations, policy.observations)) {
    throw new TypeError(`Browser matrix scenario ${expected.id} observations are invalid.`);
  }
  return deepFreeze(scenario);
}

function expectedScenarioEvidence(id, project) {
  const policies = {
    package_navigation: {
      request_count: 20,
      mutation_count: 0,
      observations: {
        css_platform_features: true,
        desktop_split: project.regime === "desktop",
        primary_activation: project.regime === "phone" ? "touch" : "keyboard",
        reduced_motion: true
      }
    },
    pairing_reload: {
      request_count: project.browser_name === "firefox" ? 9 : 7,
      mutation_count: 2,
      observations: {
        claim_replayed: false,
        fragment_scrubbed: true,
        history_back_steps: project.browser_name === "firefox" ? 2 : 1,
        history_preserved: true
      }
    },
    stream_continuity: {
      request_count: 2,
      mutation_count: 0,
      observations: {
        duplicate_events: false,
        highest_cursor: 3,
        reconnect_visible: true,
        resumed_after_cursor: 3
      }
    },
    prompt: evidencePolicy(1, 1, { duplicate_submit: false, event_confirmed: true }),
    model_control: evidencePolicy(2, 1, {
      has_selector_applied: true,
      native_radio_keyboard: true
    }),
    goal_control: evidencePolicy(2, 1, { paused_without_turn: true }),
    plan_control: evidencePolicy(2, 1, { native_radio_keyboard: true }),
    usage_utility: evidencePolicy(1, 0, { utility_focus_restored: true }),
    compact_utility: evidencePolicy(2, 1, { confirmation_required: true }),
    skills_utility: evidencePolicy(1, 0, { local_search: true }),
    approval: evidencePolicy(4, 1, {
      duplicate_response: false,
      terminal_confirmed: true
    }),
    event_diagnostics: evidencePolicy(1, 0, { bounded_projection: true }),
    interrupt: evidencePolicy(1, 1, { exact_turn_confirmed: true }),
    archive: evidencePolicy(1, 1, { retained_history_not_deleted: true }),
    laptop_resume: evidencePolicy(1, 0, {
      clipboard_outcome: project.browser_name === "firefox" ? "copied" : "unavailable"
    }),
    device_revoke: evidencePolicy(2, 1, { confirmation_required: true }),
    host_lock: evidencePolicy(1, 1, {
      local_unlock_only: true,
      writes_purged: true
    }),
    remote_recovery: evidencePolicy(14, 0, {
      automatic_profile_switch: false,
      polling: false,
      profile_return_observed: true
    }),
    https_cookie: evidencePolicy(13, 1, {
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
  const policy = policies[id];
  if (policy === undefined) {
    throw new TypeError(`Browser matrix scenario ${id} has no evidence policy.`);
  }
  return policy;
}

function evidencePolicy(requestCount, mutationCount, observations) {
  return {
    request_count: requestCount,
    mutation_count: mutationCount,
    observations
  };
}

function assertEvidencePrivacy(text) {
  if (typeof text !== "string" || text.length > 2_000_000) {
    throw new TypeError("Browser matrix evidence text is invalid.");
  }
  for (const [label, pattern] of forbiddenEvidence) {
    if (pattern.test(text)) {
      throw new TypeError(`Browser matrix evidence contains forbidden ${label}.`);
    }
  }
}

function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError(`${label} is not valid UTF-8.`);
  }
}

function exactRecord(candidate, keys, path) {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError(`${path} must be an object.`);
  }
  const actualKeys = Object.keys(candidate).sort();
  if (!sameArray(actualKeys, [...keys].sort())) {
    throw new TypeError(`${path} keys are invalid.`);
  }
  return candidate;
}

function exactArray(candidate, length, path) {
  if (!Array.isArray(candidate) || candidate.length !== length) {
    throw new TypeError(`${path} length is invalid.`);
  }
  return candidate;
}

function boundedInteger(candidate, minimum, maximum, path) {
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new TypeError(`${path} is invalid.`);
  }
}

function exactValue(candidate, expected, path) {
  if (candidate !== expected) throw new TypeError(`${path} is invalid.`);
}

function sameRecord(candidate, expected) {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }
  const keys = Object.keys(expected);
  return (
    sameArray(Object.keys(candidate).sort(), [...keys].sort()) &&
    keys.every((key) => {
      const left = candidate[key];
      const right = expected[key];
      if (Array.isArray(right)) return sameArray(left, right);
      if (right !== null && typeof right === "object") return sameRecord(left, right);
      return left === right;
    })
  );
}

function sameArray(candidate, expected) {
  return (
    Array.isArray(candidate) &&
    candidate.length === expected.length &&
    candidate.every((value, index) => {
      const target = expected[index];
      if (Array.isArray(target)) return sameArray(value, target);
      if (target !== null && typeof target === "object") return sameRecord(value, target);
      return value === target;
    })
  );
}

function unique(values) {
  return [...new Set(values)].sort();
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function deepFreeze(candidate) {
  if (candidate !== null && typeof candidate === "object" && !Object.isFrozen(candidate)) {
    for (const value of Object.values(candidate)) deepFreeze(value);
    Object.freeze(candidate);
  }
  return candidate;
}
