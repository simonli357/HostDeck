import {
  chmodSync,
  mkdtempSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeSelectedDeviceListCursor,
  encodeSelectedDeviceListCursor,
  type SelectedDeviceListResponse,
  selectedDeviceListResponseSchema
} from "@hostdeck/contracts";
import {
  createAuthDeviceRepository,
  defaultMigrations,
  type ExistingHostDeckReadOnlyDatabase,
  openExistingHostDeckReadOnlyDatabase,
  openMigratedDatabase
} from "@hostdeck/storage";
import { afterEach, describe, expect, it } from "vitest";
import { cliExitCodes } from "./exit-codes.js";
import {
  createHostDeckLocalDeviceList,
  type HostDeckLocalDeviceListInput
} from "./local-device-list.js";
import { renderDeviceList } from "./render.js";
import { runCli } from "./shell.js";

const tempDirs: string[] = [];
const createdAt = new Date("2026-07-20T20:00:00.000Z");
const timestamp = createdAt.toISOString();

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("secure local device-list CLI path", () => {
  it("lists canonical real pages without exposing stored credentials", () => {
    const harness = createHarness([
      "client_local_list_001",
      "client_local_list_002",
      "client_local_list_003"
    ]);
    const list = createHostDeckLocalDeviceList({
      stateDir: harness.stateDir,
      databasePath: harness.databasePath
    });

    const first = list.list({ limit: 2, cursor: null });
    expect(first.devices.map(({ device_id }) => device_id)).toEqual([
      "client_local_list_001",
      "client_local_list_002"
    ]);
    expect(first.has_more).toBe(true);
    expect(first.next_cursor).not.toBeNull();
    expect(
      decodeSelectedDeviceListCursor(first.next_cursor as string)
    ).toBe("client_local_list_002");

    const second = list.list({ limit: 2, cursor: first.next_cursor });
    expect(second).toMatchObject({
      devices: [{ device_id: "client_local_list_003" }],
      has_more: false,
      next_cursor: null
    });
    expect(Object.isFrozen(list)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.devices)).toBe(true);
    expect(Object.isFrozen(first.devices[0])).toBe(true);
    const serialized = JSON.stringify([first, second]);
    for (const secret of harness.rawSecrets) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toMatch(/token_hash|csrf_token_hash|cookie/iu);
  });

  it("rejects hostile options and input before opening storage", () => {
    let accessorCalls = 0;
    let openCalls = 0;
    const optionAccessor = Object.defineProperty(
      { databasePath: "/tmp/state/hostdeck.sqlite" },
      "stateDir",
      {
        enumerable: true,
        get() {
          accessorCalls += 1;
          return "/tmp/state";
        }
      }
    );
    for (const candidate of [
      null,
      {},
      { stateDir: "/tmp/state" },
      { stateDir: "/tmp/state", databasePath: 7 },
      {
        stateDir: "/tmp/state",
        databasePath: "/tmp/state/hostdeck.sqlite",
        extra: true
      },
      optionAccessor
    ]) {
      expect(() =>
        createHostDeckLocalDeviceList(candidate as never)
      ).toThrow(TypeError);
    }
    expect(accessorCalls).toBe(0);

    const list = createHostDeckLocalDeviceList({
      stateDir: "/tmp/state",
      databasePath: "/tmp/state/hostdeck.sqlite",
      openDatabase() {
        openCalls += 1;
        throw new Error("must not open");
      }
    });
    const inputAccessor = Object.defineProperty(
      { cursor: null },
      "limit",
      {
        enumerable: true,
        get() {
          accessorCalls += 1;
          return 1;
        }
      }
    );
    for (const candidate of [
      null,
      {},
      { limit: null },
      { limit: 0, cursor: null },
      { limit: 101, cursor: null },
      { limit: 1.5, cursor: null },
      { limit: null, cursor: "invalid" },
      { limit: null, cursor: null, private: true },
      inputAccessor
    ]) {
      expect(() => list.list(candidate as never)).toThrowError(
        expect.objectContaining({
          code: "internal_error",
          message: "HostDeck local device-list input is invalid."
        })
      );
    }
    expect(accessorCalls).toBe(0);
    expect(openCalls).toBe(0);
  });

  it("invokes one repository query and closes before returning", () => {
    const events: string[] = [];
    const rows = [rawDeviceRow("client_local_fake_001")];
    const fakeDatabase = {
      prepare(sql: string) {
        events.push(`prepare:${sql}`);
        return {
          all(...values: unknown[]) {
            events.push(`all:${JSON.stringify(values)}`);
            return rows;
          }
        };
      }
    };
    const list = createHostDeckLocalDeviceList({
      stateDir: "/tmp/state",
      databasePath: "/tmp/state/hostdeck.sqlite",
      openDatabase: () =>
        ({
          db: fakeDatabase,
          migration: { applied: [], currentVersion: "current" },
          verifyPath() {
            events.push("verify");
          },
          close() {
            events.push("close");
          }
        }) as unknown as ExistingHostDeckReadOnlyDatabase
    });

    const response = list.list({ limit: 1, cursor: null });
    expect(response.devices).toHaveLength(1);
    expect(events).toEqual([
      "prepare:SELECT * FROM auth_devices ORDER BY id ASC LIMIT ?",
      "all:[2]",
      "verify",
      "close"
    ]);
  });

  it("returns no page when storage close fails and sanitizes the failure", () => {
    const harness = createHarness(["client_local_close_001"]);
    const sentinel = `${harness.databasePath}:private-close-sentinel`;
    const list = createHostDeckLocalDeviceList({
      stateDir: harness.stateDir,
      databasePath: harness.databasePath,
      openDatabase(input) {
        const opened = openExistingHostDeckReadOnlyDatabase(input);
        return Object.freeze({
          ...opened,
          close() {
            opened.close();
            throw new Error(sentinel);
          }
        });
      }
    });

    expect(() => list.list({ limit: 1, cursor: null })).toThrowError(
      expect.objectContaining({
        code: "internal_error",
        message: "HostDeck device database could not be closed safely."
      })
    );
    try {
      list.list({ limit: 1, cursor: null });
    } catch (error) {
      expect(String(error)).not.toContain(sentinel);
      expect(JSON.stringify(error)).not.toContain(harness.databasePath);
    }
  });

  it("sanitizes hostile thrown values without traversing their prototype", () => {
    const sentinel = "private-hostile-prototype-sentinel";
    let prototypeReads = 0;
    const hostile = new Proxy(Object.create(null) as object, {
      getPrototypeOf() {
        prototypeReads += 1;
        throw new Error(sentinel);
      }
    });
    const list = createHostDeckLocalDeviceList({
      stateDir: "/tmp/state",
      databasePath: "/tmp/state/hostdeck.sqlite",
      openDatabase() {
        throw hostile;
      }
    });

    let caught: unknown;
    try {
      list.list({ limit: 1, cursor: null });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "internal_error",
      message: "HostDeck local device listing failed."
    });
    expect(String(caught)).not.toContain(sentinel);
    expect(prototypeReads).toBeGreaterThan(0);
  });

  it("maps missing, insecure, and stale storage to one path-free config failure", () => {
    const root = tempRoot();
    const missingPath = join(root, "missing.sqlite");
    const missing = createHostDeckLocalDeviceList({
      stateDir: root,
      databasePath: missingPath
    });
    expectConfigFailure(() => missing.list({ limit: null, cursor: null }), root);

    const insecure = createHarness([]);
    chmodSync(insecure.databasePath, 0o644);
    expectConfigFailure(
      () =>
        createHostDeckLocalDeviceList({
          stateDir: insecure.stateDir,
          databasePath: insecure.databasePath
        }).list({ limit: null, cursor: null }),
      insecure.stateDir
    );

    const stale = createHarness([], defaultMigrations.slice(0, -1));
    expectConfigFailure(
      () =>
        createHostDeckLocalDeviceList({
          stateDir: stale.stateDir,
          databasePath: stale.databasePath
        }).list({ limit: null, cursor: null }),
      stale.stateDir
    );
  });

  it("dispatches local devices once without constructing or invoking network transport", async () => {
    const cursor = encodeSelectedDeviceListCursor("client_cli_before_001");
    const requests: HostDeckLocalDeviceListInput[] = [];
    let fetchCalls = 0;
    const response = deviceResponse({
      deviceId: "client_cli_device_001",
      label: "Xiaomi 15 Pro"
    });
    const result = await runCli(
      ["devices", "--limit=1", `--cursor=${cursor}`, "--json"],
      {
        env: {
          HOSTDECK_STATE_DIR: "/tmp/hostdeck-cli-state",
          HOSTDECK_DATABASE_PATH:
            "/tmp/hostdeck-cli-state/hostdeck.sqlite"
        },
        fetch: async () => {
          fetchCalls += 1;
          throw new Error("devices must not use HTTP");
        },
        localDeviceList: {
          list(input) {
            requests.push(input);
            return response;
          }
        }
      }
    );

    expect(result.exitCode).toBe(cliExitCodes.ok);
    expect(JSON.parse(result.stdout)).toEqual(response);
    expect(requests).toEqual([{ limit: 1, cursor }]);
    expect(fetchCalls).toBe(0);
  });

  it("runs the complete shell path against the existing secure database", async () => {
    const harness = createHarness([
      "client_cli_real_001",
      "client_cli_real_002"
    ]);
    let fetchCalls = 0;
    const result = await runCli(
      ["devices", "--limit=1", "--json"],
      {
        env: {
          HOSTDECK_STATE_DIR: harness.stateDir,
          HOSTDECK_DATABASE_PATH: harness.databasePath
        },
        fetch: async () => {
          fetchCalls += 1;
          throw new Error("devices must not use HTTP");
        }
      }
    );

    expect(result).toMatchObject({
      exitCode: cliExitCodes.ok,
      stderr: ""
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      devices: [{ device_id: "client_cli_real_001" }],
      has_more: true
    });
    expect(fetchCalls).toBe(0);
  });

  it("revalidates injected pages and renders only escaped public metadata", async () => {
    const invalid = selectedDeviceListResponseSchema.parse({
      devices: [
        deviceItem("client_cli_invalid_001"),
        deviceItem("client_cli_invalid_002")
      ],
      next_cursor: null,
      has_more: false
    });
    const rejected = await runCli(["devices", "--limit=1"], {
      env: {},
      localDeviceList: { list: () => invalid }
    });
    expect(rejected).toMatchObject({
      exitCode: cliExitCodes.internal,
      stdout: ""
    });
    expect(rejected.stderr).toContain("internal_error");

    const response = deviceResponse({
      deviceId: "client_cli_render_001",
      label: "Xiaomi\n\u001b[31mprivate-token-cookie-csrf"
    });
    const human = renderDeviceList(response, false);
    expect(human).toContain("Paired devices: 1");
    expect(human).toContain("Xiaomi\\n\\u001b[31m");
    expect(human).not.toContain("\u001b[31m");
    expect(human).not.toMatch(/token_hash|csrf_token_hash|raw_device_token/iu);
    expect(JSON.parse(renderDeviceList(response, true))).toEqual(response);
  });
});

