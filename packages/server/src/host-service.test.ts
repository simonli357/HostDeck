import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPairingCodeRepository } from "@hostdeck/storage";
import {
  createFakeTmuxAdapter,
  parseSessionIdFromTmuxSessionName,
  type RealTmuxTargetDiscovery,
  tmuxSessionNameForSession
} from "@hostdeck/tmux-adapter";
import { afterEach, describe, expect, it } from "vitest";
import { startHostHttpService } from "./host-service.js";
import { isHostReady } from "./startup.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("foreground host service smoke", () => {
  it("starts, reports status, stays reachable until stopped, fails unavailable after stop, and restarts from durable state", async () => {
    const port = await getAvailablePort("127.0.0.1");
    const stateDir = tempDir("hostdeck-service-state-");
    const databasePath = join(stateDir, "hostdeck.sqlite");
    const first = await startHostHttpService({
      version: "0.0.0-service-smoke",
      ...localPaths(),
      stateDir,
      databasePath,
      bindPort: port,
      discovery: emptyDiscovery(),
      now: fixedNow,
      startOutputReader: noopOutputReader
    });

    try {
      expect(first.baseUrl.toString()).toBe(`http://127.0.0.1:${port}/`);
      expect(isHostReady(first.status())).toBe(true);
      await expect(fetchStatus(first.baseUrl)).resolves.toMatchObject({
        version: "0.0.0-service-smoke",
        bind: {
          mode: "localhost",
          host: "127.0.0.1",
          port
        },
        storage: { state: "ok" },
        tmux: { state: "ok" },
        stream: { state: "ok" },
        last_error: null
      });

      await wait(25);
      await expect(fetchStatus(first.baseUrl)).resolves.toMatchObject({
        version: "0.0.0-service-smoke"
      });
    } finally {
      await first.close();
    }

    await expect(fetchStatus(new URL(`http://127.0.0.1:${port}`))).rejects.toThrow();

    const restarted = await startHostHttpService({
      version: "0.0.0-service-smoke",
      ...localPaths(),
      stateDir,
      databasePath,
      bindPort: port,
      discovery: emptyDiscovery(),
      now: laterNow,
      startOutputReader: noopOutputReader
    });

    try {
      expect(isHostReady(restarted.status())).toBe(true);
      await expect(fetchStatus(restarted.baseUrl)).resolves.toMatchObject({
        version: "0.0.0-service-smoke",
        bind: {
          host: "127.0.0.1",
          port
        },
        last_error: null
      });
    } finally {
      await restarted.close();
    }
  });

  it("releases the daemon lease when the final HTTP listener bind fails", async () => {
    const blocker = await listenOn("127.0.0.1", 0);
    const address = blocker.address();
    if (address === null || typeof address === "string") throw new Error("Expected an allocated TCP port.");
    const stateDir = tempDir("hostdeck-service-bind-failure-state-");
    const paths = localPaths();

    try {
      await expect(
        startHostHttpService({
          version: "0.0.0-service-bind-failure",
          ...paths,
          stateDir,
          bindPort: address.port,
          checkNetworkBind() {},
          discovery: emptyDiscovery(),
          now: fixedNow
        })
      ).rejects.toThrow();
    } finally {
      await closeServer(blocker);
    }

    const recovered = await startHostHttpService({
      version: "0.0.0-service-bind-recovery",
      ...paths,
      stateDir,
      bindPort: address.port,
      discovery: emptyDiscovery(),
      now: laterNow
    });
    await recovered.close();
  });

  it("registers session, write, security, and network route families with typed failures", async () => {
    const port = await getAvailablePort("127.0.0.1");
    const stateDir = tempDir("hostdeck-service-routes-state-");
    const service = await startHostHttpService({
      version: "0.0.0-service-routes",
      ...localPaths(),
      stateDir,
      bindPort: port,
      discovery: emptyDiscovery(),
      tmux: createFakeTmuxAdapter({ now: fixedNow }),
      now: fixedNow
    });

    try {
      const started = await fetchJson(service.baseUrl, "/api/sessions", {
        method: "POST",
        body: {
          name: "http-demo",
          cwd: stateDir
        }
      });

      expect(started.status).toBe(201);
      expect(started.body).toMatchObject({
        session: {
          name: "http-demo",
          lifecycle_state: "running"
        }
      });

      const sessionId = (started.body as { session: { id: string } }).session.id;
      await expect(fetchJson(service.baseUrl, "/api/sessions")).resolves.toMatchObject({
        status: 200,
        body: {
          sessions: [expect.objectContaining({ id: sessionId })]
        }
      });
      await expect(fetchJson(service.baseUrl, `/api/sessions/${sessionId}`)).resolves.toMatchObject({
        status: 200,
        body: {
          session: expect.objectContaining({ id: sessionId })
        }
      });
      await expect(fetchJson(service.baseUrl, `/api/sessions/${sessionId}/output?after=0`)).resolves.toMatchObject({
        status: 200,
        body: {
          session_id: sessionId,
          events: []
        }
      });

      const browserWriteWithoutCookie = await fetchJson(service.baseUrl, `/api/sessions/${sessionId}/input`, {
        method: "POST",
        headers: {
          origin: service.baseUrl.origin
        },
        body: { text: "browser should need trust" }
      });
      expect(browserWriteWithoutCookie).toMatchObject({
        status: 401,
        body: {
          accepted: false,
          error: {
            code: "permission_denied"
          }
        }
      });

      await expect(
        fetchJson(service.baseUrl, "/api/pair/claim", {
          method: "POST",
          headers: {
            origin: "http://example.invalid"
          },
          body: { code: "123456" }
        })
      ).resolves.toMatchObject({
        status: 403,
        body: {
          error: {
            code: "permission_denied",
            field: "origin"
          }
        }
      });

      createPairingCodeRepository(service.startup.db).create({
        id: "pair_http_routes_01",
        rawCode: "123456",
        permission: "write",
        clientLabel: "phone",
        createdAt: fixedNow(),
        expiresAt: new Date("2026-07-09T09:00:00.000Z")
      });
      const claim = await fetchRaw(service.baseUrl, "/api/pair/claim", {
        method: "POST",
        headers: {
          origin: service.baseUrl.origin
        },
        body: { code: "123456", client_label: "phone" }
      });
      expect(claim.status).toBe(200);
      expect(claim.body).toMatchObject({
        trusted: true,
        read_only: false,
        auth_transport: "http_only_cookie"
      });
      const csrfToken = (claim.body as { csrf_token: string }).csrf_token;
      const cookie = claim.headers.get("set-cookie")?.split(";")[0];
      expect(cookie).toMatch(/^hostdeck_device=/u);

      const cookieOnlyWrite = await fetchJson(service.baseUrl, `/api/sessions/${sessionId}/input`, {
        method: "POST",
        headers: {
          cookie: cookie ?? "",
          origin: service.baseUrl.origin
        },
        body: { text: "cookie alone should fail" }
      });
      expect(cookieOnlyWrite).toMatchObject({
        status: 401,
        body: {
          accepted: false,
          error: {
            code: "permission_denied"
          }
        }
      });

      await expect(
        fetchJson(service.baseUrl, `/api/sessions/${sessionId}/input`, {
          method: "POST",
          headers: {
            cookie: cookie ?? "",
            origin: service.baseUrl.origin,
            "x-hostdeck-csrf": csrfToken
          },
          body: { text: "trusted browser write" }
        })
      ).resolves.toMatchObject({
        status: 202,
        body: {
          accepted: true,
          action: "prompt",
          session_id: sessionId
        }
      });

      await expect(fetchJson(service.baseUrl, "/api/security/state")).resolves.toMatchObject({
        status: 200,
        body: {
          trusted: false,
          locked: false,
          lan_enabled: false
        }
      });
      await expect(fetchJson(service.baseUrl, "/api/network/state")).resolves.toMatchObject({
        status: 200,
        body: {
          mode: "localhost",
          host: "127.0.0.1",
          lan_enabled: false
        }
      });
      await expect(fetchJson(service.baseUrl, "/api/security/unlock", { method: "POST" })).resolves.toMatchObject({
        status: 403,
        body: {
          error: {
            code: "permission_denied"
          }
        }
      });
    } finally {
      await service.close();
    }
  });

  it("returns typed HTTP adapter errors for unsupported methods, unknown routes, and malformed JSON", async () => {
    const port = await getAvailablePort("127.0.0.1");
    const service = await startHostHttpService({
      version: "0.0.0-service-errors",
      ...localPaths(),
      stateDir: tempDir("hostdeck-service-errors-state-"),
      bindPort: port,
      discovery: emptyDiscovery(),
      tmux: createFakeTmuxAdapter({ now: fixedNow }),
      now: fixedNow
    });

    try {
      await expect(fetchJson(service.baseUrl, "/api/host/status", { method: "POST" })).resolves.toMatchObject({
        status: 405,
        body: {
          error: {
            code: "validation_error",
            field: "method"
          }
        }
      });
      await expect(fetchJson(service.baseUrl, "/api/not-real")).resolves.toMatchObject({
        status: 404,
        body: {
          error: {
            code: "malformed_request",
            field: "route"
          }
        }
      });
      await expect(fetchRawText(service.baseUrl, "/api/sessions", "{", { method: "POST" })).resolves.toMatchObject({
        status: 400,
        body: {
          error: {
            code: "malformed_request",
            field: "body"
          }
        }
      });
    } finally {
      await service.close();
    }
  });
});

