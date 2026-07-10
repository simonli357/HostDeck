import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { codexBindingDescriptor } from "./binding.js";
import {
  type CodexSemanticRecordingTransport,
  createCodexSemanticRecordingTransport
} from "./codex-operation-semantics.smoke-support.js";
import { parseCodexCliVersionOutput } from "./compatibility.js";
import type { CodexConnectionNotification, CodexConnectionServerRequest } from "./connection.js";
import { createCodexAppServerConnection } from "./connection.js";
import { HostDeckCodexAdapterError } from "./errors.js";
import { type CodexThreadClient, createCodexThreadClient } from "./thread-client.js";
import { createCodexUnixWebSocketTransport } from "./transport.js";
import { buildCodexTuiResumeCommand } from "./tui-resume.js";

const requireSmoke = process.env.HOSTDECK_REQUIRE_CODEX_SEMANTICS_SMOKE === "1";
const codexBin = process.env.HOSTDECK_CODEX_BIN ?? "codex";
const defaultReportPath = resolve("artifacts/int-v1-006-codex-operation-observation.json");
const reportPath = resolve(process.env.HOSTDECK_CODEX_SEMANTICS_REPORT ?? defaultReportPath);
const probeMode = process.env.HOSTDECK_CODEX_SEMANTICS_MODE === "control" ? "control" : "full";

const probeLimits = Object.freeze({
  model_turns: probeMode === "control" ? 1 : 4,
  compactions: 1,
  live_operations_ms: 180_000,
  test_with_cleanup_ms: 240_000,
  request_ms: 30_000,
  event_ms: 45_000,
  trace_timeline_entries: 512,
  notifications: 4_096,
  server_requests: 16,
  protocol_issues: 128
});

