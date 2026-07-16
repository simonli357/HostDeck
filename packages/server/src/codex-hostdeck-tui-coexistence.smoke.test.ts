import { Buffer } from "node:buffer";
import {
  type ChildProcess,
  execFileSync,
  spawn
} from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  isAbsolute,
  join,
  relative,
  resolve
} from "node:path";
import {
  buildCodexTuiResumeCommand,
  type CodexAppServerConnection,
  type CodexConnectionNotification,
  type CodexRequestInput,
  codexBindingDescriptor,
  createCodexAppServerConnection,
  createCodexModelClient,
  createCodexReconciliationReadClient,
  createCodexThreadClient,
  createCodexTurnClient,
  createCodexUnixWebSocketTransport,
  type NormalizedCodexEvent,
  parseCodexCliVersionOutput
} from "@hostdeck/codex-adapter";
import {
  defaultResourceBudget,
  type ModelCatalogEntry,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "@hostdeck/contracts";
import type {
  CodexThreadId,
  CodexTurnId,
  IsoTimestamp
} from "@hostdeck/core";
import {
  createProductionProjectionAppendPort,
  createSelectedStateRepository,
  openMigratedDatabase
} from "@hostdeck/storage";
import { describe, expect, it } from "vitest";
import {
  type CodexEventPipeline,
  createCodexEventPipeline
} from "./codex-event-pipeline.js";
import {
  isProcessAlive,
  readBoundedProcessCommandLine,
  readCodexSmokePrivateJson,
  socketIdentity,
  writeCodexSmokePrivateJson
} from "./codex-hostdeck-restart-smoke-support.js";

const requireSmoke =
  process.env.HOSTDECK_REQUIRE_CODEX_TUI_COEXISTENCE_SMOKE === "1";
const codexBin = resolve(process.env.HOSTDECK_CODEX_BIN ?? "codex");
const defaultEvidencePath = resolve(
  "artifacts/int-v1-031-hostdeck-tui-coexistence-evidence.json"
);
const evidencePath = resolve(
  process.env.HOSTDECK_CODEX_TUI_COEXISTENCE_REPORT ?? defaultEvidencePath
);
const maximumBufferedNotifications = 512;
const maximumDiagnosticEntries = 1_024;
const maximumOutputBytes = 64 * 1_024;
const sentinel = "HOSTDECK_COEXIST_031";
const overallTimeoutMs = 240_000;

describe.skipIf(!requireSmoke)(
  "exact Codex HostDeck and TUI coexistence",
  () => {
    it(
      "preserves one managed thread and ordered pipeline across both client teardown directions",
      async () => {
        assertEvidencePath(evidencePath);
        rmSync(evidencePath, { force: true });
        const version = parseCodexCliVersionOutput(
          execFileSync(codexBin, ["--version"], {
            encoding: "utf8",
            timeout: 10_000,
            maxBuffer: maximumOutputBytes
          })
        );
        expect(version).toBe(codexBindingDescriptor.codex_version);
        expect(
          execFileSync("tmux", ["-V"], {
            encoding: "utf8",
            timeout: 5_000,
            maxBuffer: maximumOutputBytes
          })
        ).toMatch(/^tmux \d/u);

        const root = mkdtempSync(
          join(tmpdir(), "hostdeck-tui-coexistence-smoke-")
        );
        chmodSync(root, 0o700);
        const runtimeDir = join(root, "runtime");
        const stateDir = join(root, "state");
        const codexHome = join(root, "codex-home");
        const managedProject = join(root, "managed-project");
        const foreignProject = join(root, "foreign-project");
        const socketPath = join(runtimeDir, "app-server.sock");
        const tuiASocketPath = join(runtimeDir, "tui-a.sock");
        const tuiBSocketPath = join(runtimeDir, "tui-b.sock");
        const markerPath = join(managedProject, "coexistence-marker");
        const databasePath = join(stateDir, "hostdeck.sqlite");
        try {
          mkdirSync(runtimeDir, { mode: 0o700 });
          mkdirSync(stateDir, { mode: 0o700 });
          mkdirSync(managedProject, { mode: 0o700 });
          mkdirSync(foreignProject, { mode: 0o700 });
          prepareCodexHome(codexHome);
          initializeGitRepository(managedProject);
          initializeGitRepository(foreignProject);
        } catch (error) {
          rmSync(root, { recursive: true, force: true, maxRetries: 5 });
          throw error;
        }

        let appServer: ChildProcess;
        try {
          appServer = startAppServer(
            codexBin,
            socketPath,
            codexHome,
            managedProject
          );
        } catch (error) {
          rmSync(root, { recursive: true, force: true, maxRetries: 5 });
          throw error;
        }
        const appOutput = captureBoundedChildOutput(appServer);
        let appServerProcessGroupId: number | null = null;
        let appSocketIdentity: string | null = null;
        let connectionA: CodexAppServerConnection | null = null;
        let connectionB: CodexAppServerConnection | null = null;
        let connectionAClosed = false;
        let connectionBClosed = false;
        let database: ReturnType<typeof openMigratedDatabase> | null = null;
        let databaseClosed = false;
        let tuiA: TuiProbe | null = null;
        let tuiB: TuiProbe | null = null;
        let managedThreadId: CodexThreadId | null = null;
        let foreignThreadId: CodexThreadId | null = null;
        let threadsArchived = 0;
        let primaryError: unknown = null;
        const cleanupErrors: unknown[] = [];
        const pending = new Set<Promise<unknown>>();
        const backgroundErrors: Error[] = [];
        let pipeline: CodexEventPipeline | null = null;
        let evidence: CoexistenceEvidence | null = null;

        try {
          appServerProcessGroupId = requireChildPid(appServer);
          assertOwnedProcessGroupLeader(
            appServerProcessGroupId,
            "app-server"
          );
          await waitForSocket(socketPath, appServer, appOutput);
          const appServerPid = appServerProcessGroupId;
          appSocketIdentity = socketIdentity(socketPath);
          expect(isProcessAlive(appServerPid)).toBe(true);
          expect(lstatSync(root).mode & 0o077).toBe(0);
          expect(lstatSync(runtimeDir).mode & 0o077).toBe(0);

          const buffered: Array<{
            readonly message: CodexConnectionNotification;
            readonly generation: number;
          }> = [];
          const normalizedEvents: Array<{
            readonly method: string;
            readonly thread_id: CodexThreadId | null;
            readonly turn_id: CodexTurnId | null;
          }> = [];
          const requestRecords: Array<{
            readonly method: string;
            readonly thread_id: string | null;
          }> = [];
          const unmanagedThreadIds = new Set<CodexThreadId>();
          let callbackMode: "buffering" | "live" = "buffering";
          let unmanagedObservationCount = 0;
          let publicationCount = 0;
          let retainedEventCount = 0;
          let expectedGenerationA: number | null = null;
          const connectionAClose: {
            current: {
              readonly code: number;
              readonly clean: boolean;
              readonly reason_class: string;
            } | null;
          } = { current: null };
          let connectionATransportError = "none";
          let connectionATransportCause = "none";
          let maximumInboundMessageBytes = 0;
          let tuiATeardownStage: "before" | "during" | "after" = "before";
          let connectionACloseStage = "none";

          const consume = (
            message: CodexConnectionNotification,
            generation: number
          ): Promise<void> => {
            if (pipeline === null) {
              return Promise.reject(
                new Error("Coexistence pipeline is unavailable.")
              );
            }
            return pipeline.consume(message, generation).then((result) => {
              if (result.kind === "unmanaged_observation") {
                unmanagedObservationCount += 1;
                unmanagedThreadIds.add(result.thread_id);
              }
            });
          };

          const transportA = createCodexUnixWebSocketTransport({
            socket_path: socketPath
          });
          transportA.subscribe((event) => {
            if (event.type === "message") {
              maximumInboundMessageBytes = Math.max(
                maximumInboundMessageBytes,
                Buffer.byteLength(event.text, "utf8")
              );
              return;
            }
            if (event.type === "error") {
              if (connectionATransportError === "none") {
                connectionATransportError = classifyTransportError(
                  event.error.message
                );
                connectionATransportCause = classifyTransportCause(
                  event.error.cause
                );
              }
              return;
            }
            if (event.type !== "close" || connectionAClose.current !== null) {
              return;
            }
            connectionAClose.current = {
              code: event.code,
              clean: event.clean,
              reason_class: classifyTransportCloseReason(event.reason)
            };
            connectionACloseStage = tuiATeardownStage;
          });
          connectionA = createCodexAppServerConnection({
            transport: transportA,
            observed_version: codexBindingDescriptor.codex_version,
            on_notification(message) {
              if (connectionA === null) return;
              let generation: number;
              try {
                generation = connectionA.generation;
              } catch (error) {
                backgroundErrors.push(asError(error));
                return;
              }
              if (
                expectedGenerationA !== null &&
                generation !== expectedGenerationA
              ) {
                backgroundErrors.push(
                  new Error("HostDeck connection A generation changed.")
                );
                return;
              }
              if (callbackMode === "buffering") {
                if (buffered.length >= maximumBufferedNotifications) {
                  backgroundErrors.push(
                    new Error("Coexistence notification buffer is exhausted.")
                  );
                  return;
                }
                buffered.push({ message, generation });
                return;
              }
              track(consume(message, generation), pending, backgroundErrors);
            }
          });
          await connectionA.connect(AbortSignal.timeout(10_000));
          const liveConnectionA = connectionA;
          expectedGenerationA = connectionA.generation;
          expect(expectedGenerationA).toBeGreaterThan(0);
          expect(connectionA.compatibility).toMatchObject({
            state: "ready",
            observed_version: "0.144.0",
            mutation_policy: "allowed"
          });

          const portA = recordingPort(connectionA, requestRecords);
          const threadsA = createCodexThreadClient(portA);
          const reconciliationA = createCodexReconciliationReadClient(
            portA,
            defaultResourceBudget
          );
          const managed = await createMaterializedThread(
            threadsA,
            managedProject,
            "op_coexist_managed_0001",
            "hostdeck-coexist-managed"
          );
          managedThreadId = managed.id;
          const foreign = await createMaterializedThread(
            threadsA,
            foreignProject,
            "op_coexist_foreign_0001",
            "hostdeck-coexist-foreign"
          );
          foreignThreadId = foreign.id;
          expect(foreignThreadId).not.toBe(managedThreadId);

          const selectedModel = selectBoundedModel(
            (await createCodexModelClient(portA).listCatalog()).models
          );
          database = openMigratedDatabase(databasePath, {
            now: () => new Date()
          });
          const repository = createSelectedStateRepository(database.db);
          repository.create(
            selectedState(
              managedThreadId,
              managedProject,
              selectedModel.model.runtime_model
            )
          );
          const append = createProductionProjectionAppendPort({
            repository,
            publish() {
              publicationCount += 1;
            }
          });
          pipeline = createCodexEventPipeline({
            repository,
            append_port: append,
            normalizer: { now: monotonicIsoClock() },
            observe_event(event) {
              recordNormalizedEvent(normalizedEvents, event);
            }
          });
          callbackMode = "live";
          for (const entry of buffered.splice(0)) {
            await consume(entry.message, entry.generation);
          }
          await pipeline.barrier();
          await waitFor(
            () => pending.size === 0,
            2_000,
            "Coexistence callback work did not drain."
          );
          assertNoBackgroundErrors(backgroundErrors);
          expect(pipeline.pending_count).toBe(0);
          expect(repository.list()).toHaveLength(1);
          expect(repository.getByThreadId(foreignThreadId)).toBeNull();
          expect(unmanagedObservationCount).toBeGreaterThan(0);
          expect(unmanagedObservationCount).toBeLessThanOrEqual(
            maximumDiagnosticEntries
          );
          expect(unmanagedThreadIds.size).toBe(1);
          expect(unmanagedThreadIds.has(foreignThreadId)).toBe(true);
          expect(
            normalizedEvents.some(
              (event) => event.thread_id === foreignThreadId
            )
          ).toBe(false);

          const tuiACommand = buildCodexTuiResumeCommand({
            socket_path: socketPath,
            thread_id: managedThreadId,
            codex_bin: codexBin
          });
          tuiA = await startTui({
            command: tuiACommand,
            codex_home: codexHome,
            cwd: managedProject,
            tmux_socket_path: tuiASocketPath,
            expected_text: basename(managedProject)
          });
          const tuiAPid = tuiA.pid;
          expect(tuiA.output).toContain("OpenAI Codex");
          expect(tuiA.output).toContain(basename(managedProject));
          expect(readBoundedProcessCommandLine(tuiAPid)).toContain(
            managedThreadId
          );

          const accepted = await createCodexTurnClient(portA).startTurn({
            operation_id: "op_coexist_turn_0001",
            thread_id: managedThreadId,
            text: coexistencePrompt(markerPath),
            settings: {
              kind: "model",
              runtime_model: selectedModel.model.runtime_model,
              reasoning_effort: selectedModel.reasoning_effort
            }
          });
          expect(accepted.thread_id).toBe(managedThreadId);
          await waitFor(
            async () => {
              await pipeline?.barrier();
              assertNoBackgroundErrors(backgroundErrors);
              const projection = repository.require(
                "sess_tui_coexistence_001"
              ).projection.session;
              return (
                projection.turn_state === "in_progress" &&
                readMarker(markerPath) === "started" &&
                countNormalizedTurnEvent(
                  normalizedEvents,
                  "turn/started",
                  accepted.turn_id
                ) === 1
              );
            },
            90_000,
            "Shared coexistence turn did not enter its command interval."
          );
          await tuiA.waitForText(sentinel, 10_000);
          tuiA.assertAlive();
          expect(readMarker(markerPath)).toBe("started");
          expect(isProcessAlive(appServerPid)).toBe(true);
          expect(socketIdentity(socketPath)).toBe(appSocketIdentity);

          tuiATeardownStage = "during";
          await tuiA.close();
          tuiATeardownStage = "after";
          tuiA = null;
          try {
            await waitFor(
              async () => {
                await pipeline?.barrier();
                assertNoBackgroundErrors(backgroundErrors);
                if (
                  liveConnectionA.state !== "ready" ||
                  !isProcessAlive(appServerPid) ||
                  !isProcessGroupAlive(appServerPid) ||
                  !socketMatchesIdentity(socketPath, appSocketIdentity)
                ) {
                  throw new Error(
                    "Coexistence runtime disconnected before shared-turn completion."
                  );
                }
                return (
                  readMarker(markerPath) === "finished" &&
                  repository.require("sess_tui_coexistence_001")
                    .projection.session.turn_state === "completed" &&
                  countNormalizedTurnEvent(
                    normalizedEvents,
                    "turn/completed",
                    accepted.turn_id
                  ) === 1
                );
              },
              120_000,
              "HostDeck did not observe the shared turn complete after TUI A closed."
            );
          } catch (error) {
            let runtimeReadSucceeded = false;
            let runtimeIdle = false;
            let runtimeWaitingOnApproval = false;
            let runtimeWaitingOnUserInput = false;
            let latestTurnStatus = "read_failed";
            try {
              const runtimeThread = await threadsA.read(managedThreadId);
              runtimeReadSucceeded = true;
              runtimeIdle = runtimeThread.status === "idle";
              runtimeWaitingOnApproval = runtimeThread.active_flags.includes(
                "waiting_on_approval"
              );
              runtimeWaitingOnUserInput = runtimeThread.active_flags.includes(
                "waiting_on_user_input"
              );
            } catch {
              // The bounded diagnostic below records only the failed read.
            }
            try {
              latestTurnStatus =
                (await reconciliationA.readLatestTurn(managedThreadId))
                  ?.status ?? "missing";
            } catch {
              // The bounded diagnostic below records only the failed read.
            }
            const marker = readMarker(markerPath);
            const markerState =
              marker === null
                ? "missing"
                : marker === "started" || marker === "finished"
                  ? marker
                  : "unexpected";
            const projection = repository.require(
              "sess_tui_coexistence_001"
            ).projection.session;
            const appDiagnostics = appOutput.read();
            throw new Error(
              [
                "HostDeck shared-turn completion diagnostic:",
                `marker=${markerState}`,
                `projection=${projection.turn_state}`,
                `normalized_completion=${countNormalizedTurnEvent(
                  normalizedEvents,
                  "turn/completed",
                  accepted.turn_id
                )}`,
                `runtime_read=${String(runtimeReadSucceeded)}`,
                `runtime_idle=${String(runtimeIdle)}`,
                `runtime_waiting_approval=${String(
                  runtimeWaitingOnApproval
                )}`,
                `runtime_waiting_input=${String(
                  runtimeWaitingOnUserInput
                )}`,
                `latest_turn=${latestTurnStatus}`,
                `pipeline_failed=${String(pipeline.failure !== null)}`,
                `pending=${pipeline.pending_count}`,
                `pending_server_requests=${
                  liveConnectionA.pending_server_request_count
                }`,
                `maximum_inbound_message_bytes=${maximumInboundMessageBytes}`,
                `connection_ready=${String(
                  liveConnectionA.state === "ready"
                )}`,
                `transport_open=${String(transportA.state === "open")}`,
                `transport_close_code=${
                  connectionAClose.current?.code ?? 0
                }`,
                `transport_close_clean=${String(
                  connectionAClose.current?.clean ?? false
                )}`,
                `transport_close_reason=${
                  connectionAClose.current?.reason_class ?? "none"
                }`,
                `transport_error=${connectionATransportError}`,
                `transport_cause=${connectionATransportCause}`,
                `transport_close_stage=${connectionACloseStage}`,
                `generation_stable=${String(
                  liveConnectionA.generation === expectedGenerationA
                )}`,
                `app_process_alive=${String(
                  isProcessAlive(appServerPid)
                )}`,
                `app_group_alive=${String(
                  isProcessGroupAlive(appServerPid)
                )}`,
                `app_socket_stable=${String(
                  socketMatchesIdentity(socketPath, appSocketIdentity)
                )}`,
                `app_logged_shutdown_signal=${String(
                  appDiagnostics.includes("shutdown signal")
                )}`,
                `app_logged_queue_disconnect=${String(
                  appDiagnostics.includes("outbound queue")
                )}`,
                `app_logged_receive_error=${String(
                  appDiagnostics.includes("websocket receive error")
                )}`,
                `app_logged_disconnected_drop=${String(
                  appDiagnostics.includes("disconnected connection")
                )}`,
                `app_logged_router_exit=${String(
                  appDiagnostics.includes("outbound router task exited")
                )}`,
                `app_logged_panic=${String(
                  appDiagnostics.toLowerCase().includes("panic")
                )}`,
                `app_output_overflow=${String(appOutput.overflowed())}`,
                `app_spawn_failed=${String(appOutput.failure() !== null)}`
              ].join(" "),
              { cause: error }
            );
          }
          await pipeline.barrier();
          await waitFor(
            () => pending.size === 0,
            2_000,
            "Coexistence terminal callback work did not drain."
          );
          assertNoBackgroundErrors(backgroundErrors);
          expect(pipeline.pending_count).toBe(0);
          expect(connectionA.state).toBe("ready");
          expect(connectionA.generation).toBe(expectedGenerationA);
          expect(await threadsA.read(managedThreadId)).toMatchObject({
            id: managedThreadId,
            cwd: managedProject,
            status: "idle"
          });

          const retained = repository.listEvents(
            "sess_tui_coexistence_001"
          ).events;
          const retainedTurnStates = retained.flatMap((event) =>
            event.type === "turn" && event.turn_id === accepted.turn_id
              ? [event.state]
              : []
          );
          expect(retainedTurnStates).toEqual([
            "in_progress",
            "completed"
          ]);
          expect(
            retained.some((event) => event.type === "replay_boundary")
          ).toBe(false);
          expect(retained.map((event) => event.cursor)).toEqual(
            retained.map((_, index) => index + 1)
          );
          expect(
            requestRecords.filter((record) => record.method === "turn/start")
          ).toEqual([
            { method: "turn/start", thread_id: managedThreadId }
          ]);
          expect(repository.list()).toHaveLength(1);
          expect(repository.getByThreadId(foreignThreadId)).toBeNull();
          expect(unmanagedThreadIds.size).toBe(1);
          expect(unmanagedThreadIds.has(foreignThreadId)).toBe(true);
          expect(
            normalizedEvents.some(
              (event) => event.thread_id === foreignThreadId
            )
          ).toBe(false);
          expect(pipeline.failure).toBeNull();
          expect(publicationCount).toBe(retained.length);

          const tuiBCommand = buildCodexTuiResumeCommand({
            socket_path: socketPath,
            thread_id: managedThreadId,
            codex_bin: codexBin
          });
          tuiB = await startTui({
            command: tuiBCommand,
            codex_home: codexHome,
            cwd: managedProject,
            tmux_socket_path: tuiBSocketPath,
            expected_text: sentinel
          });
          const tuiBPid = tuiB.pid;
          expect(tuiBPid).not.toBe(tuiAPid);
          tuiB.assertAlive();
          expect(tuiB.output).toContain(sentinel);

          await pipeline.barrier();
          await connectionA.close(
            "HostDeck coexistence connection A is stopping."
          );
          connectionAClosed = true;
          await pipeline.barrier();
          await waitFor(
            () => pending.size === 0,
            2_000,
            "Coexistence callback work remained after HostDeck A close."
          );
          assertNoBackgroundErrors(backgroundErrors);
          expect(pipeline.pending_count).toBe(0);
          const finalRetained = repository.listEvents(
            "sess_tui_coexistence_001"
          ).events;
          expect(finalRetained.map((event) => event.cursor)).toEqual(
            finalRetained.map((_, index) => index + 1)
          );
          expect(
            finalRetained.some((event) => event.type === "replay_boundary")
          ).toBe(false);
          expect(
            finalRetained.flatMap((event) =>
              event.type === "turn" && event.turn_id === accepted.turn_id
                ? [event.state]
                : []
            )
          ).toEqual(["in_progress", "completed"]);
          expect(
            countNormalizedTurnEvent(
              normalizedEvents,
              "turn/started",
              accepted.turn_id
            )
          ).toBe(1);
          expect(
            countNormalizedTurnEvent(
              normalizedEvents,
              "turn/completed",
              accepted.turn_id
            )
          ).toBe(1);
          retainedEventCount = finalRetained.length;
          expect(publicationCount).toBe(retainedEventCount);
          tuiB.assertAlive();
          expect((await tuiB.capture()).output).toContain(sentinel);
          expect(isProcessAlive(appServerPid)).toBe(true);
          expect(socketIdentity(socketPath)).toBe(appSocketIdentity);

          connectionB = createCodexAppServerConnection({
            transport: createCodexUnixWebSocketTransport({
              socket_path: socketPath
            }),
            observed_version: codexBindingDescriptor.codex_version
          });
          await connectionB.connect(AbortSignal.timeout(10_000));
          expect(connectionB.compatibility).toMatchObject({
            state: "ready",
            observed_version: "0.144.0",
            mutation_policy: "allowed"
          });
          const threadsB = createCodexThreadClient(connectionB);
          expect(await threadsB.read(managedThreadId)).toMatchObject({
            id: managedThreadId,
            cwd: managedProject,
            status: "idle"
          });
          expect(isProcessAlive(tuiBPid)).toBe(true);

          await tuiB.close();
          tuiB = null;
          expect(await threadsB.read(managedThreadId)).toMatchObject({
            id: managedThreadId,
            cwd: managedProject,
            status: "idle"
          });
          expect(connectionB.state).toBe("ready");
          expect(isProcessAlive(appServerPid)).toBe(true);
          expect(socketIdentity(socketPath)).toBe(appSocketIdentity);

          await threadsB.archive(managedThreadId);
          threadsArchived += 1;
          await threadsB.archive(foreignThreadId);
          threadsArchived += 1;
          expect(threadsArchived).toBe(2);
          await connectionB.close(
            "HostDeck coexistence connection B is stopping."
          );
          connectionBClosed = true;
          database.db.close();
          databaseClosed = true;
          expect(appOutput.overflowed()).toBe(false);

          evidence = Object.freeze({
            schema_version: 1,
            task: "INT-V1-031",
            observed_at: new Date().toISOString(),
            hostdeck_commit: currentCommit(),
            runtime: {
              version: "0.144.0",
              exact_binding: true,
              app_server_process_count: 1,
              app_server_identity_stable: true,
              private_unix_socket_stable: true,
              maximum_inbound_message_bytes: maximumInboundMessageBytes
            },
            clients: {
              hostdeck_connection_count: 2,
              tui_process_count: 2,
              tui_processes_distinct: true,
              managed_thread_identity_stable: true,
              managed_cwd_identity_stable: true
            },
            shared_turn: {
              model_turn_count: 1,
              turn_start_request_count: 1,
              normalized_start_count: 1,
              normalized_completion_count: 1,
              durable_turn_event_count: 2,
              started_while_tui_alive: true,
              tui_rendered_shared_turn: true,
              completed_after_tui_close: true,
              marker_start_and_finish_observed: true
            },
            teardown: {
              tui_close_preserved_hostdeck_generation: true,
              tui_close_preserved_hostdeck_pipeline: true,
              hostdeck_close_preserved_tui: true,
              hostdeck_close_preserved_runtime: true,
              replacement_hostdeck_read_same_thread: true,
              second_tui_close_preserved_hostdeck: true
            },
            integrity: {
              pipeline_failure_count: 0,
              replay_boundary_count: 0,
              duplicate_turn_event_count: 0,
              unmanaged_observation_count: unmanagedObservationCount,
              durable_mapping_count: 1,
              foreign_mapping_count: 0,
              publication_count: publicationCount,
              retained_event_count: retainedEventCount
            },
            privacy: {
              contains_pid: false,
              contains_path: false,
              contains_socket_identity: false,
              contains_thread_or_turn_id: false,
              contains_model_prompt_tui_output_or_auth: false
            },
            cleanup: {
              tui_processes_remaining: 0,
              tmux_sockets_remaining: 0,
              hostdeck_connections_closed: 2,
              runtime_threads_archived: 2,
              database_closed: databaseClosed,
              app_server_stopped_by_outer_owner: false,
              app_server_socket_remaining: true,
              temporary_root_removed: false
            }
          } satisfies CoexistenceEvidence);
        } catch (error) {
          primaryError = error;
        } finally {
          if (tuiA !== null) {
            await collectCleanup(tuiA.close(), cleanupErrors);
          }
          if (tuiB !== null) {
            await collectCleanup(tuiB.close(), cleanupErrors);
          }
          if (connectionB !== null && !connectionBClosed) {
            await collectCleanup(
              connectionB.close("HostDeck coexistence cleanup."),
              cleanupErrors
            );
          }
          if (connectionA !== null && !connectionAClosed) {
            await collectCleanup(
              connectionA.close("HostDeck coexistence cleanup."),
              cleanupErrors
            );
          }
          if (pipeline !== null) {
            await collectCleanup(
              pipeline
                .barrier()
                .then(() =>
                  waitFor(
                    () => pending.size === 0,
                    5_000,
                    "Coexistence callback work remained during cleanup."
                  )
                ),
              cleanupErrors
            );
          }
          if (database !== null && !databaseClosed) {
            try {
              database.db.close();
              databaseClosed = true;
            } catch (error) {
              cleanupErrors.push(error);
            }
          }
          let appServerStoppedByOuterOwner = false;
          try {
            appServerStoppedByOuterOwner =
              appServerProcessGroupId === null
                ? await stopChild(appServer)
                : await stopAppServerProcessGroup(
                    appServer,
                    appServerProcessGroupId
                  );
          } catch (error) {
            cleanupErrors.push(error);
          }
          if (existsSync(socketPath)) {
            try {
              removeStoppedSocket(
                appServer,
                socketPath,
                appSocketIdentity
              );
            } catch (error) {
              cleanupErrors.push(error);
            }
          }
          try {
            rmSync(join(codexHome, "auth.json"), { force: true });
          } catch (error) {
            cleanupErrors.push(error);
          }
          if (cleanupErrors.length === 0) {
            try {
              rmSync(root, {
                recursive: true,
                force: true,
                maxRetries: 5
              });
            } catch (error) {
              cleanupErrors.push(error);
            }
          }
          if (evidence !== null && !appServerStoppedByOuterOwner) {
            cleanupErrors.push(
              new Error(
                "Coexistence app-server was not stopped by its outer owner."
              )
            );
          }
          if (evidence !== null && appOutput.overflowed()) {
            cleanupErrors.push(
              new Error("Coexistence app-server exceeded its output bound.")
            );
          }
        }

        if (evidence !== null && existsSync(root)) {
          cleanupErrors.push(
            new Error("Coexistence temporary root remains after cleanup.")
          );
        }
        if (primaryError !== null || cleanupErrors.length > 0) {
          rmSync(evidencePath, { force: true });
          const errors = [
            ...(primaryError === null ? [] : [primaryError]),
            ...cleanupErrors
          ];
          throw errors.length === 1
            ? errors[0]
            : new AggregateError(
                errors,
                "HostDeck/TUI coexistence and cleanup failed."
              );
        }
        if (evidence === null) {
          throw new Error("HostDeck/TUI coexistence evidence was not assembled.");
        }
        const completedEvidence: CoexistenceEvidence = {
          ...evidence,
          cleanup: {
            tui_processes_remaining: 0,
            tmux_sockets_remaining: 0,
            hostdeck_connections_closed: 2,
            runtime_threads_archived: 2,
            database_closed: true,
            app_server_stopped_by_outer_owner: true,
            app_server_socket_remaining: false,
            temporary_root_removed: true
          }
        };
        writeCodexSmokePrivateJson(evidencePath, completedEvidence);
        expect(readCodexSmokePrivateJson(evidencePath)).toEqual(
          completedEvidence
        );
      },
      overallTimeoutMs
    );
  }
);

interface CoexistenceEvidence {
  readonly schema_version: 1;
  readonly task: "INT-V1-031";
  readonly observed_at: string;
  readonly hostdeck_commit: string;
  readonly runtime: {
    readonly version: "0.144.0";
    readonly exact_binding: true;
    readonly app_server_process_count: 1;
    readonly app_server_identity_stable: true;
    readonly private_unix_socket_stable: true;
    readonly maximum_inbound_message_bytes: number;
  };
  readonly clients: {
    readonly hostdeck_connection_count: 2;
    readonly tui_process_count: 2;
    readonly tui_processes_distinct: true;
    readonly managed_thread_identity_stable: true;
    readonly managed_cwd_identity_stable: true;
  };
  readonly shared_turn: {
    readonly model_turn_count: 1;
    readonly turn_start_request_count: 1;
    readonly normalized_start_count: 1;
    readonly normalized_completion_count: 1;
    readonly durable_turn_event_count: 2;
    readonly started_while_tui_alive: true;
    readonly tui_rendered_shared_turn: true;
    readonly completed_after_tui_close: true;
    readonly marker_start_and_finish_observed: true;
  };
  readonly teardown: {
    readonly tui_close_preserved_hostdeck_generation: true;
    readonly tui_close_preserved_hostdeck_pipeline: true;
    readonly hostdeck_close_preserved_tui: true;
    readonly hostdeck_close_preserved_runtime: true;
    readonly replacement_hostdeck_read_same_thread: true;
    readonly second_tui_close_preserved_hostdeck: true;
  };
  readonly integrity: {
    readonly pipeline_failure_count: 0;
    readonly replay_boundary_count: 0;
    readonly duplicate_turn_event_count: 0;
    readonly unmanaged_observation_count: number;
    readonly durable_mapping_count: 1;
    readonly foreign_mapping_count: 0;
    readonly publication_count: number;
    readonly retained_event_count: number;
  };
  readonly privacy: {
    readonly contains_pid: false;
    readonly contains_path: false;
    readonly contains_socket_identity: false;
    readonly contains_thread_or_turn_id: false;
    readonly contains_model_prompt_tui_output_or_auth: false;
  };
  readonly cleanup: {
    readonly tui_processes_remaining: 0;
    readonly tmux_sockets_remaining: 0;
    readonly hostdeck_connections_closed: 2;
    readonly runtime_threads_archived: 2;
    readonly database_closed: boolean;
    readonly app_server_stopped_by_outer_owner: boolean;
    readonly app_server_socket_remaining: boolean;
    readonly temporary_root_removed: boolean;
  };
}

interface TuiProbe {
  readonly pid: number;
  readonly output: string;
  readonly assertAlive: () => void;
  readonly capture: () => Promise<{
    readonly output: string;
    readonly pane_dead: boolean;
  }>;
  readonly waitForText: (text: string, timeoutMs: number) => Promise<void>;
  readonly close: () => Promise<void>;
}

function startAppServer(
  binary: string,
  socketPath: string,
  codexHome: string,
  cwd: string
): ChildProcess {
  return spawn(
    binary,
    [
      "-c",
      'sandbox_mode="danger-full-access"',
      "-c",
      'approval_policy="never"',
      "app-server",
      "--listen",
      `unix://${socketPath}`
    ],
    {
      cwd,
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
      shell: false
    }
  );
}

function captureBoundedChildOutput(child: ChildProcess): {
  readonly read: () => string;
  readonly overflowed: () => boolean;
  readonly failure: () => Error | null;
} {
  let output = "";
  let bytes = 0;
  let overflow = false;
  let failure: Error | null = null;
  child.stderr?.on("data", (chunk: Buffer) => {
    bytes += chunk.byteLength;
    if (bytes > maximumOutputBytes) overflow = true;
    output = `${output}${chunk.toString("utf8")}`.slice(
      -maximumOutputBytes
    );
  });
  child.on("error", (error) => {
    failure ??= error;
  });
  return {
    read: () => output,
    overflowed: () => overflow,
    failure: () => failure
  };
}

async function waitForSocket(
  path: string,
  child: ChildProcess,
  output: ReturnType<typeof captureBoundedChildOutput>
): Promise<void> {
  await waitFor(
    () => {
      if (output.overflowed()) {
        throw new Error("Coexistence app-server exceeded its output bound.");
      }
      if (output.failure() !== null) {
        throw new Error("Coexistence app-server could not be started.", {
          cause: output.failure() ?? undefined
        });
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `Coexistence app-server exited before readiness: ${
            output.read() || "empty"
          }`
        );
      }
      try {
        return lstatSync(path).isSocket();
      } catch (error) {
        if (isErrno(error, "ENOENT")) return false;
        throw error;
      }
    },
    10_000,
    "Coexistence app-server did not create its Unix socket."
  );
}

