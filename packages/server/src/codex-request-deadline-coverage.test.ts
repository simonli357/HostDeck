import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface RouteDeadlineInventoryEntry {
  readonly file: string;
  readonly contextDeadlines: number;
  readonly requestDeadlines: number;
}

const routeInventory = Object.freeze<RouteDeadlineInventoryEntry[]>([
  { file: "session-start-routes.ts", contextDeadlines: 1, requestDeadlines: 0 },
  { file: "session-archive-routes.ts", contextDeadlines: 1, requestDeadlines: 0 },
  { file: "prompt-routes.ts", contextDeadlines: 1, requestDeadlines: 0 },
  { file: "model-routes.ts", contextDeadlines: 1, requestDeadlines: 1 },
  { file: "goal-routes.ts", contextDeadlines: 1, requestDeadlines: 1 },
  { file: "plan-routes.ts", contextDeadlines: 1, requestDeadlines: 1 },
  { file: "usage-routes.ts", contextDeadlines: 0, requestDeadlines: 1 },
  { file: "compact-routes.ts", contextDeadlines: 1, requestDeadlines: 0 },
  { file: "skills-routes.ts", contextDeadlines: 0, requestDeadlines: 1 },
  { file: "approval-routes.ts", contextDeadlines: 2, requestDeadlines: 0 },
  { file: "interrupt-routes.ts", contextDeadlines: 2, requestDeadlines: 0 }
]);

const serializedServiceFiles = Object.freeze([
  "codex-approval-control-service.ts",
  "codex-compact-control-service.ts",
  "codex-goal-control-service.ts",
  "codex-interrupt-control-service.ts",
  "codex-model-control-service.ts",
  "codex-plan-control-service.ts",
  "codex-prompt-control-service.ts"
]);

const directDeadlineServiceFiles = Object.freeze([
  "managed-thread-service.ts",
  "codex-skills-control-service.ts",
  "codex-usage-control-service.ts"
]);

const clientRequestInventory = Object.freeze([
  { file: "thread-client.ts", requests: 10 },
  { file: "turn-client.ts", requests: 3 },
  { file: "model-client.ts", requests: 2 },
  { file: "goal-client.ts", requests: 3 },
  { file: "plan-client.ts", requests: 1 },
  { file: "usage-client.ts", requests: 1 },
  { file: "compact-client.ts", requests: 1 },
  { file: "skills-client.ts", requests: 1 }
]);

const forbiddenRequestOwner = /AbortSignal\.timeout|new AbortController|createOperationDeadline(?:View)?\s*\(/u;

describe("IFC-V1-050 selected request deadline structural coverage", () => {
  it("binds every protocol-bearing route to the one Fastify deadline object", () => {
    expect(routeInventory).toHaveLength(11);
    for (const entry of routeInventory) {
      const source = serverSource(entry.file);
      expect(count(source, "context.deadline"), entry.file).toBe(
        entry.contextDeadlines
      );
      expect(count(source, "hostDeckRequestDeadline(request)"), entry.file).toBe(
        entry.requestDeadlines
      );
      expect(source, entry.file).not.toMatch(/\brequest\.signal\b/u);
      expect(source, entry.file).not.toMatch(forbiddenRequestOwner);
    }
  });

  it("binds every request-facing serialized service to abortable queue ownership", () => {
    expect(serializedServiceFiles).toHaveLength(7);
    for (const file of serializedServiceFiles) {
      const source = serverSource(file);
      expect(count(source, "runSerializedWithDeadline("), file).toBe(1);
      expect(source, file).toContain("OperationDeadline");
      expect(source, file).not.toMatch(forbiddenRequestOwner);
    }

    expect(directDeadlineServiceFiles).toHaveLength(3);
    for (const file of directDeadlineServiceFiles) {
      const source = serverSource(file);
      expect(source, file).toContain("requireOpenOperationDeadline(");
      expect(source, file).toContain("OperationDeadline");
      expect(source, file).not.toMatch(forbiddenRequestOwner);
    }
  });

  it("binds every direct client request to final-boundary decreasing timeout derivation", () => {
    expect(clientRequestInventory).toHaveLength(8);
    for (const entry of clientRequestInventory) {
      const source = adapterSource(entry.file);
      expect(count(source, "this.port.request({"), entry.file).toBe(
        entry.requests
      );
      expect(count(source, "codexRequestOptionsFromDeadline("), entry.file).toBe(
        entry.requests
      );
      expect(source, entry.file).not.toMatch(forbiddenRequestOwner);
    }

    const approval = adapterSource("approval-client.ts");
    expect(count(approval, "codexRequestOptionsFromDeadline("), "approval-client.ts").toBe(1);
    expect(count(approval, "this.port.respondToServerRequest("), "approval-client.ts").toBe(2);
    expect(approval).not.toMatch(forbiddenRequestOwner);
  });
});

function serverSource(file: string): string {
  return readFileSync(resolve(process.cwd(), "packages/server/src", file), "utf8");
}

function adapterSource(file: string): string {
  return readFileSync(
    resolve(process.cwd(), "packages/codex-adapter/src", file),
    "utf8"
  );
}

function count(source: string, token: string): number {
  return source.split(token).length - 1;
}
