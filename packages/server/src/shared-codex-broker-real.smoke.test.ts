import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseCodexCliVersionOutput } from "@hostdeck/codex-adapter";
import type { SharedCodexEndpointLocation } from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import {
  startSharedCodexBroker,
  stopOwnedSharedCodexBroker
} from "./shared-codex-broker-lifecycle.js";

const requireSmoke =
  process.env.HOSTDECK_REQUIRE_SHARED_CODEX_BROKER_SMOKE === "1";

describe.skipIf(!requireSmoke)("real shared Codex broker lifecycle", () => {
  it(
    "starts exact Codex on the standard socket, admits it, preserves it across close, and stops only by proof",
    async () => {
      const codexBin = realpathSync.native(
        resolve(
          process.env.HOSTDECK_CODEX_BIN ??
            execFileSync("which", ["codex"], {
              encoding: "utf8",
              timeout: 5_000,
              maxBuffer: 16 * 1_024
            }).trim()
        )
      );
      const version = parseCodexCliVersionOutput(
        execFileSync(codexBin, ["--version"], {
          encoding: "utf8",
          timeout: 10_000,
          maxBuffer: 64 * 1_024
        })
      );
      expect(version).toBe("0.147.0");

      const root = mkdtempSync(join(tmpdir(), "hostdeck-real-shared-broker-"));
      const codexHome = join(root, "codex-home");
      mkdirSync(codexHome, { mode: 0o700 });
      chmodSync(codexHome, 0o700);
      writeFileSync(
        join(codexHome, "config.toml"),
        "check_for_update_on_startup = false\n[features]\nplugins = false\n",
        { mode: 0o600 }
      );
      const location: SharedCodexEndpointLocation = Object.freeze({
        kind: "standard_unix",
        codex_home: codexHome,
        socket_path: join(
          codexHome,
          "app-server-control",
          "app-server-control.sock"
        )
      });
      const ownerPath = join(
        codexHome,
        "app-server-control",
        "hostdeck-broker-owner.json"
      );
      let owned = false;
      let primary: unknown = null;
      const cleanupErrors: unknown[] = [];
      try {
        const first = await startSharedCodexBroker({
          codex_bin: codexBin,
          location,
          mode: "attach_or_start",
          observed_version: version,
          startup_timeout_ms: 15_000
        });
        owned = true;
        expect(first.endpoint).toMatchObject({
          state: "ready",
          ownership: "owned",
          observed_version: "0.147.0"
        });
        expect(lstatSync(location.socket_path).mode & 0o7777).toBe(0o600);
        expect(lstatSync(ownerPath).mode & 0o7777).toBe(0o600);
        const pid = (
          JSON.parse(readFileSync(ownerPath, "utf8")) as { readonly pid: number }
        ).pid;

        await first.close();
        expect(processIsAlive(pid)).toBe(true);
        expect(existsSync(location.socket_path)).toBe(true);

        const versionState = JSON.parse(
          execFileSync(
            codexBin,
            ["app-server", "daemon", "version"],
            {
              cwd: root,
              env: { ...process.env, CODEX_HOME: codexHome },
              encoding: "utf8",
              timeout: 10_000,
              maxBuffer: 64 * 1_024
            }
          )
        ) as Record<string, unknown>;
        expect(JSON.stringify(versionState)).toContain("0.147.0");

        const second = await startSharedCodexBroker({
          codex_bin: codexBin,
          location,
          mode: "attach_only",
          observed_version: version,
          startup_timeout_ms: 10_000
        });
        expect(second.endpoint).toMatchObject({
          state: "ready",
          ownership: "owned",
          generation: first.endpoint.generation
        });
        await second.close();

        await stopOwnedSharedCodexBroker({
          location,
          stop_timeout_ms: 5_000
        });
        owned = false;
        expect(processIsAlive(pid)).toBe(false);
        expect(existsSync(location.socket_path)).toBe(false);
        expect(existsSync(ownerPath)).toBe(false);
      } catch (error) {
        primary = error;
      } finally {
        if (owned) {
          try {
            await stopOwnedSharedCodexBroker({
              location,
              stop_timeout_ms: 5_000
            });
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        try {
          rmSync(root, { recursive: true, force: true });
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (primary !== null && cleanupErrors.length === 0) throw primary;
      if (primary !== null || cleanupErrors.length > 0) {
        throw new AggregateError(
          primary === null ? cleanupErrors : [primary, ...cleanupErrors],
          "Shared broker smoke and cleanup failed."
        );
      }
    },
    40_000
  );
});

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
