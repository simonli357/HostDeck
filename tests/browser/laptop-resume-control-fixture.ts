import type { Page, Request } from "@playwright/test";
import {
  formatSelectedResumeLaunchCommand,
  selectedResumeMetadataResponseSchema,
  selectedResumeRemoteMaxLength
} from "../../packages/contracts/src/index.js";
import { sessionDetailBrowserSessionId } from "./session-detail-fixture.js";

export type LaptopResumeApiOutcome =
  | "available"
  | "unavailable"
  | "not_found"
  | "stale_session"
  | "runtime_unavailable"
  | "access_denied"
  | "timeout"
  | "storage"
  | "rate_limited"
  | "malformed"
  | "mismatch"
  | "wrong_thread"
  | "long_command"
  | "long_reason"
  | "pending";

export interface LaptopResumeApiController {
  readonly command: (long?: boolean) => string;
  readonly hasPendingRequest: () => boolean;
  readonly release: (outcome?: Exclude<LaptopResumeApiOutcome, "pending">) => void;
  readonly requests: () => readonly Request[];
  readonly setOutcome: (outcome: LaptopResumeApiOutcome) => void;
}

const threadId = "thread-private-browser-detail";
const socketPath = "/run/user/1000/hostdeck/private-app-server.sock";
const longSocketPrefix = `/run/user/1000/hostdeck/${"long-private-segment-".repeat(21)}`;
const longSocketSuffix = "app-server.sock";
const longSocketPath = `${longSocketPrefix}${"x".repeat(
  selectedResumeRemoteMaxLength - "unix://".length - longSocketPrefix.length - longSocketSuffix.length
)}${longSocketSuffix}`;
const unavailableReason = "The selected Codex runtime cannot provide a local laptop command.";
const longUnavailableReason = "Laptop resume is unavailable. ".padEnd(
  240,
  "Current runtime reason. "
);

export const laptopResumeBrowserCommand = availableResponse().command;
export const laptopResumeBrowserLongRemote = `unix://${longSocketPath}`;
export const laptopResumeBrowserLongCommand = availableResponse({
  socket: longSocketPath
}).command;
export const laptopResumeBrowserUnavailableReason = unavailableReason;
export const laptopResumeBrowserLongUnavailableReason = longUnavailableReason;

export async function installLaptopResumeApi(
  page: Page
): Promise<LaptopResumeApiController> {
  let outcome: LaptopResumeApiOutcome = "available";
  let pendingResolution: ((result: Exclude<LaptopResumeApiOutcome, "pending">) => void) | null =
    null;
  const captured: Request[] = [];
  const path = `/api/v1/sessions/${sessionDetailBrowserSessionId}/resume`;

  await page.route(`**${path}`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname !== path || url.search !== "" || request.method() !== "GET") {
      await route.fallback();
      return;
    }
    captured.push(request);

    let selectedOutcome = outcome;
    if (selectedOutcome === "pending") {
      if (pendingResolution !== null) {
        await route.fulfill({ status: 500, body: "duplicate pending laptop-resume read" });
        return;
      }
      selectedOutcome = await new Promise<Exclude<LaptopResumeApiOutcome, "pending">>(
        (resolve) => {
          pendingResolution = resolve;
        }
      );
      pendingResolution = null;
    }
    await fulfillOutcome(route, selectedOutcome);
  });

  return Object.freeze({
    command: (long = false) =>
      long ? laptopResumeBrowserLongCommand : laptopResumeBrowserCommand,
    hasPendingRequest: () => pendingResolution !== null,
    release(selectedOutcome: Exclude<LaptopResumeApiOutcome, "pending"> = "available") {
      if (pendingResolution === null) {
        throw new TypeError("No pending laptop-resume read exists.");
      }
      pendingResolution(selectedOutcome);
    },
    requests: () => Object.freeze([...captured]),
    setOutcome(selectedOutcome: LaptopResumeApiOutcome) {
      if (pendingResolution !== null) {
        throw new TypeError("A laptop-resume read is already pending.");
      }
      outcome = selectedOutcome;
    }
  });
}

async function fulfillOutcome(
  route: Parameters<Parameters<Page["route"]>[1]>[0],
  outcome: Exclude<LaptopResumeApiOutcome, "pending">
): Promise<void> {
  const error = errorForOutcome(outcome);
  if (error !== null) {
    await fulfillJson(route, { error: error.body }, error.status);
    return;
  }
  if (outcome === "unavailable" || outcome === "long_reason") {
    await fulfillJson(
      route,
      selectedResumeMetadataResponseSchema.parse({
        session_id: sessionDetailBrowserSessionId,
        local_only: true,
        available: false,
        command: null,
        launch: null,
        unavailable_reason: outcome === "long_reason" ? longUnavailableReason : unavailableReason
      })
    );
    return;
  }
  if (outcome === "malformed") {
    await fulfillJson(route, { ...availableResponse(), private_extra: "/private/malformed" });
    return;
  }
  if (outcome === "mismatch") {
    await fulfillJson(route, availableResponse({ session: "sess_browser_resume_foreign_001" }));
    return;
  }
  if (outcome === "wrong_thread") {
    await fulfillJson(
      route,
      availableResponse({ thread: "thread-private-browser-resume-foreign" })
    );
    return;
  }
  await fulfillJson(
    route,
    availableResponse({
      socket: outcome === "long_command" ? longSocketPath : socketPath
    })
  );
}

function availableResponse(input: Readonly<{
  session?: string;
  socket?: string;
  thread?: string;
}> = {}) {
  const launch = {
    executable: "codex",
    args: [
      "resume",
      "--remote",
      `unix://${input.socket ?? socketPath}`,
      input.thread ?? threadId
    ]
  } as const;
  const parsed = selectedResumeMetadataResponseSchema.parse({
    session_id: input.session ?? sessionDetailBrowserSessionId,
    local_only: true,
    available: true,
    command: formatSelectedResumeLaunchCommand(launch),
    launch,
    unavailable_reason: null
  });
  const exactCommand = parsed.command;
  if (!parsed.available || typeof exactCommand !== "string") {
    throw new TypeError("Laptop-resume browser fixture command is unavailable.");
  }
  return Object.freeze({ ...parsed, command: exactCommand });
}

function errorForOutcome(
  outcome: Exclude<LaptopResumeApiOutcome, "pending">
): Readonly<{
  body: Readonly<{ code: string; message: string; retryable: boolean }>;
  status: number;
}> | null {
  const privateMessage = "PRIVATE resume fixture path /workspace/resume must never render.";
  switch (outcome) {
    case "available":
    case "unavailable":
    case "malformed":
    case "mismatch":
    case "wrong_thread":
    case "long_command":
    case "long_reason":
      return null;
    case "not_found":
      return error(404, "session_not_found", privateMessage, false);
    case "stale_session":
      return error(409, "stale_session", privateMessage, false);
    case "runtime_unavailable":
      return error(503, "runtime_unavailable", privateMessage, true);
    case "access_denied":
      return error(403, "permission_denied", privateMessage, false);
    case "timeout":
      return error(504, "operation_timeout", privateMessage, true);
    case "storage":
      return error(500, "storage_error", privateMessage, true);
    case "rate_limited":
      return error(429, "rate_limited", privateMessage, true);
  }
}

function error(
  status: number,
  code: string,
  message: string,
  retryable: boolean
) {
  return Object.freeze({
    body: Object.freeze({ code, message, retryable }),
    status
  });
}

async function fulfillJson(
  route: Parameters<Parameters<Page["route"]>[1]>[0],
  body: unknown,
  status = 200
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body)
  });
}
