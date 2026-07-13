import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { createServer as createHttpsServer, get as httpsGet } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkServerIdentity, type PeerCertificate } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertHostDeckLanCertificatePolicy,
  createHostDeckLanCertificatePolicy,
  type HostDeckLanCertificatePolicy
} from "./lan-certificate-policy.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("selected LAN certificate policy", () => {
  it("issues one exact root/leaf set and exposes only bounded public metadata", async () => {
    const harness = policyHarness();
    const inspection = await harness.policy.configure({
      bind_host: "192.168.0.29",
      bind_port: 3777,
      certificate_action: "issue_leaf"
    });

    expect(inspection).toMatchObject({
      bind_host: "192.168.0.29",
      address_family: "ipv4",
      bind_port: 3777,
      configured_origin: "https://192.168.0.29:3777",
      certificate_state: "valid",
      enrollment_available: true
    });
    expect(inspection.root_fingerprint_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(inspection.leaf_fingerprint_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(inspection)).not.toMatch(/PRIVATE KEY|BEGIN CERTIFICATE|\.pem/iu);
    expect(Object.isFrozen(inspection)).toBe(true);
    expect(readdirSync(harness.directory).sort()).toEqual([
      "hostdeck-lan-key.pem",
      "hostdeck-lan.pem",
      "hostdeck-local-ca-key.pem",
      "hostdeck-local-ca.pem"
    ]);
    for (const file of readdirSync(harness.directory)) {
      expect(lstatSync(join(harness.directory, file)).mode & 0o777).toBe(0o600);
    }
    expect(harness.policy.snapshot()).toEqual({
      configurations: 1,
      enrollment_reads: 0,
      inspections: 1,
      leaf_issues: 1,
      root_issues: 1,
      tls_loads: 0
    });
  });

  it("reuses exact material without mutation and renews only the leaf under the same root", async () => {
    const harness = policyHarness();
    const initial = await harness.policy.configure({
      bind_host: "192.168.0.29",
      bind_port: 3777,
      certificate_action: "issue_leaf"
    });
    const initialFiles = fileHashes(harness.directory);
    const reused = await harness.policy.configure({
      bind_host: "192.168.0.29",
      bind_port: 3777,
      certificate_action: "reuse"
    });
    expect(reused).toEqual(initial);
    expect(fileHashes(harness.directory)).toEqual(initialFiles);

    harness.setNow(new Date("2026-07-12T20:00:01.000Z"));
    const renewed = await harness.policy.configure({
      bind_host: "192.168.0.29",
      bind_port: 3777,
      certificate_action: "issue_leaf"
    });
    const renewedFiles = fileHashes(harness.directory);
    expect(renewed.root_fingerprint_sha256).toBe(initial.root_fingerprint_sha256);
    expect(renewed.leaf_fingerprint_sha256).not.toBe(initial.leaf_fingerprint_sha256);
    expect(renewedFiles["hostdeck-local-ca.pem"]).toBe(initialFiles["hostdeck-local-ca.pem"]);
    expect(renewedFiles["hostdeck-local-ca-key.pem"]).toBe(initialFiles["hostdeck-local-ca-key.pem"]);
    expect(renewedFiles["hostdeck-lan.pem"]).not.toBe(initialFiles["hostdeck-lan.pem"]);
    expect(renewedFiles["hostdeck-lan-key.pem"]).not.toBe(initialFiles["hostdeck-lan-key.pem"]);
    expect(harness.policy.snapshot()).toMatchObject({
      configurations: 3,
      leaf_issues: 2,
      root_issues: 1
    });
  });

  it("loads private TLS material for a trusted exact-IP handshake and exports only public root DER", async () => {
    const harness = policyHarness();
    const inspection = await harness.policy.configure({
      bind_host: "192.168.0.29",
      bind_port: 3777,
      certificate_action: "issue_leaf"
    });
    const runtime = harness.policy.loadTls({ bind_host: "192.168.0.29", bind_port: 3777 });
    expect(runtime.inspection).toEqual(inspection);
    expect(runtime.tls.certificate_chain_pem).toContain("BEGIN CERTIFICATE");
    expect(runtime.tls.private_key_pem).toContain("BEGIN PRIVATE KEY");
    await expect(tlsProbe(runtime.tls, "192.168.0.29")).resolves.toBe("hostdeck-secure");
    await expect(tlsProbe(runtime.tls, "192.168.0.30")).rejects.toMatchObject({
      code: "ERR_TLS_CERT_ALTNAME_INVALID"
    });

    const enrollment = harness.policy.enrollment({
      bind_host: "192.168.0.29",
      bind_port: 3777
    });
    expect(enrollment).toMatchObject({
      fingerprint_sha256: inspection.root_fingerprint_sha256,
      host: "192.168.0.29",
      media_type: "application/x-x509-ca-cert"
    });
    expect(enrollment.certificate_der).toBeInstanceOf(Uint8Array);
    expect(enrollment.certificate_der.byteLength).toBeGreaterThan(512);
    expect(enrollment.certificate_der.byteLength).toBeLessThan(4096);
    expect(JSON.stringify(enrollment)).not.toContain("PRIVATE KEY");
  });

  it("reports renewal, expiry, and identity mismatch without inventing valid state", async () => {
    const harness = policyHarness(["192.168.0.29", "192.168.0.30"]);
    await harness.policy.configure({
      bind_host: "192.168.0.29",
      bind_port: 3777,
      certificate_action: "issue_leaf"
    });
    expect(
      harness.policy.inspect({ bind_host: "192.168.0.30", bind_port: 3777 })
        .certificate_state
    ).toBe("identity_mismatch");
    expect(() =>
      harness.policy.loadTls({ bind_host: "192.168.0.30", bind_port: 3777 })
    ).toThrowError(expect.objectContaining({ code: "certificate_not_valid" }));

    harness.setNow(new Date("2027-07-15T20:00:00.000Z"));
    expect(
      harness.policy.inspect({ bind_host: "192.168.0.29", bind_port: 3777 })
        .certificate_state
    ).toBe("renewal_due");
    harness.setNow(new Date("2027-08-20T20:00:00.000Z"));
    expect(
      harness.policy.inspect({ bind_host: "192.168.0.29", bind_port: 3777 })
        .certificate_state
    ).toBe("expired");
    expect(() =>
      harness.policy.loadTls({ bind_host: "192.168.0.29", bind_port: 3777 })
    ).toThrowError(expect.objectContaining({ code: "certificate_not_valid" }));
  });

  it("rejects unsupported or unassigned identities before file mutation", async () => {
    for (const host of [
      "0.0.0.0",
      "127.0.0.1",
      "169.254.1.1",
      "224.0.0.1",
      "8.8.8.8",
      "::",
      "::1",
      "fe80::1",
      "2607:fa49:4142:2700::1",
      "192.168.0.30"
    ]) {
      const harness = policyHarness();
      await expect(
        harness.policy.configure({
          bind_host: host,
          bind_port: 3777,
          certificate_action: "issue_leaf"
        })
      ).rejects.toMatchObject({ code: "address_unavailable" });
      expect(readdirSync(harness.directory)).toEqual([]);
    }
  });

  it("fails closed for missing, partial, linked, over-permissive, and mismatched material", async () => {
    const missing = policyHarness();
    expect(() =>
      missing.policy.inspect({ bind_host: "192.168.0.29", bind_port: 3777 })
    ).toThrowError(expect.objectContaining({ code: "certificate_missing" }));

    const partial = policyHarness();
    writeFileSync(join(partial.directory, "hostdeck-local-ca.pem"), "partial", { mode: 0o600 });
    expect(() =>
      partial.policy.inspect({ bind_host: "192.168.0.29", bind_port: 3777 })
    ).toThrowError(expect.objectContaining({ code: "certificate_partial" }));

    const linked = policyHarness();
    await issue(linked.policy);
    const leafKey = join(linked.directory, "hostdeck-lan-key.pem");
    unlinkSync(leafKey);
    symlinkSync(join(linked.directory, "hostdeck-local-ca-key.pem"), leafKey);
    expect(() =>
      linked.policy.inspect({ bind_host: "192.168.0.29", bind_port: 3777 })
    ).toThrowError(expect.objectContaining({ code: "certificate_invalid" }));

    const permissive = policyHarness();
    await issue(permissive.policy);
    chmodSync(join(permissive.directory, "hostdeck-lan-key.pem"), 0o644);
    expect(() =>
      permissive.policy.inspect({ bind_host: "192.168.0.29", bind_port: 3777 })
    ).toThrowError(expect.objectContaining({ code: "certificate_invalid" }));

    const mismatch = policyHarness();
    await issue(mismatch.policy);
    writeFileSync(
      join(mismatch.directory, "hostdeck-lan-key.pem"),
      readFileSync(join(mismatch.directory, "hostdeck-local-ca-key.pem")),
      { mode: 0o600 }
    );
    expect(() =>
      mismatch.policy.inspect({ bind_host: "192.168.0.29", bind_port: 3777 })
    ).toThrowError(expect.objectContaining({ code: "certificate_invalid" }));
  });

  it("rejects malformed construction and request objects without side effects", async () => {
    const directory = tempDirectory();
    expect(() =>
      createHostDeckLanCertificatePolicy({
        assignedAddresses: () => ["192.168.0.29"],
        certificateDirectory: ".",
        now: fixedNow
      })
    ).toThrowError(expect.objectContaining({ code: "invalid_certificate_input" }));
    const harness = policyHarness();
    assertHostDeckLanCertificatePolicy(harness.policy);
    expect(() => assertHostDeckLanCertificatePolicy({ ...harness.policy })).toThrow(TypeError);

    const valid = {
      bind_host: "192.168.0.29",
      bind_port: 3777,
      certificate_action: "issue_leaf"
    } as const;
    for (const candidate of [
      { ...valid, bind_host: "192.168.000.029" },
      { ...valid, bind_port: 0 },
      { ...valid, certificate_action: "rotate_root" },
      { ...valid, extra: true },
      Object.create(valid)
    ]) {
      await expect(harness.policy.configure(candidate as never)).rejects.toMatchObject({
        code: "invalid_certificate_input"
      });
    }
    expect(readdirSync(harness.directory)).toEqual([]);
    expect(readdirSync(directory)).toEqual([]);
  });
});