function prepareCodexHome(destination: string): void {
  const sourceHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const source = join(sourceHome, "auth.json");
  const metadata = lstatSync(source);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o077) !== 0 ||
    (process.getuid !== undefined && metadata.uid !== process.getuid())
  ) {
    throw new Error(
      "Exact coexistence proof requires one private regular Codex auth.json."
    );
  }
  mkdirSync(destination, { mode: 0o700 });
  const copied = join(destination, "auth.json");
  copyFileSync(source, copied);
  chmodSync(copied, 0o600);
}

function initializeGitRepository(path: string): void {
  execFileSync("git", ["init", "-q", "-b", "main", path], {
    timeout: 10_000,
    maxBuffer: maximumOutputBytes
  });
  writeFileSync(join(path, "README.md"), "# Coexistence proof\n", {
    mode: 0o600
  });
}

async function createMaterializedThread(
  threads: ReturnType<typeof createCodexThreadClient>,
  cwd: string,
  operationId: string,
  name: string
) {
  const started = await threads.start({ operation_id: operationId, cwd });
  return threads.ensureMaterialized({
    thread_id: started.thread.id,
    operation_id: operationId,
    cwd,
    name
  });
}

function selectBoundedModel(models: readonly ModelCatalogEntry[]): {
  readonly model: ModelCatalogEntry;
  readonly reasoning_effort: string;
} {
  for (const family of [/mini/iu, /spark/iu]) {
    for (const model of models) {
      if (
        !family.test(
          `${model.id} ${model.runtime_model} ${model.label}`
        )
      ) {
        continue;
      }
      const effort =
        model.reasoning_efforts.find(
          (candidate) => candidate.id === "minimal"
        ) ??
        model.reasoning_efforts.find(
          (candidate) => candidate.id === "low"
        );
      if (effort !== undefined) {
        return { model, reasoning_effort: effort.id };
      }
    }
  }
  throw new Error(
    "Exact Codex exposes no mini or spark model with minimal or low reasoning effort."
  );
}

