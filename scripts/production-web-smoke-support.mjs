import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  productionWebBrowserRoutes,
  productionWebManifestName,
  verifyProductionWebAssets
} from "./verify-production-package.mjs";

export const productionWebContentSecurityPolicy = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "img-src 'self' data:",
  "manifest-src 'self'",
  "media-src 'none'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'none'"
].join("; ");

export function loadProductionWebSmokeIdentity(packageRoot) {
  const webRoot = join(packageRoot, "web");
  const verification = verifyProductionWebAssets(webRoot);
  const manifest = JSON.parse(
    readFileSync(join(webRoot, productionWebManifestName), "utf8")
  );
  assert.deepEqual(manifest.browserRoutes, productionWebBrowserRoutes);
  assert.equal(manifest.packageVersion, verification.packageVersion);
  assert.equal(manifest.content.sha256, verification.sha256);
  assert.equal(manifest.content.count, verification.fileCount);
  assert.ok(manifest.entryAssets.some((path) => path.endsWith(".js")));
  return Object.freeze({
    assets: Object.freeze([...manifest.assets]),
    browserRoutes: Object.freeze([...manifest.browserRoutes]),
    entryAssets: Object.freeze([...manifest.entryAssets]),
    packageVersion: manifest.packageVersion,
    verification
  });
}

export async function assertProductionWebHttpSurface(
  origin,
  identity,
  request = fetch
) {
  const rootResponse = await request(new URL("/", origin).href);
  assert.equal(rootResponse.status, 200);
  assert.match(rootResponse.headers.get("content-type") ?? "", /^text\/html\b/u);
  assert.equal(rootResponse.headers.get("cache-control"), "no-store");
  assert.equal(
    rootResponse.headers.get("content-security-policy"),
    productionWebContentSecurityPolicy
  );
  assert.equal(rootResponse.headers.get("x-content-type-options"), "nosniff");
  const indexBody = await rootResponse.text();
  assert.match(indexBody, /<div id="root"><\/div>/u);
  assert.match(
    indexBody,
    new RegExp(
      `<meta\\s+name="hostdeck-package-version"\\s+content="${escapeRegExp(
        identity.packageVersion
      )}"\\s*/?>`,
      "u"
    )
  );
  assert.doesNotMatch(
    indexBody,
    /(?:https?:|wss?:|\/src\/|@vite\/client|vite\/hmr|sourceMappingURL|<base\b)/iu
  );
  const references = [
    ...indexBody.matchAll(/\b(?:src|href)=["'](\/assets\/[^"']+)["']/gu)
  ]
    .map((match) => (match[1] ?? "").slice(1))
    .sort((left, right) => left.localeCompare(right));
  assert.deepEqual(references, identity.entryAssets);

  const detailResponse = await request(
    new URL("/sessions/sess_package_web_001", origin).href
  );
  assert.equal(detailResponse.status, 200);
  assert.equal(detailResponse.headers.get("cache-control"), "no-store");
  assert.equal(
    detailResponse.headers.get("content-security-policy"),
    productionWebContentSecurityPolicy
  );
  assert.equal(await detailResponse.text(), indexBody);

  const descriptors = new Map(
    identity.assets.map((descriptor) => [descriptor.path, descriptor])
  );
  for (const path of identity.entryAssets) {
    const descriptor = descriptors.get(path);
    assert.ok(descriptor !== undefined, `Missing entry descriptor for ${path}.`);
    const response = await request(new URL(`/${path}`, origin).href);
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("content-type") ?? "",
      new RegExp(`^${escapeRegExp(descriptor.mediaType)}\\b`, "u")
    );
    assert.equal(
      response.headers.get("cache-control"),
      "public, max-age=31536000, immutable"
    );
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal((await response.arrayBuffer()).byteLength, descriptor.size);
  }

  await assertJsonNotFound(
    await request(new URL("/assets/undeclared-12345678.js", origin).href)
  );
  await assertJsonNotFound(
    await request(new URL(`/${productionWebManifestName}`, origin).href)
  );
  await assertJsonNotFound(
    await request(new URL("/api/v1/package-web-missing", origin).href)
  );
}

async function assertJsonNotFound(response) {
  assert.equal(response.status, 404);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^application\/json\b/u
  );
  assert.equal((await response.json()).error.code, "route_not_found");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
