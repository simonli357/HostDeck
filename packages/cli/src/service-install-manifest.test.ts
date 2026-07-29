import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertHostDeckServiceManifestMatchesLayout,
  createHostDeckServiceInstallManifest,
  parseHostDeckServiceInstallManifest,
  renderHostDeckServiceEnvironment,
  renderHostDeckServiceInstallManifest,
  resolveHostDeckServiceInstallLayout
} from "./service-install-manifest.js";

describe("IFC-V1-056 service install manifest", () => {
  it("derives one deterministic default and custom XDG layout without mutation", () => {
    const defaults = resolveHostDeckServiceInstallLayout({
      HOME: "/home/hostdeck",
      PATH: "/usr/bin"
    });
    expect(defaults).toEqual({
      command_path: "/home/hostdeck/.local/bin/codexdeck",
      config_root: "/home/hostdeck/.config",
      current_link: "/home/hostdeck/.local/share/hostdeck/current",
      data_root: "/home/hostdeck/.local/share/hostdeck",
      enablement_link:
        "/home/hostdeck/.config/systemd/user/default.target.wants/hostdeck.service",
      environment_file: "/home/hostdeck/.config/hostdeck/service.env",
      home_dir: "/home/hostdeck",
      lifecycle_lock: "/home/hostdeck/.local/share/hostdeck/lifecycle.lock",
      manifest_link: "/home/hostdeck/.local/share/hostdeck/install.json",
      releases_dir: "/home/hostdeck/.local/share/hostdeck/releases",
      systemd_user_dir: "/home/hostdeck/.config/systemd/user",
      transaction_file:
        "/home/hostdeck/.local/share/hostdeck/lifecycle-transaction.json",
      unit_paths: {
        "hostdeck-codex.service":
          "/home/hostdeck/.config/systemd/user/hostdeck-codex.service",
        "hostdeck.service":
          "/home/hostdeck/.config/systemd/user/hostdeck.service"
      }
    });
    expect(Object.isFrozen(defaults)).toBe(true);
    expect(Object.isFrozen(defaults.unit_paths)).toBe(true);

    const custom = resolveHostDeckServiceInstallLayout({
      HOME: "/home/hostdeck",
      PATH: "/usr/bin",
      XDG_CONFIG_HOME: "/home/hostdeck/config",
      XDG_DATA_HOME: "/home/hostdeck/data"
    });
    expect(custom.data_root).toBe("/home/hostdeck/data/hostdeck");
    expect(custom.environment_file).toBe(
      "/home/hostdeck/config/hostdeck/service.env"
    );
  });

  it("renders only the sorted non-secret service environment allowlist", () => {
    const descriptor = renderHostDeckServiceEnvironment({
      database_path: "/home/hostdeck/state/hostdeck.sqlite",
      env: {
        API_TOKEN: "must-not-appear",
        CODEX_HOME: "/home/hostdeck/.codex",
        HOSTDECK_CODEX_BIN: "/private/codex",
        PATH: "/home/hostdeck/bin:/usr/bin",
        XDG_CONFIG_HOME: "/home/hostdeck/config",
        XDG_RUNTIME_DIR: "/run/user/1000",
        XDG_STATE_HOME: "/home/hostdeck/state-home"
      },
      home_dir: "/home/hostdeck",
      port: 3777,
      state_dir: "/home/hostdeck/state"
    });
    expect(descriptor.content).toBe(
      [
        'CODEX_HOME="/home/hostdeck/.codex"',
        'HOME="/home/hostdeck"',
        'HOSTDECK_DATABASE_PATH="/home/hostdeck/state/hostdeck.sqlite"',
        'HOSTDECK_PORT="3777"',
        'HOSTDECK_STATE_DIR="/home/hostdeck/state"',
        'PATH="/home/hostdeck/bin:/usr/bin"',
        'XDG_CONFIG_HOME="/home/hostdeck/config"',
        'XDG_STATE_HOME="/home/hostdeck/state-home"',
        ""
      ].join("\n")
    );
    expect(descriptor.mode).toBe(0o600);
    expect(descriptor.sha256).toBe(sha256(descriptor.content));
    expect(descriptor.content).not.toMatch(
      /API_TOKEN|HOSTDECK_CODEX_BIN|XDG_RUNTIME_DIR|must-not-appear|private/u
    );
  });

  it("creates a deterministic canonical self-hashed strict owner manifest", () => {
    const layout = resolveHostDeckServiceInstallLayout({
      HOME: "/home/hostdeck",
      PATH: "/usr/bin"
    });
    const manifest = createHostDeckServiceInstallManifest({
      codex_bin: "/home/hostdeck/bin/codex",
      environment_sha256: "3".repeat(64),
      layout,
      node_bin: "/usr/bin/node",
      package_content_sha256: "2".repeat(64),
      package_manifest_sha256: "1".repeat(64),
      package_version: "1.2.3",
      units: unitDescriptors()
    });
    const content = renderHostDeckServiceInstallManifest(manifest);
    const parsed = parseHostDeckServiceInstallManifest(content);

    expect(parsed).toEqual(manifest);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.units)).toBe(true);
    expect(parsed.release.id).toBe(`1.2.3-${"1".repeat(64)}`);
    expect(parsed.release.selector_target).toBe(
      join("releases", parsed.release.id)
    );
    expect(parsed.command.target).toBe(
      "/home/hostdeck/.local/share/hostdeck/current/package/dist/shell.js"
    );
    expect(() =>
      assertHostDeckServiceManifestMatchesLayout(parsed, layout)
    ).not.toThrow();
    expect(content).toBe(`${JSON.stringify(JSON.parse(content), sortedKeys)}\n`);
  });

  it("rejects noncanonical, duplicate, extra, hash-drifted, and substituted manifests", () => {
    const manifest = createHostDeckServiceInstallManifest({
      codex_bin: "/home/hostdeck/bin/codex",
      environment_sha256: "3".repeat(64),
      layout: resolveHostDeckServiceInstallLayout({
        HOME: "/home/hostdeck",
        PATH: "/usr/bin"
      }),
      node_bin: "/usr/bin/node",
      package_content_sha256: "2".repeat(64),
      package_manifest_sha256: "1".repeat(64),
      package_version: "1.2.3",
      units: unitDescriptors()
    });
    const canonical = renderHostDeckServiceInstallManifest(manifest);
    const parsed = JSON.parse(canonical) as Record<string, unknown>;
    const mutations = [
      `${canonical.trim()} `,
      canonical.replace(
        '{"command":',
        '{"name":"hostdeck-service-install","command":'
      ),
      `${JSON.stringify({ ...parsed, extra: true })}\n`,
      `${JSON.stringify({ ...parsed, manifest_sha256: "0".repeat(64) })}\n`,
      `${JSON.stringify({
        ...parsed,
        release: {
          ...(parsed.release as Record<string, unknown>),
          package_root: "/tmp/substituted"
        }
      })}\n`
    ];
    for (const content of mutations) {
      expect(() => parseHostDeckServiceInstallManifest(content)).toThrow();
    }

    const accessor = Object.defineProperty(
      { ...manifest },
      "schema_version",
      { enumerable: true, get: () => 1 }
    );
    expect(() => renderHostDeckServiceInstallManifest(accessor)).toThrow();
  });

  it("rejects invalid roots, paths, ports, and environment controls", () => {
    expect(() =>
      resolveHostDeckServiceInstallLayout({ HOME: "relative", PATH: "/usr/bin" })
    ).toThrow();
    expect(() =>
      resolveHostDeckServiceInstallLayout({
        HOME: "/home/hostdeck",
        PATH: "/usr/bin",
        XDG_CONFIG_HOME: "/home/hostdeck/shared",
        XDG_DATA_HOME: "/home/hostdeck/shared"
      })
    ).toThrow();
    for (const env of [
      {
        HOME: "/home/hostdeck",
        XDG_DATA_HOME: "/home/hostdeck/.local/bin/codexdeck"
      },
      {
        HOME: "/home/hostdeck",
        XDG_DATA_HOME: "/home/hostdeck/.config/systemd/user"
      },
      {
        HOME: "/home/hostdeck",
        XDG_CONFIG_HOME: "/home/hostdeck/.local/bin/codexdeck"
      }
    ]) {
      expect(() =>
        resolveHostDeckServiceInstallLayout({ ...env, PATH: "/usr/bin" })
      ).toThrow();
    }
    for (const input of [
      { database_path: "/other/db", port: 3777, path: "/usr/bin" },
      { database_path: "/home/hostdeck/state/db", port: 0, path: "/usr/bin" },
      {
        database_path: "/home/hostdeck/state/db",
        port: 3777,
        path: "/usr/bin\nSECRET=value"
      },
      {
        database_path: "/home/hostdeck/state/db",
        port: 3777,
        path: "relative/bin"
      }
    ]) {
      expect(() =>
        renderHostDeckServiceEnvironment({
          database_path: input.database_path,
          env: { PATH: input.path },
          home_dir: "/home/hostdeck",
          port: input.port,
          state_dir: "/home/hostdeck/state"
        })
      ).toThrow();
    }
  });

  it("accepts canonical prereleases and rejects malformed semantic versions", () => {
    const layout = resolveHostDeckServiceInstallLayout({
      HOME: "/home/hostdeck",
      PATH: "/usr/bin"
    });
    const create = (packageVersion: string) =>
      createHostDeckServiceInstallManifest({
        codex_bin: "/home/hostdeck/bin/codex",
        environment_sha256: "3".repeat(64),
        layout,
        node_bin: "/usr/bin/node",
        package_content_sha256: "2".repeat(64),
        package_manifest_sha256: "1".repeat(64),
        package_version: packageVersion,
        units: unitDescriptors()
      });

    expect(create("1.2.3-alpha-beta.7a").release.package_version).toBe(
      "1.2.3-alpha-beta.7a"
    );
    for (const invalid of [
      "01.2.3",
      "1.02.3",
      "1.2.03",
      "1.2.3-01",
      "1.2.3-alpha..1",
      "1.2.3-",
      `1.2.3-${"a".repeat(257)}`
    ]) {
      expect(() => create(invalid)).toThrow();
    }
  });
});

function unitDescriptors() {
  const codexContent = "codex-unit\n";
  const hostDeckContent = "hostdeck-unit\n";
  return [
    {
      content: codexContent,
      mode: 0o644 as const,
      name: "hostdeck-codex.service" as const,
      sha256: sha256(codexContent)
    },
    {
      content: hostDeckContent,
      mode: 0o644 as const,
      name: "hostdeck.service" as const,
      sha256: sha256(hostDeckContent)
    }
  ] as const;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sortedKeys(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
  );
}
