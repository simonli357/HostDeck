import { homedir } from "node:os";
import {
  defaultResourceBudget,
  type SharedCodexEndpoint,
  sharedCodexEndpointSchema
} from "@hostdeck/contracts";
import {
  HostDeckSharedCodexBrokerError,
  probeCodexVersion,
  resolveSharedCodexEndpointLocation,
  startSharedCodexBroker,
  stopOwnedSharedCodexBroker
} from "@hostdeck/server";
import { resolveHostDeckCodexExecutable } from "./config.js";
import { clientOperationFailure, configFailure } from "./errors.js";

export type HostDeckBrokerAction = "start" | "status" | "stop";

export interface HostDeckBrokerControlResult {
  readonly action: HostDeckBrokerAction;
  readonly endpoint: SharedCodexEndpoint;
}

export interface HostDeckBrokerControl {
  readonly execute: (action: HostDeckBrokerAction) => Promise<HostDeckBrokerControlResult>;
}

export interface CreateHostDeckBrokerControlOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
}

export function createHostDeckBrokerControl(
  options: CreateHostDeckBrokerControlOptions
): HostDeckBrokerControl {
  const signal = options.signal ?? new AbortController().signal;
  const location = resolveSharedCodexEndpointLocation({
    home_directory: homedir(),
    ...(options.env.CODEX_HOME === undefined
      ? {}
      : { codex_home: options.env.CODEX_HOME })
  });

  return Object.freeze({
    async execute(action: HostDeckBrokerAction) {
      try {
        if (action === "stop") {
          return result(action, await stopOwnedSharedCodexBroker({
            location,
            signal,
            stop_timeout_ms: defaultResourceBudget.lifecycle_shutdown_timeout_ms
          }));
        }

        const codexBin = resolveHostDeckCodexExecutable(options.env);
        const observedVersion = await probeCodexVersion({
          executable: codexBin,
          signal,
          timeout_ms: defaultResourceBudget.protocol_read_timeout_ms
        });
        try {
          const attachment = await startSharedCodexBroker({
            codex_bin: codexBin,
            location,
            mode: action === "start" ? "attach_or_start" : "attach_only",
            observed_version: observedVersion,
            signal,
            startup_timeout_ms: defaultResourceBudget.lifecycle_startup_timeout_ms
          });
          const endpoint = attachment.endpoint;
          await attachment.close();
          return result(action, endpoint);
        } catch (error) {
          if (
            action === "status" &&
            error instanceof HostDeckSharedCodexBrokerError &&
            error.code === "broker_absent"
          ) {
            return result(action, error.endpoint);
          }
          throw error;
        }
      } catch (error) {
        throw mapBrokerFailure(error);
      }
    }
  });
}

function result(
  action: HostDeckBrokerAction,
  endpoint: SharedCodexEndpoint
): HostDeckBrokerControlResult {
  return Object.freeze({
    action,
    endpoint: sharedCodexEndpointSchema.parse(endpoint)
  });
}

function mapBrokerFailure(error: unknown): Error {
  if (!(error instanceof HostDeckSharedCodexBrokerError)) return error as Error;
  if (["insecure_path", "invalid_input"].includes(error.code)) {
    return configFailure("Shared Codex broker configuration is invalid.", "CODEX_HOME", error);
  }
  if (error.code === "unsupported_platform" || error.code === "broker_incompatible") {
    return clientOperationFailure(
      "incompatible_runtime",
      "The installed Codex runtime is not compatible with shared sessions."
    );
  }
  if (["aborted", "coordination_timeout", "startup_timeout"].includes(error.code)) {
    return clientOperationFailure(
      "operation_timeout",
      "The shared Codex broker operation timed out.",
      true
    );
  }
  if (error.code === "broker_not_owned") {
    return clientOperationFailure(
      "permission_denied",
      "HostDeck will not stop a shared Codex broker it does not own."
    );
  }
  return clientOperationFailure(
    "runtime_unavailable",
    "The shared Codex broker operation failed.",
    ["broker_absent", "broker_exited", "socket_changed", "socket_stale"].includes(error.code)
  );
}
