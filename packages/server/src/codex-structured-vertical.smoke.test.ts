import {
  type ChildProcess,
  execFileSync,
  spawn,
  spawnSync
} from "node:child_process";
import { once } from "node:events";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  realpathSync
} from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  writeFile
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, win32 } from "node:path";
import {
  buildCodexPlatformTuiResumeCommand,
  type CodexConnectionNotification,
  type CodexPlatformTuiResumeCommand,
  type CodexProtectedEnvironmentCredentialSource,
  type CodexProtocolIssue,
  type CodexRequestInput,
  type CodexRuntimeReconnectController,
  codexBindingDescriptor,
  codexRemoteAuthEnvironmentVariable,
  createCodexApprovalClient,
  createCodexCompactClient,
  createCodexGoalClient,
  createCodexModelClient,
  createCodexPlanClient,
  createCodexRuntimeReconnectController,
  createCodexSkillsClient,
  createCodexThreadClient,
  createCodexTurnClient,
  createCodexUnixSocketEndpoint,
  createCodexUnixWebSocketTransport,
  createCodexUsageClient,
  parseCodexCliVersionOutput
} from "@hostdeck/codex-adapter";
import {
  defaultResourceBudget,
  type ManagedSessionTarget,
  type RuntimeCompatibility,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "@hostdeck/contracts";
import { type CodexThreadId, createOperationDeadline } from "@hostdeck/core";
import {
  createProductionProjectionAppendPort,
  createProductionProjectionContinuityPort,
  createSelectedStateRepository,
  openMigratedDatabase,
  prepareHostDeckLocalPaths,
  resolveNativeWindowsHostDeckDefaultPaths,
  runStartupAuditOrphanReconciliation,
  type SelectedStateRepository,
  secureHostDeckRegularFile
} from "@hostdeck/storage";
import { describe, expect, it } from "vitest";
import {
  type CodexApprovalControlService,
  createCodexApprovalControlService
} from "./codex-approval-control-service.js";
import { createCodexCompactControlService } from "./codex-compact-control-service.js";
import { createCodexControlEventObserver } from "./codex-control-event-observer.js";
import {
  type CodexEventPipeline,
  type CodexEventPipelineOptions,
  createCodexEventPipeline
} from "./codex-event-pipeline.js";
import { createCodexGoalControlService } from "./codex-goal-control-service.js";
import {
  isProcessAlive,
  readBoundedProcessCommandLine
} from "./codex-hostdeck-restart-smoke-support.js";
import { createCodexInterruptControlService } from "./codex-interrupt-control-service.js";
import { createCodexModelControlService } from "./codex-model-control-service.js";
import { createCodexPlanControlService } from "./codex-plan-control-service.js";
import { createCodexPromptControlService } from "./codex-prompt-control-service.js";
import { createCodexRuntimeReconciliationLifecycle } from "./codex-runtime-reconciliation-lifecycle.js";
import { createCodexSkillsControlService } from "./codex-skills-control-service.js";
import {
  readStructuredVerticalTurnTerminal,
  type StructuredVerticalTurnTerminalEvidence
} from "./codex-structured-vertical-evidence.js";
import {
  createStructuredVerticalReport,
  publishStructuredVerticalReport,
  requireStructuredVerticalReportPath
} from "./codex-structured-vertical-report.js";
import { selectStructuredVerticalPlanModel } from "./codex-structured-vertical-selection.js";
import { createCodexUsageControlService } from "./codex-usage-control-service.js";
import { createCodexWindowsRuntimeConnection } from "./codex-windows-runtime-connection.js";
import {
  type CodexWindowsRuntimeChildProcess,
  type CodexWindowsRuntimeProcessPort,
  type CodexWindowsRuntimeProcessRequest,
  createCodexWindowsRuntimeSupervisor
} from "./codex-windows-runtime-supervisor.js";
import {
  codexWindowsRuntimeCredentialPath,
  createNodeCodexWindowsRuntimeProcessPort
} from "./codex-windows-runtime-supervisor-node.js";
import {
  createWindowsStructuredVerticalReport,
  publishWindowsStructuredVerticalReport,
  requireWindowsStructuredVerticalReportPath
} from "./codex-windows-structured-vertical-report.js";
import { combinePendingTurnSettingsReaders } from "./pending-turn-settings.js";
import {
  type WithTestOperationDeadlines,
  withTestOperationDeadlines
} from "./test-operation-deadline.js";

type TestApprovalControlService = WithTestOperationDeadlines<
  CodexApprovalControlService,
  "respond" | "waitForTerminal"
>;

const requireSmoke = process.env.HOSTDECK_REQUIRE_CODEX_VERTICAL_SMOKE === "1";
const requestedHostTarget =
  process.env.HOSTDECK_CODEX_VERTICAL_TARGET ?? "linux-x64";
if (
  requireSmoke &&
  requestedHostTarget !== "linux-x64" &&
  requestedHostTarget !== "windows-x64"
) {
  throw new TypeError("Structured vertical host target is invalid.");
}
const hostTarget = requestedHostTarget as "linux-x64" | "windows-x64";
const overallTimeoutMs = 360_000;
const planPrompt = "Produce a concise two-step plan for inspecting README.md. Do not call tools or modify files.";
const goalObjective = "Keep aggregate runtime evidence bounded.";
const interruptPrompt =
  "Without using tools, write 300 numbered one-sentence observations about deterministic software testing. Do not stop early.";

type ProofSource =
  | "request_response"
  | "normalized_event"
  | "durable_projection"
  | "read_back"
  | "server_request_response"
  | "filesystem_side_effect"
  | "tui_inspection"
  | "policy_simulation";

interface ProofEntry {
  readonly claim: string;
  readonly source: ProofSource;
}

describe.skipIf(!requireSmoke)("exact Codex assembled structured vertical", () => {
  it(
    "proves one callback pipeline and all selected controls across two managed threads",
    async () => {
      const startedAt = Date.now();
      const repositoryRoot = realpathSync(process.cwd());
      const codexBin = requireExactCodexBinary(
        process.env.HOSTDECK_CODEX_BIN,
        hostTarget
      );
      const reportPath = resolveStructuredVerticalReportPath(hostTarget);
      const hostdeckCommit =
        reportPath === null ? null : currentCleanCommit(repositoryRoot);
      const version = parseCodexCliVersionOutput(
        execFileSync(codexBin, ["--version"], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 })
      );
      expect(version).toBe(codexBindingDescriptor.codex_version);

      const layout = await createStructuredVerticalLayout(hostTarget);
      const {
        root,
        runtimeDirectory,
        codexHome,
        projectA,
        projectB,
        databasePath,
        markerPath,
        appEndpointPath,
        tuiSocketPath
      } = layout;
      const approvalPrompt =
        `Use the shell tool exactly once to run ${approvalCommand(markerPath, hostTarget)} with elevated permission. ` +
        "Request approval, do not use file-editing tools, and do nothing else.";
      try {
        await seedCodexAuthentication(codexHome);
        await seedCodexConfiguration(codexHome);
        execFileSync("git", ["init", "-q", "-b", "main", projectA], { timeout: 10_000 });
        execFileSync("git", ["init", "-q", "-b", "main", projectB], { timeout: 10_000 });
      } catch (error) {
        await layout.cleanup();
        throw error;
      }

      const child =
        hostTarget === "linux-x64"
          ? spawn(
              codexBin,
              [
                "--enable",
                "use_legacy_landlock",
                "-c",
                'sandbox_mode="read-only"',
                "-c",
                'approval_policy="on-request"',
                "app-server",
                "--listen",
                `unix://${appEndpointPath}`
              ],
              {
                cwd: projectA,
                env: { ...process.env, CODEX_HOME: codexHome },
                stdio: ["ignore", "ignore", "pipe"]
              }
            )
          : null;
      let appServerStderr = "";
      child?.stderr?.on("data", (chunk: Buffer) => {
        appServerStderr = boundedOutput(appServerStderr, chunk);
      });
      const windowsChildren: CodexWindowsRuntimeChildProcess[] = [];
      const windowsObservedPorts: number[] = [];
      const nativeWindowsProcessPort =
        hostTarget === "windows-x64"
          ? createNodeCodexWindowsRuntimeProcessPort()
          : null;
      const windowsProcessPort: CodexWindowsRuntimeProcessPort | undefined =
        nativeWindowsProcessPort === null
          ? undefined
          : Object.freeze({
              spawn(request: CodexWindowsRuntimeProcessRequest) {
                const spawned = nativeWindowsProcessPort.spawn(request);
                windowsChildren.push(spawned);
                return spawned;
              }
            });
      const windowsSupervisor =
        hostTarget === "windows-x64"
          ? createCodexWindowsRuntimeSupervisor({
              codex_bin: codexBin,
              cwd: projectA,
              endpoint_file_path: appEndpointPath,
              environment: {
                ...process.env,
                CODEX_HOME: codexHome,
                NO_COLOR: "1"
              },
              process_port:
                windowsProcessPort ??
                (() => {
                  throw new Error(
                    "Windows structured vertical process port is unavailable."
                  );
                })()
            })
          : null;
      const windowsOwner =
        windowsSupervisor === null
          ? null
          : createCodexWindowsRuntimeConnection({
              supervisor: windowsSupervisor,
              resource_budget: defaultResourceBudget
            });

      const proof: ProofEntry[] = [];
      const requestRecords: Array<{ readonly method: string; readonly params: unknown }> = [];
      const notificationCounts = new Map<string, number>();
      const observerCounts = new Map<string, number>();
      const publicationCounts = new Map<string, number>();
      const serverRequestMethods: string[] = [];
      const protocolIssues: CodexProtocolIssue[] = [];
      const backgroundErrors: Error[] = [];
      const callbackTasks = new Set<Promise<unknown>>();
      const deferredNotifications: Array<{
        readonly message: CodexConnectionNotification;
        readonly generation: number;
      }> = [];
      let callbackFailure: Error | null = null;
      let serverRequestFailure: Error | null = null;
      let expectedGeneration: number | null = null;
      let callbackMode: "buffering" | "live" = "buffering";
      let approvals: TestApprovalControlService | null = null;
      let planRehydrate: ((target: unknown) => Promise<unknown>) | null = null;
      let observeControlEvent: CodexEventPipelineOptions["observe_event"];
      let tui: TuiProbe | null = null;
      const threadIds: CodexThreadId[] = [];
      const compactProgressEvidence: string[] = [];
      const openDatabase = openMigratedDatabase(databasePath, {
        now: () => new Date()
      });
      const repository = createSelectedStateRepository(openDatabase.db);
      const projection = createProductionProjectionAppendPort({
        repository,
        publish(committed) {
          const durable = repository.require(committed.event.event.session_id);
          expect(durable.projection).toEqual(committed.projection);
          increment(publicationCounts, committed.event.event.session_id);
        }
      });
      const continuity = createProductionProjectionContinuityPort({
        repository,
        publish() {}
      });
      const eventClock = monotonicWallClock();
      const pipeline = createCodexEventPipeline({
        repository,
        append_port: projection,
        normalizer: { now: eventClock },
        async observe_event(event, generation) {
          if (observeControlEvent === undefined) {
            throw new Error(
              "Codex control observers are unavailable for a live event."
            );
          }
          await observeControlEvent(event, generation);
        }
      });
      const reconciliation = createCodexRuntimeReconciliationLifecycle({
        approvals: {
          async disconnect(generation) {
            if (approvals === null) {
              throw new Error(
                "Structured vertical approval control is unavailable."
              );
            }
            return approvals.disconnect(generation);
          }
        },
        audit: {
          reconcile(input) {
            return runStartupAuditOrphanReconciliation({
              db: openDatabase.db,
              eligible_before: input.eligible_before,
              reconciled_at: input.reconciled_at,
              signal: input.deadline.signal,
              timeout_ms: input.deadline.timeoutMs(2_000)
            });
          }
        },
        continuity,
        events: {
          barrier: (input) => pipeline.barrier(input.signal),
          reconcile: (input) =>
            pipeline.reconcile(input.threads, input.signal)
        },
        now: monotonicWallClock(),
        plans: {
          rehydrate(target) {
            if (planRehydrate === null) {
              throw new Error(
                "Structured vertical Plan control is unavailable."
              );
            }
            return planRehydrate(target);
          }
        },
        projection,
        repository,
        resource_budget: defaultResourceBudget
      });

      const consumeThroughPipeline = (message: CodexConnectionNotification, generation: number): void => {
        const operation = pipeline.consume(message, generation);
        callbackTasks.add(operation);
        void operation
          .catch((error: unknown) => {
            callbackFailure ??= asError(error);
          })
          .finally(() => callbackTasks.delete(operation));
      };

      const connection = createCodexRuntimeReconnectController({
        transport:
          windowsOwner?.transport ??
          createCodexUnixWebSocketTransport({ socket_path: appEndpointPath }),
        observed_version: version,
        host_target: hostTarget,
        resource_budget: defaultResourceBudget,
        lifecycle: Object.freeze({
          disconnected: reconciliation.disconnected,
          reconcile: reconciliation.reconcile,
          resubscribe: reconciliation.resubscribe,
          ready: reconciliation.ready
        }),
        random: () => 0,
        on_notification(message) {
          increment(notificationCounts, summarizeNotification(message));
          let generation: number;
          try {
            generation = connection.generation;
          } catch (error) {
            callbackFailure ??= asError(error);
            return;
          }
          if (expectedGeneration !== null && generation !== expectedGeneration) {
            callbackFailure ??= new Error(
              `Codex connection generation drifted from ${expectedGeneration} to ${generation}.`
            );
            return;
          }
          if (callbackMode === "buffering") {
            if (deferredNotifications.length >= defaultResourceBudget.protocol_max_pending_notifications) {
              callbackFailure ??= new Error("Codex pre-pipeline callback capacity was exhausted.");
              return;
            }
            deferredNotifications.push({ message, generation });
            return;
          }
          consumeThroughPipeline(message, generation);
        },
        on_server_request(message) {
          serverRequestMethods.push(message.method);
          try {
            if (approvals === null) throw new Error("Approval service is unavailable for a live server request.");
            approvals.register(message);
          } catch (error) {
            serverRequestFailure ??= asError(error);
            throw error;
          }
        },
        on_protocol_issue: (issue) => protocolIssues.push(issue),
        on_background_error: (error) => backgroundErrors.push(error)
      });

      let smokeError: Error | null = null;
      try {
        if (child !== null) {
          await waitForSocket(appEndpointPath, child, () => appServerStderr);
          expect((await lstat(runtimeDirectory)).mode & 0o077).toBe(0);
        }
        await connection.start();
        expectedGeneration = connection.generation;
        expect(expectedGeneration).toBeGreaterThan(0);
        prove(proof, "exact runtime connected", "request_response");

        const port = requestRecordingPort(connection, requestRecords);
        const threads = createCodexThreadClient(port);
        const [threadA, threadB] = await Promise.all([
          createManagedThread(threads, projectA, "a"),
          createManagedThread(threads, projectB, "b")
        ]);
        threadIds.push(threadA, threadB);
        const targetA = managedTarget("sess_vertical_a", threadA);
        const targetB = managedTarget("sess_vertical_b", threadB);
        const createdAt = new Date().toISOString();
        repository.create(selectedState(targetA, projectA, version, createdAt));
        repository.create(selectedState(targetB, projectB, version, createdAt));
        prove(proof, "two durable managed mappings created", "read_back");

        const modelControl = withTestOperationDeadlines(createCodexModelControlService({
          models: createCodexModelClient(port),
          states: repository
        }), ["dispatchPendingTurn", "prepareTurnSettings", "select", "snapshot"]);
        const planControl = withTestOperationDeadlines(createCodexPlanControlService({
          plans: createCodexPlanClient(port),
          models: modelControl,
          states: repository
        }), ["dispatchPendingTurn", "select", "snapshot"]);
        const pendingSettings = combinePendingTurnSettingsReaders([modelControl, planControl]);
        const goalControl = withTestOperationDeadlines(createCodexGoalControlService({
          goals: createCodexGoalClient(port),
          states: repository,
          pending_settings: pendingSettings
        }), ["mutate", "snapshot"]);
        const turnClient = createCodexTurnClient(port);
        const promptControl = withTestOperationDeadlines(createCodexPromptControlService({
          turns: turnClient,
          models: modelControl,
          plans: planControl,
          states: repository
        }), ["dispatch"]);
        const usageControl = withTestOperationDeadlines(createCodexUsageControlService({
          usage: createCodexUsageClient(port),
          states: repository
        }), ["read"]);
        const compactControl = withTestOperationDeadlines(createCodexCompactControlService({
          compact: createCodexCompactClient(port),
          states: repository
        }), ["compact"]);
        const skillsControl = withTestOperationDeadlines(createCodexSkillsControlService({
          skills: createCodexSkillsClient(port),
          states: repository
        }), ["list"]);
        approvals = withTestOperationDeadlines(createCodexApprovalControlService({
          approvals: createCodexApprovalClient(connection),
          states: repository,
          expiry_ms: 30_000,
          on_background_error: (error) => backgroundErrors.push(error)
        }), ["respond", "waitForTerminal"]);
        const interruptControl = withTestOperationDeadlines(
          createCodexInterruptControlService({ turns: turnClient, states: repository }),
          ["interrupt", "waitForTerminal"]
        );
        const controlObserver = createCodexControlEventObserver({
          plans: planControl,
          goals: goalControl,
          compact: compactControl,
          usage: usageControl,
          approvals,
          interrupts: interruptControl,
          prompts: promptControl
        });
        planRehydrate = (target) => planControl.rehydrate(target);
        observeControlEvent = async (event, generation) => {
          const receipt = await controlObserver.observe(event, generation);
          increment(observerCounts, receipt.method);
          if (
            "thread_id" in event &&
            event.thread_id === targetA.codex_thread_id &&
            [
              "turn/started",
              "item/started",
              "item/completed",
              "turn/completed"
            ].includes(event.method)
          ) {
            const progress = await compactControl.snapshot(targetA);
            if (progress !== null) {
              compactProgressEvidence.push(`${event.method}:${progress.state}`);
            }
          }
        };
        const deferredNotificationCount = deferredNotifications.length;
        for (const deferred of deferredNotifications.splice(0)) {
          if (deferred.generation !== expectedGeneration) {
            callbackFailure ??= new Error("A buffered Codex notification belongs to another connection generation.");
            break;
          }
          consumeThroughPipeline(deferred.message, deferred.generation);
        }
        callbackMode = "live";
        await flushCallbacks(callbackTasks, () => callbackFailure, () => serverRequestFailure, pipeline);
        expect(pipeline.last_sequence).toBeGreaterThanOrEqual(deferredNotificationCount);
        expect(publicationCounts.get(targetA.session_id) ?? 0).toBeGreaterThan(0);
        expect(publicationCounts.get(targetB.session_id) ?? 0).toBeGreaterThan(0);
        prove(proof, "buffered mapping callbacks traversed one pipeline", "durable_projection");

        await proveUnsupportedSkillsPolicy(connection, root);
        prove(proof, "unsupported utility rejected without wire", "policy_simulation");

        const modelBefore = await modelControl.snapshot(targetA);
        const selection = selectStructuredVerticalPlanModel(
          modelBefore.models,
          modelBefore.current.model_id,
          modelBefore.current.reasoning_effort
        );
        const selectedModel = await modelControl.select({
          operation_id: "op_vertical_model_select_0001",
          target: targetA,
          kind: "model",
          model_id: selection.model.id,
          reasoning_effort: selection.effort,
          expected_pending_revision: null
        });
        if (selectedModel.pending === null) throw new Error("Aggregate model selection did not create pending state.");

        const planBefore = await planControl.snapshot(targetA);
        if (!planBefore.modes.some((mode) => mode.mode === "plan")) {
          throw new Error("Exact runtime exposes no Plan mode for the aggregate.");
        }
        const selectedPlan = await planControl.select({
          operation_id: "op_vertical_plan_enter_0001",
          target: targetA,
          kind: "plan",
          action: "enter",
          expected_pending_revision: null
        });
        if (selectedPlan.pending === null) throw new Error("Aggregate Plan selection did not create pending state.");

        const planDispatch = await promptControl.dispatch({
          operation_id: "op_vertical_prompt_plan_0001",
          target: targetA,
          kind: "prompt",
          text: planPrompt
        });
        expect(planDispatch).toMatchObject({ action: "start", thread_id: threadA, state: "accepted" });
        prove(proof, "model and Plan prompt accepted", "request_response");
        const planTerminal = await waitForValue(
          async () => {
            await flushCallbacks(callbackTasks, () => callbackFailure, () => serverRequestFailure, pipeline);
            return turnTerminalEvidence(repository, targetA.session_id, planDispatch.turn_id);
          },
          (value) => value !== null,
          120_000,
          () => "Model-plus-Plan aggregate turn did not complete durably."
        );
        requireTurnTerminal(planTerminal, "completed", "Model-plus-Plan aggregate turn");
        const planAfter = await planControl.snapshot(targetA);
        const modelAfter = await modelControl.snapshot(targetA);
        expect(planAfter).toMatchObject({ current: { state: "confirmed", mode: "plan" }, pending: null });
        expect(["active", "complete"]).toContain(planAfter.execution.state);
        expect(modelAfter).toMatchObject({
          current: { model_id: selection.model.id, reasoning_effort: selection.effort },
          pending: null
        });
        prove(proof, "Plan and model confirmed by events", "normalized_event");
        prove(proof, "Plan turn committed to projection", "durable_projection");

        const turnsBeforeGoal = requestRecords.filter((record) => record.method === "turn/start").length;
        const goalSetsBefore = requestRecords.filter((record) => record.method === "thread/goal/set").length;
        await expect(
          goalControl.mutate({
            operation_id: "op_vertical_goal_set_0001",
            target: targetA,
            kind: "goal",
            action: "set",
            objective: goalObjective,
            expected_goal_revision: null
          })
        ).resolves.toMatchObject({ action: "set", state: "succeeded", dispatched: true });
        expect(requestRecords.filter((record) => record.method === "thread/goal/set")).toHaveLength(goalSetsBefore + 1);
        expect(requestRecords.filter((record) => record.method === "turn/start")).toHaveLength(turnsBeforeGoal);
        await waitFor(
          async () => {
            await flushCallbacks(callbackTasks, () => callbackFailure, () => serverRequestFailure, pipeline);
            return (await goalControl.snapshot(targetA)).goal?.status === "paused";
          },
          30_000,
          () => "Passive goal state did not become readable."
        );
        prove(proof, "passive goal read back paused", "read_back");

        const usageBefore = await usageControl.read({
          operation_id: "op_vertical_usage_before_0001",
          target: targetA,
          kind: "usage"
        });
        expect(usageBefore).toMatchObject({ target: targetA, runtime_version: version });
        expect(usageBefore.thread).toMatchObject({ state: "observed", turn_id: planDispatch.turn_id });

        const [skillsA, skillsB] = await Promise.all([
          skillsControl.list({ operation_id: "op_vertical_skills_a_0001", target: targetA, kind: "skills" }),
          skillsControl.list({ operation_id: "op_vertical_skills_b_0001", target: targetB, kind: "skills" })
        ]);
        expect(skillsA.target).toEqual(targetA);
        expect(skillsB.target).toEqual(targetB);
        expect(skillsA.skills.map((skill) => skill.name)).toEqual(skillsB.skills.map((skill) => skill.name));
        expect(JSON.stringify([skillsA, skillsB])).not.toContain(root);
        const skillsRequests = requestRecords.filter((request) => request.method === "skills/list");
        expect(skillsRequests).toHaveLength(2);
        expect(skillsRequests.map((request) => request.params)).toEqual(
          expect.arrayContaining([
            { cwds: [projectA], forceReload: true },
            { cwds: [projectB], forceReload: true }
          ])
        );
        prove(proof, "usage and two-cwd skills read without mutation", "read_back");

        const exitedPlan = await planControl.select({
          operation_id: "op_vertical_plan_exit_0001",
          target: targetA,
          kind: "plan",
          action: "exit",
          expected_pending_revision: null
        });
        if (exitedPlan.pending === null) throw new Error("Aggregate Default selection did not create pending state.");

        const approvalTurn = await promptControl.dispatch({
          operation_id: "op_vertical_prompt_approval_0001",
          target: targetA,
          kind: "prompt",
          text: approvalPrompt
        });
        const pendingApproval = await waitForValue(
          async () => {
            await flushCallbacks(callbackTasks, () => callbackFailure, () => serverRequestFailure, pipeline);
            return (await approvals?.list(targetA))?.find((approval) => approval.state === "pending") ?? null;
          },
          (value) => value !== null,
          90_000,
          () => "Command-backed aggregate turn produced no approval request."
        );
        if (pendingApproval === null) throw new Error("Approval wait returned no pending request.");
        await expect(
          approvals.respond({
            operation_id: "op_vertical_approval_respond_0001",
            target: pendingApproval.target,
            kind: "approval_response",
            decision: "approve",
            confirm: true
          })
        ).resolves.toMatchObject({ state: "responding", decision: null });
        prove(proof, "command approval routed exactly once", "server_request_response");
        const approvalTerminal = await waitForValue(
          async () => {
            await flushCallbacks(callbackTasks, () => callbackFailure, () => serverRequestFailure, pipeline);
            return turnTerminalEvidence(repository, targetA.session_id, approvalTurn.turn_id);
          },
          (value) => value !== null,
          120_000,
          () => "Approved command turn did not complete durably."
        );
        requireTurnTerminal(approvalTerminal, "completed", "Approved command turn");
        await flushCallbacks(callbackTasks, () => callbackFailure, () => serverRequestFailure, pipeline);
        await expect(approvals.snapshot(pendingApproval.target)).resolves.toMatchObject({
          state: "approved",
          decision: "approve"
        });
        await access(markerPath);
        prove(proof, "approved command produced marker", "filesystem_side_effect");
        expect((await planControl.snapshot(targetA)).current).toMatchObject({ state: "confirmed", mode: "default" });

        const interruptTurn = await promptControl.dispatch({
          operation_id: "op_vertical_prompt_interrupt_0001",
          target: targetA,
          kind: "prompt",
          text: interruptPrompt
        });
        await waitFor(
          async () => {
            await flushCallbacks(callbackTasks, () => callbackFailure, () => serverRequestFailure, pipeline);
            return (await promptControl.snapshot(targetA)).phase === "steerable";
          },
          60_000,
          () => "Interrupt aggregate turn never became event-proven active."
        );
        await expect(
          interruptControl.interrupt({
            operation_id: "op_vertical_interrupt_0001",
            target: {
              type: "turn",
              session_id: targetA.session_id,
              codex_thread_id: targetA.codex_thread_id,
              turn_id: interruptTurn.turn_id
            },
            kind: "interrupt",
            confirm: true
          })
        ).resolves.toMatchObject({ state: "accepted", turn_id: interruptTurn.turn_id });
        const interruptTerminal = await waitForValue(
          async () => {
            await flushCallbacks(callbackTasks, () => callbackFailure, () => serverRequestFailure, pipeline);
            return turnTerminalEvidence(repository, targetA.session_id, interruptTurn.turn_id);
          },
          (value) => value !== null,
          60_000,
          () => "Interrupt did not reach durable interrupted terminal truth."
        );
        requireTurnTerminal(interruptTerminal, "interrupted", "Interrupted aggregate turn");
        prove(proof, "active turn interrupted by exact event", "normalized_event");

        const compactAccepted = await compactControl.compact({
          operation_id: "op_vertical_compact_0001",
          target: targetA,
          kind: "compact",
          confirm: true
        });
        expect(compactAccepted).toMatchObject({ state: "accepted", target: targetA });
        const compactCompleted = await waitForValue(
          async () => {
            await flushCallbacks(callbackTasks, () => callbackFailure, () => serverRequestFailure, pipeline);
            return compactControl.snapshot(targetA);
          },
          (value) =>
            value !== null && ["completed", "failed", "incomplete", "interrupted"].includes(value.state),
          120_000,
          () => "Aggregate compact did not reach event-proven completion."
        );
        expect(compactCompleted).toMatchObject({ state: "completed", turn_id: expect.any(String), error: null });
        if (compactCompleted?.turn_id === null || compactCompleted?.turn_id === undefined) {
          throw new Error("Aggregate compact completed without one exact compact turn id.");
        }
        expect(compactProgressEvidence).toEqual(
          expect.arrayContaining([
            "item/started:running",
            "item/completed:running",
            "turn/completed:completed"
          ])
        );
        const usageAfter = await usageControl.read({
          operation_id: "op_vertical_usage_after_0001",
          target: targetA,
          kind: "usage"
        });
        expect(usageAfter).toMatchObject({ target: targetA, runtime_version: version });
        expect(usageAfter.thread).toMatchObject({ state: "observed", turn_id: compactCompleted.turn_id });
        if (usageAfter.thread.state !== "observed") {
          throw new Error("Aggregate compact lost its post-reset thread usage observation.");
        }
        prove(proof, "compact ran and completed through shared observers", "normalized_event");
        prove(proof, "compact usage reset remained coherent", "durable_projection");

        const windowsTuiAuthority = windowsOwner?.current_tui_authority() ?? null;
        if (
          windowsTuiAuthority !== null &&
          windowsTuiAuthority.generation !== expectedGeneration
        ) {
          throw new Error("Windows TUI authority generation is stale.");
        }
        if (windowsTuiAuthority !== null) {
          windowsObservedPorts.push(
            windowsEndpointPort(windowsTuiAuthority.endpoint.address)
          );
        }
        const tuiCommand = buildCodexPlatformTuiResumeCommand({
          target: hostTarget,
          endpoint:
            windowsTuiAuthority?.endpoint ??
            createCodexUnixSocketEndpoint(appEndpointPath),
          thread_id: threadB,
          codex_bin: codexBin,
          cwd: projectB
        });
        tui = await startAndInspectTui(
          tuiCommand,
          windowsTuiAuthority?.credential,
          codexHome,
          projectB,
          tuiSocketPath
        );
        expect(tui.output).toContain("OpenAI Codex");
        expect(tui.output).toContain(basename(projectB));
        await tui.close();
        tui = null;
        await flushCallbacks(callbackTasks, () => callbackFailure, () => serverRequestFailure, pipeline);
        expect(connection.snapshot().phase).toBe("ready");
        expect(connection.generation).toBe(expectedGeneration);
        await expect(threads.read(threadB)).resolves.toMatchObject({ id: threadB, status: "idle" });
        prove(proof, "TUI shared thread while HostDeck remained connected", "tui_inspection");

        if (windowsOwner !== null && windowsTuiAuthority !== null) {
          const firstCredential = windowsTuiAuthority.credential.read(
            codexRemoteAuthEnvironmentVariable
          );
          if (firstCredential === undefined) {
            throw new Error("Windows runtime credential disappeared before crash injection.");
          }
          const firstChild = windowsChildren[0];
          if (firstChild === undefined || !firstChild.terminateTree()) {
            throw new Error("Windows app-server crash injection was rejected.");
          }
          expectedGeneration = null;
          await firstChild.exit;
          await waitFor(
            () =>
              connection.snapshot().phase === "ready" &&
              connection.generation === 2 &&
              reconciliation.snapshot().phase === "ready" &&
              reconciliation.snapshot().generation === 2,
            30_000,
            () =>
              "Windows app-server was not reconciled and readmitted after forced exit."
          );
          expectedGeneration = connection.generation;
          await flushCallbacks(
            callbackTasks,
            () => callbackFailure,
            () => serverRequestFailure,
            pipeline
          );
          const secondAuthority = windowsOwner.current_tui_authority();
          const secondCredential = secondAuthority.credential.read(
            codexRemoteAuthEnvironmentVariable
          );
          if (secondCredential === undefined) {
            throw new Error("Rotated Windows runtime credential is unavailable.");
          }
          expect(secondAuthority.generation).toBe(2);
          windowsObservedPorts.push(
            windowsEndpointPort(secondAuthority.endpoint.address)
          );
          if (
            secondAuthority.endpoint.address ===
              windowsTuiAuthority.endpoint.address ||
            secondCredential === firstCredential ||
            windowsTuiAuthority.credential.read(
              codexRemoteAuthEnvironmentVariable
            ) !== undefined
          ) {
            throw new Error(
              "Windows runtime authority did not rotate and revoke cleanly."
            );
          }
          expect(connection.snapshot()).toMatchObject({
            phase: "ready",
            admitted_generation: 2,
            completed_reconnects: 1,
            disconnect_cleanups: 1
          });
          expect(reconciliation.snapshot()).toMatchObject({
            phase: "ready",
            generation: 2,
            gap_reason: "disconnect",
            durable_session_count: 2,
            boundary_count: 2,
            ready_count: 2
          });
          expect(windowsOwner.snapshot()).toMatchObject({
            phase: "active",
            runtime_generation: 2,
            transport_generation: 2,
            runtime_restarts: 1,
            observed_exits: 1
          });
          expect(windowsChildren).toHaveLength(2);
          await expect(threads.read(threadA)).resolves.toMatchObject({
            id: threadA,
            status: "idle"
          });
          prove(
            proof,
            "Windows crash reconciled before runtime readmission",
            "durable_projection"
          );
        }

        const threadBEvents = repository.listEvents(targetB.session_id).events;
        expect(threadBEvents.some((event) => event.type === "turn")).toBe(false);
        expect(turnStartRequestCountForThread(requestRecords, threadB)).toBe(0);
        expect(publicationCounts.get(targetA.session_id) ?? 0).toBeGreaterThan(0);
        expect(observerCounts.get("turn/started") ?? 0).toBeGreaterThanOrEqual(3);
        expect(pipeline.failure).toBeNull();
        expect(protocolIssues).toEqual([]);
        expect(backgroundErrors).toEqual([]);
        expect(serverRequestMethods).toHaveLength(1);
        expect(requestRecords.filter((request) => request.method === "turn/start")).toHaveLength(3);
        expect(requestRecords.filter((request) => request.method === "thread/compact/start")).toHaveLength(1);
        expect(connection.generation).toBe(expectedGeneration);
        expect(Date.now() - startedAt).toBeLessThan(overallTimeoutMs);

        const requiredSources = new Set<ProofSource>([
          "request_response",
          "normalized_event",
          "durable_projection",
          "read_back",
          "server_request_response",
          "filesystem_side_effect",
          "tui_inspection",
          "policy_simulation"
        ]);
        expect(new Set(proof.map((entry) => entry.source))).toEqual(requiredSources);
        expect(proof.length).toBeLessThanOrEqual(32);
        const redactedProof = JSON.stringify(proof);
        for (const sensitive of [
          root,
          projectA,
          projectB,
          markerPath,
          targetA.session_id,
          targetB.session_id,
          threadA,
          threadB,
          planPrompt,
          approvalPrompt,
          interruptPrompt,
          goalObjective,
          selection.model.id,
          selection.effort
        ]) {
          expect(redactedProof).not.toContain(sensitive);
        }

        await threads.archive(threadA);
        threadIds.shift();
        await threads.archive(threadB);
        threadIds.shift();
        await waitFor(
          async () => {
            await flushCallbacks(callbackTasks, () => callbackFailure, () => serverRequestFailure, pipeline);
            return [targetA, targetB].every((target) => {
              const session = repository.require(target.session_id).projection.session;
              return session.session_state === "unknown" && session.freshness === "stale";
            });
          },
          10_000,
          () => "Archive notifications did not traverse the shared durable callback path."
        );
        await expect(threads.list({ archived: true, limit: 100 })).resolves.toMatchObject({
          data: expect.arrayContaining([expect.objectContaining({ id: threadA }), expect.objectContaining({ id: threadB })])
        });
        expect(repository.require(targetA.session_id).mapping.archived_at).toBeNull();
        expect(repository.require(targetB.session_id).mapping.archived_at).toBeNull();
        prove(proof, "runtime archives read back after durable callbacks", "read_back");
      } catch (error) {
        const stderrSummary = redactDiagnostic(appServerStderr, [
          root,
          runtimeDirectory,
          codexHome,
          projectA,
          projectB,
          databasePath,
          markerPath,
          appEndpointPath,
          tuiSocketPath,
          ...threadIds
        ]);
        smokeError = new Error(
          `Real Codex structured vertical failed (threads=${threadIds.length}, requests=${requestRecords.length}, notifications=${summarizeCounts(notificationCounts)}, observers=${summarizeCounts(observerCounts)}, publication_sessions=${publicationCounts.size}, publications=${sumCounts(publicationCounts)}, server_requests=${serverRequestMethods.join("|") || "none"}, issues=${protocolIssues.map((issue) => issue.code).join("|") || "none"}, stderr=${stderrSummary || "empty"}).`,
          { cause: error }
        );
      }

      const cleanupErrors: unknown[] = [];
      const callbackFailureBeforeCleanup = aggregateCallbackFailure(
        () => callbackFailure,
        () => serverRequestFailure,
        pipeline
      );
      if (tui !== null) await collectCleanupError(tui.close(), cleanupErrors);
      if (connection.snapshot().phase === "ready" && threadIds.length > 0) {
        const threads = createCodexThreadClient(connection);
        for (const threadId of [...threadIds]) await collectCleanupError(threads.archive(threadId), cleanupErrors);
      }
      await collectCleanupError(settleCallbacks(callbackTasks), cleanupErrors);
      const callbackFailureAfterCleanup = aggregateCallbackFailure(
        () => callbackFailure,
        () => serverRequestFailure,
        pipeline
      );
      if (
        callbackFailureAfterCleanup !== null &&
        (smokeError === null || callbackFailureAfterCleanup !== callbackFailureBeforeCleanup)
      ) {
        cleanupErrors.push(callbackFailureAfterCleanup);
      }
      await collectCleanupError(connection.close(), cleanupErrors);
      if (windowsOwner !== null) {
        const deadline = createOperationDeadline({ timeoutMs: 10_000 });
        await collectCleanupError(windowsOwner.close(deadline), cleanupErrors);
        deadline.dispose();
        await collectCleanupError(
          verifyWindowsRuntimeCleanup({
            supervisor: windowsSupervisor,
            children: windowsChildren,
            ports: windowsObservedPorts,
            endpointPath: appEndpointPath
          }),
          cleanupErrors
        );
      }
      if (approvals !== null) {
        try {
          approvals.close();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (child !== null) {
        await collectCleanupError(stopChild(child), cleanupErrors);
      }
      if (openDatabase !== null) {
        try {
          openDatabase.db.close();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      await collectCleanupError(layout.cleanup(), cleanupErrors);
      if (smokeError !== null && cleanupErrors.length > 0) {
        throw new AggregateError([smokeError, ...cleanupErrors], "Codex structured vertical and cleanup failed.");
      }
      if (smokeError !== null) throw smokeError;
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Codex structured vertical cleanup failed.");
      for (const path of layout.cleanupPaths) {
        await expect(access(path)).rejects.toBeDefined();
      }
      const summary = {
        runtime_version: version,
        duration_ms: Date.now() - startedAt,
        request_count: requestRecords.length,
        notification_count: sumCounts(notificationCounts),
        observer_count: sumCounts(observerCounts),
        durable_publication_count: sumCounts(publicationCounts),
        durable_publication_sessions: publicationCounts.size,
        turn_start_count: requestRecords.filter((request) => request.method === "turn/start").length,
        compact_start_count: requestRecords.filter((request) => request.method === "thread/compact/start").length,
        server_request_count: serverRequestMethods.length,
        proof_count: proof.length,
        proof_source_count: new Set(proof.map((entry) => entry.source)).size,
        sandbox: "approved_side_effect_observed",
        tui: "passed",
        cleanup: "passed"
      } as const;
      if (reportPath !== null && hostdeckCommit !== null) {
        const reportInput = {
          observed_at: new Date().toISOString(),
          hostdeck_commit: hostdeckCommit,
          duration_ms: summary.duration_ms,
          request_count: summary.request_count,
          notification_count: summary.notification_count,
          observer_count: summary.observer_count,
          durable_publication_count: summary.durable_publication_count
        };
        if (hostTarget === "windows-x64") {
          publishWindowsStructuredVerticalReport(
            reportPath,
            createWindowsStructuredVerticalReport(reportInput)
          );
        } else {
          publishStructuredVerticalReport(
            reportPath,
            createStructuredVerticalReport(reportInput)
          );
        }
      }
      process.stdout.write(`[structured-vertical-summary] ${JSON.stringify(summary)}\n`);
    },
    overallTimeoutMs
  );
});

function resolveStructuredVerticalReportPath(
  target: "linux-x64" | "windows-x64"
): string | null {
  const candidate = process.env.HOSTDECK_CODEX_VERTICAL_REPORT;
  if (candidate === undefined) return null;
  return target === "windows-x64"
    ? requireWindowsStructuredVerticalReportPath(candidate, tmpdir())
    : requireStructuredVerticalReportPath(candidate, tmpdir());
}

function requireExactCodexBinary(
  candidate: string | undefined,
  target: "linux-x64" | "windows-x64"
): string {
  if (
    (target === "linux-x64" &&
      (process.platform !== "linux" || process.arch !== "x64")) ||
    (target === "windows-x64" &&
      (process.platform !== "win32" || process.arch !== "x64"))
  ) {
    throw new TypeError("Structured vertical target does not match this host.");
  }
  if (candidate === undefined || !isAbsolute(candidate)) {
    throw new TypeError(
      "Structured vertical requires an absolute Codex binary."
    );
  }
  const path = resolve(candidate);
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(path);
    accessSync(path, constants.X_OK);
  } catch {
    throw new TypeError("Structured vertical Codex binary is unavailable.");
  }
  if (
    realpathSync(path) !== path ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    (target === "windows-x64" && !path.toLowerCase().endsWith(".exe"))
  ) {
    throw new TypeError("Structured vertical Codex binary is insecure.");
  }
  const version = parseCodexCliVersionOutput(
    execFileSync(path, ["--version"], {
      cwd: dirname(path),
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1_024
    })
  );
  if (version !== codexBindingDescriptor.codex_version) {
    throw new TypeError("Structured vertical Codex version is unsupported.");
  }
  return path;
}

function currentCleanCommit(repositoryRoot: string): string {
  const status = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 256 * 1_024
    }
  ).trim();
  if (status !== "") {
    throw new Error("Structured vertical report requires a clean worktree.");
  }
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1_024
  }).trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error("Structured vertical commit is invalid.");
  }
  return commit;
}

