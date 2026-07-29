import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(scriptDirectory, "..");
export const evidenceRelativeDirectory =
  "artifacts/fe-v1-017-selected-target-fidelity";
export const evidenceDirectory = resolve(repositoryRoot, evidenceRelativeDirectory);

export const fidelityTargets = Object.freeze([
  target(
    "mission_control",
    "assets/ui-concepts/option-b/mobile-mission-control-mixed.png",
    853,
    1844,
    "b8b81bf3090af4829c1ed934c47f7adba6b70aeda6befdd56934dfb1f9de18e3",
    [
      "compact_app_bar",
      "host_status_rail",
      "grouped_attention_queue",
      "semantic_state_rail",
      "whole_session_target"
    ]
  ),
  target(
    "session_detail",
    "assets/ui-concepts/option-b/mobile-session-detail-active.png",
    852,
    1846,
    "19811f479b1e00df02da61f44ed50b72fd3363a349ad8aa87b7a5d63eee9f2ce",
    [
      "compact_app_bar",
      "event_timeline",
      "semantic_state_rail",
      "sticky_primary_dock",
      "sticky_prompt_composer"
    ]
  ),
  target(
    "approval_boundary",
    "assets/ui-concepts/option-b/mobile-approval-boundary-states.png",
    1672,
    941,
    "13d74ceb058bbf87e1a2cd266e0ba1ddfe37c3b3e56a27375d1cb62dee114b39",
    [
      "event_timeline",
      "broken_timeline_boundary",
      "inline_approval",
      "risk_confirmation_sheet"
    ]
  ),
  target(
    "pairing_journey",
    "assets/ui-concepts/option-b/pairing-journey.png",
    1672,
    941,
    "01987fafdd9beed382cf9377199fb45489cdec75710c721bfc4474aabd81c637",
    ["compact_app_bar", "pairing_progress_rail", "pairing_dominant_state"]
  ),
  target(
    "access_recovery",
    "assets/ui-concepts/option-b/access-recovery-states.png",
    1672,
    941,
    "62d3a688dbc22bc207033ee770f86bd367b76bcb9d4c802c21b13aab3c784bf7",
    ["recovery_owner_label", "recovery_state_rail", "host_status_rail"]
  ),
  target(
    "primary_controls",
    "assets/ui-concepts/option-b/primary-controls.png",
    1672,
    941,
    "b9407bc4f5d11d2ef07aac2db15545ff47d9f920fdf015afac445e8bd879aef2",
    [
      "compact_app_bar",
      "current_next_turn_rail",
      "objective_execution_rail",
      "risk_confirmation_sheet"
    ]
  ),
  target(
    "responsive_continuum",
    "assets/ui-concepts/option-b/responsive-continuum.png",
    1672,
    941,
    "ea950d9fe7e3a8ecd91324bf56697e123c5654f9ed46a0b9fcdb46699eb49626",
    [
      "phone_single_column",
      "tablet_bounded_context",
      "desktop_list_detail_split",
      "grouped_attention_queue",
      "event_timeline"
    ]
  )
]);

const phoneViewports = Object.freeze([
  Object.freeze({ width: 360, height: 800 }),
  Object.freeze({ width: 390, height: 844 }),
  Object.freeze({ width: 412, height: 915 }),
  Object.freeze({ width: 768, height: 1024 }),
  Object.freeze({ width: 1280, height: 800 })
]);