function selectedState(
  threadId: CodexThreadId,
  cwd: string,
  model: string
) {
  const now = new Date().toISOString();
  const mapping = selectedSessionMappingRecordSchema.parse({
    id: "sess_tui_coexistence_001",
    name: "tui-coexistence",
    codex_thread_id: threadId,
    cwd,
    runtime_source: "codex_app_server",
    runtime_version: codexBindingDescriptor.codex_version,
    disposition: "selected",
    created_at: now,
    updated_at: now,
    archived_at: null
  });
  const projection = selectedSessionProjectionRecordSchema.parse({
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
      updated_at: now,
      last_activity_at: now,
      branch: "main",
      model,
      settings: null,
      goal: null,
      recent_summary: "Exact HostDeck/TUI coexistence proof.",
      last_event_cursor: null
    },
    retained_event_count: 0,
    retained_event_bytes: 0,
    earliest_retained_cursor: null,
    retention_boundary_cursor: null
  });
  return { mapping, projection };
}

function recordingPort(
  connection: CodexAppServerConnection,
  records: Array<{
    readonly method: string;
    readonly thread_id: string | null;
  }>
) {
  return {
    get compatibility() {
      return connection.compatibility;
    },
    get generation() {
      return connection.generation;
    },
    request(input: CodexRequestInput) {
      if (records.length >= maximumDiagnosticEntries) {
        throw new Error("Coexistence request ledger is exhausted.");
      }
      records.push({
        method: input.method,
        thread_id: requestThreadId(input.params)
      });
      return connection.request(input);
    }
  };
}

