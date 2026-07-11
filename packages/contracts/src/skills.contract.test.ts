import { describe, expect, it } from "vitest";
import {
  defaultResourceBudget,
  resourceBudgetDefinitionByKey,
  skillsOperationIntentSchema,
  skillsSnapshotSchema
} from "./index.js";

const target = {
  type: "managed_session",
  session_id: "sess_contract_skills",
  codex_thread_id: "thread-contract-skills"
} as const;
const observedAt = "2026-07-11T19:00:00.000Z";

describe("structured skills contracts", () => {
  it("requires one exact intent and exposes only path-redacted public fields", () => {
    expect(
      skillsOperationIntentSchema.parse({
        operation_id: "op_contract_skills_0001",
        target,
        kind: "skills"
      })
    ).toMatchObject({ kind: "skills", target });
    expect(() =>
      skillsOperationIntentSchema.parse({
        operation_id: "op_contract_skills_0001",
        target,
        kind: "skills",
        cwd: "/tmp/caller-path"
      })
    ).toThrow();

    const snapshot = skillsSnapshotSchema.parse(contentSnapshot());
    expect(snapshot.state).toBe("content");
    expect(snapshot.skills).toEqual([
      { name: "alpha", description: "Alpha skill.", scope: "repo", enabled: true },
      { name: "beta", description: null, scope: "system", enabled: false }
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(/cwd|path|prompt|command|url|transport|message/iu);
  });

  it("keeps content, empty, partial, and error states exact", () => {
    expect(skillsSnapshotSchema.parse(contentSnapshot()).state).toBe("content");
    expect(skillsSnapshotSchema.parse({ ...contentSnapshot(), state: "empty", skills: [], error_count: 0 }).state).toBe(
      "empty"
    );
    expect(skillsSnapshotSchema.parse({ ...contentSnapshot(), state: "partial", error_count: 2 }).state).toBe("partial");
    expect(
      skillsSnapshotSchema.parse({ ...contentSnapshot(), state: "error", skills: [], error_count: 2 }).state
    ).toBe("error");
  });

  it("rejects duplicate, unsorted, contradictory, and unknown public data", () => {
    const skills = contentSnapshot().skills;
    expect(() => skillsSnapshotSchema.parse({ ...contentSnapshot(), skills: [skills[0], skills[0]] })).toThrow();
    expect(() => skillsSnapshotSchema.parse({ ...contentSnapshot(), skills: [...skills].reverse() })).toThrow();
    expect(() => skillsSnapshotSchema.parse({ ...contentSnapshot(), state: "empty" })).toThrow();
    expect(() =>
      skillsSnapshotSchema.parse({
        ...contentSnapshot(),
        skills: [{ ...skills[0], scope: "unknown" }]
      })
    ).toThrow();
    expect(() => skillsSnapshotSchema.parse({ ...contentSnapshot(), cwd: "/tmp/private" })).toThrow();
  });

  it("enforces public identity, description, count, and error ceilings", () => {
    expect(() =>
      skillsSnapshotSchema.parse({
        ...contentSnapshot(),
        skills: [{ ...contentSnapshot().skills[0], name: "x".repeat(161) }]
      })
    ).toThrow();
    expect(() =>
      skillsSnapshotSchema.parse({
        ...contentSnapshot(),
        skills: [{ ...contentSnapshot().skills[0], description: "x".repeat(4_097) }]
      })
    ).toThrow();
    expect(() => skillsSnapshotSchema.parse({ ...contentSnapshot(), error_count: 257 })).toThrow();
  });

  it("freezes the reviewed raw response ceilings", () => {
    expect(defaultResourceBudget).toMatchObject({
      protocol_skills_max_entries_per_cwd: 256,
      protocol_skills_max_errors_per_cwd: 64,
      protocol_skills_max_dependencies_per_skill: 64
    });
    expect(resourceBudgetDefinitionByKey.protocol_skills_max_entries_per_cwd.maximum).toBe(1_024);
    expect(resourceBudgetDefinitionByKey.protocol_skills_max_errors_per_cwd.maximum).toBe(256);
    expect(resourceBudgetDefinitionByKey.protocol_skills_max_dependencies_per_skill.maximum).toBe(256);
  });
});

function contentSnapshot() {
  return {
    target,
    runtime_version: "0.144.0",
    connection_generation: 3,
    observed_at: observedAt,
    state: "content",
    skills: [
      { name: "alpha", description: "Alpha skill.", scope: "repo", enabled: true },
      { name: "beta", description: null, scope: "system", enabled: false }
    ],
    error_count: 0
  } as const;
}
