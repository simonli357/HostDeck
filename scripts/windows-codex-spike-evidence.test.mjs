import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createWindowsCodexSpikeEvidence,
  parseWindowsCodexSpikeEvidence,
  serializeWindowsCodexSpikeEvidence,
  verifyWindowsCodexSpikeEvidenceFile,
  windowsCodexSpikeRuntimePolicy,
  writeWindowsCodexSpikeEvidence
} from "./windows-codex-spike-evidence.mjs";

test("accepts one exact redacted Windows Codex spike result", () => {
  const evidence = createWindowsCodexSpikeEvidence(fixture());
  assert.equal(evidence.status, "passed");
  assert.equal(evidence.runtime.cli_version, "0.144.0");
  assert.deepEqual(parseWindowsCodexSpikeEvidence(evidence), evidence);
  assert.equal(Object.isFrozen(evidence.observations.resume), true);
  assert.equal(serializeWindowsCodexSpikeEvidence(evidence).endsWith("\n"), true);
});

test("rejects partial, contradictory, and private evidence", () => {
  const baseline = fixture();
  const mutations = [
    { ...baseline, observations: { ...baseline.observations, resume: undefined } },
    {
      ...baseline,
      observations: {
        ...baseline.observations,
        authentication: { ...baseline.observations.authentication, invalid_status: 101 }
      }
    },
    {
      ...baseline,
      observations: {
        ...baseline.observations,
        privacy: { ...baseline.observations.privacy, credential_value_found: true }
      }
    },
    { ...baseline, runtime: { ...baseline.runtime, cli_version: "0.146.0" } },
    { ...baseline, private_path: "C:\\Users\\private" }
  ];
  for (const mutation of mutations) {
    assert.throws(() => createWindowsCodexSpikeEvidence(mutation));
  }
  assert.throws(() =>
    serializeWindowsCodexSpikeEvidence({
      ...createWindowsCodexSpikeEvidence(baseline),
      runner: { ...baseline.runner, image_version: "https://private.invalid" }
    })
  );
});

test("writes and independently verifies canonical digest-bound evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "hostdeck-windows-codex-evidence-"));
  try {
    const path = join(root, "int-v1-100.json");
    const expected = createWindowsCodexSpikeEvidence(fixture());
    writeWindowsCodexSpikeEvidence(path, fixture());
    assert.deepEqual(verifyWindowsCodexSpikeEvidenceFile(path), expected);
    assert.match(
      readFileSync(`${path}.sha256`, "utf8"),
      /^[a-f0-9]{64} {2}int-v1-100\.json\n$/u
    );

    writeFileSync(`${path}.sha256`, `${"0".repeat(64)}  int-v1-100.json\n`);
    assert.throws(() => verifyWindowsCodexSpikeEvidenceFile(path), /digest is invalid/u);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

function fixture() {
  return {
    generated_at: "2026-08-11T08:00:00.000Z",
    workflow: { run_attempt: 1, run_id: "123456789" },
    source: {
      commit: "1".repeat(40),
      lockfile_sha256: "2".repeat(64)
    },
    runner: {
      architecture: "x64",
      image_version: "20260810.1.0",
      label: "windows-2022",
      node_platform: "win32",
      os_release: "10.0.20348"
    },
    runtime: { ...windowsCodexSpikeRuntimePolicy },
    observations: {
      authentication: {
        accepted: true,
        invalid_status: 401,
        missing_status: 401,
        origin_status: 403
      },
      capabilities: {
        collaboration_modes: ["default", "plan"],
        experimental_api: true
      },
      initialization: {
        client_name: "hostdeck-windows-spike",
        platform_family: "windows",
        platform_os: "windows",
        version_corroborated: true
      },
      multi_client: { initialized_clients: 2, survived_peer_close: true },
      process: {
        address: "127.0.0.1",
        argv_clean: true,
        credential_acl: "current-user-only",
        listener_count: 1
      },
      resume: {
        credential_via_environment: true,
        rendered_thread: true,
        thread_turn_count: 0
      },
      privacy: { capture_scanned: true, credential_value_found: false },
      shutdown: {
        credential_file_removed: true,
        listener_closed: true,
        process_exited: true
      }
    }
  };
}
