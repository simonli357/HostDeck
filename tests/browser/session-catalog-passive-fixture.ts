import type { Page } from "@playwright/test";

export async function installPassiveSessionCatalog(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    const encoder = new TextEncoder();
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
      let activeController: ReadableStreamDefaultController<Uint8Array> | null =
        null;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          activeController = controller;
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        },
        cancel() {
          activeController = null;
        }
      });
      const abort = () => {
        if (activeController === null) return;
        try {
          activeController.close();
        } catch {
          // The browser reader may already own terminal cleanup.
        }
        activeController = null;
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
}
