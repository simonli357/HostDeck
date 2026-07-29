import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HostDeckServicePackageVerifierError,
  runHostDeckServicePackageVerifier
} from "./service-package-verifier.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0).reverse()) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("IFC-V1-056 package-verifier process boundary", () => {
  it("executes only the package verifier under the selected Node runtime", async () => {
    const root = packageFixture(
      [
        "if (process.argv.length !== 3) process.exit(91);",
        "if (process.argv[2] !== import.meta.dirname) process.exit(92);",
        "if (process.cwd() !== '/') process.exit(93);",
        "console.log('HostDeck package verified.');"
      ].join("\n")
    );

    await expect(run(root)).resolves.toBeUndefined();
  });

  it("accepts only normal and relocated read-only verifier modes", async () => {
    const root = packageFixture("console.log('HostDeck package verified.');");
    const verifier = join(root, "verify.mjs");

    chmodSync(verifier, 0o444);
    await expect(run(root)).resolves.toBeUndefined();

    for (const mode of [0o400, 0o544, 0o640, 0o664]) {
      chmodSync(verifier, mode);
      await expect(run(root)).rejects.toMatchObject({ code: "invalid_input" });
    }
  });

  it("sanitizes command failure and bounds timeout, abort, and aggregate output", async () => {
    const failed = packageFixture(
      "process.stderr.write('private /home/user secret'); process.exit(7);"
    );
    const failure = await capture(run(failed));
    expect(failure).toBeInstanceOf(HostDeckServicePackageVerifierError);
    expect(failure).toMatchObject({ code: "command_failed" });
    expect(String(failure)).not.toMatch(/private|\/home\/user|secret/u);

    const noisySuccess = packageFixture(
      "process.stderr.write('private warning'); process.exit(0);"
    );
    await expect(run(noisySuccess)).rejects.toMatchObject({
      code: "output_invalid"
    });

    const oversized = packageFixture(
      "process.stdout.write('x'.repeat(5000)); setInterval(() => {}, 1000);"
    );
    await expect(run(oversized)).rejects.toMatchObject({
      code: "output_oversized"
    });

    const invalidOutput = packageFixture(
      "process.stdout.write(Buffer.from([0xc3, 0x28]));"
    );
    await expect(run(invalidOutput)).rejects.toMatchObject({
      code: "output_invalid"
    });

    const waiting = packageFixture("setInterval(() => {}, 1000);");
    await expect(run(waiting, undefined, 20)).rejects.toMatchObject({
      code: "timed_out"
    });
    const controller = new AbortController();
    const pending = run(waiting, controller.signal, 1_000);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });

  it("kills and rejects descendants left behind by a successful verifier", async () => {
    const root = packageFixture(
      [
        'import { spawn } from "node:child_process";',
        "const child = spawn(process.execPath, [\"-e\", \"setInterval(() => {}, 1000)\"], { stdio: \"ignore\" });",
        "child.unref();"
      ].join("\n")
    );

    await expect(run(root)).rejects.toMatchObject({ code: "cleanup_failed" });
  });

  it("rejects a substituted verifier before process creation", async () => {
    const root = packageFixture("process.exit(99);");
    const verifier = join(root, "verify.mjs");
    const target = join(root, "substituted.mjs");
    const content = readFileSync(verifier);
    rmSync(verifier);
    writeFileSync(target, content, { mode: 0o644 });
    symlinkSync(target, verifier);

    await expect(run(root)).rejects.toMatchObject({ code: "invalid_input" });
  });
});

function packageFixture(body: string): string {
  const root = mkdtempSync(join(tmpdir(), "hostdeck-package-verifier-"));
  roots.push(root);
  chmodSync(root, 0o700);
  const verifier = join(root, "verify.mjs");
  writeFileSync(verifier, `${body}\n`, { mode: 0o644 });
  chmodSync(verifier, 0o644);
  return root;
}

function run(
  packageRoot: string,
  signal: AbortSignal = new AbortController().signal,
  timeoutMs = 1_000
): Promise<void> {
  return runHostDeckServicePackageVerifier({
    node_bin: process.execPath,
    package_root: packageRoot,
    signal,
    timeout_ms: timeoutMs
  });
}

async function capture(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected package verifier to reject.");
}
