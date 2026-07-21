import {
  clientOperationIdSchema,
  selectedStartSessionRequestSchema
} from "@hostdeck/contracts";
import { selectedApiRouteManifest } from "@hostdeck/server";
import { describe, expect, it } from "vitest";
import type { HttpFetch, HttpResponse } from "./api-client.js";
import {
  createHostDeckApprovalClient,
  type HostDeckApprovalClientResponseRequest
} from "./approval-client.js";
import {
  createHostDeckArchiveClient,
  type HostDeckArchiveClientRequest
} from "./archive-client.js";
import {
  createHostDeckCompactClient,
  type HostDeckCompactClientStartRequest
} from "./compact-client.js";
import {
  createHostDeckGoalClient,
  type HostDeckGoalClientMutationRequest
} from "./goal-client.js";
import { createHostDeckHostLockClient } from "./host-lock-client.js";
import {
  createHostDeckInterruptClient,
  type HostDeckInterruptClientRequest
} from "./interrupt-client.js";
import {
  createHostDeckModelClient,
  type HostDeckModelClientSelectionRequest
} from "./model-client.js";
import { createHostDeckPairingLinkClient } from "./pairing-link-client.js";
import {
  createHostDeckPlanClient,
  type HostDeckPlanClientSelectionRequest
} from "./plan-client.js";
import {
  createHostDeckPromptClient,
  type HostDeckPromptClientRequest
} from "./prompt-client.js";
import { createHostDeckRemoteControlClient } from "./remote-control-client.js";
import { createHostDeckResumeClient } from "./resume-client.js";
import { createHostDeckSkillsClient } from "./skills-client.js";
import { createHostDeckStartClient } from "./start-client.js";
import { createHostDeckUsageClient } from "./usage-client.js";

interface ObservedRequest {
  readonly method: "GET" | "POST";
  readonly path: string;
}

const baseUrl = new URL("http://127.0.0.1:48765");
const sessionId = "sess_cli_inventory_001";
const operationId = clientOperationIdSchema.parse("op_cli_inventory_001");
const expectedManifestIds = [
  "approval_list",
  "approval_respond",
  "compact_read",
  "compact_start",
  "goal_mutate",
  "goal_read",
  "host_lock",
  "host_unlock",
  "model_read",
  "model_select",
  "pair_request",
  "plan_read",
  "plan_select",
  "prompt_dispatch",
  "remote_disable",
  "remote_enable",
  "remote_status",
  "session_archive",
  "session_resume_metadata",
  "session_start",
  "skills_read",
  "turn_interrupt",
  "usage_read"
] as const;

