import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { extname, join, relative, sep } from "node:path";

const immutableCacheControl = "public, max-age=31536000, immutable";

const mediaTypes = Object.freeze({
  ".css": "text/css",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
});

export interface ProductionWebTestAsset {
  readonly content: string | Buffer;
  readonly path: `assets/${string}`;
}

export interface WriteProductionWebTestFixtureInput {
  readonly assets?: readonly ProductionWebTestAsset[];
  readonly browserRoutes?: readonly `/${string}`[];
  readonly entryAssets?: readonly `assets/${string}`[];
  readonly indexBody?: string;
  readonly packageVersion?: string;
}

export interface WriteProductionWebTestManifestInput {
  readonly browserRoutes?: readonly `/${string}`[];
  readonly entryAssets?: readonly `assets/${string}`[];
  readonly packageVersion?: string;
}

export function writeProductionWebTestFixture(
  buildRoot: string,
  input: WriteProductionWebTestFixtureInput = {}
): void {
  const packageVersion = input.packageVersion ?? "0.0.0";
  const assets = input.assets ?? [
    {
      content: "globalThis.__hostDeckProductionWebFixture = true;\n",
      path: "assets/app-ABC123xy.js"
    }
  ];
  const entryAssets = input.entryAssets ?? [assets[0]?.path ?? "assets/app-ABC123xy.js"];
  const indexBody =
    input.indexBody ??
    [
      '<!doctype html><html lang="en"><head>',
      '<meta charset="UTF-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">',
      '<meta name="theme-color" content="#121313">',
      `<meta name="hostdeck-package-version" content="${packageVersion}">`,
      "<title>HostDeck</title>",
      ...entryAssets.map((path) =>
        extname(path) === ".css"
          ? `<link rel="stylesheet" href="/${path}">`
          : `<script type="module" src="/${path}"></script>`
      ),
      '</head><body><div id="root"></div>HOSTDECK_PRODUCTION_WEB_FIXTURE</body></html>'
    ].join("");

  mkdirSync(join(buildRoot, "assets"), { mode: 0o700, recursive: true });
  const files = [
    {
      cacheControl: "no-store",
      content: Buffer.from(indexBody),
      mediaType: "text/html",
      path: "index.html"
    },
    ...assets.map((asset) => {
      const extension = extname(asset.path).toLowerCase() as keyof typeof mediaTypes;
      const mediaType = mediaTypes[extension];
      if (mediaType === undefined) {
        throw new TypeError(`Unsupported production web test asset: ${asset.path}`);
      }
      return {
        cacheControl: immutableCacheControl,
        content: Buffer.isBuffer(asset.content) ? asset.content : Buffer.from(asset.content),
        mediaType,
        path: asset.path
      };
    })
  ];

  for (const file of files) {
    const path = join(buildRoot, ...file.path.split("/"));
    mkdirSync(join(path, ".."), { mode: 0o700, recursive: true });
    writeFileSync(path, file.content, { mode: 0o600 });
  }

  const descriptors = files.map((file) => ({
    cacheControl: file.cacheControl,
    mediaType: file.mediaType,
    path: file.path,
    sha256: sha256(file.content),
    size: file.content.length
  }));
  writeFileSync(
    join(buildRoot, "hostdeck-web.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        name: "hostdeck-production-web",
        packageVersion,
        viteVersion: "8.1.4",
        browserRoutes: input.browserRoutes ?? ["/"],
        entryAssets: [...entryAssets].sort((left, right) => left.localeCompare(right)),
        index: descriptors[0],
        assets: descriptors.slice(1).sort((left, right) => left.path.localeCompare(right.path)),
        content: contentIdentity(
          files.map((file) => ({ content: file.content, path: file.path }))
        )
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
}

export function writeProductionWebTestManifest(
  buildRoot: string,
  input: WriteProductionWebTestManifestInput = {}
): void {
  const indexContent = readFileSync(join(buildRoot, "index.html"));
  const assetPaths = listAssetPaths(join(buildRoot, "assets"));
  const assets = assetPaths.map((path) => ({
    cacheControl: immutableCacheControl,
    content: readFileSync(join(buildRoot, ...path.split("/"))),
    mediaType: requireMediaType(path),
    path
  }));
  const indexBody = new TextDecoder("utf-8", { fatal: true }).decode(indexContent);
  const discoveredEntryAssets = [
    ...indexBody.matchAll(/\b(?:src|href)=["'](\/assets\/[^"']+)["']/gu)
  ]
    .map((match) => (match[1] ?? "").slice(1) as `assets/${string}`)
    .sort((left, right) => left.localeCompare(right));
  const entryAssets = input.entryAssets ?? discoveredEntryAssets;
  const files = [
    {
      cacheControl: "no-store",
      content: indexContent,
      mediaType: "text/html",
      path: "index.html"
    },
    ...assets
  ];
  const descriptors = files.map((file) => ({
    cacheControl: file.cacheControl,
    mediaType: file.mediaType,
    path: file.path,
    sha256: sha256(file.content),
    size: file.content.length
  }));
  writeFileSync(
    join(buildRoot, "hostdeck-web.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        name: "hostdeck-production-web",
        packageVersion: input.packageVersion ?? "0.0.0",
        viteVersion: "8.1.4",
        browserRoutes: input.browserRoutes ?? ["/"],
        entryAssets: [...entryAssets].sort((left, right) => left.localeCompare(right)),
        index: descriptors[0],
        assets: descriptors.slice(1),
        content: contentIdentity(
          files.map((file) => ({ content: file.content, path: file.path }))
        )
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
}

function listAssetPaths(assetsRoot: string): `assets/${string}`[] {
  const paths: `assets/${string}`[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        paths.push(`assets/${relative(assetsRoot, path).split(sep).join("/")}`);
      } else {
        throw new TypeError("Production web test assets must be regular files.");
      }
    }
  };
  visit(assetsRoot);
  return paths.sort((left, right) => left.localeCompare(right));
}

function requireMediaType(path: string): string {
  const extension = extname(path).toLowerCase() as keyof typeof mediaTypes;
  const mediaType = mediaTypes[extension];
  if (mediaType === undefined) {
    throw new TypeError(`Unsupported production web test asset: ${path}`);
  }
  return mediaType;
}

function contentIdentity(
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

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
