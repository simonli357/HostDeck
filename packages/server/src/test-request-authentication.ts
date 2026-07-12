import { createHostDeckRequestAuthenticationPolicy } from "./fastify-request-authentication.js";

export const testRequestAuthenticationPolicy =
  createHostDeckRequestAuthenticationPolicy({
    authenticateDeviceToken() {
      throw new Error("Unexpected device authentication in an unrelated test.");
    },
    now: () => new Date("2026-07-11T20:00:00.000Z")
  });
