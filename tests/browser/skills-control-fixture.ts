import type { Page, Request, Route } from "@playwright/test";
import {
  type ApiErrorEnvelope,
  type SkillsSnapshot,
  skillsSnapshotSchema
} from "../../packages/contracts/src/index.js";
import {
  type CompactControlApiController,
  installCompactControlApi
} from "./compact-control-fixture.js";
import {
  type SessionDetailApiVariant,
  sessionDetailBrowserCodexThreadId,
  sessionDetailBrowserSessionId
} from "./session-detail-fixture.js";

export type SkillsSnapshotVariant =
  | "content"
  | "empty"
  | "partial"
  | "error"
  | "long"
  | "twenty_five"
  | "ceiling";

export type SkillsReadOutcome =
  | "success"
  | "pending"
  | "unsupported"
  | "known_failure"
  | "malformed"
  | "foreign";

export interface SkillsControlApiController {
  readonly compact: CompactControlApiController;
  readonly hasPendingRead: () => boolean;
  readonly requests: () => readonly Request[];
  readonly releaseRead: (outcome?: Exclude<SkillsReadOutcome, "pending">) => void;
  readonly setReadOutcome: (outcome: SkillsReadOutcome) => void;
  readonly setSessionVariant: (variant: SessionDetailApiVariant) => void;
  readonly setSnapshotVariant: (variant: SkillsSnapshotVariant) => void;
}

const timestamp = "2026-07-27T16:00:00.000Z";
const threadId = sessionDetailBrowserCodexThreadId;
const skillsPath = `/api/v1/sessions/${sessionDetailBrowserSessionId}/skills`;

export async function installSkillsControlApi(
  page: Page,
  input: Readonly<{
    sessionVariant?: SessionDetailApiVariant;
    snapshotVariant?: SkillsSnapshotVariant;
  }> = {}
): Promise<SkillsControlApiController> {
  const compact = await installCompactControlApi(page, {
    sessionVariant: input.sessionVariant ?? "writable"
  });
  let snapshot = skillsSnapshot(input.snapshotVariant ?? "content");
  let readOutcome: SkillsReadOutcome = "success";
  let pendingResolution:
    | ((outcome: Exclude<SkillsReadOutcome, "pending">) => void)
    | null = null;
  const reads: Request[] = [];

  await page.route(`**${skillsPath}`, async (route) => {
    const request = route.request();
    reads.push(request);
    if (request.method() !== "GET") {
      await route.fulfill({ status: 405, body: "unexpected Skills method" });
      return;
    }
    let selectedOutcome = readOutcome;
    if (selectedOutcome === "pending") {
      if (pendingResolution !== null) {
        await route.fulfill({ status: 500, body: "duplicate pending Skills read" });
        return;
      }
      selectedOutcome = await new Promise<Exclude<SkillsReadOutcome, "pending">>((resolve) => {
        pendingResolution = resolve;
      });
      pendingResolution = null;
    }
    if (selectedOutcome === "unsupported") {
      await fulfillApiError(route, 409, "capability_unavailable", false);
      return;
    }
    if (selectedOutcome === "known_failure") {
      await fulfillApiError(route, 503, "service_overloaded", true);
      return;
    }
    if (selectedOutcome === "malformed") {
      await fulfillJson(route, { ...snapshot, private_path: "/home/private/.codex/skills" });
      return;
    }
    if (selectedOutcome === "foreign") {
      await fulfillJson(route, {
        ...snapshot,
        target: {
          ...snapshot.target,
          codex_thread_id: "thread-foreign-private"
        }
      });
      return;
    }
    await fulfillJson(route, snapshot);
  });

  return Object.freeze({
    compact,
    hasPendingRead: () => pendingResolution !== null,
    requests: () => reads,
    releaseRead(outcome: Exclude<SkillsReadOutcome, "pending"> = "success") {
      if (pendingResolution === null) throw new TypeError("No pending Skills read exists.");
      readOutcome = outcome;
      pendingResolution(outcome);
    },
    setReadOutcome(outcome: SkillsReadOutcome) {
      if (pendingResolution !== null) throw new TypeError("Cannot replace a pending Skills outcome.");
      readOutcome = outcome;
    },
    setSessionVariant(variant: SessionDetailApiVariant) {
      compact.setSessionVariant(variant);
    },
    setSnapshotVariant(variant: SkillsSnapshotVariant) {
      snapshot = skillsSnapshot(variant);
    }
  });
}

export function skillsSnapshot(variant: SkillsSnapshotVariant): SkillsSnapshot {
  const skills = skillsForVariant(variant);
  const errorCount = variant === "partial" || variant === "error" ? 2 : 0;
  return skillsSnapshotSchema.parse({
    target: {
      type: "managed_session",
      session_id: sessionDetailBrowserSessionId,
      codex_thread_id: threadId
    },
    runtime_version: "0.147.0",
    connection_generation: 4,
    observed_at: timestamp,
    state: skills.length === 0
      ? errorCount === 0 ? "empty" : "error"
      : errorCount === 0 ? "content" : "partial",
    skills,
    error_count: errorCount
  });
}

function skillsForVariant(variant: SkillsSnapshotVariant) {
  if (variant === "empty" || variant === "error") return [];
  if (variant === "twenty_five") return generatedSkills(25, "progressive");
  if (variant === "ceiling") return generatedSkills(1_024, "bounded");
  if (variant === "long") {
    const skills = generatedSkills(25, "long-skill");
    return [
      {
        name: `maximum-name-${"n".repeat(147)}`,
        description: `${"Exact multiline control-like /skills text with Unicode 数据.\n".repeat(69)}final-line`,
        scope: "repo" as const,
        enabled: true
      },
      {
        name: "null-description",
        description: null,
        scope: "system" as const,
        enabled: false
      },
      {
        name: "empty-description",
        description: "",
        scope: "admin" as const,
        enabled: true
      },
      ...skills.slice(3)
    ].sort((left, right) => left.name < right.name ? -1 : 1);
  }
  return [
    { name: "alpha", description: "Alpha project skill.", scope: "repo" as const, enabled: true },
    { name: "beta", description: null, scope: "system" as const, enabled: false },
    { name: "gamma", description: "", scope: "user" as const, enabled: true },
    { name: "omega", description: "Admin skill.", scope: "admin" as const, enabled: true }
  ];
}

function generatedSkills(count: number, prefix: string) {
  const scopes = ["user", "repo", "system", "admin"] as const;
  return Array.from({ length: count }, (_, index) => ({
    name: `${prefix}-${String(index + 1).padStart(4, "0")}`,
    description: `Deterministic description ${index + 1}`,
    scope: scopes[index % scopes.length] ?? "user",
    enabled: index % 3 !== 0
  }));
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json; charset=utf-8",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body)
  });
}

async function fulfillApiError(
  route: Route,
  status: number,
  code: ApiErrorEnvelope["code"],
  retryable: boolean
): Promise<void> {
  await fulfillJson(
    route,
    {
      error: {
        code,
        message: "Private Skills fixture detail with /home/private path.",
        retryable
      }
    },
    status
  );
}
