import { clientOperationIdSchema } from "@hostdeck/contracts";

export const browserOperationIdScopes = Object.freeze([
  "pair_claim",
  "csrf_bootstrap"
] as const);

export type BrowserOperationIdScope = (typeof browserOperationIdScopes)[number];

export function createSecureBrowserOperationId(scope: BrowserOperationIdScope): string {
  if (!browserOperationIdScopes.includes(scope)) {
    throw new TypeError("HostDeck browser operation-id scope is invalid.");
  }
  const cryptoPort = globalThis.crypto;
  const randomUuid = cryptoPort?.randomUUID;
  if (typeof randomUuid !== "function") {
    throw new TypeError("Secure browser operation-id generation is unavailable.");
  }

  let uuid: unknown;
  try {
    uuid = Reflect.apply(randomUuid, cryptoPort, []);
  } catch {
    throw new TypeError("Secure browser operation-id generation failed.");
  }
  if (typeof uuid !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(uuid)) {
    throw new TypeError("Secure browser operation-id generation returned invalid data.");
  }

  return clientOperationIdSchema.parse(
    `op_browser_${scope}_${uuid.replaceAll("-", "")}`
  );
}
