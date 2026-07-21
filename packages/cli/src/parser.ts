import {
  selectedDeviceIdSchema,
  selectedDeviceListCursorSchema,
  selectedSessionListCursorSchema
} from "@hostdeck/contracts";
import { usageFailure } from "./errors.js";

export type ParsedCliCommand =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "serve" }
  | { readonly kind: "status"; readonly json: boolean }
  | {
      readonly kind: "list";
      readonly limit: number | null;
      readonly cursor: string | null;
      readonly json: boolean;
    }
  | {
      readonly kind: "devices";
      readonly limit: number | null;
      readonly cursor: string | null;
      readonly json: boolean;
    }
  | {
      readonly kind: "revoke";
      readonly deviceId: string;
      readonly confirm: true;
      readonly json: boolean;
    }
  | {
      readonly kind: "service";
      readonly action:
        | "install"
        | "upgrade"
        | "status"
        | "start"
        | "stop"
        | "restart"
        | "uninstall";
      readonly json: boolean;
    }
  | { readonly kind: "start"; readonly name: string; readonly cwd: string; readonly json: boolean }
  | { readonly kind: "archive"; readonly session: string; readonly json: boolean }
  | { readonly kind: "send"; readonly session: string; readonly text: string; readonly json: boolean }
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
  | {
      readonly kind: "plan";
      readonly session: string;
      readonly action: "enter" | "exit" | null;
      readonly expectedRevision: number | null;
      readonly json: boolean;
    }
  | { readonly kind: "usage"; readonly session: string; readonly json: boolean }
  | { readonly kind: "compact"; readonly session: string; readonly confirm: boolean; readonly json: boolean }
  | { readonly kind: "skills"; readonly session: string; readonly json: boolean }
  | {
      readonly kind: "approvals";
      readonly session: string;
      readonly request: string | null;
      readonly decision: "approve" | "deny" | null;
      readonly confirm: boolean;
      readonly json: boolean;
    }
  | {
      readonly kind: "interrupt";
      readonly session: string;
      readonly turn: string;
      readonly confirm: true;
      readonly json: boolean;
    }
  | {
      readonly kind: "pair";
      readonly label?: string;
      readonly permission: "read" | "write";
    }
  | { readonly kind: "lock"; readonly json: boolean }
  | { readonly kind: "unlock"; readonly json: boolean }
  | {
      readonly kind: "legacy";
      readonly action: "reset" | "status";
      readonly confirmed: boolean;
      readonly json: boolean;
    }
  | {
      readonly kind: "remote";
      readonly action: "disable" | "enable" | "status";
      readonly json: boolean;
    };

export interface ParsedCliArgs {
  readonly command: ParsedCliCommand;
  readonly configFlags: {
    readonly apiUrl?: string;
    readonly port?: string;
    readonly configPath?: string;
    readonly stateDir?: string;
    readonly databasePath?: string;
  };
}

type MutableConfigFlags = {
  apiUrl?: string;
  port?: string;
  configPath?: string;
  stateDir?: string;
  databasePath?: string;
};

