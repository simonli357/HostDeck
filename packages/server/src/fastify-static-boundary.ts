import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { HostDeckRoutePluginRegistration } from "./fastify-app.js";
import { sendHostDeckError } from "./fastify-error-policy.js";

export const hostDeckStaticBoundaryLimits = Object.freeze({
  indexMaxBytes: 2_097_152,
  maxAssetDepth: 16,
  maxAssetEntries: 20_000,
  maxAssetFileBytes: 33_554_432,
  maxAssetFiles: 10_000,
  maxAssetTotalBytes: 268_435_456,
  maxBrowserRouteBytes: 512,
  maxBrowserRouteSegments: 16,
  maxBrowserRoutes: 64
});

export const hostDeckProductionBrowserRoutes = Object.freeze([
  "/",
  "/sessions/:session_id"
] as const);

export const hostDeckStaticContentSecurityPolicy = [
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

export interface CreateHostDeckStaticBoundaryRegistrationInput {
  readonly browserRoutes: readonly `/${string}`[];
  readonly buildRoot: string;
  readonly id: string;
  readonly packageVersion: string;
}

interface ParsedStaticBoundaryInput {
  readonly browserRoutes: readonly `/${string}`[];
  readonly buildRoot: string;
  readonly id: string;
  readonly packageVersion: string;
}

interface ValidatedStaticBuild {
  readonly assets: ReadonlyMap<string, StaticFileDescriptor>;
  readonly assetsRoot: string;
  readonly buildRoot: string;
  readonly index: StaticFileDescriptor;
}

interface StaticFileDescriptor {
  readonly cacheControl: string;
  readonly mediaType: string;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

interface ParsedStaticManifest {
  readonly assets: readonly StaticFileDescriptor[];
  readonly browserRoutes: readonly `/${string}`[];
  readonly content: Readonly<Record<string, unknown>>;
  readonly entryAssets: readonly string[];
  readonly index: StaticFileDescriptor;
  readonly packageVersion: string;
}

interface AssetInventory {
  readonly assetPaths: Set<string>;
  readonly contents: Map<string, Buffer>;
  entryCount: number;
  fileCount: number;
  totalBytes: number;
}

const registrationIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const browserLiteralSegmentPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u;
const browserParameterSegmentPattern = /^:[a-z][a-z0-9_]{0,63}$/u;
const hashedAssetPattern = /-[a-zA-Z0-9_-]{8,}(?:\.[a-zA-Z0-9]+)+$/u;
const safeStaticSegmentPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/u;
const exactVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const staticManifestName = "hostdeck-web.json";
const staticManifestMaximumBytes = 1_048_576;
const staticManifestSchemaVersion = 1;
const staticManifestViteVersion = "8.1.4";
const immutableCacheControl = "public, max-age=31536000, immutable";
const supportedMediaTypes = Object.freeze({
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

export function createHostDeckStaticBoundaryRegistration(
  input: CreateHostDeckStaticBoundaryRegistrationInput
): HostDeckRoutePluginRegistration {
  const parsed = parseStaticBoundaryInput(input);
  const registration: HostDeckRoutePluginRegistration = {
    id: parsed.id,
    surface: "static",
    async register(app) {
      const build = await validateStaticBuild(
        parsed.buildRoot,
        parsed.packageVersion,
        parsed.browserRoutes
      );
      app.addHook("onRequest", async (request, reply) => {
        const rawTarget = request.raw.url ?? request.url;
        if (isStaticAssetTarget(rawTarget) && !isAllowedRawStaticTarget(rawTarget)) {
          return sendHostDeckError(reply, request, 404, {
            code: "route_not_found",
            message: "Route not found.",
            retryable: false
          });
        }
      });
      await app.register(fastifyStatic, {
        allowedPath(pathName, root) {
          const relativePath = parseAllowedStaticPath(pathName, true);
          if (root === build.buildRoot) {
            return (
              relativePath === "index.html" &&
              isCurrentCanonicalFile(
                build.buildRoot,
                build.index,
                false
              )
            );
          }
          const descriptor =
            relativePath === null ? undefined : build.assets.get(relativePath);
          return (
            descriptor !== undefined &&
            root === build.assetsRoot &&
            isCurrentCanonicalFile(
              build.assetsRoot,
              descriptor,
              true
            )
          );
        },
        cacheControl: false,
        decorateReply: true,
        dotfiles: "deny",
        index: false,
        prefix: "/assets/",
        prefixAvoidTrailingSlash: false,
        redirect: false,
        root: build.assetsRoot,
        serveDotFiles: false,
        setHeaders(reply, filePath) {
          if (filePath === join(build.buildRoot, build.index.path)) {
            reply.type(build.index.mediaType);
            reply.header("Cache-Control", build.index.cacheControl);
            reply.header("Content-Security-Policy", hostDeckStaticContentSecurityPolicy);
            reply.header("X-Content-Type-Options", "nosniff");
            return;
          }
          const relativePath = filePath.startsWith(`${build.assetsRoot}${sep}`)
            ? portable(relative(build.assetsRoot, filePath))
            : parseAllowedStaticPath(filePath, true);
          const descriptor =
            relativePath === null ? undefined : build.assets.get(relativePath);
          if (descriptor === undefined) {
            throw new TypeError("Static response escaped its validated manifest.");
          }
          reply.type(descriptor.mediaType);
          reply.header("X-Content-Type-Options", "nosniff");
          reply.header("Cache-Control", descriptor.cacheControl);
        },
        wildcard: true
      });

      const sendIndex = (_request: FastifyRequest, reply: FastifyReply) => {
        reply.type(build.index.mediaType);
        reply.header("Cache-Control", "no-store");
        reply.header("Content-Security-Policy", hostDeckStaticContentSecurityPolicy);
        reply.header("X-Content-Type-Options", "nosniff");
        return reply.sendFile("index.html", build.buildRoot, { cacheControl: false });
      };
      for (const route of parsed.browserRoutes) app.get(route, sendIndex);
    }
  };
  return Object.freeze(registration);
}

function parseStaticBoundaryInput(input: unknown): ParsedStaticBoundaryInput {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("HostDeck static-boundary input must be an object.");
  }
  const value = input as Partial<CreateHostDeckStaticBoundaryRegistrationInput>;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("HostDeck static-boundary input must be a plain object.");
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = ["browserRoutes", "buildRoot", "id", "packageVersion"];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TypeError("HostDeck static-boundary input fields are invalid.");
  }
  if (typeof value.id !== "string" || !registrationIdPattern.test(value.id)) {
    throw new TypeError("HostDeck static-boundary registration id is invalid.");
  }
  if (typeof value.buildRoot !== "string" || !isCanonicalAbsoluteInput(value.buildRoot)) {
    throw new TypeError("HostDeck static build root must be a canonical absolute path.");
  }
  if (
    typeof value.packageVersion !== "string" ||
    !exactVersionPattern.test(value.packageVersion)
  ) {
    throw new TypeError("HostDeck static packageVersion is invalid.");
  }
  if (!Array.isArray(value.browserRoutes)) {
    throw new TypeError("HostDeck static browserRoutes must be an array.");
  }
  if (
    value.browserRoutes.length < 1 ||
    value.browserRoutes.length > hostDeckStaticBoundaryLimits.maxBrowserRoutes
  ) {
    throw new TypeError(
      `HostDeck static browserRoutes must contain 1 to ${hostDeckStaticBoundaryLimits.maxBrowserRoutes} routes.`
    );
  }
  const routes = new Set<string>();
  const routeShapes = new Set<string>();
  for (const route of value.browserRoutes) {
    if (
      typeof route !== "string" ||
      !isAllowedBrowserRoute(route) ||
      route === "/assets" ||
      route.startsWith("/assets/") ||
      route === "/api" ||
      route.startsWith("/api/")
    ) {
      throw new TypeError("HostDeck static browser route is invalid.");
    }
    if (routes.has(route)) throw new TypeError(`HostDeck static browser route "${route}" is duplicated.`);
    const shape = browserRouteShape(route);
    if (routeShapes.has(shape)) {
      throw new TypeError(`HostDeck static browser route shape "${shape}" is duplicated.`);
    }
    routes.add(route);
    routeShapes.add(shape);
  }
  if (!routes.has("/")) throw new TypeError('HostDeck static browserRoutes must include "/".');
  return Object.freeze({
    browserRoutes: Object.freeze([...routes]) as readonly `/${string}`[],
    buildRoot: value.buildRoot,
    id: value.id,
    packageVersion: value.packageVersion
  });
}

function isCanonicalAbsoluteInput(path: string): boolean {
  if (!isAbsolute(path) || path === sep || path.includes("\0")) return false;
  if (normalize(path) !== path || resolve(path) !== path) return false;
  return path.endsWith(sep) ? path === sep : true;
}

async function validateStaticBuild(
  buildRoot: string,
  packageVersion: string,
  browserRoutes: readonly `/${string}`[]
): Promise<ValidatedStaticBuild> {
  const root = await requireCanonicalDirectory(buildRoot, "Static build root");
  const manifest = await readStaticManifest(root, packageVersion, browserRoutes);
  const indexPath = join(root, "index.html");
  const indexStats = await lstat(indexPath);
  if (
    !indexStats.isFile() ||
    indexStats.isSymbolicLink() ||
    indexStats.size < 1 ||
    indexStats.size > hostDeckStaticBoundaryLimits.indexMaxBytes ||
    indexStats.nlink !== 1
  ) {
    throw new TypeError("Static build index.html must be one nonempty bounded regular file.");
  }
  if ((await realpath(indexPath)) !== indexPath) {
    throw new TypeError("Static build index.html must be canonical and cannot traverse symlinks.");
  }
  const indexContent = await readFile(indexPath);
  assertStaticFileIdentity(manifest.index, indexContent, "Static build index.html");
  validateStaticIndex(indexContent, manifest);

  const assetsRoot = await requireCanonicalDirectory(join(root, "assets"), "Static assets root");
  const assets = new Map(manifest.assets.map((asset) => [asset.path.slice("assets/".length), asset]));
  const inventory: AssetInventory = {
    assetPaths: new Set<string>(),
    contents: new Map<string, Buffer>(),
    entryCount: 0,
    fileCount: 0,
    totalBytes: 0
  };
  await inspectAssetDirectory(assetsRoot, "", 0, inventory, assets);
  if (inventory.fileCount < 1) throw new TypeError("Static assets root must contain at least one asset file.");
  const actualPaths = [...inventory.assetPaths].sort((left, right) => left.localeCompare(right));
  const expectedPaths = [...assets.keys()].sort((left, right) => left.localeCompare(right));
  if (!sameArray(actualPaths, expectedPaths)) {
    throw new TypeError("Static asset inventory does not match its manifest.");
  }
  const contentIdentity = computeStaticContentIdentity([
    { content: indexContent, path: "index.html" },
    ...actualPaths.map((path) => ({
      content: inventory.contents.get(path) as Buffer,
      path: `assets/${path}`
    }))
  ]);
  assertExactObjectKeys(manifest.content, ["bytes", "count", "sha256"], "Static content identity");
  if (
    manifest.content.bytes !== contentIdentity.bytes ||
    manifest.content.count !== contentIdentity.count ||
    manifest.content.sha256 !== contentIdentity.sha256
  ) {
    throw new TypeError("Static content identity does not match its manifest.");
  }
  return Object.freeze({
    assets,
    assetsRoot,
    buildRoot: root,
    index: manifest.index
  });
}

async function requireCanonicalDirectory(path: string, label: string): Promise<string> {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new TypeError(`${label} must be a real directory.`);
  }
  const canonical = await realpath(path);
  if (canonical !== path) throw new TypeError(`${label} must be canonical and cannot traverse symlinks.`);
  return canonical;
}

async function inspectAssetDirectory(
  directory: string,
  relativeDirectory: string,
  depth: number,
  inventory: AssetInventory,
  expected: ReadonlyMap<string, StaticFileDescriptor>
): Promise<void> {
  if (depth > hostDeckStaticBoundaryLimits.maxAssetDepth) {
    throw new TypeError("Static asset directory depth exceeds its configured limit.");
  }
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (!isAllowedStaticSegment(entry.name)) {
      throw new TypeError("Static asset tree contains a forbidden path segment.");
    }
    const path = join(directory, entry.name);
    const relativePath = relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
    inventory.entryCount += 1;
    if (inventory.entryCount > hostDeckStaticBoundaryLimits.maxAssetEntries) {
      throw new TypeError("Static asset entry count exceeds its configured limit.");
    }
    const stats = await lstat(path);
    if (entry.isSymbolicLink() || stats.isSymbolicLink()) {
      throw new TypeError("Static asset tree cannot contain symbolic links.");
    }
    if (entry.isDirectory() && stats.isDirectory()) {
      if ((await realpath(path)) !== path) {
        throw new TypeError("Static asset directory must be canonical and cannot traverse symlinks.");
      }
      if (![...expected.keys()].some((candidate) => candidate.startsWith(`${relativePath}/`))) {
        throw new TypeError("Static asset tree contains an undeclared directory.");
      }
      await inspectAssetDirectory(path, relativePath, depth + 1, inventory, expected);
      continue;
    }
    if (!entry.isFile() || !stats.isFile() || stats.nlink !== 1) {
      throw new TypeError("Static asset must be one regular non-linked file.");
    }
    if (stats.size > hostDeckStaticBoundaryLimits.maxAssetFileBytes) {
      throw new TypeError("Static asset exceeds its per-file byte limit.");
    }
    const descriptor = expected.get(relativePath);
    if (descriptor === undefined) {
      throw new TypeError("Static asset tree contains an undeclared file.");
    }
    const content = await readFile(path);
    assertStaticFileIdentity(descriptor, content, `Static asset ${relativePath}`);
    inventory.assetPaths.add(relativePath);
    inventory.contents.set(relativePath, content);
    inventory.fileCount += 1;
    inventory.totalBytes += stats.size;
    if (inventory.fileCount > hostDeckStaticBoundaryLimits.maxAssetFiles) {
      throw new TypeError("Static asset file count exceeds its configured limit.");
    }
    if (inventory.totalBytes > hostDeckStaticBoundaryLimits.maxAssetTotalBytes) {
      throw new TypeError("Static asset total bytes exceed their configured limit.");
    }
  }
}

