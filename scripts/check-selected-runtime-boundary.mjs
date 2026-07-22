import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync
} from "node:fs";
import {
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import { pathToFileURL } from "node:url";
import {
  createScanner,
  LanguageVariant,
  SyntaxKind
} from "typescript/unstable/ast";

const selectedRootEntries = [
  "packages/server/src/index.ts",
  "packages/cli/src/index.ts",
  "packages/web/src/index.ts",
  "packages/contracts/src/index.ts",
  "packages/core/src/index.ts",
  "packages/storage/src/index.ts"
];

const productionPackageRootEntries = selectedRootEntries.filter(
  (path) => path !== "packages/web/src/index.ts"
);

const removedPaths = [
  "packages/tmux-adapter/package.json",
  "packages/cli/src/local-admin.test.ts",
  "packages/cli/src/local-admin.ts",
  "packages/contracts/src/api.contract.test.ts",
  "packages/contracts/src/api.ts",
  "packages/contracts/src/lan-network.contract.test.ts",
  "packages/contracts/src/lan-network.ts",
  "packages/contracts/src/ui.contract.test.ts",
  "packages/contracts/src/ui.ts",
  "packages/core/src/classifier.ts",
  "packages/core/src/commands.test.ts",
  "packages/core/src/commands.ts",
  "packages/core/src/session.test.ts",
  "packages/core/src/session.ts",
  "packages/server/src/api-route-contracts.contract.test.ts",
  "packages/server/src/api-route-contracts.ts",
  "packages/server/src/fastify-host-lifecycle-https.test.ts",
  "packages/server/src/host-service.ts",
  "packages/server/src/lan-certificate-policy.test.ts",
  "packages/server/src/lan-certificate-policy.ts",
  "packages/server/src/lan-https-certificate.probe.test.ts",
  "packages/server/src/lan-network-https.test.ts",
  "packages/server/src/lan-network-routes.test.ts",
  "packages/server/src/lan-network-routes.ts",
  "packages/server/src/lan-network-service.ts",
  "packages/server/src/output-reader.ts",
  "packages/server/src/read-routes.ts",
  "packages/server/src/restart-reconciler.ts",
  "packages/server/src/security-acceptance-android.smoke.test.ts",
  "packages/server/src/security-acceptance-harness.test.ts",
  "packages/server/src/security-acceptance-harness.ts",
  "packages/server/src/security-routes.test.ts",
  "packages/server/src/security-routes.ts",
  "packages/server/src/session-control-routes.ts",
  "packages/server/src/startup.ts",
  "packages/server/src/stream-routes.ts",
  "packages/server/src/write-routes.ts",
  "packages/storage/src/audit-repository.test.ts",
  "packages/storage/src/audit-repository.ts",
  "packages/storage/src/csrf-bootstrap-repository.test.ts",
  "packages/storage/src/lan-configuration-repository.test.ts",
  "packages/storage/src/lan-configuration-repository.ts",
  "packages/storage/src/restart-persistence.test.ts",
  "packages/storage/src/retention-repository.test.ts",
  "packages/storage/src/retention-repository.ts",
  "packages/storage/src/session-repository.test.ts",
  "packages/storage/src/session-repository.ts",
  "packages/storage/src/storage-hardening.test.ts",
  "packages/test-fixtures/src/classifier.test.ts",
  "packages/test-fixtures/src/codex-output.ts",
  "packages/test-fixtures/src/cross-package.contract.test.ts",
  "packages/test-fixtures/src/dashboard-states.ts",
  "packages/test-fixtures/src/session-states.ts",
  "packages/web/src/view-models.test.ts",
  "packages/web/src/view-models.ts"
];

const exactRootModules = new Map([
  [
    "packages/core/src/index.ts",
    ["./deadline.js", "./errors.js", "./identifiers.js", "./remote-ingress.js", "./selected-runtime.js"]
  ],
  [
    "packages/contracts/src/index.ts",
    [
      "./api-error.js",
      "./csrf.js",
      "./device-listing.js",
      "./device-revocation.js",
      "./host-health.js",
      "./host-lock.js",
      "./pairing.js",
      "./pairing-link.js",
      "./remote-ingress.js",
      "./request-authentication.js",
      "./resource-policy.js",
      "./route-params.js",
      "./scalars.js",
      "./security-audit.js",
      "./selected-event-page.js",
      "./selected-mobile.js",
      "./selected-operations.js",
      "./selected-resume.js",
      "./selected-runtime.js",
      "./selected-session-read.js",
      "./selected-storage.js",
      "./storage.js"
    ]
  ],
  [
    "packages/web/src/index.ts",
    [
      "./app-shell.js",
      "./csrf-client.js",
      "./http-client.js",
      "./http-route-contracts.js",
      "./pairing-bootstrap.js",
      "./sse-client.js",
      "./sse-route-contract.js"
    ]
  ],
  [
    "packages/test-fixtures/src/index.ts",
    ["./mobile-design-contract.js", "./remote-ingress.js", "./structured-runtime.js"]
  ]
]);

const forbiddenRootModules = new Set([
  "./api-route-contracts.js",
  "./api.js",
  "./audit-repository.js",
  "./classifier.js",
  "./commands.js",
  "./host-service.js",
  "./lan-certificate-policy.js",
  "./lan-configuration-repository.js",
  "./lan-network-routes.js",
  "./lan-network-service.js",
  "./lan-network.js",
  "./local-admin.js",
  "./output-reader.js",
  "./read-routes.js",
  "./restart-reconciler.js",
  "./retention-repository.js",
  "./security-acceptance-harness.js",
  "./security-routes.js",
  "./session-control-routes.js",
  "./session-repository.js",
  "./session.js",
  "./startup.js",
  "./stream-routes.js",
  "./ui.js",
  "./view-models.js",
  "./write-routes.js"
]);

const forbiddenDependencies = [
  "@hostdeck/tmux-adapter",
  "@peculiar/x509",
  "reflect-metadata"
];

const forbiddenScripts = [
  "smoke:android-security",
  "smoke:lan-android",
  "test:tmux"
];

const forbiddenScriptFragments = [
  "packages/tmux-adapter",
  "security-acceptance-android.smoke.test.ts",
  "lan-certificate-policy",
  "lan-network-routes",
  "view-models.test.ts"
];

const historicalTokenPaths = new Set([
  "packages/contracts/src/security-audit.ts",
  "packages/contracts/src/selected-storage.ts",
  "packages/core/src/selected-runtime.ts",
  "packages/storage/src/migrations.ts"
]);

const historicalExceptionImports = new Map([
  ["packages/storage/src/migrations.ts", []],
  [
    "packages/contracts/src/security-audit.ts",
    ["@hostdeck/core", "./remote-ingress.js", "./scalars.js", "zod"]
  ],
  [
    "packages/contracts/src/selected-storage.ts",
    [
      "@hostdeck/core",
      "./scalars.js",
      "./security-audit.js",
      "./selected-operations.js",
      "./selected-runtime.js",
      "./storage.js",
      "zod"
    ]
  ],
  ["packages/core/src/selected-runtime.ts", ["./identifiers.js"]],
  ["packages/storage/src/legacy-session-repository.ts", ["better-sqlite3"]],
  ["packages/cli/src/legacy-session-admin.ts", ["./errors.js", "@hostdeck/storage", "node:fs"]]
]);

const cliLocalStorageOwners = new Map([
  [
    "packages/cli/src/legacy-session-admin.ts",
    {
      modules: ["./errors.js", "@hostdeck/storage", "node:fs"],
      storageSymbols: [
        "HostDeckLocalPathError",
        "createLegacySessionRepository",
        "openMigratedDatabase",
        "openSecureHostDeckRegularFile",
        "prepareHostDeckStatePaths"
      ]
    }
  ],
  [
    "packages/cli/src/local-device-list.ts",
    {
      modules: ["./errors.js", "@hostdeck/contracts", "@hostdeck/storage"],
      storageSymbols: [
        "HostDeckAuthRepositoryError",
        "HostDeckLocalPathError",
        "HostDeckMigrationError",
        "createDeviceListingRepository",
        "openExistingHostDeckReadOnlyDatabase"
      ]
    }
  ]
]);

const legacyTokenPattern = /\b(?:bind_host|bind_mode|certificate(?:s|_[A-Za-z0-9_]+)?|lan|lan_configure|lan_disable|lan_enable|lan_enabled|raw_input|selected_lan_configuration|tmux_error|unsupported_slash)\b/giu;
const forbiddenLegacySymbolPattern = /\b(?:createLegacyPairingCodeRepository|createLocalAdmin|revokeLegacy|rotateCsrfBootstrap|setLanEnabled)\b/gu;
const forbiddenTmuxInvocationPattern = /\b(?:execFile|execFileSync|spawn|spawnSync)\s*\([\s\S]{0,160}?["'`]tmux["'`]/gu;

export function validateSelectedRuntimeBoundary(root = process.cwd()) {
  const repositoryRoot = resolve(root);
  const failures = [];

  for (const path of removedPaths) {
    if (existsSync(join(repositoryRoot, path))) failures.push(`removed path exists: ${path}`);
  }
  if (existsSync(join(repositoryRoot, "packages/tmux-adapter"))) {
    failures.push("packages/tmux-adapter must not exist as a directory");
  }

  const manifests = readWorkspaceManifests(repositoryRoot, failures);
  for (const { path, value } of manifests) {
    for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const dependency of forbiddenDependencies) {
        if (value[section]?.[dependency] !== undefined) {
          failures.push(`${path} ${section} retains ${dependency}`);
        }
      }
    }
    if (path === "packages/cli/package.json") {
      if (!isExactSelectedCliBin(value.bin)) {
        failures.push(`${path} must declare only codexdeck -> ./src/shell.ts`);
      }
    } else if (path.startsWith("packages/") && value.bin !== undefined) {
      failures.push(`${path} declares an unselected workspace command`);
    }
  }

  const rootPackage = manifests.find(({ path }) => path === "package.json")?.value;
  if (rootPackage !== undefined) validateRootScripts(rootPackage, failures);
  validateLockfile(repositoryRoot, failures);

  for (const [path, expected] of exactRootModules) {
    const source = readRequiredSource(repositoryRoot, path, failures);
    if (source !== null) {
      failures.push(...compareExactModuleSet(path, collectModuleSpecifiers(source), expected));
    }
  }
  for (const entry of selectedRootEntries) {
    const source = readRequiredSource(repositoryRoot, entry, failures);
    if (source === null) continue;
    for (const specifier of collectModuleSpecifiers(source)) {
      if (forbiddenRootModules.has(specifier)) {
        failures.push(`${entry} exports forbidden module ${specifier}`);
      }
    }
  }

  validateSelectedModes(repositoryRoot, failures);
  validateListenerBoundary(repositoryRoot, failures);
  validateCliBoundary(repositoryRoot, failures);
  validateHistoricalExceptions(repositoryRoot, failures);

  const productionSources = sourceFiles(join(repositoryRoot, "packages"))
    .filter((path) => !isTestFile(path));
  for (const absolutePath of productionSources) {
    const path = repositoryPath(repositoryRoot, absolutePath);
    const source = readFileSync(absolutePath, "utf8");
    for (const token of findLegacyInterfaceTokens(path, source)) {
      failures.push(`${path} contains non-allowlisted legacy token ${JSON.stringify(token)}`);
    }
    if (source.includes("@hostdeck/tmux-adapter")) {
      failures.push(`${path} imports the retired tmux adapter`);
    }
    if (forbiddenTmuxInvocationPattern.test(source)) {
      failures.push(`${path} invokes tmux from production source`);
    }
    forbiddenTmuxInvocationPattern.lastIndex = 0;
    for (const symbol of uniqueMatches(source, forbiddenLegacySymbolPattern)) {
      failures.push(`${path} contains retired production symbol ${symbol}`);
    }
  }

  const closure = buildProductionClosure(repositoryRoot, failures);
  for (const path of closure.files) {
    const source = readFileSync(join(repositoryRoot, path), "utf8");
    if (path !== "packages/storage/src/migrations.ts" && /\btmux\b/iu.test(source)) {
      failures.push(`${path} brings tmux into production-root closure`);
    }
  }

  if (!existsSync(join(repositoryRoot, "packages/storage/src/legacy-session-repository.ts"))) {
    failures.push("bounded legacy session repository is missing");
  }
  const storageRoot = readRequiredSource(repositoryRoot, "packages/storage/src/index.ts", failures);
  if (storageRoot !== null && !collectModuleSpecifiers(storageRoot).includes("./legacy-session-repository.js")) {
    failures.push("@hostdeck/storage must retain the bounded legacy session repository export");
  }

  return Object.freeze({
    failures: Object.freeze([...new Set(failures)].sort()),
    closureFiles: Object.freeze([...closure.files].sort()),
    externalModules: Object.freeze([...closure.externalModules].sort())
  });
}

export function isExactSelectedCliBin(candidate) {
  return (
    candidate !== null &&
    typeof candidate === "object" &&
    !Array.isArray(candidate) &&
    Object.getPrototypeOf(candidate) === Object.prototype &&
    Object.keys(candidate).length === 1 &&
    candidate.codexdeck === "./src/shell.ts"
  );
}

export function collectModuleSpecifiers(source) {
  const tokens = scanTokens(source);
  const specifiers = new Set();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === SyntaxKind.FromKeyword && tokens[index + 1]?.kind === SyntaxKind.StringLiteral) {
      specifiers.add(tokens[index + 1].value);
      continue;
    }
    if (token.kind !== SyntaxKind.ImportKeyword) continue;
    const next = tokens[index + 1];
    if (next?.kind === SyntaxKind.StringLiteral) {
      specifiers.add(next.value);
    } else if (next?.kind === SyntaxKind.OpenParenToken && tokens[index + 2]?.kind === SyntaxKind.StringLiteral) {
      specifiers.add(tokens[index + 2].value);
    }
  }
  return [...specifiers].sort();
}

