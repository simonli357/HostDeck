import { describe, expect, it } from "vitest";
import {
  decodeSelectedDeviceListCursor,
  encodeSelectedDeviceListCursor,
  selectedDeviceListCursorMaxLength,
  selectedDeviceListCursorSchema,
  selectedDeviceListDefaultPageSize,
  selectedDeviceListInputSchema,
  selectedDeviceListItemSchema,
  selectedDeviceListMaxPageSize,
  selectedDeviceListPageSchema,
  selectedDeviceListQuerySchema,
  selectedDeviceListResponseSchema
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

  it("encodes one canonical versioned opaque cursor at the selected id bounds", () => {
    const examples = ["a", "client_phone-01:primary", "Z".repeat(120)];
    for (const deviceId of examples) {
      const cursor = encodeSelectedDeviceListCursor(deviceId);
      expect(selectedDeviceListCursorSchema.parse(cursor)).toBe(cursor);
      expect(decodeSelectedDeviceListCursor(cursor)).toBe(deviceId);
      expect(cursor).not.toContain("=");
    }
    for (let length = 1; length <= 120; length += 1) {
      const deviceId = `a${"Z".repeat(length - 1)}`;
      expect(decodeSelectedDeviceListCursor(encodeSelectedDeviceListCursor(deviceId))).toBe(
        deviceId
      );
    }
    expect(encodeSelectedDeviceListCursor("Z".repeat(120))).toHaveLength(
      selectedDeviceListCursorMaxLength
    );

    for (const candidate of [
      "",
      "v1.",
      "v2.YQ",
      "V1.YQ",
      "v1.YQ=",
      "v1.Y Q",
      "v1.A",
      "v1.YR",
      `v1.${"Y".repeat(161)}`,
      "v1.Y2xpZW50IHdpdGggc3BhY2Vz",
      `v1.${"eHh4".repeat(40)}eA`
    ]) {
      expect(() => selectedDeviceListCursorSchema.parse(candidate)).toThrow();
      expect(() => decodeSelectedDeviceListCursor(candidate)).toThrow(
        "Selected device-list cursor is invalid."
      );
    }
    expect(() => encodeSelectedDeviceListCursor("client with spaces")).toThrow(
      "Selected device-list cursor device id is invalid."
    );
  });

  it("maps one exact canonical HTTP query to the bounded storage input", () => {
    expect(selectedDeviceListDefaultPageSize).toBe(100);
    expect(selectedDeviceListQuerySchema.parse({})).toEqual({
      limit: 100,
      afterDeviceId: null
    });
    const cursor = encodeSelectedDeviceListCursor("client_page_100");
    expect(selectedDeviceListQuerySchema.parse({ limit: "1", cursor })).toEqual({
      limit: 1,
      afterDeviceId: "client_page_100"
    });
    expect(selectedDeviceListQuerySchema.parse({ limit: "100" })).toEqual({
      limit: 100,
      afterDeviceId: null
    });
    expect(Object.isFrozen(selectedDeviceListQuerySchema.parse({}))).toBe(true);

    for (const candidate of [
      { limit: "" },
      { limit: "0" },
      { limit: "00" },
      { limit: "01" },
      { limit: "101" },
      { limit: "+1" },
      { limit: "-1" },
      { limit: "1.0" },
      { limit: "1e2" },
      { limit: " 1" },
      { limit: 1 },
      { limit: ["1", "2"] },
      { cursor: [cursor, cursor] },
      { cursor: "client_page_100" },
      { offset: "0" }
    ]) {
      expect(() => selectedDeviceListQuerySchema.parse(candidate)).toThrow();
    }
  });

  it("requires one exact non-secret HTTP response with coherent opaque continuation", () => {
    const first = apiDeviceItem("client_a");
    const second = apiDeviceItem("client_b");
    expect(
      selectedDeviceListResponseSchema.parse({
        devices: [first, second],
        next_cursor: encodeSelectedDeviceListCursor("client_b"),
        has_more: true
      })
    ).toEqual({
      devices: [first, second],
      next_cursor: encodeSelectedDeviceListCursor("client_b"),
      has_more: true
    });
    expect(
      selectedDeviceListResponseSchema.parse({
        devices: [],
        next_cursor: null,
        has_more: false
      })
    ).toEqual({ devices: [], next_cursor: null, has_more: false });

    const invalid = [
      { devices: [second, first], next_cursor: null, has_more: false },
      { devices: [first, first], next_cursor: null, has_more: false },
      {
        devices: [first],
        next_cursor: encodeSelectedDeviceListCursor("client_b"),
        has_more: true
      },
      { devices: [first], next_cursor: null, has_more: true },
      {
        devices: [],
        next_cursor: encodeSelectedDeviceListCursor("client_a"),
        has_more: true
      },
      { devices: [first], next_cursor: null, has_more: false, total_count: 1 },
      {
        devices: [{ ...first, token_hash: "private" }],
        next_cursor: null,
        has_more: false
      },
      {
        devices: Array.from({ length: 101 }, (_, index) =>
          apiDeviceItem(`client_${index.toString().padStart(3, "0")}`)
        ),
        next_cursor: null,
        has_more: false
      }
    ];
    for (const candidate of invalid) {
      expect(() => selectedDeviceListResponseSchema.parse(candidate)).toThrow();
    }
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

function apiDeviceItem(deviceId: string) {
  return {
    device_id: deviceId,
    client_label: "Android phone",
    permission: "write" as const,
    created_at: createdAt,
    last_used_at: null,
    expires_at: null,
    revoked_at: null
  };
}