async function fetchStatus(baseUrl: URL): Promise<unknown> {
  const response = await fetch(new URL("/api/host/status", baseUrl));

  if (!response.ok) {
    throw new Error(`Unexpected service status HTTP ${response.status}.`);
  }

  return response.json();
}

async function fetchJson(
  baseUrl: URL,
  path: string,
  init: {
    readonly method?: "GET" | "POST";
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: unknown;
  } = {}
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(new URL(path, baseUrl), {
    method: init.method ?? "GET",
    headers: {
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {})
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {})
  });

  return {
    status: response.status,
    body: await response.json()
  };
}

async function fetchRaw(
  baseUrl: URL,
  path: string,
  init: {
    readonly method: "POST";
    readonly headers?: Readonly<Record<string, string>>;
    readonly body: unknown;
  }
): Promise<{ readonly status: number; readonly headers: Headers; readonly body: unknown }> {
  const response = await fetch(new URL(path, baseUrl), {
    method: init.method,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {})
    },
    body: JSON.stringify(init.body)
  });

  return {
    status: response.status,
    headers: response.headers,
    body: await response.json()
  };
}

async function fetchRawText(
  baseUrl: URL,
  path: string,
  body: string,
  init: {
    readonly method: "POST";
  }
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(new URL(path, baseUrl), {
    method: init.method,
    headers: {
      "content-type": "application/json"
    },
    body
  });

  return {
    status: response.status,
    body: await response.json()
  };
}