export function compareExactModuleSet(label, actual, expected) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const failures = [];
  for (const specifier of expectedSet) {
    if (!actualSet.has(specifier)) failures.push(`${label} is missing selected root module ${specifier}`);
  }
  for (const specifier of actualSet) {
    if (!expectedSet.has(specifier)) failures.push(`${label} exposes unexpected root module ${specifier}`);
  }
  return failures;
}

export function findLegacyInterfaceTokens(path, source) {
  if (historicalTokenPaths.has(path)) return [];
  return uniqueMatches(source, legacyTokenPattern);
}

export function readConstStringArray(source, name) {
  const tokens = scanTokens(source);
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].kind !== SyntaxKind.Identifier || tokens[index].value !== name) continue;
    if (!tokens.slice(Math.max(0, index - 3), index).some((token) => token.kind === SyntaxKind.ConstKeyword)) continue;
    if (tokens[index + 1]?.kind !== SyntaxKind.EqualsToken || tokens[index + 2]?.kind !== SyntaxKind.OpenBracketToken) {
      return null;
    }
    const values = [];
    let cursor = index + 3;
    let expectValue = true;
    while (cursor < tokens.length && tokens[cursor].kind !== SyntaxKind.CloseBracketToken) {
      const token = tokens[cursor];
      if (expectValue && token.kind === SyntaxKind.StringLiteral) {
        values.push(token.value);
        expectValue = false;
      } else if (!expectValue && token.kind === SyntaxKind.CommaToken) {
        expectValue = true;
      } else {
        return null;
      }
      cursor += 1;
    }
    return tokens[cursor]?.kind === SyntaxKind.CloseBracketToken ? values : null;
  }
  return null;
}