interface Harness {
  readonly stateDir: string;
  readonly databasePath: string;
  readonly rawSecrets: readonly string[];
}

function createHarness(
  ids: readonly string[],
  migrations = defaultMigrations
): Harness {
  const stateDir = tempRoot();
  const databasePath = join(stateDir, "hostdeck.sqlite");
  const opened = openMigratedDatabase(databasePath, {
    migrations,
    now: () => createdAt
  });
  const rawSecrets: string[] = [];
  try {
    const auth = createAuthDeviceRepository(opened.db);
    for (const id of ids) {
      const rawDeviceToken = `device-token:${id}:${"D".repeat(24)}`;
      const rawCsrfToken = `csrf-token:${id}:${"C".repeat(24)}`;
      rawSecrets.push(rawDeviceToken, rawCsrfToken);
      auth.create({
        id,
        rawDeviceToken,
        rawCsrfToken,
        permission: id.endsWith("1") ? "read" : "write",
        clientLabel: `Android ${id}`,
        createdAt
      });
    }
  } finally {
    opened.db.close();
    chmodSync(databasePath, 0o600);
  }
  return { stateDir, databasePath, rawSecrets };
}

function rawDeviceRow(id: string) {
  return {
    id,
    token_hash: "a".repeat(64),
    csrf_token_hash: "b".repeat(64),
    csrf_generation: 1,
    csrf_rotated_at: timestamp,
    client_label: "Android fake",
    permission: "read",
    created_at: timestamp,
    last_used_at: null,
    expires_at: null,
    revoked_at: null
  };
}

function deviceItem(deviceId: string) {
  return {
    device_id: deviceId,
    client_label: "Android fixture",
    permission: "write" as const,
    created_at: timestamp,
    last_used_at: null,
    expires_at: null,
    revoked_at: null
  };
}

function deviceResponse(input: {
  readonly deviceId: string;
  readonly label: string;
}): SelectedDeviceListResponse {
  return selectedDeviceListResponseSchema.parse({
    devices: [
      {
        ...deviceItem(input.deviceId),
        client_label: input.label
      }
    ],
    next_cursor: null,
    has_more: false
  });
}

function expectConfigFailure(run: () => unknown, privatePath: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({
    code: "invalid_config",
    exitCode: cliExitCodes.config,
    field: "database_path",
    message:
      "HostDeck device database must already exist with secure paths and the current schema."
  });
  expect(String(caught)).not.toContain(privatePath);
  expect(JSON.stringify(caught)).not.toContain(privatePath);
}

function tempRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-local-device-list-"));
  tempDirs.push(directory);
  return directory;
}
