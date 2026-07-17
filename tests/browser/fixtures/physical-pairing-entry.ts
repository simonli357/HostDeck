import {
  selectedAccessStateResponseSchema,
  selectedCsrfBootstrapResponseSchema,
  selectedDeviceRevokeResponseSchema,
  selectedHostLockStateResponseSchema
} from "../../../packages/contracts/src/index.js";
import {
  type BrowserPairingOperation,
  type BrowserPairingResponsePort,
  bootstrapBrowserPairing,
  bootstrapWindowPairing
} from "../../../packages/web/src/pairing-bootstrap.js";

type PhysicalCheckpoint =
  | "paired"
  | "reloaded"
  | "started"
  | "locked"
  | "unlocked"
  | "stream-ready"
  | "away-ready"
  | "recovered";

type PhysicalCommand = "hold" | "prepare-away" | "revoke" | "cleanup";

interface PhysicalSseState {
  errors: number;
  events: number;
  heartbeats: number;
  streamFailure: boolean;
}

const requestBase = Object.freeze({
  cache: "no-store" as const,
  credentials: "include" as const,
  redirect: "error" as const,
  referrerPolicy: "no-referrer" as const
});
const commandPath = "/__physical/command";
const protectedPath = "/__physical/protected";
let activeEventSource: EventSource | null = null;
let activeHeartbeat: AbortController | null = null;
let initialFragment = window.location.hash;
let fragmentScrubbed = true;

if (initialFragment !== "") {
  try {
    window.history.replaceState(window.history.state, "", "/");
  } catch {
    initialFragment = "";
    fragmentScrubbed = false;
  }
}

void (fragmentScrubbed
  ? runPhysicalAcceptance(initialFragment)
  : Promise.reject(new Error("Pairing fragment could not be removed.")))
  .catch(() => renderFailure())
  .finally(() => {
    initialFragment = "";
  });

async function runPhysicalAcceptance(fragment: string): Promise<void> {
  renderState("Starting", "Checking the private phone connection.", "starting");
  if (fragment !== "") {
    await runPairingEntry(fragment);
    return;
  }

  const bootstrap = await bootstrapWindowPairing();
  requireCondition(
    bootstrap.state === "no_fragment",
    "Reload did not start fragment-free."
  );
  await requireSecretFreeBrowserState();
  requireCondition(
    (await requestStatus(protectedPath)) === 200,
    "Reload lost device authority."
  );
  await sendCheckpoint("reloaded");
  await waitForStartOrCleanup();
}

async function runPairingEntry(fragment: string): Promise<void> {
  requireCondition(window.location.hash === "", "Pairing fragment remained visible.");
  await requireSecretFreeBrowserState();
  requireCondition(
    (await requestStatus(protectedPath)) === 401,
    "Unpaired access reached protected data."
  );

  let retainedFragment = fragment;
  fragment = "";
  const result = await bootstrapBrowserPairing({
    location: {
      origin: window.location.origin,
      pathname: window.location.pathname,
      search: window.location.search,
      get hash() {
        const value = retainedFragment;
        retainedFragment = "";
        return value;
      }
    },
    history: {
      get state() {
        return window.history.state as unknown;
      },
      replaceState(data, unused, url) {
        window.history.replaceState(data, unused, url);
      }
    },
    fetch: async (path, init) =>
      (await window.fetch(path, init)) as unknown as BrowserPairingResponsePort,
    createOperationId(operation: BrowserPairingOperation) {
      return operation === "pair_claim"
        ? "op_physical_pair_claim_browser_0001"
        : "op_physical_pair_csrf_browser_0001";
    }
  });
  retainedFragment = "";
  requireCondition(
    result.state === "paired" &&
      result.permission === "write" &&
      Number.isSafeInteger(result.csrf_generation) &&
      result.csrf_generation > 0,
    "Pairing did not create writer authority."
  );
  await requireSecretFreeBrowserState();
  requireCondition(
    (await requestStatus(protectedPath)) === 200,
    "Paired authority did not reach protected data."
  );
  renderState("Paired", "Reloading without the pairing link.", "paired");
  await sendCheckpoint("paired");
  window.location.reload();
}

