import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const supportedBrowserManifestPath = resolve(
  scriptDirectory,
  "..",
  "tests/browser/supported-browser-manifest.json"
);

const browserNames = ["chromium", "firefox"];
const enginePolicies = Object.freeze({
  chromium: Object.freeze({ browserVersion: "149.0.7827.55", revision: "1228" }),
  firefox: Object.freeze({ browserVersion: "151.0", revision: "1532" })
});
const projectIds = [
  "chromium-phone",
  "chromium-desktop",
  "firefox-phone",
  "firefox-desktop"
];
const inputModes = ["keyboard", "pointer", "touch"];
const scenarioIds = [
  "package_navigation",
  "pairing_reload",
  "stream_continuity",
  "prompt",
  "model_control",
  "goal_control",
  "plan_control",
  "usage_utility",
  "compact_utility",
  "skills_utility",
  "approval",
  "event_diagnostics",
  "interrupt",
  "archive",
  "laptop_resume",
  "device_revoke",
  "host_lock",
  "remote_recovery",
  "https_cookie"
];
const sha256Pattern = /^[a-f0-9]{64}$/u;

export function readSupportedBrowserManifest(path = supportedBrowserManifestPath) {
  const bytes = readFileSync(path);
  if (bytes.byteLength < 2 || bytes.byteLength > 16_384) {
    throw new TypeError("Supported browser manifest size is invalid.");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError("Supported browser manifest is not valid UTF-8.");
  }
  let candidate;
  try {
    candidate = JSON.parse(text);
  } catch {
    throw new TypeError("Supported browser manifest is not valid JSON.");
  }
  return parseSupportedBrowserManifest(candidate);
}

export function parseSupportedBrowserManifest(candidate) {
  const manifest = exactRecord(candidate, [
    "schema_version",
    "name",
    "task_id",
    "playwright_version",
    "platform",
    "architecture",
    "evidence_schema_version",
    "package",
    "engines",
    "projects",
    "scenarios",
    "automated_interaction_ids"
  ], "manifest");
  exactInteger(manifest.schema_version, 1, "manifest.schema_version");
  exactString(manifest.name, "hostdeck-supported-browser-matrix", "manifest.name");
  exactString(manifest.task_id, "FE-V1-040", "manifest.task_id");
  exactString(manifest.playwright_version, "1.61.1", "manifest.playwright_version");
  exactString(manifest.platform, "linux", "manifest.platform");
  exactString(manifest.architecture, "x64", "manifest.architecture");
  exactInteger(
    manifest.evidence_schema_version,
    1,
    "manifest.evidence_schema_version"
  );
  const packageIdentity = parsePackageIdentity(manifest.package);

  const engines = exactArray(manifest.engines, 2, "manifest.engines").map(
    (value, index) => parseEngine(value, index)
  );
  if (!sameArray(engines.map(({ browser_name }) => browser_name), browserNames)) {
    throw new TypeError("Supported browser engine order is invalid.");
  }

  const projects = exactArray(manifest.projects, 4, "manifest.projects").map(
    (value, index) => parseProject(value, index)
  );
  if (!sameArray(projects.map(({ id }) => id), projectIds)) {
    throw new TypeError("Supported browser project order is invalid.");
  }
  for (const project of projects) {
    if (!engines.some(({ browser_name }) => browser_name === project.browser_name)) {
      throw new TypeError(`Supported browser project ${project.id} has no engine.`);
    }
  }
  assertProjectPolicy(projects);
  const scenarios = exactArray(manifest.scenarios, scenarioIds.length, "manifest.scenarios")
    .map((scenario, index) => parseScenario(scenario, index));
  if (!sameArray(scenarios.map(({ id }) => id), scenarioIds)) {
    throw new TypeError("Supported browser scenario order is invalid.");
  }
  const automatedInteractionIds = boundedUniqueStrings(
    manifest.automated_interaction_ids,
    34,
    34,
    1,
    64,
    "manifest.automated_interaction_ids"
  );
  const scenarioInteractionIds = scenarios.flatMap(({ interaction_ids }) =>
    interaction_ids
  );
  if (
    scenarioInteractionIds.length !== automatedInteractionIds.length ||
    !sameArray([...scenarioInteractionIds].sort(), [...automatedInteractionIds].sort())
  ) {
    throw new TypeError("Supported browser scenario interaction coverage is invalid.");
  }

  return deepFreeze({
    schema_version: manifest.schema_version,
    name: manifest.name,
    task_id: manifest.task_id,
    playwright_version: manifest.playwright_version,
    platform: manifest.platform,
    architecture: manifest.architecture,
    evidence_schema_version: manifest.evidence_schema_version,
    package: packageIdentity,
    engines,
    projects,
    scenarios,
    automated_interaction_ids: automatedInteractionIds
  });
}

function parseScenario(candidate, index) {
  const path = `manifest.scenarios[${index}]`;
  const value = exactRecord(candidate, ["id", "interaction_ids"], path);
  boundedString(value.id, 1, 64, `${path}.id`);
  const interactions = boundedUniqueStrings(
    value.interaction_ids,
    0,
    10,
    1,
    64,
    `${path}.interaction_ids`
  );
  return deepFreeze({ id: value.id, interaction_ids: interactions });
}

function parsePackageIdentity(candidate) {
  const value = exactRecord(candidate, [
    "package_version",
    "content_sha256",
    "manifest_sha256",
    "web_sha256",
    "web_manifest_sha256"
  ], "manifest.package");
  exactString(value.package_version, "0.0.0", "manifest.package.package_version");
  for (const key of [
    "content_sha256",
    "manifest_sha256",
    "web_sha256",
    "web_manifest_sha256"
  ]) {
    if (typeof value[key] !== "string" || !sha256Pattern.test(value[key])) {
      throw new TypeError(`manifest.package.${key} is invalid.`);
    }
  }
  return deepFreeze({ ...value });
}