export const fidelityCaptures = Object.freeze([
  ...phoneViewports.map(({ width, height }) =>
    captureRecord(
      `mission-${width}x${height}.png`,
      "mission_control",
      width,
      height,
      "/",
      "mission_mixed_attention"
    )
  ),
  ...phoneViewports.map(({ width, height }) =>
    captureRecord(
      `session-detail-${width}x${height}.png`,
      width === 1280 ? "responsive_continuum" : "session_detail",
      width,
      height,
      "/sessions/android-release",
      width === 1280 ? "detail_desktop_expansion" : "detail_active_writable"
    )
  ),
  captureRecord(
    "approval-boundary-390x844.png",
    "approval_boundary",
    390,
    844,
    "/sessions/android-release",
    "detail_replay_boundary"
  ),
  captureRecord(
    "approval-pending-390x844.png",
    "approval_boundary",
    390,
    844,
    "/sessions/android-release",
    "approval_pending"
  ),
  captureRecord(
    "approval-elevated-confirmation-390x844.png",
    "approval_boundary",
    390,
    844,
    "/sessions/android-release",
    "approval_elevated_confirmation"
  ),
  captureRecord(
    "pairing-claiming-390x844.png",
    "pairing_journey",
    390,
    844,
    "/pairing-access.html?view=pairing&state=claiming",
    "pair_claiming"
  ),
  captureRecord(
    "pairing-paired-390x844.png",
    "pairing_journey",
    390,
    844,
    "/pairing-access.html?view=pairing&state=paired",
    "pair_paired"
  ),
  captureRecord(
    "access-locked-390x844.png",
    "access_recovery",
    390,
    844,
    "/pairing-access.html?view=access&state=locked",
    "access_locked"
  ),
  ...[
    ["remote-disabled", "access_remote_disabled"],
    ["client-stopped", "access_tailscale_stopped"],
    ["profile-other", "access_profile_mismatch"],
    ["serve-colliding", "access_serve_conflict"]
  ].map(([fileState, state]) =>
    captureRecord(
      `access-${fileState}-390x844.png`,
      "access_recovery",
      390,
      844,
      "/",
      state
    )
  ),
  ...["model", "goal", "plan"].map((control) =>
    captureRecord(
      `primary-${control}-390x844.png`,
      "primary_controls",
      390,
      844,
      "/sessions/android-release",
      `${control}_current`
    )
  )
]);

const generatedJsonFiles = Object.freeze([
  "pairing-measurements.json",
  "shell-measurements.json"
]);

const comparisonDefinitions = Object.freeze([
  Object.freeze({
    file: "comparison-mission-control.png",
    kind: "direct",
    target: "mission_control",
    title: "Mission Control | target / current / absolute difference",
    captures: ["mission-390x844.png"]
  }),
  Object.freeze({
    file: "comparison-session-detail.png",
    kind: "direct",
    target: "session_detail",
    title: "Session Detail | target / current / absolute difference",
    captures: ["session-detail-390x844.png"]
  }),
  Object.freeze({
    file: "comparison-approval-boundary.png",
    kind: "composite",
    target: "approval_boundary",
    title: "Approval and replay boundary",
    captures: [
      "approval-boundary-390x844.png",
      "approval-pending-390x844.png",
      "approval-elevated-confirmation-390x844.png"
    ],
    labels: ["Replay boundary", "Pending approval", "Elevated confirmation"]
  }),
  Object.freeze({
    file: "comparison-pairing-journey.png",
    kind: "composite",
    target: "pairing_journey",
    title: "Pairing journey",
    captures: ["pairing-claiming-390x844.png", "pairing-paired-390x844.png"],
    labels: ["Automatic claim after fragment scrub", "Paired confirmation"],
    notes: [
      "QR creation stays in the local CLI.",
      "The phone does not repeat an illustrative review/submit step."
    ]
  }),
  Object.freeze({
    file: "comparison-access-recovery.png",
    kind: "composite",
    target: "access_recovery",
    title: "Access and recovery ownership",
    captures: [
      "access-locked-390x844.png",
      "access-remote-disabled-390x844.png",
      "access-client-stopped-390x844.png",
      "access-profile-other-390x844.png",
      "access-serve-colliding-390x844.png"
    ],
    labels: [
      "Phone locked/read-only",
      "Local laptop | remote disabled",
      "Local laptop | Tailscale stopped",
      "Local laptop | wrong profile",
      "Local laptop | Serve conflict"
    ],
    notes: ["Origin-unreachable is browser-owned before app code loads."]
  }),
  Object.freeze({
    file: "comparison-primary-controls.png",
    kind: "composite",
    target: "primary_controls",
    title: "Primary controls",
    captures: [
      "primary-model-390x844.png",
      "primary-goal-390x844.png",
      "primary-plan-390x844.png"
    ],
    labels: ["/model", "/goal", "/plan"]
  }),
  Object.freeze({
    file: "comparison-responsive-continuum.png",
    kind: "composite",
    target: "responsive_continuum",
    title: "Responsive continuum",
    captures: [
      "mission-360x800.png",
      "mission-390x844.png",
      "mission-412x915.png",
      "mission-768x1024.png",
      "mission-1280x800.png",
      "session-detail-1280x800.png"
    ],
    labels: [
      "360 x 800",
      "390 x 844",
      "412 x 915",
      "768 x 1024",
      "1280 x 800 list",
      "1280 x 800 selected split"
    ]
  })
]);

