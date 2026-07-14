import { describe, expect, it } from "vitest";
import {
  createSelectedPairingLink,
  selectedPairingFragmentSchema,
  selectedPairingLinkMaxLength,
  selectedPairingLinkSchema
} from "./pairing-link.js";

const origin = "https://private-laptop.fixture-tailnet.ts.net";
const code = "AbCdEfGhIjKlMnOpQrSt_1";
const link = `${origin}/#pair=${code}`;

describe("selected remote pairing link contract", () => {
  it("builds one canonical root link with the raw code only in the fragment", () => {
    const result = createSelectedPairingLink({ external_origin: origin, code });

    expect(result).toBe(link);
    expect(new URL(result)).toMatchObject({
      origin,
      pathname: "/",
      search: "",
      hash: `#pair=${code}`
    });
    expect(result).toHaveLength(origin.length + 29);
    expect(result.length).toBeLessThanOrEqual(selectedPairingLinkMaxLength);
  });

  it("accepts only one exact unencoded pairing fragment", () => {
    expect(selectedPairingFragmentSchema.parse(`#pair=${code}`)).toBe(`#pair=${code}`);

    for (const candidate of [
      "",
      "pair=AbCdEfGhIjKlMnOpQrSt_1",
      "#Pair=AbCdEfGhIjKlMnOpQrSt_1",
      "#pair=short",
      "#pair=AbCdEfGhIjKlMnOpQrSt%5F1",
      "#pair=AbCdEfGhIjKlMnOpQrSt_1&extra=1",
      "#pair=AbCdEfGhIjKlMnOpQrSt_1#again"
    ]) {
      expect(selectedPairingFragmentSchema.safeParse(candidate).success, candidate).toBe(false);
    }
  });

  it("rejects every form that could move or duplicate the secret", () => {
    for (const candidate of [
      `${origin}?pair=${code}`,
      `${origin}/pair/${code}`,
      `${origin}/dashboard#pair=${code}`,
      `${origin}/?next=/#pair=${code}`,
      `${origin}/#code=${code}`,
      `${origin}/#pair=${code}&pair=${code}`,
      `${origin}/#pair=${code.replace("_", "%5F")}`,
      `http://private-laptop.fixture-tailnet.ts.net/#pair=${code}`,
      `https://private-laptop.fixture-tailnet.ts.net:444/#pair=${code}`,
      `https://user@private-laptop.fixture-tailnet.ts.net/#pair=${code}`,
      `https://private-laptop.example.com/#pair=${code}`,
      `javascript:#pair=${code}`,
      `${link}/`
    ]) {
      expect(selectedPairingLinkSchema.safeParse(candidate).success, candidate).toBe(false);
    }
  });

  it("rejects malformed constructor input rather than normalizing it", () => {
    for (const candidate of [
      { external_origin: `${origin}/`, code },
      { external_origin: origin, code: "too-short" },
      { external_origin: origin, code, extra: true }
    ]) {
      expect(() => createSelectedPairingLink(candidate as never)).toThrow();
    }
  });
});