function emptyDiscovery(): RealTmuxTargetDiscovery {
  return {
    tmuxSessionNameForSession,
    parseSessionIdFromTmuxSessionName,
    async listTargets() {
      return [];
    },
    async getTargetBySessionId() {
      return null;
    },
    async reconcileTargets() {
      return {
        liveTargets: [],
        staleTargets: [],
        unmanagedTargets: []
      };
    }
  };
}

function noopOutputReader(): void {
  return;
}

async function getAvailablePort(host: string): Promise<number> {
  const server = await listenOn(host, 0);
  const address = server.address();
  await closeServer(server);

  if (address === null || typeof address === "string") {
    throw new Error("Unable to allocate an ephemeral TCP port.");
  }

  return address.port;
}

function listenOn(host: string, port: number): Promise<Server> {
  return new Promise((resolveListen, rejectListen) => {
    const server = createServer();
    let settled = false;

    function settle(error?: unknown): void {
      if (settled) {
        return;
      }

      settled = true;

      if (error !== undefined) {
        rejectListen(error);
        return;
      }

      resolveListen(server);
    }

    server.once("error", settle);
    server.listen(
      {
        host,
        port,
        exclusive: true
      },
      () => settle()
    );
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error !== undefined) {
        rejectClose(error);
        return;
      }

      resolveClose();
    });
  });
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function localPaths(): { readonly configDir: string; readonly runtimeDir: string } {
  const runtimeParent = tempDir("hostdeck-service-runtime-parent-");
  return {
    configDir: tempDir("hostdeck-service-config-"),
    runtimeDir: join(runtimeParent, "hostdeck")
  };
}

function fixedNow(): Date {
  return new Date("2026-07-09T08:00:00.000Z");
}

function laterNow(): Date {
  return new Date("2026-07-09T08:05:00.000Z");
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