function requestRecordingPort(
  connection: CodexRuntimeReconnectController,
  records: Array<{ readonly method: string; readonly params: unknown }>
) {
  return {
    get compatibility() {
      return connection.compatibility;
    },
    get generation() {
      return connection.generation;
    },
    request(input: CodexRequestInput) {
      if (records.length >= 256) throw new Error("Structured vertical exceeded its request-record ceiling.");
      records.push({ method: input.method, params: input.params });
      return connection.request(input);
    }
  };
}

async function proveUnsupportedSkillsPolicy(
  connection: CodexRuntimeReconnectController,
  cwd: string
): Promise<void> {
  const compatibility: RuntimeCompatibility = {
    ...connection.compatibility,
    state: "degraded",
    capabilities: connection.compatibility.capabilities.map((capability) =>
      capability.name === "skills"
        ? { ...capability, state: "unavailable", reason: "aggregate policy simulation" }
        : capability
    )
  };
  let requests = 0;
  const client = createCodexSkillsClient({
    compatibility,
    generation: connection.generation,
    async request() {
      requests += 1;
      throw new Error("Unsupported policy simulation reached the wire.");
    }
  });
  await expect(client.listForCwd({ cwd })).rejects.toMatchObject({ code: "unsupported_method" });
  expect(requests).toBe(0);
}

