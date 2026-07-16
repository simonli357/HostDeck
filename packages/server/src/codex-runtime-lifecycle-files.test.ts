import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertLifecycleDirectoryEmpty,
  assertLifecycleScenarioInventory,
  countCurrentUserProcessReferences,
  publishPrivateLifecycleJson,
  readPrivateLifecycleJson,
  requireLifecycleEvidencePath,
  requirePrivateLifecycleReportPath
} from "./codex-runtime-lifecycle-files.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0).reverse()) {
    rmSync(path, { force: true, recursive: true });
  }
});

describe("runtime lifecycle private scenario files", () => {
  it("accepts one absent fixed report directly under a private root", () => {
    const root = privateRoot();
    const report = join(root, "supervisor-report.json");

    expect(
      requirePrivateLifecycleReportPath(
        report,
        "supervisor-report.json",
        root
      )
    ).toBe(report);
  });

  it("rejects existing, nested, aliased, and weak report roots", () => {
    const existingRoot = privateRoot();
    const existing = join(existingRoot, "restart-report.json");
    writeFileSync(existing, "{}\n", { mode: 0o600 });
    expect(() =>
      requirePrivateLifecycleReportPath(
        existing,
        "restart-report.json",
        existingRoot
      )
    ).toThrow("path is invalid");

    const nestedRoot = privateRoot();
    const nested = join(nestedRoot, "nested");
    mkdirSync(nested, { mode: 0o700 });
    expect(() =>
      requirePrivateLifecycleReportPath(
        join(nested, "coexistence-report.json"),
        "coexistence-report.json",
        nestedRoot
      )
    ).toThrow("path is invalid");

    const aliasedTarget = privateRoot();
    const alias = `${aliasedTarget}-alias`;
    symlinkSync(aliasedTarget, alias);
    cleanup.push(alias);
    expect(() =>
      requirePrivateLifecycleReportPath(
        join(alias, "supervisor-report.json"),
        "supervisor-report.json",
        alias
      )
    ).toThrow("directory is insecure");

    const weakRoot = privateRoot();
    chmodSync(weakRoot, 0o755);
    expect(() =>
      requirePrivateLifecycleReportPath(
        join(weakRoot, "restart-report.json"),
        "restart-report.json",
        weakRoot
      )
    ).toThrow("directory is insecure");
  });

  it("accepts only the exact private regular report inventory", () => {
    const root = privateRoot();
    const report = join(root, "integration-report.json");
    writeFileSync(report, '{"success":true}\n', { mode: 0o600 });

    expect(() =>
      assertLifecycleScenarioInventory(root, ["integration-report.json"])
    ).not.toThrow();
    expect(readPrivateLifecycleJson(report)).toEqual({ success: true });

    writeFileSync(join(root, "unexpected"), "private", { mode: 0o600 });
    expect(() =>
      assertLifecycleScenarioInventory(root, ["integration-report.json"])
    ).toThrow("unexpected entries");
  });

  it("rejects linked, weak, malformed, and oversized reports", () => {
    const linkedRoot = privateRoot();
    const source = join(linkedRoot, "source.json");
    const linked = join(linkedRoot, "supervisor-report.json");
    writeFileSync(source, "{}\n", { mode: 0o600 });
    symlinkSync(source, linked);
    expect(() => readPrivateLifecycleJson(linked)).toThrow(
      "insecure or invalid"
    );

    const weakRoot = privateRoot();
    const weak = join(weakRoot, "restart-report.json");
    writeFileSync(weak, "{}\n", { mode: 0o644 });
    expect(() => readPrivateLifecycleJson(weak)).toThrow(
      "insecure or invalid"
    );

    const malformedRoot = privateRoot();
    const malformed = join(malformedRoot, "coexistence-report.json");
    writeFileSync(malformed, "not-json\n", { mode: 0o600 });
    expect(() => readPrivateLifecycleJson(malformed)).toThrow("not valid JSON");

    const oversizedRoot = privateRoot();
    const oversized = join(oversizedRoot, "integration-report.json");
    writeFileSync(oversized, "x".repeat(128 * 1_024 + 1), { mode: 0o600 });
    expect(() => readPrivateLifecycleJson(oversized)).toThrow(
      "insecure or invalid"
    );
  });

  it("validates and atomically replaces one private artifacts report", () => {
    const repository = privateRoot();
    const artifacts = join(repository, "artifacts");
    mkdirSync(artifacts, { mode: 0o700 });
    const report = join(artifacts, "int-v1-032-evidence.json");

    expect(requireLifecycleEvidencePath(report, repository)).toBe(report);
    expect(publishPrivateLifecycleJson(report, { generation: 1 })).toEqual({
      generation: 1
    });
    expect(publishPrivateLifecycleJson(report, { generation: 2 })).toEqual({
      generation: 2
    });
    expect(readPrivateLifecycleJson(report)).toEqual({ generation: 2 });
    expect(lstatSync(report).mode & 0o7777).toBe(0o600);
    expect(lstatSync(report).nlink).toBe(1);
  });

  it("rejects final evidence outside or through an aliased artifacts parent", () => {
    const repository = privateRoot();
    const artifacts = join(repository, "artifacts");
    mkdirSync(artifacts, { mode: 0o700 });
    expect(() =>
      requireLifecycleEvidencePath(
        resolve(repository, "outside.json"),
        repository
      )
    ).toThrow("under artifacts");

    const external = privateRoot();
    const alias = join(artifacts, "alias");
    symlinkSync(external, alias);
    expect(() =>
      requireLifecycleEvidencePath(join(alias, "evidence.json"), repository)
    ).toThrow("under artifacts");
  });

  it("proves empty roots and counts only current-user command references", async () => {
    const root = privateRoot();
    expect(() => assertLifecycleDirectoryEmpty(root)).not.toThrow();

    const commandChild = spawn(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1000)", root],
      { stdio: "ignore" }
    );
    const environmentChild = spawn(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1000)"],
      {
        env: { ...process.env, HOSTDECK_FIXTURE_ROOT: root },
        stdio: "ignore"
      }
    );
    try {
      await Promise.all([
        once(commandChild, "spawn"),
        once(environmentChild, "spawn")
      ]);
      expect(countCurrentUserProcessReferences(root)).toBe(2);
    } finally {
      commandChild.kill("SIGKILL");
      environmentChild.kill("SIGKILL");
      await Promise.all([
        once(commandChild, "close"),
        once(environmentChild, "close")
      ]);
    }
    expect(countCurrentUserProcessReferences(root)).toBe(0);

    writeFileSync(join(root, "remaining"), "x", { mode: 0o600 });
    expect(() => assertLifecycleDirectoryEmpty(root)).toThrow("not empty");
  });
});

function privateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hostdeck-lifecycle-files-"));
  chmodSync(root, 0o700);
  cleanup.push(root);
  return root;
}
