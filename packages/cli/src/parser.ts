import { usageFailure } from "./errors.js";

export type ParsedCliCommand =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "serve" }
  | { readonly kind: "status"; readonly json: boolean }
  | { readonly kind: "start"; readonly name: string; readonly cwd: string; readonly json: boolean }
  | { readonly kind: "list"; readonly json: boolean }
  | { readonly kind: "send"; readonly session: string; readonly text: string }
  | { readonly kind: "attach"; readonly session: string }
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

  if (command === "send") {
    if (rest.length < 2) {
      throw usageFailure("The send command requires a session target and text.");
    }

    const [session, ...textParts] = rest;

    return {
      command: {
        kind: "send",
        session: session ?? "",
        text: textParts.join(" ")
      },
      configFlags
    };
  }

  if (command === "attach") {
    return { command: { kind: "attach", session: singleSessionArgument("attach", rest) }, configFlags };
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