export function parseCliArgs(args: readonly string[]): ParsedCliArgs {
  const configFlags: MutableConfigFlags = {};
  const seenConfigFlags = new Set<keyof MutableConfigFlags>();
  const positionals: string[] = [];
  let json = false;
  let jsonSeen = false;
  let metaCommand: "help" | "version" | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === undefined) {
      continue;
    }

    if (token === "--help" || token === "-h") {
      if (positionals.length > 0) {
        throw usageFailure(`${token} must appear before the command.`);
      }
      if (metaCommand !== null) {
        throw usageFailure("Help and version options may be specified only once.");
      }
      metaCommand = "help";
      continue;
    }

    if (token === "--version" || token === "-v") {
      if (positionals.length > 0) {
        throw usageFailure(`${token} must appear before the command.`);
      }
      if (metaCommand !== null) {
        throw usageFailure("Help and version options may be specified only once.");
      }
      metaCommand = "version";
      continue;
    }

    if (token === "--json") {
      if (jsonSeen) {
        throw usageFailure("The --json option may be specified only once.");
      }
      json = true;
      jsonSeen = true;
      continue;
    }

    if (token === "--api-url") {
      requireGlobalOptionPosition(token, positionals);
      setConfigFlag(
        configFlags,
        seenConfigFlags,
        "apiUrl",
        readOptionValue(args, index, "--api-url"),
        "--api-url"
      );
      index += 1;
      continue;
    }

    if (token.startsWith("--api-url=")) {
      requireGlobalOptionPosition("--api-url", positionals);
      setConfigFlag(
        configFlags,
        seenConfigFlags,
        "apiUrl",
        readInlineOptionValue(token, "--api-url"),
        "--api-url"
      );
      continue;
    }

    if (token === "--port") {
      requireGlobalOptionPosition(token, positionals);
      setConfigFlag(
        configFlags,
        seenConfigFlags,
        "port",
        readOptionValue(args, index, "--port"),
        "--port"
      );
      index += 1;
      continue;
    }

    if (token.startsWith("--port=")) {
      requireGlobalOptionPosition("--port", positionals);
      setConfigFlag(
        configFlags,
        seenConfigFlags,
        "port",
        readInlineOptionValue(token, "--port"),
        "--port"
      );
      continue;
    }

    if (token === "--config") {
      requireGlobalOptionPosition(token, positionals);
      setConfigFlag(
        configFlags,
        seenConfigFlags,
        "configPath",
        readOptionValue(args, index, "--config"),
        "--config"
      );
      index += 1;
      continue;
    }

    if (token.startsWith("--config=")) {
      requireGlobalOptionPosition("--config", positionals);
      setConfigFlag(
        configFlags,
        seenConfigFlags,
        "configPath",
        readInlineOptionValue(token, "--config"),
        "--config"
      );
      continue;
    }

    if (token === "--state-dir") {
      requireGlobalOptionPosition(token, positionals);
      setConfigFlag(
        configFlags,
        seenConfigFlags,
        "stateDir",
        readOptionValue(args, index, "--state-dir"),
        "--state-dir"
      );
      index += 1;
      continue;
    }

    if (token.startsWith("--state-dir=")) {
      requireGlobalOptionPosition("--state-dir", positionals);
      setConfigFlag(
        configFlags,
        seenConfigFlags,
        "stateDir",
        readInlineOptionValue(token, "--state-dir"),
        "--state-dir"
      );
      continue;
    }

    if (token === "--database" || token === "--database-path") {
      requireGlobalOptionPosition(token, positionals);
      setConfigFlag(
        configFlags,
        seenConfigFlags,
        "databasePath",
        readOptionValue(args, index, token),
        token
      );
      index += 1;
      continue;
    }

    if (token.startsWith("--database=")) {
      requireGlobalOptionPosition("--database", positionals);
      setConfigFlag(
        configFlags,
        seenConfigFlags,
        "databasePath",
        readInlineOptionValue(token, "--database"),
        "--database"
      );
      continue;
    }

    if (token.startsWith("--database-path=")) {
      requireGlobalOptionPosition("--database-path", positionals);
      setConfigFlag(
        configFlags,
        seenConfigFlags,
        "databasePath",
        readInlineOptionValue(token, "--database-path"),
        "--database-path"
      );
      continue;
    }

    if (token === "--") {
      if (
        positionals[0] === "model" ||
        positionals[0] === "goal" ||
        positionals[0] === "plan" ||
        positionals[0] === "compact" ||
        positionals[0] === "approvals" ||
        positionals[0] === "interrupt" ||
        positionals[0] === "legacy" ||
        positionals[0] === "serve" ||
        positionals[0] === "status" ||
        positionals[0] === "list" ||
        positionals[0] === "devices" ||
        positionals[0] === "revoke" ||
        positionals[0] === "service"
      ) {
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

  if (metaCommand !== null) {
    if (positionals.length > 0 || json) {
      throw usageFailure(`The ${metaCommand} option does not accept command arguments or --json.`);
    }
    return { command: { kind: metaCommand }, configFlags };
  }

  if (positionals.length === 0) {
    if (json) {
      throw usageFailure("The --json option requires a command.");
    }
    return { command: { kind: "help" }, configFlags };
  }

  const [command, ...rest] = positionals;

  if (command === "help") {
    if (rest.length > 0 || json) {
      throw usageFailure("The help command does not accept extra arguments.");
    }

    return { command: { kind: "help" }, configFlags };
  }

  if (command === "version") {
    if (rest.length > 0 || json) {
      throw usageFailure("The version command does not accept extra arguments.");
    }

    return { command: { kind: "version" }, configFlags };
  }

  if (command === "serve") {
    if (rest.length > 0 || json) {
      throw usageFailure("The serve command does not accept arguments or --json.");
    }
    return { command: { kind: "serve" }, configFlags };
  }

  if (command === "status") {
    return {
      command: {
        kind: "status",
        json: parseNoArgJsonOptions("status", rest, json)
      },
      configFlags
    };
  }

  if (command === "list") {
    return {
      command: parsePaginationCommand("list", rest, json),
      configFlags
    };
  }

  if (command === "devices") {
    return {
      command: parsePaginationCommand("devices", rest, json),
      configFlags
    };
  }

  if (command === "revoke") {
    return { command: parseRevokeCommand(rest, json), configFlags };
  }

  if (command === "service") {
    return { command: parseServiceCommand(rest, json), configFlags };
  }

  if (command === "start") {
    const parsed = parseStartOptions(rest);

    return { command: { kind: "start", name: parsed.name, cwd: parsed.cwd, json: parsed.json || json }, configFlags };
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

  if (command === "plan") {
    const parsed = parsePlanOptions(rest, json);
    return {
      command: {
        kind: "plan",
        session: parsed.session,
        action: parsed.action,
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

  if (command === "compact") {
    const parsed = parseCompactOptions(rest, json);
    return {
      command: {
        kind: "compact",
        session: parsed.session,
        confirm: parsed.confirm,
        json: parsed.json
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

  if (command === "approvals") {
    const parsed = parseApprovalsOptions(rest, json);
    return {
      command: {
        kind: "approvals",
        session: parsed.session,
        request: parsed.request,
        decision: parsed.decision,
        confirm: parsed.confirm,
        json: parsed.json
      },
      configFlags
    };
  }

  if (command === "interrupt") {
    const parsed = parseInterruptOptions(rest, json);
    return {
      command: {
        kind: "interrupt",
        session: parsed.session,
        turn: parsed.turn,
        confirm: true,
        json: parsed.json
      },
      configFlags
    };
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
    return {
      command: {
        kind: "lock",
        json: parseNoArgJsonOptions("lock", rest, json)
      },
      configFlags
    };
  }

  if (command === "unlock") {
    return { command: { kind: "unlock", json: parseNoArgJsonOptions("unlock", rest, json) }, configFlags };
  }

  if (command === "legacy") {
    return { command: parseLegacyCommand(rest, json), configFlags };
  }

  if (command === "remote") {
    return {
      command: parseRemoteCommand(rest, json),
      configFlags
    };
  }

  throw usageFailure(`Unknown command: ${command ?? ""}`);
}

function parseLegacyCommand(
  args: readonly string[],
  globalJson: boolean
): Extract<ParsedCliCommand, { readonly kind: "legacy" }> {
  const [action, ...rest] = args;
  if (action === "status") {
    return {
      kind: "legacy",
      action,
      confirmed: false,
      json: parseNoArgJsonOptions("legacy status", rest, globalJson)
    };
  }
  if (action === "reset") {
    if (rest.length !== 1 || rest[0] !== "--confirm") {
      throw usageFailure("Legacy reset requires --confirm.");
    }
    return { kind: "legacy", action, confirmed: true, json: globalJson };
  }
  throw usageFailure("Legacy requires status or reset --confirm.");
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

function parsePaginationCommand(
  command: "devices" | "list",
  args: readonly string[],
  globalJson: boolean
): Extract<ParsedCliCommand, { readonly kind: "devices" | "list" }> {
  let limit: number | null = null;
  let cursor: string | null = null;
  let limitSeen = false;
  let cursorSeen = false;
  let json = globalJson;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) continue;

    if (token === "--json") {
      if (json) throw usageFailure(`The ${command} command accepts --json only once.`);
      json = true;
      continue;
    }

    if (token === "--limit") {
      if (limitSeen) throw usageFailure(`The ${command} command accepts --limit only once.`);
      limit = parsePageLimit(readOptionValue(args, index, "--limit"), command);
      limitSeen = true;
      index += 1;
      continue;
    }

    if (token.startsWith("--limit=")) {
      if (limitSeen) throw usageFailure(`The ${command} command accepts --limit only once.`);
      limit = parsePageLimit(readInlineOptionValue(token, "--limit"), command);
      limitSeen = true;
      continue;
    }

    if (token === "--cursor") {
      if (cursorSeen) throw usageFailure(`The ${command} command accepts --cursor only once.`);
      cursor = parsePageCursor(
        readOptionValue(args, index, "--cursor"),
        command
      );
      cursorSeen = true;
      index += 1;
      continue;
    }

    if (token.startsWith("--cursor=")) {
      if (cursorSeen) throw usageFailure(`The ${command} command accepts --cursor only once.`);
      cursor = parsePageCursor(
        readInlineOptionValue(token, "--cursor"),
        command
      );
      cursorSeen = true;
      continue;
    }

    if (token.startsWith("-")) {
      throw usageFailure(`Unknown ${command} option: ${token}`);
    }
    throw usageFailure(`The ${command} command does not accept positional arguments.`);
  }

  return { kind: command, limit, cursor, json };
}

function parsePageLimit(candidate: string, command: "devices" | "list"): number {
  if (!/^(?:[1-9]|[1-9][0-9]|100)$/u.test(candidate)) {
    throw usageFailure(`${command} limit must be an integer from 1 through 100.`, "--limit");
  }
  return Number(candidate);
}

function parsePageCursor(candidate: string, command: "devices" | "list"): string {
  const schema =
    command === "list"
      ? selectedSessionListCursorSchema
      : selectedDeviceListCursorSchema;
  if (!schema.safeParse(candidate).success) {
    throw usageFailure(`${command} cursor is invalid.`, "--cursor");
  }
  return candidate;
}

function parseRevokeCommand(
  args: readonly string[],
  globalJson: boolean
): Extract<ParsedCliCommand, { readonly kind: "revoke" }> {
  const [deviceIdCandidate, ...rest] = args;
  const deviceId = selectedDeviceIdSchema.safeParse(deviceIdCandidate);
  if (!deviceId.success) {
    throw usageFailure("The revoke command requires one valid device id.", "device_id");
  }

  let confirmed = false;
  let json = globalJson;
  for (const token of rest) {
    if (token === "--confirm") {
      if (confirmed) throw usageFailure("The revoke command accepts --confirm only once.");
      confirmed = true;
      continue;
    }
    if (token === "--json") {
      if (json) throw usageFailure("The revoke command accepts --json only once.");
      json = true;
      continue;
    }
    if (token.startsWith("-")) {
      throw usageFailure(`Unknown revoke option: ${token}`);
    }
    throw usageFailure(`Unexpected revoke argument: ${token}`);
  }

  if (!confirmed) {
    throw usageFailure("Device revoke requires --confirm.");
  }
  return { kind: "revoke", deviceId: deviceId.data, confirm: true, json };
}

function parseServiceCommand(
  args: readonly string[],
  globalJson: boolean
): Extract<ParsedCliCommand, { readonly kind: "service" }> {
  const [action, ...rest] = args;
  if (!isServiceAction(action)) {
    throw usageFailure(
      "Service requires install, upgrade, status, start, stop, restart, or uninstall."
    );
  }
  return {
    kind: "service",
    action,
    json: parseNoArgJsonOptions(`service ${action}`, rest, globalJson)
  };
}

function isServiceAction(
  candidate: string | undefined
): candidate is Extract<ParsedCliCommand, { readonly kind: "service" }>["action"] {
  return (
    candidate === "install" ||
    candidate === "upgrade" ||
    candidate === "status" ||
    candidate === "start" ||
    candidate === "stop" ||
    candidate === "restart" ||
    candidate === "uninstall"
  );
}

function parseStartOptions(args: readonly string[]): { readonly name: string; readonly cwd: string; readonly json: boolean } {
  let name: string | undefined;
  let cwd: string | undefined;
  let json = false;
  let nameSeen = false;
  let cwdSeen = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === undefined) {
      continue;
    }

    if (token === "--name") {
      if (nameSeen) throw usageFailure("The start command accepts --name only once.");
      name = readOptionValue(args, index, "--name");
      nameSeen = true;
      index += 1;
      continue;
    }

    if (token.startsWith("--name=")) {
      if (nameSeen) throw usageFailure("The start command accepts --name only once.");
      name = readInlineOptionValue(token, "--name");
      nameSeen = true;
      continue;
    }

    if (token === "--cwd") {
      if (cwdSeen) throw usageFailure("The start command accepts --cwd only once.");
      cwd = readOptionValue(args, index, "--cwd");
      cwdSeen = true;
      index += 1;
      continue;
    }

    if (token.startsWith("--cwd=")) {
      if (cwdSeen) throw usageFailure("The start command accepts --cwd only once.");
      cwd = readInlineOptionValue(token, "--cwd");
      cwdSeen = true;
      continue;
    }

    if (token === "--json") {
      if (json) throw usageFailure("The start command accepts --json only once.");
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
      if (json) throw usageFailure(`The ${command} command accepts --json only once.`);
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

function parsePlanOptions(
  args: readonly string[],
  globalJson: boolean
): {
  readonly session: string;
  readonly action: "enter" | "exit" | null;
  readonly expectedRevision: number | null;
  readonly json: boolean;
} {
  const [session, actionCandidate, ...rest] = args;
  if (session === undefined || session.startsWith("-")) {
    throw usageFailure("The plan command requires one managed session id.");
  }
  if (actionCandidate === undefined) {
    return { session, action: null, expectedRevision: null, json: globalJson };
  }
  if (actionCandidate !== "enter" && actionCandidate !== "exit") {
    throw usageFailure(`Unknown plan action: ${actionCandidate}`);
  }

  let expectedRevision: number | null = null;
  let revisionSeen = false;
  let json = globalJson;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined) continue;
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--expected-revision") {
      if (revisionSeen) throw usageFailure("The plan command accepts --expected-revision only once.");
      expectedRevision = parsePlanRevision(readOptionValue(rest, index, "--expected-revision"));
      revisionSeen = true;
      index += 1;
      continue;
    }
    if (token.startsWith("--expected-revision=")) {
      if (revisionSeen) throw usageFailure("The plan command accepts --expected-revision only once.");
      expectedRevision = parsePlanRevision(readInlineOptionValue(token, "--expected-revision"));
      revisionSeen = true;
      continue;
    }
    if (token.startsWith("-")) throw usageFailure(`Unknown plan option: ${token}`);
    throw usageFailure(`Unexpected plan argument: ${token}`);
  }
  return { session, action: actionCandidate, expectedRevision, json };
}

function parsePlanRevision(candidate: string): number {
  if (!/^[1-9]\d*$/u.test(candidate)) {
    throw usageFailure("Plan expected revision must be a positive integer.");
  }
  const revision = Number(candidate);
  if (!Number.isSafeInteger(revision)) {
    throw usageFailure("Plan expected revision exceeds the supported range.");
  }
  return revision;
}

function parseCompactOptions(
  args: readonly string[],
  globalJson: boolean
): { readonly session: string; readonly confirm: boolean; readonly json: boolean } {
  const [session, ...rest] = args;
  if (session === undefined || session.startsWith("-")) {
    throw usageFailure("The compact command requires one managed session id.");
  }
  let confirm = false;
  for (const token of rest) {
    if (token === "--confirm") {
      if (confirm) throw usageFailure("The compact command accepts --confirm only once.");
      confirm = true;
      continue;
    }
    if (token.startsWith("-")) throw usageFailure(`Unknown compact option: ${token}`);
    throw usageFailure(`Unexpected compact argument: ${token}`);
  }
  return { session, confirm, json: globalJson };
}

function parseApprovalsOptions(
  args: readonly string[],
  globalJson: boolean
): {
  readonly session: string;
  readonly request: string | null;
  readonly decision: "approve" | "deny" | null;
  readonly confirm: boolean;
  readonly json: boolean;
} {
  const [session, request, decision, ...rest] = args;
  if (session === undefined || session.startsWith("-")) {
    throw usageFailure("The approvals command requires one managed session id.");
  }
  if (request === undefined && decision === undefined && rest.length === 0) {
    return { session, request: null, decision: null, confirm: false, json: globalJson };
  }
  if (
    request === undefined ||
    request.startsWith("-") ||
    (decision !== "approve" && decision !== "deny") ||
    rest.length !== 1 ||
    rest[0] !== "--confirm"
  ) {
    throw usageFailure(
      "Approval response requires SESSION_ID REQUEST_ID approve|deny --confirm."
    );
  }
  return { session, request, decision, confirm: true, json: globalJson };
}

function parseInterruptOptions(
  args: readonly string[],
  globalJson: boolean
): { readonly session: string; readonly turn: string; readonly json: boolean } {
  const [session, turn, ...rest] = args;
  if (session === undefined || session.startsWith("-") || turn === undefined || turn.startsWith("-")) {
    throw usageFailure("Interrupt requires SESSION_ID TURN_ID --confirm.");
  }
  if (rest.length !== 1 || rest[0] !== "--confirm") {
    throw usageFailure("Interrupt requires SESSION_ID TURN_ID --confirm.");
  }
  return { session, turn, json: globalJson };
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

function requireGlobalOptionPosition(
  optionName: string,
  positionals: readonly string[]
): void {
  if (positionals.length > 0) {
    throw usageFailure(`${optionName} must appear before the command.`, optionName);
  }
}

function setConfigFlag(
  flags: MutableConfigFlags,
  seen: Set<keyof MutableConfigFlags>,
  key: keyof MutableConfigFlags,
  value: string,
  optionName: string
): void {
  if (seen.has(key)) {
    throw usageFailure(`${optionName} may be specified only once.`, optionName);
  }
  flags[key] = value;
  seen.add(key);
}