export function readInterfacePropertyNames(source, name) {
  const tokens = scanTokens(source);
  for (let index = 0; index < tokens.length - 2; index += 1) {
    if (
      tokens[index].kind !== SyntaxKind.InterfaceKeyword ||
      tokens[index + 1].kind !== SyntaxKind.Identifier ||
      tokens[index + 1].value !== name
    ) {
      continue;
    }
    const openIndex = tokens.findIndex((token, candidate) => candidate > index + 1 && token.kind === SyntaxKind.OpenBraceToken);
    if (openIndex < 0) return null;
    const properties = [];
    let braceDepth = 1;
    let segment = [];
    for (let cursor = openIndex + 1; cursor < tokens.length; cursor += 1) {
      const token = tokens[cursor];
      if (token.kind === SyntaxKind.OpenBraceToken) braceDepth += 1;
      if (token.kind === SyntaxKind.CloseBraceToken) braceDepth -= 1;
      if ((token.kind === SyntaxKind.SemicolonToken && braceDepth === 1) || braceDepth === 0) {
        if (segment.length > 0) {
          const property = interfacePropertyName(segment);
          if (property === null) return null;
          properties.push(property);
          segment = [];
        }
        if (braceDepth === 0) return properties;
        continue;
      }
      if (braceDepth === 1) segment.push(token);
    }
    return null;
  }
  return null;
}