async function createManagedThread(
  threads: ReturnType<typeof createCodexThreadClient>,
  cwd: string,
  suffix: "a" | "b"
): Promise<CodexThreadId> {
  const operationId = `op_vertical_thread_${suffix}_0001`;
  const started = await threads.start({ operation_id: operationId, cwd });
  await threads.ensureMaterialized({
    thread_id: started.thread.id,
    operation_id: operationId,
    cwd,
    name: `hostdeck-vertical-${suffix}`
  });
  return started.thread.id;
}

function selectedState(
  target: ManagedSessionTarget,
  cwd: string,
  runtimeVersion: string,
  at: string
) {
  const mapping = selectedSessionMappingRecordSchema.parse({
    id: target.session_id,
    name: target.session_id.replace(/^sess_/u, ""),
    codex_thread_id: target.codex_thread_id,
    cwd,
    runtime_source: "codex_app_server",
    runtime_version: runtimeVersion,
    disposition: "selected",
    created_at: at,
    updated_at: at,
    archived_at: null
  });
  return {
    mapping,
    projection: selectedSessionProjectionRecordSchema.parse({
      session: {
        id: mapping.id,
        name: mapping.name,
        codex_thread_id: mapping.codex_thread_id,
        cwd: mapping.cwd,
        runtime_source: mapping.runtime_source,
        runtime_version: mapping.runtime_version,
        created_at: mapping.created_at,
        archived_at: null,
        session_state: "active",
        turn_state: "idle",
        attention: "none",
        freshness: "current",
        freshness_reason: null,
        updated_at: at,
        last_activity_at: null,
        branch: null,
        model: null,
        goal: null,
        recent_summary: "",
        last_event_cursor: null
      },
      retained_event_count: 0,
      retained_event_bytes: 0,
      earliest_retained_cursor: null,
      retention_boundary_cursor: null
    })
  };
}

