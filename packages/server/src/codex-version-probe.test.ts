import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HostDeckCodexVersionProbeError,
  probeCodexVersion
} from "./codex-version-probe.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0).reverse()) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("production Codex version probe", () => {
  it("runs only the exact version command and returns supported or drifted semver", async () => {
    const exact = executable(
      "exact",
      [
        "[ \"$#\" -eq 1 ] || exit 91",
        "[ \"$1\" = \"--version\" ] || exit 92",
        "[ \"$PWD\" = \"/\" ] || exit 93",
        "printf 'codex-cli 0.148.0\\n'"
      ].join("\n")
    );
    const drift = executable(
      "drift",
      "printf 'codex-cli 0.145.0\\n'"
    );

    await expect(observe(exact)).resolves.toBe("0.148.0");
    await expect(observe(drift)).resolves.toBe("0.145.0");
  });

  it.each([
    ["stderr", "printf 'private' >&2\nprintf 'codex-cli 0.148.0\\n'", "output_invalid"],
    ["malformed", "printf 'codex 0.148.0\\n'", "output_invalid"],
    ["extra", "printf 'codex-cli 0.148.0\\nextra\\n'", "output_invalid"],
    ["nonzero", "printf 'codex-cli 0.148.0\\n'\nexit 7", "command_failed"],
    ["signaled", "kill -TERM $$", "command_failed"]
  ])("rejects %s command behavior without exposing output", async (label, body, code) => {
    const path = executable(label, body);
    const error = await capture(observe(path));

    expect(error).toBeInstanceOf(HostDeckCodexVersionProbeError);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain(path);
    expect(String(error)).not.toContain("private");
  });

  it("bounds aggregate output and terminates the owned process group", async () => {
    const path = executable(
      "overflow",
      "/usr/bin/head -c 8192 /dev/zero\n/bin/sleep 30"
    );
    const startedAt = Date.now();
    const error = await capture(observe(path));

    expect(error).toMatchObject({ code: "output_oversized" });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it("bounds timeout and caller abort while cleaning the child", async () => {
    const path = executable("wait", "/bin/sleep 30");
    const timeoutError = await capture(observe(path, undefined, 30));
    expect(timeoutError).toMatchObject({ code: "command_timeout" });

    const controller = new AbortController();
    const pending = observe(path, controller.signal, 1_000);
    controller.abort();
    const abortError = await capture(pending);
    expect(abortError).toMatchObject({ code: "aborted" });
  });

  it("rejects invalid and hostile input before command work", async () => {
    const path = executable("unused", "exit 99");
    const controller = new AbortController();
    controller.abort();
    await expect(observe(path, controller.signal)).rejects.toMatchObject({
      code: "aborted"
    });
    await expect(
      probeCodexVersion({
        executable: "codex",
        signal: new AbortController().signal,
        timeout_ms: 100
      })
    ).rejects.toMatchObject({ code: "invalid_config" });
    await expect(
      probeCodexVersion({
        executable: join(tmpdir(), "missing-hostdeck-codex"),
        signal: new AbortController().signal,
        timeout_ms: 100
      })
    ).rejects.toMatchObject({ code: "spawn_failed" });

    let accessorRead = false;
    const hostile = Object.defineProperty(
      {
        signal: new AbortController().signal,
        timeout_ms: 100
      },
      "executable",
      {
        enumerable: true,
        get() {
          accessorRead = true;
          return path;
        }
      }
    );
    await expect(
      probeCodexVersion(hostile as never)
    ).rejects.toMatchObject({ code: "invalid_config" });
    expect(accessorRead).toBe(false);
  });
});

function observe(
  path: string,
  signal: AbortSignal = new AbortController().signal,
  timeoutMs = 1_000
): Promise<string> {
  return probeCodexVersion({
    executable: path,
    signal,
    timeout_ms: timeoutMs
  });
}

function executable(label: string, body: string): string {
  const root = mkdtempSync(join(tmpdir(), `hostdeck-version-${label}-`));
  roots.push(root);
  const path = join(root, "codex");
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

async function capture(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected Codex version probe to reject.");
}