function requestThreadId(params: unknown): string | null {
  if (
    params === null ||
    typeof params !== "object" ||
    Array.isArray(params)
  ) {
    return null;
  }
  const value = (params as Record<string, unknown>).threadId;
  return typeof value === "string" ? value : null;
}

function recordNormalizedEvent(
  events: Array<{
    readonly method: string;
    readonly thread_id: CodexThreadId | null;
    readonly turn_id: CodexTurnId | null;
  }>,
  event: NormalizedCodexEvent
): void {
  if (events.length >= maximumDiagnosticEntries) {
    throw new Error("Coexistence normalized-event ledger is exhausted.");
  }
  events.push({
    method: event.method,
    thread_id: event.scope === "thread" ? event.thread_id : null,
    turn_id:
      "turn_id" in event && typeof event.turn_id === "string"
        ? event.turn_id
        : null
  });
}

function countNormalizedTurnEvent(
  events: readonly {
    readonly method: string;
    readonly turn_id: CodexTurnId | null;
  }[],
  method: "turn/completed" | "turn/started",
  turnId: CodexTurnId
): number {
  return events.filter(
    (event) => event.method === method && event.turn_id === turnId
  ).length;
}

function coexistencePrompt(markerPath: string): string {
  const quoted = shellQuote(markerPath);
  return [
    sentinel,
    "Use the shell tool exactly once to run this command:",
    `printf started > ${quoted}; sleep 20; printf finished > ${quoted}`,
    `Wait for it to finish, then reply with exactly ${sentinel}_DONE.`
  ].join("\n");
}

