import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertHostDeckSystemdUserUnitBundle,
  type GenerateHostDeckSystemdUserUnitsInput,
  generateHostDeckSystemdUserUnits,
  generateHostDeckSystemdUserUnitsForInstall,
  HostDeckSystemdUserUnitError,
  type HostDeckSystemdUserUnitErrorCode,
  type HostDeckSystemdUserUnitErrorStage,
  hostDeckSystemdUserUnitMode,
  hostDeckSystemdUserUnitNames
} from "./systemd-user-units.js";

const roots: string[] = [];
const version = "1.2.3-test.1";

afterEach(() => {
  for (const root of roots.splice(0).reverse()) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("IFC-V1-055 systemd user-unit generator", () => {
  it("returns one deterministic deeply frozen and branded exact bundle", () => {
    const layout = fixture("exact", "present");
    const before = snapshotFiles(layout.root);
    const first = generateHostDeckSystemdUserUnits(layout.input);
    const second = generateHostDeckSystemdUserUnits(
      Object.freeze({ ...layout.input })
    );

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first).toEqual({
      broker_host_path: layout.brokerHostPath,
      package_version: version,
      schema_version: 2,
      service_host_path: layout.serviceHostPath,
      units: [
        {
          content: expectedCodexUnit(layout),
          mode: 0o644,
          name: "hostdeck-codex.service",
          sha256: sha256(expectedCodexUnit(layout))
        },
        {
          content: expectedHostDeckUnit(layout),
          mode: 0o644,
          name: "hostdeck.service",
          sha256: sha256(expectedHostDeckUnit(layout))
        }
      ]
    });
    expect(hostDeckSystemdUserUnitNames).toEqual([
      "hostdeck-codex.service",
      "hostdeck.service"
    ]);
    expect(hostDeckSystemdUserUnitMode).toBe(0o644);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.units)).toBe(true);
    expect(first.units.every(Object.isFrozen)).toBe(true);
    expect(() => assertHostDeckSystemdUserUnitBundle(first)).not.toThrow();
    expect(() =>
      assertHostDeckSystemdUserUnitBundle(structuredClone(first))
    ).toThrow("bundle is invalid");
    expect(snapshotFiles(layout.root)).toEqual(before);
  });

  it("verifies a staged package while rendering only its final release path", () => {
    const layout = fixture("install-staging", "present");
    const finalPackageRoot = join(
      layout.root,
      "releases",
      "1.2.3-final",
      "package"
    );
    const bundle = generateHostDeckSystemdUserUnitsForInstall({
      ...layout.input,
      node_bin: join(finalPackageRoot, "runtime", "bin", "node"),
      package_root: finalPackageRoot,
      verification_package_root: layout.packageRoot
    });

    expect(bundle.service_host_path).toBe(
      join(finalPackageRoot, "dist", "service-host.js")
    );
    expect(bundle.broker_host_path).toBe(
      join(finalPackageRoot, "dist", "broker-host.js")
    );
    expect(bundle.units[1].content).toContain(finalPackageRoot);
    expect(bundle.units[1].content).not.toContain(layout.packageRoot);
  });

  it("verifies an immutable read-only staged package", () => {
    const layout = fixture("install-read-only", "present");
    const distRoot = dirname(layout.serviceHostPath);
    chmodSync(layout.manifestPath, 0o444);
    chmodSync(layout.brokerHostPath, 0o444);
    chmodSync(layout.serviceHostPath, 0o444);
    chmodSync(distRoot, 0o555);
    chmodSync(layout.packageRoot, 0o555);

    try {
      expect(() =>
        generateHostDeckSystemdUserUnitsForInstall({
          ...layout.input,
          verification_package_root: layout.packageRoot
        })
      ).not.toThrow();
    } finally {
      chmodSync(layout.packageRoot, 0o755);
      chmodSync(distRoot, 0o755);
    }
  });

  it("accepts an unpublished private environment parent only for install staging", () => {
    const layout = fixture("install-environment-staging", "missing");
    const environmentRoot = dirname(layout.environmentFile);
    rmSync(environmentRoot, { recursive: true });

    expect(() => generateHostDeckSystemdUserUnits(layout.input)).toThrowError(
      expect.objectContaining({
        code: "environment_file_invalid",
        stage: "environment_file"
      })
    );
    const bundle = generateHostDeckSystemdUserUnitsForInstall({
      ...layout.input,
      verification_package_root: layout.packageRoot
    });
    expect(bundle.units[0].content).toContain(layout.environmentFile);
    expect(existsSync(environmentRoot)).toBe(false);

    chmodSync(dirname(environmentRoot), 0o720);
    expect(() =>
      generateHostDeckSystemdUserUnitsForInstall({
        ...layout.input,
        verification_package_root: layout.packageRoot
      })
    ).toThrowError(
      expect.objectContaining({
        code: "environment_file_invalid",
        stage: "environment_file"
      })
    );
  });

  it("emits only the frozen ownership, dependency, and lifecycle policy", () => {
    const layout = fixture("policy", "present");
    const { units } = generateHostDeckSystemdUserUnits(layout.input);
    const codex = units[0].content;
    const hostDeck = units[1].content;
    const combined = `${codex}\n${hostDeck}`;

    expect(sectionNames(codex)).toEqual(["Unit", "Service"]);
    expect(sectionNames(hostDeck)).toEqual(["Unit", "Service", "Install"]);
    expect(matches(codex, /^ExecStart=/gmu)).toHaveLength(1);
    expect(matches(hostDeck, /^ExecStart=/gmu)).toHaveLength(1);
    expect(codex).not.toContain("RuntimeDirectory=");
    expect(combined).not.toContain("XDG_RUNTIME_DIR=");
    expect(hostDeck).toContain("RuntimeDirectory=hostdeck-service/hostdeck\n");
    expect(hostDeck).toContain("RuntimeDirectoryMode=0700\n");
    expect(hostDeck).toContain("Wants=hostdeck-codex.service\n");
    expect(hostDeck).toContain("After=hostdeck-codex.service\n");
    expect(codex).not.toContain("hostdeck.service");
    expect(codex).not.toContain("[Install]");
    expect(hostDeck.endsWith("WantedBy=default.target\n")).toBe(true);

    for (const directive of [
      "StartLimitIntervalSec=60s",
      "StartLimitBurst=5",
      "Type=exec",
      "WorkingDirectory=%h",
      "UMask=0077",
      "RestartSec=2s",
      "TimeoutStartSec=90s",
      "TimeoutStopSec=30s",
      "StandardOutput=journal",
      "StandardError=journal"
    ]) {
      expect(
        matches(combined, new RegExp(`^${directive}$`, "gmu"))
      ).toHaveLength(2);
    }
    expect(codex).toContain("Restart=on-failure\n");
    expect(codex).toContain("KillMode=mixed\n");
    expect(hostDeck).toContain("Restart=always\n");
    expect(hostDeck).toContain("KillMode=control-group\n");
    expect(combined).not.toMatch(
      /^(?:Requires|Requisite|BindsTo|PartOf|Upholds|PropagatesReloadTo|ReloadPropagatedFrom|StopWhenUnneeded|User|Group|CapabilityBoundingSet|ListenStream)=/gmu
    );
    expect(combined.toLowerCase()).not.toMatch(
      /tailscale|tailscaled|sudo|\/bin\/(?:ba)?sh|node_modules\/\.bin|tsx|ts-node|0\.0\.0\.0|https?:\/\//u
    );
    expect(combined).not.toContain("codexdeck serve");
    expect(combined).not.toContain("HOSTDECK_CODEX_BIN=$");
    expect(combined.split("\n").filter((line) => line.startsWith("#"))).toEqual([
      `# Generated by HostDeck ${version}. Do not edit.`,
      `# Generated by HostDeck ${version}. Do not edit.`
    ]);
  });

  it("omits the installer-owned environment file when the input is null", () => {
    const layout = fixture("no-environment", "none");
    const bundle = generateHostDeckSystemdUserUnits(layout.input);
    expect(bundle.units[0].content).not.toContain("EnvironmentFile=");
    expect(bundle.units[1].content).not.toContain("EnvironmentFile=");
  });

  it("encodes hostile valid path characters and passes the supported parser", () => {
    const layout = fixture("quoted", "present", true);
    const bundle = generateHostDeckSystemdUserUnits(layout.input);
    const unitRoot = join(layout.root, "units");
    mkdirSync(unitRoot, { mode: 0o700 });
    const unitPaths = bundle.units.map((unit) => {
      const path = join(unitRoot, unit.name);
      writeFileSync(path, unit.content, { mode: unit.mode });
      return path;
    });

    expect(bundle.units[0].content).toContain("%%percent");
    expect(bundle.units[1].content).toContain("$$/dist/service-host.js");
    expect(bundle.units[0].content).toContain("EnvironmentFile=-/tmp/");
    expect(bundle.units[0].content).toContain("\\x20");
    expect(bundle.units[0].content).toContain("\\x22");
    expect(bundle.units[0].content).toContain("\\x27");
    expect(bundle.units[0].content).toContain("\\x5c");
    expect(bundle.units[1].content).toContain(
      `Environment=${encodeWord(`HOSTDECK_CODEX_BIN=${layout.codexBin}`, false)}`
    );

    const result = spawnSync(
      "systemd-analyze",
      ["verify", "--user", ...unitPaths],
      { encoding: "utf8" }
    );
    expect(`${result.stdout}${result.stderr}`, "systemd-analyze output").toBe("");
    expect(result.status).toBe(0);
  });

  it("rejects non-plain, incomplete, extra, symbol, and accessor input before access", () => {
    const layout = fixture("shape", "missing");
    const base = { ...layout.input };
    const missing = { ...base } as Record<string, unknown>;
    delete missing.node_bin;
    const extra = { ...base, unexpected: true };
    const symbol = { ...base, [Symbol("private")]: true };
    const accessor = { ...base } as Record<string, unknown>;
    let accessed = false;
    Object.defineProperty(accessor, "node_bin", {
      enumerable: true,
      get() {
        accessed = true;
        return layout.nodeBin;
      }
    });

    for (const candidate of [
      null,
      [],
      Object.create(null),
      missing,
      extra,
      symbol,
      accessor
    ]) {
      expectUnitError(candidate, "invalid_input", "input");
    }
    expect(accessed).toBe(false);
  });

  it("rejects malformed and injection-bearing values at their owning stage", () => {
    const layout = fixture("syntax", "missing");
    const cases: ReadonlyArray<
      readonly [
        Partial<GenerateHostDeckSystemdUserUnitsInput>,
        HostDeckSystemdUserUnitErrorCode,
        HostDeckSystemdUserUnitErrorStage
      ]
    > = [
      [{ node_bin: "relative/node" }, "node_invalid", "node"],
      [{ node_bin: `${layout.nodeBin}\nRestart=no` }, "node_invalid", "node"],
      [{ node_bin: `${layout.nodeBin}\u0085Bad=yes` }, "node_invalid", "node"],
      [{ codex_bin: `${layout.codexBin}/../codex` }, "codex_invalid", "codex"],
      [{ package_root: "/" }, "package_invalid", "package"],
      [
        { environment_file: `${layout.environmentFile}\rBad=yes` },
        "environment_file_invalid",
        "environment_file"
      ],
      [
        { environment_file: `/${"x".repeat(4096)}` },
        "environment_file_invalid",
        "environment_file"
      ],
      [{ expected_package_version: "1.2.3\n[Service]" }, "invalid_input", "input"],
      [{ expected_package_version: "v1.2.3" }, "invalid_input", "input"]
    ];
    for (const [change, code, stage] of cases) {
      expectUnitError({ ...layout.input, ...change }, code, stage);
    }
  });

  it("rejects noncanonical, linked, nonregular, nonexecutable, and writable binaries", () => {
    for (const target of ["node", "codex"] as const) {
      for (const mutation of [
        "symlink",
        "directory",
        "nonexecutable",
        "group-writable",
        "systemd-quote",
        "systemd-single-quote",
        "systemd-backslash",
        "missing"
      ] as const) {
        const layout = fixture(`binary-${target}-${mutation}`, "missing");
        const original = target === "node" ? layout.nodeBin : layout.codexBin;
        let selected = original;
        if (mutation === "symlink") {
          selected = `${original}-link`;
          symlinkSync(original, selected);
        } else if (mutation === "directory") {
          rmSync(original);
          mkdirSync(original, { mode: 0o700 });
        } else if (mutation === "nonexecutable") {
          chmodSync(original, 0o600);
        } else if (mutation === "group-writable") {
          chmodSync(original, 0o720);
        } else if (mutation.startsWith("systemd-")) {
          const character =
            mutation === "systemd-quote"
              ? '"'
              : mutation === "systemd-single-quote"
                ? "'"
                : "\\";
          const directory = join(layout.root, `executable${character}path`);
          mkdirSync(directory, { mode: 0o700 });
          selected = join(directory, target);
          writeExecutable(selected);
        } else {
          rmSync(original);
        }
        expectUnitError(
          {
            ...layout.input,
            [target === "node" ? "node_bin" : "codex_bin"]: selected
          },
          target === "node" ? "node_invalid" : "codex_invalid",
          target
        );
      }
    }
  });

  it("accepts a canonical safe hard-linked executable", () => {
    const layout = fixture("binary-hardlink", "missing");
    linkSync(layout.codexBin, `${layout.codexBin}.store-link`);
    expect(lstatSync(layout.codexBin).nlink).toBe(2);
    expect(() => generateHostDeckSystemdUserUnits(layout.input)).not.toThrow();
  });

  it("rejects insecure package roots and manifest identities", () => {
    const mutations: ReadonlyArray<
      readonly [string, (layout: FixtureLayout) => void]
    > = [
      ["writable-root", (layout) => chmodSync(layout.packageRoot, 0o770)],
      ["manifest-mode", (layout) => chmodSync(layout.manifestPath, 0o600)],
      ["manifest-hardlink", (layout) => linkSync(layout.manifestPath, `${layout.manifestPath}.copy`)],
      ["manifest-json", (layout) => rewriteManifestRaw(layout, "not-json\n")],
      ["manifest-schema", (layout) => mutateManifest(layout, { schemaVersion: 3 })],
      ["manifest-name", (layout) => mutateManifest(layout, { name: "other" })],
      ["manifest-version", (layout) => mutateManifest(layout, { packageVersion: "9.9.9" })],
      ["artifact-kind", (layout) => mutateManifest(layout, { artifact: { kind: "windows_msix" } })],
      ["target-id", (layout) => mutateManifest(layout, { target: { id: "windows-x64" } })],
      ["runtime-delivery", (layout) => mutateManifest(layout, { runtime: { delivery: "bundled" } })],
      [
        "service-extra",
        (layout) =>
          mutateServiceHost(layout, { unexpected: true } as Record<string, unknown>)
      ],
      ["service-package", (layout) => mutateServiceHost(layout, { package: "other" })],
      ["service-path", (layout) => mutateServiceHost(layout, { path: "dist/other.js" })],
      ["service-version", (layout) => mutateServiceHost(layout, { version: "9.9.9" })],
      ["service-lifecycle", (layout) => mutateServiceHost(layout, { lifecycle: "windows_user_agent" })],
      ["service-hash-shape", (layout) => mutateServiceHost(layout, { sha256: "short" })],
      ["service-hash", (layout) => mutateServiceHost(layout, { sha256: "0".repeat(64) })],
      ["service-size", (layout) => mutateServiceHost(layout, { size: 1 })],
      ["service-size-bound", (layout) => mutateServiceHost(layout, { size: 16_777_217 })],
      ["host-mode", (layout) => chmodSync(layout.serviceHostPath, 0o600)],
      ["host-hardlink", (layout) => linkSync(layout.serviceHostPath, `${layout.serviceHostPath}.copy`)],
      ["host-content", (layout) => writeFileSync(layout.serviceHostPath, "changed\n")],
      [
        "host-symlink",
        (layout) => {
          const target = `${layout.serviceHostPath}.target`;
          writeFileSync(target, readFileSync(layout.serviceHostPath), { mode: 0o644 });
          rmSync(layout.serviceHostPath);
          symlinkSync(target, layout.serviceHostPath);
        }
      ]
    ];

    for (const [label, mutate] of mutations) {
      const layout = fixture(`package-${label}`, "missing");
      mutate(layout);
      expectUnitError(layout.input, "package_invalid", "package", layout.root);
    }

    const linkedRoot = fixture("package-root-link", "missing");
    const alias = `${linkedRoot.packageRoot}-alias`;
    symlinkSync(linkedRoot.packageRoot, alias);
    expectUnitError(
      { ...linkedRoot.input, package_root: alias },
      "package_invalid",
      "package",
      linkedRoot.root
    );
  });

  it("accepts absent or private opaque environment files and rejects unsafe paths", () => {
    for (const state of ["missing", "present"] as const) {
      const layout = fixture(`environment-${state}`, state);
      if (state === "present") {
        writeFileSync(
          layout.environmentFile,
          "HOSTDECK_CODEX_BIN=/ignored-by-this-leaf\nXDG_RUNTIME_DIR=/ignored\n",
          { mode: 0o600 }
        );
        chmodSync(layout.environmentFile, 0o600);
      }
      expect(() => generateHostDeckSystemdUserUnits(layout.input)).not.toThrow();
    }

    const mutations: ReadonlyArray<
      readonly [string, (layout: FixtureLayout) => GenerateHostDeckSystemdUserUnitsInput]
    > = [
      [
        "parent-mode",
        (layout) => {
          chmodSync(dirname(layout.environmentFile), 0o755);
          return layout.input;
        }
      ],
      [
        "file-mode",
        (layout) => {
          chmodSync(layout.environmentFile, 0o640);
          return layout.input;
        }
      ],
      [
        "file-hardlink",
        (layout) => {
          linkSync(layout.environmentFile, `${layout.environmentFile}.copy`);
          return layout.input;
        }
      ],
      [
        "file-size-bound",
        (layout) => {
          writeFileSync(layout.environmentFile, Buffer.alloc(1_048_577), {
            mode: 0o600
          });
          chmodSync(layout.environmentFile, 0o600);
          return layout.input;
        }
      ],
      [
        "file-directory",
        (layout) => {
          rmSync(layout.environmentFile);
          mkdirSync(layout.environmentFile, { mode: 0o600 });
          return layout.input;
        }
      ],
      [
        "file-symlink",
        (layout) => {
          const alias = `${layout.environmentFile}.alias`;
          symlinkSync(layout.environmentFile, alias);
          return { ...layout.input, environment_file: alias };
        }
      ],
      [
        "parent-symlink",
        (layout) => {
          const alias = `${dirname(layout.environmentFile)}-alias`;
          symlinkSync(dirname(layout.environmentFile), alias);
          return {
            ...layout.input,
            environment_file: join(alias, "hostdeck.env")
          };
        }
      ]
    ];
    for (const [label, mutate] of mutations) {
      const layout = fixture(`environment-invalid-${label}`, "present");
      expectUnitError(
        mutate(layout),
        "environment_file_invalid",
        "environment_file",
        layout.root
      );
    }
  });
});

