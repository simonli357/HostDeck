import { usageFailure } from "./errors.js";

export type ParsedCliCommand =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "serve" }
  | { readonly kind: "status"; readonly json: boolean }
  | { readonly kind: "start"; readonly name: string; readonly cwd: string; readonly json: boolean }
  | { readonly kind: "list"; readonly json: boolean }
  | { readonly kind: "archive"; readonly session: string; readonly json: boolean }
  | { readonly kind: "send"; readonly session: string; readonly text: string; readonly json: boolean }
  | { readonly kind: "attach"; readonly session: string }
  | { readonly kind: "resume"; readonly session: string }
  | {
      readonly kind: "model";
      readonly session: string;
      readonly model: string | null;
      readonly effort: string | null;
      readonly expectedRevision: number | null;
      readonly json: boolean;
    }
  | {
      readonly kind: "goal";
      readonly session: string;
      readonly action: "clear" | "complete" | "pause" | "resume" | "set" | null;
      readonly objective: string | null;
      readonly expectedRevision: string | null;
      readonly json: boolean;
    }
  | { readonly kind: "usage"; readonly session: string; readonly json: boolean }
  | { readonly kind: "skills"; readonly session: string; readonly json: boolean }
  | { readonly kind: "stop"; readonly session: string }
  | {
      readonly kind: "pair";
      readonly label?: string;
      readonly permission: "read" | "write";
    }
  | { readonly kind: "lock"; readonly reason?: string; readonly json: boolean }
  | { readonly kind: "unlock"; readonly json: boolean }
  | {
      readonly kind: "remote";
      readonly action: "disable" | "enable" | "status";
      readonly json: boolean;
    };

export interface ParsedCliArgs {
  readonly command: ParsedCliCommand;
  readonly configFlags: {
    readonly apiUrl?: string;
    readonly host?: string;
    readonly port?: string;
    readonly configPath?: string;
    readonly stateDir?: string;
    readonly databasePath?: string;
  };
}

type MutableConfigFlags = {
  apiUrl?: string;
  host?: string;
  port?: string;
  configPath?: string;
  stateDir?: string;
  databasePath?: string;
};

