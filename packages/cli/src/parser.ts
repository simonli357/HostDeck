import { usageFailure } from "./errors.js";

export type ParsedCliCommand =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "status"; readonly json: boolean }
  | { readonly kind: "start"; readonly name: string; readonly cwd: string; readonly json: boolean }
  | { readonly kind: "list"; readonly json: boolean }
  | { readonly kind: "send"; readonly session: string; readonly text: string }
  | { readonly kind: "attach"; readonly session: string }
  | { readonly kind: "stop"; readonly session: string };

export interface ParsedCliArgs {
  readonly command: ParsedCliCommand;
  readonly configFlags: {
    readonly apiUrl?: string;
    readonly host?: string;
    readonly port?: string;
    readonly configPath?: string;
  };
}

type MutableConfigFlags = {
  apiUrl?: string;
  host?: string;
  port?: string;
  configPath?: string;
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
    if (rest.length > 0) {
      throw usageFailure("The status command does not accept positional arguments.");
    }

    return { command: { kind: "status", json }, configFlags };
  }

  if (command === "start") {
    const parsed = parseStartOptions(rest);

    return { command: { kind: "start", name: parsed.name, cwd: parsed.cwd, json }, configFlags };
  }

  if (command === "list") {
    if (rest.length > 0) {
      throw usageFailure("The list command does not accept positional arguments.");
    }

    return { command: { kind: "list", json }, configFlags };
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

  throw usageFailure(`Unknown command: ${command ?? ""}`);
}

function parseStartOptions(args: readonly string[]): { readonly name: string; readonly cwd: string } {
  let name: string | undefined;
  let cwd: string | undefined;

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

  return { name, cwd };
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
