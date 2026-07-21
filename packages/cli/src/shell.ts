import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type {
  ApiErrorEnvelope,
  CompactProgressResponse,
  GoalControlSnapshot,
  GoalMutationRequest,
  InterruptResponse,
  ModelControlSnapshot,
  ModelSelectionRequest,
  PendingApprovalListResponse,
  PendingApprovalResponse,
  PlanControlSnapshot,
  PlanSelectionRequest,
  PromptDispatchResponse,
  SelectedHostLockRequest,
  SelectedHostUnlockRequest,
  SelectedOperationDispatch,
  SelectedResumeMetadataResponse,
  SelectedSessionStartResponse,
  SelectedStartSessionRequest,
  SkillsSnapshot,
  UsageSnapshot
} from "@hostdeck/contracts";
import {
  approvalResponseRequestSchema,
  archiveSessionRequestSchema,
  clientOperationIdSchema,
  compactProgressResponseSchema,
  compactStartRequestSchema,
  defaultResourceBudget,
  goalControlSnapshotSchema,
  goalMutationRequestSchema,
  interruptRequestSchema,
  interruptResponseSchema,
  modelControlSnapshotSchema,
  modelSelectionRequestSchema,
  pendingApprovalListResponseSchema,
  pendingApprovalResponseSchema,
  planControlSnapshotSchema,
  planSelectionRequestSchema,
  promptDispatchResponseSchema,
  promptSessionRequestSchema,
  type RemoteDisableRequest,
  type RemoteEnableRequest,
  remoteDisableRequestSchema,
  remoteEnableRequestSchema,
  type SelectedPairRequest,
  selectedHostLockRequestSchema,
  selectedHostUnlockRequestSchema,
  selectedOperationDispatchSchema,
  selectedPairRequestSchema,
  selectedResumeMetadataResponseSchema,
  selectedResumeParamsSchema,
  selectedSessionStartResponseSchema,
  selectedStartSessionRequestSchema,
  sessionApprovalParamsSchema,
  sessionIdParamsSchema,
  sessionTurnParamsSchema,
  skillsSnapshotSchema,
  usageSnapshotSchema
} from "@hostdeck/contracts";
import type { HttpFetch } from "./api-client.js";
import {
  createHostDeckApprovalClient,
  type HostDeckApprovalClient,
  type HostDeckApprovalClientResponseRequest
} from "./approval-client.js";
import {
  createHostDeckArchiveClient,
  type HostDeckArchiveClient,
  type HostDeckArchiveClientRequest
} from "./archive-client.js";
import {
  createHostDeckCompactClient,
  type HostDeckCompactClient,
  type HostDeckCompactClientStartRequest
} from "./compact-client.js";
import { type LoadCliConfigOptions, loadCliConfig } from "./config.js";
import {
  clientOperationFailure,
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
import {
  createHostDeckHostLockClient,
  type HostDeckHostLockClient
} from "./host-lock-client.js";
import {
  createHostDeckInterruptClient,
  type HostDeckInterruptClient,
  type HostDeckInterruptClientRequest
} from "./interrupt-client.js";
import {
  createLegacySessionAdmin,
  type LegacySessionAdmin
} from "./legacy-session-admin.js";
import { createBoundedLoopbackFetch } from "./loopback-http.js";
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
  renderApprovalList,
  renderApprovalResponse,
  renderArchiveSession,
  renderCompactProgress,
  renderFailure,
  renderGoalSnapshot,
  renderHelp,
  renderHostLockState,
  renderInterruptResponse,
  renderLegacySessionReset,
  renderLegacySessionStatus,
  renderModelSnapshot,
  renderPairingLink,
  renderPlanSnapshot,
  renderPromptDispatch,
  renderRemoteState,
  renderSkillsSnapshot,
  renderStartSession,
  renderUsageSnapshot,
  renderVersion,
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
  readonly signal?: AbortSignal;
  readonly legacyAdmin?: LegacySessionAdmin;
  readonly hostLockClient?: HostDeckHostLockClient;
  readonly goalClient?: HostDeckGoalClient;
  readonly compactClient?: HostDeckCompactClient;
  readonly approvalClient?: HostDeckApprovalClient;
  readonly interruptClient?: HostDeckInterruptClient;
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
  readonly createHostLockOperationId?: (
    action: "lock" | "unlock"
  ) => string;
  readonly createArchiveOperationId?: () => string;
  readonly createCompactOperationId?: () => string;
  readonly createApprovalOperationId?: () => string;
  readonly createInterruptOperationId?: () => string;
  readonly createGoalOperationId?: () => string;
  readonly createModelOperationId?: () => string;
  readonly createPlanOperationId?: () => string;
  readonly createPromptOperationId?: () => string;
  readonly createStartOperationId?: () => string;
  readonly renderPairingQr?: TerminalQrRenderer;
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
    const selectedFetch =
      options.fetch ??
      createBoundedLoopbackFetch(
        options.signal === undefined ? {} : { signal: options.signal }
      );
    const selectedClientOptions = Object.freeze({
      baseUrl: config.baseUrl,
      fetch: selectedFetch
    });

    if (parsed.command.kind === "remote") {
      const remoteClient =
        options.remoteClient ??
        createHostDeckRemoteControlClient(selectedClientOptions);
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
      const pairingClient =
        options.pairingClient ??
        createHostDeckPairingLinkClient(selectedClientOptions);
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

    if (parsed.command.kind === "lock" || parsed.command.kind === "unlock") {
      const client =
        options.hostLockClient ??
        createHostDeckHostLockClient(selectedClientOptions);
      const request = createHostLockMutationRequest(
        parsed.command.kind,
        options.createHostLockOperationId ?? createHostLockOperationId
      );
      const response =
        parsed.command.kind === "lock"
          ? await Reflect.apply(client.lock, undefined, [request])
          : await Reflect.apply(client.unlock, undefined, [request]);
      return success(renderHostLockState(response, parsed.command.json));
    }

    if (parsed.command.kind === "resume") {
      const target = parseResumeTarget(parsed.command.session);
      const resumeClient =
        options.resumeClient ?? createHostDeckResumeClient(selectedClientOptions);
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
      const modelClient =
        options.modelClient ?? createHostDeckModelClient(selectedClientOptions);
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
      const goalClient =
        options.goalClient ?? createHostDeckGoalClient(selectedClientOptions);
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
      const planClient =
        options.planClient ?? createHostDeckPlanClient(selectedClientOptions);
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
      const usageClient =
        options.usageClient ?? createHostDeckUsageClient(selectedClientOptions);
      const snapshot = parseUsageSnapshot(
        await Reflect.apply(usageClient.read, undefined, [target]),
        target
      );
      return success(renderUsageSnapshot(snapshot, parsed.command.json));
    }

    if (parsed.command.kind === "compact") {
      const target = parseCompactTarget(parsed.command.session);
      const compactClient =
        options.compactClient ?? createHostDeckCompactClient(selectedClientOptions);
      if (!parsed.command.confirm) {
        const response = parseCompactResponse(
          await Reflect.apply(compactClient.read, undefined, [target]),
          target,
          null
        );
        return success(renderCompactProgress(response, target, parsed.command.json));
      }
      const request = createCompactStartRequest(
        parsed.command,
        options.createCompactOperationId ?? createCompactOperationId
      );
      const response = parseCompactResponse(
        await Reflect.apply(compactClient.start, undefined, [request]),
        target,
        request
      );
      return success(renderCompactProgress(response, target, parsed.command.json));
    }

    if (parsed.command.kind === "skills") {
      const target = parseSkillsTarget(parsed.command.session);
      const skillsClient =
        options.skillsClient ?? createHostDeckSkillsClient(selectedClientOptions);
      const snapshot = parseSkillsSnapshot(
        await Reflect.apply(skillsClient.list, undefined, [target]),
        target
      );
      return success(renderSkillsSnapshot(snapshot, parsed.command.json));
    }

    if (parsed.command.kind === "approvals") {
      const target = parseApprovalTarget(parsed.command.session);
      const approvalClient =
        options.approvalClient ?? createHostDeckApprovalClient(selectedClientOptions);
      if (parsed.command.request === null) {
        const response = parseApprovalList(
          await Reflect.apply(approvalClient.list, undefined, [target]),
          target
        );
        return success(renderApprovalList(response, parsed.command.json));
      }
      const request = createApprovalResponseRequest(
        parsed.command,
        options.createApprovalOperationId ?? createApprovalOperationId
      );
      const response = parseApprovalResponse(
        await Reflect.apply(approvalClient.respond, undefined, [request]),
        request
      );
      return success(renderApprovalResponse(response, parsed.command.json));
    }

    if (parsed.command.kind === "interrupt") {
      const interruptClient =
        options.interruptClient ?? createHostDeckInterruptClient(selectedClientOptions);
      const request = createInterruptRequest(
        parsed.command,
        options.createInterruptOperationId ?? createInterruptOperationId
      );
      const response = parseInterruptResponse(
        await Reflect.apply(interruptClient.interrupt, undefined, [request]),
        request
      );
      return success(renderInterruptResponse(response, parsed.command.json));
    }

    if (parsed.command.kind === "start") {
      const startClient =
        options.startClient ?? createHostDeckStartClient(selectedClientOptions);
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
      const archiveClient =
        options.archiveClient ?? createHostDeckArchiveClient(selectedClientOptions);
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
      const promptClient =
        options.promptClient ?? createHostDeckPromptClient(selectedClientOptions);
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

    if (parsed.command.kind === "legacy") {
      const legacyAdmin =
        options.legacyAdmin ??
        createLegacySessionAdmin({
          stateDir: config.stateDir,
          databasePath: config.databasePath
        });
      return success(
        parsed.command.action === "status"
          ? renderLegacySessionStatus(legacyAdmin.getLegacySessions(), parsed.command.json)
          : renderLegacySessionReset(
              legacyAdmin.resetLegacySessions({ confirmed: true }),
              parsed.command.json
            )
      );
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

function compactCliProgressMessage(code: ApiErrorEnvelope["code"]): string {
  switch (code) {
    case "unknown_error":
      return "Compact outcome is unknown and requires reconciliation.";
    case "operation_conflict":
      return "Compact progress conflicts with observed runtime state.";
    case "protocol_error":
      return "Codex compact lifecycle failed protocol validation.";
    case "runtime_unavailable":
      return "Codex compact lifecycle lost runtime continuity.";
    case "session_not_writable":
      return "Managed session became unavailable during compaction.";
    default:
      return "Compact progress could not be verified.";
  }
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

function createHostLockMutationRequest(
  action: "lock" | "unlock",
  createOperationId: (action: "lock" | "unlock") => string
): SelectedHostLockRequest | SelectedHostUnlockRequest {
  let operationId: unknown;
  try {
    operationId = Reflect.apply(createOperationId, undefined, [action]);
  } catch (error) {
    throw internalFailure("Host-lock operation id generation failed.", error);
  }
  const candidate = { operation_id: operationId, confirmed: true };
  const parsed =
    action === "lock"
      ? selectedHostLockRequestSchema.safeParse(candidate)
      : selectedHostUnlockRequestSchema.safeParse(candidate);
  if (!parsed.success) {
    throw internalFailure("Host-lock operation id generation failed.");
  }
  return parsed.data;
}

function createRemoteOperationId(action: "disable" | "enable"): string {
  return `op_remote_${action}_${randomUUID().replaceAll("-", "")}`;
}

function createPairOperationId(): string {
  return `op_pair_request_${randomUUID().replaceAll("-", "")}`;
}

function createHostLockOperationId(action: "lock" | "unlock"): string {
  return `op_host_${action}_${randomUUID().replaceAll("-", "")}`;
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

function createCompactOperationId(): string {
  return `op_compact_${randomUUID().replaceAll("-", "")}`;
}

function createApprovalOperationId(): string {
  return `op_approval_${randomUUID().replaceAll("-", "")}`;
}

function createInterruptOperationId(): string {
  return `op_interrupt_${randomUUID().replaceAll("-", "")}`;
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

function parseCompactTarget(candidate: string): string {
  const parsed = sessionIdParamsSchema.safeParse({ session_id: candidate });
  if (!parsed.success) throw usageFailure("Compact requires one valid managed session id.", "session");
  return parsed.data.session_id;
}

function createCompactStartRequest(
  command: Extract<ReturnType<typeof parseCliArgs>["command"], { readonly kind: "compact" }>,
  createOperationId: () => string
): HostDeckCompactClientStartRequest {
  if (!command.confirm) throw internalFailure("Compact start command lost its confirmation.");
  let operationId: unknown;
  try {
    operationId = Reflect.apply(createOperationId, undefined, []);
  } catch (error) {
    throw internalFailure("Compact operation id generation failed.", error);
  }
  const target = sessionIdParamsSchema.safeParse({ session_id: command.session });
  const body = compactStartRequestSchema.safeParse({
    operation_id: operationId,
    kind: "compact",
    confirm: true
  });
  if (!target.success) throw usageFailure("Compact requires one valid managed session id.", "session");
  if (!body.success) throw internalFailure("Compact operation id generation failed.");
  return Object.freeze({ ...body.data, session_id: target.data.session_id });
}

function parseCompactResponse(
  candidate: unknown,
  sessionId: string,
  request: HostDeckCompactClientStartRequest | null
): CompactProgressResponse {
  let parsed: ReturnType<typeof compactProgressResponseSchema.safeParse>;
  try {
    parsed = compactProgressResponseSchema.safeParse(candidate);
  } catch {
    throw internalFailure("HostDeck compact client returned invalid managed-session data.");
  }
  if (!parsed.success) throw internalFailure("HostDeck compact client returned invalid managed-session data.");
  const progress = parsed.data.progress;
  if (progress !== null && progress.target.session_id !== sessionId) {
    throw internalFailure("HostDeck compact client returned invalid managed-session data.");
  }
  if (
    request !== null &&
    (progress === null ||
      progress.operation_id !== request.operation_id ||
      progress.state !== "accepted" ||
      progress.turn_id !== null ||
      progress.error !== null)
  ) {
    throw internalFailure("HostDeck compact client returned contradictory start data.");
  }
  if (progress === null || progress.error === null) return parsed.data;
  return compactProgressResponseSchema.parse({
    progress: {
      ...progress,
      error: {
        code: progress.error.code,
        message: compactCliProgressMessage(progress.error.code),
        retryable: progress.error.retryable
      }
    }
  });
}

function parseApprovalTarget(candidate: string): string {
  const parsed = sessionIdParamsSchema.safeParse({ session_id: candidate });
  if (!parsed.success) throw usageFailure("Approvals requires one valid managed session id.", "session");
  return parsed.data.session_id;
}

function createApprovalResponseRequest(
  command: Extract<ReturnType<typeof parseCliArgs>["command"], { readonly kind: "approvals" }>,
  createOperationId: () => string
): HostDeckApprovalClientResponseRequest {
  if (command.request === null || command.decision === null || !command.confirm) {
    throw internalFailure("Approval response command lost its request, decision, or confirmation.");
  }
  let operationId: unknown;
  try {
    operationId = Reflect.apply(createOperationId, undefined, []);
  } catch (error) {
    throw internalFailure("Approval operation id generation failed.", error);
  }
  const params = sessionApprovalParamsSchema.safeParse({
    session_id: command.session,
    request_id: command.request
  });
  const body = approvalResponseRequestSchema.safeParse({
    operation_id: operationId,
    kind: "approval_response",
    decision: command.decision,
    confirm: true
  });
  if (!params.success) throw usageFailure("Approval response target is invalid.", "approvals");
  if (!body.success) throw internalFailure("Approval operation id generation failed.");
  return Object.freeze({ ...params.data, ...body.data });
}

function parseApprovalList(candidate: unknown, sessionId: string): PendingApprovalListResponse {
  let parsed: ReturnType<typeof pendingApprovalListResponseSchema.safeParse>;
  try {
    parsed = pendingApprovalListResponseSchema.safeParse(candidate);
  } catch {
    throw internalFailure("HostDeck approval client returned invalid managed-session data.");
  }
  if (!parsed.success || parsed.data.target.session_id !== sessionId) {
    throw internalFailure("HostDeck approval client returned invalid managed-session data.");
  }
  return parsed.data;
}

function parseApprovalResponse(
  candidate: unknown,
  request: HostDeckApprovalClientResponseRequest
): PendingApprovalResponse {
  let parsed: ReturnType<typeof pendingApprovalResponseSchema.safeParse>;
  try {
    parsed = pendingApprovalResponseSchema.safeParse(candidate);
  } catch {
    throw internalFailure("HostDeck approval client returned invalid response data.");
  }
  if (
    !parsed.success ||
    parsed.data.operation_id !== request.operation_id ||
    parsed.data.requested_decision !== request.decision ||
    parsed.data.approval.target.session_id !== request.session_id ||
    parsed.data.approval.target.request_id !== request.request_id
  ) {
    throw internalFailure("HostDeck approval client returned contradictory response data.");
  }
  return parsed.data;
}

function createInterruptRequest(
  command: Extract<ReturnType<typeof parseCliArgs>["command"], { readonly kind: "interrupt" }>,
  createOperationId: () => string
): HostDeckInterruptClientRequest {
  if (!command.confirm) throw internalFailure("Interrupt command lost its confirmation.");
  let operationId: unknown;
  try {
    operationId = Reflect.apply(createOperationId, undefined, []);
  } catch (error) {
    throw internalFailure("Interrupt operation id generation failed.", error);
  }
  const params = sessionTurnParamsSchema.safeParse({ session_id: command.session, turn_id: command.turn });
  const body = interruptRequestSchema.safeParse({
    operation_id: operationId,
    kind: "interrupt",
    confirm: true
  });
  if (!params.success) throw usageFailure("Interrupt target is invalid.", "interrupt");
  if (!body.success) throw internalFailure("Interrupt operation id generation failed.");
  return Object.freeze({ ...params.data, ...body.data });
}

function parseInterruptResponse(
  candidate: unknown,
  request: HostDeckInterruptClientRequest
): InterruptResponse {
  let parsed: ReturnType<typeof interruptResponseSchema.safeParse>;
  try {
    parsed = interruptResponseSchema.safeParse(candidate);
  } catch {
    throw internalFailure("HostDeck interrupt client returned invalid response data.");
  }
  if (
    !parsed.success ||
    parsed.data.operation_id !== request.operation_id ||
    parsed.data.target.session_id !== request.session_id ||
    parsed.data.target.turn_id !== request.turn_id ||
    parsed.data.turn_id !== request.turn_id
  ) {
    throw internalFailure("HostDeck interrupt client returned contradictory response data.");
  }
  return parsed.data;
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

export async function main(args = process.argv.slice(2), options: CliRunOptions = {}): Promise<CliExitCode> {
  const result = await runCli(args, options);

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
  assertCliOutput(stdout, "stdout");
  return {
    exitCode: cliExitCodes.ok,
    stdout,
    stderr: ""
  };
}

function failure(error: ReturnType<typeof toCliFailure>): CliRunResult {
  let selectedError = error;
  let stderr: string;
  try {
    stderr = renderFailure(selectedError);
    assertCliOutput(stderr, "stderr");
  } catch {
    selectedError = internalFailure(
      "HostDeck CLI failure output exceeded its selected limit."
    );
    stderr = renderFailure(selectedError);
  }
  return {
    exitCode: selectedError.exitCode,
    stdout: "",
    stderr
  };
}

function assertCliOutput(output: string, stream: "stderr" | "stdout"): void {
  if (
    output.includes("\0") ||
    Buffer.byteLength(output, "utf8") >
      defaultResourceBudget.cli_response_max_bytes
  ) {
    throw internalFailure(`HostDeck CLI ${stream} exceeds its selected limit.`);
  }
}
