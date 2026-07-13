import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  buildCodexTuiResumeCommand,
  type CodexAppServerConnection,
  type CodexConnectionNotification,
  type CodexProtocolIssue,
  type CodexRequestInput,
  codexBindingDescriptor,
  createCodexApprovalClient,
  createCodexAppServerConnection,
  createCodexCompactClient,
  createCodexGoalClient,
  createCodexModelClient,
  createCodexPlanClient,
  createCodexSkillsClient,
  createCodexThreadClient,
  createCodexTurnClient,
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
import type { CodexThreadId } from "@hostdeck/core";
import {
  createProductionProjectionAppendPort,
  createSelectedStateRepository,
  openMigratedDatabase,
  type SelectedStateRepository
} from "@hostdeck/storage";
import { describe, expect, it } from "vitest";
import {
  type CodexApprovalControlService,
  createCodexApprovalControlService
} from "./codex-approval-control-service.js";
import { createCodexCompactControlService } from "./codex-compact-control-service.js";
import { createCodexControlEventObserver } from "./codex-control-event-observer.js";
import { type CodexEventPipeline, createCodexEventPipeline } from "./codex-event-pipeline.js";
import { createCodexGoalControlService } from "./codex-goal-control-service.js";
import { createCodexInterruptControlService } from "./codex-interrupt-control-service.js";
import { createCodexModelControlService } from "./codex-model-control-service.js";
import { createCodexPlanControlService } from "./codex-plan-control-service.js";
import { createCodexPromptControlService } from "./codex-prompt-control-service.js";
import { createCodexSkillsControlService } from "./codex-skills-control-service.js";
import {
  readStructuredVerticalTurnTerminal,
  type StructuredVerticalTurnTerminalEvidence
} from "./codex-structured-vertical-evidence.js";
import { selectStructuredVerticalPlanModel } from "./codex-structured-vertical-selection.js";
import { createCodexUsageControlService } from "./codex-usage-control-service.js";
import { combinePendingTurnSettingsReaders } from "./pending-turn-settings.js";