export function parseCliArgs(args: readonly string[]): ParsedCliArgs {
  const configFlags: MutableConfigFlags = {};
  const positionals: string[] = [];
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === undefined) {
      continue;
    }

    if (token === "--help" || token === "-h") {
      return { command: { kind: "help" }, configFlags };
    }

    if (token === "--version" || token === "-v") {
      return { command: { kind: "version" }, configFlags };
    }

    if (token === "--json") {
      json = true;
      continue;
    }

    if (token === "--api-url") {
      configFlags.apiUrl = readOptionValue(args, index, "--api-url");
      index += 1;
      continue;
    }

    if (token.startsWith("--api-url=")) {
      configFlags.apiUrl = readInlineOptionValue(token, "--api-url");
      continue;
    }

    if (token === "--host") {
      configFlags.host = readOptionValue(args, index, "--host");
      index += 1;
      continue;
    }

    if (token.startsWith("--host=")) {
      configFlags.host = readInlineOptionValue(token, "--host");
      continue;
    }

    if (token === "--port") {
      configFlags.port = readOptionValue(args, index, "--port");
      index += 1;
      continue;
    }

    if (token.startsWith("--port=")) {
      configFlags.port = readInlineOptionValue(token, "--port");
      continue;
    }

    if (token === "--config") {
      configFlags.configPath = readOptionValue(args, index, "--config");
      index += 1;
      continue;
    }

    if (token.startsWith("--config=")) {
      configFlags.configPath = readInlineOptionValue(token, "--config");
      continue;
    }

    if (token === "--state-dir") {
      configFlags.stateDir = readOptionValue(args, index, "--state-dir");
      index += 1;
      continue;
    }

    if (token.startsWith("--state-dir=")) {
      configFlags.stateDir = readInlineOptionValue(token, "--state-dir");
      continue;
    }

    if (token === "--database" || token === "--database-path") {
      configFlags.databasePath = readOptionValue(args, index, token);
      index += 1;
      continue;
    }

    if (token.startsWith("--database=")) {
      configFlags.databasePath = readInlineOptionValue(token, "--database");
      continue;
    }

    if (token.startsWith("--database-path=")) {
      configFlags.databasePath = readInlineOptionValue(token, "--database-path");
      continue;
    }

    if (token === "--") {
      if (positionals[0] === "model" || positionals[0] === "goal") {
        throw usageFailure(`The ${positionals[0]} command does not accept an option terminator.`);
      }
      positionals.push(...args.slice(index + 1));
      break;
    }

    if (token.startsWith("-") && positionals.length === 0) {
      throw usageFailure(`Unknown option: ${token}`);
    }

    positionals.push(token);
  }

  if (positionals.length === 0) {
    return { command: { kind: "help" }, configFlags };
  }

  const [command, ...rest] = positionals;

  if (command === "help") {
    if (rest.length > 0) {
      throw usageFailure("The help command does not accept extra arguments.");
    }

    return { command: { kind: "help" }, configFlags };
  }

  if (command === "version") {
    if (rest.length > 0) {
      throw usageFailure("The version command does not accept extra arguments.");
    }

    return { command: { kind: "version" }, configFlags };
  }

  if (command === "status") {
    return { command: { kind: "status", json: parseNoArgJsonOptions("status", rest, json) }, configFlags };
  }

  if (command === "serve") {
    if (rest.length > 0) {
      throw usageFailure("The serve command does not accept positional arguments.");
    }

    return { command: { kind: "serve" }, configFlags };
  }

  if (command === "start") {
    const parsed = parseStartOptions(rest);

    return { command: { kind: "start", name: parsed.name, cwd: parsed.cwd, json: parsed.json || json }, configFlags };
  }

  if (command === "list") {
    return { command: { kind: "list", json: parseNoArgJsonOptions("list", rest, json) }, configFlags };
  }

  if (command === "archive") {
    return {
      command: {
        kind: "archive",
        session: singleSessionArgument("archive", rest),
        json
      },
      configFlags
    };
  }

  if (command === "send") {
    if (rest.length < 2) {
      throw usageFailure("The send command requires a session target and text.");
    }

    const [session, ...textParts] = rest;

    return {
      command: {
        kind: "send",
        session: session ?? "",
        text: textParts.join(" "),
        json
      },
      configFlags
    };
  }

  if (command === "attach") {
    return { command: { kind: "attach", session: singleSessionArgument("attach", rest) }, configFlags };
  }

  if (command === "resume") {
    if (json) {
      throw usageFailure("The resume command does not support --json.");
    }
    return {
      command: {
        kind: "resume",
        session: singleSessionArgument("resume", rest)
      },
      configFlags
    };
  }

  if (command === "model") {
    const parsed = parseModelOptions(rest, json);
    return {
      command: {
        kind: "model",
        session: parsed.session,
        model: parsed.model,
        effort: parsed.effort,
        expectedRevision: parsed.expectedRevision,
        json: parsed.json
      },
      configFlags
    };
  }

  if (command === "goal") {
    const parsed = parseGoalOptions(rest, json);
    return {
      command: {
        kind: "goal",
        session: parsed.session,
        action: parsed.action,
        objective: parsed.objective,
        expectedRevision: parsed.expectedRevision,
        json: parsed.json
      },
      configFlags
    };
  }

  if (command === "usage") {
    return {
      command: {
        kind: "usage",
        session: singleSessionArgument("usage", rest),
        json
      },
      configFlags
    };
  }

  if (command === "skills") {
    return {
      command: {
        kind: "skills",
        session: singleSessionArgument("skills", rest),
        json
      },
      configFlags
    };
  }

  if (command === "stop") {
    return { command: { kind: "stop", session: singleSessionArgument("stop", rest) }, configFlags };
  }

  if (command === "pair") {
    const parsed = parsePairOptions(rest, json);

    return {
      command: {
        kind: "pair",
        ...(parsed.label !== undefined ? { label: parsed.label } : {}),
        permission: parsed.permission
      },
      configFlags
    };
  }

  if (command === "lock") {
    const parsed = parseLockOptions(rest, json);

    return {
      command: {
        kind: "lock",
        ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
        json: parsed.json
      },
      configFlags
    };
  }

  if (command === "unlock") {
    return { command: { kind: "unlock", json: parseNoArgJsonOptions("unlock", rest, json) }, configFlags };
  }

  if (command === "remote") {
    return {
      command: parseRemoteCommand(rest, json),
      configFlags
    };
  }

  throw usageFailure(`Unknown command: ${command ?? ""}`);
}

function parseRemoteCommand(
  args: readonly string[],
  globalJson: boolean
): Extract<ParsedCliCommand, { readonly kind: "remote" }> {
  const [action, ...rest] = args;
  if (action === undefined) {
    throw usageFailure(
      "The remote command requires status, enable, or disable."
    );
  }
  if (action !== "status" && action !== "enable" && action !== "disable") {
    throw usageFailure(`Unknown remote command: ${action}`);
  }
  return {
    kind: "remote",
    action,
    json: parseNoArgJsonOptions(`remote ${action}`, rest, globalJson)
  };
}