function readMarker(path: string): string | null {
  if (!existsSync(path)) return null;
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.size < 1 ||
    metadata.size > 32
  ) {
    throw new Error("Coexistence marker is invalid.");
  }
  return readFileSync(path, "utf8").trim();
}

function classifyTransportCloseReason(reason: string): string {
  const normalized = reason.toLowerCase();
  if (normalized.includes("heartbeat")) return "heartbeat";
  if (normalized.includes("socket")) return "socket";
  if (normalized.includes("hostdeck")) return "hostdeck_requested";
  if (normalized === "") return "empty";
  return "other";
}

function classifyTransportError(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes("heartbeat")) return "heartbeat";
  if (normalized.includes("protocol")) return "protocol";
  if (normalized.includes("queue") || normalized.includes("overload")) {
    return "overload";
  }
  return "other";
}

function classifyTransportCause(cause: unknown): string {
  if (!(cause instanceof Error)) return "none";
  const code =
    "code" in cause && typeof cause.code === "string"
      ? cause.code
      : "";
  if (/^[A-Z][A-Z0-9_]{0,63}$/u.test(code)) {
    return code;
  }
  return code === "" ? "no_code" : "other";
}

function socketMatchesIdentity(
  path: string,
  expectedIdentity: string | null
): boolean {
  if (expectedIdentity === null || !existsSync(path)) return false;
  try {
    return socketIdentity(path) === expectedIdentity;
  } catch {
    return false;
  }
}