const requireSmoke = process.env.HOSTDECK_REQUIRE_CODEX_VERTICAL_SMOKE === "1";
const codexBin = process.env.HOSTDECK_CODEX_BIN ?? "codex";
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
      const version = parseCodexCliVersionOutput(
        execFileSync(codexBin, ["--version"], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 })
      );
      expect(version).toBe(codexBindingDescriptor.codex_version);

      const root = await mkdtemp(join(tmpdir(), "hostdeck-vertical-smoke-"));
      const runtimeDirectory = join(root, "runtime");
      const codexHome = join(root, "codex-home");
      const projectA = join(root, "project-a");
      const projectB = join(root, "project-b");
      const databasePath = join(root, "hostdeck.sqlite");
      const markerPath = join(root, "approved-marker");
      const approvalPrompt =
        `Use the shell tool exactly once to run \`touch ${shellQuote(markerPath)}\` with elevated permission. ` +
        "Request approval, do not use file-editing tools, and do nothing else.";
      const appSocketPath = join(runtimeDirectory, "app.sock");
      const tuiSocketPath = join(runtimeDirectory, "tui.sock");
      await Promise.all([
        mkdir(runtimeDirectory, { mode: 0o700 }),
        mkdir(codexHome, { mode: 0o700 }),
        mkdir(projectA, { mode: 0o700 }),
        mkdir(projectB, { mode: 0o700 })
      ]);
      try {
        await seedCodexAuthentication(codexHome);
        execFileSync("git", ["init", "-q", "-b", "main", projectA], { timeout: 10_000 });
        execFileSync("git", ["init", "-q", "-b", "main", projectB], { timeout: 10_000 });
      } catch (error) {
        await rm(root, { recursive: true, force: true });
        throw error;
      }

      const child = spawn(
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
          `unix://${appSocketPath}`
        ],
        {
          cwd: projectA,
          env: { ...process.env, CODEX_HOME: codexHome },
          stdio: ["ignore", "ignore", "pipe"]
        }
      );
      let appServerStderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        appServerStderr = boundedOutput(appServerStderr, chunk);
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
      let pipeline: CodexEventPipeline | null = null;
      let callbackMode: "buffering" | "live" = "buffering";
      let approvals: CodexApprovalControlService | null = null;
      let tui: TuiProbe | null = null;
      const threadIds: CodexThreadId[] = [];
      const compactProgressEvidence: string[] = [];
      let openDatabase: ReturnType<typeof openMigratedDatabase> | null = null;

      const consumeThroughPipeline = (message: CodexConnectionNotification, generation: number): void => {
        if (pipeline === null) {
          callbackFailure ??= new Error("Codex callback entered live mode before pipeline construction.");
          return;
        }
        const operation = pipeline.consume(message, generation);
        callbackTasks.add(operation);
        void operation
          .catch((error: unknown) => {
            callbackFailure ??= asError(error);
          })
          .finally(() => callbackTasks.delete(operation));
      };

      const connection = createCodexAppServerConnection({
        transport: createCodexUnixWebSocketTransport({ socket_path: appSocketPath }),
        observed_version: version,
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
        on_protocol_issue: (issue) => protocolIssues.push(issue)
      });

      let smokeError: Error | null = null;
      try {
        await waitForSocket(appSocketPath, child, () => appServerStderr);
        expect((await lstat(runtimeDirectory)).mode & 0o077).toBe(0);
        await connection.connect();
        expectedGeneration = connection.generation;
        expect(expectedGeneration).toBeGreaterThan(0);
        prove(proof, "exact runtime connected", "request_response");

        openDatabase = openMigratedDatabase(databasePath, { now: () => new Date() });
        const repository = createSelectedStateRepository(openDatabase.db);
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

        const modelControl = createCodexModelControlService({
          models: createCodexModelClient(port),
          states: repository
        });
        const planControl = createCodexPlanControlService({
          plans: createCodexPlanClient(port),
          models: modelControl,
          states: repository
        });
        const pendingSettings = combinePendingTurnSettingsReaders([modelControl, planControl]);
        const goalControl = createCodexGoalControlService({
          goals: createCodexGoalClient(port),
          states: repository,
          pending_settings: pendingSettings
        });
        const turnClient = createCodexTurnClient(port);
        const promptControl = createCodexPromptControlService({
          turns: turnClient,
          models: modelControl,
          plans: planControl,
          states: repository
        });
        const usageControl = createCodexUsageControlService({
          usage: createCodexUsageClient(port),
          states: repository
        });
        const compactControl = createCodexCompactControlService({
          compact: createCodexCompactClient(port),
          states: repository
        });
        const skillsControl = createCodexSkillsControlService({
          skills: createCodexSkillsClient(port),
          states: repository
        });
        approvals = createCodexApprovalControlService({
          approvals: createCodexApprovalClient(connection),
          states: repository,
          expiry_ms: 30_000,
          on_background_error: (error) => backgroundErrors.push(error)
        });
        const interruptControl = createCodexInterruptControlService({ turns: turnClient, states: repository });
        const controlObserver = createCodexControlEventObserver({
          plans: planControl,
          goals: goalControl,
          compact: compactControl,
          usage: usageControl,
          approvals,
          interrupts: interruptControl,
          prompts: promptControl
        });
        const eventClock = monotonicWallClock();
        pipeline = createCodexEventPipeline({
          repository,
          append_port: createProductionProjectionAppendPort({
            repository,
            publish(committed) {
              const durable = repository.require(committed.event.event.session_id);
              expect(durable.projection).toEqual(committed.projection);
              increment(publicationCounts, committed.event.event.session_id);
            }
          }),
          normalizer: { now: eventClock },
          async observe_event(event, generation) {
            const receipt = await controlObserver.observe(event, generation);
            increment(observerCounts, receipt.method);
            if (
              "thread_id" in event &&
              event.thread_id === targetA.codex_thread_id &&
              ["turn/started", "item/started", "item/completed", "turn/completed"].includes(event.method)
            ) {
              const progress = await compactControl.snapshot(targetA);
              if (progress !== null) compactProgressEvidence.push(`${event.method}:${progress.state}`);
            }
          }
        });
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

        const tuiCommand = buildCodexTuiResumeCommand({
          socket_path: appSocketPath,
          thread_id: threadB,
          codex_bin: codexBin
        });
        tui = await startAndInspectTui(tuiCommand, codexHome, projectB, tuiSocketPath);
        expect(tui.output).toContain("OpenAI Codex");
        expect(tui.output).toContain(basename(projectB));
        await tui.close();
        tui = null;
        await flushCallbacks(callbackTasks, () => callbackFailure, () => serverRequestFailure, pipeline);
        expect(connection.state).toBe("ready");
        expect(connection.generation).toBe(expectedGeneration);
        await expect(threads.read(threadB)).resolves.toMatchObject({ id: threadB, status: "idle" });
        prove(proof, "TUI shared thread while HostDeck remained connected", "tui_inspection");

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
          appSocketPath,
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
      if (connection.state === "ready" && threadIds.length > 0) {
        const threads = createCodexThreadClient(connection);
        for (const threadId of [...threadIds]) await collectCleanupError(threads.archive(threadId), cleanupErrors);
      }
      await collectCleanupError(connection.close("HostDeck structured vertical smoke completed."), cleanupErrors);
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
      if (approvals !== null) {
        try {
          approvals.close();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      await collectCleanupError(stopChild(child), cleanupErrors);
      if (openDatabase !== null) {
        try {
          openDatabase.db.close();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      await collectCleanupError(rm(root, { recursive: true, force: true }), cleanupErrors);
      if (smokeError !== null && cleanupErrors.length > 0) {
        throw new AggregateError([smokeError, ...cleanupErrors], "Codex structured vertical and cleanup failed.");
      }
      if (smokeError !== null) throw smokeError;
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Codex structured vertical cleanup failed.");
      process.stdout.write(
        `[structured-vertical-summary] ${JSON.stringify({
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
        })}\n`
      );
    },
    overallTimeoutMs
  );
});

function requestRecordingPort(
  connection: CodexAppServerConnection,
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

async function proveUnsupportedSkillsPolicy(connection: CodexAppServerConnection, cwd: string): Promise<void> {
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
  command: ReturnType<typeof buildCodexTuiResumeCommand>,
  codexHome: string,
  projectDirectory: string,
  tmuxSocketPath: string
): Promise<TuiProbe> {
  const threadId = command.args.at(-1);
  if (threadId === undefined) throw new Error("TUI resume command is missing its exact thread id.");
  const args = [...command.args.slice(0, -1), "--no-alt-screen", threadId];
  const shellCommand = [command.executable, ...args].map(shellQuote).join(" ");
  const environment = { ...process.env, CODEX_HOME: codexHome, TERM: "xterm-256color" };
  let output = "";
  let running = false;
  try {
    await runFile(
      "tmux",
      ["-S", tmuxSocketPath, "-f", "/dev/null", "new-session", "-d", "-x", "120", "-y", "40", "-s", "hostdeck-tui"],
      { cwd: projectDirectory, env: environment }
    );
    running = true;
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
        await runFile("tmux", ["-S", tmuxSocketPath, "kill-server"], { env: environment });
        running = false;
      }
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (running) {
      await collectCleanupError(
        runFile("tmux", ["-S", tmuxSocketPath, "kill-server"], { env: environment }),
        cleanupErrors
      );
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "Codex TUI inspection and cleanup failed.");
    }
    throw error;
  }
}

interface TuiProbe {
  readonly output: string;
  readonly close: () => Promise<void>;
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

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").then(() => undefined);
  child.kill("SIGTERM");
  if (await settlesWithin(exited, 2_000)) return;
  child.kill("SIGKILL");
  if (!(await settlesWithin(exited, 1_000))) throw new Error("Codex vertical-smoke app-server did not exit after SIGKILL.");
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

async function seedCodexAuthentication(codexHome: string): Promise<void> {
  const sourceHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const source = join(sourceHome, "auth.json");
  const sourceMetadata = await lstat(source);
  if (!sourceMetadata.isFile() || (sourceMetadata.mode & 0o077) !== 0) {
    throw new Error("Installed Codex authentication must be a private regular auth.json file for the vertical smoke.");
  }
  const destination = join(codexHome, "auth.json");
  await copyFile(source, destination);
  await chmod(destination, 0o600);
  const destinationMetadata = await lstat(destination);
  if (!destinationMetadata.isFile() || (destinationMetadata.mode & 0o077) !== 0) {
    throw new Error("Temporary Codex authentication copy is not private.");
  }
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
