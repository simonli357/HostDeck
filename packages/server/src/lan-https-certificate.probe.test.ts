import "reflect-metadata";

import { spawnSync } from "node:child_process";
import { createPrivateKey, X509Certificate as NodeX509Certificate, randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { get as httpGet } from "node:http";
import { createServer as createHttpsServer, get as httpsGet } from "node:https";
import { SocketAddress } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkServerIdentity } from "node:tls";
import { secureHostDeckRegularFile } from "@hostdeck/storage";
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
  type X509Certificate,
  X509CertificateGenerator
} from "@peculiar/x509";
import { afterEach, describe, expect, it } from "vitest";

const dayMs = 24 * 60 * 60 * 1_000;
const clockSkewMs = 5 * 60 * 1_000;
const rootValidityMs = 3_650 * dayMs;
const leafValidityMs = 397 * dayMs;
const renewalThresholdMs = 30 * dayMs;
const rsaAlgorithm = Object.freeze({
  hash: "SHA-256",
  modulusLength: 2_048,
  name: "RSASSA-PKCS1-v1_5",
  publicExponent: new Uint8Array([1, 0, 1])
});
const signingAlgorithm = Object.freeze({ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" });
const tempDirectories: string[] = [];

cryptoProvider.set(globalThis.crypto);

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("IFC-V1-015 local HTTPS certificate profile", () => {
  it("admits only canonical assigned private IPv4 or ULA identities", () => {
    expect(resolveLanCertificateIdentity("192.168.0.29", ["192.168.0.29"])).toEqual({
      address: "192.168.0.29",
      family: "ipv4",
      host_allowlist: ["192.168.0.29"]
    });
    expect(resolveLanCertificateIdentity("FD00:0:0:0:0:0:0:29", ["fd00::29"])).toEqual({
      address: "fd00::29",
      family: "ipv6",
      host_allowlist: ["[fd00::29]"]
    });

    for (const address of [
      "0.0.0.0",
      "127.0.0.1",
      "169.254.1.1",
      "224.0.0.1",
      "8.8.8.8",
      "::",
      "::1",
      "fe80::1",
      "2607:fa49:4142:2700::1",
      "not-an-address"
    ]) {
      expect(() => resolveLanCertificateIdentity(address, [address]), address).toThrow(
        "HostDeck LAN certificate address"
      );
    }
    expect(() => resolveLanCertificateIdentity("192.168.0.29", ["192.168.0.30"])).toThrow(
      "assigned to this host"
    );
  });

  it("generates an exact mobile-compatible CA and IP leaf profile", async () => {
    const now = new Date("2026-07-11T12:00:00.000Z");
    const authority = await generateAuthority(now);
    const leaf = await generateLeaf(authority, "192.168.0.29", now);
    const rootNode = new NodeX509Certificate(authority.certificatePem);
    const leafNode = new NodeX509Certificate(leaf.certificatePem);

    expect(rootNode.ca).toBe(true);
    expect(leafNode.ca).toBe(false);
    expect(rootNode.verify(rootNode.publicKey)).toBe(true);
    expect(leafNode.verify(rootNode.publicKey)).toBe(true);
    expect(leafNode.checkIssued(rootNode)).toBe(true);
    expect(rootNode.checkPrivateKey(createPrivateKey(authority.privateKeyPem))).toBe(true);
    expect(leafNode.checkPrivateKey(createPrivateKey(leaf.privateKeyPem))).toBe(true);
    expect(leafNode.checkIP("192.168.0.29")).toBe("192.168.0.29");
    expect(leafNode.checkIP("192.168.0.30")).toBeUndefined();
    expect(leafNode.subjectAltName).toBe("IP Address:192.168.0.29");
    expect(leafNode.keyUsage).toEqual(["1.3.6.1.5.5.7.3.1"]);
    expect(leafNode.validFromDate.getTime()).toBe(now.getTime() - clockSkewMs);
    expect(leafNode.validToDate.getTime()).toBe(now.getTime() - clockSkewMs + leafValidityMs);
    expect(leafNode.validToDate.getTime() - leafNode.validFromDate.getTime()).toBe(leafValidityMs);
    expect(rootNode.validToDate.getTime() - rootNode.validFromDate.getTime()).toBe(rootValidityMs);
    expect(leafCertificateState(leafNode, "192.168.0.29", new Date(leafNode.validToDate.getTime() - renewalThresholdMs - 1))).toBe(
      "valid"
    );
    expect(leafCertificateState(leafNode, "192.168.0.29", new Date(leafNode.validToDate.getTime() - renewalThresholdMs))).toBe(
      "renewal_due"
    );
    expect(leafCertificateState(leafNode, "192.168.0.30", now)).toBe("identity_mismatch");
    expect(leafCertificateState(leafNode, "192.168.0.29", new Date(leafNode.validFromDate.getTime() - 1))).toBe(
      "not_yet_valid"
    );
    expect(leafCertificateState(leafNode, "192.168.0.29", new Date(leafNode.validToDate.getTime() + 1))).toBe(
      "expired"
    );
    expect(rootNode.fingerprint256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/u);
    expect(rootNode.serialNumber).toMatch(/^[0-7][0-9A-F]{31}$/u);
    expect(leafNode.serialNumber).toMatch(/^[0-7][0-9A-F]{31}$/u);

    const rootBasic = requireExtension(authority.certificate, BasicConstraintsExtension);
    const rootUsage = requireExtension(authority.certificate, KeyUsagesExtension);
    const leafBasic = requireExtension(leaf.certificate, BasicConstraintsExtension);
    const leafUsage = requireExtension(leaf.certificate, KeyUsagesExtension);
    const leafExtendedUsage = requireExtension(leaf.certificate, ExtendedKeyUsageExtension);
    const leafNames = requireExtension(leaf.certificate, SubjectAlternativeNameExtension);
    expect(rootBasic).toMatchObject({ ca: true, critical: true, pathLength: 0 });
    expect(rootUsage).toMatchObject({
      critical: true,
      usages: KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign
    });
    expect(leafBasic).toMatchObject({ ca: false, critical: true });
    expect(leafUsage).toMatchObject({
      critical: true,
      usages: KeyUsageFlags.digitalSignature | KeyUsageFlags.keyEncipherment
    });
    expect(leafExtendedUsage).toMatchObject({ critical: false, usages: [ExtendedKeyUsage.serverAuth] });
    expect(leafNames.names.toJSON()).toEqual([{ type: "ip", value: "192.168.0.29" }]);
    expect(requireExtension(leaf.certificate, AuthorityKeyIdentifierExtension).keyId).toBe(
      requireExtension(authority.certificate, SubjectKeyIdentifierExtension).keyId
    );

    const enrollment = enrollmentArtifact(authority, "192.168.0.29");
    expect(enrollment).toMatchObject({
      certificate_der: expect.any(Uint8Array),
      fingerprint_sha256: normalizedFingerprint(rootNode),
      host: "192.168.0.29",
      media_type: "application/x-x509-ca-cert"
    });
    expect(enrollment.certificate_der.byteLength).toBeGreaterThan(512);
    expect(enrollment.certificate_der.byteLength).toBeLessThan(4_096);
    expect(JSON.stringify(enrollment)).not.toContain("PRIVATE KEY");
  });

  it("serves only to the trusted exact IP and rejects untrusted, mismatched, and plaintext clients", async () => {
    const now = new Date();
    const authority = await generateAuthority(now);
    const leaf = await generateLeaf(authority, "192.168.0.29", now);
    const server = createHttpsServer(
      {
        cert: leaf.certificatePem,
        key: leaf.privateKeyPem,
        minVersion: "TLSv1.2"
      },
      (_request, response) => response.end("hostdeck-secure")
    );
    const port = await listenLoopback(server);
    try {
      await expect(httpsBody(port, "192.168.0.29", authority.certificatePem)).resolves.toBe(
        "hostdeck-secure"
      );
      await expect(httpsBody(port, "192.168.0.30", authority.certificatePem)).rejects.toMatchObject({
        code: "ERR_TLS_CERT_ALTNAME_INVALID"
      });
      await expect(httpsBody(port, "192.168.0.29")).rejects.toMatchObject({
        code: expect.stringMatching(/SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE/u)
      });
      await expect(plainHttpBody(port)).rejects.toMatchObject({
        code: expect.stringMatching(/ECONNRESET|EPIPE/u)
      });
    } finally {
      await closeServer(server);
    }
  });

  it("renews leaf identity under the same root and requires re-enrollment after root rotation", async () => {
    const now = new Date();
    const authority = await generateAuthority(now);
    const original = await generateLeaf(authority, "192.168.0.29", now);
    const renewed = await generateLeaf(authority, "192.168.0.29", new Date(now.getTime() + 1_000));
    const rotatedAuthority = await generateAuthority(now);
    const rotatedLeaf = await generateLeaf(rotatedAuthority, "192.168.0.29", now);

    expect(renewed.serialNumber).not.toBe(original.serialNumber);
    expect(new NodeX509Certificate(renewed.certificatePem).fingerprint256).not.toBe(
      new NodeX509Certificate(original.certificatePem).fingerprint256
    );
    await expect(probeTls(renewed, authority.certificatePem, "192.168.0.29")).resolves.toBe(
      "hostdeck-secure"
    );
    await expect(probeTls(rotatedLeaf, authority.certificatePem, "192.168.0.29")).rejects.toMatchObject({
      code: expect.stringMatching(/CERT_SIGNATURE_FAILURE|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE/u)
    });
    await expect(
      probeTls(rotatedLeaf, rotatedAuthority.certificatePem, "192.168.0.29")
    ).resolves.toBe("hostdeck-secure");
  });

  it("rejects expired, not-yet-valid, and mismatched private-key identities", async () => {
    const now = new Date();
    const authority = await generateAuthority(now);
    const expired = await generateLeaf(authority, "192.168.0.29", now, {
      notAfter: new Date(now.getTime() - dayMs),
      notBefore: new Date(now.getTime() - 2 * dayMs)
    });
    const future = await generateLeaf(authority, "192.168.0.29", now, {
      notAfter: new Date(now.getTime() + 2 * dayMs),
      notBefore: new Date(now.getTime() + dayMs)
    });
    const valid = await generateLeaf(authority, "192.168.0.29", now);
    const unrelated = await generateLeaf(authority, "192.168.0.29", now);

    await expect(probeTls(expired, authority.certificatePem, "192.168.0.29")).rejects.toMatchObject({
      code: "CERT_HAS_EXPIRED"
    });
    await expect(probeTls(future, authority.certificatePem, "192.168.0.29")).rejects.toMatchObject({
      code: "CERT_NOT_YET_VALID"
    });
    expect(() => createHttpsServer({ cert: valid.certificatePem, key: unrelated.privateKeyPem })).toThrow(
      /key values mismatch/iu
    );
  });

  it("passes OpenSSL chain/purpose/IP checks and existing owner-only path validation", async () => {
    const now = new Date();
    const authority = await generateAuthority(now);
    const leaf = await generateLeaf(authority, "192.168.0.29", now);
    const root = tempDirectory();
    const caPath = join(root, "hostdeck-ca.pem");
    const caKeyPath = join(root, "hostdeck-ca-key.pem");
    const leafPath = join(root, "hostdeck-leaf.pem");
    const leafKeyPath = join(root, "hostdeck-leaf-key.pem");
    writeFileSync(caPath, authority.certificatePem, { flag: "wx", mode: 0o600 });
    writeFileSync(caKeyPath, authority.privateKeyPem, { flag: "wx", mode: 0o600 });
    writeFileSync(leafPath, leaf.certificatePem, { flag: "wx", mode: 0o600 });
    writeFileSync(leafKeyPath, leaf.privateKeyPem, { flag: "wx", mode: 0o600 });

    for (const [path, label] of [
      [caPath, "CA certificate"],
      [caKeyPath, "CA private key"],
      [leafPath, "leaf certificate"],
      [leafKeyPath, "leaf private key"]
    ] as const) {
      expect(secureHostDeckRegularFile(path, { label, mode: 0o600, repair_mode: false })).toBeNull();
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
    }

    const verify = runOpenSsl(["verify", "-purpose", "sslserver", "-CAfile", caPath, leafPath]);
    expect(verify.status, verify.stderr).toBe(0);
    expect(verify.stdout).toContain(`${leafPath}: OK`);
    const matchingIp = runOpenSsl(["x509", "-in", leafPath, "-noout", "-checkip", "192.168.0.29"]);
    expect(matchingIp.status, matchingIp.stderr).toBe(0);
    expect(matchingIp.stdout).toContain("does match certificate");
    const wrongIp = runOpenSsl(["x509", "-in", leafPath, "-noout", "-checkip", "192.168.0.30"]);
    expect(wrongIp.status, wrongIp.stderr).toBe(0);
    expect(wrongIp.stdout).toContain("does NOT match certificate");

    chmodSync(caKeyPath, 0o644);
    expectPathError(
      () =>
        secureHostDeckRegularFile(caKeyPath, {
          label: "CA private key",
          mode: 0o600,
          repair_mode: false
        }),
      "permission_update_failed"
    );
    chmodSync(caKeyPath, 0o600);
    const substitutePath = join(root, "substitute-key.pem");
    symlinkSync(caKeyPath, substitutePath);
    expectPathError(
      () =>
        secureHostDeckRegularFile(substitutePath, {
          label: "CA private key",
          mode: 0o600,
          repair_mode: false
        }),
      "symlink_rejected"
    );
  });
});

interface LanCertificateIdentity {
  readonly address: string;
  readonly family: "ipv4" | "ipv6";
  readonly host_allowlist: readonly string[];
}

interface AuthorityMaterial {
  readonly certificate: X509Certificate;
  readonly certificatePem: string;
  readonly keys: CryptoKeyPair;
  readonly privateKeyPem: string;
}

interface LeafMaterial {
  readonly certificate: X509Certificate;
  readonly certificatePem: string;
  readonly privateKeyPem: string;
  readonly serialNumber: string;
}

interface LeafValidityOverride {
  readonly notAfter: Date;
  readonly notBefore: Date;
}

type LeafCertificateState =
  | "expired"
  | "identity_mismatch"
  | "not_yet_valid"
  | "renewal_due"
  | "valid";

function resolveLanCertificateIdentity(
  input: string,
  assignedAddresses: readonly string[]
): LanCertificateIdentity {
  const parsed = parseSocketAddress(input);
  if (parsed === null || !isPrivateLanAddress(parsed)) {
    throw new TypeError("HostDeck LAN certificate address must be a private IPv4 or ULA IPv6 address.");
  }
  const assigned = new Set(
    assignedAddresses.map((address) => parseSocketAddress(address)?.address).filter((address) => address !== undefined)
  );
  if (!assigned.has(parsed.address)) {
    throw new TypeError("HostDeck LAN certificate address must be assigned to this host.");
  }
  const family = parsed.family === "ipv4" ? "ipv4" : "ipv6";
  return Object.freeze({
    address: parsed.address,
    family,
    host_allowlist: Object.freeze([family === "ipv6" ? `[${parsed.address}]` : parsed.address])
  });
}

function parseSocketAddress(input: string): SocketAddress | null {
  if (typeof input !== "string" || input.length < 2 || input !== input.trim()) return null;
  const candidate = input.includes(":") ? `[${input}]:443` : `${input}:443`;
  return SocketAddress.parse(candidate) ?? null;
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

async function generateAuthority(now: Date): Promise<AuthorityMaterial> {
  const keys = await generateRsaKeys();
  const certificate = await X509CertificateGenerator.createSelfSigned({
    extensions: [
      new BasicConstraintsExtension(true, 0, true),
      new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true),
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
}

async function generateLeaf(
  authority: AuthorityMaterial,
  address: string,
  now: Date,
  validity?: LeafValidityOverride
): Promise<LeafMaterial> {
  const identity = resolveLanCertificateIdentity(address, [address]);
  const keys = await generateRsaKeys();
  const serialNumber = randomSerialNumber();
  const certificate = await X509CertificateGenerator.create({
    extensions: [
      new BasicConstraintsExtension(false, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.digitalSignature | KeyUsageFlags.keyEncipherment, true),
      new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth]),
      new SubjectAlternativeNameExtension([{ type: "ip", value: identity.address }]),
      await SubjectKeyIdentifierExtension.create(keys.publicKey),
      await AuthorityKeyIdentifierExtension.create(authority.keys.publicKey)
    ],
    issuer: authority.certificate.subject,
    notAfter: validity?.notAfter ?? new Date(now.getTime() - clockSkewMs + leafValidityMs),
    notBefore: validity?.notBefore ?? new Date(now.getTime() - clockSkewMs),
    publicKey: keys.publicKey,
    serialNumber,
    signingAlgorithm,
    signingKey: authority.keys.privateKey,
    subject: "CN=HostDeck LAN"
  });
  return Object.freeze({
    certificate,
    certificatePem: certificate.toString("pem"),
    privateKeyPem: await exportPrivateKey(keys.privateKey),
    serialNumber
  });
}

function enrollmentArtifact(authority: AuthorityMaterial, host: string) {
  const parsed = new NodeX509Certificate(authority.certificatePem);
  return Object.freeze({
    certificate_der: new Uint8Array(authority.certificate.rawData),
    fingerprint_sha256: normalizedFingerprint(parsed),
    host,
    media_type: "application/x-x509-ca-cert" as const
  });
}

async function generateRsaKeys(): Promise<CryptoKeyPair> {
  return globalThis.crypto.subtle.generateKey(rsaAlgorithm, true, ["sign", "verify"]);
}

async function exportPrivateKey(key: CryptoKey): Promise<string> {
  const der = Buffer.from(await globalThis.crypto.subtle.exportKey("pkcs8", key));
  const body = der.toString("base64").match(/.{1,64}/gu)?.join("\n");
  if (body === undefined) throw new Error("Generated private key did not encode.");
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
}

function randomSerialNumber(): string {
  const bytes = randomBytes(16);
  bytes[0] = ((bytes[0] ?? 0) & 0x7f) || 1;
  return bytes.toString("hex").toUpperCase();
}

function requireExtension<T>(
  certificate: X509Certificate,
  extensionConstructor: abstract new (...args: never[]) => T
): T {
  const extension = certificate.extensions.find((candidate) => candidate instanceof extensionConstructor);
  if (extension === undefined) throw new Error(`Missing certificate extension ${extensionConstructor.name}.`);
  return extension as T;
}

function normalizedFingerprint(certificate: NodeX509Certificate): string {
  return certificate.fingerprint256.replaceAll(":", "").toLowerCase();
}

function leafCertificateState(
  certificate: NodeX509Certificate,
  identity: string,
  now: Date
): LeafCertificateState {
  const observedAt = now.getTime();
  if (observedAt < certificate.validFromDate.getTime()) return "not_yet_valid";
  if (observedAt > certificate.validToDate.getTime()) return "expired";
  if (certificate.checkIP(identity) === undefined) return "identity_mismatch";
  if (certificate.validToDate.getTime() - observedAt <= renewalThresholdMs) return "renewal_due";
  return "valid";
}

function expectPathError(operation: () => unknown, code: string): void {
  let captured: unknown;
  try {
    operation();
  } catch (error) {
    captured = error;
  }
  expect(captured).toMatchObject({ code });
}

async function probeTls(leaf: LeafMaterial, ca: string, identity: string): Promise<string> {
  const server = createHttpsServer(
    { cert: leaf.certificatePem, key: leaf.privateKeyPem, minVersion: "TLSv1.2" },
    (_request, response) => response.end("hostdeck-secure")
  );
  const port = await listenLoopback(server);
  try {
    return await httpsBody(port, identity, ca);
  } finally {
    await closeServer(server);
  }
}

function httpsBody(port: number, identity: string, ca?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = httpsGet(
      {
        agent: false,
        ca,
        checkServerIdentity: (_hostname, certificate) => checkServerIdentity(identity, certificate),
        host: "127.0.0.1",
        path: "/",
        port,
        rejectUnauthorized: true
      },
      (response) => collectBody(response, resolve, reject)
    );
    request.setTimeout(2_000, () => request.destroy(new Error("HTTPS probe exceeded its deadline.")));
    request.once("error", reject);
  });
}

function plainHttpBody(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = httpGet({ host: "127.0.0.1", path: "/", port }, (response) =>
      collectBody(response, resolve, reject)
    );
    request.setTimeout(2_000, () => request.destroy(new Error("Plain HTTP probe exceeded its deadline.")));
    request.once("error", reject);
  });
}

function collectBody(
  response: import("node:http").IncomingMessage,
  resolve: (body: string) => void,
  reject: (error: Error) => void
): void {
  let body = "";
  response.setEncoding("utf8");
  response.on("data", (chunk: string) => {
    body += chunk;
    if (body.length > 1_024) {
      response.destroy(new Error("TLS probe response exceeded its bound."));
    }
  });
  response.once("end", () => resolve(body));
  response.once("error", reject);
}

function listenLoopback(server: import("node:https").Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("HTTPS probe did not bind a TCP address."));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: import("node:https").Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-lan-certificate-"));
  tempDirectories.push(directory);
  return directory;
}

function runOpenSsl(args: readonly string[]): { readonly status: number | null; readonly stderr: string; readonly stdout: string } {
  const result = spawnSync("openssl", args, { encoding: "utf8", timeout: 5_000 });
  if (result.error !== undefined) throw result.error;
  return Object.freeze({ status: result.status, stderr: result.stderr, stdout: result.stdout });
}