interface PolicyHarness {
  readonly directory: string;
  readonly policy: HostDeckLanCertificatePolicy;
  readonly setNow: (value: Date) => void;
}

function policyHarness(
  assignedAddresses: readonly string[] = ["192.168.0.29"]
): PolicyHarness {
  const directory = tempDirectory();
  let now = fixedNow();
  const policy = createHostDeckLanCertificatePolicy({
    assignedAddresses: () => assignedAddresses,
    certificateDirectory: directory,
    now: () => new Date(now)
  });
  return {
    directory,
    policy,
    setNow(value) {
      now = new Date(value);
    }
  };
}

async function issue(policy: HostDeckLanCertificatePolicy): Promise<void> {
  await policy.configure({
    bind_host: "192.168.0.29",
    bind_port: 3777,
    certificate_action: "issue_leaf"
  });
}

function fileHashes(directory: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(directory).map((file) => [
      file,
      createHash("sha256").update(readFileSync(join(directory, file))).digest("hex")
    ])
  );
}

function tlsProbe(
  tls: { readonly certificate_chain_pem: string; readonly private_key_pem: string },
  identity: string
): Promise<string> {
  const certificates = tls.certificate_chain_pem.match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu
  );
  const ca = certificates?.[1];
  if (ca === undefined) throw new Error("TLS chain did not contain a root certificate.");
  const server = createHttpsServer(
    {
      cert: tls.certificate_chain_pem,
      key: tls.private_key_pem,
      minVersion: "TLSv1.2"
    },
    (_request, response) => response.end("hostdeck-secure")
  );
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("TLS test listener did not bind."));
        return;
      }
      const request = httpsGet(
        {
          ca,
          checkServerIdentity: (_hostname, certificate: PeerCertificate) =>
            checkServerIdentity(identity, certificate),
          host: "127.0.0.1",
          port: address.port,
          rejectUnauthorized: true
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            body += chunk;
          });
          response.once("end", () => {
            server.close((error) => (error === undefined ? resolve(body) : reject(error)));
          });
        }
      );
      request.once("error", (error) => {
        server.close(() => reject(error));
      });
      request.setTimeout(2000, () => request.destroy(new Error("TLS probe timed out.")));
    });
  });
}

function fixedNow(): Date {
  return new Date("2026-07-12T20:00:00.000Z");
}

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "hostdeck-lan-certificate-policy-"));
  chmodSync(directory, 0o700);
  tempDirectories.push(directory);
  return directory;
}