function managedTarget(sessionId: string, threadId: string): ManagedSessionTarget {
  return { type: "managed_session", session_id: sessionId, codex_thread_id: threadId } as ManagedSessionTarget;
}

function turnTerminalEvidence(
  repository: SelectedStateRepository,
  sessionId: string,
  turnId: string
): StructuredVerticalTurnTerminalEvidence | null {
  const committedCursor = repository.require(sessionId).projection.session.last_event_cursor ?? 0;
  return readStructuredVerticalTurnTerminal(repository, sessionId, turnId, committedCursor);
}

function requireTurnTerminal(
  evidence: StructuredVerticalTurnTerminalEvidence | null,
  expected: StructuredVerticalTurnTerminalEvidence["state"],
  label: string
): asserts evidence is StructuredVerticalTurnTerminalEvidence {
  if (evidence === null) throw new Error(`${label} returned no terminal evidence.`);
  if (evidence.state !== expected) {
    throw new Error(
      `${label} reached ${evidence.state} instead of ${expected} (code=${evidence.error_code ?? "none"}, message=${evidence.error_message ?? "none"}).`
    );
  }
}

function turnStartRequestCountForThread(
  requests: readonly { readonly method: string; readonly params: unknown }[],
  threadId: string
): number {
  return requests.filter(
    (request) => request.method === "turn/start" && isRecord(request.params) && request.params.threadId === threadId
  ).length;
}

