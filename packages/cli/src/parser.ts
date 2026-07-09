import { usageFailure } from "./errors.js";

export type ParsedCliCommand =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "status"; readonly json: boolean };

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

    if (token.startsWith("-")) {
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

  throw usageFailure(`Unknown command: ${command ?? ""}`);
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