async function waitForStartOrCleanup(): Promise<void> {
  renderState(
    "Ready on this phone",
    "Tap Start check to validate remote access.",
    "ready"
  );
  const button = requireStartButton();
  button.hidden = false;

  let started = false;
  let fullscreenRequest: Promise<boolean> | null = null;
  const start = () => {
    started = true;
    fullscreenRequest = enterFullscreen().then(
      () => true,
      () => false
    );
  };
  button.addEventListener("click", start, { once: true });
  let selected: "start" | "cleanup" | null = null;
  const deadline = Date.now() + 5 * 60_000;
  while (selected === null && Date.now() < deadline) {
    if (started) {
      selected = "start";
      break;
    }
    if ((await readCommand()) === "cleanup") {
      selected = "cleanup";
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  button.removeEventListener("click", start);
  requireCondition(selected !== null, "Acceptance start timed out.");
  button.hidden = true;

  if (selected === "cleanup") {
    await revokeAndClean();
    return;
  }
  requireCondition(
    fullscreenRequest !== null && (await fullscreenRequest),
    "Phone acceptance did not enter fullscreen."
  );
  renderState("Running", "Validating writer authority.", "running");
  await afterPaint();
  await sendCheckpoint("started");
  await runSecuritySequence();
}

async function runSecuritySequence(): Promise<void> {
  const csrf = await bootstrapCsrf("op_physical_lock_csrf_0001");
  const headers = csrfHeaders(csrf.csrf_token, csrf.csrf_generation);
  const lockResponse = await window.fetch("/api/v1/access/lock", {
    ...requestBase,
    method: "POST",
    headers,
    body: JSON.stringify({
      operation_id: "op_physical_host_lock_0001",
      confirmed: true
    })
  });
  const lock = selectedHostLockStateResponseSchema.parse(
    await requireJson(lockResponse, 200)
  );
  requireCondition(lock.locked, "Writer lock did not persist.");
  requireCondition(
    (await requestStatus(protectedPath)) === 200,
    "Host lock blocked a protected read."
  );
  requireCondition(
    (await window.fetch("/api/v1/access/unlock", {
      ...requestBase,
      method: "POST",
      headers,
      body: JSON.stringify({
        operation_id: "op_physical_remote_unlock_0001",
        confirmed: true
      })
    })).status === 403,
    "Remote writer unexpectedly unlocked the host."
  );
  await sendCheckpoint("locked");

  await waitForCondition(async () => {
    const response = await window.fetch("/api/v1/access", requestBase);
    if (response.status !== 200) return false;
    return !selectedAccessStateResponseSchema.parse(await response.json()).locked;
  }, 60_000);
  requireCondition(
    (await requestStatus(protectedPath)) === 200,
    "Local unlock did not preserve protected reads."
  );
  await sendCheckpoint("unlocked");

  const sse = startPhysicalSse();
  await waitForCondition(
    () =>
      sse.events >= 1 &&
      sse.heartbeats >= 1 &&
      !sse.streamFailure &&
      activeEventSource?.readyState === EventSource.OPEN,
    45_000
  );
  renderState(
    "Paired and ready",
    "Writer authority, protected reads, and live updates are ready.",
    "paired_ready"
  );
  await afterPaint();
  await sendCheckpoint("stream-ready");

  await waitForCommand("prepare-away", 5 * 60_000);
  const eventsBeforeAway = sse.events;
  renderState(
    "Saved profile away",
    "Private phone access is closed. Laptop control remains local.",
    "profile_away"
  );
  await afterPaint();
  await sendCheckpoint("away-ready");
  await waitForCondition(() => sse.errors >= 1, 45_000);
  requireCondition(
    (await requestStatus(protectedPath, 3_000)) !== 200,
    "Protected data succeeded during the away interval."
  );
  await waitForCondition(
    () =>
      sse.events > eventsBeforeAway &&
      activeEventSource?.readyState === EventSource.OPEN,
    90_000
  );
  requireCondition(
    (await requestStatus(protectedPath)) === 200,
    "Recovered connection lost device authority."
  );
  renderState(
    "Connection recovered",
    "Private access and live updates recovered without another pairing.",
    "recovered"
  );
  await afterPaint();
  await sendCheckpoint("recovered");

  await waitForCommand("revoke", 5 * 60_000);
  await revokeAndClean();
}

function startPhysicalSse(): PhysicalSseState {
  activeEventSource?.close();
  activeHeartbeat?.abort();
  const state: PhysicalSseState = {
    errors: 0,
    events: 0,
    heartbeats: 0,
    streamFailure: false
  };
  const source = new EventSource("/__physical/events", {
    withCredentials: true
  });
  activeEventSource = source;
  source.onmessage = () => {
    state.events += 1;
  };
  source.onerror = () => {
    state.errors += 1;
  };

  const controller = new AbortController();
  activeHeartbeat = controller;
  void window.fetch("/__physical/events", {
    ...requestBase,
    headers: { accept: "text/event-stream" },
    signal: controller.signal
  }).then(async (response) => {
    if (!response.ok || response.body === null) {
      state.streamFailure = true;
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let retained = "";
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      retained = (retained + decoder.decode(next.value, { stream: true })).slice(
        -4096
      );
      if (retained.includes(": heartbeat")) {
        state.heartbeats += 1;
        controller.abort();
        return;
      }
    }
    state.streamFailure = state.heartbeats === 0;
  }).catch(() => {
    if (state.heartbeats === 0 && !controller.signal.aborted) {
      state.streamFailure = true;
    }
  });
  return state;
}

async function revokeAndClean(): Promise<void> {
  const csrf = await bootstrapCsrf("op_physical_revoke_csrf_0001");
  const accessResponse = await window.fetch("/api/v1/access", requestBase);
  const access = selectedAccessStateResponseSchema.parse(
    await requireJson(accessResponse, 200)
  );
  requireCondition(
    access.authentication_state === "paired_device" &&
      access.permission === "write" &&
      access.device_id !== null,
    "Current writer authority was unavailable for revocation."
  );
  const revokeResponse = await window.fetch(
    `/api/v1/access/devices/${encodeURIComponent(access.device_id)}/revoke`,
    {
      ...requestBase,
      method: "POST",
      headers: csrfHeaders(csrf.csrf_token, csrf.csrf_generation),
      body: JSON.stringify({
        operation_id: "op_physical_self_revoke_0001",
        confirmed: true
      })
    }
  );
  const revoked = selectedDeviceRevokeResponseSchema.parse(
    await requireJson(revokeResponse, 200)
  );
  requireCondition(
    revoked.device_id === access.device_id &&
      revoked.authority_invalidated &&
      revoked.self_revoked,
    "Self-revocation response was inconsistent."
  );
  requireCondition(
    (await requestStatus(protectedPath)) === 401,
    "Revoked authority retained protected reads."
  );
  requireCondition(
    (await window.fetch("/api/v1/access/csrf", {
      ...requestBase,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operation_id: "op_physical_revoked_csrf_0001"
      })
    })).status === 401,
    "Revoked authority retained CSRF bootstrap."
  );
  activeEventSource?.close();
  activeEventSource = null;
  activeHeartbeat?.abort();
  activeHeartbeat = null;
  await clearBrowserStorage();
  await requireSecretFreeBrowserState();
  renderState(
    "Revoked and cleaned",
    "Device authority was removed and private state was cleared.",
    "revoked_cleaned"
  );
  await afterPaint();
  requireCondition(
    (await requestStatus("/__physical/checkpoint/revoked")) === 401,
    "Revoked checkpoint unexpectedly retained device authority."
  );
}

