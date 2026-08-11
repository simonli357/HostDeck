import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWindowsStructuredVerticalReport,
  parseWindowsStructuredVerticalReport,
  publishWindowsStructuredVerticalReport,
  readWindowsStructuredVerticalReport,
  requireWindowsStructuredVerticalReportPath,
  windowsStructuredVerticalReportName
} from "./codex-windows-structured-vertical-report.js";

const commit = "a".repeat(40);

describe("Windows structured vertical report", () => {
  it("creates one exact frozen aggregate with restart and privacy truth", () => {
    const report = validReport();

    expect(report).toMatchObject({
      task: "INT-V1-104",
      hostdeck_commit: commit,
      runtime: {
        app_server_process_count: 2,
        connection_generation_count: 2,
        endpoint_rotation_count: 1,
        credential_rotation_count: 1
      },
      execution: {
        managed_thread_count: 2,
        turn_start_count: 3,
        proof_count: 17,
        aggregate_retry_count: 0
      },
      continuity: {
        completed_reconnects: 1,
        boundary_count: 2,
        ready_count: 2
      },
      cleanup: {
        app_servers_remaining: 0,
        listeners_remaining: 0,
        credential_files_remaining: 0,
        temporary_roots_remaining: 0
      }
    });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.continuity)).toBe(true);
  });

  it("rejects partial, retried, contradictory, stale, and private evidence", () => {
    const report = validReport();
    const invalid = [
      { ...report, extra: true },
      {
        ...report,
        execution: { ...report.execution, aggregate_retry_count: 1 }
      },
      {
        ...report,
        runtime: { ...report.runtime, connection_generation_count: 1 }
      },
      {
        ...report,
        continuity: { ...report.continuity, boundary_count: 1 }
      },
      {
        ...report,
        privacy: { ...report.privacy, contains_path: true }
      },
      {
        ...report,
        cleanup: { ...report.cleanup, listeners_remaining: 1 }
      }
    ];

    for (const candidate of invalid) {
      expect(() => parseWindowsStructuredVerticalReport(candidate)).toThrow();
    }
    expect(() =>
      parseWindowsStructuredVerticalReport(report, "b".repeat(40))
    ).toThrow("Windows structured vertical report commit does not match.");
  });

  it("publishes and reads one bounded hardened report", () => {
    const root = mkdtempSync(join(tmpdir(), "hd-windows-vertical-"));
    chmodSync(root, 0o700);
    const path = join(root, windowsStructuredVerticalReportName);
    try {
      expect(requireWindowsStructuredVerticalReportPath(path, root)).toBe(path);
      expect(
        publishWindowsStructuredVerticalReport(path, validReport())
      ).toEqual(validReport());
      expect(readWindowsStructuredVerticalReport(path, commit)).toEqual(
        validReport()
      );
      expect(lstatSync(path).nlink).toBe(1);
      expect(lstatSync(path).size).toBeLessThan(64 * 1_024);
      expect(() =>
        requireWindowsStructuredVerticalReportPath(path, root)
      ).toThrow();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects a foreign name and pre-existing output", () => {
    const root = mkdtempSync(join(tmpdir(), "hd-windows-vertical-"));
    chmodSync(root, 0o700);
    const path = join(root, windowsStructuredVerticalReportName);
    try {
      expect(() =>
        requireWindowsStructuredVerticalReportPath(
          join(root, "other.json"),
          root
        )
      ).toThrow();
      writeFileSync(path, "{}\n", { encoding: "utf8", flag: "wx" });
      expect(() =>
        requireWindowsStructuredVerticalReportPath(path, root)
      ).toThrow();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

function validReport() {
  return createWindowsStructuredVerticalReport({
    observed_at: "2026-08-11T12:00:00.000Z",
    hostdeck_commit: commit,
    duration_ms: 120_000,
    request_count: 72,
    notification_count: 180,
    observer_count: 160,
    durable_publication_count: 150
  });
}