function validateRootScripts(rootPackage, failures) {
  const scripts = rootPackage.scripts ?? {};
  for (const script of forbiddenScripts) {
    if (scripts[script] !== undefined) failures.push(`package.json retains forbidden script ${script}`);
  }
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== "string") continue;
    for (const fragment of forbiddenScriptFragments) {
      if (command.includes(fragment)) failures.push(`package.json script ${name} retains ${fragment}`);
    }
  }
  const expectedWebTest =
    "vitest run packages/web/src/app-shell.test.tsx packages/web/src/csrf-client.test.ts packages/web/src/http-client.test.ts packages/web/src/pairing-bootstrap.test.ts packages/web/src/sse-client.test.ts packages/test-fixtures/src/fixtures.test.ts";
  if (scripts["test:web"] !== expectedWebTest) {
    failures.push(
      "package.json test:web must run only selected shell, CSRF, HTTP, pairing, SSE, and fixture tests"
    );
  }
}

function validateLockfile(root, failures) {
  const path = join(root, "pnpm-lock.yaml");
  if (!existsSync(path)) {
    failures.push("pnpm-lock.yaml is missing");
    return;
  }
  const lockfile = readFileSync(path, "utf8");
  for (const dependency of forbiddenDependencies) {
    if (lockfile.includes(dependency)) failures.push(`pnpm-lock.yaml retains ${dependency}`);
  }
  if (lockfile.includes("packages/tmux-adapter")) {
    failures.push("pnpm-lock.yaml retains packages/tmux-adapter");
  }
}

