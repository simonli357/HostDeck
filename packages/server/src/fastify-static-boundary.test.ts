import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultResourceBudget } from "@hostdeck/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createHostDeckFastifyApp, hostDeckFastifyResourceSnapshot } from "./fastify-app.js";
import type { HostDeckInternalErrorObservation } from "./fastify-error-policy.js";
import { createHostDeckRequestTrustPolicy } from "./fastify-request-trust.js";
import {
  type CreateHostDeckStaticBoundaryRegistrationInput,
  createHostDeckStaticBoundaryRegistration,
  hostDeckStaticBoundaryLimits
} from "./fastify-static-boundary.js";
import { testRequestAuthenticationPolicy } from "./test-request-authentication.js";

const loopbackTrustPolicy = createHostDeckRequestTrustPolicy({
  allowedOrigins: ["http://localhost"],
  mode: "loopback",
  transport: "http"
});

const indexBody = "<!doctype html><html><body>HOSTDECK_STATIC_INDEX_SENTINEL</body></html>";
const javascriptBody = "globalThis.__hostdeckStaticFixture = true;\n";
const temporaryDirectories = new Set<string>();

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { force: true, recursive: true });
  }
  temporaryDirectories.clear();
});

describe("explicit Fastify static-dashboard boundary", () => {
  it("rejects ambiguous registration input and copies an exact browser route allowlist", async () => {
    const buildRoot = createBuildFixture();
    const browserRoutes: `/${string}`[] = ["/", "/sessions/:session_id", "/settings"];
    const registration = createHostDeckStaticBoundaryRegistration({
      browserRoutes,
      buildRoot,
      id: "dashboard-static"
    });
    expect(Object.isFrozen(registration)).toBe(true);
    expect(registration).toMatchObject({ id: "dashboard-static", surface: "static" });

    browserRoutes.push("/late-mutation");
    const app = createStaticApp(registration);
    await app.ready();
    try {
      expect((await app.inject("/settings")).statusCode).toBe(200);
      expectJsonError(await app.inject("/late-mutation"), 404, "route_not_found");
    } finally {
      await app.close();
    }

    const base: CreateHostDeckStaticBoundaryRegistrationInput = {
      browserRoutes: ["/"],
      buildRoot,
      id: "dashboard-static"
    };
    const invalidInputs: readonly [unknown, string][] = [
      [null, "must be an object"],
      [{ ...base, unexpected: true }, "fields are invalid"],
      [Object.assign(Object.create({ inherited: true }), base), "must be a plain object"],
      [{ ...base, id: "Dashboard" }, "registration id is invalid"],
      [{ ...base, buildRoot: "relative/build" }, "canonical absolute path"],
      [{ ...base, buildRoot: `${buildRoot}/` }, "canonical absolute path"],
      [{ ...base, buildRoot: `${buildRoot}/assets/..` }, "canonical absolute path"],
      [{ ...base, browserRoutes: [] }, "must contain 1 to"],
      [{ ...base, browserRoutes: ["/settings"] }, 'must include "/"'],
      [{ ...base, browserRoutes: ["/", "/settings", "/settings"] }, "is duplicated"],
      [
        { ...base, browserRoutes: ["/", "/sessions/:id", "/sessions/:session_id"] },
        "route shape"
      ],
      [{ ...base, browserRoutes: ["/", "/api"] }, "browser route is invalid"],
      [{ ...base, browserRoutes: ["/", "/api/status"] }, "browser route is invalid"],
      [{ ...base, browserRoutes: ["/", "/assets/app.js"] }, "browser route is invalid"],
      [{ ...base, browserRoutes: ["/", "/.hidden"] }, "browser route is invalid"],
      [{ ...base, browserRoutes: ["/", "/sessions/foo:bar"] }, "browser route is invalid"],
      [{ ...base, browserRoutes: ["/", "/sessions/:Bad"] }, "browser route is invalid"],
      [{ ...base, browserRoutes: ["/", "/sessions/:id/:id"] }, "browser route is invalid"],
      [{ ...base, browserRoutes: ["/", "/settings/"] }, "browser route is invalid"],
      [{ ...base, browserRoutes: ["/", "/wildcard/*"] }, "browser route is invalid"],
      [
        {
          ...base,
          browserRoutes: [
            "/",
            `/${Array.from(
              { length: hostDeckStaticBoundaryLimits.maxBrowserRouteSegments + 1 },
              () => "segment"
            ).join("/")}`
          ]
        },
        "browser route is invalid"
      ],
      [
        { ...base, browserRoutes: ["/", `/${"a".repeat(hostDeckStaticBoundaryLimits.maxBrowserRouteBytes)}`] },
        "browser route is invalid"
      ],
      [
        {
          ...base,
          browserRoutes: Array.from(
            { length: hostDeckStaticBoundaryLimits.maxBrowserRoutes + 1 },
            (_, index) => `/route-${index}` as const
          )
        },
        "must contain 1 to"
      ]
    ];
    for (const [input, message] of invalidInputs) {
      expect(() =>
        createHostDeckStaticBoundaryRegistration(
          input as CreateHostDeckStaticBoundaryRegistrationInput
        )
      ).toThrow(message);
    }
  });

  it("serves only explicit browser routes and validated assets with deterministic response policy", async () => {
    const buildRoot = createBuildFixture();
    const observations: HostDeckInternalErrorObservation[] = [];
    const app = createStaticApp(
      createHostDeckStaticBoundaryRegistration({
        browserRoutes: ["/", "/sessions/:session_id", "/settings"],
        buildRoot,
        id: "dashboard-static"
      }),
      observations
    );
    await app.ready();

    try {
      for (const url of ["/", "/sessions/sess_mobile_01", "/settings?tab=general"]) {
        const response = await app.inject({ method: "GET", url });
        expect(response.statusCode).toBe(200);
        expect(response.body).toBe(indexBody);
        expect(response.headers["content-type"]).toContain("text/html");
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.headers["x-content-type-options"]).toBe("nosniff");
      }

      const browserHead = await app.inject({ method: "HEAD", url: "/settings" });
      expect(browserHead.statusCode).toBe(200);
      expect(browserHead.body).toBe("");
      expect(browserHead.headers["content-length"]).toBe(String(Buffer.byteLength(indexBody)));
      expect(browserHead.headers["cache-control"]).toBe("no-store");

      const javascript = await app.inject("/assets/app-ABC123xy.js?v=1");
      expect(javascript.statusCode).toBe(200);
      expect(javascript.body).toBe(javascriptBody);
      expect(javascript.headers["content-type"]).toContain("javascript");
      expect(javascript.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      expect(javascript.headers["x-content-type-options"]).toBe("nosniff");

      const stylesheet = await app.inject("/assets/styles-12345678.css");
      expect(stylesheet.statusCode).toBe(200);
      expect(stylesheet.headers["content-type"]).toContain("text/css");
      expect(stylesheet.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

      const unhashed = await app.inject("/assets/plain.txt");
      expect(unhashed.statusCode).toBe(200);
      expect(unhashed.body).toBe("plain-static-fixture\n");
      expect(unhashed.headers["content-type"]).toContain("text/plain");
      expect(unhashed.headers["cache-control"]).toBe("no-store");

      const nested = await app.inject("/assets/nested/manifest.json");
      expect(nested.statusCode).toBe(200);
      expect(nested.json()).toEqual({ fixture: true });
      expect(nested.headers["cache-control"]).toBe("no-store");

      const hashedHtml = await app.inject("/assets/fragment-12345678.html");
      expect(hashedHtml.statusCode).toBe(200);
      expect(hashedHtml.headers["content-type"]).toContain("text/html");
      expect(hashedHtml.headers["cache-control"]).toBe("no-store");

      const assetHead = await app.inject({ method: "HEAD", url: "/assets/app-ABC123xy.js" });
      expect(assetHead.statusCode).toBe(200);
      expect(assetHead.body).toBe("");
      expect(assetHead.headers["content-length"]).toBe(String(Buffer.byteLength(javascriptBody)));
      expect(assetHead.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

      expectJsonError(await app.inject("/api/missing"), 404, "route_not_found");
      expectJsonError(await app.inject("/dashboard"), 404, "route_not_found");
      expectJsonError(await app.inject("/settings/"), 404, "route_not_found");
      expectJsonError(await app.inject("/assets/index.html"), 404, "route_not_found");
      expectJsonError(await app.inject("/assets/missing.js"), 404, "route_not_found");
      const wrongMethod = await app.inject({ method: "POST", url: "/settings" });
      expectJsonError(wrongMethod, 405, "method_not_allowed");
      expect(wrongMethod.headers.allow).toBe("GET, HEAD");
      expect(observations).toEqual([]);
      expect(hostDeckFastifyResourceSnapshot(app)).toEqual({
        aborted_requests: 0,
        in_flight_requests: 0,
        max_in_flight_requests: defaultResourceBudget.http_max_in_flight_requests,
        rejected_header_count_requests: 0,
        rejected_overload_requests: 0,
        timed_out_requests: 0
      });
    } finally {
      await app.close();
    }
  });

  it("denies raw, encoded, and double-encoded dot or traversal targets before file lookup", async () => {
    const buildRoot = createBuildFixture();
    const app = createStaticApp(
      createHostDeckStaticBoundaryRegistration({
        browserRoutes: ["/"],
        buildRoot,
        id: "dashboard-static"
      })
    );
    await app.ready();
    writeFileSync(join(buildRoot, "assets", ".secret"), "STATIC_SECRET_SENTINEL", { mode: 0o600 });
    writeFileSync(join(buildRoot, "assets", "late-added.txt"), "LATE_STATIC_SENTINEL", { mode: 0o600 });
    writeFileSync(join(buildRoot, "outside.txt"), "OUTSIDE_STATIC_SENTINEL", { mode: 0o600 });
    rmSync(join(buildRoot, "assets", "plain.txt"));
    symlinkSync("../index.html", join(buildRoot, "assets", "plain.txt"));
    rmSync(join(buildRoot, "index.html"));
    symlinkSync("outside.txt", join(buildRoot, "index.html"));

    try {
      expectJsonError(await app.inject("/"), 404, "route_not_found");
      const deniedTargets = [
        "/assets",
        "/assets/",
        "/assets//plain.txt",
        "/assets/.secret",
        "/assets/late-added.txt",
        "/assets/plain.txt",
        "/assets/%2esecret",
        "/assets/%252esecret",
        "/assets/%252e%252e%252findex.html",
        "/assets/nested%2f..%2fplain.txt",
        "/assets/..%5cindex.html",
        "/assets/%252e%252e%255cindex.html",
        "/assets/plain%00.txt",
        "/assets/%25/anything"
      ];
      for (const url of deniedTargets) {
        const response = await app.inject({ method: "GET", url });
        expect([400, 403, 404], `${url} returned ${response.statusCode}`).toContain(response.statusCode);
        expect(response.headers["content-type"], url).toContain("application/json");
        expect(response.body, url).not.toContain(indexBody);
        if (response.statusCode === 403) expect(response.json()).toMatchObject({ error: { code: "invalid_origin" } });
        expect(response.body, url).not.toContain("STATIC_SECRET_SENTINEL");
        expect(response.body, url).not.toContain("LATE_STATIC_SENTINEL");
        expect(response.body, url).not.toContain("OUTSIDE_STATIC_SENTINEL");
      }

      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as AddressInfo;
      for (const path of [
        "/assets/../index.html",
        "/assets/%2e%2e/index.html",
        "/assets/nested/../plain.txt",
        "/assets/nested/%2e%2e/plain.txt"
      ]) {
        const response = await rawHttpGet(address.port, path);
        expect([400, 404], `${path} returned ${response.statusCode}`).toContain(response.statusCode);
        expect(response.headers["content-type"], path).toContain("application/json");
        expect(response.body, path).not.toContain(indexBody);
        expect(response.body, path).not.toContain("OUTSIDE_STATIC_SENTINEL");
      }
      expect(hostDeckFastifyResourceSnapshot(app).in_flight_requests).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("fails startup for absent, non-canonical, linked, hidden, deep, or oversized build content", async () => {
    const missingParent = createTemporaryDirectory("hostdeck-static-missing-");
    await expectStaticBuildRejected(join(missingParent, "absent"), "ENOENT");

    const missingIndex = createTemporaryDirectory("hostdeck-static-no-index-");
    mkdirSync(join(missingIndex, "assets"));
    writeFileSync(join(missingIndex, "assets", "app.js"), "asset", { mode: 0o600 });
    await expectStaticBuildRejected(missingIndex, "ENOENT");

    const emptyIndex = createBuildFixture();
    truncateSync(join(emptyIndex, "index.html"), 0);
    await expectStaticBuildRejected(emptyIndex, "nonempty bounded regular file");

    const oversizedIndex = createBuildFixture();
    truncateSync(join(oversizedIndex, "index.html"), hostDeckStaticBoundaryLimits.indexMaxBytes + 1);
    await expectStaticBuildRejected(oversizedIndex, "nonempty bounded regular file");

    const missingAssets = createTemporaryDirectory("hostdeck-static-no-assets-");
    writeFileSync(join(missingAssets, "index.html"), indexBody, { mode: 0o600 });
    await expectStaticBuildRejected(missingAssets, "ENOENT");

    const emptyAssets = createBuildFixture();
    rmSync(join(emptyAssets, "assets"), { recursive: true });
    mkdirSync(join(emptyAssets, "assets"));
    await expectStaticBuildRejected(emptyAssets, "at least one asset file");

    const actualRoot = createBuildFixture();
    const rootLinkParent = createTemporaryDirectory("hostdeck-static-root-link-");
    const rootLink = join(rootLinkParent, "build");
    symlinkSync(actualRoot, rootLink, "dir");
    await expectStaticBuildRejected(rootLink, "must be a real directory");

    const linkedIndex = createBuildFixture();
    rmSync(join(linkedIndex, "index.html"));
    writeFileSync(join(linkedIndex, "linked-index-source.html"), indexBody, { mode: 0o600 });
    symlinkSync("linked-index-source.html", join(linkedIndex, "index.html"));
    await expectStaticBuildRejected(linkedIndex, "nonempty bounded regular file");

    const linkedAssetsRoot = createTemporaryDirectory("hostdeck-static-assets-link-");
    writeFileSync(join(linkedAssetsRoot, "index.html"), indexBody, { mode: 0o600 });
    const externalAssets = createTemporaryDirectory("hostdeck-static-assets-target-");
    writeFileSync(join(externalAssets, "app.js"), "asset", { mode: 0o600 });
    symlinkSync(externalAssets, join(linkedAssetsRoot, "assets"), "dir");
    await expectStaticBuildRejected(linkedAssetsRoot, "must be a real directory");

    const linkedAsset = createBuildFixture();
    symlinkSync("plain.txt", join(linkedAsset, "assets", "linked.txt"));
    await expectStaticBuildRejected(linkedAsset, "cannot contain symbolic links");

    const hardLinkedAsset = createBuildFixture();
    writeFileSync(join(hardLinkedAsset, "hard-link-source.txt"), "linked", { mode: 0o600 });
    linkSync(join(hardLinkedAsset, "hard-link-source.txt"), join(hardLinkedAsset, "assets", "linked.txt"));
    await expectStaticBuildRejected(hardLinkedAsset, "regular non-linked file");

    const hiddenAsset = createBuildFixture();
    writeFileSync(join(hiddenAsset, "assets", ".env"), "secret", { mode: 0o600 });
    await expectStaticBuildRejected(hiddenAsset, "forbidden path segment");

    const deepAssets = createBuildFixture();
    let deepDirectory = join(deepAssets, "assets");
    for (let depth = 0; depth <= hostDeckStaticBoundaryLimits.maxAssetDepth; depth += 1) {
      deepDirectory = join(deepDirectory, `level-${depth}`);
      mkdirSync(deepDirectory);
    }
    writeFileSync(join(deepDirectory, "deep.txt"), "deep", { mode: 0o600 });
    await expectStaticBuildRejected(deepAssets, "directory depth exceeds");

    const oversizedAsset = createBuildFixture();
    truncateSync(
      join(oversizedAsset, "assets", "app-ABC123xy.js"),
      hostDeckStaticBoundaryLimits.maxAssetFileBytes + 1
    );
    await expectStaticBuildRejected(oversizedAsset, "per-file byte limit");

    const oversizedTree = createBuildFixture();
    for (let index = 0; index < 8; index += 1) {
      const path = join(oversizedTree, "assets", `large-${index}.bin`);
      writeFileSync(path, "", { mode: 0o600 });
      truncateSync(path, hostDeckStaticBoundaryLimits.maxAssetFileBytes);
    }
    await expectStaticBuildRejected(oversizedTree, "total bytes exceed");
  });
});

function createStaticApp(
  registration: ReturnType<typeof createHostDeckStaticBoundaryRegistration>,
  observations: HostDeckInternalErrorObservation[] = []
) {
  return createHostDeckFastifyApp({
    observeInternalError: (observation) => observations.push(observation),
    requestAuthenticationPolicy: testRequestAuthenticationPolicy,
    requestTrustPolicy: loopbackTrustPolicy,
    resourceBudget: defaultResourceBudget,
    routePlugins: [registration]
  });
}

function createBuildFixture(): string {
  const buildRoot = createTemporaryDirectory("hostdeck-static-build-");
  mkdirSync(join(buildRoot, "assets", "nested"), { recursive: true });
  writeFileSync(join(buildRoot, "index.html"), indexBody, { mode: 0o600 });
  writeFileSync(join(buildRoot, "assets", "app-ABC123xy.js"), javascriptBody, { mode: 0o600 });
  writeFileSync(join(buildRoot, "assets", "styles-12345678.css"), "body { color: black; }\n", {
    mode: 0o600
  });
  writeFileSync(join(buildRoot, "assets", "plain.txt"), "plain-static-fixture\n", { mode: 0o600 });
  writeFileSync(join(buildRoot, "assets", "fragment-12345678.html"), "<p>fragment fixture</p>\n", {
    mode: 0o600
  });
  writeFileSync(join(buildRoot, "assets", "nested", "manifest.json"), '{"fixture":true}\n', {
    mode: 0o600
  });
  return buildRoot;
}

function createTemporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.add(directory);
  return directory;
}

async function expectStaticBuildRejected(buildRoot: string, causeFragment: string): Promise<void> {
  const app = createStaticApp(
    createHostDeckStaticBoundaryRegistration({
      browserRoutes: ["/"],
      buildRoot,
      id: "rejected-static"
    })
  );
  let failure: unknown;
  try {
    await app.ready();
  } catch (error) {
    failure = error;
  }
  try {
    expect(failure).toBeDefined();
    expect(errorCauseMessages(failure)).toContain('HostDeck route plugin "rejected-static" failed registration.');
    expect(errorCauseMessages(failure)).toContain(causeFragment);
  } finally {
    await app.close();
  }
}

function errorCauseMessages(failure: unknown): string {
  const messages: string[] = [];
  const visited = new Set<unknown>();
  let current = failure;
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    messages.push(current.message);
    current = (current as Error & { readonly cause?: unknown }).cause;
  }
  return messages.join(" <- ");
}

function expectJsonError(
  response: Awaited<ReturnType<ReturnType<typeof createStaticApp>["inject"]>>,
  status: number,
  code: string
): void {
  expect(response.statusCode).toBe(status);
  expect(response.headers["content-type"]).toContain("application/json");
  expect(response.headers["x-request-id"]).toMatch(/^req_[0-9a-f-]{36}$/u);
  expect(response.body).not.toContain(indexBody);
  expect(response.json()).toMatchObject({
    error: {
      code,
      retryable: false,
      details: { request_id: response.headers["x-request-id"] }
    }
  });
}

interface RawHttpResponse {
  readonly body: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly statusCode: number;
}

async function rawHttpGet(port: number, path: string): Promise<RawHttpResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { headers: { host: "localhost" }, host: "127.0.0.1", method: "GET", path, port },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            headers: Object.fromEntries(
              Object.entries(response.headers).map(([name, value]) => [
                name,
                Array.isArray(value) ? value.join(", ") : value
              ])
            ),
            statusCode: response.statusCode ?? 0
          });
        });
      }
    );
    request.once("error", reject);
    request.end();
  });
}