describe("IFC-V1-046 source CLI selected-route inventory", () => {
  it("keeps every source client operation inside the production manifest", async () => {
    const observed: ObservedRequest[] = [];
    const fetch: HttpFetch = async (rawUrl, init) => {
      const url = new URL(rawUrl);
      observed.push({ method: init.method, path: url.pathname });
      if (url.pathname === "/api/v1/remote/status") {
        return jsonResponse(200, {
          availability: "ready",
          external_origin: "https://hostdeck-cli.fixture-tailnet.ts.net",
          generation: 1,
          laptop_action_required: false,
          observed_at: "2026-07-20T12:00:00.000Z",
          reason: null
        });
      }
      throw new Error("Stop after recording the selected CLI route.");
    };
    const options = { baseUrl, fetch };

    await observe(() =>
      createHostDeckStartClient(options).start(
        selectedStartSessionRequestSchema.parse({
          cwd: "/tmp/hostdeck-cli-inventory",
          name: "cli-inventory",
          operation_id: operationId
        })
      )
    );

    const model = createHostDeckModelClient(options);
    await observe(() => model.read(sessionId));
    await observe(() =>
      model.select({
        expected_pending_revision: null,
        kind: "model",
        model_id: "model-inventory",
        operation_id: operationId,
        reasoning_effort: null,
        session_id: sessionId
      } satisfies HostDeckModelClientSelectionRequest)
    );

    const goal = createHostDeckGoalClient(options);
    await observe(() => goal.read(sessionId));
    await observe(() =>
      goal.mutate({
        action: "set",
        expected_goal_revision: null,
        kind: "goal",
        objective: "Verify selected CLI route inventory.",
        operation_id: operationId,
        session_id: sessionId
      } satisfies HostDeckGoalClientMutationRequest)
    );

    const plan = createHostDeckPlanClient(options);
    await observe(() => plan.read(sessionId));
    await observe(() =>
      plan.select({
        action: "enter",
        expected_pending_revision: null,
        kind: "plan",
        operation_id: operationId,
        session_id: sessionId
      } satisfies HostDeckPlanClientSelectionRequest)
    );

    await observe(() => createHostDeckUsageClient(options).read(sessionId));

    const compact = createHostDeckCompactClient(options);
    await observe(() => compact.read(sessionId));
    await observe(() =>
      compact.start({
        confirm: true,
        kind: "compact",
        operation_id: operationId,
        session_id: sessionId
      } satisfies HostDeckCompactClientStartRequest)
    );

    await observe(() => createHostDeckSkillsClient(options).list(sessionId));

    const approval = createHostDeckApprovalClient(options);
    await observe(() => approval.list(sessionId));
    await observe(() =>
      approval.respond({
        confirm: true,
        decision: "approve",
        kind: "approval_response",
        operation_id: operationId,
        request_id: "string:cli-inventory-approval",
        session_id: sessionId
      } satisfies HostDeckApprovalClientResponseRequest)
    );

    await observe(() =>
      createHostDeckInterruptClient(options).interrupt({
        confirm: true,
        kind: "interrupt",
        operation_id: operationId,
        session_id: sessionId,
        turn_id: "turn-cli-inventory-001"
      } satisfies HostDeckInterruptClientRequest)
    );

    await observe(() =>
      createHostDeckArchiveClient(options).archive({
        confirm: true,
        kind: "archive",
        operation_id: operationId,
        session_id: sessionId
      } satisfies HostDeckArchiveClientRequest)
    );
    await observe(() => createHostDeckResumeClient(options).read(sessionId));
    await observe(() =>
      createHostDeckPromptClient(options).send({
        kind: "prompt",
        operation_id: operationId,
        session_id: sessionId,
        text: "Verify the selected route inventory."
      } satisfies HostDeckPromptClientRequest)
    );

    const remote = createHostDeckRemoteControlClient(options);
    await observe(() => remote.status());
    await observe(() =>
      remote.enable({ confirmed: true, operation_id: operationId })
    );
    await observe(() =>
      remote.disable({ confirmed: true, operation_id: operationId })
    );
    await observe(() =>
      createHostDeckPairingLinkClient(options).issue({
        client_label: "CLI inventory fixture",
        operation_id: operationId,
        permission: "write"
      })
    );

    const hostLock = createHostDeckHostLockClient(options);
    await observe(() =>
      hostLock.lock({ confirmed: true, operation_id: operationId })
    );
    await observe(() =>
      hostLock.unlock({ confirmed: true, operation_id: operationId })
    );

    const matchedIds = new Set(
      observed.map((request) => requireManifestMatch(request))
    );
    expect([...matchedIds].sort()).toEqual([...expectedManifestIds].sort());
    expect(matchedIds.size).toBe(expectedManifestIds.length);
    expect(observed.every((request) => request.path.startsWith("/api/v1/"))).toBe(
      true
    );
  });
});

async function observe(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch {
    // The recording transport intentionally stops before response handling.
  }
}

function requireManifestMatch(request: ObservedRequest): string {
  const matches = selectedApiRouteManifest.filter(
    (entry) =>
      entry.method === request.method && pathsMatch(entry.path, request.path)
  );
  expect(matches, `${request.method} ${request.path}`).toHaveLength(1);
  const match = matches[0];
  if (match === undefined) throw new Error("Selected CLI route is unmanifested.");
  return match.id;
}

function pathsMatch(manifestPath: string, concretePath: string): boolean {
  const manifestSegments = manifestPath.split("/");
  const concreteSegments = concretePath.split("/");
  return (
    manifestSegments.length === concreteSegments.length &&
    manifestSegments.every(
      (segment, index) =>
        (segment.startsWith(":") && concreteSegments[index]?.length !== 0) ||
        segment === concreteSegments[index]
    )
  );
}

function jsonResponse(status: number, payload: unknown): HttpResponse {
  return {
    json: async () => payload,
    ok: status >= 200 && status < 300,
    status
  };
}