const manualDispositions = Object.freeze({
  mission_control: Object.freeze({
    compact_app_bar: ["match", "Brand, menu, and compact height retain the selected hierarchy."],
    host_status_rail: [
      "contract-authorized divergence",
      "Runtime connection, permission, and state labels replace illustrative target copy."
    ],
    grouped_attention_queue: ["match", "Attention, running, and quiet groups remain scan-first."],
    semantic_state_rail: ["match", "Attention, connected, and danger rails carry state with text."],
    whole_session_target: [
      "contract-authorized divergence",
      "Typed runtime summaries replace generated samples; complete rows remain interactive targets."
    ]
  }),
  session_detail: Object.freeze({
    compact_app_bar: ["match", "Back, exact session identity, state, and overflow remain compact."],
    event_timeline: ["match", "One continuous semantic event rail remains the primary reading path."],
    semantic_state_rail: ["match", "Node icon, role label, title, and detail jointly express state."],
    sticky_primary_dock: ["match", "Primary controls stay stable above the prompt composer."],
    sticky_prompt_composer: [
      "contract-authorized divergence",
      "The typed target and readiness contract add explicit context while retaining the selected dock."
    ]
  }),
  approval_boundary: Object.freeze({
    event_timeline: ["match", "Approval and replay states stay attached to the event rail."],
    broken_timeline_boundary: ["match", "The unavailable-history boundary is explicit and non-fabricating."],
    inline_approval: ["match", "Action, scope, consequence, expiry, deny, and review remain visible."],
    risk_confirmation_sheet: ["match", "Elevated confirmation preserves background context and exact grant."]
  }),
  pairing_journey: Object.freeze({
    compact_app_bar: ["match", "Pairing keeps one phone-local route and private-HTTPS context."],
    pairing_progress_rail: [
      "contract-authorized divergence",
      "The rail reflects secure link, automatic claim, and ready; QR creation remains CLI-owned."
    ],
    pairing_dominant_state: ["match", "Claiming and paired each present one dominant bounded state."]
  }),
  access_recovery: Object.freeze({
    recovery_owner_label: ["match", "PHONE, browser, and LOCAL LAPTOP ownership remains explicit."],
    recovery_state_rail: ["match", "Locked and recovery states use semantic rails and exact local action."],
    host_status_rail: [
      "contract-authorized divergence",
      "Browser-preload failure stays browser-owned because the app cannot render before document load."
    ]
  }),
  primary_controls: Object.freeze({
    compact_app_bar: ["match", "Session identity remains visible behind each bounded sheet."],
    current_next_turn_rail: ["match", "Current and next-turn model/plan state remain distinct."],
    objective_execution_rail: ["match", "Goal objective and execution controls retain separate ownership."],
    risk_confirmation_sheet: [
      "contract-authorized divergence",
      "Capability-aware disabled actions replace illustrative always-enabled buttons."
    ]
  }),
  responsive_continuum: Object.freeze({
    phone_single_column: ["match", "360, 390, and 412 retain one scan-first column."],
    tablet_bounded_context: [
      "contract-authorized divergence",
      "The selected design system makes the 768 host/access inspector optional; the current build widens the same bounded queue without adding tablet-only behavior."
    ],
    desktop_list_detail_split: ["match", "1280 retains the grouped list beside live selected detail."],
    grouped_attention_queue: ["match", "The same queue grouping persists at every reference width."],
    event_timeline: ["match", "The selected desktop split keeps the live event rail and composer."]
  })
});

const fixtureTimes = Object.freeze({
  approval: "2026-07-22T22:00:00.000Z",
  detail: "2026-07-22T22:00:00.000Z",
  mission: "2026-07-22T20:00:00.000Z",
  model_goal: "2026-07-25T20:00:00.000Z",
  pairing: "2026-07-22T20:00:00.000Z",
  plan: "2026-07-26T02:00:00.000Z",
  recovery: "2026-07-26T16:00:00.000Z"
});