function parseStartOptions(args: readonly string[]): { readonly name: string; readonly cwd: string; readonly json: boolean } {
  let name: string | undefined;
  let cwd: string | undefined;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === undefined) {
      continue;
    }

    if (token === "--name") {
      name = readOptionValue(args, index, "--name");
      index += 1;
      continue;
    }

    if (token.startsWith("--name=")) {
      name = readInlineOptionValue(token, "--name");
      continue;
    }

    if (token === "--cwd") {
      cwd = readOptionValue(args, index, "--cwd");
      index += 1;
      continue;
    }

    if (token.startsWith("--cwd=")) {
      cwd = readInlineOptionValue(token, "--cwd");
      continue;
    }

    if (token === "--json") {
      json = true;
      continue;
    }

    if (token.startsWith("-")) {
      throw usageFailure(`Unknown start option: ${token}`);
    }

    throw usageFailure(`Unexpected start argument: ${token}`);
  }

  if (name === undefined) {
    throw usageFailure("The start command requires --name.");
  }

  if (cwd === undefined) {
    throw usageFailure("The start command requires --cwd.");
  }

  return { name, cwd, json };
}

function parseNoArgJsonOptions(command: string, args: readonly string[], globalJson: boolean): boolean {
  let json = globalJson;

  for (const token of args) {
    if (token === "--json") {
      json = true;
      continue;
    }

    if (token.startsWith("-")) {
      throw usageFailure(`Unknown ${command} option: ${token}`);
    }

    throw usageFailure(`The ${command} command does not accept positional arguments.`);
  }

  return json;
}

function parseModelOptions(
  args: readonly string[],
  globalJson: boolean
): {
  readonly session: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly expectedRevision: number | null;
  readonly json: boolean;
} {
  const [session, ...rest] = args;
  if (session === undefined || session.startsWith("-")) {
    throw usageFailure("The model command requires one managed session id.");
  }
  let model: string | null = null;
  let effort: string | null = null;
  let expectedRevision: number | null = null;
  let effortSeen = false;
  let revisionSeen = false;
  let json = globalJson;

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined) continue;
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--effort") {
      if (effortSeen) throw usageFailure("The model command accepts --effort only once.");
      effort = readOptionValue(rest, index, "--effort");
      effortSeen = true;
      index += 1;
      continue;
    }
    if (token.startsWith("--effort=")) {
      if (effortSeen) throw usageFailure("The model command accepts --effort only once.");
      effort = readInlineOptionValue(token, "--effort");
      effortSeen = true;
      continue;
    }
    if (token === "--expected-revision") {
      if (revisionSeen) throw usageFailure("The model command accepts --expected-revision only once.");
      expectedRevision = parsePositiveRevision(readOptionValue(rest, index, "--expected-revision"));
      revisionSeen = true;
      index += 1;
      continue;
    }
    if (token.startsWith("--expected-revision=")) {
      if (revisionSeen) throw usageFailure("The model command accepts --expected-revision only once.");
      expectedRevision = parsePositiveRevision(readInlineOptionValue(token, "--expected-revision"));
      revisionSeen = true;
      continue;
    }
    if (token.startsWith("-")) throw usageFailure(`Unknown model option: ${token}`);
    if (model !== null) throw usageFailure(`Unexpected model argument: ${token}`);
    model = token;
  }

  if (model === null && (effortSeen || revisionSeen)) {
    throw usageFailure("Model effort and expected revision require one catalog model id.");
  }
  return { session, model, effort, expectedRevision, json };
}

function parsePositiveRevision(candidate: string): number {
  if (!/^[1-9]\d*$/u.test(candidate)) {
    throw usageFailure("Model expected revision must be a positive integer.");
  }
  const revision = Number(candidate);
  if (!Number.isSafeInteger(revision)) {
    throw usageFailure("Model expected revision exceeds the supported range.");
  }
  return revision;
}

