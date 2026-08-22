// Pure fact model for docs/planning/04-technical-plan.md.
//
// The plan is the owner of "exact" architecture truth, but nothing verified that its
// stated versions and counts still matched the workspace. This module makes each claim
// machine-checkable: every descriptor pairs one regex that must match the plan exactly
// once with one function that reads the authoritative value out of code or a manifest.
//
// A claim that stops matching is an error on purpose. Rewording a pinned fact is exactly
// the moment it needs re-verification, so silence is not an acceptable outcome here.

const versionPattern = String.raw`\d+\.\d+\.\d+`;

/**
 * @param {string} label human-readable dependency name used in the failure message
 * @param {RegExp} claim must contain exactly one capture group holding the claimed value
 * @param {(sources: PlanFactSources) => string | null} actual authoritative value, or null when absent
 */
function fact(id, label, claim, actual) {
  return { id, label, claim, actual };
}

function dependency(id, label, pattern, packageName, dependencyName) {
  return fact(id, label, pattern, (sources) => {
    const manifest = sources.manifests[packageName];
    if (manifest === undefined) return null;
    return manifest.dependencies?.[dependencyName] ?? manifest.devDependencies?.[dependencyName] ?? null;
  });
}

function countMatches(text, pattern) {
  return (text.match(pattern) ?? []).length;
}

function readNumber(text, pattern, label) {
  const match = pattern.exec(text);
  if (match === null) throw new Error(`technical-plan-facts: could not read ${label}`);
  return match[1];
}

