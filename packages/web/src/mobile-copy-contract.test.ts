import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createScanner, LanguageVariant, SyntaxKind } from "typescript/unstable/ast";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL(".", import.meta.url));

const copyOwnerFiles = [
  "app-shell.tsx",
  "approval-decision-state.ts",
  "approval-decisions.tsx",
  "archive-control-state.ts",
  "archive-control.tsx",
  "compact-control-state.ts",
  "compact-control.tsx",
  "cross-screen-failure-state.ts",
  "event-diagnostics-state.ts",
  "event-diagnostics.tsx",
  "goal-control-state.ts",
  "goal-control.tsx",
  "host-access-recovery-state.ts",
  "host-access.tsx",
  "host-lock-state.ts",
  "host-lock.tsx",
  "interrupt-control-state.ts",
  "interrupt-control.tsx",
  "laptop-resume-control-state.ts",
  "laptop-resume-control.tsx",
  "mission-control.tsx",
  "model-control-state.ts",
  "model-control.tsx",
  "paired-device-management-state.ts",
  "paired-device-management.tsx",
  "pairing-screen.tsx",
  "plan-control-state.ts",
  "plan-control.tsx",
  "prompt-composer-state.ts",
  "prompt-composer.tsx",
  "remote-connection-recovery-state.ts",
  "runtime-compatibility-state.ts",
  "runtime-compatibility.tsx",
  "session-detail-feed.ts",
  "session-detail.tsx",
  "session-utilities.tsx",
  "skills-control-state.ts",
  "skills-control.tsx",
  "usage-control-state.ts",
  "usage-control.tsx"
] as const;

const prohibitedCopyPatterns = [
  ["implementation authority", /\bauthority\b/giu],
  ["terminal lifecycle jargon", /\bterminal (?:proof|result|decision|audited)\b/giu],
  ["process lifecycle jargon", /\bprocess-live\b/giu],
  ["generation jargon", /\bsame-generation\b/giu],
  ["projection jargon", /\b(?:session|retained) projection\b/giu],
  ["protocol jargon", /\bprotocol validation\b/giu],
  ["reconciliation jargon", /\b(?:reconcile|reconciled|reconciliation|dispatched)\b/giu],
  [
    "structured-operation jargon",
    /\bstructured (?:approval|compact|goal|model|plan|skills|usage)\b/giu
  ],
  [
    "unselected product surface",
    /\b(?:desktop console|terminal emulator|arbitrary shell|file tree|git review|storage console|raw json viewer|tailscale profile switcher)\b/giu
  ]
] as const;