type EnvironmentState = "missing" | "none" | "present";

interface FixtureLayout {
  readonly brokerHostPath: string;
  readonly codexBin: string;
  readonly environmentFile: string;
  readonly input: GenerateHostDeckSystemdUserUnitsInput;
  readonly manifestPath: string;
  readonly nodeBin: string;
  readonly packageRoot: string;
  readonly root: string;
  readonly serviceHostPath: string;
}

function fixture(
  label: string,
  environmentState: EnvironmentState,
  specialPaths = false
): FixtureLayout {
  const root = mkdtempSync(join(tmpdir(), `hostdeck-units-${label}-`));
  roots.push(root);
  chmodSync(root, 0o700);
  const base = specialPaths
    ? join(root, 'space "quote" single\'quote back\\slash %percent $dollar')
    : join(root, "layout");
  mkdirSync(base, { mode: 0o700 });
  const executableBase = specialPaths
    ? join(root, "executable space %percent $dollar")
    : base;
  if (specialPaths) mkdirSync(executableBase, { mode: 0o700 });
  const codexBin = join(executableBase, specialPaths ? "codex bin % $" : "codex");
  writeExecutable(codexBin);

  const packageRoot = specialPaths
    ? join(root, "package root % $")
    : join(base, "package");
  const distRoot = join(packageRoot, "dist");
  const runtimeBinRoot = join(packageRoot, "runtime", "bin");
  mkdirSync(distRoot, { mode: 0o755, recursive: true });
  mkdirSync(runtimeBinRoot, { mode: 0o755, recursive: true });
  chmodSync(packageRoot, 0o755);
  chmodSync(distRoot, 0o755);
  const nodeBin = join(runtimeBinRoot, "node");
  writeExecutable(nodeBin, 0o755);
  const brokerHostPath = join(distRoot, "broker-host.js");
  const brokerHostContent = "export const brokerHostFixture = true;\n";
  writeFileSync(brokerHostPath, brokerHostContent, { mode: 0o644 });
  chmodSync(brokerHostPath, 0o644);
  const serviceHostPath = join(distRoot, "service-host.js");
  const serviceHostContent = "export const serviceHostFixture = true;\n";
  writeFileSync(serviceHostPath, serviceHostContent, { mode: 0o644 });
  chmodSync(serviceHostPath, 0o644);
  const manifestPath = join(packageRoot, "hostdeck-package.json");
  writeManifest(
    manifestPath,
    brokerHostContent,
    serviceHostContent,
    readFileSync(nodeBin)
  );

  const environmentRoot = join(
    base,
    specialPaths ? 'environment "root" % $ \\' : "environment"
  );
  mkdirSync(environmentRoot, { mode: 0o700 });
  chmodSync(environmentRoot, 0o700);
  const environmentFile = join(environmentRoot, "hostdeck.env");
  if (environmentState === "present") {
    writeFileSync(environmentFile, "HOSTDECK_PORT=48721\n", { mode: 0o600 });
    chmodSync(environmentFile, 0o600);
  }

  return Object.freeze({
    brokerHostPath,
    codexBin,
    environmentFile,
    input: Object.freeze({
      codex_bin: codexBin,
      environment_file: environmentState === "none" ? null : environmentFile,
      expected_package_version: version,
      node_bin: nodeBin,
      package_root: packageRoot
    }),
    manifestPath,
    nodeBin,
    packageRoot,
    root,
    serviceHostPath
  });
}