export const technicalPlanFacts = [
  dependency(
    "fastify",
    "fastify",
    new RegExp(String.raw`Exact \x60fastify\x60 (${versionPattern})`),
    "@hostdeck/server",
    "fastify"
  ),
  dependency(
    "fastify-sse",
    "@fastify/sse",
    new RegExp(String.raw`Exact \x60@fastify/sse\x60 (${versionPattern})`),
    "@hostdeck/server",
    "@fastify/sse"
  ),
  dependency(
    "fastify-static",
    "@fastify/static",
    new RegExp(String.raw`Exact \x60@fastify/static\x60 (${versionPattern})`),
    "@hostdeck/server",
    "@fastify/static"
  ),
  dependency(
    "cookie",
    "cookie",
    new RegExp(String.raw`\x60cookie\x60 (${versionPattern})`),
    "@hostdeck/server",
    "cookie"
  ),
  dependency(
    "zod",
    "zod",
    new RegExp(String.raw`and \x60zod\x60 (${versionPattern}) with HostDeck-owned`),
    "@hostdeck/contracts",
    "zod"
  ),
  dependency(
    "ws",
    "ws",
    new RegExp(String.raw`Exact \x60ws\x60 (${versionPattern}) client`),
    "@hostdeck/codex-adapter",
    "ws"
  ),
  dependency(
    "koffi",
    "koffi",
    new RegExp(String.raw`Exact \x60koffi\x60 (${versionPattern})`),
    "@hostdeck/server",
    "koffi"
  ),
  dependency(
    "qrcode",
    "qrcode",
    new RegExp(String.raw`exact \x60qrcode\x60 (${versionPattern})`),
    "@hostdeck/cli",
    "qrcode"
  ),
  dependency(
    "better-sqlite3",
    "better-sqlite3",
    new RegExp(String.raw`Exact \x60better-sqlite3\x60 (${versionPattern})`),
    "@hostdeck/storage",
    "better-sqlite3"
  ),
  dependency(
    "fs-native-extensions",
    "fs-native-extensions",
    new RegExp(String.raw`exact \x60fs-native-extensions\x60 (${versionPattern})`),
    "@hostdeck/storage",
    "fs-native-extensions"
  ),
  dependency(
    "react",
    "react",
    new RegExp(`Exact React (${versionPattern}),`),
    "@hostdeck/web",
    "react"
  ),
  dependency(
    "react-router",
    "react-router",
    new RegExp(`React Router (${versionPattern}),`),
    "@hostdeck/web",
    "react-router"
  ),
  dependency(
    "radix-dialog",
    "@radix-ui/react-dialog",
    new RegExp(`Radix Dialog (${versionPattern}),`),
    "@hostdeck/web",
    "@radix-ui/react-dialog"
  ),
  dependency(
    "lucide-react",
    "lucide-react",
    new RegExp(`Lucide React (${versionPattern}),`),
    "@hostdeck/web",
    "lucide-react"
  ),
  dependency(
    "eventsource-parser",
    "eventsource-parser",
    new RegExp(String.raw`\x60eventsource-parser\x60 (${versionPattern}),`),
    "@hostdeck/web",
    "eventsource-parser"
  ),

  fact(
    "node-runtime",
    "pinned Node runtime",
    new RegExp(String.raw`Pinned Node\.js (${versionPattern}) and strict TypeScript`),
    (sources) => sources.rootManifest.engines?.node ?? null
  ),
  fact(
    "codex-version",
    "pinned Codex CLI",
    new RegExp(String.raw`exact \x60codex-cli (${versionPattern})\x60`),
    (sources) => readNumber(sources.codexBindingManifest, /"codexVersion":\s*"(\d+\.\d+\.\d+)"/, "codexVersion")
  ),
  fact(
    "tailscale-version",
    "reviewed Tailscale client",
    new RegExp(`the current exact version is (${versionPattern})`),
    (sources) => readNumber(sources.tailscaleObserver, /short:\s*"(\d+\.\d+\.\d+)"/, "tailscale short version")
  ),

  fact(
    "resource-budget-count",
    "resourceBudgetSchema limit count",
    /one strict flat \x60resourceBudgetSchema\x60 with (\d+) integer limits/,
    (sources) => String(countMatches(sources.resourcePolicy, /defineResource\(\s*\n?\s*"[a-z0-9_]+"/g))
  ),
  fact(
    "protocol-value-count",
    "codexResourceOptionsFromBudget protocol values",
    /\x60codexResourceOptionsFromBudget\x60 maps all (\d+) protocol values/,
    (sources) => {
      const match = /codexResourceBudgetKeys\s*=\s*\[([\s\S]*?)\]/.exec(sources.codexResourceOptions);
      if (match === null) throw new Error("technical-plan-facts: could not read codexResourceBudgetKeys");
      return String(match[1].split(",").filter((entry) => entry.trim().length > 0).length);
    }
  ),
  fact(
    "source-module-count",
    "production package source closure",
    /currently (\d+) source modules across/,
    (sources) =>
      readNumber(sources.verifyProductionPackage, /productionPackageSourceCount = (\d+)/, "productionPackageSourceCount")
  ),
  fact(
    "route-count",
    "selected API route manifest size",
    /proves the \d+-registration\/(\d+)-route descriptor/,
    (sources) =>
      readNumber(sources.packageSmoke, /selectedApiRouteManifest\.length,\s*(\d+)/, "selectedApiRouteManifest length")
  ),
  fact(
    "registration-count",
    "selected API route composition size",
    /proves the (\d+)-registration\/\d+-route descriptor/,
    (sources) =>
      readNumber(
        sources.packageSmoke,
        /hostDeckSelectedApiRouteCompositionDescriptor\.length,\s*(\d+)/,
        "route composition descriptor length"
      )
  )
];

/**
 * @typedef {{
 *   planText: string,
 *   rootManifest: Record<string, unknown>,
 *   manifests: Record<string, Record<string, unknown>>,
 *   resourcePolicy: string,
 *   codexResourceOptions: string,
 *   codexBindingManifest: string,
 *   tailscaleObserver: string,
 *   verifyProductionPackage: string,
 *   packageSmoke: string
 * }} PlanFactSources
 */

/**
 * Compare every declared technical-plan fact against its authoritative source.
 * @param {PlanFactSources} sources
 * @returns {{ errors: string[], checked: number }}
 */
export function checkTechnicalPlanFacts(sources) {
  const errors = [];
  let checked = 0;

  for (const entry of technicalPlanFacts) {
    const matches = [...sources.planText.matchAll(new RegExp(entry.claim.source, "g"))];
    if (matches.length === 0) {
      errors.push(
        `technical plan: no claim found for ${entry.label} (${entry.id}); the plan was reworded, so re-verify the fact and update scripts/technical-plan-facts.mjs`
      );
      continue;
    }
    if (matches.length > 1) {
      errors.push(
        `technical plan: ${entry.label} (${entry.id}) is claimed ${matches.length} times; one fact must have one statement`
      );
      continue;
    }

    const claimed = matches[0][1];
    let actual;
    try {
      actual = entry.actual(sources);
    } catch (error) {
      errors.push(`technical plan: cannot resolve authoritative value for ${entry.label} (${entry.id}): ${error.message}`);
      continue;
    }

    checked += 1;
    if (actual === null) {
      errors.push(`technical plan: ${entry.label} (${entry.id}) is claimed as ${claimed} but is absent from the workspace`);
      continue;
    }
    if (actual !== claimed) {
      errors.push(`technical plan: ${entry.label} (${entry.id}) claims ${claimed} but the workspace has ${actual}`);
    }
  }

  return { errors, checked };
}
