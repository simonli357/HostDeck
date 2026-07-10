import { lstatSync, realpathSync } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, normalize, resolve, sep } from "node:path";
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

export interface CreateHostDeckStaticBoundaryRegistrationInput {
  readonly browserRoutes: readonly `/${string}`[];
  readonly buildRoot: string;
  readonly id: string;
}

interface ParsedStaticBoundaryInput {
  readonly browserRoutes: readonly `/${string}`[];
  readonly buildRoot: string;
  readonly id: string;
}

interface ValidatedStaticBuild {
  readonly assetPaths: ReadonlySet<string>;
  readonly assetsRoot: string;
  readonly buildRoot: string;
}

interface AssetInventory {
  readonly assetPaths: Set<string>;
  entryCount: number;
  fileCount: number;
  totalBytes: number;
}

const registrationIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const browserLiteralSegmentPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u;
const browserParameterSegmentPattern = /^:[a-z][a-z0-9_]{0,63}$/u;
const hashedAssetPattern = /-[a-zA-Z0-9_-]{8,}(?:\.[a-zA-Z0-9]+)+$/u;
const htmlAssetPattern = /\.html?$/iu;

export function createHostDeckStaticBoundaryRegistration(
  input: CreateHostDeckStaticBoundaryRegistrationInput
): HostDeckRoutePluginRegistration {
  const parsed = parseStaticBoundaryInput(input);
  const registration: HostDeckRoutePluginRegistration = {
    id: parsed.id,
    surface: "static",
    async register(app) {
      const build = await validateStaticBuild(parsed.buildRoot);
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
                relativePath,
                hostDeckStaticBoundaryLimits.indexMaxBytes,
                1
              )
            );
          }
          return (
            relativePath !== null &&
            root === build.assetsRoot &&
            build.assetPaths.has(relativePath) &&
            isCurrentCanonicalFile(
              build.assetsRoot,
              relativePath,
              hostDeckStaticBoundaryLimits.maxAssetFileBytes,
              0
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
        setHeaders(response, filePath) {
          response.setHeader("X-Content-Type-Options", "nosniff");
          response.setHeader(
            "Cache-Control",
            isImmutableHashedAssetPath(filePath)
              ? "public, max-age=31536000, immutable"
              : "no-store"
          );
        },
        wildcard: true
      });

      const sendIndex = (_request: FastifyRequest, reply: FastifyReply) => {
        reply.header("Cache-Control", "no-store");
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
  const expectedKeys = ["browserRoutes", "buildRoot", "id"];
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
    id: value.id
  });
}

function isCanonicalAbsoluteInput(path: string): boolean {
  if (!isAbsolute(path) || path === sep || path.includes("\0")) return false;
  if (normalize(path) !== path || resolve(path) !== path) return false;
  return path.endsWith(sep) ? path === sep : true;
}

async function validateStaticBuild(buildRoot: string): Promise<ValidatedStaticBuild> {
  const root = await requireCanonicalDirectory(buildRoot, "Static build root");
  const indexPath = join(root, "index.html");
  const index = await lstat(indexPath);
  if (
    !index.isFile() ||
    index.isSymbolicLink() ||
    index.size < 1 ||
    index.size > hostDeckStaticBoundaryLimits.indexMaxBytes ||
    index.nlink !== 1
  ) {
    throw new TypeError("Static build index.html must be one nonempty bounded regular file.");
  }
  if ((await realpath(indexPath)) !== indexPath) {
    throw new TypeError("Static build index.html must be canonical and cannot traverse symlinks.");
  }

  const assetsRoot = await requireCanonicalDirectory(join(root, "assets"), "Static assets root");
  const inventory: AssetInventory = {
    assetPaths: new Set<string>(),
    entryCount: 0,
    fileCount: 0,
    totalBytes: 0
  };
  await inspectAssetDirectory(assetsRoot, "", 0, inventory);
  if (inventory.fileCount < 1) throw new TypeError("Static assets root must contain at least one asset file.");
  return Object.freeze({ assetPaths: inventory.assetPaths, assetsRoot, buildRoot: root });
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
  inventory: AssetInventory
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
      await inspectAssetDirectory(path, relativePath, depth + 1, inventory);
      continue;
    }
    if (!entry.isFile() || !stats.isFile() || stats.nlink !== 1) {
      throw new TypeError("Static asset must be one regular non-linked file.");
    }
    if (stats.size > hostDeckStaticBoundaryLimits.maxAssetFileBytes) {
      throw new TypeError("Static asset exceeds its per-file byte limit.");
    }
    inventory.assetPaths.add(relativePath);
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
  if (
    segment.length === 0 ||
    segment === "." ||
    segment === ".." ||
    segment.startsWith(".") ||
    segment.includes("%") ||
    segment.includes("?") ||
    segment.includes("#")
  ) {
    return false;
  }
  for (let index = 0; index < segment.length; index += 1) {
    const code = segment.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function isImmutableHashedAssetPath(filePath: string): boolean {
  const fileName = basename(filePath);
  return !htmlAssetPattern.test(fileName) && hashedAssetPattern.test(fileName);
}

function isCurrentCanonicalFile(
  root: string,
  relativePath: string,
  maxBytes: number,
  minBytes: number
): boolean {
  const filePath = join(root, ...relativePath.split("/"));
  try {
    const stats = lstatSync(filePath);
    return (
      stats.isFile() &&
      !stats.isSymbolicLink() &&
      stats.nlink === 1 &&
      stats.size >= minBytes &&
      stats.size <= maxBytes &&
      realpathSync(filePath) === filePath
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