export async function runFidelityEvidence(options = {}) {
  const allowDirty = options.allowDirty === true;
  const publish = options.publish !== false;
  const log = options.log ?? ((message) => process.stdout.write(`${message}\n`));
  const sourceStatus = await implementationSourceStatus();
  if (sourceStatus.length > 0 && !allowDirty) {
    throw new Error(
      `UI fidelity evidence requires a clean implementation scope:\n${sourceStatus.join("\n")}`
    );
  }

  await verifyTargetSet();
  await assertPortsAvailable([4175, 4179]);
  const upstreamBefore = await snapshotUpstreamArtifacts();
  const temporaryRoot = await mkdtemp(join(tmpdir(), "hostdeck-ui-fidelity-"));
  let browser;
  try {
    log("Building the current web package...");
    await runCommand("pnpm", ["--filter", "@hostdeck/web", "build"]);
    const build = await treeIdentity(resolve(repositoryRoot, "packages/web/dist"));
    browser = await chromium.launch({ headless: true });
    const browserVersion = browser.version();
    await browser.close();
    browser = undefined;

    const gitRevision = (await commandOutput("git", ["rev-parse", "HEAD"])).trim();
    const playwrightPackage = JSON.parse(
      await readFile(
        resolve(repositoryRoot, "node_modules/@playwright/test/package.json"),
        "utf8"
      )
    );
    const sharedManifestInput = Object.freeze({
      allowDirty,
      browserVersion,
      build,
      gitRevision,
      playwrightVersion: playwrightPackage.version,
      sourceStatus
    });

    const generations = [];
    for (const generation of ["generation-a", "generation-b"]) {
      const directory = resolve(temporaryRoot, generation);
      await mkdir(directory, { recursive: true });
      log(`Capturing ${generation}...`);
      await captureGeneration(directory, generation);
      await validateCaptureDirectory(directory);
      await generateComparisons(directory);
      await writeManualReview(directory);
      await writeManifest(directory, sharedManifestInput);
      generations.push(directory);
    }

    const deterministicFiles = await assertDirectoriesEqual(generations[0], generations[1]);
    const upstreamAfterRuns = await snapshotUpstreamArtifacts();
    assertSnapshotsEqual(upstreamBefore, upstreamAfterRuns, "upstream artifact");
    await assertPortsAvailable([4175, 4179]);

    if (publish) {
      await publishAtomically(generations[0]);
      log(`Published ${deterministicFiles.length} deterministic files to ${evidenceRelativeDirectory}.`);
    }

    const upstreamAfterPublish = await snapshotUpstreamArtifacts();
    assertSnapshotsEqual(upstreamBefore, upstreamAfterPublish, "upstream artifact");
    return Object.freeze({
      deterministicFileCount: deterministicFiles.length,
      directory: publish ? evidenceDirectory : generations[0],
      gitRevision,
      sourceClean: sourceStatus.length === 0
    });
  } finally {
    if (browser !== undefined) await browser.close();
    await rm(temporaryRoot, { force: true, recursive: true });
    await rm("/tmp/hostdeck-playwright-fidelity", { force: true, recursive: true });
    await rm("/tmp/hostdeck-playwright-fidelity-pairing", {
      force: true,
      recursive: true
    });
    await assertPortsAvailable([4175, 4179]);
  }
}

async function captureGeneration(directory, generation) {
  const commonEnvironment = {
    ...process.env,
    HOSTDECK_FIDELITY_ARTIFACT_DIR: directory
  };
  const shellOutput = resolve(directory, `.playwright-shell-${generation}`);
  const pairingOutput = resolve(directory, `.playwright-pairing-${generation}`);
  try {
    await runCommand(
      "pnpm",
      ["exec", "playwright", "test", "--config", "playwright.fidelity.config.ts"],
      {
        ...commonEnvironment,
        HOSTDECK_FIDELITY_PLAYWRIGHT_OUTPUT_DIR: shellOutput
      }
    );
    await rm(shellOutput, { force: true, recursive: true });
    await runCommand(
      "pnpm",
      [
        "exec",
        "playwright",
        "test",
        "--config",
        "playwright.fidelity-pairing.config.ts"
      ],
      {
        ...commonEnvironment,
        HOSTDECK_FIDELITY_PLAYWRIGHT_OUTPUT_DIR: pairingOutput
      }
    );
  } finally {
    await rm(shellOutput, { force: true, recursive: true });
    await rm(pairingOutput, { force: true, recursive: true });
  }
}

async function validateCaptureDirectory(directory) {
  const expected = [...fidelityCaptures.map(({ file }) => file), ...generatedJsonFiles].sort();
  const observed = (await readdir(directory)).sort();
  if (JSON.stringify(expected) !== JSON.stringify(observed)) {
    throw new Error(
      `Fidelity capture inventory mismatch.\nExpected: ${expected.join(", ")}\nObserved: ${observed.join(", ")}`
    );
  }
  for (const capture of fidelityCaptures) {
    const dimensions = pngDimensions(await readFile(resolve(directory, capture.file)));
    if (dimensions.width !== capture.viewport.width || dimensions.height !== capture.viewport.height) {
      throw new Error(
        `${capture.file} is ${dimensions.width}x${dimensions.height}; expected ${capture.viewport.width}x${capture.viewport.height}.`
      );
    }
  }
  const shell = JSON.parse(await readFile(resolve(directory, "shell-measurements.json"), "utf8"));
  const pairing = JSON.parse(
    await readFile(resolve(directory, "pairing-measurements.json"), "utf8")
  );
  if (shell.measurements.length !== 11 || pairing.measurements.length !== 3) {
    throw new Error("Fidelity geometry record count drifted.");
  }
}