describe.skipIf(!requireSmoke)("installed Codex exact operation semantics smoke", () => {
  it(
    "records a bounded redacted two-thread turn/control/approval/disconnect matrix",
    async () => {
      assertReportPath(reportPath);
      const observedAt = new Date().toISOString();
      const hostdeckCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 64 * 1024
      }).trim();
      const version = parseCodexCliVersionOutput(
        execFileSync(codexBin, ["--version"], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 })
      );
      expect(version).toBe(codexBindingDescriptor.codex_version);

      const root = await mkdtemp(join(tmpdir(), "hostdeck-codex-semantics-"));
      const runtimeDirectory = join(root, "runtime");
      const codexHome = join(root, "codex-home");
      const projectA = join(root, "project-a");
      const projectB = join(root, "project-b");
      const socketPath = join(runtimeDirectory, "app.sock");
      const tuiSocketPath = join(runtimeDirectory, "tui-tmux.sock");
      const approvedMarker = join(projectB, "approved-marker");
      const deniedMarker = join(projectB, "denied-marker");
      const deadlineAt = Date.now() + probeLimits.live_operations_ms;
      const operations: OperationEvidence[] = [];
      const cleanup: CleanupEvidence = {
        active_turn_interrupts_attempted: 0,
        active_turns_already_terminal: 0,
        threads_archived: 0,
        tui_stopped: false,
        connection_closed: false,
        recorder_disposed: false,
        app_server_stopped: false,
        temporary_root_removed: false
      };
      let currentStage = "isolation_setup";
      let failureStage = currentStage;
      let operationsFinishedAt = Date.now();
      let primaryError: unknown = null;
      let child: ChildProcess | null = null;
      let connection: ReturnType<typeof createCodexAppServerConnection> | null = null;
      let threads: CodexThreadClient | null = null;
      let recording: CodexSemanticRecordingTransport | null = null;
      let tui: TuiProbe | null = null;
      let appServerStderr = "";
      let modelTurnsStarted = 0;
      let compactionsStarted = 0;
      const managedThreads: string[] = [];
      const activeTurns = new Map<string, string>();
      const log = new InboundObservationLog();
      const runFacts: RunFacts = {
        two_distinct_threads: false,
        separate_repositories: false,
        requested_model_was_non_default: false,
        model_override_read_back: false,
        turn_model_override_read_back: false,
        plan_mode_observed: false,
        default_mode_after_plan_observed: false,
        approval_declined_once: false,
        approval_accepted_once: false,
        duplicate_approval_rejected_locally: false,
        approved_side_effect_present: false,
        denied_side_effect_absent: false,
        tui_and_hostdeck_concurrent: false,
        reconnect_generation_advanced: false,
        interrupted_not_archived: false,
        second_thread_unchanged_by_thread_a_turn: false,
        compact_context_item_observed: false,
        compact_completed_within_observation: false
      };
      const usage: UsageEvidence = {
        account_usage_before_shape: "not_attempted",
        account_usage_after_shape: "not_attempted",
        thread_a_total_tokens: null,
        thread_b_total_tokens: null,
        goal_tokens_used: null,
        monetary_cost: null,
        monetary_cost_source: "not_exposed_by_app_server"
      };

      try {
        await Promise.all([
          mkdir(runtimeDirectory, { mode: 0o700 }),
          mkdir(codexHome, { mode: 0o700 }),
          mkdir(projectA, { mode: 0o700 }),
          mkdir(projectB, { mode: 0o700 })
        ]);
        await seedCodexAuthentication(codexHome);
        for (const project of [projectA, projectB]) {
          execFileSync("git", ["init", "-q", "-b", "main", project], { timeout: 10_000 });
          await writeFile(join(project, "README.md"), "# Isolated HostDeck semantic probe\n", { mode: 0o600 });
        }
        expect((await stat(runtimeDirectory)).mode & 0o077).toBe(0);
        expect((await stat(codexHome)).mode & 0o077).toBe(0);

        currentStage = "app_server_start";
        child = spawn(codexBin, ["app-server", "--listen", `unix://${socketPath}`], {
          env: { ...process.env, CODEX_HOME: codexHome },
          stdio: ["ignore", "ignore", "pipe"]
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          appServerStderr = boundedOutput(appServerStderr, chunk);
        });
        await waitForSocket(socketPath, child, deadlineAt);
        expect((await lstat(socketPath)).isSocket()).toBe(true);

        currentStage = "connection_handshake";
        recording = createCodexSemanticRecordingTransport(
          createCodexUnixWebSocketTransport({ socket_path: socketPath }),
          { timeline_limit: probeLimits.trace_timeline_entries }
        );
        connection = createCodexAppServerConnection({
          transport: recording.transport,
          observed_version: version,
          on_notification: (message) => log.addNotification(message),
          on_server_request: (message) => log.addServerRequest(message),
          on_protocol_issue: (issue) => log.addProtocolIssue(issue)
        });
        await connection.connect(deadlineSignal(deadlineAt));
        expect(connection.state).toBe("ready");
        threads = createCodexThreadClient(connection);

        currentStage = "managed_thread_setup";
        const setupMark = log.mark();
        const startedA = await threads.start({ operation_id: "op_semantics_thread_a", cwd: projectA });
        managedThreads.push(startedA.thread.id);
        await threads.ensureMaterialized({
          thread_id: startedA.thread.id,
          operation_id: "op_semantics_thread_a",
          cwd: projectA,
          name: "hostdeck-semantics-a"
        });
        const startedB = await threads.start({ operation_id: "op_semantics_thread_b", cwd: projectB });
        managedThreads.push(startedB.thread.id);
        await threads.ensureMaterialized({
          thread_id: startedB.thread.id,
          operation_id: "op_semantics_thread_b",
          cwd: projectB,
          name: "hostdeck-semantics-b"
        });
        expect(startedA.thread.id).not.toBe(startedB.thread.id);
        expect((await threads.read(startedA.thread.id)).cwd).toBe(projectA);
        expect((await threads.read(startedB.thread.id)).cwd).toBe(projectB);
        runFacts.two_distinct_threads = true;
        runFacts.separate_repositories = true;
        operations.push(
          operationEvidence("managed_threads", "thread/start + thread/read", "both", "supported", log.summarySince(setupMark), {
            thread_count: 2,
            distinct_ids: true,
            distinct_cwds: true,
            content_retained: false
          })
        );

        currentStage = "structured_catalog_reads";
        const modelMark = log.mark();
        const modelList = requireRecord(
          await request(connection, "model/list", { cursor: null, limit: 100, includeHidden: false }, "read", deadlineAt),
          "model/list result"
        );
        const models = requireRecordArray(modelList.data, "model/list data");
        expect(models.length).toBeGreaterThan(0);
        const visibleModels = models.filter((model) => model.hidden === false);
        expect(visibleModels.length).toBeGreaterThan(0);
        const defaultModel = visibleModels.find((model) => model.isDefault === true) ?? visibleModels[0];
        const selectedModel = visibleModels.find((model) => model.isDefault === false) ?? defaultModel;
        const defaultModelName = requireString(defaultModel?.model, "default model name");
        const selectedModelName = requireString(selectedModel?.model, "selected model name");
        const selectedEffort = selectBoundedEffort(selectedModel);
        runFacts.requested_model_was_non_default = selectedModelName !== defaultModelName;
        operations.push(
          operationEvidence("model_catalog", "model/list", "runtime", "supported", log.summarySince(modelMark), {
            visible_models: visibleModels.length,
            hidden_models_requested: false,
            selected_role: runFacts.requested_model_was_non_default ? "non_default_visible" : "default_visible",
            selected_effort_role: selectedEffort === null ? "catalog_default" : selectedEffort
          })
        );

        const collaborationMark = log.mark();
        const collaborationResult = requireRecord(
          await request(connection, "collaborationMode/list", {}, "read", deadlineAt),
          "collaborationMode/list result"
        );
        const collaborationModes = requireRecordArray(collaborationResult.data, "collaborationMode/list data");
        const planMask = requireCollaborationMask(collaborationModes, "plan");
        const defaultMask = requireCollaborationMask(collaborationModes, "default");
        operations.push(
          operationEvidence(
            "collaboration_catalog",
            "collaborationMode/list",
            "runtime",
            "supported",
            log.summarySince(collaborationMark),
            { mode_count: collaborationModes.length, plan_present: true, default_present: true }
          )
        );

        const skillsMark = log.mark();
        const skillsResult = requireRecord(
          await request(connection, "skills/list", { cwds: [projectA, projectB], forceReload: true }, "read", deadlineAt),
          "skills/list result"
        );
        const skillsEntries = requireRecordArray(skillsResult.data, "skills/list data");
        expect(skillsEntries.length).toBe(2);
        const skillCount = skillsEntries.reduce((count, entry) => count + requireArray(entry.skills, "skills entry skills").length, 0);
        const skillErrorCount = skillsEntries.reduce(
          (count, entry) => count + requireArray(entry.errors, "skills entry errors").length,
          0
        );
        operations.push(
          operationEvidence("skills", "skills/list", "both_repositories", "supported", log.summarySince(skillsMark), {
            cwd_entries: skillsEntries.length,
            skill_count: skillCount,
            error_count: skillErrorCount,
            empty_is_explicit: skillCount === 0
          })
        );

        const usageBeforeMark = log.mark();
        const usageBefore = await attemptRequest(connection, "account/usage/read", undefined, "read", deadlineAt);
        usage.account_usage_before_shape = usageBefore.ok ? responseFieldSummary(usageBefore.value) : errorSummary(usageBefore.error);
        operations.push(
          operationEvidence(
            "account_usage_before",
            "account/usage/read",
            "runtime",
            usageBefore.ok ? "supported" : "remote_rejected",
            log.summarySince(usageBeforeMark),
            { result_shape: usage.account_usage_before_shape }
          )
        );

        currentStage = "goal_lifecycle";
        const goalMark = log.mark();
        const goalSet = requireRecord(
          await request(
            connection,
            "thread/goal/set",
            { threadId: startedA.thread.id, objective: "Complete the bounded HostDeck semantic probe", status: "paused" },
            "mutation",
            deadlineAt
          ),
          "thread/goal/set result"
        );
        expect(requireRecord(goalSet.goal, "goal set goal").status).toBe("paused");
        const goalRead = requireRecord(
          await request(connection, "thread/goal/get", { threadId: startedA.thread.id }, "read", deadlineAt),
          "thread/goal/get result"
        );
        expect(requireRecord(goalRead.goal, "goal get goal").status).toBe("paused");
        operations.push(
          operationEvidence("goal_lifecycle", "thread/goal/set + thread/goal/get", "thread_a", "supported", log.summarySince(goalMark), {
            transitions: "none_to_paused",
            read_back: true,
            autonomous_turns_started: 0,
            active_resume_semantics_recorded_in_companion_observation: true,
            replacement_content_retained: false
          })
        );

        currentStage = "model_override";
        const modelOverrideMark = log.mark();
        const modelOverride = requireRecord(
          await request(
            connection,
            "thread/resume",
            { threadId: startedA.thread.id, model: selectedModelName, excludeTurns: true },
            "mutation",
            deadlineAt
          ),
          "thread/resume model override result"
        );
        runFacts.model_override_read_back = modelOverride.model === selectedModelName;
        operations.push(
          operationEvidence(
            "loaded_thread_model_override",
            "thread/resume model override",
            "thread_a_loaded",
            runFacts.model_override_read_back ? "applied" : "accepted_not_applied",
            log.summarySince(modelOverrideMark),
            {
              catalog_target_used: true,
              read_back_matches: runFacts.model_override_read_back,
              changed_from_default: runFacts.requested_model_was_non_default,
              production_selection_candidate: false
            }
          )
        );

        if (probeMode === "full") {
          currentStage = "plan_mode_turn";
        const threadABeforePlan = await readThreadWithTurns(connection, startedA.thread.id, deadlineAt);
        const planMark = log.mark();
        const planTurn = await startTurn(
          connection,
          {
            threadId: startedB.thread.id,
            clientUserMessageId: "hostdeck_probe_plan_1",
            input: [textInput("Produce a concise two-step plan for inspecting README.md. Do not call tools or modify files.")],
            approvalPolicy: "never",
            approvalsReviewer: "user",
            sandboxPolicy: { type: "readOnly", networkAccess: false },
            collaborationMode: collaborationModeFromMask(planMask, "plan", defaultModelName)
          },
          deadlineAt,
          () => {
            modelTurnsStarted += 1;
            enforceModelTurnBudget(modelTurnsStarted);
          }
        );
        activeTurns.set(startedB.thread.id, planTurn.id);
        const completedPlan = await log.waitForNotification(
          "turn/completed",
          (message) => notificationMatchesTurn(message, startedB.thread.id, planTurn.id),
          planMark,
          deadlineAt
        );
        activeTurns.delete(startedB.thread.id);
        expect(notificationTurnStatus(completedPlan)).toBe("completed");
        const planSummary = log.summarySince(planMark);
        runFacts.plan_mode_observed =
          planSummary.notification_methods.includes("turn/plan/updated") ||
          log.notificationsSince(planMark).some((message) => notificationHasItemType(message, "plan")) ||
          log.notificationsSince(planMark).some((message) => notificationHasMode(message, "plan"));
        expect(runFacts.plan_mode_observed).toBe(true);
        const threadAAfterPlan = await readThreadWithTurns(connection, startedA.thread.id, deadlineAt);
        expect(threadAAfterPlan.turns.length).toBe(threadABeforePlan.turns.length);
        operations.push(
          operationEvidence("plan_enter", "turn/start collaborationMode=plan", "thread_b", "supported", planSummary, {
            final_status: "completed",
            plan_event_or_item: true,
            turn_budget_used: modelTurnsStarted,
            thread_a_turn_count_unchanged: true
          })
        );

        currentStage = "stale_control_rejections";
        const staleSteerMark = log.mark();
        const staleSteer = await attemptRequest(
          connection,
          "turn/steer",
          {
            threadId: startedB.thread.id,
            expectedTurnId: planTurn.id,
            clientUserMessageId: "hostdeck_probe_stale_steer",
            input: [textInput("This stale steer must be rejected.")]
          },
          "mutation",
          deadlineAt
        );
        expect(staleSteer.ok).toBe(false);
        operations.push(
          operationEvidence("stale_steer", "turn/steer", "thread_b_completed_turn", "remote_rejected", log.summarySince(staleSteerMark), {
            error: staleSteer.ok ? "unexpected_success" : errorSummary(staleSteer.error),
            no_new_turn_started: !log.summarySince(staleSteerMark).notification_methods.includes("turn/started")
          })
        );
        const staleInterruptMark = log.mark();
        const staleInterrupt = await attemptRequest(
          connection,
          "turn/interrupt",
          { threadId: startedB.thread.id, turnId: planTurn.id },
          "mutation",
          deadlineAt
        );
        operations.push(
          operationEvidence(
            "completed_turn_interrupt",
            "turn/interrupt",
            "thread_b_completed_turn",
            staleInterrupt.ok ? "idempotent_success" : "remote_rejected",
            log.summarySince(staleInterruptMark),
            { result: staleInterrupt.ok ? responseFieldSummary(staleInterrupt.value) : errorSummary(staleInterrupt.error) }
          )
        );
        const unknownMethodMark = log.mark();
        const unknownMethod = await attemptRequest(
          connection,
          "hostdeck/unsupported-operation",
          {},
          "read",
          deadlineAt
        );
        expect(unknownMethod.ok).toBe(false);
        operations.push(
          operationEvidence("unknown_method", "hostdeck/unsupported-operation", "local_broker", "local_rejected", log.summarySince(unknownMethodMark), {
            error: unknownMethod.ok ? "unexpected_success" : errorSummary(unknownMethod.error),
            sent_on_wire: false
          })
        );

        currentStage = "approval_decline_turn";
        const declineMark = log.mark();
        const declineTurn = await startTurn(
          connection,
          {
            threadId: startedB.thread.id,
            clientUserMessageId: "hostdeck_probe_approval_decline",
            input: [
              textInput(
                `Use the shell tool to run exactly \`touch ${shellQuote(deniedMarker)}\` with elevated permission. Request approval, do not use file-editing tools, and do nothing else.`
              )
            ],
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            sandboxPolicy: { type: "readOnly", networkAccess: false },
            collaborationMode: collaborationModeFromMask(defaultMask, "default", defaultModelName),
            ...(selectedEffort === null ? {} : { effort: selectedEffort })
          },
          deadlineAt,
          () => {
            modelTurnsStarted += 1;
            enforceModelTurnBudget(modelTurnsStarted);
          }
        );
        activeTurns.set(startedB.thread.id, declineTurn.id);
        const declineRequest = await log.waitForServerRequest(
          (message) => serverRequestMatchesTurn(message, startedB.thread.id, declineTurn.id),
          declineMark,
          deadlineAt
        );
        expect(declineRequest.method).toBe("item/commandExecution/requestApproval");
        const declineParams = requireRecord(declineRequest.params, "decline approval params");
        expect(declineParams).not.toHaveProperty("expiresAt");
        await connection.respondToServerRequest(declineRequest.id, { decision: "decline" });
        runFacts.approval_declined_once = true;
        const duplicateResponse = await captureError(
          connection.respondToServerRequest(declineRequest.id, { decision: "accept" })
        );
        expect(duplicateResponse).toBeInstanceOf(HostDeckCodexAdapterError);
        expect((duplicateResponse as HostDeckCodexAdapterError).code).toBe("protocol_violation");
        runFacts.duplicate_approval_rejected_locally = true;
        await log.waitForNotification(
          "serverRequest/resolved",
          (message) => notificationMatchesThread(message, startedB.thread.id),
          declineMark,
          deadlineAt
        );
        const declineCompleted = await log.waitForNotification(
          "turn/completed",
          (message) => notificationMatchesTurn(message, startedB.thread.id, declineTurn.id),
          declineMark,
          deadlineAt
        );
        activeTurns.delete(startedB.thread.id);
        expect(["completed", "failed", "interrupted"]).toContain(notificationTurnStatus(declineCompleted));
        runFacts.denied_side_effect_absent = !(await pathExists(deniedMarker));
        expect(runFacts.denied_side_effect_absent).toBe(true);
        const declineSummary = log.summarySince(declineMark);
        runFacts.default_mode_after_plan_observed =
          log.notificationsSince(declineMark).some((message) => notificationHasMode(message, "default"));
        expect(runFacts.default_mode_after_plan_observed).toBe(true);
        operations.push(
          operationEvidence("approval_decline", "item/commandExecution/requestApproval", "thread_b", "supported", declineSummary, {
            decision: "decline",
            duplicate_response_error: errorSummary(duplicateResponse),
            app_server_expiry_field_present: false,
            denied_side_effect_absent: true,
            explicit_default_mode_after_plan: true
          })
        );

        currentStage = "approval_accept_turn";
        const acceptMark = log.mark();
        const acceptTurn = await startTurn(
          connection,
          {
            threadId: startedB.thread.id,
            clientUserMessageId: "hostdeck_probe_approval_accept",
            input: [
              textInput(
                `Use the shell tool to run exactly \`touch ${shellQuote(approvedMarker)}\` with elevated permission. Request approval, do not use file-editing tools, and do nothing else.`
              )
            ],
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            sandboxPolicy: { type: "readOnly", networkAccess: false },
            collaborationMode: collaborationModeFromMask(defaultMask, "default", defaultModelName),
            ...(selectedEffort === null ? {} : { effort: selectedEffort })
          },
          deadlineAt,
          () => {
            modelTurnsStarted += 1;
            enforceModelTurnBudget(modelTurnsStarted);
          }
        );
        activeTurns.set(startedB.thread.id, acceptTurn.id);
        const acceptRequest = await log.waitForServerRequest(
          (message) => serverRequestMatchesTurn(message, startedB.thread.id, acceptTurn.id),
          acceptMark,
          deadlineAt
        );
        expect(acceptRequest.method).toBe("item/commandExecution/requestApproval");
        await connection.respondToServerRequest(acceptRequest.id, { decision: "accept" });
        runFacts.approval_accepted_once = true;
        await log.waitForNotification(
          "serverRequest/resolved",
          (message) => notificationMatchesThread(message, startedB.thread.id),
          acceptMark,
          deadlineAt
        );
        const acceptCompleted = await log.waitForNotification(
          "turn/completed",
          (message) => notificationMatchesTurn(message, startedB.thread.id, acceptTurn.id),
          acceptMark,
          deadlineAt
        );
        activeTurns.delete(startedB.thread.id);
        expect(notificationTurnStatus(acceptCompleted)).toBe("completed");
        runFacts.approved_side_effect_present = await pathExists(approvedMarker);
        expect(runFacts.approved_side_effect_present).toBe(true);
        operations.push(
          operationEvidence("approval_accept", "item/commandExecution/requestApproval", "thread_b", "supported", log.summarySince(acceptMark), {
            decision: "accept",
            approved_side_effect_present: true,
            response_count: 1
          })
        );
        }

        currentStage = "steer_tui_disconnect_interrupt_turn";
        const threadBBeforeA = await readThreadWithTurns(connection, startedB.thread.id, deadlineAt);
        const controlMark = log.mark();
        const controlTurn = await startTurn(
          connection,
          {
            threadId: startedA.thread.id,
            clientUserMessageId: "hostdeck_probe_control_turn",
            input: [textInput("Use the shell tool to run exactly `sleep 45`. Do nothing else and wait for it to finish.")],
            approvalPolicy: "never",
            approvalsReviewer: "user",
            sandboxPolicy: { type: "dangerFullAccess" },
            model: selectedModelName,
            ...(selectedEffort === null ? {} : { effort: selectedEffort })
          },
          deadlineAt,
          () => {
            modelTurnsStarted += 1;
            enforceModelTurnBudget(modelTurnsStarted);
          }
        );
        activeTurns.set(startedA.thread.id, controlTurn.id);
        await log.waitForNotification(
          "turn/started",
          (message) => notificationMatchesTurn(message, startedA.thread.id, controlTurn.id),
          controlMark,
          deadlineAt
        );
        const steerResult = requireRecord(
          await request(
            connection,
            "turn/steer",
            {
              threadId: startedA.thread.id,
              expectedTurnId: controlTurn.id,
              clientUserMessageId: "hostdeck_probe_control_steer",
              input: [textInput("Keep this same turn active until the running command is interrupted.")]
            },
            "mutation",
            deadlineAt
          ),
          "turn/steer result"
        );
        expect(steerResult.turnId).toBe(controlTurn.id);
        await log.waitForNotification(
          "item/started",
          (message) => notificationMatchesTurn(message, startedA.thread.id, controlTurn.id) && notificationHasItemType(message, "commandExecution"),
          controlMark,
          deadlineAt
        );
        const tuiCommand = buildCodexTuiResumeCommand({
          socket_path: socketPath,
          thread_id: startedA.thread.id,
          codex_bin: codexBin
        });
        tui = await startAndInspectTui(tuiCommand, codexHome, projectA, tuiSocketPath, deadlineAt);
        await request(connection, "thread/read", { threadId: startedA.thread.id, includeTurns: false }, "read", deadlineAt);
        runFacts.tui_and_hostdeck_concurrent = true;
        const generationBeforeReconnect = connection.generation;
        await connection.reconnect(deadlineSignal(deadlineAt));
        expect(connection.generation).toBeGreaterThan(generationBeforeReconnect);
        runFacts.reconnect_generation_advanced = true;
        const resumedAfterReconnect = requireRecord(
          await request(
            connection,
            "thread/resume",
            { threadId: startedA.thread.id, excludeTurns: true },
            "read",
            deadlineAt
          ),
          "thread/resume after reconnect result"
        );
        expect(requireRecord(resumedAfterReconnect.thread, "resumed thread").id).toBe(startedA.thread.id);
        runFacts.turn_model_override_read_back = resumedAfterReconnect.model === selectedModelName;
        await request(
          connection,
          "turn/interrupt",
          { threadId: startedA.thread.id, turnId: controlTurn.id },
          "mutation",
          deadlineAt
        );
        const interrupted = await log.waitForNotification(
          "turn/completed",
          (message) => notificationMatchesTurn(message, startedA.thread.id, controlTurn.id),
          controlMark,
          deadlineAt
        );
        activeTurns.delete(startedA.thread.id);
        expect(notificationTurnStatus(interrupted)).toBe("interrupted");
        await tui.close();
        tui = null;
        cleanup.tui_stopped = true;
        const threadAAfterInterrupt = await readThreadWithTurns(connection, startedA.thread.id, deadlineAt);
        expect(threadAAfterInterrupt.turns.some((turn) => turn.id === controlTurn.id && turn.status === "interrupted")).toBe(true);
        expect(requireRecord(threadAAfterInterrupt.status, "thread A status").type).not.toBe("notLoaded");
        runFacts.interrupted_not_archived = true;
        const threadBAfterA = await readThreadWithTurns(connection, startedB.thread.id, deadlineAt);
        runFacts.second_thread_unchanged_by_thread_a_turn = threadBAfterA.turns.length === threadBBeforeA.turns.length;
        expect(runFacts.second_thread_unchanged_by_thread_a_turn).toBe(true);
        operations.push(
          operationEvidence(
            "turn_steer_tui_disconnect_interrupt",
            "turn/start + turn/steer + reconnect + turn/interrupt",
            "thread_a",
            "supported",
            log.summarySince(controlMark),
            {
              steer_same_turn_id: true,
              second_turn_started_by_steer: false,
              tui_concurrent_read: true,
              explicit_reconnect_generation_advanced: true,
              accepted_turn_survived_client_disconnect: true,
              turn_model_override_read_back: runFacts.turn_model_override_read_back,
              final_status: "interrupted",
              archived: false,
              thread_b_turn_count_unchanged: true
            }
          )
        );

        currentStage = "manual_compaction";
        const compactMark = log.mark();
        const compactThreadId = probeMode === "control" ? startedA.thread.id : startedB.thread.id;
        compactionsStarted += 1;
        enforceCompactionBudget(compactionsStarted);
        const compactResult = requireRecord(
          await request(connection, "thread/compact/start", { threadId: compactThreadId }, "mutation", deadlineAt),
          "thread/compact/start result"
        );
        expect(Object.keys(compactResult)).toHaveLength(0);
        const compactItem = await log.waitForNotification(
          "item/started",
          (message) => notificationMatchesThread(message, compactThreadId) && notificationHasItemType(message, "contextCompaction"),
          compactMark,
          deadlineAt
        );
        const compactTurnId = notificationTurnId(compactItem);
        activeTurns.set(compactThreadId, compactTurnId);
        runFacts.compact_context_item_observed = true;
        const compactItemCompleted = await log.waitForOptionalNotification(
          "item/completed",
          (message) =>
            notificationMatchesTurn(message, compactThreadId, compactTurnId) && notificationHasItemType(message, "contextCompaction"),
          compactMark,
          deadlineAt,
          10_000
        );
        runFacts.compact_completed_within_observation = compactItemCompleted !== null;
        if (compactItemCompleted === null) {
          await request(
            connection,
            "turn/interrupt",
            { threadId: compactThreadId, turnId: compactTurnId },
            "mutation",
            deadlineAt
          );
        }
        const compactCompleted = await log.waitForNotification(
          "turn/completed",
          (message) => notificationMatchesTurn(message, compactThreadId, compactTurnId),
          compactMark,
          deadlineAt
        );
        activeTurns.delete(compactThreadId);
        const compactTerminalStatus = notificationTurnStatus(compactCompleted);
        expect(compactTerminalStatus).toBe(compactItemCompleted === null ? "interrupted" : "completed");
        operations.push(
          operationEvidence(
            "manual_compaction",
            "thread/compact/start",
            probeMode === "control" ? "thread_a" : "thread_b",
            compactItemCompleted === null ? "accepted_incomplete_then_interrupted" : "completed",
            log.summarySince(compactMark),
            {
            response_immediate_empty_object: true,
            context_compaction_item_lifecycle: true,
            item_completed_within_observation: compactItemCompleted !== null,
            terminal_status: compactTerminalStatus,
            context_reduction_claimed: compactItemCompleted !== null,
            compaction_budget_used: compactionsStarted
            }
          )
        );

        currentStage = "usage_and_goal_terminal";
        const usageAfterMark = log.mark();
        const usageAfter = await attemptRequest(connection, "account/usage/read", undefined, "read", deadlineAt);
        usage.account_usage_after_shape = usageAfter.ok ? responseFieldSummary(usageAfter.value) : errorSummary(usageAfter.error);
        const usageByThread = log.latestThreadTokenTotals();
        usage.thread_a_total_tokens = usageByThread.get(startedA.thread.id) ?? null;
        usage.thread_b_total_tokens = usageByThread.get(startedB.thread.id) ?? null;
        const finalGoalRead = requireRecord(
          await request(connection, "thread/goal/get", { threadId: startedA.thread.id }, "read", deadlineAt),
          "final thread/goal/get result"
        );
        const finalGoal = requireRecord(finalGoalRead.goal, "final active goal");
        usage.goal_tokens_used = requireNonNegativeNumber(finalGoal.tokensUsed, "goal tokensUsed");
        const completedGoal = requireRecord(
          await request(
            connection,
            "thread/goal/set",
            { threadId: startedA.thread.id, status: "complete" },
            "mutation",
            deadlineAt
          ),
          "completed goal result"
        );
        expect(requireRecord(completedGoal.goal, "completed goal").status).toBe("complete");
        await request(connection, "thread/goal/clear", { threadId: startedA.thread.id }, "mutation", deadlineAt);
        const clearedGoal = requireRecord(
          await request(connection, "thread/goal/get", { threadId: startedA.thread.id }, "read", deadlineAt),
          "cleared goal result"
        );
        expect(clearedGoal.goal).toBeNull();
        operations.push(
          operationEvidence(
            "usage_and_goal_terminal",
            "account/usage/read + thread/tokenUsage/updated + thread/goal/*",
            "runtime_and_thread_a",
            usageAfter.ok ? "supported" : "partially_supported",
            log.summarySince(usageAfterMark),
            {
              account_usage_result_shape: usage.account_usage_after_shape,
              thread_token_usage_observed: usage.thread_a_total_tokens !== null || usage.thread_b_total_tokens !== null,
              goal_usage_observed: usage.goal_tokens_used !== null,
              goal_transition: "paused_to_complete_to_clear",
              monetary_cost_exposed: false
            }
          )
        );

        currentStage = "final_invariants";
        expect(modelTurnsStarted).toBe(probeLimits.model_turns);
        expect(compactionsStarted).toBe(probeLimits.compactions);
        expect(log.notificationCount("turn/started")).toBeGreaterThanOrEqual(modelTurnsStarted);
        expect(log.notificationCount("turn/started")).toBeLessThanOrEqual(modelTurnsStarted + compactionsStarted);
        expect(log.protocolIssueCount("fatal")).toBe(0);
        expect(Date.now()).toBeLessThanOrEqual(deadlineAt);
      } catch (error) {
        failureStage = currentStage;
        primaryError = error;
      }
      operationsFinishedAt = Date.now();

      currentStage = "cleanup";
      const cleanupErrors: unknown[] = [];
      if (connection !== null && ["degraded", "ready"].includes(connection.state)) {
        for (const [threadId, turnId] of activeTurns) {
          cleanup.active_turn_interrupts_attempted += 1;
          const interruptOutcome = await collectCleanupInterrupt(
            connection.request({
              method: "turn/interrupt",
              params: { threadId, turnId },
              kind: "mutation",
              timeout_ms: 5_000
            })
          );
          if (interruptOutcome === "already_terminal") cleanup.active_turns_already_terminal += 1;
          if (interruptOutcome instanceof Error) cleanupErrors.push(interruptOutcome);
        }
        if (threads !== null) {
          for (const threadId of managedThreads) {
            const errorsBefore = cleanupErrors.length;
            await collectCleanupError(threads.archive(threadId), cleanupErrors);
            if (cleanupErrors.length === errorsBefore) cleanup.threads_archived += 1;
          }
        }
      }
      if (tui !== null) {
        const errorsBefore = cleanupErrors.length;
        await collectCleanupError(tui.close(), cleanupErrors);
        if (cleanupErrors.length === errorsBefore) cleanup.tui_stopped = true;
      }
      if (connection !== null) {
        const errorsBefore = cleanupErrors.length;
        await collectCleanupError(connection.close("HostDeck Codex semantic probe completed."), cleanupErrors);
        if (cleanupErrors.length === errorsBefore) cleanup.connection_closed = true;
      }
      const wire = recording?.snapshot() ?? null;
      recording?.dispose();
      cleanup.recorder_disposed = recording !== null;
      if (child !== null) {
        const errorsBefore = cleanupErrors.length;
        await collectCleanupError(stopChild(child), cleanupErrors);
        if (cleanupErrors.length === errorsBefore) cleanup.app_server_stopped = true;
      }
      await collectCleanupError(rm(root, { recursive: true, force: true }), cleanupErrors);
      cleanup.temporary_root_removed = !(await pathExists(root));

      const report: SemanticProbeReport = {
        schema_version: 1,
        task: "INT-V1-006",
        probe_mode: probeMode,
        observed_at: observedAt,
        hostdeck_commit: hostdeckCommit,
        codex_version: version,
        binding_id: codexBindingDescriptor.binding_id,
        platform: { os: process.platform, arch: process.arch },
        isolation: {
          copied_auth_file_only: true,
          auth_copy_mode: "0600",
          codex_home_temporary: true,
          private_unix_socket: true,
          repositories: 2,
          report_contains_prompt_or_output_content: false
        },
        limits: probeLimits,
        actual: {
          model_turns_started: modelTurnsStarted,
          observed_turns_started: log.notificationCount("turn/started"),
          compactions_started: compactionsStarted,
          live_elapsed_ms: Math.max(0, operationsFinishedAt - (deadlineAt - probeLimits.live_operations_ms)),
          no_automatic_model_retry: true
        },
        facts: runFacts,
        usage,
        operations,
        observed_guarantees: observedGuarantees(runFacts),
        inferences_and_deferrals: inferenceAndDeferrals(),
        protocol_issues: log.safeProtocolIssues(),
        wire,
        cleanup,
        failure: primaryError === null ? null : safeFailure(failureStage, primaryError),
        cleanup_failures: cleanupErrors.map((error) => safeFailure("cleanup", error))
      };
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });

      if (primaryError !== null && cleanupErrors.length > 0) {
        throw new AggregateError([primaryError, ...cleanupErrors], "Codex semantic probe and cleanup failed; see redacted report.");
      }
      if (primaryError !== null) throw primaryError;
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Codex semantic probe cleanup failed; see redacted report.");
      expect(cleanup).toMatchObject({
        threads_archived: 2,
        tui_stopped: true,
        connection_closed: true,
        recorder_disposed: true,
        app_server_stopped: true,
        temporary_root_removed: true
      });
      expect(appServerStderr.length).toBeLessThanOrEqual(32_000);
    },
    probeLimits.test_with_cleanup_ms
  );
});

