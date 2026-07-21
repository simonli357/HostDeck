import { readdir, readFile } from "node:fs/promises";
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
  readonly body: string | undefined;
  readonly headers: Readonly<Record<string, string>>;
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

const selectedClientContracts = [
  {
    factory: "createHostDeckApprovalClient",
    file: "approval-client.ts",
    interface: "HostDeckApprovalClient",
    operations: ["list", "respond"]
  },
  {
    factory: "createHostDeckArchiveClient",
    file: "archive-client.ts",
    interface: "HostDeckArchiveClient",
    operations: ["archive"]
  },
  {
    factory: "createHostDeckCompactClient",
    file: "compact-client.ts",
    interface: "HostDeckCompactClient",
    operations: ["read", "start"]
  },
  {
    factory: "createHostDeckGoalClient",
    file: "goal-client.ts",
    interface: "HostDeckGoalClient",
    operations: ["mutate", "read"]
  },
  {
    factory: "createHostDeckHostLockClient",
    file: "host-lock-client.ts",
    interface: "HostDeckHostLockClient",
    operations: ["lock", "unlock"]
  },
  {
    factory: "createHostDeckInterruptClient",
    file: "interrupt-client.ts",
    interface: "HostDeckInterruptClient",
    operations: ["interrupt"]
  },
  {
    factory: "createHostDeckModelClient",
    file: "model-client.ts",
    interface: "HostDeckModelClient",
    operations: ["read", "select"]
  },
  {
    factory: "createHostDeckPairingLinkClient",
    file: "pairing-link-client.ts",
    interface: "HostDeckPairingLinkClient",
    operations: ["issue"]
  },
  {
    factory: "createHostDeckPlanClient",
    file: "plan-client.ts",
    interface: "HostDeckPlanClient",
    operations: ["read", "select"]
  },
  {
    factory: "createHostDeckPromptClient",
    file: "prompt-client.ts",
    interface: "HostDeckPromptClient",
    operations: ["send"]
  },
  {
    factory: "createHostDeckRemoteControlClient",
    file: "remote-control-client.ts",
    interface: "HostDeckRemoteControlClient",
    operations: ["disable", "enable", "status"]
  },
  {
    factory: "createHostDeckResumeClient",
    file: "resume-client.ts",
    interface: "HostDeckResumeClient",
    operations: ["read"]
  },
  {
    factory: "createHostDeckSkillsClient",
    file: "skills-client.ts",
    interface: "HostDeckSkillsClient",
    operations: ["list"]
  },
  {
    factory: "createHostDeckStartClient",
    file: "start-client.ts",
    interface: "HostDeckStartClient",
    operations: ["start"]
  },
  {
    factory: "createHostDeckUsageClient",
    file: "usage-client.ts",
    interface: "HostDeckUsageClient",
    operations: ["read"]
  }
] as const;

const expectedStatusSourceByFile = Object.freeze({
  "approval-client.ts": "expectedStatus: 200",
  "archive-client.ts": "expectedStatus: 202",
  "compact-client.ts": "expectedStatus: request === null ? 200 : 202",
  "goal-client.ts": "expectedStatus: 200",
  "host-lock-client.ts": "expectedStatus: 200",
  "interrupt-client.ts": "expectedStatus: 200",
  "model-client.ts": "expectedStatus: 200",
  "pairing-link-client.ts": "expectedStatus: 200",
  "plan-client.ts": "expectedStatus: 200",
  "prompt-client.ts": "expectedStatus: 202",
  "remote-control-client.ts": "expectedStatus: 200",
  "resume-client.ts": "expectedStatus: 200",
  "skills-client.ts": "expectedStatus: 200",
  "start-client.ts": "expectedStatus: 201",
  "usage-client.ts": "expectedStatus: 200"
});

