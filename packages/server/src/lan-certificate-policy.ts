import "reflect-metadata";

import { Buffer } from "node:buffer";
import {
  createPrivateKey,
  X509Certificate as NodeX509Certificate, 
  randomBytes
} from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { SocketAddress } from "node:net";
import { basename, join, resolve } from "node:path";
import {
  canonicalIpHost,
  lanOrigin,
  type SelectedLanCertificateState
} from "@hostdeck/contracts";
import {
  type HostDeckLanCertificateDescriptor,
  openSecureHostDeckRegularFile,
  secureHostDeckRegularFile
} from "@hostdeck/storage";
import {
  AuthorityKeyIdentifierExtension,
  BasicConstraintsExtension,
  cryptoProvider,
  ExtendedKeyUsage,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectAlternativeNameExtension,
  SubjectKeyIdentifierExtension,
  X509Certificate,
  X509CertificateGenerator
} from "@peculiar/x509";

const dayMs = 24 * 60 * 60 * 1_000;
const clockSkewMs = 5 * 60 * 1_000;
const rootValidityMs = 3_650 * dayMs;
const leafValidityMs = 397 * dayMs;
const renewalThresholdMs = 30 * dayMs;
const maximumCertificateFileBytes = 32_768;
const rsaAlgorithm = Object.freeze({
  hash: "SHA-256",
  modulusLength: 2_048,
  name: "RSASSA-PKCS1-v1_5",
  publicExponent: new Uint8Array([1, 0, 1])
});
const signingAlgorithm = Object.freeze({
  name: "RSASSA-PKCS1-v1_5",
  hash: "SHA-256"
});
const policyInputKeys = ["assignedAddresses", "certificateDirectory", "now"] as const;
const configureInputKeys = ["bind_host", "bind_port", "certificate_action"] as const;
const inspectInputKeys = ["bind_host", "bind_port"] as const;
const fileNames = Object.freeze({
  rootCertificate: "hostdeck-local-ca.pem",
  rootPrivateKey: "hostdeck-local-ca-key.pem",
  leafCertificate: "hostdeck-lan.pem",
  leafPrivateKey: "hostdeck-lan-key.pem"
});

cryptoProvider.set(globalThis.crypto);

export type HostDeckLanCertificateErrorCode =
  | "address_unavailable"
  | "certificate_invalid"
  | "certificate_missing"
  | "certificate_not_valid"
  | "certificate_partial"
  | "certificate_publish_failed"
  | "certificate_unavailable"
  | "invalid_certificate_input";

export class HostDeckLanCertificateError extends Error {
  constructor(
    readonly code: HostDeckLanCertificateErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostDeckLanCertificateError";
  }
}

export interface CreateHostDeckLanCertificatePolicyInput {
  readonly assignedAddresses: () => readonly string[];
  readonly certificateDirectory: string;
  readonly now: () => Date;
}

export interface ConfigureHostDeckLanCertificateInput {
  readonly bind_host: string;
  readonly bind_port: number;
  readonly certificate_action: "reuse" | "issue_leaf";
}

export interface InspectHostDeckLanCertificateInput {
  readonly bind_host: string;
  readonly bind_port: number;
}

export interface HostDeckLanCertificateInspection
  extends HostDeckLanCertificateDescriptor {
  readonly certificate_state: Exclude<
    SelectedLanCertificateState,
    "not_configured" | "unavailable"
  >;
  readonly enrollment_available: true;
}

export interface HostDeckLanTlsMaterial {
  readonly certificate_chain_pem: string;
  readonly private_key_pem: string;
}

export interface HostDeckLanTlsInput {
  readonly inspection: HostDeckLanCertificateInspection;
  readonly tls: HostDeckLanTlsMaterial;
}

export interface HostDeckLanEnrollment {
  readonly certificate_der: Uint8Array;
  readonly fingerprint_sha256: string;
  readonly host: string;
  readonly media_type: "application/x-x509-ca-cert";
}

export interface HostDeckLanCertificatePolicySnapshot {
  readonly configurations: number;
  readonly enrollment_reads: number;
  readonly inspections: number;
  readonly leaf_issues: number;
  readonly root_issues: number;
  readonly tls_loads: number;
}