interface OperationEvidence {
  readonly operation: string;
  readonly wire_operation: string;
  readonly target: string;
  readonly outcome: string;
  readonly notification_methods: readonly string[];
  readonly server_request_methods: readonly string[];
  readonly protocol_issue_codes: readonly string[];
  readonly details: Readonly<Record<string, boolean | number | string | null>>;
}

interface RunFacts {
  two_distinct_threads: boolean;
  separate_repositories: boolean;
  requested_model_was_non_default: boolean;
  model_override_read_back: boolean;
  turn_model_override_read_back: boolean;
  plan_mode_observed: boolean;
  default_mode_after_plan_observed: boolean;
  approval_declined_once: boolean;
  approval_accepted_once: boolean;
  duplicate_approval_rejected_locally: boolean;
  approved_side_effect_present: boolean;
  denied_side_effect_absent: boolean;
  tui_and_hostdeck_concurrent: boolean;
  reconnect_generation_advanced: boolean;
  interrupted_not_archived: boolean;
  second_thread_unchanged_by_thread_a_turn: boolean;
  compact_context_item_observed: boolean;
  compact_completed_within_observation: boolean;
}

interface UsageEvidence {
  account_usage_before_shape: string;
  account_usage_after_shape: string;
  thread_a_total_tokens: number | null;
  thread_b_total_tokens: number | null;
  goal_tokens_used: number | null;
  monetary_cost: null;
  monetary_cost_source: "not_exposed_by_app_server";
}