function writeExecutable(path: string, mode = 0o700): void {
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode });
  chmodSync(path, mode);
}

function writeManifest(
  path: string,
  brokerHostContent: string,
  serviceHostContent: string,
  nodeContent: Buffer
): void {
  rewriteManifestRaw(
    { manifestPath: path },
    `${JSON.stringify(
      {
        artifact: { kind: "native_tree" },
        brokerHost: {
          lifecycle: "systemd_user",
          package: "@hostdeck/cli",
          path: "dist/broker-host.js",
          sha256: sha256(brokerHostContent),
          size: Buffer.byteLength(brokerHostContent),
          version
        },
        name: "hostdeck-production-package",
        packageVersion: version,
        runtime: {
          architecture: "x64",
          bundle: {
            path: "runtime/bin/node",
            sha256: sha256(nodeContent),
            size: nodeContent.length
          },
          delivery: "bundled",
          platform: "linux"
        },
        schemaVersion: 6,
        serviceHost: {
          lifecycle: "systemd_user",
          package: "@hostdeck/cli",
          path: "dist/service-host.js",
          sha256: sha256(serviceHostContent),
          size: Buffer.byteLength(serviceHostContent),
          version
        },
        target: {
          architecture: "x64",
          id: "linux-x64",
          lifecycle: "systemd_user",
          platform: "linux"
        }
      },
      null,
      2
    )}\n`
  );
}