export interface HostDeckLanCertificatePolicy {
  readonly configure: (
    input: ConfigureHostDeckLanCertificateInput
  ) => Promise<HostDeckLanCertificateInspection>;
  readonly enrollment: (
    input: InspectHostDeckLanCertificateInput
  ) => HostDeckLanEnrollment;
  readonly inspect: (
    input: InspectHostDeckLanCertificateInput
  ) => HostDeckLanCertificateInspection;
  readonly loadTls: (
    input: InspectHostDeckLanCertificateInput
  ) => HostDeckLanTlsInput;
  readonly snapshot: () => HostDeckLanCertificatePolicySnapshot;
}

interface MutableCounters {
  configurations: number;
  enrollmentReads: number;
  inspections: number;
  leafIssues: number;
  rootIssues: number;
  tlsLoads: number;
}

interface CertificatePaths {
  readonly rootCertificate: string;
  readonly rootPrivateKey: string;
  readonly leafCertificate: string;
  readonly leafPrivateKey: string;
}

interface CertificateSet {
  readonly authority: AuthorityMaterial;
  readonly leaf: LoadedLeafMaterial;
}

interface AuthorityMaterial {
  readonly certificate: X509Certificate;
  readonly certificatePem: string;
  readonly keys: CryptoKeyPair;
  readonly privateKeyPem: string;
}

interface GeneratedLeafMaterial {
  readonly certificate: X509Certificate;
  readonly certificatePem: string;
  readonly privateKeyPem: string;
}

interface LoadedLeafMaterial extends GeneratedLeafMaterial {
  readonly nodeCertificate: NodeX509Certificate;
}

interface ParsedPolicyInput {
  readonly assignedAddresses: () => readonly string[];
  readonly certificateDirectory: string;
  readonly now: () => Date;
}

const acceptedPolicies = new WeakSet<object>();
const maxCounter = Number.MAX_SAFE_INTEGER;

export function createHostDeckLanCertificatePolicy(
  input: CreateHostDeckLanCertificatePolicyInput
): HostDeckLanCertificatePolicy {
  const parsed = parsePolicyInput(input);
  const paths = certificatePaths(parsed.certificateDirectory);
  const counters: MutableCounters = {
    configurations: 0,
    enrollmentReads: 0,
    inspections: 0,
    leafIssues: 0,
    rootIssues: 0,
    tlsLoads: 0
  };
  const policy: HostDeckLanCertificatePolicy = {
    async configure(input) {
      const request = parseConfigureInput(input);
      const now = readNow(parsed.now);
      const identity = resolveLanCertificateIdentity(
        request.bind_host,
        parsed.assignedAddresses()
      );
      assertCertificateDirectory(parsed.certificateDirectory);
      const presence = certificateSetPresence(paths);
      if (request.certificate_action === "reuse") {
        if (presence === "missing") throw certificateMissing();
        if (presence === "partial") throw certificatePartial();
        const inspection = inspectSet(
          loadCertificateSet(paths),
          identity.address,
          request.bind_port,
          now
        );
        requireUsableInspection(inspection);
        counters.configurations = increment(counters.configurations);
        counters.inspections = increment(counters.inspections);
        return inspection;
      }

      let authority: AuthorityMaterial;
      if (presence === "missing") {
        authority = await generateAuthority(now);
        const leaf = await generateLeaf(authority, identity.address, now);
        publishCertificateFiles(paths, {
          rootCertificate: authority.certificatePem,
          rootPrivateKey: authority.privateKeyPem,
          leafCertificate: leaf.certificatePem,
          leafPrivateKey: leaf.privateKeyPem
        });
        counters.rootIssues = increment(counters.rootIssues);
      } else {
        if (presence === "partial") throw certificatePartial();
        authority = loadCertificateSet(paths).authority;
        requireUsableAuthority(authority, now);
        const leaf = await generateLeaf(authority, identity.address, now);
        publishCertificateFiles(paths, {
          leafCertificate: leaf.certificatePem,
          leafPrivateKey: leaf.privateKeyPem
        });
      }
      counters.leafIssues = increment(counters.leafIssues);
      const inspection = inspectSet(
        loadCertificateSet(paths),
        identity.address,
        request.bind_port,
        now
      );
      requireUsableInspection(inspection);
      counters.configurations = increment(counters.configurations);
      counters.inspections = increment(counters.inspections);
      return inspection;
    },
    enrollment(input) {
      const request = parseInspectInput(input);
      const now = readNow(parsed.now);
      const identity = resolveLanCertificateIdentity(
        request.bind_host,
        parsed.assignedAddresses()
      );
      assertCertificateDirectory(parsed.certificateDirectory);
      const set = loadCompleteCertificateSet(paths);
      const inspection = inspectSet(set, identity.address, request.bind_port, now);
      requireUsableInspection(inspection);
      counters.enrollmentReads = increment(counters.enrollmentReads);
      return Object.freeze({
        certificate_der: new Uint8Array(set.authority.certificate.rawData),
        fingerprint_sha256: inspection.root_fingerprint_sha256,
        host: identity.address,
        media_type: "application/x-x509-ca-cert" as const
      });
    },
    inspect(input) {
      const request = parseInspectInput(input);
      const now = readNow(parsed.now);
      const identity = resolveLanCertificateIdentity(
        request.bind_host,
        parsed.assignedAddresses()
      );
      assertCertificateDirectory(parsed.certificateDirectory);
      const inspection = inspectSet(
        loadCompleteCertificateSet(paths),
        identity.address,
        request.bind_port,
        now
      );
      counters.inspections = increment(counters.inspections);
      return inspection;
    },
    loadTls(input) {
      const request = parseInspectInput(input);
      const now = readNow(parsed.now);
      const identity = resolveLanCertificateIdentity(
        request.bind_host,
        parsed.assignedAddresses()
      );
      assertCertificateDirectory(parsed.certificateDirectory);
      const set = loadCompleteCertificateSet(paths);
      const inspection = inspectSet(set, identity.address, request.bind_port, now);
      requireUsableInspection(inspection);
      counters.tlsLoads = increment(counters.tlsLoads);
      return Object.freeze({
        inspection,
        tls: Object.freeze({
          certificate_chain_pem: `${set.leaf.certificatePem.trim()}\n${set.authority.certificatePem.trim()}\n`,
          private_key_pem: set.leaf.privateKeyPem
        })
      });
    },
    snapshot() {
      return Object.freeze({
        configurations: counters.configurations,
        enrollment_reads: counters.enrollmentReads,
        inspections: counters.inspections,
        leaf_issues: counters.leafIssues,
        root_issues: counters.rootIssues,
        tls_loads: counters.tlsLoads
      });
    }
  };
  acceptedPolicies.add(policy);
  return Object.freeze(policy);
}