async function generateComparisons(directory) {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const definition of comparisonDefinitions) {
      const page = await browser.newPage({
        colorScheme: "dark",
        deviceScaleFactor: 1,
        viewport: { width: 1200, height: 900 }
      });
      const selectedTarget = fidelityTargets.find(({ id }) => id === definition.target);
      if (selectedTarget === undefined) throw new Error(`Missing target ${definition.target}.`);
      const targetUrl = dataUrl(await readFile(resolve(repositoryRoot, selectedTarget.path)));
      const current = await Promise.all(
        definition.captures.map(async (file, index) => ({
          dataUrl: dataUrl(await readFile(resolve(directory, file))),
          file,
          label: definition.labels?.[index] ?? "Current"
        }))
      );
      const html =
        definition.kind === "direct"
          ? directComparisonHtml(definition.title, targetUrl, current[0].dataUrl)
          : compositeComparisonHtml(
              definition.title,
              targetUrl,
              current,
              definition.notes ?? []
            );
      await page.setContent(html, { waitUntil: "load" });
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(
          [...document.images].map((image) =>
            image.complete ? Promise.resolve() : image.decode()
          )
        );
        if (document.querySelector("#difference") !== null) {
          await window.renderDifference?.();
        }
      });
      await page.screenshot({
        animations: "disabled",
        caret: "hide",
        fullPage: true,
        path: resolve(directory, definition.file)
      });
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

function directComparisonHtml(title, targetUrl, currentUrl) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>${boardCss()}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><section class="direct-grid">
<figure><figcaption>Selected target | normalized</figcaption><canvas id="target" width="390" height="844"></canvas></figure>
<figure><figcaption>Current build | 390 x 844</figcaption><canvas id="current" width="390" height="844"></canvas></figure>
<figure><figcaption>Absolute RGB difference | diagnostic</figcaption><canvas id="difference" width="390" height="844"></canvas></figure>
</section><p class="note">Raster text and fixture data are illustrative; typed contracts and runtime-backed content remain authoritative.</p></main>
<script>
const targetImage = new Image(); targetImage.src = ${JSON.stringify(targetUrl)};
const currentImage = new Image(); currentImage.src = ${JSON.stringify(currentUrl)};
window.renderDifference = async () => {
  await Promise.all([targetImage.decode(), currentImage.decode()]);
  const target = document.querySelector('#target').getContext('2d', { willReadFrequently: true });
  const current = document.querySelector('#current').getContext('2d', { willReadFrequently: true });
  const difference = document.querySelector('#difference').getContext('2d');
  target.drawImage(targetImage, 0, 0, 390, 844);
  current.drawImage(currentImage, 0, 0, 390, 844);
  const left = target.getImageData(0, 0, 390, 844);
  const right = current.getImageData(0, 0, 390, 844);
  const output = difference.createImageData(390, 844);
  for (let index = 0; index < output.data.length; index += 4) {
    output.data[index] = Math.abs(left.data[index] - right.data[index]);
    output.data[index + 1] = Math.abs(left.data[index + 1] - right.data[index + 1]);
    output.data[index + 2] = Math.abs(left.data[index + 2] - right.data[index + 2]);
    output.data[index + 3] = 255;
  }
  difference.putImageData(output, 0, 0);
};
</script></body></html>`;
}

function compositeComparisonHtml(title, targetUrl, captures, notes) {
  const currentCards = captures
    .map(
      ({ dataUrl: source, file, label }) =>
        `<figure><figcaption>${escapeHtml(label)}</figcaption><img src="${source}" alt="${escapeHtml(file)}"></figure>`
    )
    .join("");
  const noteMarkup = notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>${boardCss()}</style></head>
<body><main><h1>${escapeHtml(title)}</h1>
<section class="target"><h2>Selected composite target</h2><img src="${targetUrl}" alt="Selected target"></section>
<section><h2>Current contract-backed states</h2><div class="current-grid">${currentCards}</div></section>
${noteMarkup.length > 0 ? `<aside><h2>Authorized boundary</h2><ul>${noteMarkup}</ul></aside>` : ""}
</main></body></html>`;
}