async function startTui(input: {
  readonly command: ReturnType<typeof buildCodexTuiResumeCommand>;
  readonly codex_home: string;
  readonly cwd: string;
  readonly tmux_socket_path: string;
  readonly expected_text: string;
}): Promise<TuiProbe> {
  const threadId = input.command.args.at(-1);
  if (threadId === undefined) {
    throw new Error("Coexistence TUI command has no thread id.");
  }
  const args = [
    ...input.command.args.slice(0, -1),
    "--no-alt-screen",
    threadId
  ];
  const shellCommand = `exec ${[input.command.executable, ...args]
    .map(shellQuote)
    .join(" ")}`;
  const environment = {
    ...process.env,
    CODEX_HOME: input.codex_home,
    TERM: "xterm-256color"
  };
  let running = false;
  let processGroupStopped = false;
  let panePid: number | null = null;
  let tmuxServerPid: number | null = null;
  let tmuxSocketIdentity: string | null = null;
  let latestOutput = "";
  const capture = async () => {
    const output = (
      await runFile(
        "tmux",
        [
          "-S",
          input.tmux_socket_path,
          "capture-pane",
          "-p",
          "-t",
          "hostdeck-tui:0.0",
          "-S",
          "-1000"
        ],
        { env: environment }
      )
    ).stdout;
    const pane = (
      await runFile(
        "tmux",
        [
          "-S",
          input.tmux_socket_path,
          "display-message",
          "-p",
          "-t",
          "hostdeck-tui:0.0",
          "#{pane_dead}"
        ],
        { env: environment }
      )
    ).stdout.trim();
    if (pane !== "0" && pane !== "1") {
      throw new Error("Coexistence TUI pane state is invalid.");
    }
    latestOutput = output;
    return { output, pane_dead: pane === "1" };
  };
  try {
    await runFile(
      "tmux",
      [
        "-S",
        input.tmux_socket_path,
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-x",
        "120",
        "-y",
        "40",
        "-s",
        "hostdeck-tui"
      ],
      { cwd: input.cwd, env: environment }
    );
    running = true;
    tmuxServerPid = parsePositiveInteger(
      (
        await runFile(
          "tmux",
          [
            "-S",
            input.tmux_socket_path,
            "display-message",
            "-p",
            "#{pid}"
          ],
          { env: environment }
        )
      ).stdout.trim(),
      "tmux server pid"
    );
    tmuxSocketIdentity = socketIdentity(input.tmux_socket_path);
    if (
      !readBoundedProcessCommandLine(tmuxServerPid).includes(
        input.tmux_socket_path
      )
    ) {
      throw new Error("Coexistence tmux server identity is invalid.");
    }
    await runFile(
      "tmux",
      [
        "-S",
        input.tmux_socket_path,
        "set-option",
        "-g",
        "remain-on-exit",
        "on"
      ],
      { env: environment }
    );
    await runFile(
      "tmux",
      [
        "-S",
        input.tmux_socket_path,
        "respawn-pane",
        "-k",
        "-t",
        "hostdeck-tui:0.0",
        shellCommand
      ],
      { cwd: input.cwd, env: environment }
    );
    panePid = parsePositiveInteger(
      (
        await runFile(
          "tmux",
          [
            "-S",
            input.tmux_socket_path,
            "display-message",
            "-p",
            "-t",
            "hostdeck-tui:0.0",
            "#{pane_pid}"
          ],
          { env: environment }
        )
      ).stdout.trim(),
      "TUI pane pid"
    );
    assertOwnedProcessGroupLeader(panePid, "TUI");
    await waitFor(
      async () => {
        const snapshot = await capture();
        if (snapshot.pane_dead) {
          throw new Error("Coexistence TUI exited before inspection.");
        }
        return (
          snapshot.output.includes("OpenAI Codex") &&
          snapshot.output.includes(input.expected_text)
        );
      },
      10_000,
      "Coexistence TUI did not render its expected managed-thread view."
    );
    const fixedPid = panePid;
    const fixedTmuxServerPid = tmuxServerPid;
    const fixedTmuxSocketIdentity = tmuxSocketIdentity;
    const close = async () => {
      if (!running) return;
      if (!processGroupStopped) {
        const stopped = await stopOwnedProcessGroup(
          fixedPid,
          "Coexistence TUI"
        );
        processGroupStopped = true;
        if (!stopped) {
          throw new Error(
            "Coexistence TUI process group exited before owner teardown."
          );
        }
      }
      await stopTuiTmuxServer(
        input.tmux_socket_path,
        fixedTmuxServerPid,
        fixedTmuxSocketIdentity,
        environment
      );
      running = false;
      await waitFor(
        () =>
          !isProcessGroupAlive(fixedPid) &&
          !existsSync(input.tmux_socket_path),
        5_000,
        "Coexistence TUI process or tmux socket remained after close."
      );
    };
    return {
      pid: fixedPid,
      output: latestOutput,
      assertAlive() {
        if (
          !running ||
          !isProcessAlive(fixedPid) ||
          !isProcessGroupAlive(fixedPid)
        ) {
          throw new Error("Coexistence TUI process is not alive.");
        }
      },
      capture,
      async waitForText(text, timeoutMs) {
        await waitFor(
          async () => {
            const snapshot = await capture();
            if (snapshot.pane_dead) {
              throw new Error(
                "Coexistence TUI exited while waiting for shared work."
              );
            }
            return snapshot.output.includes(text);
          },
          timeoutMs,
          "Coexistence TUI did not render shared work."
        );
      },
      close
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (panePid !== null) {
      await collectCleanup(
        stopOwnedProcessGroup(
          panePid,
          "Failed coexistence TUI"
        ).then(() => undefined),
        cleanupErrors
      );
    }
    if (running) {
      const stopTmux =
        tmuxServerPid === null || tmuxSocketIdentity === null
          ? runFile(
              "tmux",
              ["-S", input.tmux_socket_path, "kill-server"],
              { env: environment }
            ).then(() => undefined)
          : stopTuiTmuxServer(
              input.tmux_socket_path,
              tmuxServerPid,
              tmuxSocketIdentity,
              environment
            );
      await collectCleanup(stopTmux, cleanupErrors);
    }
    await collectCleanup(
      waitFor(
        () =>
          (panePid === null || !isProcessGroupAlive(panePid)) &&
          !existsSync(input.tmux_socket_path),
        5_000,
        "Coexistence TUI process or socket remained after failed startup."
      ),
      cleanupErrors
    );
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Coexistence TUI inspection and cleanup failed."
      );
    }
    throw error;
  }
}