export function assertHostDeckLanCertificatePolicy(
  candidate: unknown
): asserts candidate is HostDeckLanCertificatePolicy {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !acceptedPolicies.has(candidate) ||
    !Object.isFrozen(candidate)
  ) {
    throw new TypeError(
      "HostDeck LAN certificate policy must be created by createHostDeckLanCertificatePolicy."
    );
  }
}

function parsePolicyInput(input: unknown): ParsedPolicyInput {
  const value = readExactDataObject(input, policyInputKeys);
  if (
    typeof value.assignedAddresses !== "function" ||
    typeof value.certificateDirectory !== "string" ||
    value.certificateDirectory !== resolve(value.certificateDirectory) ||
    typeof value.now !== "function"
  ) {
    throw invalidInput();
  }
  assertCertificateDirectory(value.certificateDirectory);
  return Object.freeze({
    assignedAddresses: value.assignedAddresses as () => readonly string[],
    certificateDirectory: value.certificateDirectory,
    now: value.now as () => Date
  });
}

function parseConfigureInput(
  input: unknown
): ConfigureHostDeckLanCertificateInput {
  const value = readExactDataObject(input, configureInputKeys);
  const base = parseInspectInput({
    bind_host: value.bind_host,
    bind_port: value.bind_port
  });
  if (
    value.certificate_action !== "reuse" &&
    value.certificate_action !== "issue_leaf"
  ) {
    throw invalidInput();
  }
  return Object.freeze({ ...base, certificate_action: value.certificate_action });
}

function parseInspectInput(input: unknown): InspectHostDeckLanCertificateInput {
  const value = readExactDataObject(input, inspectInputKeys);
  const host =
    typeof value.bind_host === "string"
      ? canonicalIpHost(value.bind_host)
      : null;
  const port = value.bind_port;
  if (
    host === null ||
    typeof port !== "number" ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw invalidInput();
  }
  return Object.freeze({ bind_host: host, bind_port: port });
}