async function bootstrapCsrf(operationId: string) {
  const response = await window.fetch("/api/v1/access/csrf", {
    ...requestBase,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation_id: operationId })
  });
  return selectedCsrfBootstrapResponseSchema.parse(
    await requireJson(response, 200)
  );
}

function csrfHeaders(
  token: string,
  generation: number
): Readonly<Record<string, string>> {
  return Object.freeze({
    "content-type": "application/json",
    "x-hostdeck-csrf": token,
    "x-hostdeck-csrf-generation": String(generation)
  });
}

async function sendCheckpoint(checkpoint: PhysicalCheckpoint): Promise<void> {
  requireCondition(
    (await requestStatus(`/__physical/checkpoint/${checkpoint}`)) === 204,
    "Acceptance checkpoint was rejected."
  );
}

async function waitForCommand(
  expected: Exclude<PhysicalCommand, "hold">,
  timeoutMs: number
): Promise<void> {
  await waitForCondition(async () => (await readCommand()) === expected, timeoutMs);
}

async function readCommand(): Promise<PhysicalCommand> {
  const response = await window.fetch(commandPath, requestBase);
  const body = await requireJson(response, 200);
  requireCondition(
    body !== null &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      Object.keys(body).sort().join(",") === "command,revision" &&
      Number.isSafeInteger((body as { revision?: unknown }).revision) &&
      (body as { revision: number }).revision >= 0,
    "Acceptance command response was malformed."
  );
  const command = (body as { command?: unknown }).command;
  requireCondition(
    command === "hold" ||
      command === "prepare-away" ||
      command === "revoke" ||
      command === "cleanup",
    "Acceptance command was invalid."
  );
  return command;
}