function validateSelectedModes(root, failures) {
  const path = "packages/contracts/src/request-authentication.ts";
  const source = readRequiredSource(root, path, failures);
  if (source === null) return;
  const modes = readConstStringArray(source, "selectedRequestNetworkModes");
  if (JSON.stringify(modes) !== JSON.stringify(["loopback", "remote"])) {
    failures.push(`${path} selectedRequestNetworkModes must be exactly loopback and remote`);
  }
}

function validateListenerBoundary(root, failures) {
  const path = "packages/server/src/fastify-host-lifecycle.ts";
  const source = readRequiredSource(root, path, failures);
  if (source === null) return;
  if (JSON.stringify(readConstStringArray(source, "bindKeys")) !== JSON.stringify(["host", "port", "transport"])) {
    failures.push(`${path} bindKeys must be exactly host, port, and transport`);
  }
  for (const required of [
    'readonly host: "127.0.0.1"',
    'readonly transport: "http"',
    'value.host !== "127.0.0.1"',
    'value.transport !== "http"'
  ]) {
    if (!source.includes(required)) failures.push(`${path} is missing listener invariant ${required}`);
  }
  if (/\b(?:cert|certificate|https|privateKey|tls)\b/iu.test(source)) {
    failures.push(`${path} contains retired TLS listener material`);
  }
  const appPath = "packages/server/src/fastify-app.ts";
  const appSource = readRequiredSource(root, appPath, failures);
  if (appSource !== null && /\b(?:cert|certificate|https|privateKey|tls)\b/iu.test(appSource)) {
    failures.push(`${appPath} contains retired TLS server material`);
  }
}

