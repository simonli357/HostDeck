import { randomUUID } from "node:crypto";
import type {
  ApiErrorEnvelope,
  ApiSession,
  GoalControlSnapshot,
  GoalMutationRequest,
  ModelControlSnapshot,
  ModelSelectionRequest,
  PlanControlSnapshot,
  PlanSelectionRequest,
  PromptDispatchResponse,
  SelectedOperationDispatch,
  SelectedResumeMetadataResponse,
  SelectedSessionStartResponse,
  SelectedStartSessionRequest,
  SkillsSnapshot,
  UsageSnapshot
} from "@hostdeck/contracts";
import {
  archiveSessionRequestSchema,
  clientOperationIdSchema,
  goalControlSnapshotSchema,
  goalMutationRequestSchema,
  modelControlSnapshotSchema,
  modelSelectionRequestSchema,
  planControlSnapshotSchema,
  planSelectionRequestSchema,
  promptDispatchResponseSchema,
  promptSessionRequestSchema,
  type RemoteDisableRequest,
  type RemoteEnableRequest,
  remoteDisableRequestSchema,
  remoteEnableRequestSchema,
  type SelectedPairRequest,
  selectedOperationDispatchSchema,
  selectedPairRequestSchema,
  selectedResumeMetadataResponseSchema,
  selectedResumeParamsSchema,
  selectedSessionStartResponseSchema,
  selectedStartSessionRequestSchema,
  sessionIdParamsSchema,
  skillsSnapshotSchema,
  usageSnapshotSchema
} from "@hostdeck/contracts";
import { type HostHttpService, type StartHostHttpServiceInput, startHostHttpService } from "@hostdeck/server";
import { createHostDeckApiClient, type HostDeckApiClient, type HttpFetch } from "./api-client.js";
import {
  createHostDeckArchiveClient,
  type HostDeckArchiveClient,
  type HostDeckArchiveClientRequest
} from "./archive-client.js";
import { type LoadCliConfigOptions, loadCliConfig } from "./config.js";
import {
  apiFailure,
  clientOperationFailure,
  configFailure,
  internalFailure,
  toCliFailure,
  usageFailure
} from "./errors.js";
import { type CliExitCode, cliExitCodes } from "./exit-codes.js";
import {
  createHostDeckGoalClient,
  type HostDeckGoalClient,
  type HostDeckGoalClientMutationRequest
} from "./goal-client.js";
import { createLocalAdmin, type LocalAdmin } from "./local-admin.js";
import {
  createHostDeckModelClient,
  type HostDeckModelClient,
  type HostDeckModelClientSelectionRequest
} from "./model-client.js";
import {
  createHostDeckPairingLinkClient,
  type HostDeckPairingLinkClient
} from "./pairing-link-client.js";
import { parseCliArgs } from "./parser.js";
import {
  createHostDeckPlanClient,
  type HostDeckPlanClient,
  type HostDeckPlanClientSelectionRequest
} from "./plan-client.js";
import {
  createHostDeckPromptClient,
  type HostDeckPromptClient,
  type HostDeckPromptClientRequest
} from "./prompt-client.js";
import {
  createHostDeckRemoteControlClient,
  type HostDeckRemoteControlClient
} from "./remote-control-client.js";
import {
  renderArchiveSession,
  renderAttachCommand,
  renderFailure,
  renderGoalSnapshot,
  renderHelp,
  renderLockCommand,
  renderModelSnapshot,
  renderPairingLink,
  renderPlanSnapshot,
  renderPromptDispatch,
  renderRemoteState,
  renderServeStarted,
  renderServeStopped,
  renderSessionList,
  renderSkillsSnapshot,
  renderStartSession,
  renderStatus,
  renderUsageSnapshot,
  renderVersion,
  renderWriteAccepted,
  type TerminalQrRenderer
} from "./render.js";
import {
  createHostDeckResumeClient,
  type HostDeckResumeClient
} from "./resume-client.js";
import {
  createHostDeckResumeLauncher,
  type HostDeckResumeLauncher
} from "./resume-launcher.js";
import {
  createHostDeckSkillsClient,
  type HostDeckSkillsClient
} from "./skills-client.js";
import {
  createHostDeckStartClient,
  type HostDeckStartClient
} from "./start-client.js";
import {
  createHostDeckUsageClient,
  type HostDeckUsageClient
} from "./usage-client.js";

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
  readonly goalClient?: HostDeckGoalClient;
  readonly modelClient?: HostDeckModelClient;
  readonly planClient?: HostDeckPlanClient;
  readonly archiveClient?: HostDeckArchiveClient;
  readonly promptClient?: HostDeckPromptClient;
  readonly pairingClient?: HostDeckPairingLinkClient;
  readonly remoteClient?: HostDeckRemoteControlClient;
  readonly resumeClient?: HostDeckResumeClient;
  readonly resumeLauncher?: HostDeckResumeLauncher;
  readonly skillsClient?: HostDeckSkillsClient;
  readonly startClient?: HostDeckStartClient;
  readonly usageClient?: HostDeckUsageClient;
  readonly createOperationId?: (
    action: "disable" | "enable"
  ) => string;
  readonly createPairOperationId?: () => string;
  readonly createArchiveOperationId?: () => string;
  readonly createGoalOperationId?: () => string;
  readonly createModelOperationId?: () => string;
  readonly createPlanOperationId?: () => string;
  readonly createPromptOperationId?: () => string;
  readonly createStartOperationId?: () => string;
  readonly renderPairingQr?: TerminalQrRenderer;
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

    if (parsed.command.kind === "remote") {
      const remoteClientOptions = { baseUrl: config.baseUrl };
      if (options.fetch !== undefined) {
        Object.assign(remoteClientOptions, { fetch: options.fetch });
      }
      const remoteClient =
        options.remoteClient ??
        createHostDeckRemoteControlClient(remoteClientOptions);
      if (parsed.command.action === "status") {
        return success(
          renderRemoteState(
            await remoteClient.status(),
            parsed.command.json
          )
        );
      }
      const request = createRemoteMutationRequest(
        parsed.command.action,
        options.createOperationId ?? createRemoteOperationId
      );
      const state =
        parsed.command.action === "enable"
          ? await remoteClient.enable(request as RemoteEnableRequest)
          : await remoteClient.disable(request as RemoteDisableRequest);
      return success(renderRemoteState(state, parsed.command.json));
    }

    if (parsed.command.kind === "pair") {
      const pairingClientOptions = { baseUrl: config.baseUrl };
      if (options.fetch !== undefined) {
        Object.assign(pairingClientOptions, { fetch: options.fetch });
      }
      const pairingClient =
        options.pairingClient ??
        createHostDeckPairingLinkClient(pairingClientOptions);
      const request = createPairingRequest(
        parsed.command,
        options.createPairOperationId ?? createPairOperationId
      );
      return success(
        await renderPairingLink(
          await pairingClient.issue(request),
          options.renderPairingQr
        )
      );
    }

    if (parsed.command.kind === "resume") {
      const target = parseResumeTarget(parsed.command.session);
      let resumeClient = options.resumeClient;
      if (resumeClient === undefined) {
        const resumeClientOptions = { baseUrl: config.baseUrl };
        if (options.fetch !== undefined) {
          Object.assign(resumeClientOptions, { fetch: options.fetch });
        }
        resumeClient = createHostDeckResumeClient(resumeClientOptions);
      }
      const metadata = parseResumeMetadata(
        await Reflect.apply(resumeClient.read, undefined, [target]),
        target
      );
      if (!metadata.available || metadata.launch === null) {
        throw clientOperationFailure(
          "capability_unavailable",
          "Managed session is not available for laptop resume."
        );
      }
      const launcher =
        options.resumeLauncher ?? createHostDeckResumeLauncher();
      await Reflect.apply(launcher.launch, undefined, [metadata.launch]);
      return success("");
    }

    if (parsed.command.kind === "model") {
      const target = parseModelTarget(parsed.command.session);
      let modelClient = options.modelClient;
      if (modelClient === undefined) {
        const modelClientOptions = { baseUrl: config.baseUrl };
        if (options.fetch !== undefined) Object.assign(modelClientOptions, { fetch: options.fetch });
        modelClient = createHostDeckModelClient(modelClientOptions);
      }
      if (parsed.command.model === null) {
        const snapshot = parseModelSnapshot(
          await Reflect.apply(modelClient.read, undefined, [target])
        );
        return success(renderModelSnapshot(snapshot, parsed.command.json));
      }
      const request = createModelSelectionRequest(
        parsed.command,
        options.createModelOperationId ?? createModelOperationId
      );
      const snapshot = parseModelSelectionSnapshot(
        await Reflect.apply(modelClient.select, undefined, [request]),
        request
      );
      return success(renderModelSnapshot(snapshot, parsed.command.json, request));
    }

    if (parsed.command.kind === "goal") {
      const target = parseGoalTarget(parsed.command.session);
      let goalClient = options.goalClient;
      if (goalClient === undefined) {
        const goalClientOptions = { baseUrl: config.baseUrl };
        if (options.fetch !== undefined) Object.assign(goalClientOptions, { fetch: options.fetch });
        goalClient = createHostDeckGoalClient(goalClientOptions);
      }
      if (parsed.command.action === null) {
        const snapshot = parseGoalSnapshot(await Reflect.apply(goalClient.read, undefined, [target]));
        return success(renderGoalSnapshot(snapshot, parsed.command.json));
      }
      const request = createGoalMutationRequest(
        parsed.command,
        options.createGoalOperationId ?? createGoalOperationId
      );
      const snapshot = parseGoalMutationSnapshot(
        await Reflect.apply(goalClient.mutate, undefined, [request]),
        request
      );
      return success(renderGoalSnapshot(snapshot, parsed.command.json, request));
    }

    if (parsed.command.kind === "plan") {
      const target = parsePlanTarget(parsed.command.session);
      let planClient = options.planClient;
      if (planClient === undefined) {
        const planClientOptions = { baseUrl: config.baseUrl };
        if (options.fetch !== undefined) Object.assign(planClientOptions, { fetch: options.fetch });
        planClient = createHostDeckPlanClient(planClientOptions);
      }
      if (parsed.command.action === null) {
        const snapshot = parsePlanSnapshot(await Reflect.apply(planClient.read, undefined, [target]));
        return success(renderPlanSnapshot(snapshot, parsed.command.json));
      }
      const request = createPlanSelectionRequest(
        parsed.command,
        options.createPlanOperationId ?? createPlanOperationId
      );
      const snapshot = parsePlanSelectionSnapshot(
        await Reflect.apply(planClient.select, undefined, [request]),
        request
      );
      return success(renderPlanSnapshot(snapshot, parsed.command.json, request));
    }

    if (parsed.command.kind === "usage") {
      const target = parseUsageTarget(parsed.command.session);
      let usageClient = options.usageClient;
      if (usageClient === undefined) {
        const usageClientOptions = { baseUrl: config.baseUrl };
        if (options.fetch !== undefined) {
          Object.assign(usageClientOptions, { fetch: options.fetch });
        }
        usageClient = createHostDeckUsageClient(usageClientOptions);
      }
      const snapshot = parseUsageSnapshot(
        await Reflect.apply(usageClient.read, undefined, [target]),
        target
      );
      return success(renderUsageSnapshot(snapshot, parsed.command.json));
    }

    if (parsed.command.kind === "skills") {
      const target = parseSkillsTarget(parsed.command.session);
      let skillsClient = options.skillsClient;
      if (skillsClient === undefined) {
        const skillsClientOptions = { baseUrl: config.baseUrl };
        if (options.fetch !== undefined) {
          Object.assign(skillsClientOptions, { fetch: options.fetch });
        }
        skillsClient = createHostDeckSkillsClient(skillsClientOptions);
      }
      const snapshot = parseSkillsSnapshot(
        await Reflect.apply(skillsClient.list, undefined, [target]),
        target
      );
      return success(renderSkillsSnapshot(snapshot, parsed.command.json));
    }

    if (parsed.command.kind === "start") {
      let startClient = options.startClient;
      if (startClient === undefined) {
        const startClientOptions = { baseUrl: config.baseUrl };
        if (options.fetch !== undefined) {
          Object.assign(startClientOptions, { fetch: options.fetch });
        }
        startClient = createHostDeckStartClient(startClientOptions);
      }
      const startRequest = createSessionStartRequest(
        parsed.command,
        options.createStartOperationId ?? createStartOperationId
      );
      const response = parseSessionStartResponse(
        await Reflect.apply(startClient.start, undefined, [startRequest]),
        startRequest
      );
      return success(renderStartSession(response, parsed.command.json));
    }

    if (parsed.command.kind === "archive") {
      let archiveClient = options.archiveClient;
      if (archiveClient === undefined) {
        const archiveClientOptions = { baseUrl: config.baseUrl };
        if (options.fetch !== undefined) {
          Object.assign(archiveClientOptions, { fetch: options.fetch });
        }
        archiveClient = createHostDeckArchiveClient(archiveClientOptions);
      }
      const archiveRequest = createSessionArchiveRequest(
        parsed.command,
        options.createArchiveOperationId ?? createArchiveOperationId
      );
      const response = parseSessionArchiveResponse(
        await Reflect.apply(archiveClient.archive, undefined, [archiveRequest]),
        archiveRequest
      );
      return success(renderArchiveSession(response, parsed.command.json));
    }

    if (parsed.command.kind === "send") {
      let promptClient = options.promptClient;
      if (promptClient === undefined) {
        const promptClientOptions = { baseUrl: config.baseUrl };
        if (options.fetch !== undefined) {
          Object.assign(promptClientOptions, { fetch: options.fetch });
        }
        promptClient = createHostDeckPromptClient(promptClientOptions);
      }
      const promptRequest = createPromptRequest(
        parsed.command,
        options.createPromptOperationId ?? createPromptOperationId
      );
      const response = parsePromptResponse(
        await Reflect.apply(promptClient.send, undefined, [promptRequest]),
        promptRequest
      );
      return success(renderPromptDispatch(response, parsed.command.json));
    }

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

    if (parsed.command.kind === "list") {
      return success(renderSessionList(await client.listSessions(), parsed.command.json));
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

function createRemoteMutationRequest(
  action: "disable" | "enable",
  createOperationId: (action: "disable" | "enable") => string
): RemoteDisableRequest | RemoteEnableRequest {
  let operationId: unknown;
  try {
    operationId = createOperationId(action);
  } catch (error) {
    throw internalFailure("Remote control operation id generation failed.", error);
  }
  const candidate = { operation_id: operationId, confirmed: true };
  const parsed =
    action === "enable"
      ? remoteEnableRequestSchema.safeParse(candidate)
      : remoteDisableRequestSchema.safeParse(candidate);
  if (!parsed.success) {
    throw internalFailure("Remote control operation id generation failed.");
  }
  return parsed.data;
}

function createPairingRequest(
  command: Extract<ReturnType<typeof parseCliArgs>["command"], { readonly kind: "pair" }>,
  createOperationId: () => string
): SelectedPairRequest {
  let operationId: unknown;
  try {
    operationId = createOperationId();
  } catch {
    throw internalFailure("Pairing operation id generation failed.");
  }
  const parsed = selectedPairRequestSchema.safeParse({
    operation_id: operationId,
    permission: command.permission,
    ...(command.label === undefined ? {} : { client_label: command.label })
  });
  if (!parsed.success) {
    throw usageFailure("Pairing options do not satisfy the selected pairing contract.");
  }
  return parsed.data;
}

function createRemoteOperationId(action: "disable" | "enable"): string {
  return `op_remote_${action}_${randomUUID().replaceAll("-", "")}`;
}

function createPairOperationId(): string {
  return `op_pair_request_${randomUUID().replaceAll("-", "")}`;
}

function createStartOperationId(): string {
  return `op_session_start_${randomUUID().replaceAll("-", "")}`;
}

function createArchiveOperationId(): string {
  return `op_session_archive_${randomUUID().replaceAll("-", "")}`;
}

function createPromptOperationId(): string {
  return `op_prompt_${randomUUID().replaceAll("-", "")}`;
}

function createModelOperationId(): string {
  return `op_model_${randomUUID().replaceAll("-", "")}`;
}

function createGoalOperationId(): string {
  return `op_goal_${randomUUID().replaceAll("-", "")}`;
}

function createPlanOperationId(): string {
  return `op_plan_${randomUUID().replaceAll("-", "")}`;
}

function createSessionStartRequest(
  command: Extract<
    ReturnType<typeof parseCliArgs>["command"],
    { readonly kind: "start" }
  >,
  createOperationId: () => string
): SelectedStartSessionRequest {
  let operationId: unknown;
  try {
    operationId = Reflect.apply(createOperationId, undefined, []);
  } catch (error) {
    throw internalFailure("Session-start operation id generation failed.", error);
  }
  if (!clientOperationIdSchema.safeParse(operationId).success) {
    throw internalFailure("Session-start operation id generation failed.");
  }
  const parsed = selectedStartSessionRequestSchema.safeParse({
    operation_id: operationId,
    name: command.name,
    cwd: command.cwd
  });
  if (!parsed.success) {
    throw usageFailure(
      "Start options do not satisfy the managed-session contract.",
      "start"
    );
  }
  return parsed.data;
}

function parseSessionStartResponse(
  candidate: unknown,
  request: SelectedStartSessionRequest
): SelectedSessionStartResponse {
  const parsed = selectedSessionStartResponseSchema.safeParse(candidate);
  if (
    !parsed.success ||
    parsed.data.operation_id !== request.operation_id ||
    parsed.data.session.name !== request.name ||
    parsed.data.session.cwd !== request.cwd
  ) {
    throw internalFailure(
      "HostDeck start client returned invalid managed-session data."
    );
  }
  return parsed.data;
}

function createSessionArchiveRequest(
  command: Extract<
    ReturnType<typeof parseCliArgs>["command"],
    { readonly kind: "archive" }
  >,
  createOperationId: () => string
): HostDeckArchiveClientRequest {
  let operationId: unknown;
  try {
    operationId = Reflect.apply(createOperationId, undefined, []);
  } catch (error) {
    throw internalFailure("Session-archive operation id generation failed.", error);
  }
  const target = sessionIdParamsSchema.safeParse({ session_id: command.session });
  const body = archiveSessionRequestSchema.safeParse({
    operation_id: operationId,
    kind: "archive",
    confirm: true
  });
  if (!target.success) {
    throw usageFailure(
      "Archive requires one valid managed session id.",
      "session"
    );
  }
  if (!body.success) {
    throw internalFailure("Session-archive operation id generation failed.");
  }
  return Object.freeze({ ...body.data, session_id: target.data.session_id });
}

function parseSessionArchiveResponse(
  candidate: unknown,
  request: HostDeckArchiveClientRequest
): SelectedOperationDispatch {
  const parsed = selectedOperationDispatchSchema.safeParse(candidate);
  if (
    !parsed.success ||
    parsed.data.state !== "accepted" ||
    parsed.data.kind !== "archive" ||
    parsed.data.operation_id !== request.operation_id ||
    parsed.data.target.type !== "managed_session" ||
    parsed.data.target.session_id !== request.session_id
  ) {
    throw internalFailure(
      "HostDeck archive client returned invalid managed-session data."
    );
  }
  return parsed.data;
}

function createPromptRequest(
  command: Extract<
    ReturnType<typeof parseCliArgs>["command"],
    { readonly kind: "send" }
  >,
  createOperationId: () => string
): HostDeckPromptClientRequest {
  let operationId: unknown;
  try {
    operationId = Reflect.apply(createOperationId, undefined, []);
  } catch (error) {
    throw internalFailure("Prompt operation id generation failed.", error);
  }
  const target = sessionIdParamsSchema.safeParse({ session_id: command.session });
  const body = promptSessionRequestSchema.safeParse({
    operation_id: operationId,
    kind: "prompt",
    text: command.text
  });
  if (!target.success) {
    throw usageFailure("Send requires one valid managed session id.", "session");
  }
  if (!body.success) {
    if (!clientOperationIdSchema.safeParse(operationId).success) {
      throw internalFailure("Prompt operation id generation failed.");
    }
    throw usageFailure("Send requires non-empty prompt text within the selected limit.", "text");
  }
  return Object.freeze({ ...body.data, session_id: target.data.session_id });
}

function parsePromptResponse(
  candidate: unknown,
  request: HostDeckPromptClientRequest
): PromptDispatchResponse {
  const parsed = promptDispatchResponseSchema.safeParse(candidate);
  if (
    !parsed.success ||
    parsed.data.operation_id !== request.operation_id ||
    parsed.data.target.session_id !== request.session_id
  ) {
    throw internalFailure(
      "HostDeck prompt client returned invalid managed-session data."
    );
  }
  return parsed.data;
}

function parseResumeTarget(candidate: string): string {
  const parsed = selectedResumeParamsSchema.safeParse({
    session_id: candidate
  });
  if (!parsed.success) {
    throw usageFailure(
      "Laptop resume requires one valid managed session id.",
      "session"
    );
  }
  return parsed.data.session_id;
}

function parseResumeMetadata(
  candidate: unknown,
  sessionId: string
): SelectedResumeMetadataResponse {
  const parsed = selectedResumeMetadataResponseSchema.safeParse(candidate);
  if (!parsed.success || parsed.data.session_id !== sessionId) {
    throw internalFailure(
      "HostDeck resume client returned invalid managed-thread metadata."
    );
  }
  return parsed.data;
}

function parseModelTarget(candidate: string): string {
  const parsed = sessionIdParamsSchema.safeParse({ session_id: candidate });
  if (!parsed.success) throw usageFailure("Model requires one valid managed session id.", "session");
  return parsed.data.session_id;
}

function createModelSelectionRequest(
  command: Extract<ReturnType<typeof parseCliArgs>["command"], { readonly kind: "model" }>,
  createOperationId: () => string
): HostDeckModelClientSelectionRequest {
  if (command.model === null) throw internalFailure("Model selection command lost its catalog model id.");
  let operationId: unknown;
  try {
    operationId = Reflect.apply(createOperationId, undefined, []);
  } catch (error) {
    throw internalFailure("Model operation id generation failed.", error);
  }
  const target = sessionIdParamsSchema.safeParse({ session_id: command.session });
  const body = modelSelectionRequestSchema.safeParse({
    operation_id: operationId,
    kind: "model",
    model_id: command.model,
    reasoning_effort: command.effort,
    expected_pending_revision: command.expectedRevision
  });
  if (!target.success) throw usageFailure("Model requires one valid managed session id.", "session");
  if (!body.success) {
    if (!clientOperationIdSchema.safeParse(operationId).success) {
      throw internalFailure("Model operation id generation failed.");
    }
    throw usageFailure("Model selection does not satisfy the selected model contract.", "model");
  }
  return Object.freeze({ ...body.data, session_id: target.data.session_id });
}

function parseModelSnapshot(candidate: unknown): ModelControlSnapshot {
  let parsed: ReturnType<typeof modelControlSnapshotSchema.safeParse>;
  try {
    parsed = modelControlSnapshotSchema.safeParse(candidate);
  } catch {
    throw internalFailure("HostDeck model client returned invalid managed-session data.");
  }
  if (!parsed.success) throw internalFailure("HostDeck model client returned invalid managed-session data.");
  return parsed.data;
}

function parseModelSelectionSnapshot(
  candidate: unknown,
  request: HostDeckModelClientSelectionRequest
): ModelControlSnapshot {
  const snapshot = parseModelSnapshot(candidate);
  assertModelSelectionCorrelation(snapshot, request);
  return snapshot;
}

function assertModelSelectionCorrelation(snapshot: ModelControlSnapshot, request: ModelSelectionRequest): void {
  const model = snapshot.models.find((candidate) => candidate.id === request.model_id);
  const resolvedEffort =
    request.reasoning_effort ?? model?.reasoning_efforts.find((candidate) => candidate.is_default)?.id;
  if (model === undefined || resolvedEffort === undefined) {
    throw internalFailure("HostDeck model client returned contradictory selection data.");
  }
  if (snapshot.pending !== null) {
    if (
      snapshot.pending.selection_operation_id !== request.operation_id ||
      snapshot.pending.model_id !== request.model_id ||
      snapshot.pending.runtime_model !== model.runtime_model ||
      snapshot.pending.reasoning_effort !== resolvedEffort ||
      snapshot.pending.catalog_state !== "available" ||
      snapshot.pending.phase !== "pending" ||
      snapshot.pending.turn_id !== null ||
      snapshot.pending.error !== null ||
      (request.expected_pending_revision !== null &&
        snapshot.pending.revision <= request.expected_pending_revision)
    ) {
      throw internalFailure("HostDeck model client returned contradictory selection data.");
    }
    return;
  }
  if (
    snapshot.current.catalog_state !== "available" ||
    snapshot.current.model_id !== request.model_id ||
    snapshot.current.runtime_model !== model.runtime_model ||
    snapshot.current.reasoning_effort !== resolvedEffort
  ) {
    throw internalFailure("HostDeck model client returned contradictory selection data.");
  }
}

function parseGoalTarget(candidate: string): string {
  const parsed = sessionIdParamsSchema.safeParse({ session_id: candidate });
  if (!parsed.success) throw usageFailure("Goal requires one valid managed session id.", "session");
  return parsed.data.session_id;
}

function createGoalMutationRequest(
  command: Extract<ReturnType<typeof parseCliArgs>["command"], { readonly kind: "goal" }>,
  createOperationId: () => string
): HostDeckGoalClientMutationRequest {
  if (command.action === null) throw internalFailure("Goal mutation command lost its lifecycle action.");
  let operationId: unknown;
  try {
    operationId = Reflect.apply(createOperationId, undefined, []);
  } catch (error) {
    throw internalFailure("Goal operation id generation failed.", error);
  }
  const target = sessionIdParamsSchema.safeParse({ session_id: command.session });
  const body = goalMutationRequestSchema.safeParse({
    operation_id: operationId,
    kind: "goal",
    action: command.action,
    objective: command.objective,
    expected_goal_revision: command.expectedRevision
  });
  if (!target.success) throw usageFailure("Goal requires one valid managed session id.", "session");
  if (!body.success) {
    if (!clientOperationIdSchema.safeParse(operationId).success) {
      throw internalFailure("Goal operation id generation failed.");
    }
    throw usageFailure("Goal mutation does not satisfy the selected goal contract.", "goal");
  }
  return Object.freeze({ ...body.data, session_id: target.data.session_id });
}

function parseGoalSnapshot(candidate: unknown): GoalControlSnapshot {
  let parsed: ReturnType<typeof goalControlSnapshotSchema.safeParse>;
  try {
    parsed = goalControlSnapshotSchema.safeParse(candidate);
  } catch {
    throw internalFailure("HostDeck goal client returned invalid managed-session data.");
  }
  if (!parsed.success) throw internalFailure("HostDeck goal client returned invalid managed-session data.");
  return parsed.data;
}

function parseGoalMutationSnapshot(
  candidate: unknown,
  request: HostDeckGoalClientMutationRequest
): GoalControlSnapshot {
  const snapshot = parseGoalSnapshot(candidate);
  assertGoalMutationCorrelation(snapshot, request);
  return snapshot;
}

function assertGoalMutationCorrelation(snapshot: GoalControlSnapshot, request: GoalMutationRequest): void {
  if (snapshot.uncertain_mutation !== null) {
    throw internalFailure("HostDeck goal client returned contradictory mutation data.");
  }
  if (request.action === "clear") {
    if (snapshot.goal !== null) throw internalFailure("HostDeck goal client returned contradictory mutation data.");
    return;
  }
  const goal = snapshot.goal;
  const expectedStatus =
    request.action === "resume" ? "active" : request.action === "complete" ? "complete" : "paused";
  if (
    goal === null ||
    goal.status !== expectedStatus ||
    (request.action === "set" && goal.objective !== request.objective) ||
    (request.action === "resume" &&
      request.expected_goal_revision !== null &&
      goal.revision === request.expected_goal_revision)
  ) {
    throw internalFailure("HostDeck goal client returned contradictory mutation data.");
  }
}

function parsePlanTarget(candidate: string): string {
  const parsed = sessionIdParamsSchema.safeParse({ session_id: candidate });
  if (!parsed.success) throw usageFailure("Plan requires one valid managed session id.", "session");
  return parsed.data.session_id;
}

function createPlanSelectionRequest(
  command: Extract<ReturnType<typeof parseCliArgs>["command"], { readonly kind: "plan" }>,
  createOperationId: () => string
): HostDeckPlanClientSelectionRequest {
  if (command.action === null) throw internalFailure("Plan selection command lost its action.");
  let operationId: unknown;
  try {
    operationId = Reflect.apply(createOperationId, undefined, []);
  } catch (error) {
    throw internalFailure("Plan operation id generation failed.", error);
  }
  const target = sessionIdParamsSchema.safeParse({ session_id: command.session });
  const body = planSelectionRequestSchema.safeParse({
    operation_id: operationId,
    kind: "plan",
    action: command.action,
    expected_pending_revision: command.expectedRevision
  });
  if (!target.success) throw usageFailure("Plan requires one valid managed session id.", "session");
  if (!body.success) {
    if (!clientOperationIdSchema.safeParse(operationId).success) {
      throw internalFailure("Plan operation id generation failed.");
    }
    throw usageFailure("Plan selection does not satisfy the selected Plan contract.", "plan");
  }
  return Object.freeze({ ...body.data, session_id: target.data.session_id });
}

function parsePlanSnapshot(candidate: unknown): PlanControlSnapshot {
  let parsed: ReturnType<typeof planControlSnapshotSchema.safeParse>;
  try {
    parsed = planControlSnapshotSchema.safeParse(candidate);
  } catch {
    throw internalFailure("HostDeck Plan client returned invalid managed-session data.");
  }
  if (!parsed.success) throw internalFailure("HostDeck Plan client returned invalid managed-session data.");
  return parsed.data;
}

function parsePlanSelectionSnapshot(
  candidate: unknown,
  request: HostDeckPlanClientSelectionRequest
): PlanControlSnapshot {
  const snapshot = parsePlanSnapshot(candidate);
  assertPlanSelectionCorrelation(snapshot, request);
  return snapshot;
}

function assertPlanSelectionCorrelation(snapshot: PlanControlSnapshot, request: PlanSelectionRequest): void {
  const desiredMode = request.action === "enter" ? "plan" : "default";
  if (!snapshot.modes.some((entry) => entry.mode === desiredMode)) {
    throw internalFailure("HostDeck Plan client returned contradictory selection data.");
  }
  if (snapshot.pending !== null) {
    if (
      snapshot.pending.selection_operation_id !== request.operation_id ||
      snapshot.pending.mode !== desiredMode ||
      snapshot.pending.catalog_state !== "available" ||
      snapshot.pending.phase !== "pending" ||
      snapshot.pending.turn_id !== null ||
      snapshot.pending.resolved_settings !== null ||
      snapshot.pending.error !== null ||
      (request.expected_pending_revision !== null &&
        snapshot.pending.revision <= request.expected_pending_revision)
    ) {
      throw internalFailure("HostDeck Plan client returned contradictory selection data.");
    }
    return;
  }
  if (snapshot.current.state !== "confirmed" || snapshot.current.mode !== desiredMode) {
    throw internalFailure("HostDeck Plan client returned contradictory selection data.");
  }
}

function parseUsageTarget(candidate: string): string {
  const parsed = sessionIdParamsSchema.safeParse({ session_id: candidate });
  if (!parsed.success) {
    throw usageFailure(
      "Usage requires one valid managed session id.",
      "session"
    );
  }
  return parsed.data.session_id;
}

function parseUsageSnapshot(
  candidate: unknown,
  sessionId: string
): UsageSnapshot {
  let parsed: ReturnType<typeof usageSnapshotSchema.safeParse>;
  try {
    parsed = usageSnapshotSchema.safeParse(candidate);
  } catch {
    throw internalFailure(
      "HostDeck usage client returned invalid managed-session data."
    );
  }
  if (
    !parsed.success ||
    parsed.data.target.session_id !== sessionId
  ) {
    throw internalFailure(
      "HostDeck usage client returned invalid managed-session data."
    );
  }
  return parsed.data;
}

function parseSkillsTarget(candidate: string): string {
  const parsed = sessionIdParamsSchema.safeParse({ session_id: candidate });
  if (!parsed.success) {
    throw usageFailure(
      "Skills requires one valid managed session id.",
      "session"
    );
  }
  return parsed.data.session_id;
}

function parseSkillsSnapshot(
  candidate: unknown,
  sessionId: string
): SkillsSnapshot {
  let parsed: ReturnType<typeof skillsSnapshotSchema.safeParse>;
  try {
    parsed = skillsSnapshotSchema.safeParse(candidate);
  } catch {
    throw internalFailure(
      "HostDeck skills client returned invalid managed-session data."
    );
  }
  if (!parsed.success || parsed.data.target.session_id !== sessionId) {
    throw internalFailure(
      "HostDeck skills client returned invalid managed-session data."
    );
  }
  return parsed.data;
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
