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
  createStructuredVerticalReport,
  parseStructuredVerticalReport,
  publishStructuredVerticalReport,
  readStructuredVerticalReport,
  requireStructuredVerticalReportPath,
  structuredVerticalReportName
} from "./codex-structured-vertical-report.js";

const commit = "a".repeat(40);

describe("structured vertical private report", () => {
  it("creates one exact deep-frozen privacy-bounded report", () => {
    const report = validReport();

    expect(report).toMatchObject({
      task: "INT-V1-027",
      hostdeck_commit: commit,
      execution: {
        managed_thread_count: 2,
        turn_start_count: 3,
        compact_start_count: 1,
        proof_count: 16
      },
      cleanup: {
        app_servers_remaining: 0,
        tui_processes_remaining: 0,
        temporary_root_removed: true
      }
    });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.execution)).toBe(true);
    expect(JSON.stringify(report)).not.toContain("/tmp/private");
  });

  it("rejects extra, contradictory, stale, and malformed truth", () => {
    const report = validReport();
    const invalid = [
      { ...report, extra: true },
      { ...report, hostdeck_commit: "b".repeat(40) },
      {
        ...report,
        execution: { ...report.execution, turn_start_count: 2 }
      },
      {
        ...report,
        cleanup: { ...report.cleanup, app_servers_remaining: 1 }
      },
      {
        ...report,
        privacy: { ...report.privacy, contains_path: true }
      }
    ];

    expect(() => parseStructuredVerticalReport(invalid[0])).toThrow();
    expect(() => parseStructuredVerticalReport(invalid[1], commit)).toThrow(
      "Structured vertical report commit does not match."
    );
    for (const candidate of invalid.slice(2)) {
      expect(() => parseStructuredVerticalReport(candidate)).toThrow();
    }
  });

  it("publishes only one private report in the exact secure root", () => {
    const root = mkdtempSync(join(tmpdir(), "hd-svr-"));
    chmodSync(root, 0o700);
    const path = join(root, structuredVerticalReportName);
    try {
      expect(requireStructuredVerticalReportPath(path, root)).toBe(path);
      expect(publishStructuredVerticalReport(path, validReport())).toEqual(
        validReport()
      );
      expect(readStructuredVerticalReport(path, commit)).toEqual(validReport());
      expect(lstatSync(path).mode & 0o077).toBe(0);
      expect(lstatSync(path).nlink).toBe(1);
      expect(() => requireStructuredVerticalReportPath(path, root)).toThrow();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects an insecure parent and a pre-existing path before publication", () => {
    const root = mkdtempSync(join(tmpdir(), "hd-svr-"));
    const path = join(root, structuredVerticalReportName);
    try {
      chmodSync(root, 0o755);
      expect(() => requireStructuredVerticalReportPath(path, root)).toThrow();
      chmodSync(root, 0o700);
      writeFileSync(path, "{}\n", { mode: 0o600 });
      expect(() => requireStructuredVerticalReportPath(path, root)).toThrow();
      expect(() =>
        requireStructuredVerticalReportPath(
          join(root, "other-report.json"),
          root
        )
      ).toThrow();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

function validReport() {
  return createStructuredVerticalReport({
    observed_at: "2026-07-16T12:00:00.000Z",
    hostdeck_commit: commit,
    duration_ms: 30_000,
    request_count: 58,
    notification_count: 137,
    observer_count: 121,
    durable_publication_count: 117
  });
}
