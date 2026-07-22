import {
  hostDeckLoopbackOriginSchema,
  remoteExternalOriginSchema
} from "@hostdeck/contracts";

export type BrowserTransport = "http" | "https";

export interface SelectedBrowserOrigin {
  readonly origin: string;
  readonly transport: BrowserTransport;
}

export function readSelectedBrowserOrigin(
  candidate: unknown
): SelectedBrowserOrigin {
  const value =
    candidate === undefined
      ? typeof globalThis.location?.origin === "string"
        ? globalThis.location.origin
        : undefined
      : candidate;
  if (typeof value !== "string") {
    throw new TypeError("HostDeck browser current origin is unavailable.");
  }
  if (hostDeckLoopbackOriginSchema.safeParse(value).success) {
    return Object.freeze({ origin: value, transport: "http" });
  }
  if (remoteExternalOriginSchema.safeParse(value).success) {
    return Object.freeze({ origin: value, transport: "https" });
  }
  throw new TypeError("HostDeck browser current origin is not selected.");
}
