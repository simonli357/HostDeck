export const codexOutputCategories = [
  "question_waiting",
  "approval_waiting",
  "command_running",
  "tests_passed",
  "tests_failed",
  "compact_warning",
  "idle_no_output",
  "unknown_output"
] as const;

export type CodexOutputCategory = (typeof codexOutputCategories)[number];

export interface CodexOutputFixture {
  readonly id: string;
  readonly category: CodexOutputCategory;
  readonly title: string;
  readonly output: string;
  readonly expected: {
    readonly status:
      | "idle"
      | "running"
      | "waiting_for_user"
      | "waiting_for_approval"
      | "tests_failed"
      | "tests_passed"
      | "compacting"
      | "disconnected"
      | "unknown";
    readonly attention: "none" | "watch" | "needs_input" | "needs_approval" | "failed" | "stuck" | "unknown";
  };
}

export const codexOutputFixtures: readonly CodexOutputFixture[] = [
  {
    id: "codex_question_waiting",
    category: "question_waiting",
    title: "Question Waiting",
    output: "I found two possible approaches.\n\nWhich direction should I take?\n1. Minimal patch\n2. Broader refactor\n\nReply with a choice.",
    expected: {
      status: "waiting_for_user",
      attention: "needs_input"
    }
  },
  {
    id: "codex_approval_waiting",
    category: "approval_waiting",
    title: "Approval Waiting",
    output: "Codex needs approval to run this command:\n\npnpm test\n\nApprove before continuing.",
    expected: {
      status: "waiting_for_approval",
      attention: "needs_approval"
    }
  },
  {
    id: "codex_command_running",
    category: "command_running",
    title: "Command Running",
    output: "$ pnpm test\n\nRUN v4.1.10 /home/simonli/Videos/apps/HostDeck\n\nTests are still running...",
    expected: {
      status: "running",
      attention: "watch"
    }
  },
  {
    id: "codex_tests_passed",
    category: "tests_passed",
    title: "Tests Passed",
    output: "Test Files 4 passed (4)\nTests 31 passed (31)\nDuration 821ms\n\nValidation is complete.",
    expected: {
      status: "tests_passed",
      attention: "none"
    }
  },
  {
    id: "codex_tests_failed",
    category: "tests_failed",
    title: "Tests Failed",
    output: "FAIL packages/core/src/session.test.ts\nTests 1 failed | 30 passed\n\nThe failure is in session lifecycle handling.",
    expected: {
      status: "tests_failed",
      attention: "failed"
    }
  },
  {
    id: "codex_compact_warning",
    category: "compact_warning",
    title: "Compact Warning",
    output: "Context is getting low. Run /compact soon before continuing with a larger change.",
    expected: {
      status: "compacting",
      attention: "watch"
    }
  },
  {
    id: "codex_idle_no_output",
    category: "idle_no_output",
    title: "Idle No Output",
    output: "",
    expected: {
      status: "idle",
      attention: "none"
    }
  },
  {
    id: "codex_unknown_output",
    category: "unknown_output",
    title: "Unknown Output",
    output: "<<unrecognized agent output>>\nstatus token: maybe-done\nnext marker: ???",
    expected: {
      status: "unknown",
      attention: "unknown"
    }
  }
] as const;

export function codexOutputFixtureByCategory(category: CodexOutputCategory): CodexOutputFixture {
  const fixture = codexOutputFixtures.find((candidate) => candidate.category === category);

  if (fixture === undefined) {
    throw new TypeError(`Missing Codex output fixture for category: ${category}`);
  }

  return fixture;
}