function prove(entries: ProofEntry[], claim: string, source: ProofSource): void {
  if (entries.length >= 32 || claim.length === 0 || claim.length > 96) {
    throw new Error("Structured vertical proof ledger exceeded its bound or received an invalid claim.");
  }
  entries.push(Object.freeze({ claim, source }));
}

async function flushCallbacks(
  tasks: ReadonlySet<Promise<unknown>>,
  readFailure: () => Error | null,
  readServerRequestFailure: () => Error | null,
  pipeline: CodexEventPipeline | null
): Promise<void> {
  await settleCallbacks(tasks);
  const failure = aggregateCallbackFailure(readFailure, readServerRequestFailure, pipeline);
  if (failure !== null) throw failure;
}

async function settleCallbacks(tasks: ReadonlySet<Promise<unknown>>): Promise<void> {
  while (tasks.size > 0) await Promise.allSettled([...tasks]);
}

function aggregateCallbackFailure(
  readFailure: () => Error | null,
  readServerRequestFailure: () => Error | null,
  pipeline: CodexEventPipeline | null
): Error | null {
  return readFailure() ?? readServerRequestFailure() ?? pipeline?.failure ?? null;
}

async function waitForValue<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs: number,
  timeoutMessage: () => string
): Promise<T> {
  const started = Date.now();
  while (true) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() - started > timeoutMs) throw new Error(timeoutMessage());
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  timeoutMessage: () => string
): Promise<void> {
  await waitForValue(async () => predicate(), Boolean, timeoutMs, timeoutMessage);
}

