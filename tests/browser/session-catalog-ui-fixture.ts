import type { Page } from "@playwright/test";
import type { SessionCatalogEvent } from "../../packages/contracts/src/index.js";

export interface SessionCatalogBrowserController {
  readonly push: (event: SessionCatalogEvent) => Promise<void>;
  readonly closeConnections: () => Promise<void>;
  readonly requestUrls: () => Promise<readonly string[]>;
}

export async function installSessionCatalogBrowserStream(
  page: Page
): Promise<SessionCatalogBrowserController> {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    const encoder = new TextEncoder();
    const controllers = new Set<ReadableStreamDefaultController<Uint8Array>>();
    const requests: string[] = [];
    const frame = (event: SessionCatalogEvent) =>
      `id: ${String(event.cursor)}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

    Object.defineProperty(window, "__hostdeckSessionCatalogSse", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: Object.freeze({
        requests,
        push(event: SessionCatalogEvent) {
          const bytes = encoder.encode(frame(event));
          for (const controller of [...controllers]) {
            try {
              controller.enqueue(bytes);
            } catch {
              controllers.delete(controller);
            }
          }
        },
        closeConnections() {
          for (const controller of [...controllers]) {
            try {
              controller.close();
            } catch {
              // The browser reader may already own terminal cleanup.
            }
          }
          controllers.clear();
        }
      })
    });

    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl =
        typeof input === "string"
          ? new URL(input, window.location.href)
          : input instanceof URL
            ? input
            : new URL(input.url, window.location.href);
      if (requestUrl.pathname !== "/api/v1/sessions/catalog/stream") {
        return originalFetch(input, init);
      }
      requests.push(requestUrl.href);
      let activeController: ReadableStreamDefaultController<Uint8Array> | null =
        null;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          activeController = controller;
          controllers.add(controller);
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        },
        cancel() {
          if (activeController !== null) controllers.delete(activeController);
        }
      });
      const abort = () => {
        if (activeController === null) return;
        controllers.delete(activeController);
        try {
          activeController.close();
        } catch {
          // The browser reader may already own terminal cleanup.
        }
      };
      if (init?.signal?.aborted === true) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: {
            "cache-control": "no-store",
            "content-type": "text/event-stream"
          }
        })
      );
    };
  });

  return Object.freeze({
    async push(event: SessionCatalogEvent) {
      await page.evaluate((nextEvent) => {
        const runtime = (
          window as typeof window & {
            __hostdeckSessionCatalogSse?: {
              readonly push: (candidate: SessionCatalogEvent) => void;
            };
          }
        ).__hostdeckSessionCatalogSse;
        if (runtime === undefined) {
          throw new TypeError("Session catalog SSE fixture is missing.");
        }
        runtime.push(nextEvent);
      }, event);
    },
    async closeConnections() {
      await page.evaluate(() => {
        const runtime = (
          window as typeof window & {
            __hostdeckSessionCatalogSse?: {
              readonly closeConnections: () => void;
            };
          }
        ).__hostdeckSessionCatalogSse;
        if (runtime === undefined) {
          throw new TypeError("Session catalog SSE fixture is missing.");
        }
        runtime.closeConnections();
      });
    },
    async requestUrls() {
      return page.evaluate(() => {
        const runtime = (
          window as typeof window & {
            __hostdeckSessionCatalogSse?: {
              readonly requests: readonly string[];
            };
          }
        ).__hostdeckSessionCatalogSse;
        if (runtime === undefined) {
          throw new TypeError("Session catalog SSE fixture is missing.");
        }
        return [...runtime.requests];
      });
    }
  });
}