async function stopTuiTmuxServer(
  path: string,
  serverPid: number,
  expectedSocketIdentity: string,
  environment: NodeJS.ProcessEnv
): Promise<void> {
  await runFile("tmux", ["-S", path, "kill-server"], {
    env: environment
  });
  await waitFor(
    () => !isProcessAlive(serverPid),
    5_000,
    "Coexistence tmux server remained after owner teardown."
  );
  if (
    !existsSync(path) ||
    socketIdentity(path) !== expectedSocketIdentity
  ) {
    throw new Error(
      "Refusing to remove a missing or replaced coexistence tmux socket."
    );
  }
  rmSync(path);
  if (existsSync(path)) {
    throw new Error("Coexistence tmux socket remained after owner cleanup.");
  }
}

async function runFile(
  executable: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
  }
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill("SIGKILL");
      rejectRun(error);
    };
    const timeout = setTimeout(
      () => fail(new Error(`${executable} timed out.`)),
      5_000
    );
    timeout.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maximumOutputBytes) {
        fail(new Error(`${executable} stdout exceeded its byte bound.`));
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > maximumOutputBytes) {
        fail(new Error(`${executable} stderr exceeded its byte bound.`));
        return;
      }
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      fail(new Error(`Unable to start ${executable}.`, { cause: error }));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolveRun({ stdout, stderr });
        return;
      }
      rejectRun(
        new Error(
          `${executable} exited with ${String(
            code ?? signal ?? "unknown"
          )}: ${stderr || stdout || "empty"}`
        )
      );
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function monotonicIsoClock(): () => IsoTimestamp {
  let last = Date.now();
  return () => {
    last = Math.max(last + 1, Date.now());
    return new Date(last).toISOString() as IsoTimestamp;
  };
}