function validateCliBoundary(root, failures) {
  const configPath = "packages/cli/src/config.ts";
  const config = readRequiredSource(root, configPath, failures);
  if (config !== null) {
    const expectedFlags = ["apiUrl", "port", "configPath", "stateDir", "databasePath"];
    if (JSON.stringify(readInterfacePropertyNames(config, "CliConfigFlags")) !== JSON.stringify(expectedFlags)) {
      failures.push(`${configPath} CliConfigFlags drifted from the selected loopback-only fields`);
    }
    const expectedRawKeys = ["api_url", "apiUrl", "port", "state_dir", "stateDir", "database_path", "databasePath"];
    if (JSON.stringify(readConstStringArray(config, "rawConfigKeys")) !== JSON.stringify(expectedRawKeys)) {
      failures.push(`${configPath} rawConfigKeys drifted from the selected loopback-only fields`);
    }
    for (const required of ['Object.hasOwn(flags, "host")', "env.HOSTDECK_HOST !== undefined", "hostDeckLoopbackOriginSchema.safeParse(value)"]) {
      if (!config.includes(required)) failures.push(`${configPath} is missing config rejection ${required}`);
    }
  }

  const cliRoot = join(root, "packages/cli/src");
  for (const absolutePath of sourceFiles(cliRoot).filter((path) => !isTestFile(path))) {
    const path = repositoryPath(root, absolutePath);
    const source = readFileSync(absolutePath, "utf8");
    if (path !== configPath && /HOSTDECK_HOST|--host/gu.test(source)) {
      failures.push(`${path} exposes retired arbitrary-host configuration`);
    }
    failures.push(...findCliLocalStorageBoundaryViolations(path, source));
  }
}

export function findCliLocalStorageBoundaryViolations(path, source) {
  const touchesStorage = /@hostdeck\/storage|better-sqlite3|openMigratedDatabase|createLegacySessionRepository|createPairingCodeRepository|createSettingsRepository/gu.test(
    source
  );
  if (!touchesStorage) return [];
  const owner = cliLocalStorageOwners.get(path);
  if (owner === undefined) {
    return [`${path} crosses the CLI local-storage administration boundary`];
  }

  const failures = compareExactModuleSet(
    `${path} local-storage owner`,
    collectModuleSpecifiers(source),
    owner.modules
  );
  const storageSymbols = readNamedImportNames(source, "@hostdeck/storage");
  if (
    storageSymbols === null ||
    JSON.stringify(storageSymbols) !== JSON.stringify(owner.storageSymbols)
  ) {
    failures.push(`${path} local-storage imports drifted from its exact owner symbols`);
  }
  return failures;
}

export function readNamedImportNames(source, moduleSpecifier) {
  const escapedSpecifier = moduleSpecifier.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(
    `import\\s*\\{([^{};]*)\\}\\s*from\\s*["']${escapedSpecifier}["']\\s*;`,
    "gu"
  );
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1 || matches[0]?.[1] === undefined) return null;
  const names = matches[0][1].split(",").map((segment) => {
    const normalized = segment.trim().replace(/^type\s+/u, "");
    const [name, alias, extra] = normalized.split(/\s+as\s+/u);
    if (
      name === undefined ||
      extra !== undefined ||
      !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name) ||
      (alias !== undefined && !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(alias))
    ) {
      return null;
    }
    return name;
  });
  if (names.some((name) => name === null)) return null;
  return [...new Set(names)].sort();
}