function mutateManifest(
  layout: FixtureLayout,
  change: Readonly<Record<string, unknown>>
): void {
  const manifest = JSON.parse(
    readFileSync(layout.manifestPath, "utf8")
  ) as Record<string, unknown>;
  rewriteManifestRaw(layout, `${JSON.stringify({ ...manifest, ...change })}\n`);
}

function mutateServiceHost(
  layout: FixtureLayout,
  change: Readonly<Record<string, unknown>>
): void {
  const manifest = JSON.parse(
    readFileSync(layout.manifestPath, "utf8")
  ) as Record<string, unknown>;
  const serviceHost = manifest.serviceHost as Record<string, unknown>;
  rewriteManifestRaw(
    layout,
    `${JSON.stringify({
      ...manifest,
      serviceHost: { ...serviceHost, ...change }
    })}\n`
  );
}

function rewriteManifestRaw(
  layout: Pick<FixtureLayout, "manifestPath">,
  content: string
): void {
  writeFileSync(layout.manifestPath, content, { mode: 0o644 });
  chmodSync(layout.manifestPath, 0o644);
}

function expectedCodexUnit(layout: FixtureLayout): string {
  return [
    `# Generated by HostDeck ${version}. Do not edit.`,
    "[Unit]",
    `Description=HostDeck shared Codex broker (${version})`,
    "StartLimitIntervalSec=60s",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=exec",
    "WorkingDirectory=%h",
    `EnvironmentFile=-${encodeFilePath(layout.environmentFile)}`,
    `Environment=${encodeWord(`HOSTDECK_CODEX_BIN=${layout.codexBin}`, false)}`,
    "UMask=0077",
    `ExecStart=${encodeWord(layout.nodeBin, false)} ${encodeWord(layout.brokerHostPath, true)}`,
    `ExecStartPost=${encodeWord(layout.nodeBin, false)} ${encodeWord(layout.brokerHostPath, true)} --check-ready`,
    ...expectedBrokerPolicy()
  ].join("\n").concat("\n");
}