interface CleanupEvidence {
  active_turn_interrupts_attempted: number;
  active_turns_already_terminal: number;
  threads_archived: number;
  tui_stopped: boolean;
  connection_closed: boolean;
  recorder_disposed: boolean;
  app_server_stopped: boolean;
  temporary_root_removed: boolean;
}

interface SemanticProbeReport {
  readonly schema_version: 1;
  readonly task: "INT-V1-006";
  readonly probe_mode: "control" | "full";
  readonly observed_at: string;
  readonly hostdeck_commit: string;
  readonly codex_version: string;
  readonly binding_id: string;
  readonly platform: { readonly os: string; readonly arch: string };
  readonly isolation: Readonly<Record<string, boolean | number | string>>;
  readonly limits: typeof probeLimits;
  readonly actual: Readonly<Record<string, boolean | number>>;
  readonly facts: RunFacts;
  readonly usage: UsageEvidence;
  readonly operations: readonly OperationEvidence[];
  readonly observed_guarantees: readonly string[];
  readonly inferences_and_deferrals: readonly string[];
  readonly protocol_issues: readonly SafeProtocolIssue[];
  readonly wire: ReturnType<CodexSemanticRecordingTransport["snapshot"]> | null;
  readonly cleanup: CleanupEvidence;
  readonly failure: SafeFailure | null;
  readonly cleanup_failures: readonly SafeFailure[];
}