function monotonicWallClock(): () => string {
  let milliseconds = 0;
  return () => {
    milliseconds = Math.max(milliseconds, Date.now());
    return new Date(milliseconds).toISOString();
  };
}

function summarizeNotification(notification: CodexConnectionNotification): string {
  if (!isRecord(notification.params)) return notification.method;
  const item = isRecord(notification.params.item) ? notification.params.item : null;
  return `${notification.method}${item === null || typeof item.type !== "string" ? "" : `:${item.type}`}`;
}

function increment(counts: Map<string, number>, key: string): void {
  if (!counts.has(key) && counts.size >= 128) throw new Error("Structured vertical diagnostic key ceiling exceeded.");
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function summarizeCounts(counts: ReadonlyMap<string, number>): string {
  return [...counts.entries()]
    .slice(-32)
    .map(([key, count]) => `${key}:${count}`)
    .join("|") || "none";
}

function sumCounts(counts: ReadonlyMap<string, number>): number {
  return [...counts.values()].reduce((total, count) => total + count, 0);
}

function redactDiagnostic(value: string, sensitiveValues: readonly string[]): string {
  let redacted = value;
  for (const sensitive of sensitiveValues) {
    if (sensitive.length > 0) redacted = redacted.replaceAll(sensitive, "[redacted]");
  }
  return redacted;
}

async function startAndInspectTui(
  command: CodexPlatformTuiResumeCommand,
  credential: CodexProtectedEnvironmentCredentialSource | undefined,
  codexHome: string,
  projectDirectory: string,
  tmuxSocketPath: string
): Promise<TuiProbe> {
  if (command.target === "windows-x64") {
    if (credential === undefined) {
      throw new Error("Windows TUI resume credential is unavailable.");
    }
    return startAndInspectWindowsTui(
      command,
      credential,
      codexHome,
      projectDirectory
    );
  }
  if (credential !== undefined) {
    throw new Error("Linux TUI resume received unexpected credential authority.");
  }
  const threadId = command.args.at(-1);
  if (threadId === undefined) throw new Error("TUI resume command is missing its exact thread id.");
  const args = [...command.args.slice(0, -1), "--no-alt-screen", threadId];
  const shellCommand = [command.executable, ...args].map(shellQuote).join(" ");
  const environment = { ...process.env, CODEX_HOME: codexHome, TERM: "xterm-256color" };
  let output = "";
  let running = false;
  let tmuxServerPid: number | null = null;
  try {
    await runFile(
      "tmux",
      ["-S", tmuxSocketPath, "-f", "/dev/null", "new-session", "-d", "-x", "120", "-y", "40", "-s", "hostdeck-tui"],
      { cwd: projectDirectory, env: environment }
    );
    running = true;
    tmuxServerPid = parseProcessId(
      (
        await runFile(
          "tmux",
          ["-S", tmuxSocketPath, "display-message", "-p", "#{pid}"],
          { env: environment }
        )
      ).stdout,
      "tmux server"
    );
    assertTmuxServerIdentity(tmuxServerPid, tmuxSocketPath);
    await runFile("tmux", ["-S", tmuxSocketPath, "set-option", "-g", "remain-on-exit", "on"], { env: environment });
    await runFile(
      "tmux",
      ["-S", tmuxSocketPath, "respawn-pane", "-k", "-t", "hostdeck-tui:0.0", shellCommand],
      { cwd: projectDirectory, env: environment }
    );
    await waitFor(
      async () => {
        output = (
          await runFile("tmux", ["-S", tmuxSocketPath, "capture-pane", "-p", "-t", "hostdeck-tui:0.0", "-S", "-1000"], {
            env: environment
          })
        ).stdout;
        const pane = (
          await runFile(
            "tmux",
            ["-S", tmuxSocketPath, "display-message", "-p", "-t", "hostdeck-tui:0.0", "#{pane_dead} #{pane_dead_status}"],
            { env: environment }
          )
        ).stdout.trim();
        if (pane.startsWith("1 ")) throw new Error(`Codex TUI exited (${pane}).`);
        return output.includes("OpenAI Codex") && output.includes(basename(projectDirectory));
      },
      8_000,
      () => "TUI did not render the expected managed-thread view before timeout."
    );
    return {
      output,
      async close() {
        if (!running) return;
        if (tmuxServerPid === null) {
          throw new Error("Structured vertical tmux server identity is missing.");
        }
        await stopTuiTmuxServer(
          tmuxSocketPath,
          tmuxServerPid,
          environment
        );
        running = false;
      }
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (running) {
      const stopTmux =
        tmuxServerPid === null
          ? runFile("tmux", ["-S", tmuxSocketPath, "kill-server"], {
              env: environment
            }).then(() => undefined)
          : stopTuiTmuxServer(
              tmuxSocketPath,
              tmuxServerPid,
              environment
            );
      await collectCleanupError(stopTmux, cleanupErrors);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "Codex TUI inspection and cleanup failed.");
    }
    throw error;
  }
}

async function startAndInspectWindowsTui(
  command: Extract<CodexPlatformTuiResumeCommand, { readonly target: "windows-x64" }>,
  credential: CodexProtectedEnvironmentCredentialSource,
  codexHome: string,
  projectDirectory: string
): Promise<TuiProbe> {
  const token = credential.read(codexRemoteAuthEnvironmentVariable);
  if (token === undefined || !/^[A-Za-z0-9_-]{43,512}$/u.test(token)) {
    throw new Error("Windows TUI resume credential is unavailable.");
  }
  const threadId = command.args.at(-1);
  if (threadId === undefined) {
    throw new Error("Windows TUI resume command is missing its exact thread id.");
  }
  const args = [...command.args.slice(0, -1), "--no-alt-screen", threadId];
  const environment = {
    ...process.env,
    CODEX_HOME: codexHome,
    TERM: "xterm-256color",
    [codexRemoteAuthEnvironmentVariable]: token
  };
  const child = spawn(
    locateWinpty(),
    ["-Xallow-non-tty", "-Xplain", command.executable, ...args],
    {
      cwd: projectDirectory,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    }
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout = boundedOutput(stdout, chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = boundedOutput(stderr, chunk);
  });
  let running = true;
  try {
    await waitFor(
      () => {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error("Windows Codex TUI exited before rendering.");
        }
        const output = stripTerminalControl(`${stdout}\n${stderr}`);
        return (
          output.includes("OpenAI Codex") &&
          output.includes(basename(projectDirectory))
        );
      },
      15_000,
      () => "Windows Codex TUI did not render before timeout."
    );
    const spawnArguments = JSON.stringify(child.spawnargs);
    if (
      spawnArguments.includes(token) ||
      !spawnArguments.includes("--remote-auth-token-env") ||
      !spawnArguments.includes(codexRemoteAuthEnvironmentVariable)
    ) {
      throw new Error("Windows Codex TUI authority was not environment-only.");
    }
    const output = stripTerminalControl(`${stdout}\n${stderr}`);
    if (output.includes(token)) {
      throw new Error("Windows Codex TUI output contained credential material.");
    }
    return {
      output,
      async close() {
        if (!running) return;
        await stopWindowsProcessTree(child);
        running = false;
      }
    };
  } catch (error) {
    if (running) {
      await stopWindowsProcessTree(child).catch(() => undefined);
      running = false;
    }
    throw error;
  }
}

