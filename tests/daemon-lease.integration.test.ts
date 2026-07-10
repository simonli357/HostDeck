import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireHostDeckDaemonLease,
  HostDeckDaemonLeaseError
} from "../packages/storage/src/index.js";

const cleanup: string[] = [];
const fixturePath = resolve("tests/fixtures/daemon-lease-holder.cjs");
const requireFromStorage = createRequire(resolve("packages/storage/package.json"));
const fsExtPath = requireFromStorage.resolve("fs-ext");

afterEach(() => {
  for (const path of cleanup.splice(0).reverse()) rmSync(path, { force: true, recursive: true });
});

describe("daemon lease process lifecycle", () => {
  it("blocks a second process and reacquires immediately after SIGKILL", async () => {
    const root = mkdtempSync(join(tmpdir(), "hostdeck-daemon-crash-"));
    cleanup.push(root);
    const leasePath = join(root, "hostdeck.lock");
    const child = spawn(process.execPath, [fixturePath, fsExtPath, leasePath], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    try {
      await waitForAcquired(child);
      expectLeaseError(() => acquireHostDeckDaemonLease({ lease_path: leasePath }), "lease_held");
      await killAndWait(child);

      const recovered = acquireHostDeckDaemonLease({ lease_path: leasePath });
      try {
        expect(recovered.released).toBe(false);
      } finally {
        recovered.release();
      }
    } finally {
      await killAndWait(child);
    }
  });
});

function waitForAcquired(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolveReady, rejectReady) => {
    const cleanupListeners = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onData = (data: string) => {
      cleanupListeners();
      if (data.includes("acquired")) {
        resolveReady();
        return;
      }
      rejectReady(new Error(`Unexpected child output: ${data}`));
    };
    const onError = (error: Error) => {
      cleanupListeners();
      rejectReady(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanupListeners();
      rejectReady(new Error(`Lease child exited before acquisition: code=${String(code)} signal=${String(signal)}.`));
    };
    const timeout = setTimeout(() => {
      cleanupListeners();
      rejectReady(new Error("Timed out waiting for child lease acquisition."));
    }, 5_000);
    child.stdout.setEncoding("utf8");
    child.stdout.once("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function killAndWait(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

function expectLeaseError(work: () => unknown, code: HostDeckDaemonLeaseError["code"]): void {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(HostDeckDaemonLeaseError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected HostDeckDaemonLeaseError ${code}.`);
}