function validateHistoricalExceptions(root, failures) {
  for (const [path, expectedImports] of historicalExceptionImports) {
    const source = readRequiredSource(root, path, failures);
    if (source === null) continue;
    failures.push(...compareExactModuleSet(`${path} historical exception`, collectModuleSpecifiers(source), expectedImports));
    if (/\b(?:fetch|fork|spawn|spawnSync|execFile|execFileSync)\s*\(/gu.test(source) || /\bprocess\./gu.test(source)) {
      failures.push(`${path} historical exception gained process or network behavior`);
    }
    if (/\b(?:fallback|selectBackend|selectTransport)\b/giu.test(source)) {
      failures.push(`${path} historical exception gained a fallback selector`);
    }
  }
}

function buildProductionClosure(root, failures) {
  const workspacePackages = readWorkspacePackageMap(root, failures);
  const pending = [...productionPackageRootEntries];
  const files = new Set();
  const externalModules = new Set();

  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || files.has(path)) continue;
    const absolutePath = join(root, path);
    if (!existsSync(absolutePath)) {
      failures.push(`production closure is missing ${path}`);
      continue;
    }
    files.add(path);
    const source = readFileSync(absolutePath, "utf8");
    try {
      if (hasNonLiteralDynamicImport(source)) {
        failures.push(`${path} contains a non-literal dynamic import that escapes static closure inspection`);
      }
    } catch (error) {
      throw new Error(`Unable to scan production closure source ${path}.`, { cause: error });
    }
    for (const specifier of collectModuleSpecifiers(source)) {
      const resolved = resolveSourceModule(root, path, specifier, workspacePackages);
      if (resolved.kind === "source") {
        pending.push(resolved.path);
      } else if (resolved.kind === "external") {
        externalModules.add(specifier);
      } else {
        failures.push(`${path} has unresolved source import ${specifier}`);
      }
    }
  }

  return { files, externalModules };
}

function resolveSourceModule(root, fromPath, specifier, workspacePackages) {
  if (specifier.startsWith(".")) {
    const target = resolve(dirname(join(root, fromPath)), specifier);
    const resolvedPath = resolveSourcePath(target);
    return resolvedPath === null
      ? { kind: "unresolved" }
      : { kind: "source", path: repositoryPath(root, resolvedPath) };
  }

  const workspacePackage = [...workspacePackages.entries()]
    .sort(([left], [right]) => right.length - left.length)
    .find(([name]) => specifier === name || specifier.startsWith(`${name}/`));
  if (workspacePackage === undefined) {
    return specifier.startsWith("@hostdeck/") ? { kind: "unresolved" } : { kind: "external" };
  }

  const [name, packageInfo] = workspacePackage;
  const subpath = specifier === name ? "." : `./${specifier.slice(name.length + 1)}`;
  const target = packageExportTarget(packageInfo.manifest, subpath);
  if (target === null) return { kind: "unresolved" };
  const resolvedPath = resolveSourcePath(resolve(root, packageInfo.directory, target));
  return resolvedPath === null
    ? { kind: "unresolved" }
    : { kind: "source", path: repositoryPath(root, resolvedPath) };
}

function resolveSourcePath(target) {
  const candidates = [target];
  if (extname(target) === ".js") {
    candidates.push(`${target.slice(0, -3)}.ts`, `${target.slice(0, -3)}.tsx`);
  }
  if (extname(target) === "") {
    candidates.push(
      `${target}.ts`,
      `${target}.tsx`,
      join(target, "index.ts"),
      join(target, "index.tsx")
    );
  }
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function packageExportTarget(manifest, subpath) {
  const exports = manifest.exports;
  let entry = null;
  if (typeof exports === "string" && subpath === ".") entry = exports;
  else if (exports !== null && typeof exports === "object") {
    entry = exports[subpath] ?? (subpath === "." && !Object.hasOwn(exports, ".") ? exports : null);
  }
  if (typeof entry === "string") return entry;
  if (entry !== null && typeof entry === "object") {
    for (const condition of ["types", "import", "default"]) {
      if (typeof entry[condition] === "string") return entry[condition];
    }
  }
  return subpath === "." && typeof manifest.types === "string" ? manifest.types : null;
}

function readWorkspaceManifests(root, failures) {
  const paths = ["package.json"];
  const packagesRoot = join(root, "packages");
  if (existsSync(packagesRoot)) {
    for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(packagesRoot, entry.name, "package.json"))) {
        paths.push(`packages/${entry.name}/package.json`);
      }
    }
  }
  return paths.flatMap((path) => {
    try {
      return [{ path, value: JSON.parse(readFileSync(join(root, path), "utf8")) }];
    } catch {
      failures.push(`${path} is missing or invalid JSON`);
      return [];
    }
  });
}

function readWorkspacePackageMap(root, failures) {
  const result = new Map();
  for (const { path, value } of readWorkspaceManifests(root, failures)) {
    if (path === "package.json" || typeof value.name !== "string") continue;
    result.set(value.name, { directory: dirname(path), manifest: value });
  }
  return result;
}