function resolveLanCertificateIdentity(
  input: string,
  assignedAddresses: readonly string[]
): { readonly address: string; readonly family: "ipv4" | "ipv6" } {
  if (!Array.isArray(assignedAddresses) || assignedAddresses.length > 256) {
    throw new HostDeckLanCertificateError(
      "address_unavailable",
      "Host LAN address inventory is unavailable."
    );
  }
  const parsed = parseSocketAddress(input);
  if (parsed === null || !isPrivateLanAddress(parsed)) {
    throw new HostDeckLanCertificateError(
      "address_unavailable",
      "LAN address is not an admitted private host identity."
    );
  }
  const assigned = new Set<string>();
  for (const candidate of assignedAddresses) {
    const canonical = typeof candidate === "string" ? canonicalIpHost(candidate) : null;
    const address = canonical === null ? null : parseSocketAddress(canonical);
    if (address !== null) assigned.add(address.address);
  }
  if (!assigned.has(parsed.address)) {
    throw new HostDeckLanCertificateError(
      "address_unavailable",
      "LAN address is not assigned to this host."
    );
  }
  return Object.freeze({
    address: parsed.address,
    family: parsed.family === "ipv4" ? "ipv4" : "ipv6"
  });
}

function parseSocketAddress(input: string): SocketAddress | null {
  if (canonicalIpHost(input) !== input) return null;
  return SocketAddress.parse(
    input.includes(":") ? `[${input}]:443` : `${input}:443`
  ) ?? null;
}

