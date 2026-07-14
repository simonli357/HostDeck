import { type BrowserContext, expect, type Page, type Request, test } from "@playwright/test";

const code = "AbCdEfGhIjKlMnOpQrSt_1";
const fragment = `#pair=${code}`;
const csrfToken = "C".repeat(43);
const claimResponse = {
  device_id: "client_abcdefghijklmnopqrstuvwx",
  permission: "write",
  client_label: "Android phone",
  created_at: "2026-07-13T22:01:00.000Z",
  expires_at: "2026-10-11T22:01:00.000Z",
  csrf_bootstrap_required: true
};
const csrfResponse = {
  csrf_token: csrfToken,
  csrf_generation: 2,
  rotated_at: "2026-07-13T22:01:01.000Z"
};

test("scrubs the real URL before no-referrer claim and survives reload/back/forward", async ({
  page
}) => {
  const requests: Request[] = [];
  await page.route("**/api/v1/access/**", async (route) => {
    const request = route.request();
    requests.push(request);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        request.url().endsWith("/pairing-claims") ? claimResponse : csrfResponse
      )
    });
  });
  await page.goto("/?previous=1");
  await page.goto(`/${fragment}`);

  const result = await runPairing(page);

  expect(result).toMatchObject({ state: "paired", csrf_generation: 2 });
  expect(await immediateUrl(page)).toBe("http://127.0.0.1:4179/");
  expect(page.url()).toBe("http://127.0.0.1:4179/");
  expect(requests).toHaveLength(2);
  expect(requests.every((request) => !request.url().includes(code))).toBe(true);
  expect(requests.every((request) => request.headers().referer === undefined)).toBe(true);
  expect(requests[0]?.postData()).toContain(code);
  expect(requests[1]?.postData()).not.toContain(code);

  await page.reload();
  await expect(runPairing(page)).resolves.toEqual({ state: "no_fragment" });
  expect(requests).toHaveLength(2);

  await page.goBack();
  expect(page.url()).toBe("http://127.0.0.1:4179/?previous=1");
  expect(page.url()).not.toContain(code);
  await page.goForward();
  expect(page.url()).toBe("http://127.0.0.1:4179/");
  await expect(runPairing(page)).resolves.toEqual({ state: "no_fragment" });
  expect(requests).toHaveLength(2);
});

test("two real tabs race one code and only one reaches CSRF bootstrap", async ({ context }) => {
  let consumed = false;
  let devicesCreated = 0;
  let claimRequests = 0;
  let csrfRequests = 0;
  await installSharedClaimRoutes(context, async (request) => {
    if (request.url().endsWith("/csrf")) {
      csrfRequests += 1;
      return { status: 200, body: csrfResponse };
    }
    claimRequests += 1;
    if (consumed) {
      return {
        status: 401,
        body: {
          error: {
            code: "permission_denied",
            message: "Pairing claim was not accepted.",
            retryable: false
          }
        }
      };
    }
    consumed = true;
    devicesCreated += 1;
    return { status: 200, body: claimResponse };
  });
  const first = await context.newPage();
  const second = await context.newPage();
  await Promise.all([first.goto(`/${fragment}`), second.goto(`/${fragment}`)]);

  const results = await Promise.all([runPairing(first), runPairing(second)]);

  expect(results.map((result) => result.state).sort()).toEqual(["claim_rejected", "paired"]);
  expect(devicesCreated).toBe(1);
  expect(claimRequests).toBe(2);
  expect(csrfRequests).toBe(1);
  expect(first.url()).toBe("http://127.0.0.1:4179/");
  expect(second.url()).toBe("http://127.0.0.1:4179/");
});

test("a browser network failure is one unknown claim with a scrubbed URL", async ({ page }) => {
  let claimRequests = 0;
  await page.route("**/api/v1/access/pairing-claims", async (route) => {
    claimRequests += 1;
    await route.abort("failed");
  });
  await page.goto(`/${fragment}`);

  const result = await runPairing(page);

  expect(result).toEqual({ state: "claim_unknown" });
  expect(claimRequests).toBe(1);
  expect(page.url()).toBe("http://127.0.0.1:4179/");
  expect(JSON.stringify(result)).not.toContain(code);
});

async function runPairing(page: Page): Promise<Record<string, unknown>> {
  return await page.evaluate(async () => {
    const harness = (window as unknown as {
      readonly hostDeckPairingTest: {
        readonly run: () => Promise<Record<string, unknown>>;
      };
    }).hostDeckPairingTest;
    return await harness.run();
  });
}

async function immediateUrl(page: Page): Promise<string | null> {
  return await page.evaluate(() =>
    (window as unknown as {
      readonly hostDeckPairingTest: { readonly urlImmediatelyAfterStart: string | null };
    }).hostDeckPairingTest.urlImmediatelyAfterStart
  );
}

async function installSharedClaimRoutes(
  context: BrowserContext,
  respond: (request: Request) => Promise<{
    readonly status: number;
    readonly body: unknown;
  }>
): Promise<void> {
  await context.route("**/api/v1/access/**", async (route) => {
    const response = await respond(route.request());
    await route.fulfill({
      status: response.status,
      contentType: "application/json",
      body: JSON.stringify(response.body)
    });
  });
}