interface SafeFailure {
  readonly stage: string;
  readonly name: string;
  readonly code: string | null;
  readonly outcome: string | null;
  readonly retry_safe: boolean | null;
  readonly rpc_code: number | null;
  readonly message_redacted: true;
}

interface SafeProtocolIssue {
  readonly severity: string;
  readonly code: string;
  readonly method: string | null;
  readonly message_redacted: true;
}

interface ObservationMark {
  readonly notification: number;
  readonly server_request: number;
  readonly protocol_issue: number;
}

interface ObservationSummary {
  readonly notification_methods: readonly string[];
  readonly server_request_methods: readonly string[];
  readonly protocol_issue_codes: readonly string[];
}

class InboundObservationLog {
  private readonly notifications: CodexConnectionNotification[] = [];
  private readonly serverRequests: CodexConnectionServerRequest[] = [];
  private readonly protocolIssues: Array<{ readonly severity: string; readonly code: string; readonly method: string | null }> = [];

  addNotification(message: CodexConnectionNotification): void {
    if (this.notifications.length >= probeLimits.notifications) throw new Error("Codex semantic probe notification limit exceeded.");
    this.notifications.push(message);
  }

  addServerRequest(message: CodexConnectionServerRequest): void {
    if (this.serverRequests.length >= probeLimits.server_requests) throw new Error("Codex semantic probe server-request limit exceeded.");
    this.serverRequests.push(message);
  }

