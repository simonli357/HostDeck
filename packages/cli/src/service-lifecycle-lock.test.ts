import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostDeckFileLockPort } from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireHostDeckServiceLifecycleLock,
  HostDeckServiceLifecycleLockError
} from "./service-lifecycle-lock.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0).reverse()) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("IFC-V1-056 lifecycle advisory lock", () => {
  it("creates one owner-only lock, rejects contention, and releases idempotently", () => {
    const path = fixturePath();
    const first = acquireHostDeckServiceLifecycleLock(path);
    expect(lstatSync(path).mode & 0o7777).toBe(0o600);
    expect(() => acquireHostDeckServiceLifecycleLock(path)).toThrowError(
      expect.objectContaining({ code: "lock_held" })
    );
    first.release();
    first.release();
    expect(first.released).toBe(true);

    const second = acquireHostDeckServiceLifecycleLock(path);
    second.release();
  });

  it("refuses wrong-mode, hard-linked, and symbolic lock files without repair", () => {
    for (const kind of ["mode", "hardlink", "symlink"] as const) {
      const path = fixturePath(kind);
      if (kind === "mode") {
        writeFileSync(path, "", { mode: 0o644 });
        chmodSync(path, 0o644);
      } else {
        const target = `${path}.target`;
        writeFileSync(target, "", { mode: 0o600 });
        if (kind === "hardlink") {
          linkSync(target, path);
        } else {
          symlinkSync(target, path);
        }
      }
      let observed: unknown;
      try {
        acquireHostDeckServiceLifecycleLock(path);
      } catch (error) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(HostDeckServiceLifecycleLockError);
      expect(observed).toMatchObject({ code: "invalid_lock" });
      if (kind === "mode") expect(lstatSync(path).mode & 0o7777).toBe(0o644);
    }
  });

  it("maps only the port's explicit null result to contention", () => {
    const path = fixturePath("normalized-contention");
    const heldPort: HostDeckFileLockPort = Object.freeze({
      tryAcquireExclusive: () => null
    });
    expect(() => acquireHostDeckServiceLifecycleLock(path, heldPort)).toThrowError(
      expect.objectContaining({ code: "lock_held" })
    );

    const privateValue = "private-lock-binding-failure";
    const failedPort: HostDeckFileLockPort = Object.freeze({
      tryAcquireExclusive() {
        throw Object.assign(new Error(privateValue), { code: "EAGAIN" });
      }
    });
    let observed: unknown;
    try {
      acquireHostDeckServiceLifecycleLock(path, failedPort);
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(HostDeckServiceLifecycleLockError);
    expect(observed).toMatchObject({
      code: "lock_io_failed",
      message: "HostDeck service lifecycle lock operation failed."
    });
    expect(JSON.stringify({
      name: (observed as Error).name,
      message: (observed as Error).message
    })).not.toContain(privateValue);

    const recovered = acquireHostDeckServiceLifecycleLock(path);
    recovered.release();
  });

  it("closes ownership even when the injected release reports failure", () => {
    const path = fixturePath("release-failure");
    const failedReleasePort: HostDeckFileLockPort = Object.freeze({
      tryAcquireExclusive: () => Object.freeze({
        released: false,
        release() {
          throw new Error("private-release-failure");
        }
      })
    });
    const lock = acquireHostDeckServiceLifecycleLock(path, failedReleasePort);
    expect(() => lock.release()).toThrowError(
      expect.objectContaining({ code: "lock_io_failed" })
    );
    expect(lock.released).toBe(true);
    expect(() => lock.release()).not.toThrow();

    const recovered = acquireHostDeckServiceLifecycleLock(path);
    recovered.release();
  });
});

function fixturePath(label = "lock"): string {
  const root = mkdtempSync(join(tmpdir(), `hostdeck-lifecycle-${label}-`));
  roots.push(root);
  chmodSync(root, 0o700);
  return join(root, "lifecycle.lock");
}