function isPrivateLanAddress(address: SocketAddress): boolean {
  if (address.family === "ipv4") {
    const octets = address.address.split(".").map(Number);
    const first = octets[0];
    const second = octets[1];
    return (
      first === 10 ||
      (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }
  const firstHextet = Number.parseInt(address.address.split(":", 1)[0] ?? "", 16);
  return Number.isSafeInteger(firstHextet) && (firstHextet & 0xfe00) === 0xfc00;
}

function certificatePaths(directory: string): CertificatePaths {
  return Object.freeze({
    rootCertificate: join(directory, fileNames.rootCertificate),
    rootPrivateKey: join(directory, fileNames.rootPrivateKey),
    leafCertificate: join(directory, fileNames.leafCertificate),
    leafPrivateKey: join(directory, fileNames.leafPrivateKey)
  });
}

function assertCertificateDirectory(directory: string): void {
  try {
    const resolved = resolve(directory);
    const metadata = lstatSync(resolved);
    const uid = process.getuid?.();
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      typeof uid !== "number" ||
      metadata.uid !== uid ||
      (metadata.mode & 0o777) !== 0o700 ||
      realpathSync(resolved) !== resolved
    ) {
      throw new TypeError();
    }
  } catch (error) {
    throw new HostDeckLanCertificateError(
      "certificate_unavailable",
      "LAN certificate directory is unavailable.",
      { cause: error }
    );
  }
}

function certificateSetPresence(paths: CertificatePaths): "complete" | "missing" | "partial" {
  const present = Object.values(paths).map((path) => existsSync(path));
  if (present.every((value) => value)) return "complete";
  if (present.every((value) => !value)) return "missing";
  return "partial";
}

function loadCompleteCertificateSet(paths: CertificatePaths): CertificateSet {
  const presence = certificateSetPresence(paths);
  if (presence === "missing") throw certificateMissing();
  if (presence === "partial") throw certificatePartial();
  return loadCertificateSet(paths);
}

function loadCertificateSet(paths: CertificatePaths): CertificateSet {
  try {
    const rootCertificatePem = readSecureText(paths.rootCertificate, "LAN root certificate");
    const rootPrivateKeyPem = readSecureText(paths.rootPrivateKey, "LAN root private key");
    const leafCertificatePem = readSecureText(paths.leafCertificate, "LAN leaf certificate");
    const leafPrivateKeyPem = readSecureText(paths.leafPrivateKey, "LAN leaf private key");
    const rootNode = new NodeX509Certificate(rootCertificatePem);
    const leafNode = new NodeX509Certificate(leafCertificatePem);
    const rootCertificate = new X509Certificate(rootCertificatePem);
    const leafCertificate = new X509Certificate(leafCertificatePem);
    if (
      !rootNode.ca ||
      leafNode.ca ||
      !rootNode.verify(rootNode.publicKey) ||
      !leafNode.verify(rootNode.publicKey) ||
      !leafNode.checkIssued(rootNode) ||
      !rootNode.checkPrivateKey(createPrivateKey(rootPrivateKeyPem)) ||
      !leafNode.checkPrivateKey(createPrivateKey(leafPrivateKeyPem))
    ) {
      throw new TypeError();
    }
    assertRootExtensions(rootCertificate);
    assertLeafExtensions(leafCertificate);
    const authority: AuthorityMaterial = Object.freeze({
      certificate: rootCertificate,
      certificatePem: rootCertificatePem,
      keys: Object.freeze({
        privateKey: importPrivateKey(rootPrivateKeyPem),
        publicKey: importPublicKey(rootNode)
      }),
      privateKeyPem: rootPrivateKeyPem
    });
    const leaf: LoadedLeafMaterial = Object.freeze({
      certificate: leafCertificate,
      certificatePem: leafCertificatePem,
      privateKeyPem: leafPrivateKeyPem,
      nodeCertificate: leafNode
    });
    return Object.freeze({ authority, leaf });
  } catch (error) {
    if (error instanceof HostDeckLanCertificateError) throw error;
    throw new HostDeckLanCertificateError(
      "certificate_invalid",
      "LAN certificate material is invalid.",
      { cause: error }
    );
  }
}

function inspectSet(
  set: CertificateSet,
  host: string,
  port: number,
  now: Date
): HostDeckLanCertificateInspection {
  requireUsableAuthority(set.authority, now);
  const state = leafCertificateState(set.leaf.nodeCertificate, host, now);
  return Object.freeze({
    bind_host: host,
    address_family: host.includes(":") ? "ipv6" : "ipv4",
    bind_port: port,
    configured_origin: lanOrigin(host, port),
    root_fingerprint_sha256: normalizedFingerprint(
      new NodeX509Certificate(set.authority.certificatePem)
    ),
    leaf_fingerprint_sha256: normalizedFingerprint(set.leaf.nodeCertificate),
    leaf_valid_from: set.leaf.nodeCertificate.validFromDate.toISOString(),
    leaf_expires_at: set.leaf.nodeCertificate.validToDate.toISOString(),
    certificate_state: state,
    enrollment_available: true
  });
}

function requireUsableAuthority(authority: AuthorityMaterial, now: Date): void {
  const certificate = new NodeX509Certificate(authority.certificatePem);
  const time = now.getTime();
  if (
    time < certificate.validFromDate.getTime() ||
    time > certificate.validToDate.getTime()
  ) {
    throw new HostDeckLanCertificateError(
      "certificate_not_valid",
      "LAN root certificate is outside its validity period."
    );
  }
}

function requireUsableInspection(inspection: HostDeckLanCertificateInspection): void {
  if (
    inspection.certificate_state !== "valid" &&
    inspection.certificate_state !== "renewal_due"
  ) {
    throw new HostDeckLanCertificateError(
      "certificate_not_valid",
      "LAN leaf certificate is not valid for the selected host."
    );
  }
}

async function generateAuthority(now: Date): Promise<AuthorityMaterial> {
  try {
    const keys = await generateRsaKeys();
    const certificate = await X509CertificateGenerator.createSelfSigned({
      extensions: [
        new BasicConstraintsExtension(true, 0, true),
        new KeyUsagesExtension(
          KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign,
          true
        ),
        await SubjectKeyIdentifierExtension.create(keys.publicKey)
      ],
      keys,
      name: "CN=HostDeck Local CA",
      notAfter: new Date(now.getTime() - clockSkewMs + rootValidityMs),
      notBefore: new Date(now.getTime() - clockSkewMs),
      serialNumber: randomSerialNumber(),
      signingAlgorithm
    });
    return Object.freeze({
      certificate,
      certificatePem: certificate.toString("pem"),
      keys,
      privateKeyPem: await exportPrivateKey(keys.privateKey)
    });
  } catch (error) {
    throw new HostDeckLanCertificateError(
      "certificate_unavailable",
      "LAN certificate authority generation failed.",
      { cause: error }
    );
  }
}

async function generateLeaf(
  authority: AuthorityMaterial,
  address: string,
  now: Date
): Promise<GeneratedLeafMaterial> {
  try {
    const keys = await generateRsaKeys();
    const certificate = await X509CertificateGenerator.create({
      extensions: [
        new BasicConstraintsExtension(false, undefined, true),
        new KeyUsagesExtension(
          KeyUsageFlags.digitalSignature | KeyUsageFlags.keyEncipherment,
          true
        ),
        new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth]),
        new SubjectAlternativeNameExtension([{ type: "ip", value: address }]),
        await SubjectKeyIdentifierExtension.create(keys.publicKey),
        await AuthorityKeyIdentifierExtension.create(authority.keys.publicKey)
      ],
      issuer: authority.certificate.subject,
      notAfter: new Date(now.getTime() - clockSkewMs + leafValidityMs),
      notBefore: new Date(now.getTime() - clockSkewMs),
      publicKey: keys.publicKey,
      serialNumber: randomSerialNumber(),
      signingAlgorithm,
      signingKey: authority.keys.privateKey,
      subject: "CN=HostDeck LAN"
    });
    return Object.freeze({
      certificate,
      certificatePem: certificate.toString("pem"),
      privateKeyPem: await exportPrivateKey(keys.privateKey)
    });
  } catch (error) {
    throw new HostDeckLanCertificateError(
      "certificate_unavailable",
      "LAN leaf certificate generation failed.",
      { cause: error }
    );
  }
}

