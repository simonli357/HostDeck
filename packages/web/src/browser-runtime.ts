import { createSecureBrowserOperationId } from "./browser-operation-id.js";
import {
  type BrowserConnectionStateCoordinator,
  createBrowserConnectionStateCoordinator
} from "./connection-state.js";
import { createBrowserCsrfClient } from "./csrf-client.js";
import { createBrowserHttpClient } from "./http-client.js";
import { createBrowserSseClient } from "./sse-client.js";

export type BrowserConnectionCoordinatorFactory = () => BrowserConnectionStateCoordinator;

export function createProductionBrowserConnectionCoordinator(): BrowserConnectionStateCoordinator {
  const origin = globalThis.location?.origin;
  if (typeof origin !== "string") {
    throw new TypeError("HostDeck browser origin is unavailable.");
  }

  const httpClient = createBrowserHttpClient({ origin });
  let csrfClient: ReturnType<typeof createBrowserCsrfClient> | null = null;
  let sseClient: ReturnType<typeof createBrowserSseClient> | null = null;

  try {
    csrfClient = createBrowserCsrfClient({
      httpClient,
      createOperationId: () => createSecureBrowserOperationId("csrf_bootstrap")
    });
    sseClient = createBrowserSseClient({ origin });
    return createBrowserConnectionStateCoordinator({
      httpClient,
      sseClient,
      csrfClient,
      origin
    });
  } catch (error) {
    sseClient?.close();
    csrfClient?.close();
    throw error;
  }
}