function parseGoalOptions(
  args: readonly string[],
  globalJson: boolean
): {
  readonly session: string;
  readonly action: "clear" | "complete" | "pause" | "resume" | "set" | null;
  readonly objective: string | null;
  readonly expectedRevision: string | null;
  readonly json: boolean;
} {
  const [session, actionCandidate, ...rest] = args;
  if (session === undefined || session.startsWith("-")) {
    throw usageFailure("The goal command requires one managed session id.");
  }
  if (actionCandidate === undefined) {
    return { session, action: null, objective: null, expectedRevision: null, json: globalJson };
  }
  if (!isGoalAction(actionCandidate)) {
    throw usageFailure(`Unknown goal action: ${actionCandidate}`);
  }

  let objective: string | null = null;
  let expectedRevision: string | null = null;
  let objectiveSeen = false;
  let revisionSeen = false;
  let json = globalJson;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined) continue;
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--objective") {
      if (objectiveSeen) throw usageFailure("The goal command accepts --objective only once.");
      objective = readOptionValue(rest, index, "--objective");
      objectiveSeen = true;
      index += 1;
      continue;
    }
    if (token.startsWith("--objective=")) {
      if (objectiveSeen) throw usageFailure("The goal command accepts --objective only once.");
      objective = readInlineOptionValue(token, "--objective");
      objectiveSeen = true;
      continue;
    }
    if (token === "--expected-revision") {
      if (revisionSeen) throw usageFailure("The goal command accepts --expected-revision only once.");
      expectedRevision = parseGoalRevision(readOptionValue(rest, index, "--expected-revision"));
      revisionSeen = true;
      index += 1;
      continue;
    }
    if (token.startsWith("--expected-revision=")) {
      if (revisionSeen) throw usageFailure("The goal command accepts --expected-revision only once.");
      expectedRevision = parseGoalRevision(readInlineOptionValue(token, "--expected-revision"));
      revisionSeen = true;
      continue;
    }
    if (token.startsWith("-")) throw usageFailure(`Unknown goal option: ${token}`);
    throw usageFailure(`Unexpected goal argument: ${token}`);
  }

  if (actionCandidate === "set") {
    if (!objectiveSeen) throw usageFailure("The goal set action requires --objective.");
  } else {
    if (objectiveSeen) throw usageFailure("Only the goal set action accepts --objective.");
    if (!revisionSeen) throw usageFailure(`The goal ${actionCandidate} action requires --expected-revision.`);
  }
  return { session, action: actionCandidate, objective, expectedRevision, json };
}

function isGoalAction(candidate: string): candidate is "clear" | "complete" | "pause" | "resume" | "set" {
  return candidate === "set" || candidate === "pause" || candidate === "resume" || candidate === "complete" || candidate === "clear";
}

function parseGoalRevision(candidate: string): string {
  if (!/^[a-f0-9]{64}$/u.test(candidate)) {
    throw usageFailure("Goal expected revision must be 64 lowercase hexadecimal characters.");
  }
  return candidate;
}

function parsePairOptions(args: readonly string[], globalJson: boolean): {
  readonly label?: string;
  readonly permission: "read" | "write";
} {
  if (globalJson) {
    throw usageFailure("The pair command does not support --json because its output contains a one-time secret.");
  }
  let label: string | undefined;
  let permission: "read" | "write" = "write";
  let permissionOptionSeen = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === undefined) {
      continue;
    }

    if (token === "--json") {
      throw usageFailure("The pair command does not support --json because its output contains a one-time secret.");
    }

    if (token === "--label") {
      if (label !== undefined) throw usageFailure("The pair command accepts --label only once.");
      label = readOptionValue(args, index, "--label");
      index += 1;
      continue;
    }

    if (token.startsWith("--label=")) {
      if (label !== undefined) throw usageFailure("The pair command accepts --label only once.");
      label = readInlineOptionValue(token, "--label");
      continue;
    }

    if (token === "--read-only") {
      if (permissionOptionSeen) throw usageFailure("The pair command accepts one permission option.");
      permission = "read";
      permissionOptionSeen = true;
      continue;
    }

    if (token === "--write") {
      if (permissionOptionSeen) throw usageFailure("The pair command accepts one permission option.");
      permission = "write";
      permissionOptionSeen = true;
      continue;
    }

    if (token.startsWith("-")) {
      throw usageFailure(`Unknown pair option: ${token}`);
    }

    throw usageFailure(`Unexpected pair argument: ${token}`);
  }

  return {
    ...(label !== undefined ? { label } : {}),
    permission
  };
}

function parseLockOptions(args: readonly string[], globalJson: boolean): { readonly reason?: string; readonly json: boolean } {
  let reason: string | undefined;
  let json = globalJson;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === undefined) {
      continue;
    }

    if (token === "--json") {
      json = true;
      continue;
    }

    if (token === "--reason") {
      reason = readOptionValue(args, index, "--reason");
      index += 1;
      continue;
    }

    if (token.startsWith("--reason=")) {
      reason = readInlineOptionValue(token, "--reason");
      continue;
    }

    if (token.startsWith("-")) {
      throw usageFailure(`Unknown lock option: ${token}`);
    }

    throw usageFailure(`Unexpected lock argument: ${token}`);
  }

  return {
    ...(reason !== undefined ? { reason } : {}),
    json
  };
}

function singleSessionArgument(command: string, args: readonly string[]): string {
  if (args.length !== 1) {
    throw usageFailure(`The ${command} command requires exactly one session target.`);
  }

  return args[0] ?? "";
}

function readOptionValue(args: readonly string[], index: number, optionName: string): string {
  const value = args[index + 1];

  if (value === undefined || value.startsWith("--")) {
    throw usageFailure(`${optionName} requires a value.`, optionName);
  }

  return value;
}

function readInlineOptionValue(token: string, optionName: string): string {
  const value = token.slice(optionName.length + 1);

  if (value.length === 0) {
    throw usageFailure(`${optionName} requires a value.`, optionName);
  }

  return value;
}