describe("CLI selected-route inventory", () => {
  it("keeps the exact client factory and public-operation inventory on the shared transport", async () => {
    const sourceDirectory = new URL("./", import.meta.url);
    const actualClientFiles = (await readdir(sourceDirectory))
      .filter((file) => file.endsWith("-client.ts") && file !== "api-client.ts")
      .sort();
    expect(actualClientFiles).toEqual(
      selectedClientContracts.map((entry) => entry.file).sort()
    );
    expect(selectedClientContracts).toHaveLength(15);
    expect(
      selectedClientContracts.reduce(
        (count, entry) => count + entry.operations.length,
        0
      )
    ).toBe(23);

    for (const entry of selectedClientContracts) {
      const source = await readFile(new URL(entry.file, sourceDirectory), "utf8");
      const factoryNames = [...source.matchAll(/export function (createHostDeck\w+Client)\s*\(/g)]
        .map((match) => match[1]);
      expect(factoryNames, entry.file).toEqual([entry.factory]);

      const interfaceBody = source.match(
        new RegExp(`export interface ${entry.interface} \\{([\\s\\S]*?)\\n\\}`)
      )?.[1];
      expect(interfaceBody, entry.file).toBeDefined();
      const operationNames = [...(interfaceBody ?? "").matchAll(/readonly\s+(\w+):/g)]
        .map((match) => match[1])
        .sort();
      expect(operationNames, entry.file).toEqual([...entry.operations].sort());

      expect(source.match(/await requestCliJson\(\{/g), entry.file).toHaveLength(1);
      expect(source, entry.file).toContain(
        expectedStatusSourceByFile[entry.file]
      );
      expect(source, entry.file).toContain("throwCliApiFailure");
      expect(source, entry.file).toMatch(/sanitize:\s*sanitize\w+ApiError/);
      expect(source, entry.file).toMatch(/function sanitize\w+ApiError\s*\(/);
      expect(source, entry.file).toContain("createBoundedLoopbackFetch");
      expect(source, entry.file).not.toMatch(
        /\b(?:assertCliHttpResponse|daemonUnavailableFailure|readCliJsonPayload)\b/
      );
      expect(source, entry.file).not.toMatch(/(?:globalThis\.)?fetch\s*\(/);
      expect(source, entry.file).not.toMatch(/node:https?/);
    }
  });

  it("keeps every source client operation inside the production manifest", async () => {
    const observed: ObservedRequest[] = [];
    const fetch: HttpFetch = async (rawUrl, init) => {
      const url = new URL(rawUrl);
      observed.push({
        body: init.body,
        headers: init.headers,
        method: init.method,
        path: url.pathname
      });
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
      if (url.pathname === "/api/v1/access/pairing-codes") {
        return jsonResponse(200, {
          pairing_id: "pair_abcdefghijklmnopqrstuvwx",
          code: "AbCdEfGhIjKlMnOpQrSt_1",
          permission: "write",
          client_label: "CLI inventory fixture",
          created_at: "2026-07-20T12:00:00.000Z",
          expires_at: "2026-07-20T12:05:00.000Z"
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

    const observedManifestIds = observed.map((request) => requireManifestMatch(request));
    const matchedIds = new Set(observedManifestIds);
    expect([...matchedIds].sort()).toEqual([...expectedManifestIds].sort());
    expect(matchedIds.size).toBe(expectedManifestIds.length);
    expect(observed).toHaveLength(25);
    expect(observed.filter((request) => request.method === "GET")).toHaveLength(11);
    expect(observed.filter((request) => request.method === "POST")).toHaveLength(14);
    expect(
      observed.every(
        (request) =>
          request.method !== "GET" ||
          (request.body === undefined &&
            request.headers["content-type"] === undefined)
      )
    ).toBe(true);
    expect(
      observed.every(
        (request) =>
          request.method !== "POST" ||
          (typeof request.body === "string" &&
            request.body.length > 0 &&
            request.headers["content-type"] === "application/json")
      )
    ).toBe(true);
    expect(
      new Set(
        observed
          .filter((request) => request.method === "GET")
          .map((request) => requireManifestMatch(request))
      ).size
    ).toBe(9);
    expect(
      new Set(
        observed
          .filter((request) => request.method === "POST")
          .map((request) => requireManifestMatch(request))
      ).size
    ).toBe(14);
    expect(
      observedManifestIds.filter((manifestId) => manifestId === "remote_status")
    ).toHaveLength(3);
    expect(
      observedManifestIds.filter((manifestId) => manifestId !== "remote_status")
    ).toHaveLength(expectedManifestIds.length - 1);
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