interface TuiProbe {
  readonly output: string;
  readonly close: () => Promise<void>;
}

async function stopTuiTmuxServer(
  socketPath: string,
  serverPid: number,
  environment: NodeJS.ProcessEnv
): Promise<void> {
  assertTmuxServerIdentity(serverPid, socketPath);
  await runFile("tmux", ["-S", socketPath, "kill-server"], {
    env: environment
  });
  await waitFor(
    () => !isProcessAlive(serverPid),
    5_000,
    () => "Structured vertical tmux server remained after owner teardown."
  );
}

function assertTmuxServerIdentity(serverPid: number, socketPath: string): void {
  if (!readBoundedProcessCommandLine(serverPid).includes(socketPath)) {
    throw new Error("Structured vertical tmux server identity is invalid.");
  }
}

function parseProcessId(candidate: string, label: string): number {
  const value = candidate.trim();
  if (!/^\d+$/u.test(value)) {
    throw new Error(`Structured vertical ${label} pid is invalid.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Structured vertical ${label} pid is invalid.`);
  }
  return parsed;
}

async function runFile(
  executable: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv }
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
      settled = true;
      reject(new Error(`${executable} timed out.`));
    }, 5_000);
    timeout.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = boundedOutput(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = boundedOutput(stderr, chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`Unable to start ${executable}.`, { cause: error }));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${executable} exited with ${code ?? signal ?? "unknown"}: ${stderr || stdout || "empty"}`));
    });
  });
}

async function waitForSocket(socketPath: string, child: ChildProcess, readStderr: () => string): Promise<void> {
  await waitFor(
    async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Codex app-server exited before creating its vertical-smoke socket: ${readStderr()}`);
      }
      try {
        return (await lstat(socketPath)).isSocket();
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        return false;
      }
    },
    5_000,
    () => `Codex app-server did not create its vertical-smoke socket: ${readStderr()}`
  );
}

async function verifyWindowsRuntimeCleanup(input: {
  readonly supervisor: ReturnType<
    typeof createCodexWindowsRuntimeSupervisor
  > | null;
  readonly children: readonly CodexWindowsRuntimeChildProcess[];
  readonly ports: readonly number[];
  readonly endpointPath: string;
}): Promise<void> {
  if (
    input.supervisor === null ||
    input.children.length !== 2 ||
    input.ports.length !== 2 ||
    new Set(input.ports).size !== 2
  ) {
    throw new Error("Windows structured vertical cleanup inventory is invalid.");
  }
  for (const port of input.ports) await waitForClosedWindowsPort(port);
  if (input.children.some((child) => child.isRunning())) {
    throw new Error("Windows structured vertical retained an owned app-server.");
  }
  expect(input.supervisor.snapshot()).toMatchObject({
    phase: "closed",
    endpoint_ready: false,
    credential_file_present: false,
    claim_held: false,
    process_state: "exited"
  });
  expect(lstatSync(input.endpointPath).size).toBe(0);
  expect(
    existsSync(codexWindowsRuntimeCredentialPath(input.endpointPath))
  ).toBe(false);
}

async function waitForClosedWindowsPort(port: number): Promise<void> {
  const { createConnection } = await import("node:net");
  await waitFor(
    () =>
      new Promise<boolean>((resolveClosed) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        const timeout = setTimeout(() => {
          socket.destroy();
          resolveClosed(false);
        }, 250);
        socket.once("connect", () => {
          clearTimeout(timeout);
          socket.destroy();
          resolveClosed(false);
        });
        socket.once("error", () => {
          clearTimeout(timeout);
          resolveClosed(true);
        });
      }),
    5_000,
    () => "Windows Codex app-server listener remained after cleanup."
  );
}