  addProtocolIssue(issue: { readonly severity: string; readonly code: string; readonly method: string | null }): void {
    if (this.protocolIssues.length >= probeLimits.protocol_issues) throw new Error("Codex semantic probe protocol-issue limit exceeded.");
    this.protocolIssues.push({ severity: issue.severity, code: issue.code, method: issue.method });
  }

  mark(): ObservationMark {
    return {
      notification: this.notifications.length,
      server_request: this.serverRequests.length,
      protocol_issue: this.protocolIssues.length
    };
  }

  notificationsSince(mark: ObservationMark): readonly CodexConnectionNotification[] {
    return this.notifications.slice(mark.notification);
  }

  summarySince(mark: ObservationMark): ObservationSummary {
    return {
      notification_methods: uniqueSorted(this.notifications.slice(mark.notification).map((message) => message.method)),
      server_request_methods: uniqueSorted(this.serverRequests.slice(mark.server_request).map((message) => message.method)),
      protocol_issue_codes: uniqueSorted(this.protocolIssues.slice(mark.protocol_issue).map((issue) => issue.code))
    };
  }

  async waitForNotification(
    method: string,
    predicate: (message: CodexConnectionNotification) => boolean,
    mark: ObservationMark,
    deadlineAt: number
  ): Promise<CodexConnectionNotification> {
    return waitForValue(
      () => this.notifications.slice(mark.notification).find((message) => message.method === method && predicate(message)),
      eventDeadline(deadlineAt),
      `notification ${method}`
    );
  }

  async waitForServerRequest(
    predicate: (message: CodexConnectionServerRequest) => boolean,
    mark: ObservationMark,
    deadlineAt: number
  ): Promise<CodexConnectionServerRequest> {
    return waitForValue(
      () => this.serverRequests.slice(mark.server_request).find(predicate),
      eventDeadline(deadlineAt),
      "supported server request"
    );
  }

  async waitForOptionalNotification(
    method: string,
    predicate: (message: CodexConnectionNotification) => boolean,
    mark: ObservationMark,
    deadlineAt: number,
    timeoutMs: number
  ): Promise<CodexConnectionNotification | null> {
    const observationDeadline = Math.min(deadlineAt, Date.now() + timeoutMs);
    while (Date.now() < observationDeadline) {
      const message = this.notifications
        .slice(mark.notification)
        .find((candidate) => candidate.method === method && predicate(candidate));
      if (message !== undefined) return message;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    return null;
  }

  latestThreadTokenTotals(): Map<string, number> {
    const totals = new Map<string, number>();
    for (const message of this.notifications) {
      if (message.method !== "thread/tokenUsage/updated") continue;
      const params = requireRecord(message.params, "thread/tokenUsage/updated params");
      const threadId = requireString(params.threadId, "token usage threadId");
      const tokenUsage = requireRecord(params.tokenUsage, "token usage");
      const total = requireRecord(tokenUsage.total, "token usage total");
      totals.set(threadId, requireNonNegativeNumber(total.totalTokens, "totalTokens"));
    }
    return totals;
  }

  protocolIssueCount(severity: string): number {
    return this.protocolIssues.filter((issue) => issue.severity === severity).length;
  }

  notificationCount(method: string): number {
    return this.notifications.filter((message) => message.method === method).length;
  }

  safeProtocolIssues(): readonly SafeProtocolIssue[] {
    return this.protocolIssues.map((issue) => ({ ...issue, message_redacted: true as const }));
  }
}

function operationEvidence(
  operation: string,
  wireOperation: string,
  target: string,
  outcome: string,
  summary: ObservationSummary,
  details: Readonly<Record<string, boolean | number | string | null>>
): OperationEvidence {
  return {
    operation,
    wire_operation: wireOperation,
    target,
    outcome,
    notification_methods: summary.notification_methods,
    server_request_methods: summary.server_request_methods,
    protocol_issue_codes: summary.protocol_issue_codes,
    details
  };
}

async function request(
  connection: ReturnType<typeof createCodexAppServerConnection>,
  method: string,
  params: unknown,
  kind: "mutation" | "read",
  deadlineAt: number
): Promise<unknown> {
  const timeout = requestTimeout(deadlineAt);
  return connection.request({ method, params, kind, timeout_ms: timeout, signal: deadlineSignal(deadlineAt) });
}

async function attemptRequest(
  connection: ReturnType<typeof createCodexAppServerConnection>,
  method: string,
  params: unknown,
  kind: "mutation" | "read",
  deadlineAt: number
): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown }> {
  try {
    return { ok: true, value: await request(connection, method, params, kind, deadlineAt) };
  } catch (error) {
    return { ok: false, error };
  }
}

async function startTurn(
  connection: ReturnType<typeof createCodexAppServerConnection>,
  params: Record<string, unknown>,
  deadlineAt: number,
  reserveBudget: () => void
): Promise<{ readonly id: string; readonly status: string }> {
  reserveBudget();
  const result = requireRecord(await request(connection, "turn/start", params, "mutation", deadlineAt), "turn/start result");
  const turn = requireRecord(result.turn, "turn/start turn");
  return { id: requireString(turn.id, "turn id"), status: requireString(turn.status, "turn status") };
}