async function readStaticManifest(
  root: string,
  packageVersion: string,
  browserRoutes: readonly `/${string}`[]
): Promise<ParsedStaticManifest & { readonly content: Readonly<Record<string, unknown>> }> {
  const rootEntries = (await readdir(root, { withFileTypes: true }))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  if (!sameArray(rootEntries, ["assets", "index.html", staticManifestName].sort())) {
    throw new TypeError("Static build root inventory is invalid.");
  }
  const manifestPath = join(root, staticManifestName);
  const stats = await lstat(manifestPath);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    stats.size < 1 ||
    stats.size > staticManifestMaximumBytes ||
    (await realpath(manifestPath)) !== manifestPath
  ) {
    throw new TypeError("Static build manifest must be one bounded canonical regular file.");
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(await readFile(manifestPath))
    );
  } catch (cause) {
    throw new TypeError("Static build manifest is invalid JSON or UTF-8.", { cause });
  }
  assertExactObjectKeys(
    candidate,
    [
      "assets",
      "browserRoutes",
      "content",
      "entryAssets",
      "index",
      "name",
      "packageVersion",
      "schemaVersion",
      "viteVersion"
    ],
    "Static build manifest"
  );
  if (
    candidate.schemaVersion !== staticManifestSchemaVersion ||
    candidate.name !== "hostdeck-production-web" ||
    candidate.packageVersion !== packageVersion ||
    candidate.viteVersion !== staticManifestViteVersion
  ) {
    throw new TypeError("Static build manifest version identity is inconsistent.");
  }
  if (
    !Array.isArray(candidate.browserRoutes) ||
    candidate.browserRoutes.length !== browserRoutes.length ||
    candidate.browserRoutes.some((route, index) => route !== browserRoutes[index])
  ) {
    throw new TypeError("Static build browser routes are inconsistent.");
  }
  const index = parseStaticFileDescriptor(
    candidate.index,
    "index.html",
    "text/html",
    "no-store",
    "Static index descriptor"
  );
  if (
    !Array.isArray(candidate.assets) ||
    candidate.assets.length < 1 ||
    candidate.assets.length > hostDeckStaticBoundaryLimits.maxAssetFiles
  ) {
    throw new TypeError("Static build asset descriptors are invalid.");
  }
  const assets = candidate.assets.map((asset) =>
    parseStaticAssetDescriptor(asset)
  );
  const assetPaths = assets.map((asset) => asset.path);
  const sortedAssetPaths = [...assetPaths].sort((left, right) => left.localeCompare(right));
  if (
    !sameArray(assetPaths, sortedAssetPaths) ||
    new Set(assetPaths).size !== assetPaths.length ||
    new Set(assetPaths.map((path) => path.toLowerCase())).size !== assetPaths.length
  ) {
    throw new TypeError("Static build asset descriptors must be sorted and case-unique.");
  }
  if (
    !Array.isArray(candidate.entryAssets) ||
    candidate.entryAssets.length < 1 ||
    candidate.entryAssets.some((path) => typeof path !== "string")
  ) {
    throw new TypeError("Static build entry assets are invalid.");
  }
  const entryAssets = [...candidate.entryAssets] as string[];
  const sortedEntryAssets = [...entryAssets].sort((left, right) => left.localeCompare(right));
  if (
    !sameArray(entryAssets, sortedEntryAssets) ||
    new Set(entryAssets).size !== entryAssets.length ||
    entryAssets.some((path) => !assetPaths.includes(path)) ||
    !entryAssets.some((path) => extname(path).toLowerCase() === ".js")
  ) {
    throw new TypeError("Static build entry assets are inconsistent.");
  }
  assertExactObjectKeys(candidate.content, ["bytes", "count", "sha256"], "Static content identity");
  const declaredBytes = [index, ...assets].reduce((total, descriptor) => total + descriptor.size, 0);
  if (
    !Number.isSafeInteger(candidate.content.bytes) ||
    candidate.content.bytes !== declaredBytes ||
    candidate.content.count !== assets.length + 1 ||
    typeof candidate.content.sha256 !== "string" ||
    !sha256Pattern.test(candidate.content.sha256)
  ) {
    throw new TypeError("Static build content identity is inconsistent.");
  }
  return Object.freeze({
    assets: Object.freeze(assets),
    browserRoutes: Object.freeze([...browserRoutes]),
    content: Object.freeze({ ...candidate.content }),
    entryAssets: Object.freeze(entryAssets),
    index,
    packageVersion
  });
}

