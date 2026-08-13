import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { defaultResourceBudget } from "@hostdeck/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createHostDeckFastifyApp, hostDeckFastifyResourceSnapshot } from "./fastify-app.js";
import type { HostDeckInternalErrorObservation } from "./fastify-error-policy.js";
import {
  hostDeckLoopbackTestAuthority,
  hostDeckLoopbackTestOrigin,
  injectHostDeckLoopback
} from "./fastify-loopback-test-request.js";
import { createHostDeckRequestTrustPolicy } from "./fastify-request-trust.js";
import {
  type CreateHostDeckStaticBoundaryRegistrationInput,
  createHostDeckStaticBoundaryRegistration,
  hostDeckStaticBoundaryLimits,
  hostDeckStaticContentSecurityPolicy
} from "./fastify-static-boundary.js";
import { testRequestAuthenticationPolicy } from "./test-request-authentication.js";

const loopbackTrustPolicy = createHostDeckRequestTrustPolicy({
  allowedOrigin: hostDeckLoopbackTestOrigin
});

const indexBody = '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content"><meta name="theme-color" content="#121313"><meta name="hostdeck-package-version" content="0.0.0"><title>HostDeck</title><script type="module" src="/assets/app-ABC123xy.js"></script><link rel="stylesheet" href="/assets/styles-12345678.css"></head><body><div id="root"></div>HOSTDECK_STATIC_INDEX_SENTINEL</body></html>';
const javascriptBody = `globalThis.__hostdeckStaticFixture = true;\n${"void 0;\n".repeat(256)}`;
const temporaryDirectories = new Set<string>();

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { force: true, recursive: true });
  }
  temporaryDirectories.clear();
});