describe("FE-V1-018 production mobile copy contract", () => {
  it("audits one explicit unique production source inventory", () => {
    expect(new Set(copyOwnerFiles).size).toBe(copyOwnerFiles.length);
    expect(copyOwnerFiles).toContain("mission-control.tsx");
    expect(copyOwnerFiles).toContain("session-detail.tsx");
    expect(copyOwnerFiles).toContain("pairing-screen.tsx");
    expect(copyOwnerFiles).toContain("host-access.tsx");
    for (const file of copyOwnerFiles) {
      expect(() => readFileSync(`${sourceRoot}/${file}`, "utf8"), file).not.toThrow();
      expect(file, file).not.toContain(".test.");
    }
  });

  it("keeps implementation and unselected-surface jargon out of copy owners", () => {
    const violations: string[] = [];
    for (const file of copyOwnerFiles) {
      const source = readFileSync(`${sourceRoot}/${file}`, "utf8");
      const literals = sourceLiterals(file, source);
      for (const [policy, pattern] of prohibitedCopyPatterns) {
        for (const literal of literals) {
          for (const match of literal.text.matchAll(pattern)) {
            violations.push(`${file}:${literal.line}:${policy}:${match[0]}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("limits user-facing thread terminology to runtime detail and exact handoff owners", () => {
    const allowed = new Set([
      "archive-control-state.ts",
      "archive-control.tsx",
      "goal-control-state.ts",
      "laptop-resume-control-state.ts",
      "laptop-resume-control.tsx",
      "session-detail-feed.ts",
      "session-utilities.tsx",
      "usage-control-state.ts",
      "usage-control.tsx"
    ]);
    const unexpected: string[] = [];
    for (const file of copyOwnerFiles) {
      const source = readFileSync(`${sourceRoot}/${file}`, "utf8");
      const containsThread = sourceLiterals(file, source).some(({ text }) => /\bthread\b/iu.test(text));
      if (containsThread && !allowed.has(file)) unexpected.push(file);
    }
    expect(unexpected).toEqual([]);
  });

  it("retains the explicit local terminal handoff without exposing phone execution", () => {
    const component = readFileSync(`${sourceRoot}/laptop-resume-control.tsx`, "utf8");
    const state = readFileSync(`${sourceRoot}/laptop-resume-control-state.ts`, "utf8");
    expect(component).toContain("Laptop terminal only");
    expect(component).toContain("Use only in a terminal on the HostDeck laptop.");
    expect(state).toContain("Nothing ran here. Use it only in a terminal on the HostDeck laptop.");
    expect(`${component}\n${state}`).not.toMatch(/(?:run|execute) (?:this|command) on (?:the|this) phone/iu);
  });

  it("audits copy tokens without treating identifiers or comments as visible copy", () => {
    const fixture = [
      'const authority = "visible copy";',
      "// terminal proof is an implementation comment",
      "const value = `before $" + "{authority} retained projection`;",
      "const node = <p>process-live</p>;"
    ].join("\n");

    expect(sourceLiterals("fixture.tsx", fixture)).toEqual([
      { line: 1, text: "visible copy" },
      { line: 3, text: "before " },
      { line: 3, text: " retained projection" },
      { line: 4, text: "process-live" }
    ]);
  });
});

function sourceLiterals(
  file: string,
  source: string
): readonly Readonly<{ text: string; line: number }>[] {
  const scanner = createScanner(
    true,
    file.endsWith(".tsx") ? LanguageVariant.JSX : LanguageVariant.Standard,
    source
  );
  const literals: Array<Readonly<{ text: string; line: number }>> = [];
  const templateExpressionDepths: number[] = [];
  let braceDepth = 0;
  let token = scanner.scan();

  while (token !== SyntaxKind.EndOfFile) {
    if (
      token === SyntaxKind.StringLiteral ||
      token === SyntaxKind.NoSubstitutionTemplateLiteral ||
      token === SyntaxKind.TemplateHead ||
      token === SyntaxKind.TemplateMiddle ||
      token === SyntaxKind.TemplateTail
    ) {
      literals.push({
        line: lineAtOffset(source, scanner.getTokenStart()),
        text: scanner.getTokenValue()
      });
    }

    if (token === SyntaxKind.TemplateHead) {
      templateExpressionDepths.push(braceDepth);
    } else if (token === SyntaxKind.TemplateTail) {
      templateExpressionDepths.pop();
    } else if (token === SyntaxKind.OpenBraceToken) {
      braceDepth += 1;
    } else if (
      token === SyntaxKind.CloseBraceToken &&
      templateExpressionDepths.at(-1) === braceDepth
    ) {
      token = scanner.reScanTemplateToken(false);
      continue;
    } else if (token === SyntaxKind.CloseBraceToken) {
      braceDepth = Math.max(0, braceDepth - 1);
    }

    token = scanner.scan();
  }

  if (file.endsWith(".tsx")) {
    const jsxTextPattern =
      /(?:<(?:[A-Za-z][\w.:$-]*)(?:\s+(?:[^"'<>]|"[^"]*"|'[^']*')*)?>|<\/[A-Za-z][\w.:$-]*>|<>)(?<text>[^<>{}]*\p{L}[^<>{}]*)</gu;
    for (const match of source.matchAll(jsxTextPattern)) {
      const text = match.groups?.text?.trim();
      const textOffset = match.index + match[0].indexOf(match.groups?.text ?? "");
      if (text) literals.push({ line: lineAtOffset(source, textOffset), text });
    }
  }

  return Object.freeze(literals.sort((left, right) => left.line - right.line));
}

function lineAtOffset(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source.charCodeAt(index) === 10) line += 1;
  }
  return line;
}