async function generateRsaKeys(): Promise<CryptoKeyPair> {
  return globalThis.crypto.subtle.generateKey(rsaAlgorithm, true, ["sign", "verify"]);
}

async function exportPrivateKey(key: CryptoKey): Promise<string> {
  const der = Buffer.from(await globalThis.crypto.subtle.exportKey("pkcs8", key));
  const body = der.toString("base64").match(/.{1,64}/gu)?.join("\n");
  if (body === undefined) throw new TypeError();
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
}

function importPrivateKey(pem: string): CryptoKey {
  return createPrivateKey(pem).toCryptoKey(
    signingAlgorithm,
    true,
    ["sign"]
  ) as unknown as CryptoKey;
}

function importPublicKey(certificate: NodeX509Certificate): CryptoKey {
  return certificate.publicKey.toCryptoKey(
    signingAlgorithm,
    true,
    ["verify"]
  ) as unknown as CryptoKey;
}

function publishCertificateFiles(
  paths: CertificatePaths,
  files: Partial<Record<keyof CertificatePaths, string>>
): void {
  const temporary: string[] = [];
  try {
    const prepared = Object.entries(files).map(([name, content]) => {
      if (typeof content !== "string" || content.length === 0) throw new TypeError();
      const target = paths[name as keyof CertificatePaths];
      if (existsSync(target)) {
        secureHostDeckRegularFile(target, {
          label: `existing ${basename(target)}`,
          mode: 0o600,
          repair_mode: false
        });
      }
      const path = join(
        resolve(target, ".."),
        `.${basename(target)}.${randomBytes(12).toString("hex")}.tmp`
      );
      writeFileSync(path, content, { flag: "wx", mode: 0o600 });
      temporary.push(path);
      secureHostDeckRegularFile(path, {
        label: `prepared ${basename(target)}`,
        mode: 0o600,
        repair_mode: false
      });
      return { path, target };
    });
    for (const file of prepared) {
      renameSync(file.path, file.target);
      temporary.splice(temporary.indexOf(file.path), 1);
      secureHostDeckRegularFile(file.target, {
        label: `published ${basename(file.target)}`,
        mode: 0o600,
        repair_mode: false
      });
    }
  } catch (error) {
    throw new HostDeckLanCertificateError(
      "certificate_publish_failed",
      "LAN certificate publication failed.",
      { cause: error }
    );
  } finally {
    for (const path of temporary) rmSync(path, { force: true });
  }
}

function readSecureText(path: string, label: string): string {
  const opened = openSecureHostDeckRegularFile(path, {
    label,
    mode: 0o600,
    repair_mode: false
  });
  try {
    const content = readFileSync(opened.descriptor, "utf8");
    opened.verifyPath();
    if (
      Buffer.byteLength(content, "utf8") < 64 ||
      Buffer.byteLength(content, "utf8") > maximumCertificateFileBytes
    ) {
      throw new TypeError();
    }
    return content;
  } finally {
    closeSync(opened.descriptor);
  }
}