describe("explicit Fastify static-dashboard boundary", () => {
  it("rejects ambiguous registration input and copies an exact browser route allowlist", async () => {
    const buildRoot = createBuildFixture(["/", "/sessions/:session_id", "/settings"]);
    const browserRoutes: `/${string}`[] = ["/", "/sessions/:session_id", "/settings"];
    const registration = createHostDeckStaticBoundaryRegistration({
      browserRoutes,
      buildRoot,
      id: "dashboard-static",
      packageVersion: "0.0.0"
    });
    expect(Object.isFrozen(registration)).toBe(true);
    expect(registration).toMatchObject({ id: "dashboard-static", surface: "static" });

    browserRoutes.push("/late-mutation");
    const app = createStaticApp(registration);
    await app.ready();
    try {
      expect((await injectHostDeckLoopback(app, "/settings")).statusCode).toBe(200);
      expectJsonError(await injectHostDeckLoopback(app, "/late-mutation"), 404, "route_not_found");
    } finally {
      await app.close();
    }

    const base: CreateHostDeckStaticBoundaryRegistrationInput = {
      browserRoutes: ["/"],
      buildRoot,
      id: "dashboard-static",
      packageVersion: "0.0.0"
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
    const buildRoot = createBuildFixture(["/", "/sessions/:session_id", "/settings"]);
    const observations: HostDeckInternalErrorObservation[] = [];
    const app = createStaticApp(
      createHostDeckStaticBoundaryRegistration({
        browserRoutes: ["/", "/sessions/:session_id", "/settings"],
        buildRoot,
        id: "dashboard-static",
        packageVersion: "0.0.0"
      }),
      observations
    );
    await app.ready();

    try {
      for (const url of ["/", "/sessions/sess_mobile_01", "/settings?tab=general"]) {
        const response = await injectHostDeckLoopback(app, { method: "GET", url });
        expect(response.statusCode).toBe(200);
        expect(response.body).toBe(indexBody);
        expect(response.headers["content-type"]).toContain("text/html");
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.headers["content-security-policy"]).toBe(
          hostDeckStaticContentSecurityPolicy
        );
        expect(response.headers["x-content-type-options"]).toBe("nosniff");
      }

      const browserHead = await injectHostDeckLoopback(app, { method: "HEAD", url: "/settings" });
      expect(browserHead.statusCode).toBe(200);
      expect(browserHead.body).toBe("");
      expect(browserHead.headers["content-length"]).toBe(String(Buffer.byteLength(indexBody)));
      expect(browserHead.headers["cache-control"]).toBe("no-store");

      const javascript = await injectHostDeckLoopback(app, "/assets/app-ABC123xy.js?v=1");
      expect(javascript.statusCode).toBe(200);
      expect(javascript.body).toBe(javascriptBody);
      expect(javascript.headers["content-type"]).toContain("javascript");
      expect(javascript.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      expect(javascript.headers["x-content-type-options"]).toBe("nosniff");
      expect(javascript.headers.vary).toBe("Accept-Encoding");
      expect(javascript.headers["content-encoding"]).toBeUndefined();

      const brotliJavascript = await injectHostDeckLoopback(app, {
        method: "GET",
        url: "/assets/app-ABC123xy.js",
        headers: { "accept-encoding": "gzip, br" }
      });
      expect(brotliJavascript.statusCode).toBe(200);
      expect(brotliJavascript.headers["content-encoding"]).toBe("br");
      expect(brotliJavascript.headers["content-length"]).toBeUndefined();
      expect(brotliJavascript.headers.vary).toBe("Accept-Encoding");
      expect(brotliDecompressSync(brotliJavascript.rawPayload).toString()).toBe(javascriptBody);

      const gzipJavascript = await injectHostDeckLoopback(app, {
        method: "GET",
        url: "/assets/app-ABC123xy.js",
        headers: { "accept-encoding": "br;q=0, gzip" }
      });
      expect(gzipJavascript.statusCode).toBe(200);
      expect(gzipJavascript.headers["content-encoding"]).toBe("gzip");
      expect(gunzipSync(gzipJavascript.rawPayload).toString()).toBe(javascriptBody);

      const stylesheet = await injectHostDeckLoopback(app, "/assets/styles-12345678.css");
      expect(stylesheet.statusCode).toBe(200);
      expect(stylesheet.headers["content-type"]).toContain("text/css");
      expect(stylesheet.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

      const text = await injectHostDeckLoopback(app, "/assets/plain-12345678.txt");
      expect(text.statusCode).toBe(200);
      expect(text.body).toBe("plain-static-fixture\n");
      expect(text.headers["content-type"]).toContain("text/plain");
      expect(text.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

      const nested = await injectHostDeckLoopback(app, "/assets/nested/manifest-12345678.json");
      expect(nested.statusCode).toBe(200);
      expect(nested.json()).toEqual({ fixture: true });
      expect(nested.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

      const assetHead = await injectHostDeckLoopback(app, { method: "HEAD", url: "/assets/app-ABC123xy.js" });
      expect(assetHead.statusCode).toBe(200);
      expect(assetHead.body).toBe("");
      expect(assetHead.headers["content-length"]).toBe(String(Buffer.byteLength(javascriptBody)));
      expect(assetHead.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      expect(assetHead.headers.vary).toBe("Accept-Encoding");
      expect(assetHead.headers["content-encoding"]).toBeUndefined();

      expectJsonError(await injectHostDeckLoopback(app, "/api/missing"), 404, "route_not_found");
      expectJsonError(await injectHostDeckLoopback(app, "/dashboard"), 404, "route_not_found");
      expectJsonError(await injectHostDeckLoopback(app, "/settings/"), 404, "route_not_found");
      expectJsonError(await injectHostDeckLoopback(app, "/assets/index.html"), 404, "route_not_found");
      expectJsonError(await injectHostDeckLoopback(app, "/assets/missing.js"), 404, "route_not_found");
      const wrongMethod = await injectHostDeckLoopback(app, { method: "POST", url: "/settings" });
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
        id: "dashboard-static",
        packageVersion: "0.0.0"
      })
    );
    await app.ready();
    writeFileSync(join(buildRoot, "assets", ".secret"), "STATIC_SECRET_SENTINEL", { mode: 0o600 });
    writeFileSync(join(buildRoot, "assets", "late-added.txt"), "LATE_STATIC_SENTINEL", { mode: 0o600 });
    writeFileSync(join(buildRoot, "outside.txt"), "OUTSIDE_STATIC_SENTINEL", { mode: 0o600 });
    rmSync(join(buildRoot, "assets", "plain-12345678.txt"));
    symlinkSync("../index.html", join(buildRoot, "assets", "plain-12345678.txt"));
    rmSync(join(buildRoot, "index.html"));
    symlinkSync("outside.txt", join(buildRoot, "index.html"));
    writeFileSync(
      join(buildRoot, "assets", "app-ABC123xy.js"),
      "globalThis.__hostDeckMutated = true;\n",
      { mode: 0o600 }
    );
    rmSync(join(buildRoot, "assets", "styles-12345678.css"));

    try {
      expectJsonError(await injectHostDeckLoopback(app, "/"), 404, "route_not_found");
      const deniedTargets = [
        "/assets",
        "/assets/",
        "/assets//plain-12345678.txt",
        "/assets/.secret",
        "/assets/late-added.txt",
        "/assets/app-ABC123xy.js",
        "/assets/plain-12345678.txt",
        "/assets/styles-12345678.css",
        "/assets/%2esecret",
        "/assets/%252esecret",
        "/assets/%252e%252e%252findex.html",
        "/assets/nested%2f..%2fplain-12345678.txt",
        "/assets/..%5cindex.html",
        "/assets/%252e%252e%255cindex.html",
        "/assets/plain%00-12345678.txt",
        "/assets/%25/anything"
      ];
      for (const url of deniedTargets) {
        const response = await injectHostDeckLoopback(app, { method: "GET", url });
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
        "/assets/nested/../plain-12345678.txt",
        "/assets/nested/%2e%2e/plain-12345678.txt"
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
    await expectStaticBuildRejected(missingIndex, "root inventory");

    const emptyIndex = createBuildFixture();
    truncateSync(join(emptyIndex, "index.html"), 0);
    await expectStaticBuildRejected(emptyIndex, "nonempty bounded regular file");

    const oversizedIndex = createBuildFixture();
    truncateSync(join(oversizedIndex, "index.html"), hostDeckStaticBoundaryLimits.indexMaxBytes + 1);
    await expectStaticBuildRejected(oversizedIndex, "nonempty bounded regular file");

    const missingAssets = createTemporaryDirectory("hostdeck-static-no-assets-");
    writeFileSync(join(missingAssets, "index.html"), indexBody, { mode: 0o600 });
    await expectStaticBuildRejected(missingAssets, "root inventory");

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
    const linkedIndexSource = createTemporaryDirectory("hostdeck-static-index-target-");
    writeFileSync(join(linkedIndexSource, "index.html"), indexBody, { mode: 0o600 });
    symlinkSync(join(linkedIndexSource, "index.html"), join(linkedIndex, "index.html"));
    await expectStaticBuildRejected(linkedIndex, "nonempty bounded regular file");

    const linkedAssetsRoot = createBuildFixture();
    rmSync(join(linkedAssetsRoot, "assets"), { recursive: true });
    const externalAssets = createTemporaryDirectory("hostdeck-static-assets-target-");
    writeFileSync(join(externalAssets, "app.js"), "asset", { mode: 0o600 });
    symlinkSync(externalAssets, join(linkedAssetsRoot, "assets"), "dir");
    await expectStaticBuildRejected(linkedAssetsRoot, "must be a real directory");

    const linkedAsset = createBuildFixture();
    symlinkSync("plain-12345678.txt", join(linkedAsset, "assets", "linked-12345678.txt"));
    await expectStaticBuildRejected(linkedAsset, "cannot contain symbolic links");

    const hardLinkedAsset = createBuildFixture();
    const hardLinkSource = createTemporaryDirectory("hostdeck-static-hard-link-");
    writeFileSync(join(hardLinkSource, "source.txt"), "linked", { mode: 0o600 });
    linkSync(join(hardLinkSource, "source.txt"), join(hardLinkedAsset, "assets", "linked-12345678.txt"));
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
    writeFileSync(join(deepDirectory, "deep-12345678.txt"), "deep", { mode: 0o600 });
    await expectStaticBuildRejected(deepAssets, "undeclared directory");

    const oversizedAsset = createBuildFixture();
    truncateSync(
      join(oversizedAsset, "assets", "app-ABC123xy.js"),
      hostDeckStaticBoundaryLimits.maxAssetFileBytes + 1
    );
    await expectStaticBuildRejected(oversizedAsset, "per-file byte limit");

    const oversizedTree = createBuildFixture();
    for (let index = 0; index < 8; index += 1) {
      const path = join(oversizedTree, "assets", `large-${index}-12345678.txt`);
      writeFileSync(path, "", { mode: 0o600 });
      truncateSync(path, hostDeckStaticBoundaryLimits.maxAssetFileBytes);
    }
    await expectStaticBuildRejected(oversizedTree, "undeclared file");
  });

  it("fails startup for manifest, descriptor, route, and resigned index drift", async () => {
    const invalidJson = createBuildFixture();
    writeFileSync(join(invalidJson, "hostdeck-web.json"), "{", { mode: 0o600 });
    await expectStaticBuildRejected(invalidJson, "invalid JSON");

    const extraField = createBuildFixture();
    mutateBuildManifest(extraField, (manifest) => {
      (manifest as MutableWebManifest & { unexpected?: boolean }).unexpected = true;
    });
    await expectStaticBuildRejected(extraField, "fields are invalid");

    const schemaDrift = createBuildFixture();
    mutateBuildManifest(schemaDrift, (manifest) => {
      manifest.schemaVersion += 1;
    });
    await expectStaticBuildRejected(schemaDrift, "version identity is inconsistent");

    const packageDrift = createBuildFixture();
    mutateBuildManifest(packageDrift, (manifest) => {
      manifest.packageVersion = "9.9.9";
    });
    await expectStaticBuildRejected(packageDrift, "version identity is inconsistent");

    const routeDrift = createBuildFixture();
    mutateBuildManifest(routeDrift, (manifest) => {
      manifest.browserRoutes = ["/settings"];
    });
    await expectStaticBuildRejected(routeDrift, "browser routes are inconsistent");

    const orderDrift = createBuildFixture();
    mutateBuildManifest(orderDrift, (manifest) => {
      manifest.assets.reverse();
    });
    await expectStaticBuildRejected(orderDrift, "descriptors must be sorted");

    const countDrift = createBuildFixture();
    mutateBuildManifest(countDrift, (manifest) => {
      manifest.content.count += 1;
    });
    await expectStaticBuildRejected(countDrift, "content identity is inconsistent");

    const descriptorDrift = createBuildFixture();
    mutateBuildManifest(descriptorDrift, (manifest) => {
      manifest.index.sha256 = "0".repeat(64);
    });
    await expectStaticBuildRejected(descriptorDrift, "index.html identity");

    const referenceDrift = createBuildFixture();
    mutateBuildManifest(referenceDrift, (manifest) => {
      manifest.entryAssets = manifest.entryAssets.filter((path) => path.endsWith(".js"));
    });
    await expectStaticBuildRejected(referenceDrift, "entry references are inconsistent");

    const markerDrift = createBuildFixture();
    resignBuildIndex(markerDrift, (index) =>
      index.replace('content="0.0.0"', 'content="9.9.9"')
    );
    await expectStaticBuildRejected(markerDrift, "invalid version");

    const externalReference = createBuildFixture();
    resignBuildIndex(externalReference, (index) =>
      index.replace(
        "/assets/app-ABC123xy.js",
        "https://example.invalid/app-ABC123xy.js"
      )
    );
    await expectStaticBuildRejected(externalReference, "external reference");

    const inlineScript = createBuildFixture();
    resignBuildIndex(inlineScript, (index) => `${index}<script>void 0</script>`);
    await expectStaticBuildRejected(inlineScript, "inline executable script");

    const duplicateMarker = createBuildFixture();
    resignBuildIndex(duplicateMarker, (index) =>
      index.replace(
        "</head>",
        '<meta name="hostdeck-package-version" content="0.0.0"></head>'
      )
    );
    await expectStaticBuildRejected(duplicateMarker, "invalid version");

    const documentDrift = createBuildFixture();
    resignBuildIndex(documentDrift, (index) =>
      index.replace("<title>HostDeck</title>", "")
    );
    await expectStaticBuildRejected(documentDrift, "document structure");

    const foreignReference = createBuildFixture();
    resignBuildIndex(foreignReference, (index) =>
      index.replace("</body>", '<img src="/foreign.png"></body>')
    );
    await expectStaticBuildRejected(foreignReference, "entry references");

    const invalidUtf8 = createBuildFixture();
    resignBuildIndexBytes(invalidUtf8, (index) =>
      Buffer.concat([index, Buffer.from([0xff])])
    );
    await expectStaticBuildRejected(invalidUtf8, "not valid UTF-8");

    const caseCollision = createBuildFixture();
    mutateBuildManifest(caseCollision, (manifest) => {
      const source = manifest.assets.find(
        (asset) => asset.path === "assets/app-ABC123xy.js"
      );
      if (source === undefined) throw new TypeError("Static test asset is missing.");
      manifest.assets = [
        ...manifest.assets,
        { ...source, path: "assets/APP-ABC123xy.js" }
      ].sort((left, right) => left.path.localeCompare(right.path));
    });
    await expectStaticBuildRejected(caseCollision, "case-unique");
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

function createBuildFixture(
  browserRoutes: readonly `/${string}`[] = ["/"]
): string {
  const buildRoot = createTemporaryDirectory("hostdeck-static-build-");
  mkdirSync(join(buildRoot, "assets", "nested"), { recursive: true });
  const files = [
    { cacheControl: "no-store", content: indexBody, mediaType: "text/html", path: "index.html" },
    { cacheControl: "public, max-age=31536000, immutable", content: javascriptBody, mediaType: "text/javascript", path: "assets/app-ABC123xy.js" },
    { cacheControl: "public, max-age=31536000, immutable", content: '{"fixture":true}\n', mediaType: "application/json", path: "assets/nested/manifest-12345678.json" },
    { cacheControl: "public, max-age=31536000, immutable", content: "plain-static-fixture\n", mediaType: "text/plain", path: "assets/plain-12345678.txt" },
    { cacheControl: "public, max-age=31536000, immutable", content: "body { color: black; }\n", mediaType: "text/css", path: "assets/styles-12345678.css" }
  ] as const;
  for (const file of files) {
    writeFileSync(join(buildRoot, ...file.path.split("/")), file.content, { mode: 0o600 });
  }
  const descriptors = files.map((file) => ({
    cacheControl: file.cacheControl,
    mediaType: file.mediaType,
    path: file.path,
    sha256: sha256(file.content),
    size: Buffer.byteLength(file.content)
  }));
  const content = staticIdentity(files.map((file) => ({ content: Buffer.from(file.content), path: file.path })));
  writeFileSync(
    join(buildRoot, "hostdeck-web.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      name: "hostdeck-production-web",
      packageVersion: "0.0.0",
      viteVersion: "8.1.4",
      browserRoutes,
      entryAssets: ["assets/app-ABC123xy.js", "assets/styles-12345678.css"].sort(),
      index: descriptors[0],
      assets: descriptors.slice(1).sort((left, right) => left.path.localeCompare(right.path)),
      content
    }, null, 2)}\n`,
    { mode: 0o600 }
  );
  return buildRoot;
}

function staticIdentity(
  entries: readonly { readonly content: Buffer; readonly path: string }[]
): { readonly bytes: number; readonly count: number; readonly sha256: string } {
  const hash = createHash("sha256");
  let bytes = 0;
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
    for (const value of ["file", entry.path, String(entry.content.length)]) {
      const framed = Buffer.from(value);
      hash.update(String(framed.length));
      hash.update(":");
      hash.update(framed);
      hash.update(";");
    }
    hash.update(entry.content);
    bytes += entry.content.length;
  }
  return Object.freeze({ bytes, count: entries.length, sha256: hash.digest("hex") });
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

interface MutableWebFileDescriptor {
  cacheControl: string;
  mediaType: string;
  path: string;
  sha256: string;
  size: number;
}

interface MutableWebManifest {
  assets: MutableWebFileDescriptor[];
  browserRoutes: string[];
  content: { bytes: number; count: number; sha256: string };
  entryAssets: string[];
  index: MutableWebFileDescriptor;
  name: string;
  packageVersion: string;
  schemaVersion: number;
  viteVersion: string;
}

function mutateBuildManifest(
  buildRoot: string,
  mutate: (manifest: MutableWebManifest) => void
): void {
  const path = join(buildRoot, "hostdeck-web.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as MutableWebManifest;
  mutate(manifest);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

function resignBuildIndex(
  buildRoot: string,
  mutate: (index: string) => string
): void {
  resignBuildIndexBytes(buildRoot, (index) =>
    Buffer.from(mutate(new TextDecoder("utf-8", { fatal: true }).decode(index)))
  );
}

function resignBuildIndexBytes(
  buildRoot: string,
  mutate: (index: Buffer) => Buffer
): void {
  const indexPath = join(buildRoot, "index.html");
  const changed = mutate(readFileSync(indexPath));
  writeFileSync(indexPath, changed, { mode: 0o600 });
  mutateBuildManifest(buildRoot, (manifest) => {
    manifest.index.sha256 = sha256(changed);
    manifest.index.size = changed.length;
    const entries = [
      { content: changed, path: "index.html" },
      ...manifest.assets.map((asset) => ({
        content: readFileSync(join(buildRoot, ...asset.path.split("/"))),
        path: asset.path
      }))
    ];
    manifest.content = staticIdentity(entries);
  });
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
      id: "rejected-static",
      packageVersion: "0.0.0"
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
      {
        headers: { host: hostDeckLoopbackTestAuthority },
        host: "127.0.0.1",
        method: "GET",
        path,
        port
      },
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