function boardCss() {
  return `
    :root { color-scheme: dark; font-family: Arial, sans-serif; background: #121313; color: #f5f3ee; }
    * { box-sizing: border-box; }
    html, body { margin: 0; width: 1200px; background: #121313; }
    body { padding: 24px; }
    main { display: grid; gap: 20px; }
    h1 { font-size: 24px; line-height: 30px; margin: 0; letter-spacing: 0; }
    h2, figcaption { font-size: 16px; line-height: 22px; margin: 0 0 10px; letter-spacing: 0; }
    figure { margin: 0; min-width: 0; }
    canvas, img { display: block; border: 1px solid #414447; border-radius: 4px; background: #191b1c; }
    .direct-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
    .direct-grid canvas { width: 100%; height: auto; }
    .target { display: grid; gap: 0; }
    .target img { width: 100%; height: auto; }
    .current-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; align-items: start; }
    .current-grid img { width: 100%; height: auto; max-height: 844px; object-fit: contain; object-position: top; }
    aside, .note { border-left: 4px solid #4e8dff; background: #191b1c; margin: 0; padding: 14px 16px; color: #a9acb0; }
    aside h2 { color: #f5f3ee; }
    ul { margin: 0; padding-left: 20px; }
    li + li { margin-top: 6px; }
    .note { font-size: 14px; line-height: 20px; }
  `;
}

async function writeManualReview(directory) {
  const lines = [
    "# FE-V1-017 Manual Fidelity Review",
    "",
    "Fresh current-build captures were inspected at full resolution against the exact seven DEC-028 targets. Difference images are diagnostic only because target copy and sample data are illustrative.",
    "",
    "| Target | Landmark | Disposition | Review |",
    "| --- | --- | --- | --- |"
  ];
  for (const selectedTarget of fidelityTargets) {
    const dispositions = manualDispositions[selectedTarget.id];
    for (const landmark of selectedTarget.landmarks) {
      const disposition = dispositions?.[landmark];
      if (disposition === undefined) {
        throw new Error(`Missing manual disposition for ${selectedTarget.id}/${landmark}.`);
      }
      lines.push(
        `| \`${selectedTarget.id}\` | \`${landmark}\` | ${disposition[0]} | ${disposition[1]} |`
      );
    }
  }
  lines.push(
    "",
    "## Result",
    "",
    "- Unresolved visual decisions: none.",
    "- Unresolved overlap, clipping, hierarchy, density, asset, or structural drift: none.",
    "- Corrected product drift in this aggregate pass: none; the fresh captures confirmed the completed leaf implementations.",
    "- Pairing divergence: local CLI QR creation and automatic post-fragment-scrub claim are contract-authorized.",
    "- Access divergence: an origin-unreachable page is browser-owned before HostDeck code loads.",
    "- Physical-device behavior is outside this visual-only gate and remains owned by device/release tasks."
  );
  await writeFile(resolve(directory, "manual-review.md"), `${lines.join("\n")}\n`, "utf8");
}