function parseEngine(candidate, index) {
  const path = `manifest.engines[${index}]`;
  const engine = exactRecord(candidate, [
    "browser_name",
    "browser_version",
    "revision",
    "executable_directory_markers"
  ], path);
  if (!browserNames.includes(engine.browser_name)) {
    throw new TypeError(`${path}.browser_name is invalid.`);
  }
  boundedString(engine.browser_version, 1, 64, `${path}.browser_version`);
  boundedString(engine.revision, 1, 16, `${path}.revision`);
  const policy = enginePolicies[engine.browser_name];
  if (
    policy === undefined ||
    engine.browser_version !== policy.browserVersion ||
    engine.revision !== policy.revision
  ) {
    throw new TypeError(`${path} identity is invalid.`);
  }
  const markers = boundedUniqueStrings(
    engine.executable_directory_markers,
    1,
    2,
    1,
    64,
    `${path}.executable_directory_markers`
  );
  for (const marker of markers) {
    if (!/^[a-z_]+-[0-9]+$/u.test(marker) || !marker.endsWith(`-${engine.revision}`)) {
      throw new TypeError(`${path}.executable_directory_markers is invalid.`);
    }
  }
  return deepFreeze({
    browser_name: engine.browser_name,
    browser_version: engine.browser_version,
    revision: engine.revision,
    executable_directory_markers: markers
  });
}

function parseProject(candidate, index) {
  const path = `manifest.projects[${index}]`;
  const project = exactRecord(candidate, [
    "id",
    "browser_name",
    "regime",
    "viewport",
    "has_touch",
    "is_mobile",
    "input_modes"
  ], path);
  if (!projectIds.includes(project.id)) throw new TypeError(`${path}.id is invalid.`);
  if (!browserNames.includes(project.browser_name)) {
    throw new TypeError(`${path}.browser_name is invalid.`);
  }
  if (project.regime !== "phone" && project.regime !== "desktop") {
    throw new TypeError(`${path}.regime is invalid.`);
  }
  const viewport = exactRecord(project.viewport, ["width", "height"], `${path}.viewport`);
  positiveInteger(viewport.width, `${path}.viewport.width`);
  positiveInteger(viewport.height, `${path}.viewport.height`);
  if (typeof project.has_touch !== "boolean" || typeof project.is_mobile !== "boolean") {
    throw new TypeError(`${path} mobile options are invalid.`);
  }
  const modes = boundedUniqueStrings(project.input_modes, 2, 3, 1, 16, `${path}.input_modes`);
  if (modes.some((mode) => !inputModes.includes(mode))) {
    throw new TypeError(`${path}.input_modes is invalid.`);
  }
  return deepFreeze({
    id: project.id,
    browser_name: project.browser_name,
    regime: project.regime,
    viewport: deepFreeze({ width: viewport.width, height: viewport.height }),
    has_touch: project.has_touch,
    is_mobile: project.is_mobile,
    input_modes: modes
  });
}

function assertProjectPolicy(projects) {
  for (const project of projects) {
    const expectedEngine = project.id.startsWith("chromium-") ? "chromium" : "firefox";
    const expectedRegime = project.id.endsWith("-phone") ? "phone" : "desktop";
    if (project.browser_name !== expectedEngine || project.regime !== expectedRegime) {
      throw new TypeError(`Supported browser project ${project.id} identity is invalid.`);
    }
    const phone = project.regime === "phone";
    const expectedViewport = phone ? { width: 390, height: 844 } : { width: 1280, height: 800 };
    if (
      project.viewport.width !== expectedViewport.width ||
      project.viewport.height !== expectedViewport.height ||
      project.has_touch !== phone ||
      project.is_mobile !== (project.id === "chromium-phone") ||
      !sameArray(project.input_modes, phone ? inputModes : inputModes.slice(0, 2))
    ) {
      throw new TypeError(`Supported browser project ${project.id} policy is invalid.`);
    }
  }
}

function exactRecord(candidate, keys, path) {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError(`${path} must be an object.`);
  }
  const actualKeys = Object.keys(candidate);
  if (!sameArray([...actualKeys].sort(), [...keys].sort())) {
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

function boundedUniqueStrings(candidate, minimum, maximum, minLength, maxLength, path) {
  if (!Array.isArray(candidate) || candidate.length < minimum || candidate.length > maximum) {
    throw new TypeError(`${path} length is invalid.`);
  }
  const values = candidate.map((value, index) => {
    boundedString(value, minLength, maxLength, `${path}[${index}]`);
    return value;
  });
  if (new Set(values).size !== values.length) throw new TypeError(`${path} is not unique.`);
  return Object.freeze(values);
}

function boundedString(candidate, minimum, maximum, path) {
  if (
    typeof candidate !== "string" ||
    candidate.length < minimum ||
    candidate.length > maximum ||
    candidate.trim() !== candidate
  ) {
    throw new TypeError(`${path} is invalid.`);
  }
}

function exactString(candidate, expected, path) {
  if (candidate !== expected) throw new TypeError(`${path} is invalid.`);
}

function exactInteger(candidate, expected, path) {
  if (candidate !== expected) throw new TypeError(`${path} is invalid.`);
}

function positiveInteger(candidate, path) {
  if (!Number.isSafeInteger(candidate) || candidate < 1) {
    throw new TypeError(`${path} is invalid.`);
  }
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function deepFreeze(candidate) {
  if (candidate !== null && typeof candidate === "object" && !Object.isFrozen(candidate)) {
    for (const value of Object.values(candidate)) deepFreeze(value);
    Object.freeze(candidate);
  }
  return candidate;
}