function expectedHostDeckUnit(layout: FixtureLayout): string {
  return [
    `# Generated by HostDeck ${version}. Do not edit.`,
    "[Unit]",
    `Description=HostDeck service (${version})`,
    "Wants=hostdeck-codex.service",
    "After=hostdeck-codex.service",
    "StartLimitIntervalSec=60s",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=exec",
    "WorkingDirectory=%h",
    `EnvironmentFile=-${encodeFilePath(layout.environmentFile)}`,
    `Environment=${encodeWord(`HOSTDECK_CODEX_BIN=${layout.codexBin}`, false)}`,
    "UMask=0077",
    "RuntimeDirectory=hostdeck-service/hostdeck",
    "RuntimeDirectoryMode=0700",
    `ExecStart=${encodeWord(layout.nodeBin, false)} ${encodeWord(layout.serviceHostPath, true)}`,
    ...expectedServicePolicy(),
    "",
    "[Install]",
    "WantedBy=default.target"
  ].join("\n").concat("\n");
}

function expectedServicePolicy(): readonly string[] {
  return [
    "Restart=always",
    "RestartSec=2s",
    "TimeoutStartSec=90s",
    "TimeoutStopSec=30s",
    "KillMode=control-group",
    "StandardOutput=journal",
    "StandardError=journal"
  ];
}

