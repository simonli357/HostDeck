import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import {
  type HostPlatformCapability,
  resolveHostPlatformCapability,
  type SupportedHostTarget
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import {
  createTailscalePlatformCommandAdapter,
  discoverTailscaleExecutable,
  nativeTailscaleExecutableDiscoveryPort,
  runNativeTailscaleProcess,
  type TailscaleExecutableDiscoveryPort,
  type TailscaleExecutableInspection,
  type TailscaleNativeProcessPort,
  type TailscaleNativeProcessRequest,
  type TailscaleNativeProcessResult,
  type TailscalePlatformCommandName,
  type TailscalePlatformCommandRequest
} from "./tailscale-command-adapter.js";

const proxyOrigin = "http://127.0.0.1:3777";
const commandArguments: Readonly<Record<TailscalePlatformCommandName, readonly string[]>> =
  Object.freeze({
    version: Object.freeze(["version"]),
    status: Object.freeze(["status", "--json"]),
    profile_list: Object.freeze(["switch", "--list", "--json"]),
    serve_status: Object.freeze(["serve", "status", "--json"]),
    funnel_status: Object.freeze(["funnel", "status", "--json"]),
    enable: Object.freeze(["serve", "--bg", proxyOrigin]),
    disable: Object.freeze(["serve", "--https=443", "--set-path=/", "off"])
  });

const targetExpectations = Object.freeze({
  "linux-x64": Object.freeze({
    executable: "/usr/bin/tailscale",
    cwd: "/",
    environment: {
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
      TERM: "dumb"
    }
  }),
  "windows-x64": Object.freeze({
    executable: "C:\\Program Files\\Tailscale\\tailscale.exe",
    cwd: "C:\\",
    environment: {
      LANG: "C",
      LC_ALL: "C",
      PATH: "C:\\Program Files\\Tailscale;C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      TERM: "dumb",
      WINDIR: "C:\\Windows"
    }
  })
} as const);

describe("platform Tailscale command adapter", () => {
  it.each(["linux-x64", "windows-x64"] as const)(
    "discovers only the reviewed %s binary and builds every fixed command",
    async (target) => {
      const harness = createHarness(target);
      const commands = Object.keys(commandArguments) as TailscalePlatformCommandName[];

      for (const command of commands) {
        const result = await harness.adapter.run(commandRequest(command, harness.controller.signal));
        expect(result).toEqual({
          completion: "succeeded",
          stdout: command === "enable" || command === "disable" ? "" : "fixture-output",
          consent_required: false,
          permission_denied: false
        });
        expect(Object.isFrozen(result)).toBe(true);
      }

      const expected = targetExpectations[target];
      expect(harness.discoveryCalls).toEqual(
        commands.map(() => ({ candidate: expected.executable, target }))
      );
      expect(harness.processRequests).toHaveLength(commands.length);
      for (const [index, request] of harness.processRequests.entries()) {
        const command = commands[index] as TailscalePlatformCommandName;
        expect(request).toMatchObject({
          executable: expected.executable,
          args: commandArguments[command],
          cwd: expected.cwd,
          environment: expected.environment,
          timeout_ms: 1_000,
          output_max_bytes: 4_096,
          retain_stdout: command !== "enable" && command !== "disable",
          scan_mutation_markers: command === "enable" || command === "disable"
        });
        expect(request.signal).toBe(harness.controller.signal);
        expect(Object.keys(request).sort()).toEqual([
          "args",
          "cwd",
          "environment",
          "executable",
          "output_max_bytes",
          "retain_stdout",
          "scan_mutation_markers",
          "signal",
          "timeout_ms"
        ]);
      }
    }
  );

  it("does not inspect or execute during construction and discovery performs no process action", () => {
    const harness = createHarness("linux-x64");
    expect(harness.discoveryCalls).toHaveLength(0);
    expect(harness.processRequests).toHaveLength(0);

    const result = discoverTailscaleExecutable(capability("linux-x64"), harness.discovery);
    expect(result).toMatchObject({
      status: "available",
      target: "linux-x64",
      executable: "/usr/bin/tailscale"
    });
    expect(harness.discoveryCalls).toHaveLength(1);
    expect(harness.processRequests).toHaveLength(0);
  });

  it("accepts only the native extended-length form of the reviewed Windows drive path", async () => {
    const inspection = validInspection("windows-x64") as Extract<
      TailscaleExecutableInspection,
      { status: "present" }
    >;
    const accepted = createHarness("windows-x64", {
      ...inspection,
      canonical_path: `\\\\?\\${inspection.canonical_path}`
    });
    await expect(accepted.adapter.run(commandRequest("version"))).resolves.toMatchObject({
      completion: "succeeded"
    });

    const rejected = createHarness("windows-x64", {
      ...inspection,
      canonical_path: "\\\\?\\UNC\\server\\Tailscale\\tailscale.exe"
    });
    await expect(rejected.adapter.run(commandRequest("version"))).resolves.toMatchObject({
      completion: "executable_invalid"
    });
    expect(rejected.processRequests).toHaveLength(0);
  });

  it.each(invalidInspectionCases())(
    "rejects $label before spawning",
    async ({ target, inspection }) => {
      const harness = createHarness(target, inspection);
      const result = await harness.adapter.run(commandRequest("version"));
      expect(result).toEqual({
        completion: inspection.status === "missing" ? "not_installed" : "executable_invalid",
        stdout: "",
        consent_required: false,
        permission_denied: false
      });
      expect(harness.processRequests).toHaveLength(0);
    }
  );

  it("fails closed on mixed-platform capability data before discovery", () => {
    const linux = capability("linux-x64");
    let discoveryCalls = 0;
    expect(() =>
      createTailscalePlatformCommandAdapter({
        capability: { ...linux, target: "windows-x64" } as HostPlatformCapability,
        discovery: {
          inspect() {
            discoveryCalls += 1;
            return { status: "missing" };
          }
        },
        process: {
          async run() {
            throw new TypeError("Process must not run.");
          }
        }
      })
    ).toThrow("Host platform capability validation failed.");
    expect(discoveryCalls).toBe(0);
  });

  it("rejects extra argv, invalid proxy origins, and out-of-policy bounds before discovery", async () => {
    const harness = createHarness("linux-x64");
    const invalid = [
      { ...commandRequest("version"), args: ["up"] },
      { ...commandRequest("status"), proxy_origin: proxyOrigin },
      { ...commandRequest("enable"), proxy_origin: "http://0.0.0.0:3777" },
      { ...commandRequest("disable"), proxy_origin: proxyOrigin },
      { ...commandRequest("version"), timeout_ms: 30_001 },
      { ...commandRequest("version"), output_max_bytes: 8_388_609 }
    ];
    for (const request of invalid) {
      await expect(harness.adapter.run(request as never)).rejects.toThrow(
        "Tailscale platform command request is invalid."
      );
    }
    expect(harness.discoveryCalls).toHaveLength(0);
    expect(harness.processRequests).toHaveLength(0);
  });

  it("validates process-port results and never exposes raw diagnostics", async () => {
    const privateSentinel = "private-profile-identity-sentinel";
    let reply: unknown = nativeResult("succeeded", "ok");
    const harness = createHarness("linux-x64", validInspection("linux-x64"), () => reply);

    reply = nativeResult("succeeded", "x".repeat(4_097));
    await expect(harness.adapter.run(commandRequest("version"))).resolves.toMatchObject({
      completion: "output_oversized",
      stdout: ""
    });

    reply = nativeResult("succeeded", "\ud800");
    await expect(harness.adapter.run(commandRequest("version"))).resolves.toMatchObject({
      completion: "output_invalid",
      stdout: ""
    });

    reply = { ...nativeResult("succeeded", ""), future: true };
    await expect(harness.adapter.run(commandRequest("version"))).resolves.toMatchObject({
      completion: "output_invalid"
    });

    reply = nativeResult("command_timeout");
    await expect(harness.adapter.run(commandRequest("version"))).resolves.toMatchObject({
      completion: "command_timeout"
    });

    reply = nativeResult("command_failed", privateSentinel);
    const result = await harness.adapter.run(commandRequest("version"));
    expect(result).toMatchObject({ completion: "output_invalid", stdout: "" });
    expect(JSON.stringify(result)).not.toContain(privateSentinel);
  });

  it("maps discovery and process exceptions to generic, privacy-safe outcomes", async () => {
    const privateSentinel = "private-profile-identity-sentinel";
    const discoveryHarness = createHarness("linux-x64", () => {
      throw new Error(privateSentinel);
    });
    const discoveryResult = await discoveryHarness.adapter.run(commandRequest("version"));
    expect(discoveryResult).toMatchObject({ completion: "executable_invalid", stdout: "" });
    expect(JSON.stringify(discoveryResult)).not.toContain(privateSentinel);

    const processHarness = createHarness(
      "linux-x64",
      validInspection("linux-x64"),
      () => {
        throw new Error(privateSentinel);
      }
    );
    const processResult = await processHarness.adapter.run(commandRequest("version"));
    expect(processResult).toMatchObject({ completion: "command_failed", stdout: "" });
    expect(JSON.stringify(processResult)).not.toContain(privateSentinel);
  });

  it("short-circuits pre-aborted commands before discovery", async () => {
    const harness = createHarness("windows-x64");
    harness.controller.abort();
    await expect(harness.adapter.run(commandRequest("version", harness.controller.signal))).resolves.toEqual({
      completion: "aborted",
      stdout: "",
      consent_required: false,
      permission_denied: false
    });
    expect(harness.discoveryCalls).toHaveLength(0);
    expect(harness.processRequests).toHaveLength(0);
  });
});

describe("native bounded Tailscale process edge", () => {
  it("passes literal argv without a shell and returns only bounded stdout", async () => {
    const literal = "literal;not-a-shell-command";
    const result = await runNativeTailscaleProcess(
      nativeRequest(["-e", "process.stdout.write(process.argv[1])", literal])
    );
    expect(result).toEqual({
      completion: "succeeded",
      stdout: literal,
      consent_required: false,
      permission_denied: false
    });
  });

  it("detects mutation consent and permission markers without returning process output", async () => {
    const result = await runNativeTailscaleProcess(
      nativeRequest(
        [
          "-e",
          "process.stdout.write('https://login.tail'); process.stdout.write('scale.com/'); process.stderr.write('Permission denied')"
        ],
        { retain_stdout: false, scan_mutation_markers: true }
      )
    );
    expect(result).toEqual({
      completion: "succeeded",
      stdout: "",
      consent_required: true,
      permission_denied: true
    });
  });

  it.each([
    ["nonzero exit", ["-e", "process.exit(7)"], "command_failed"],
    ["combined output overflow", ["-e", "process.stdout.write('x'.repeat(4097))"], "output_oversized"],
    ["invalid UTF-8", ["-e", "process.stdout.write(Buffer.from([255]))"], "output_invalid"],
    ["timeout", ["-e", "setInterval(() => {}, 1000)"], "command_timeout"]
  ] as const)("returns a stable completion for %s", async (_label, args, completion) => {
    const result = await runNativeTailscaleProcess(
      nativeRequest([...args], { timeout_ms: completion === "command_timeout" ? 100 : 1_000 })
    );
    expect(result).toEqual({
      completion,
      stdout: "",
      consent_required: false,
      permission_denied: false
    });
  });

  it("kills an in-flight command on lifecycle abort and leaves no child resource", async () => {
    const controller = new AbortController();
    const pending = runNativeTailscaleProcess(
      nativeRequest(["-e", "setInterval(() => {}, 1000)"], { signal: controller.signal })
    );
    setTimeout(() => controller.abort(), 50);
    await expect(pending).resolves.toMatchObject({ completion: "aborted", stdout: "" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(process.getActiveResourcesInfo()).not.toContain("ChildProcess");
  });

  it("inspects an executable candidate read-only and distinguishes a missing path", () => {
    const target = process.platform === "win32" ? "windows-x64" : "linux-x64";
    const root = mkdtempSync(join(tmpdir(), "hostdeck-tailscale-inspection-"));
    const candidate = join(root, process.platform === "win32" ? "tailscale.exe" : "tailscale");
    try {
      const bytes = Buffer.alloc(5_000, 0x41);
      writeFileSync(candidate, bytes, { mode: 0o755 });
      chmodSync(candidate, 0o755);
      const before = statSync(candidate, { bigint: true });

      const inspection = nativeTailscaleExecutableDiscoveryPort.inspect(candidate, target);
      const after = statSync(candidate, { bigint: true });
      expect(inspection.status).toBe("present");
      if (inspection.status === "present") {
        expect({
          canonical_matches:
            process.platform === "win32"
              ? win32
                  .normalize(inspection.canonical_path.replace(/^\\\\\?\\/u, ""))
                  .toLowerCase() ===
                win32.normalize(candidate).toLowerCase()
              : inspection.canonical_path === candidate,
          identity_stable: inspection.identity_stable,
          is_file: inspection.is_file,
          is_symbolic_link: inspection.is_symbolic_link,
          link_count: inspection.link_count,
          size_bytes: inspection.size_bytes
        }).toEqual({
          canonical_matches: true,
          identity_stable: true,
          is_file: true,
          is_symbolic_link: false,
          link_count: 1,
          size_bytes: bytes.byteLength
        });
        expect(inspection.header).toHaveLength(4_096);
      }
      expect(after.size).toBe(before.size);
      expect(after.mtimeNs).toBe(before.mtimeNs);
      expect(readFileSync(candidate)).toEqual(bytes);
      expect(nativeTailscaleExecutableDiscoveryPort.inspect(`${candidate}.missing`, target)).toEqual({
        status: "missing"
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function createHarness(
  target: SupportedHostTarget,
  inspection:
    | TailscaleExecutableInspection
    | (() => TailscaleExecutableInspection) = validInspection(target),
  processReply:
    | unknown
    | (() => unknown) = nativeResult("succeeded", "fixture-output")
) {
  const controller = new AbortController();
  const discoveryCalls: Array<{ candidate: string; target: SupportedHostTarget }> = [];
  const processRequests: TailscaleNativeProcessRequest[] = [];
  const discovery: TailscaleExecutableDiscoveryPort = Object.freeze({
    inspect(candidate: string, selectedTarget: SupportedHostTarget) {
      discoveryCalls.push({ candidate, target: selectedTarget });
      return typeof inspection === "function" ? inspection() : inspection;
    }
  });
  const processPort: TailscaleNativeProcessPort = Object.freeze({
    async run(request: TailscaleNativeProcessRequest) {
      processRequests.push(request);
      if (typeof processReply === "function") return processReply();
      if (request.scan_mutation_markers && isNativeResult(processReply)) {
        return { ...processReply, stdout: "" };
      }
      return processReply;
    }
  });
  const adapter = createTailscalePlatformCommandAdapter({
    capability: capability(target),
    discovery,
    process: processPort
  });
  return { adapter, controller, discovery, discoveryCalls, processRequests };
}

function capability(target: SupportedHostTarget): HostPlatformCapability {
  return resolveHostPlatformCapability({
    platform: target === "linux-x64" ? "linux" : "win32",
    architecture: "x64",
    node_version: "22.22.2",
    node_abi: "127"
  });
}

function commandRequest(
  command: TailscalePlatformCommandName,
  signal: AbortSignal = new AbortController().signal
): TailscalePlatformCommandRequest {
  return {
    command,
    proxy_origin: command === "enable" ? proxyOrigin : null,
    timeout_ms: 1_000,
    output_max_bytes: 4_096,
    signal
  };
}

function validInspection(target: SupportedHostTarget): TailscaleExecutableInspection {
  return {
    status: "present",
    canonical_path: targetExpectations[target].executable,
    is_file: true,
    is_symbolic_link: false,
    identity_stable: true,
    size_bytes: 32_000_000,
    link_count: 1,
    owner_uid: target === "linux-x64" ? 0 : null,
    mode: target === "linux-x64" ? 0o100755 : null,
    header: target === "linux-x64" ? linuxX64ElfHeader() : windowsX64PeHeader()
  };
}

function invalidInspectionCases(): Array<{
  label: string;
  target: SupportedHostTarget;
  inspection: TailscaleExecutableInspection;
}> {
  const linux = validInspection("linux-x64") as Extract<
    TailscaleExecutableInspection,
    { status: "present" }
  >;
  const windows = validInspection("windows-x64") as Extract<
    TailscaleExecutableInspection,
    { status: "present" }
  >;
  const armElf = linuxX64ElfHeader();
  new DataView(armElf.buffer).setUint16(18, 0xb7, true);
  const x86Pe = windowsX64PeHeader();
  new DataView(x86Pe.buffer).setUint16(0x84, 0x14c, true);
  return [
    { label: "a missing reviewed candidate", target: "linux-x64", inspection: { status: "missing" } },
    { label: "an inspection failure", target: "linux-x64", inspection: { status: "invalid" } },
    {
      label: "an alternate Linux alias path",
      target: "linux-x64",
      inspection: { ...linux, canonical_path: "/usr/local/bin/tailscale" }
    },
    {
      label: "a Windows command-script alias",
      target: "windows-x64",
      inspection: { ...windows, canonical_path: "C:\\Program Files\\Tailscale\\tailscale.cmd" }
    },
    { label: "a symbolic link", target: "linux-x64", inspection: { ...linux, is_symbolic_link: true } },
    { label: "a non-file", target: "linux-x64", inspection: { ...linux, is_file: false } },
    { label: "an identity race", target: "linux-x64", inspection: { ...linux, identity_stable: false } },
    { label: "a hard-link alias", target: "linux-x64", inspection: { ...linux, link_count: 2 } },
    { label: "a non-root Linux binary", target: "linux-x64", inspection: { ...linux, owner_uid: 1000 } },
    { label: "a writable Linux binary", target: "linux-x64", inspection: { ...linux, mode: 0o100777 } },
    { label: "a shell script", target: "linux-x64", inspection: { ...linux, header: scriptHeader() } },
    { label: "an ARM64 ELF", target: "linux-x64", inspection: { ...linux, header: armElf } },
    { label: "a non-PE Windows file", target: "windows-x64", inspection: { ...windows, header: scriptHeader() } },
    { label: "an x86 PE", target: "windows-x64", inspection: { ...windows, header: x86Pe } },
    { label: "a tiny binary", target: "windows-x64", inspection: { ...windows, size_bytes: 4_095 } },
    {
      label: "an oversized binary",
      target: "windows-x64",
      inspection: { ...windows, size_bytes: 268_435_457 }
    }
  ];
}

function linuxX64ElfHeader(): Uint8Array {
  const header = new Uint8Array(4_096);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  const view = new DataView(header.buffer);
  view.setUint16(16, 2, true);
  view.setUint16(18, 0x3e, true);
  return header;
}

function windowsX64PeHeader(): Uint8Array {
  const header = new Uint8Array(4_096);
  header[0] = 0x4d;
  header[1] = 0x5a;
  const view = new DataView(header.buffer);
  view.setUint32(0x3c, 0x80, true);
  header.set([0x50, 0x45, 0, 0], 0x80);
  view.setUint16(0x84, 0x8664, true);
  view.setUint16(0x98, 0x20b, true);
  return header;
}

function scriptHeader(): Uint8Array {
  const header = new Uint8Array(4_096);
  header.set(Buffer.from("#!/bin/sh\n", "utf8"));
  return header;
}

function nativeResult(
  completion: TailscaleNativeProcessResult["completion"],
  stdout = ""
): TailscaleNativeProcessResult {
  return {
    completion,
    stdout,
    consent_required: false,
    permission_denied: false
  };
}

function isNativeResult(value: unknown): value is TailscaleNativeProcessResult {
  return value !== null && typeof value === "object" && "completion" in value && "stdout" in value;
}

function nativeRequest(
  args: readonly string[],
  overrides: Partial<TailscaleNativeProcessRequest> = {}
): TailscaleNativeProcessRequest {
  return {
    executable: process.execPath,
    args,
    cwd: process.cwd(),
    environment:
      process.platform === "win32"
        ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" }
        : { LANG: "C" },
    timeout_ms: 1_000,
    output_max_bytes: 4_096,
    signal: new AbortController().signal,
    retain_stdout: true,
    scan_mutation_markers: false,
    ...overrides
  };
}
