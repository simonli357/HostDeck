import { describe, expect, it } from "vitest";
import {
  pairingClaimRateGlobalRecordSchema,
  pairingClaimRateSourceRecordSchema,
  pairingClaimSourceKeySchema,
  pairingClientLabelSchema,
  selectedPairClaimRequestSchema,
  selectedPairClaimResponseSchema,
  selectedPairingClientLabelSchema,
  selectedPairingDeviceIdSchema,
  selectedPairingIdSchema,
  selectedPairRequestResponseSchema,
  selectedPairRequestSchema,
  selectedRawPairingCodeSchema
} from "./pairing.js";
import { pairingCodeRecordSchema } from "./storage.js";

const sourceKey = `sha256:${"a".repeat(64)}`;
const codeHash = `sha256:${"b".repeat(64)}`;
const createdAt = "2026-07-11T20:00:00.000Z";
const expiresAt = "2026-07-11T20:05:00.000Z";

describe("selected pairing contracts", () => {
  it("accepts only canonical source keys, exact 128-bit code encoding, and bounded labels", () => {
    expect(pairingClaimSourceKeySchema.parse(sourceKey)).toBe(sourceKey);
    expect(selectedRawPairingCodeSchema.parse("abcdefghijklmnopqrstuv")).toBe("abcdefghijklmnopqrstuv");
    expect(pairingClientLabelSchema.parse(null)).toBeNull();
    expect(pairingClientLabelSchema.parse("Android phone")).toBe("Android phone");

    for (const candidate of [
      "127.0.0.1",
      "sha256:short",
      `sha256:${"A".repeat(64)}`,
      `sha256:${"g".repeat(64)}`,
      `${sourceKey}0`
    ]) {
      expect(() => pairingClaimSourceKeySchema.parse(candidate)).toThrow();
    }
    for (const candidate of [
      "abcdefghijklmnopqrstu",
      "abcdefghijklmnopqrstuvw",
      "abcdefghijklmnopqrstu=",
      "abcdefghijklmnopqrstu!"
    ]) {
      expect(() => selectedRawPairingCodeSchema.parse(candidate)).toThrow();
    }
    for (const candidate of [
      "",
      " leading",
      "trailing ",
      "line\nbreak",
      "format\u200bcharacter",
      "x".repeat(121),
      undefined,
      1
    ]) {
      expect(() => pairingClientLabelSchema.parse(candidate)).toThrow();
    }
  });

  it("owns exact selected issue and claim HTTP contracts", () => {
    const operationId = "op_pairing_contract_01";
    const rawCode = "abcdefghijklmnopqrstuv";
    const pairingId = "pair_abcdefghijklmnopqrstuvwx";
    const deviceId = "client_abcdefghijklmnopqrstuvwx";

    expect(selectedPairingIdSchema.parse(pairingId)).toBe(pairingId);
    expect(selectedPairingDeviceIdSchema.parse(deviceId)).toBe(deviceId);
    expect(selectedPairingClientLabelSchema.parse("Simon's phone")).toBe("Simon's phone");
    expect(
      selectedPairRequestSchema.parse({
        operation_id: operationId,
        permission: "write",
        client_label: "Simon's phone"
      })
    ).toEqual({
      operation_id: operationId,
      permission: "write",
      client_label: "Simon's phone"
    });
    expect(
      selectedPairClaimRequestSchema.parse({ operation_id: operationId, code: rawCode })
    ).toEqual({ operation_id: operationId, code: rawCode });

    const issueResponse = {
      pairing_id: pairingId,
      code: rawCode,
      permission: "read",
      client_label: null,
      created_at: createdAt,
      expires_at: expiresAt
    } as const;
    expect(selectedPairRequestResponseSchema.parse(issueResponse)).toEqual(issueResponse);

    const claimResponse = {
      device_id: deviceId,
      permission: "write",
      client_label: "Simon's phone",
      created_at: createdAt,
      expires_at: "2026-10-09T20:00:00.000Z",
      csrf_bootstrap_required: true
    } as const;
    expect(selectedPairClaimResponseSchema.parse(claimResponse)).toEqual(claimResponse);

    for (const candidate of [
      { operation_id: "request-1", permission: "write" },
      { operation_id: operationId, permission: "admin" },
      { operation_id: operationId, permission: "read", extra: true }
    ]) {
      expect(() => selectedPairRequestSchema.parse(candidate)).toThrow();
    }
    for (const candidate of [
      { operation_id: operationId, code: "too-short" },
      { operation_id: operationId, code: rawCode, client_label: " phone" },
      { operation_id: operationId, code: rawCode, extra: true }
    ]) {
      expect(() => selectedPairClaimRequestSchema.parse(candidate)).toThrow();
    }
    expect(() =>
      selectedPairRequestResponseSchema.parse({ ...issueResponse, expires_at: createdAt })
    ).toThrow();
    expect(() =>
      selectedPairClaimResponseSchema.parse({ ...claimResponse, expires_at: createdAt })
    ).toThrow();
    expect(() =>
      selectedPairClaimResponseSchema.parse({ ...claimResponse, csrf_token: "secret" })
    ).toThrow();
  });

  it("normalizes valid rate timestamps and rejects impossible or unbounded rate state", () => {
    expect(
      pairingClaimRateSourceRecordSchema.parse({
        source_key: sourceKey,
        window_started_at: "2026-07-11T16:00:00.000-04:00",
        attempt_count: 1,
        last_attempt_at: "2026-07-11T20:00:01.000Z"
      })
    ).toEqual({
      source_key: sourceKey,
      window_started_at: createdAt,
      attempt_count: 1,
      last_attempt_at: "2026-07-11T20:00:01.000Z"
    });
    expect(
      pairingClaimRateGlobalRecordSchema.parse({
        id: "pair_claim_global",
        window_started_at: createdAt,
        attempt_count: Number.MAX_SAFE_INTEGER,
        last_attempt_at: createdAt
      }).attempt_count
    ).toBe(Number.MAX_SAFE_INTEGER);

    const sourceRecord = {
      source_key: sourceKey,
      window_started_at: createdAt,
      attempt_count: 1,
      last_attempt_at: createdAt
    } as const;
    for (const attemptCount of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        pairingClaimRateSourceRecordSchema.parse({ ...sourceRecord, attempt_count: attemptCount })
      ).toThrow();
    }
    expect(() =>
      pairingClaimRateSourceRecordSchema.parse({
        ...sourceRecord,
        last_attempt_at: "2026-07-11T19:59:59.999Z"
      })
    ).toThrow();
    expect(() => pairingClaimRateSourceRecordSchema.parse({ ...sourceRecord, extra: true })).toThrow();
    expect(() =>
      pairingClaimRateGlobalRecordSchema.parse({
        id: "another_global",
        window_started_at: createdAt,
        attempt_count: 1,
        last_attempt_at: createdAt
      })
    ).toThrow();
  });

  it("distinguishes preserved legacy rows from strict selected owner provenance", () => {
    const legacy = pairingCodeRecordSchema.parse({
      ...pairingRecord(),
      expires_at: "2026-07-11T19:00:00.000Z",
      claim_contract_version: null
    });
    expect(legacy.claim_contract_version).toBeNull();

    const unused = pairingCodeRecordSchema.parse(pairingRecord());
    const revoked = pairingCodeRecordSchema.parse({
      ...pairingRecord(),
      revoked_at: "2026-07-11T20:01:00.000Z"
    });
    const used = pairingCodeRecordSchema.parse({
      ...pairingRecord(),
      used_at: "2026-07-11T20:04:59.999Z",
      claimed_device_id: "client_selected_owner"
    });
    expect(unused.claimed_device_id).toBeNull();
    expect(revoked.revoked_at).toBe("2026-07-11T20:01:00.000Z");
    expect(used.claimed_device_id).toBe("client_selected_owner");

    const invalid = [
      { ...pairingRecord(), code_hash: `legacy:${"c".repeat(64)}` },
      { ...pairingRecord(), expires_at: createdAt },
      { ...pairingRecord(), expires_at: "2026-07-11T19:59:59.999Z" },
      { ...pairingRecord(), claimed_device_id: "client_without_use" },
      { ...pairingRecord(), used_at: "2026-07-11T20:01:00.000Z" },
      {
        ...pairingRecord(),
        used_at: "2026-07-11T19:59:59.999Z",
        claimed_device_id: "client_early_use"
      },
      { ...pairingRecord(), used_at: expiresAt, claimed_device_id: "client_expired_use" },
      {
        ...pairingRecord(),
        used_at: "2026-07-11T20:01:00.000Z",
        revoked_at: "2026-07-11T20:02:00.000Z",
        claimed_device_id: "client_contradiction"
      },
      { ...pairingRecord(), revoked_at: "2026-07-11T19:59:59.999Z" },
      {
        ...pairingRecord(),
        claim_contract_version: null,
        claimed_device_id: "client_invented_legacy_owner"
      },
      { ...pairingRecord(), extra: true }
    ];
    for (const candidate of invalid) expect(() => pairingCodeRecordSchema.parse(candidate)).toThrow();
  });
});

function pairingRecord() {
  return {
    id: "pair_selected_contract",
    code_hash: codeHash,
    permission: "write" as const,
    client_label: "Android phone",
    created_at: createdAt,
    expires_at: expiresAt,
    used_at: null,
    revoked_at: null,
    claim_contract_version: 1 as const,
    claimed_device_id: null
  };
}