function readRequiredSource(root, path, failures) {
  const absolutePath = join(root, path);
  if (!existsSync(absolutePath)) {
    failures.push(`required boundary source is missing: ${path}`);
    return null;
  }
  return readFileSync(absolutePath, "utf8");
}

function sourceFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (
      entry.isFile() &&
      (path.endsWith(".ts") || path.endsWith(".tsx")) &&
      !path.endsWith(".d.ts")
    ) {
      files.push(path);
    }
  }
  return files;
}

function isTestFile(path) {
  return /(?:^|\.)(?:contract\.|integration\.|probe\.|smoke\.)?(?:test|spec)\.tsx?$/u.test(path);
}

function hasNonLiteralDynamicImport(source) {
  const tokens = scanTokens(source);
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].kind !== SyntaxKind.ImportKeyword || tokens[index + 1]?.kind !== SyntaxKind.OpenParenToken) continue;
    if (tokens[index + 2]?.kind !== SyntaxKind.StringLiteral || tokens[index + 3]?.kind !== SyntaxKind.CloseParenToken) {
      return true;
    }
  }
  return false;
}

function scanTokens(source) {
  const scanner = createScanner(true, LanguageVariant.Standard, source);
  const tokens = [];
  const maximumTokens = source.length * 2 + 100;
  const templateBraceDepths = [];
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    pushScannedToken(tokens, scanner, kind, maximumTokens);
    if (scanner.getTokenEnd() <= scanner.getTokenStart()) {
      scanner.resetTokenState(Math.min(source.length, scanner.getTokenStart() + 1));
    }
    if (kind === SyntaxKind.TemplateHead) {
      templateBraceDepths.push(0);
      continue;
    }
    if (templateBraceDepths.length === 0) continue;
    const activeIndex = templateBraceDepths.length - 1;
    if (kind === SyntaxKind.OpenBraceToken) {
      templateBraceDepths[activeIndex] += 1;
    } else if (kind === SyntaxKind.CloseBraceToken && templateBraceDepths[activeIndex] > 0) {
      templateBraceDepths[activeIndex] -= 1;
    } else if (kind === SyntaxKind.CloseBraceToken) {
      const templateKind = scanner.reScanTemplateToken(false);
      pushScannedToken(tokens, scanner, templateKind, maximumTokens);
      if (templateKind === SyntaxKind.TemplateTail) templateBraceDepths.pop();
    }
  }
  return tokens;
}

function pushScannedToken(tokens, scanner, kind, maximumTokens) {
  tokens.push({ kind, text: scanner.getTokenText(), value: scanner.getTokenValue() });
  if (tokens.length > maximumTokens) {
    const tail = tokens.slice(-6).map((token) => `${token.kind}:${JSON.stringify(token.text)}`).join(", ");
    throw new Error(`TypeScript boundary scanner exceeded its token budget near offset ${scanner.getTokenStart()} after ${tail}.`);
  }
}

function interfacePropertyName(segment) {
  const tokens = segment.filter((token) => token.kind !== SyntaxKind.ReadonlyKeyword);
  const name = tokens[0];
  if (name === undefined || (name.kind !== SyntaxKind.Identifier && name.kind !== SyntaxKind.StringLiteral)) return null;
  const separator = tokens[1]?.kind === SyntaxKind.QuestionToken ? tokens[2] : tokens[1];
  if (separator?.kind !== SyntaxKind.ColonToken) return null;
  return name.value;
}

function uniqueMatches(source, pattern) {
  pattern.lastIndex = 0;
  const matches = [...source.matchAll(pattern)].map((match) => match[0]);
  pattern.lastIndex = 0;
  return [...new Set(matches)].sort();
}

function repositoryPath(root, absolutePath) {
  return relative(root, absolutePath).split(sep).join("/");
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const result = validateSelectedRuntimeBoundary();
  if (result.failures.length > 0) {
    throw new Error(`Selected runtime boundary failed:\n- ${result.failures.join("\n- ")}`);
  }
  console.log(
    `Selected runtime boundary OK: ${result.closureFiles.length} production source modules, ${result.externalModules.length} external modules.`
  );
}