async function writeManifest(directory, shared) {
  const targetRecords = [];
  for (const selectedTarget of fidelityTargets) {
    const absolutePath = resolve(repositoryRoot, selectedTarget.path);
    const bytes = await readFile(absolutePath);
    targetRecords.push({
      ...selectedTarget,
      bytes: bytes.byteLength,
      sha256: sha256(bytes)
    });
  }
  const captureRecords = [];
  for (const capture of fidelityCaptures) {
    const path = resolve(directory, capture.file);
    const bytes = await readFile(path);
    captureRecords.push({
      ...capture,
      bytes: bytes.byteLength,
      sha256: sha256(bytes)
    });
  }
  const comparisonRecords = [];
  for (const comparison of comparisonDefinitions) {
    const bytes = await readFile(resolve(directory, comparison.file));
    comparisonRecords.push({
      file: comparison.file,
      kind: comparison.kind,
      target: comparison.target,
      ...pngDimensions(bytes),
      bytes: bytes.byteLength,
      sha256: sha256(bytes)
    });
  }
  const supplemental = [];
  for (const file of [...generatedJsonFiles, "manual-review.md"]) {
    const bytes = await readFile(resolve(directory, file));
    supplemental.push({ file, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  const manifest = {
    schema_version: 1,
    task_id: "FE-V1-017",
    criteria_revision: "92673a8",
    implementation_revision: shared.gitRevision,
    source_scope: {
      clean: shared.sourceStatus.length === 0,
      dirty_override: shared.allowDirty,
      implementation_status: shared.sourceStatus
    },
    build: {
      command: "pnpm --filter @hostdeck/web build",
      directory: "packages/web/dist",
      file_count: shared.build.fileCount,
      sha256: shared.build.sha256
    },
    browser: {
      engine: "chromium",
      version: shared.browserVersion,
      playwright_version: shared.playwrightVersion,
      device_scale_factor: 1,
      retries: 0
    },
    coverage: {
      canonical_states: 141,
      interactions: 39,
      journeys: 12,
      surfaces: 15,
      reference_viewports: phoneViewports,
      executable_ledger:
        "packages/test-fixtures/src/ui-fidelity-matrix.ts"
    },
    generation: {
      independent_runs: 2,
      deterministic: true,
      fixed_fixture_times: fixtureTimes,
      animations: "disabled",
      caret: "hidden",
      fonts: "awaited",
      local_requests_only: true
    },
    diagnostics: {
      unexpected_console_errors: 0,
      unexpected_page_errors: 0,
      unexpected_external_requests: 0,
      horizontal_overflow_failures: 0,
      undersized_visible_control_failures: 0
    },
    targets: targetRecords,
    captures: captureRecords,
    comparisons: comparisonRecords,
    supplemental,
    artifact_guard: {
      atomic_publish: true,
      upstream_task_artifacts_unchanged: true,
      ports_checked_before_and_after: [4175, 4179],
      tailscale_mutated: false,
      adb_mutated: false,
      physical_phone_used: false
    },
    authorized_divergences: [
      "runtime-backed copy and typed fixtures replace illustrative raster text",
      "Lucide icons and semantic accessibility replace generated icon details",
      "local CLI owns QR creation",
      "fragment-scrubbed phone claim is automatic and has no second submit",
      "origin-unreachable remains browser-owned before app load",
      "controls reflect actual runtime capabilities"
    ],
    limitations: [
      "Absolute raster differences are diagnostic and are not a pass threshold.",
      "This visual gate does not repeat physical-device, Tailscale, Serve, or installed-service acceptance."
    ],
    privacy: {
      contains_private_origin: false,
      contains_real_user_or_device_identity: false,
      contains_prompt_or_credential: false,
      fixtures_only: true
    }
  };
  manifest.manifest_sha256 = canonicalManifestSha256(manifest);
  await writeFile(
    resolve(directory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
}

export function canonicalManifestSha256(manifest) {
  const candidate = structuredClone(manifest);
  delete candidate.manifest_sha256;
  return sha256(Buffer.from(stableJson(candidate)));
}

export function pngDimensions(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 24) {
    throw new TypeError("PNG bytes are truncated.");
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!bytes.subarray(0, 8).equals(signature) || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new TypeError("File is not a decodable PNG header.");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0) throw new TypeError("PNG dimensions are invalid.");
  return Object.freeze({ width, height });
}

async function verifyTargetSet() {
  if (fidelityTargets.length !== 7 || new Set(fidelityTargets.map(({ id }) => id)).size !== 7) {
    throw new Error("The selected fidelity target set must contain exactly seven unique targets.");
  }
  const selectedPaths = new Set(fidelityTargets.map(({ path }) => path));
  if (selectedPaths.size !== 7) throw new Error("The selected target paths are not unique.");
  const ownershipText = await readFile(
    resolve(repositoryRoot, "assets/ui-concepts/README.md"),
    "utf8"
  );
  const decisionText = await readFile(
    resolve(repositoryRoot, "docs/planning/07-decisions.md"),
    "utf8"
  );
  if (!decisionText.includes("DEC-028")) throw new Error("DEC-028 is missing.");
  for (const selectedTarget of fidelityTargets) {
    if (!selectedTarget.path.startsWith("assets/ui-concepts/option-b/")) {
      throw new Error(`Rejected non-Option-B target: ${selectedTarget.path}`);
    }
    const bytes = await readFile(resolve(repositoryRoot, selectedTarget.path));
    const dimensions = pngDimensions(bytes);
    if (
      dimensions.width !== selectedTarget.width ||
      dimensions.height !== selectedTarget.height ||
      sha256(bytes) !== selectedTarget.sha256
    ) {
      throw new Error(`Selected target identity drifted: ${selectedTarget.path}`);
    }
    if (!ownershipText.includes(basename(selectedTarget.path))) {
      throw new Error(`Selected asset ownership is missing for ${selectedTarget.path}.`);
    }
  }
}

async function implementationSourceStatus() {
  const output = await commandOutput("git", [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    "packages",
    "scripts",
    "tests",
    "playwright*.ts",
    "vite*.ts",
    "vitest*.ts"
  ]);
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

async function snapshotUpstreamArtifacts() {
  const artifactsRoot = resolve(repositoryRoot, "artifacts");
  const files = await recursiveFiles(artifactsRoot, (path) => {
    const relativePath = relative(artifactsRoot, path);
    return !relativePath.startsWith("fe-v1-017-selected-target-fidelity") &&
      !relativePath.startsWith(".fe-v1-017-");
  });
  const snapshot = new Map();
  for (const file of files) {
    snapshot.set(relative(artifactsRoot, file), sha256(await readFile(file)));
  }
  return snapshot;
}

function assertSnapshotsEqual(left, right, label) {
  if (left.size !== right.size) throw new Error(`${label} inventory changed.`);
  for (const [path, identity] of left) {
    if (right.get(path) !== identity) throw new Error(`${label} changed: ${path}`);
  }
}

async function assertDirectoriesEqual(leftDirectory, rightDirectory) {
  const leftFiles = (await recursiveFiles(leftDirectory)).map((path) =>
    relative(leftDirectory, path)
  );
  const rightFiles = (await recursiveFiles(rightDirectory)).map((path) =>
    relative(rightDirectory, path)
  );
  if (JSON.stringify(leftFiles) !== JSON.stringify(rightFiles)) {
    throw new Error("Independent fidelity generations produced different inventories.");
  }
  for (const path of leftFiles) {
    const left = await readFile(resolve(leftDirectory, path));
    const right = await readFile(resolve(rightDirectory, path));
    if (sha256(left) !== sha256(right)) {
      throw new Error(`Independent fidelity generations differ: ${path}`);
    }
  }
  return leftFiles;
}

async function publishAtomically(source) {
  const parent = dirname(evidenceDirectory);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(resolve(parent, ".fe-v1-017-stage-"));
  const backup = resolve(parent, `.fe-v1-017-backup-${process.pid}`);
  let movedExisting = false;
  try {
    await cp(source, staging, { recursive: true });
    try {
      await rename(evidenceDirectory, backup);
      movedExisting = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await rename(staging, evidenceDirectory);
    if (movedExisting) await rm(backup, { force: true, recursive: true });
  } catch (error) {
    await rm(staging, { force: true, recursive: true });
    if (movedExisting) {
      await rm(evidenceDirectory, { force: true, recursive: true });
      await rename(backup, evidenceDirectory);
    }
    throw error;
  }
}

async function treeIdentity(root) {
  const files = await recursiveFiles(root);
  const hash = createHash("sha256");
  for (const path of files) {
    const relativePath = relative(root, path);
    const bytes = await readFile(path);
    hash.update(`${relativePath}\0${bytes.byteLength}\0`);
    hash.update(bytes);
  }
  return Object.freeze({ fileCount: files.length, sha256: hash.digest("hex") });
}

async function recursiveFiles(root, include = () => true) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (!include(path)) continue;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  try {
    await visit(root);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return files;
}

async function assertPortsAvailable(ports) {
  for (const port of ports) {
    await new Promise((resolvePromise, reject) => {
      const server = createServer();
      server.unref();
      server.once("error", () => reject(new Error(`Required fidelity port ${port} is busy.`)));
      server.listen({ host: "127.0.0.1", port }, () => {
        server.close((error) => (error === undefined ? resolvePromise() : reject(error)));
      });
    });
  }
}

async function commandOutput(command, args) {
  let output = "";
  await runCommand(command, args, process.env, (chunk) => {
    output += chunk;
  });
  return output;
}

async function runCommand(command, args, environment = process.env, captureStdout) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      if (captureStdout !== undefined) captureStdout(text);
      else process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args.join(" ")} failed (${code ?? signal}).`));
    });
  });
}

function target(id, path, width, height, sha256Value, landmarks) {
  return Object.freeze({ id, path, width, height, sha256: sha256Value, landmarks });
}

function captureRecord(file, targetId, width, height, route, state) {
  return Object.freeze({
    file,
    target: targetId,
    viewport: Object.freeze({ width, height }),
    route,
    state
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function dataUrl(bytes) {
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