function assertRootExtensions(certificate: X509Certificate): void {
  const basic = requireExtension(certificate, BasicConstraintsExtension);
  const usage = requireExtension(certificate, KeyUsagesExtension);
  requireExtension(certificate, SubjectKeyIdentifierExtension);
  if (
    !basic.critical ||
    !basic.ca ||
    basic.pathLength !== 0 ||
    !usage.critical ||
    usage.usages !== (KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign)
  ) {
    throw new TypeError();
  }
}

function assertLeafExtensions(certificate: X509Certificate): void {
  const basic = requireExtension(certificate, BasicConstraintsExtension);
  const usage = requireExtension(certificate, KeyUsagesExtension);
  const extended = requireExtension(certificate, ExtendedKeyUsageExtension);
  const names = requireExtension(certificate, SubjectAlternativeNameExtension);
  requireExtension(certificate, SubjectKeyIdentifierExtension);
  requireExtension(certificate, AuthorityKeyIdentifierExtension);
  const jsonNames = names.names.toJSON();
  if (
    !basic.critical ||
    basic.ca ||
    !usage.critical ||
    usage.usages !==
      (KeyUsageFlags.digitalSignature | KeyUsageFlags.keyEncipherment) ||
    extended.critical ||
    extended.usages.length !== 1 ||
    extended.usages[0] !== ExtendedKeyUsage.serverAuth ||
    jsonNames.length !== 1 ||
    jsonNames[0]?.type !== "ip"
  ) {
    throw new TypeError();
  }
}

function requireExtension<T>(
  certificate: X509Certificate,
  extensionConstructor: abstract new (...args: never[]) => T
): T {
  const extension = certificate.extensions.find(
    (candidate) => candidate instanceof extensionConstructor
  );
  if (extension === undefined) throw new TypeError();
  return extension as T;
}

function leafCertificateState(
  certificate: NodeX509Certificate,
  identity: string,
  now: Date
): Exclude<SelectedLanCertificateState, "not_configured" | "unavailable"> {
  const observedAt = now.getTime();
  if (observedAt < certificate.validFromDate.getTime()) return "not_yet_valid";
  if (observedAt > certificate.validToDate.getTime()) return "expired";
  if (certificate.checkIP(identity) === undefined) return "identity_mismatch";
  if (certificate.validToDate.getTime() - observedAt <= renewalThresholdMs) {
    return "renewal_due";
  }
  return "valid";
}

function normalizedFingerprint(certificate: NodeX509Certificate): string {
  return certificate.fingerprint256.replaceAll(":", "").toLowerCase();
}

function randomSerialNumber(): string {
  const bytes = randomBytes(16);
  bytes[0] = ((bytes[0] ?? 0) & 0x7f) || 1;
  return bytes.toString("hex").toUpperCase();
}

function readNow(now: () => Date): Date {
  let value: unknown;
  try {
    value = now();
  } catch (error) {
    throw new HostDeckLanCertificateError(
      "certificate_unavailable",
      "LAN certificate clock is unavailable.",
      { cause: error }
    );
  }
  if (!(value instanceof Date)) throw invalidInput();
  const time = Date.prototype.getTime.call(value);
  if (!Number.isFinite(time)) throw invalidInput();
  return new Date(time);
}

function readExactDataObject(
  input: unknown,
  expectedKeys: readonly string[]
): Readonly<Record<string, unknown>> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw invalidInput();
  }
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw invalidInput();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => {
      if (typeof key !== "string" || !expectedKeys.includes(key)) return true;
      const descriptor = descriptors[key];
      return descriptor === undefined || !descriptor.enumerable || !("value" in descriptor);
    })
  ) {
    throw invalidInput();
  }
  return Object.freeze(
    Object.fromEntries(keys.map((key) => [key, descriptors[key as string]?.value]))
  );
}

function certificateMissing(): HostDeckLanCertificateError {
  return new HostDeckLanCertificateError(
    "certificate_missing",
    "LAN certificate material has not been configured."
  );
}

function certificatePartial(): HostDeckLanCertificateError {
  return new HostDeckLanCertificateError(
    "certificate_partial",
    "LAN certificate material is incomplete."
  );
}

function invalidInput(): HostDeckLanCertificateError {
  return new HostDeckLanCertificateError(
    "invalid_certificate_input",
    "LAN certificate input is invalid."
  );
}

function increment(value: number): number {
  return value >= maxCounter ? maxCounter : value + 1;
}