function windowsEndpointPort(address: string): number {
  const parsed = /^ws:\/\/127\.0\.0\.1:([1-9][0-9]{3,4})$/u.exec(address);
  const port = parsed === null ? Number.NaN : Number(parsed[1]);
  if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error("Windows Codex app-server endpoint port is invalid.");
  }
  return port;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").then(() => undefined);
  child.kill("SIGTERM");
  if (await settlesWithin(exited, 2_000)) return;
  child.kill("SIGKILL");
  if (!(await settlesWithin(exited, 1_000))) throw new Error("Codex vertical-smoke app-server did not exit after SIGKILL.");
}

async function stopWindowsProcessTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!Number.isSafeInteger(child.pid) || (child.pid ?? 0) < 1) {
    throw new Error("Windows Codex TUI process identity is unavailable.");
  }
  const exited = once(child, "exit").then(() => undefined);
  const result = spawnSync(
    "taskkill.exe",
    ["/PID", String(child.pid), "/T", "/F"],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1_024,
      shell: false,
      timeout: 10_000,
      windowsHide: true
    }
  );
  if (
    result.error !== undefined ||
    result.signal !== null ||
    (result.status !== 0 && child.exitCode === null && child.signalCode === null)
  ) {
    if (await settlesWithin(exited, 500)) return;
    throw new Error("Windows Codex TUI process tree could not be terminated.");
  }
  if (!(await settlesWithin(exited, 5_000))) {
    throw new Error("Windows Codex TUI process tree remained after termination.");
  }
}

function locateWinpty(): string {
  const candidates = [
    "C:\\Program Files\\Git\\usr\\bin\\winpty.exe",
    "C:\\Program Files\\Git\\mingw64\\bin\\winpty.exe"
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && lstatSync(candidate).isFile()) {
      return realpathSync(candidate);
    }
  }
  throw new Error("Windows Codex TUI requires the reviewed winpty harness.");
}

function stripTerminalControl(value: string): string {
  const ansiEscapePattern = new RegExp(
    `${String.fromCharCode(27)}\\[[0-9;]*m`,
    "gu"
  );
  return value
    .replaceAll(ansiEscapePattern, "")
    .replaceAll("\r", "");
}

async function settlesWithin(promise: Promise<void>, milliseconds: number): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  const expired = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), milliseconds);
    timeout.unref();
  });
  const settled = await Promise.race([promise.then(() => true as const), expired]);
  if (timeout !== undefined) clearTimeout(timeout);
  return settled;
}

interface StructuredVerticalLayout {
  readonly root: string;
  readonly runtimeDirectory: string;
  readonly codexHome: string;
  readonly projectA: string;
  readonly projectB: string;
  readonly databasePath: string;
  readonly markerPath: string;
  readonly appEndpointPath: string;
  readonly tuiSocketPath: string;
  readonly cleanupPaths: readonly string[];
  readonly cleanup: () => Promise<void>;
}

async function createStructuredVerticalLayout(
  target: "linux-x64" | "windows-x64"
): Promise<StructuredVerticalLayout> {
  if (target === "linux-x64") {
    const root = await mkdtemp(join(tmpdir(), "hostdeck-vertical-smoke-"));
    const runtimeDirectory = join(root, "runtime");
    const codexHome = join(root, "codex-home");
    const projectA = join(root, "project-a");
    const projectB = join(root, "project-b");
    await Promise.all([
      mkdir(runtimeDirectory, { mode: 0o700 }),
      mkdir(codexHome, { mode: 0o700 }),
      mkdir(projectA, { mode: 0o700 }),
      mkdir(projectB, { mode: 0o700 })
    ]);
    return Object.freeze({
      root,
      runtimeDirectory,
      codexHome,
      projectA,
      projectB,
      databasePath: join(root, "hostdeck.sqlite"),
      markerPath: join(root, "approved-marker"),
      appEndpointPath: join(runtimeDirectory, "app.sock"),
      tuiSocketPath: join(runtimeDirectory, "tui.sock"),
      cleanupPaths: Object.freeze([root]),
      cleanup: () => rm(root, { recursive: true, force: true })
    });
  }

  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("Windows structured vertical requires native Windows x64.");
  }
  const defaults = resolveNativeWindowsHostDeckDefaultPaths();
  const suffix = `Vertical-${process.pid}-${Date.now()}`;
  const paths = prepareHostDeckLocalPaths({
    config_dir: win32.join(defaults.config_dir, suffix),
    state_dir: win32.join(defaults.state_dir, suffix),
    runtime_dir: win32.join(defaults.runtime_dir, suffix),
    database_path: win32.join(defaults.state_dir, suffix, "hostdeck.sqlite")
  });
  const projectA = win32.join(paths.state_dir, "project-a");
  const projectB = win32.join(paths.state_dir, "project-b");
  await Promise.all([
    mkdir(projectA, { mode: 0o700 }),
    mkdir(projectB, { mode: 0o700 })
  ]);
  const cleanupPaths = Object.freeze([
    paths.config_dir,
    paths.state_dir,
    paths.runtime_dir
  ]);
  return Object.freeze({
    root: paths.state_dir,
    runtimeDirectory: paths.runtime_dir,
    codexHome: paths.config_dir,
    projectA,
    projectB,
    databasePath: paths.database_path,
    markerPath: win32.join(paths.state_dir, "approved-marker"),
    appEndpointPath: win32.join(paths.runtime_dir, "app-server.endpoint"),
    tuiSocketPath: win32.join(paths.runtime_dir, "unused-tui.sock"),
    cleanupPaths,
    async cleanup() {
      const failures: unknown[] = [];
      for (const path of cleanupPaths) {
        await collectCleanupError(
          rm(path, { recursive: true, force: true }),
          failures
        );
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "Windows structured vertical temporary paths were not removed."
        );
      }
    }
  });
}

async function seedCodexAuthentication(codexHome: string): Promise<void> {
  const sourceHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const source = join(sourceHome, "auth.json");
  const sourceMetadata = await lstat(source);
  if (
    !sourceMetadata.isFile() ||
    sourceMetadata.isSymbolicLink() ||
    sourceMetadata.nlink !== 1 ||
    (process.platform !== "win32" && (sourceMetadata.mode & 0o077) !== 0)
  ) {
    throw new Error("Installed Codex authentication must be a private regular auth.json file for the vertical smoke.");
  }
  const destination = join(codexHome, "auth.json");
  await copyFile(source, destination);
  if (process.platform === "win32") {
    secureHostDeckRegularFile(destination, {
      label: "Structured vertical Codex authentication",
      mode: 0o600,
      repair_mode: true
    });
  } else {
    await chmod(destination, 0o600);
  }
  const destinationMetadata = await lstat(destination);
  if (
    !destinationMetadata.isFile() ||
    destinationMetadata.isSymbolicLink() ||
    destinationMetadata.nlink !== 1 ||
    (process.platform !== "win32" && (destinationMetadata.mode & 0o077) !== 0)
  ) {
    throw new Error("Temporary Codex authentication copy is not private.");
  }
}

async function seedCodexConfiguration(codexHome: string): Promise<void> {
  const destination = join(codexHome, "config.toml");
  await writeFile(
    destination,
    [
      "check_for_update_on_startup = false",
      'sandbox_mode = "read-only"',
      'approval_policy = "on-request"',
      "[features]",
      "goals = true",
      "plugins = false",
      ""
    ].join("\n"),
    { encoding: "utf8", flag: "wx", mode: 0o600 }
  );
  if (process.platform === "win32") {
    secureHostDeckRegularFile(destination, {
      label: "Structured vertical Codex configuration",
      mode: 0o600,
      repair_mode: true
    });
  } else {
    await chmod(destination, 0o600);
  }
}

function approvalCommand(
  markerPath: string,
  target: "linux-x64" | "windows-x64"
): string {
  if (target === "linux-x64") {
    return `\`touch ${shellQuote(markerPath)}\``;
  }
  const escaped = markerPath.replaceAll("'", "''");
  return `\`[System.IO.File]::WriteAllText('${escaped}', 'approved')\``;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function boundedOutput(current: string, chunk: Buffer): string {
  return `${current}${chunk.toString("utf8")}`.slice(-32_000);
}

async function collectCleanupError(operation: Promise<unknown>, errors: unknown[]): Promise<void> {
  try {
    await operation;
  } catch (error) {
    errors.push(error);
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
