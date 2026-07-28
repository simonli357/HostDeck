import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  expect,
  type Page,
  type Request,
  type Response,
  test
} from "@playwright/test";
import { hostDeckStaticContentSecurityPolicy } from "../../packages/server/src/index.js";
import {
  installSessionDetailApi,
  sessionDetailBrowserSessionId
} from "./session-detail-fixture.js";

const packageRoot = join(process.cwd(), "dist", "hostdeck");
const packageManifest = JSON.parse(
  readFileSync(join(packageRoot, "hostdeck-package.json"), "utf8")
);
const webManifest = JSON.parse(
  readFileSync(join(packageRoot, packageManifest.web.manifestPath), "utf8")
);
const packageOrigin = "http://127.0.0.1:4183";

test("executes the relocated production package with strict browser policy", async ({
  page,
  request
}) => {
  const diagnostics = observeProductionPage(page);
  await page.addInitScript(() => {
    const runtime = window as typeof window & {
      __hostDeckCspViolations?: string[];
    };
    runtime.__hostDeckCspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      runtime.__hostDeckCspViolations?.push(
        `${event.effectiveDirective}:${event.blockedURI}`
      );
    });
  });
  const api = await installSessionDetailApi(page, "active", {
    configuredOrigin: packageOrigin
  });

  const rootResponse = await page.goto("/");
  expect(rootResponse).not.toBeNull();
  await expectProductionDocument(rootResponse as Response);
  await expect(
    page.getByRole("heading", { level: 1, name: "Mission Control" })
  ).toBeVisible();
  const dialogTrigger = page.getByRole("button", {
    name: "Open Host and access"
  });
  await dialogTrigger.click();
  await expect(page.getByRole("dialog", { name: "Host & access" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Host & access" })).toBeHidden();
  await expect.poll(() => diagnostics.pendingRequests.size).toBe(0);

  const detailResponse = await page.goto(
    `/sessions/${sessionDetailBrowserSessionId}`
  );
  expect(detailResponse).not.toBeNull();
  await expectProductionDocument(detailResponse as Response);
  await expect(
    page.getByText(
      "The structured mobile session feed is ready for device validation."
    )
  ).toBeVisible();
  await expect(page.getByRole("banner")).toContainText("android-release");

  const loadedAssetPaths = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .map((entry) => new URL(entry.name).pathname)
      .filter((path) => path.startsWith("/assets/"))
      .sort()
  );
  expect(loadedAssetPaths).toEqual(
    webManifest.entryAssets.map((path: string) => `/${path}`).sort()
  );
  for (const path of webManifest.entryAssets as string[]) {
    const response = diagnostics.responses.find(
      (candidate) => new URL(candidate.url()).pathname === `/${path}`
    );
    expect(response, `Browser did not load ${path}.`).toBeDefined();
    const descriptor = webManifest.assets.find(
      (asset: { path: string }) => asset.path === path
    );
    expect(descriptor).toBeDefined();
    expect(await response?.headerValue("cache-control")).toBe(
      "public, max-age=31536000, immutable"
    );
    expect(await response?.headerValue("content-type")).toMatch(
      new RegExp(`^${escapeRegExp(descriptor.mediaType)}\\b`, "u")
    );
    expect(await response?.headerValue("x-content-type-options")).toBe(
      "nosniff"
    );
  }

  const apiMiss = await request.get("/api/v1/package-browser-missing");
  expect(apiMiss.status()).toBe(404);
  expect(apiMiss.headers()["content-type"]).toMatch(/^application\/json\b/u);
  expect((await apiMiss.json()).error.code).toBe("route_not_found");

  const apiReads = new Set(
    api.requests.map((observed) => {
      const url = new URL(observed.url());
      return `${observed.method()} ${url.pathname}`;
    })
  );
  for (const expected of [
    "GET /api/v1/access",
    "GET /api/v1/sessions",
    `GET /api/v1/sessions/${sessionDetailBrowserSessionId}`
  ]) {
    expect(apiReads.has(expected), `Browser omitted ${expected}.`).toBe(true);
  }

  expect(diagnostics.externalRequests).toEqual([]);
  expect(diagnostics.networkFailures).toEqual([]);
  expect(diagnostics.abortedRequests).toEqual([
    `/api/v1/sessions/${sessionDetailBrowserSessionId}/approvals`
  ]);
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const runtime = window as typeof window & {
          __hostDeckCspViolations?: string[];
        };
        return {
          csp: runtime.__hostDeckCspViolations ?? [],
          local: localStorage.length,
          session: sessionStorage.length
        };
      })
    )
    .toEqual({ csp: [], local: 0, session: 0 });
});

async function expectProductionDocument(response: Response): Promise<void> {
  expect(response.status()).toBe(200);
  expect(await response.headerValue("content-type")).toMatch(/^text\/html\b/u);
  expect(await response.headerValue("cache-control")).toBe("no-store");
  expect(await response.headerValue("content-security-policy")).toBe(
    hostDeckStaticContentSecurityPolicy
  );
  expect(await response.headerValue("x-content-type-options")).toBe("nosniff");
}

function observeProductionPage(page: Page) {
  const responses: Response[] = [];
  const externalRequests: string[] = [];
  const abortedRequests: string[] = [];
  const networkFailures: string[] = [];
  const pendingRequests = new Set<Request>();
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("response", (response) => responses.push(response));
  page.on("request", (request) => {
    pendingRequests.add(request);
    const url = new URL(request.url());
    if (url.protocol.startsWith("http") && url.origin !== packageOrigin) {
      externalRequests.push(request.url());
    }
  });
  page.on("requestfinished", (request) => pendingRequests.delete(request));
  page.on("requestfailed", (request) => {
    pendingRequests.delete(request);
    const url = new URL(request.url());
    if (
      request.failure()?.errorText === "net::ERR_ABORTED" &&
      url.origin === packageOrigin &&
      url.pathname ===
        `/api/v1/sessions/${sessionDetailBrowserSessionId}/approvals`
    ) {
      abortedRequests.push(url.pathname);
      return;
    }
    networkFailures.push(`${request.url()}:${request.failure()?.errorText ?? "unknown"}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return {
    consoleErrors,
    externalRequests,
    abortedRequests,
    networkFailures,
    pageErrors,
    pendingRequests,
    responses
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