async function requestStatus(path: string, timeoutMs = 10_000): Promise<number> {
  try {
    return (
      await window.fetch(path, {
        ...requestBase,
        signal: AbortSignal.timeout(timeoutMs)
      })
    ).status;
  } catch {
    return -1;
  }
}

async function requireJson(response: Response, status: number): Promise<unknown> {
  requireCondition(response.status === status, "Acceptance request status was invalid.");
  const contentType = response.headers.get("content-type") ?? "";
  requireCondition(
    contentType.toLowerCase().startsWith("application/json"),
    "Acceptance response was not JSON."
  );
  return response.json() as Promise<unknown>;
}

async function requireSecretFreeBrowserState(): Promise<void> {
  const databases = await indexedDB.databases();
  const registrations = await navigator.serviceWorker.getRegistrations();
  requireCondition(
    window.location.hash === "" &&
      window.location.pathname === "/" &&
      window.location.search === "" &&
      document.cookie === "" &&
      localStorage.length === 0 &&
      sessionStorage.length === 0 &&
      databases.length === 0 &&
      (await caches.keys()).length === 0 &&
      registrations.length === 0 &&
      !document.body.innerText.includes("#pair=") &&
      !document.referrer.includes("#pair=") &&
      !performance
        .getEntriesByType("resource")
        .some((entry) => entry.name.includes("#pair=")),
    "Browser privacy state was invalid."
  );
}

async function clearBrowserStorage(): Promise<void> {
  localStorage.clear();
  sessionStorage.clear();
  await Promise.all((await caches.keys()).map((name) => caches.delete(name)));
  await Promise.all(
    (await navigator.serviceWorker.getRegistrations()).map((registration) =>
      registration.unregister()
    )
  );
  for (const database of await indexedDB.databases()) {
    if (typeof database.name !== "string") continue;
    await new Promise<void>((resolve, reject) => {
      const pending = indexedDB.deleteDatabase(database.name as string);
      pending.onsuccess = () => resolve();
      pending.onerror = () => reject(new Error("IndexedDB cleanup failed."));
      pending.onblocked = () => reject(new Error("IndexedDB cleanup was blocked."));
    });
  }
}

async function enterFullscreen(): Promise<void> {
  await document.documentElement.requestFullscreen();
  requireCondition(
    document.fullscreenElement === document.documentElement,
    "Phone acceptance did not enter fullscreen."
  );
}

async function afterPaint(): Promise<void> {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Acceptance condition timed out.");
}

function renderState(title: string, detail: string, state: string): void {
  const status = document.querySelector("#status");
  const detailNode = document.querySelector("#detail");
  requireCondition(
    status instanceof HTMLElement && detailNode instanceof HTMLElement,
    "Acceptance display was unavailable."
  );
  document.documentElement.dataset.acceptanceState = state;
  status.textContent = title;
  detailNode.textContent = detail;
}

function renderFailure(): void {
  activeEventSource?.close();
  activeHeartbeat?.abort();
  const button = document.querySelector("#start");
  if (button instanceof HTMLButtonElement) button.hidden = true;
  const status = document.querySelector("#status");
  const detail = document.querySelector("#detail");
  document.documentElement.dataset.acceptanceState = "failed";
  if (status !== null) status.textContent = "Check failed";
  if (detail !== null) detail.textContent = "Acceptance stopped safely.";
}

function requireStartButton(): HTMLButtonElement {
  const button = document.querySelector("#start");
  requireCondition(
    button instanceof HTMLButtonElement,
    "Acceptance start control was unavailable."
  );
  return button;
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
