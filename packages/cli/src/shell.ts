import type { ApiErrorEnvelope, ApiSession } from "@hostdeck/contracts";
import { type HostHttpService, type StartHostHttpServiceInput, startHostHttpService } from "@hostdeck/server";
import { createHostDeckApiClient, type HostDeckApiClient, type HttpFetch } from "./api-client.js";
import { type LoadCliConfigOptions, loadCliConfig } from "./config.js";
import { apiFailure, configFailure, toCliFailure, usageFailure } from "./errors.js";
import { type CliExitCode, cliExitCodes } from "./exit-codes.js";
import { createLocalAdmin, type LocalAdmin } from "./local-admin.js";
import { parseCliArgs } from "./parser.js";
import {
  renderAttachCommand,
  renderFailure,
  renderHelp,
  renderLockCommand,
  renderPairingCode,
  renderServeStarted,
  renderServeStopped,
  renderSessionList,
  renderStartSession,
  renderStatus,
  renderVersion,
  renderWriteAccepted
} from "./render.js";

export interface CliRunResult {
  readonly exitCode: CliExitCode;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CliRunOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly readFile?: LoadCliConfigOptions["readFile"];
  readonly fetch?: HttpFetch;
  readonly client?: HostDeckApiClient;
  readonly localAdmin?: LocalAdmin;
  readonly startService?: (input: StartHostHttpServiceInput) => Promise<HostHttpService>;
  readonly waitForShutdown?: () => Promise<void>;
  readonly writeStdout?: (chunk: string) => void;
  readonly version?: string;
}

const defaultVersion = "0.0.0";

export async function runCli(args: readonly string[], options: CliRunOptions = {}): Promise<CliRunResult> {
  try {
    const parsed = parseCliArgs(args);

    if (parsed.command.kind === "help") {
      return success(renderHelp());
    }

    if (parsed.command.kind === "version") {
      return success(renderVersion(options.version ?? defaultVersion));
    }

    const configOptions: LoadCliConfigOptions = {
      flags: parsed.configFlags
    };

    if (options.env !== undefined) {
      Object.assign(configOptions, { env: options.env });
    }

    if (options.cwd !== undefined) {
      Object.assign(configOptions, { cwd: options.cwd });
    }

    if (options.readFile !== undefined) {
      Object.assign(configOptions, { readFile: options.readFile });
    }

    const config = loadCliConfig(configOptions);
    const localAdmin =
      options.localAdmin ??
      createLocalAdmin({
        stateDir: config.stateDir,
        databasePath: config.databasePath
      });
    const clientOptions = { baseUrl: config.baseUrl };

    if (options.fetch !== undefined) {
      Object.assign(clientOptions, { fetch: options.fetch });
    }

    const client = options.client ?? createHostDeckApiClient(clientOptions);

    if (parsed.command.kind === "serve") {
      if (config.runtimeDir === null) {
        throw configFailure("XDG_RUNTIME_DIR is required to start the HostDeck service securely.", "runtime_dir");
      }
      const service = await (options.startService ?? startHostHttpService)({
        version: options.version ?? defaultVersion,
        configDir: config.configDir,
        stateDir: config.stateDir,
        runtimeDir: config.runtimeDir,
        databasePath: config.databasePath,
        bindPort: portFromBaseUrl(config.baseUrl)
      });
      let output = emitStdout(renderServeStarted(service.baseUrl), options.writeStdout);

      try {
        await (options.waitForShutdown ?? waitForTerminationSignal)();
      } finally {
        await service.close();
      }

      output += emitStdout(renderServeStopped(), options.writeStdout);
      return success(output);
    }

    if (parsed.command.kind === "status") {
      return success(renderStatus(await client.getStatus(), parsed.command.json));
    }

    if (parsed.command.kind === "start") {
      return success(renderStartSession(await client.startSession({ name: parsed.command.name, cwd: parsed.command.cwd }), parsed.command.json));
    }

    if (parsed.command.kind === "list") {
      return success(renderSessionList(await client.listSessions(), parsed.command.json));
    }

    if (parsed.command.kind === "send") {
      const session = await resolveManagedSession(client, parsed.command.session);
      requireWritableSession(session);
      return success(renderWriteAccepted(await client.sendPrompt(session.id, parsed.command.text)));
    }

    if (parsed.command.kind === "attach") {
      const session = await resolveManagedSession(client, parsed.command.session);
      requireAttachableSession(session);
      return success(renderAttachCommand(session));
    }

    if (parsed.command.kind === "stop") {
      const session = await resolveManagedSession(client, parsed.command.session);
      requireWritableSession(session);
      return success(renderWriteAccepted(await client.stopSession(session.id)));
    }

    if (parsed.command.kind === "pair") {
      return success(
        renderPairingCode(
          localAdmin.createPairingCode({
            permission: parsed.command.permission,
            ttlMinutes: parsed.command.ttlMinutes,
            ...(parsed.command.label !== undefined ? { label: parsed.command.label } : {})
          }),
          parsed.command.json
        )
      );
    }

    if (parsed.command.kind === "lock") {
      return success(
        renderLockCommand(
          localAdmin.setLock({
            locked: true,
            ...(parsed.command.reason !== undefined ? { reason: parsed.command.reason } : {})
          }),
          parsed.command.json
        )
      );
    }

    if (parsed.command.kind === "unlock") {
      return success(renderLockCommand(localAdmin.setLock({ locked: false }), parsed.command.json));
    }

    return failure(toCliFailure(new Error("Unsupported HostDeck CLI command.")));
  } catch (error) {
    return failure(toCliFailure(error));
  }
}

