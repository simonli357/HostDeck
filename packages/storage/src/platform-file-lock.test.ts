import { spawn } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHostDeckFileLockPort,
  HostDeckFileLockError,
  nativeHostDeckFileLockPort
} from "./platform-file-lock.js";

const roots: string[] = [];
const children = new Set<ReturnType<typeof spawn>>();

afterEach(async () => {
  for (const child of children) child.kill();
  await Promise.all([...children].map((child) => waitForExit(child, 5_000)));
  children.clear();
  for (const root of roots.splice(0).reverse()) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("cross-platform native file-lock port", () => {
  it("owns one descriptor nonblockingly and releases idempotently", () => {
    const path = lockPath();
    const firstDescriptor = openSync(path, "r+");
    const secondDescriptor = openSync(path, "r+");
    try {
      const lock = nativeHostDeckFileLockPort.tryAcquireExclusive(firstDescriptor);
      expect(lock).not.toBeNull();
      expect(Object.isFrozen(lock)).toBe(true);
      expect(nativeHostDeckFileLockPort.tryAcquireExclusive(firstDescriptor)).toBeNull();
      expect(nativeHostDeckFileLockPort.tryAcquireExclusive(secondDescriptor)).toBeNull();

      lock?.release();
      lock?.release();
      expect(lock?.released).toBe(true);

      const replacement = nativeHostDeckFileLockPort.tryAcquireExclusive(secondDescriptor);
      expect(replacement).not.toBeNull();
      replacement?.release();
    } finally {
      closeSync(secondDescriptor);
      closeSync(firstDescriptor);
    }
  });

  it("releases ownership when a competing process exits", async () => {
    const path = lockPath();
    const nativeModule = createRequire(import.meta.url).resolve("fs-native-extensions");
    const child = spawn(
      process.execPath,
      [
        "--eval",
        [
          "const fs = require('node:fs');",
          "const lock = require(process.argv[1]);",
          "const descriptor = fs.openSync(process.argv[2], 'r+');",
          "if (!lock.tryLock(descriptor)) process.exit(71);",
          "process.stdout.write('locked\\n');",
          "setInterval(() => {}, 1000);"
        ].join(" "),
        nativeModule,
        path
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    children.add(child);
    await waitForOutput(child, "locked\n", 10_000);

    const descriptor = openSync(path, "r+");
    try {
      expect(nativeHostDeckFileLockPort.tryAcquireExclusive(descriptor)).toBeNull();
      child.kill("SIGKILL");
      await waitForExit(child, 10_000);
      children.delete(child);

      const recovered = nativeHostDeckFileLockPort.tryAcquireExclusive(descriptor);
      expect(recovered).not.toBeNull();
      recovered?.release();
    } finally {
      closeSync(descriptor);
    }
  }, 20_000);

  it("maps binding and descriptor failures to bounded non-reflecting errors", () => {
    const privateValue = "private-lock-value";
    const broken = createHostDeckFileLockPort({
      tryLock() {
        throw new Error(privateValue);
      },
      unlock() {
        throw new Error(privateValue);
      }
    });

    for (const work of [
      () => nativeHostDeckFileLockPort.tryAcquireExclusive(-1),
      () => broken.tryAcquireExclusive(5)
    ]) {
      try {
        work();
      } catch (error) {
        expect(error).toBeInstanceOf(HostDeckFileLockError);
        expect((error as Error).message).toBe("HostDeck file-lock operation failed.");
        expect(JSON.stringify({ name: (error as Error).name, message: (error as Error).message })).not.toContain(
          privateValue
        );
      }
    }
  });

  it("makes a failed unlock terminal so callers cannot double-release uncertain ownership", () => {
    const port = createHostDeckFileLockPort({
      tryLock: () => true,
      unlock() {
        throw new Error("private-release-failure");
      }
    });
    const lock = port.tryAcquireExclusive(7);
    expect(() => lock?.release()).toThrowError(
      expect.objectContaining({ code: "lock_io_failed" })
    );
    expect(lock?.released).toBe(true);
    expect(() => lock?.release()).not.toThrow();
  });
});

function lockPath(): string {
  const root = mkdtempSync(join(tmpdir(), "hostdeck-platform-lock-"));
  roots.push(root);
  const path = join(root, "owner.lock");
  writeFileSync(path, "", { mode: 0o600 });
  return path;
}

function waitForOutput(
  child: ReturnType<typeof spawn>,
  expected: string,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => finish(new Error("File-lock worker readiness timed out.")), timeoutMs);
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output === expected) finish();
      else if (!expected.startsWith(output)) finish(new Error("File-lock worker readiness output was invalid."));
    };
    const onExit = () => finish(new Error("File-lock worker exited before readiness."));
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
      if (error === undefined) resolve();
      else reject(error);
    };
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
  });
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("File-lock worker exit timed out."));
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