function parseStaticAssetDescriptor(candidate: unknown): StaticFileDescriptor {
  const descriptor = parseStaticFileDescriptor(
    candidate,
    undefined,
    undefined,
    immutableCacheControl,
    "Static asset descriptor"
  );
  if (
    !descriptor.path.startsWith("assets/") ||
    !hashedAssetPattern.test(basename(descriptor.path)) ||
    descriptor.mediaType !== supportedMediaTypes[extname(descriptor.path).toLowerCase() as keyof typeof supportedMediaTypes]
  ) {
    throw new TypeError("Static asset descriptor path or media type is invalid.");
  }
  return descriptor;
}

function parseStaticFileDescriptor(
  candidate: unknown,
  expectedPath: string | undefined,
  expectedMediaType: string | undefined,
  expectedCacheControl: string,
  label: string
): StaticFileDescriptor {
  assertExactObjectKeys(
    candidate,
    ["cacheControl", "mediaType", "path", "sha256", "size"],
    label
  );
  if (
    typeof candidate.path !== "string" ||
    parseAllowedStaticPath(candidate.path, false) !== candidate.path ||
    (expectedPath !== undefined && candidate.path !== expectedPath) ||
    typeof candidate.mediaType !== "string" ||
    (expectedMediaType !== undefined && candidate.mediaType !== expectedMediaType) ||
    candidate.cacheControl !== expectedCacheControl ||
    !Number.isSafeInteger(candidate.size) ||
    (candidate.size as number) < 1 ||
    typeof candidate.sha256 !== "string" ||
    !sha256Pattern.test(candidate.sha256)
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return Object.freeze({
    cacheControl: candidate.cacheControl,
    mediaType: candidate.mediaType,
    path: candidate.path,
    sha256: candidate.sha256,
    size: candidate.size as number
  });
}

function validateStaticIndex(content: Buffer, manifest: ParsedStaticManifest): void {
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (cause) {
    throw new TypeError("Static index is not valid UTF-8.", { cause });
  }
  const escapedVersion = manifest.packageVersion.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const marker = new RegExp(
    `<meta\\s+name=["']hostdeck-package-version["']\\s+content=["']${escapedVersion}["']\\s*/?>`,
    "gu"
  );
  if (
    countMatches(html, marker) !== 1 ||
    countMatches(html, /<meta\b[^>]*\bname=["']hostdeck-package-version["'][^>]*>/giu) !== 1 ||
    /(?:https?:|wss?:|\/src\/|@vite\/client|vite\/hmr|sourceMappingURL)/iu.test(html) ||
    /<base\b/iu.test(html) ||
    /\son[a-z][a-z0-9_-]*\s*=/iu.test(html)
  ) {
    throw new TypeError("Static index contains an invalid version, source, or external reference.");
  }
  assertSelectedProductionDocument(html);
  const references = [];
  for (const match of html.matchAll(/(?:^|[\s<])(?:src|href)\s*=\s*["']([^"']+)["']/giu)) {
    const reference = match[1] ?? "";
    if (!reference.startsWith("/assets/")) {
      throw new TypeError("Static index entry references are inconsistent.");
    }
    references.push(reference.slice(1));
  }
  references.sort((left, right) => left.localeCompare(right));
  if (!sameArray(references, manifest.entryAssets)) {
    throw new TypeError("Static index entry references are inconsistent.");
  }
  const scripts = [...html.matchAll(/<script\b([^>]*)>/giu)];
  if (
    scripts.length !== 1 ||
    scripts.some(
      (match) =>
        !/(?:^|\s)type=["']module["'](?:\s|$)/u.test(match[1] ?? "") ||
        !/(?:^|\s)src=["']\/assets\//u.test(match[1] ?? "")
    )
  ) {
    throw new TypeError("Static index contains inline executable script.");
  }
}

function assertSelectedProductionDocument(html: string): void {
  const selectedElements: readonly (readonly [RegExp, RegExp])[] = [
    [/<!doctype\s+html\s*>/giu, /<!doctype\b/giu],
    [/<html\s+lang=["']en["']\s*>/giu, /<html\b/giu],
    [/<meta\s+charset=["']UTF-8["']\s*\/?>/giu, /<meta\b[^>]*\bcharset\s*=/giu],
    [
      /<meta\s+name=["']viewport["']\s+content=["']width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content["']\s*\/?>/giu,
      /<meta\b[^>]*\bname=["']viewport["'][^>]*>/giu
    ],
    [
      /<meta\s+name=["']theme-color["']\s+content=["']#121313["']\s*\/?>/giu,
      /<meta\b[^>]*\bname=["']theme-color["'][^>]*>/giu
    ],
    [/<title>HostDeck<\/title>/giu, /<title\b/giu],
    [/<div\s+id=["']root["']\s*><\/div>/giu, /<[a-z][^>]*\bid=["']root["'][^>]*>/giu]
  ];
  if (
    selectedElements.some(
      ([expected, family]) =>
        countMatches(html, expected) !== 1 || countMatches(html, family) !== 1
    )
  ) {
    throw new TypeError("Static index document structure is invalid.");
  }
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

function assertStaticFileIdentity(
  descriptor: StaticFileDescriptor,
  content: Buffer,
  label: string
): void {
  if (
    content.length !== descriptor.size ||
    sha256(content) !== descriptor.sha256
  ) {
    throw new TypeError(`${label} identity does not match its manifest.`);
  }
}

function computeStaticContentIdentity(
  entries: readonly { readonly content: Buffer; readonly path: string }[]
): { readonly bytes: number; readonly count: number; readonly sha256: string } {
  const hash = createHash("sha256");
  let bytes = 0;
  const sorted = [...entries].sort((left, right) => left.path.localeCompare(right.path));
  for (const entry of sorted) {
    updateFramedHash(hash, "file");
    updateFramedHash(hash, entry.path);
    updateFramedHash(hash, String(entry.content.length));
    hash.update(entry.content);
    bytes += entry.content.length;
  }
  return Object.freeze({ bytes, count: sorted.length, sha256: hash.digest("hex") });
}

function updateFramedHash(hash: ReturnType<typeof createHash>, value: string): void {
  const content = Buffer.from(value);
  hash.update(String(content.length));
  hash.update(":");
  hash.update(content);
  hash.update(";");
}

function assertExactObjectKeys(
  candidate: unknown,
  expected: readonly string[],
  label: string
): asserts candidate is Record<string, unknown> {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(candidate);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const keys = Object.keys(candidate).sort();
  const sortedExpected = [...expected].sort();
  if (!sameArray(keys, sortedExpected)) throw new TypeError(`${label} fields are invalid.`);
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function portable(path: string): string {
  return path.split(sep).join("/");
}

function parseAllowedStaticPath(pathName: string, allowLeadingSlash: boolean): string | null {
  if (pathName.length === 0 || pathName.includes("\\") || pathName.includes("\0")) return null;
  const relativePath = allowLeadingSlash && pathName.startsWith("/") ? pathName.slice(1) : pathName;
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("/") ||
    !relativePath.split("/").every(isAllowedStaticSegment)
  ) {
    return null;
  }
  return relativePath;
}

function isStaticAssetTarget(rawTarget: string): boolean {
  const queryStart = rawTarget.indexOf("?");
  const pathName = queryStart === -1 ? rawTarget : rawTarget.slice(0, queryStart);
  return pathName === "/assets" || pathName.startsWith("/assets/");
}

function isAllowedRawStaticTarget(rawTarget: string): boolean {
  const queryStart = rawTarget.indexOf("?");
  const encodedPath = queryStart === -1 ? rawTarget : rawTarget.slice(0, queryStart);
  if (!encodedPath.startsWith("/assets/")) return false;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(encodedPath);
  } catch {
    return false;
  }
  if (!decodedPath.startsWith("/assets/")) return false;
  const relativePath = decodedPath.slice("/assets/".length);
  return parseAllowedStaticPath(relativePath, false) !== null;
}

function isAllowedStaticSegment(segment: string): boolean {
  return safeStaticSegmentPattern.test(segment);
}

function isCurrentCanonicalFile(
  root: string,
  descriptor: StaticFileDescriptor,
  stripAssetsPrefix: boolean
): boolean {
  const relativePath = stripAssetsPrefix
    ? descriptor.path.slice("assets/".length)
    : descriptor.path;
  const filePath = join(root, ...relativePath.split("/"));
  try {
    const stats = lstatSync(filePath);
    return (
      stats.isFile() &&
      !stats.isSymbolicLink() &&
      stats.nlink === 1 &&
      stats.size === descriptor.size &&
      realpathSync(filePath) === filePath &&
      sha256(readFileSync(filePath)) === descriptor.sha256
    );
  } catch {
    return false;
  }
}

function isAllowedBrowserRoute(route: string): route is `/${string}` {
  if (
    !route.startsWith("/") ||
    route.length > hostDeckStaticBoundaryLimits.maxBrowserRouteBytes ||
    Buffer.byteLength(route, "utf8") > hostDeckStaticBoundaryLimits.maxBrowserRouteBytes
  ) {
    return false;
  }
  if (route === "/") return true;
  const segments = route.slice(1).split("/");
  if (
    segments.length > hostDeckStaticBoundaryLimits.maxBrowserRouteSegments ||
    segments.some(
      (segment) =>
        !browserLiteralSegmentPattern.test(segment) && !browserParameterSegmentPattern.test(segment)
    )
  ) {
    return false;
  }
  const parameterNames = segments.filter((segment) => segment.startsWith(":"));
  return new Set(parameterNames).size === parameterNames.length;
}

function browserRouteShape(route: string): string {
  if (route === "/") return route;
  return `/${route
    .slice(1)
    .split("/")
    .map((segment) => (segment.startsWith(":") ? ":" : segment))
    .join("/")}`;
}
