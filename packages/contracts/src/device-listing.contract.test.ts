import { describe, expect, it } from "vitest";
import {
  selectedDeviceListInputSchema,
  selectedDeviceListItemSchema,
  selectedDeviceListMaxPageSize,
  selectedDeviceListPageSchema
} from "./device-listing.js";

const createdAt = "2026-07-11T20:00:00.000Z";

describe("selected device listing contracts", () => {
  it("requires one exact explicit keyset input bounded from 1 through 100", () => {
    expect(selectedDeviceListMaxPageSize).toBe(100);
    expect(selectedDeviceListInputSchema.parse({ limit: 1, afterDeviceId: null })).toEqual({
      limit: 1,
      afterDeviceId: null
    });
    expect(
      selectedDeviceListInputSchema.parse({
        limit: selectedDeviceListMaxPageSize,
        afterDeviceId: "client_page_100"
      })
    ).toEqual({ limit: 100, afterDeviceId: "client_page_100" });

    for (const candidate of [
      null,
      {},
      { limit: 1 },
      { afterDeviceId: null },
      { limit: 0, afterDeviceId: null },
      { limit: 101, afterDeviceId: null },
      { limit: 1.5, afterDeviceId: null },
      { limit: Number.MAX_SAFE_INTEGER + 1, afterDeviceId: null },
      { limit: 1, afterDeviceId: "client with spaces" },
      { limit: 1, afterDeviceId: null, offset: 0 }
    ]) {
      expect(() => selectedDeviceListInputSchema.parse(candidate)).toThrow();
    }
  });

  it("projects only exact non-secret lifecycle metadata with canonical timestamps", () => {
    expect(
      selectedDeviceListItemSchema.parse({
        ...deviceItem("client_phone"),
        createdAt: "2026-07-11T16:00:00.000-04:00",
        lastUsedAt: "2026-07-11T16:01:00.000-04:00"
      })
    ).toEqual({
      ...deviceItem("client_phone"),
      lastUsedAt: "2026-07-11T20:01:00.000Z"
    });
    for (const secretField of [
      "token_hash",
      "csrf_token_hash",
      "csrf_generation",
      "csrf_rotated_at",
      "rawDeviceToken",
      "rawCsrfToken"
    ]) {
      expect(() =>
        selectedDeviceListItemSchema.parse({
          ...deviceItem("client_phone"),
          [secretField]: "private"
        })
      ).toThrow();
    }
    for (const candidate of [
      { ...deviceItem("client_phone"), permission: "admin" },
      { ...deviceItem("client_phone"), clientLabel: "" },
      { ...deviceItem("client_phone"), createdAt: "not-a-time" },
      { ...deviceItem("client phone") }
    ]) {
      expect(() => selectedDeviceListItemSchema.parse(candidate)).toThrow();
    }
  });

  it("requires strict ascending ids and coherent continuation state", () => {
    expect(
      selectedDeviceListPageSchema.parse({
        devices: [deviceItem("client_a"), deviceItem("client_b")],
        nextAfterDeviceId: "client_b",
        hasMore: true
      })
    ).toMatchObject({ nextAfterDeviceId: "client_b", hasMore: true });
    expect(
      selectedDeviceListPageSchema.parse({
        devices: [deviceItem("client_a")],
        nextAfterDeviceId: null,
        hasMore: false
      })
    ).toMatchObject({ nextAfterDeviceId: null, hasMore: false });

    const invalid = [
      {
        devices: [deviceItem("client_b"), deviceItem("client_a")],
        nextAfterDeviceId: null,
        hasMore: false
      },
      {
        devices: [deviceItem("client_a"), deviceItem("client_a")],
        nextAfterDeviceId: null,
        hasMore: false
      },
      {
        devices: [deviceItem("client_a")],
        nextAfterDeviceId: "client_other",
        hasMore: true
      },
      {
        devices: [deviceItem("client_a")],
        nextAfterDeviceId: null,
        hasMore: true
      },
      {
        devices: [],
        nextAfterDeviceId: "client_a",
        hasMore: true
      },
      {
        devices: Array.from({ length: 101 }, (_, index) => deviceItem(`client_${index.toString().padStart(3, "0")}`)),
        nextAfterDeviceId: null,
        hasMore: false
      },
      {
        devices: [],
        nextAfterDeviceId: null,
        hasMore: false,
        totalCount: 0
      }
    ];
    for (const candidate of invalid) expect(() => selectedDeviceListPageSchema.parse(candidate)).toThrow();
  });
});

function deviceItem(deviceId: string) {
  return {
    deviceId,
    clientLabel: "Android phone",
    permission: "write" as const,
    createdAt,
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null
  };
}