function track(
  operation: Promise<unknown>,
  pending: Set<Promise<unknown>>,
  errors: Error[]
): void {
  pending.add(operation);
  void operation.then(
    () => pending.delete(operation),
    (error: unknown) => {
      pending.delete(operation);
      errors.push(asError(error));
    }
  );
}

function assertNoBackgroundErrors(errors: readonly Error[]): void {
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      "HostDeck/TUI coexistence background work failed."
    );
  }
}

async function stopChild(child: ChildProcess): Promise<boolean> {
  if (child.pid === undefined) return false;
  if (child.exitCode !== null || child.signalCode !== null) return false;
  const exited = once(child, "exit").then(() => undefined);
  child.kill("SIGTERM");
  if (await settlesWithin(exited, 3_000)) return true;
  child.kill("SIGKILL");
  if (!(await settlesWithin(exited, 2_000))) {
    throw new Error("Coexistence app-server did not stop.");
  }
  return true;
}

async function stopAppServerProcessGroup(
  child: ChildProcess,
  processGroupId: number
): Promise<boolean> {
  const exited =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : once(child, "exit").then(() => undefined);
  const stopped = await stopOwnedProcessGroup(
    processGroupId,
    "Coexistence app-server"
  );
  if (!stopped) return false;
  if (!(await settlesWithin(exited, 2_000))) {
    throw new Error("Coexistence app-server launcher did not exit.");
  }
  return true;
}

async function stopOwnedProcessGroup(
  processGroupId: number,
  label: string
): Promise<boolean> {
  if (!isProcessGroupAlive(processGroupId)) return false;
  signalProcessGroup(processGroupId, "SIGTERM");
  if (await waitForProcessGroupAbsence(processGroupId, 3_000)) {
    return true;
  }
  signalProcessGroup(processGroupId, "SIGKILL");
  if (!(await waitForProcessGroupAbsence(processGroupId, 2_000))) {
    throw new Error(`${label} process group did not stop.`);
  }
  return true;
}

function signalProcessGroup(
  processGroupId: number,
  signal: NodeJS.Signals
): void {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (!isErrno(error, "ESRCH")) throw error;
  }
}

async function waitForProcessGroupAbsence(
  processGroupId: number,
  timeoutMs: number
): Promise<boolean> {
  const started = Date.now();
  while (isProcessGroupAlive(processGroupId)) {
    if (Date.now() - started >= timeoutMs) return false;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  return true;
}

function isProcessGroupAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (isErrno(error, "ESRCH")) return false;
    if (isErrno(error, "EPERM")) return true;
    throw error;
  }
}

function assertOwnedProcessGroupLeader(pid: number, label: string): void {
  const identity = readProcessGroupIdentity(pid);
  const current = readProcessGroupIdentity(process.pid);
  if (
    identity.process_group_id !== pid ||
    identity.session_id !== pid ||
    identity.process_group_id === current.process_group_id ||
    identity.session_id === current.session_id
  ) {
    throw new Error(`${label} does not own an isolated process group.`);
  }
}

function readProcessGroupIdentity(pid: number): {
  readonly process_group_id: number;
  readonly session_id: number;
} {
  const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  if (raw.length < 8 || raw.length > 8_192) {
    throw new Error("Coexistence process identity is invalid.");
  }
  const commandEnd = raw.lastIndexOf(") ");
  if (!raw.startsWith(`${pid} (`) || commandEnd < 3) {
    throw new Error("Coexistence process identity has an invalid shape.");
  }
  const fields = raw.slice(commandEnd + 2).trim().split(/\s+/u);
  if (fields.length < 20) {
    throw new Error("Coexistence process identity is incomplete.");
  }
  return {
    process_group_id: parsePositiveInteger(
      fields[2] ?? "",
      "process group id"
    ),
    session_id: parsePositiveInteger(fields[3] ?? "", "session id")
  };
}

function removeStoppedSocket(
  child: ChildProcess,
  path: string,
  expectedIdentity: string | null
): void {
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error(
      "Refusing to remove coexistence socket before app-server exit."
    );
  }
  if (expectedIdentity === null || socketIdentity(path) !== expectedIdentity) {
    throw new Error("Refusing to remove a replaced coexistence socket.");
  }
  rmSync(path);
  if (existsSync(path)) {
    throw new Error("Coexistence app-server socket remained after removal.");
  }
}

async function collectCleanup(
  operation: Promise<void>,
  errors: unknown[]
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    errors.push(error);
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  message: string
): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started >= timeoutMs) throw new Error(message);
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

async function settlesWithin(
  operation: Promise<void>,
  timeoutMs: number
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((resolveExpired) => {
    timeout = setTimeout(() => resolveExpired(false), timeoutMs);
    timeout.unref();
  });
  const result = await Promise.race([
    operation.then(() => true as const),
    expired
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  return result;
}

function parsePositiveInteger(value: string, label: string): number {
  if (!/^[1-9][0-9]{0,15}$/u.test(value)) {
    throw new Error(`Coexistence ${label} is invalid.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Coexistence ${label} is unsafe.`);
  }
  return parsed;
}

function requireChildPid(child: ChildProcess): number {
  if (!Number.isSafeInteger(child.pid) || (child.pid as number) < 1) {
    throw new Error("Coexistence app-server has no valid pid.");
  }
  return child.pid as number;
}

function currentCommit(): string {
  const status = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 256 * 1_024
    }
  ).trim();
  if (status !== "") {
    throw new Error("Coexistence evidence requires a clean worktree.");
  }
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: maximumOutputBytes
  }).trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error("Coexistence evidence commit is invalid.");
  }
  return commit;
}

function assertEvidencePath(path: string): void {
  const artifacts = resolve("artifacts");
  const relationship = relative(artifacts, path);
  if (
    !isAbsolute(path) ||
    relationship === "" ||
    relationship === ".." ||
    relationship.startsWith("../") ||
    isAbsolute(relationship) ||
    !path.endsWith(".json")
  ) {
    throw new Error(
      "Coexistence evidence path must be a JSON file under artifacts."
    );
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    String(error.code) === code
  );
}