async function readThreadWithTurns(
  connection: ReturnType<typeof createCodexAppServerConnection>,
  threadId: string,
  deadlineAt: number
): Promise<{ readonly turns: ReadonlyArray<{ readonly id: string; readonly status: string }>; readonly status: unknown }> {
  const result = requireRecord(
    await request(connection, "thread/read", { threadId, includeTurns: true }, "read", deadlineAt),
    "thread/read result"
  );
  const thread = requireRecord(result.thread, "thread/read thread");
  return {
    turns: requireRecordArray(thread.turns, "thread turns").map((turn) => ({
      id: requireString(turn.id, "stored turn id"),
      status: requireString(turn.status, "stored turn status")
    })),
    status: thread.status
  };
}

function textInput(text: string): Record<string, unknown> {
  return { type: "text", text, text_elements: [] };
}

function collaborationModeFromMask(
  mask: Record<string, unknown>,
  requiredMode: "default" | "plan",
  fallbackModel: string
): Record<string, unknown> {
  const mode = mask.mode === null ? requiredMode : requireString(mask.mode, "collaboration mode");
  expect(mode).toBe(requiredMode);
  return {
    mode,
    settings: {
      model: mask.model === null ? fallbackModel : requireString(mask.model, "collaboration model"),
      reasoning_effort: mask.reasoning_effort === undefined ? null : mask.reasoning_effort,
      developer_instructions: null
    }
  };
}

function requireCollaborationMask(modes: readonly Record<string, unknown>[], mode: "default" | "plan"): Record<string, unknown> {
  const match = modes.find((candidate) => candidate.mode === mode || String(candidate.name).toLowerCase() === mode);
  if (match === undefined) throw new Error(`Codex collaboration catalog is missing ${mode}.`);
  return match;
}

function selectBoundedEffort(model: Record<string, unknown> | undefined): string | null {
  if (model === undefined) return null;
  const options = requireRecordArray(model.supportedReasoningEfforts, "supported reasoning efforts");
  const efforts = options.map((option) => requireString(option.reasoningEffort, "reasoning effort"));
  return efforts.find((effort) => effort === "minimal") ?? efforts.find((effort) => effort === "low") ?? null;
}

function notificationMatchesThread(message: CodexConnectionNotification, threadId: string): boolean {
  return requireRecord(message.params, `${message.method} params`).threadId === threadId;
}

function notificationMatchesTurn(message: CodexConnectionNotification, threadId: string, turnId: string): boolean {
  const params = requireRecord(message.params, `${message.method} params`);
  if (params.threadId !== threadId) return false;
  if (params.turnId === turnId) return true;
  return isRecord(params.turn) && params.turn.id === turnId;
}

function notificationTurnStatus(message: CodexConnectionNotification): string {
  const params = requireRecord(message.params, `${message.method} params`);
  return requireString(requireRecord(params.turn, `${message.method} turn`).status, `${message.method} turn status`);
}

function notificationTurnId(message: CodexConnectionNotification): string {
  const params = requireRecord(message.params, `${message.method} params`);
  if (typeof params.turnId === "string") return params.turnId;
  return requireString(requireRecord(params.turn, `${message.method} turn`).id, `${message.method} turn id`);
}

function notificationHasItemType(message: CodexConnectionNotification, itemType: string): boolean {
  const params = requireRecord(message.params, `${message.method} params`);
  return isRecord(params.item) && params.item.type === itemType;
}

function notificationHasMode(message: CodexConnectionNotification, mode: "default" | "plan"): boolean {
  if (message.method !== "thread/settings/updated") return false;
  const params = requireRecord(message.params, "thread/settings/updated params");
  if (!isRecord(params.threadSettings) || !isRecord(params.threadSettings.collaborationMode)) return false;
  return params.threadSettings.collaborationMode.mode === mode;
}

function serverRequestMatchesTurn(message: CodexConnectionServerRequest, threadId: string, turnId: string): boolean {
  const params = requireRecord(message.params, `${message.method} params`);
  return params.threadId === threadId && params.turnId === turnId;
}

function enforceModelTurnBudget(count: number): void {
  if (count > probeLimits.model_turns) throw new Error("Codex semantic probe model-turn budget exceeded.");
}

function enforceCompactionBudget(count: number): void {
  if (count > probeLimits.compactions) throw new Error("Codex semantic probe compaction budget exceeded.");
}

function observedGuarantees(facts: RunFacts): readonly string[] {
  const guarantees = [
    facts.two_distinct_threads && "two isolated managed thread ids remained distinct",
    !facts.model_override_read_back && "thread/resume accepted but did not apply a model override to an already loaded thread",
    facts.turn_model_override_read_back && "turn/start applied the catalog model override for the turn and subsequent thread state",
    facts.plan_mode_observed && "plan collaboration mode produced structured plan state",
    facts.default_mode_after_plan_observed && "an explicit Default collaboration mode exited plan behavior",
    facts.approval_declined_once && "one correlated command approval decline resolved exactly once",
    facts.approval_accepted_once && "one correlated command approval accept resolved exactly once",
    facts.tui_and_hostdeck_concurrent && "a normal TUI and HostDeck connection read the same runtime concurrently",
    facts.reconnect_generation_advanced && "an accepted active turn survived one explicit HostDeck client reconnect",
    facts.interrupted_not_archived && "interrupt produced interrupted turn state without archiving the thread",
    facts.second_thread_unchanged_by_thread_a_turn && "thread A control work did not add a turn to thread B",
    facts.compact_context_item_observed && "manual compact returned immediately and emitted a contextCompaction item start",
    facts.compact_context_item_observed &&
      !facts.compact_completed_within_observation &&
      "manual compact did not prove context reduction within the bounded observation window"
  ];
  return guarantees.filter((value): value is string => typeof value === "string");
}

function inferenceAndDeferrals(): readonly string[] {
  return [
    "App-server approval requests expose startedAtMs but no expiry; HostDeck must own expiry policy and connection-generation invalidation.",
    "The companion goal-activation observation proves that active goals autonomously start turns; this final probe keeps goals paused so unrelated operations remain attributable and bounded.",
    "thread/resume.model is not a valid model-selection control for an already loaded thread in exact 0.144.0; downstream model selection must use the observed turn/start boundary and read back later thread state.",
    "A successful post-accept reconnect does not prove the outcome of a turn/start request disconnected before its response; broker unknown-outcome rules remain authoritative until the reconnect leaves.",
    "Account token activity and thread token usage do not expose monetary cost; HostDeck must not invent a currency estimate.",
    "The collaboration catalog is a mask; HostDeck constructs the exact mode settings from mask fields plus the selected catalog model and built-in instructions.",
    "Current official docs can advance beyond pinned 0.144.0; generated 0.144.0 bindings and this observation remain the compatibility authority.",
    "The spike records operation semantics only; normalization, persistence, API routing, UI state, restart recovery, and approval expiry belong to their downstream leaf tasks."
  ];
}

function responseFieldSummary(candidate: unknown): string {
  if (!isRecord(candidate)) return candidate === null ? "null" : typeof candidate;
  return `object:${Object.keys(candidate).sort().join(",") || "empty"}`;
}

function errorSummary(error: unknown): string {
  if (error instanceof HostDeckCodexAdapterError) {
    return `${error.code}:${error.outcome}:retry_${error.retry_safe ? "safe" : "unsafe"}:rpc_${error.rpc_code ?? "none"}`;
  }
  return error instanceof Error ? error.name : "unknown_error";
}

function safeFailure(stage: string, error: unknown): SafeFailure {
  if (error instanceof HostDeckCodexAdapterError) {
    return {
      stage,
      name: error.name,
      code: error.code,
      outcome: error.outcome,
      retry_safe: error.retry_safe,
      rpc_code: error.rpc_code,
      message_redacted: true
    };
  }
  return {
    stage,
    name: error instanceof Error ? error.name : "UnknownError",
    code: null,
    outcome: null,
    retry_safe: null,
    rpc_code: null,
    message_redacted: true
  };
}

async function captureError(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
    return null;
  } catch (error) {
    return error;
  }
}