function expectedBrokerPolicy(): readonly string[] {
  return [
    "Restart=on-failure",
    "RestartSec=2s",
    "TimeoutStartSec=90s",
    "TimeoutStopSec=30s",
    "KillMode=mixed",
    "StandardOutput=journal",
    "StandardError=journal"
  ];
}

function encodeWord(value: string, execWord: boolean): string {
  let encoded = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%");
  if (execWord) encoded = encoded.replaceAll("$", () => "$$");
  return `"${encoded}"`;
}

function encodeFilePath(value: string): string {
  return value
    .replaceAll("\\", "\\x5c")
    .replaceAll('"', "\\x22")
    .replaceAll("'", "\\x27")
    .replaceAll(" ", "\\x20")
    .replaceAll("%", "%%");
}

function expectUnitError(
  candidate: unknown,
  code: HostDeckSystemdUserUnitErrorCode,
  stage: HostDeckSystemdUserUnitErrorStage,
  privateValue?: string
): void {
  let observed: unknown;
  try {
    generateHostDeckSystemdUserUnits(candidate);
  } catch (error) {
    observed = error;
  }
  expect(observed).toBeInstanceOf(HostDeckSystemdUserUnitError);
  const selected = observed as HostDeckSystemdUserUnitError;
  expect(selected).toMatchObject({
    code,
    message: "HostDeck systemd user-unit generation failed.",
    name: "HostDeckSystemdUserUnitError",
    stage
  });
  if (privateValue !== undefined) {
    expect(`${selected.name}:${selected.message}:${selected.stack}`).not.toContain(
      privateValue
    );
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function matches(value: string, pattern: RegExp): RegExpMatchArray[] {
  return [...value.matchAll(pattern)];
}

function sectionNames(value: string): string[] {
  return matches(value, /^\[([^\]]+)\]$/gmu).map((match) => match[1] ?? "");
}

function snapshotFiles(root: string): readonly string[] {
  const results: string[] = [];
  const visit = (path: string): void => {
    const stats = lstatSync(path);
    results.push(`${path.slice(root.length)}:${stats.mode}:${stats.size}:${stats.nlink}`);
    if (!stats.isDirectory()) return;
    for (const name of readdirSync(path).sort((left, right) => left.localeCompare(right))) {
      visit(join(path, name));
    }
  };
  visit(root);
  return results;
}