async function resolveManagedSession(client: HostDeckApiClient, target: string): Promise<ApiSession> {
  const sessions = (await client.listSessions()).sessions.filter((session) => session.id === target || session.name === target);

  if (sessions.length === 0) {
    throw usageFailure(`No managed session matches ${target}.`, "session");
  }

  if (sessions.length > 1) {
    throw usageFailure(`Session target ${target} matches more than one managed session. Use a session id.`, "session");
  }

  const session = sessions[0];

  if (session === undefined) {
    throw usageFailure(`No managed session matches ${target}.`, "session");
  }

  return session;
}

function requireAttachableSession(session: ApiSession): void {
  if (session.lifecycle_state === "running") {
    return;
  }

  throw apiFailure(statusForLifecycle(session), sessionLifecycleError(session, "attach"));
}

function requireWritableSession(session: ApiSession): void {
  if (session.lifecycle_state === "running") {
    return;
  }

  throw apiFailure(statusForLifecycle(session), sessionLifecycleError(session, "write"));
}

function statusForLifecycle(session: ApiSession): number {
  return session.lifecycle_state === "stale" ? 409 : 409;
}

function sessionLifecycleError(session: ApiSession, action: "attach" | "write"): ApiErrorEnvelope {
  if (session.lifecycle_state === "stale") {
    return {
      code: "stale_session",
      message: `Session ${session.id} is stale and cannot ${action}.`,
      retryable: false,
      session_id: session.id
    };
  }

  return {
    code: "session_not_writable",
    message: `Session ${session.id} is ${session.lifecycle_state} and cannot ${action}.`,
    retryable: false,
    session_id: session.id
  };
}

export async function main(args = process.argv.slice(2), options: CliRunOptions = {}): Promise<CliExitCode> {
  const result = await runCli(args, {
    ...options,
    writeStdout: options.writeStdout ?? ((chunk) => process.stdout.write(chunk))
  });

  if (result.stdout.length > 0) {
    process.stdout.write(result.stdout);
  }

  if (result.stderr.length > 0) {
    process.stderr.write(result.stderr);
  }

  process.exitCode = result.exitCode;
  return result.exitCode;
}

function success(stdout: string): CliRunResult {
  return {
    exitCode: cliExitCodes.ok,
    stdout,
    stderr: ""
  };
}

function emitStdout(chunk: string, writeStdout: ((chunk: string) => void) | undefined): string {
  if (writeStdout !== undefined) {
    writeStdout(chunk);
    return "";
  }

  return chunk;
}

function portFromBaseUrl(baseUrl: URL): number {
  const port = baseUrl.port.length > 0 ? Number(baseUrl.port) : baseUrl.protocol === "https:" ? 443 : 80;

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw usageFailure(`Invalid serve port in ${baseUrl.toString()}.`, "port");
  }

  return port;
}

function waitForTerminationSignal(): Promise<void> {
  return new Promise((resolveSignal) => {
    function cleanup(): void {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }

    function onSignal(): void {
      cleanup();
      resolveSignal();
    }

    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}

function failure(error: ReturnType<typeof toCliFailure>): CliRunResult {
  return {
    exitCode: error.exitCode,
    stdout: "",
    stderr: renderFailure(error)
  };
}