async function waitForValue<T>(
  read: () => T | undefined | Promise<T | undefined>,
  deadlineAt: number,
  label: string
): Promise<T> {
  while (true) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadlineAt) throw new Error(`Timed out waiting for Codex ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function requestTimeout(deadlineAt: number): number {
  const remaining = deadlineAt - Date.now();
  if (remaining < 50) throw new Error("Codex semantic probe live-operation deadline expired.");
  return Math.max(50, Math.min(probeLimits.request_ms, remaining));
}

function eventDeadline(deadlineAt: number): number {
  return Math.min(deadlineAt, Date.now() + probeLimits.event_ms);
}

function deadlineSignal(deadlineAt: number): AbortSignal {
  const remaining = deadlineAt - Date.now();
  if (remaining < 1) throw new Error("Codex semantic probe live-operation deadline expired.");
  return AbortSignal.timeout(remaining);
}

function requireRecord(candidate: unknown, label: string): Record<string, unknown> {
  if (!isRecord(candidate)) throw new TypeError(`${label} must be an object.`);
  return candidate;
}

function requireRecordArray(candidate: unknown, label: string): Record<string, unknown>[] {
  return requireArray(candidate, label).map((entry) => requireRecord(entry, `${label} entry`));
}

function requireArray(candidate: unknown, label: string): unknown[] {
  if (!Array.isArray(candidate)) throw new TypeError(`${label} must be an array.`);
  return candidate;
}

function requireString(candidate: unknown, label: string): string {
  if (typeof candidate !== "string" || candidate.length < 1) throw new TypeError(`${label} must be a non-empty string.`);
  return candidate;
}

function requireNonNegativeNumber(candidate: unknown, label: string): number {
  if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0) {
    throw new TypeError(`${label} must be a non-negative finite number.`);
  }
  return candidate;
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate);
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function assertReportPath(candidate: string): void {
  if (!isAbsolute(candidate) || basename(candidate).length < 1 || !candidate.endsWith(".json")) {
    throw new TypeError("Codex semantic probe report path must be an absolute JSON path.");
  }
}

async function startAndInspectTui(
  command: ReturnType<typeof buildCodexTuiResumeCommand>,
  codexHome: string,
  projectDirectory: string,
  tmuxSocketPath: string,
  deadlineAt: number
): Promise<TuiProbe> {
  const threadId = command.args.at(-1);
  if (threadId === undefined) throw new Error("TUI resume command is missing its exact thread id.");
  const args = [...command.args.slice(0, -1), "--no-alt-screen", threadId];
  const shellCommand = [command.executable, ...args].map(shellQuote).join(" ");
  const environment = { ...process.env, CODEX_HOME: codexHome, TERM: "xterm-256color" };
  let running = false;
  try {
    await runFile(
      "tmux",
      ["-S", tmuxSocketPath, "-f", "/dev/null", "new-session", "-d", "-x", "120", "-y", "40", "-s", "hostdeck-semantics"],
      { cwd: projectDirectory, env: environment },
      deadlineAt
    );
    running = true;
    await runFile("tmux", ["-S", tmuxSocketPath, "set-option", "-g", "remain-on-exit", "on"], { env: environment }, deadlineAt);
    await runFile(
      "tmux",
      ["-S", tmuxSocketPath, "respawn-pane", "-k", "-t", "hostdeck-semantics:0.0", shellCommand],
      { cwd: projectDirectory, env: environment },
      deadlineAt
    );
    await waitForValue(
      async () => {
        const output = (
          await runFile(
            "tmux",
            ["-S", tmuxSocketPath, "capture-pane", "-p", "-t", "hostdeck-semantics:0.0", "-S", "-1000"],
            { env: environment },
            deadlineAt
          )
        ).stdout;
        const pane = (
          await runFile(
            "tmux",
            ["-S", tmuxSocketPath, "display-message", "-p", "-t", "hostdeck-semantics:0.0", "#{pane_dead} #{pane_dead_status}"],
            { env: environment },
            deadlineAt
          )
        ).stdout.trim();
        if (pane.startsWith("1 ")) throw new Error("Codex semantic probe TUI exited before inspection.");
        return output.includes("OpenAI Codex") && output.includes(basename(projectDirectory)) ? true : undefined;
      },
      Math.min(deadlineAt, Date.now() + 8_000),
      "TUI rendering"
    );
    return {
      async close() {
        if (!running) return;
        await stopTmuxServer(tmuxSocketPath, environment, deadlineAt);
        running = false;
      }
    };
  } catch (error) {
    try {
      if (running) await stopTmuxServer(tmuxSocketPath, environment, deadlineAt);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Codex semantic probe TUI inspection and cleanup failed.");
    }
    throw error;
  }
}

interface TuiProbe {
  readonly close: () => Promise<void>;
}

async function stopTmuxServer(tmuxSocketPath: string, environment: NodeJS.ProcessEnv, deadlineAt: number): Promise<void> {
  await runFile("tmux", ["-S", tmuxSocketPath, "kill-server"], { env: environment }, deadlineAt);
}

async function waitForSocket(socketPath: string, child: ChildProcess, deadlineAt: number): Promise<void> {
  await waitForValue(
    async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error("Codex app-server exited before creating its Unix socket.");
      }
      try {
        return (await lstat(socketPath)).isSocket() ? true : undefined;
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        return undefined;
      }
    },
    Math.min(deadlineAt, Date.now() + 5_000),
    "app-server Unix socket"
  );
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").then(() => undefined);
  child.kill("SIGTERM");
  if (await settlesWithin(exited, 2_000)) return;
  child.kill("SIGKILL");
  if (!(await settlesWithin(exited, 1_000))) throw new Error("Codex app-server did not exit after SIGKILL.");
}

async function settlesWithin(promise: Promise<void>, milliseconds: number): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  const expired = new Promise<false>((resolvePromise) => {
    timeout = setTimeout(() => resolvePromise(false), milliseconds);
    timeout.unref();
  });
  const settled = await Promise.race([promise.then(() => true as const), expired]);
  if (timeout !== undefined) clearTimeout(timeout);
  return settled;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function boundedOutput(current: string, chunk: Buffer): string {
  return `${current}${chunk.toString("utf8")}`.slice(-32_000);
}

async function seedCodexAuthentication(codexHome: string): Promise<void> {
  const sourceHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const source = join(sourceHome, "auth.json");
  const sourceMetadata = await lstat(source);
  if (!sourceMetadata.isFile() || (sourceMetadata.mode & 0o077) !== 0) {
    throw new Error("Installed Codex authentication must be a private regular auth.json file for the semantic probe.");
  }
  const destination = join(codexHome, "auth.json");
  await copyFile(source, destination);
  await chmod(destination, 0o600);
  const destinationMetadata = await lstat(destination);
  if (!destinationMetadata.isFile() || (destinationMetadata.mode & 0o077) !== 0) {
    throw new Error("Temporary Codex authentication copy is not private.");
  }
}

async function runFile(
  executable: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv },
  deadlineAt: number
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = Math.max(1, Math.min(5_000, deadlineAt - Date.now()));
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
      settled = true;
      reject(new Error(`${executable} timed out.`));
    }, timeoutMs);
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
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`${executable} exited with ${code ?? signal ?? "unknown"}; output redacted.`));
    });
  });
}

async function collectCleanupError(operation: Promise<unknown>, errors: unknown[]): Promise<void> {
  try {
    await operation;
  } catch (error) {
    errors.push(error);
  }
}

async function collectCleanupInterrupt(operation: Promise<unknown>): Promise<"interrupted" | "already_terminal" | Error> {
  try {
    await operation;
    return "interrupted";
  } catch (error) {
    if (error instanceof HostDeckCodexAdapterError && error.code === "remote_error" && error.rpc_code === -32600) {
      return "already_terminal";
    }
    return error instanceof Error ? error : new Error("Unknown cleanup interrupt failure.");
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
