import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, copyFile, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CodexConnectionNotification,
  type CodexConnectionServerRequest,
  type CodexProtocolIssue,
  type CodexRequestInput,
  type CodexThreadClient,
  codexBindingDescriptor,
  createCodexAppServerConnection,
  createCodexSkillsClient,
  createCodexThreadClient,
  createCodexUnixWebSocketTransport,
  parseCodexCliVersionOutput
} from "@hostdeck/codex-adapter";
import {
  type SkillsSnapshot,
  selectedSessionMappingRecordSchema,
  selectedSessionProjectionRecordSchema
} from "@hostdeck/contracts";
import type { CodexThreadId } from "@hostdeck/core";
import type { SelectedSessionState } from "@hostdeck/storage";
import { describe, expect, it } from "vitest";
import { createCodexSkillsControlService } from "./codex-skills-control-service.js";
import { withTestOperationDeadlines } from "./test-operation-deadline.js";

const requireSmoke = process.env.HOSTDECK_REQUIRE_CODEX_SKILLS_SMOKE === "1";
const codexBin = process.env.HOSTDECK_CODEX_BIN ?? "codex";

describe.skipIf(!requireSmoke)("exact Codex skills-control smoke", () => {
  it(
    "lists each selected cwd independently without exposing raw discovery metadata",
    async () => {
      const version = parseCodexCliVersionOutput(
        execFileSync(codexBin, ["--version"], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 })
      );
      expect(version).toBe(codexBindingDescriptor.codex_version);

      const root = await mkdtemp(join(tmpdir(), "hostdeck-skills-smoke-"));
      const runtimeDirectory = join(root, "runtime");
      const codexHome = join(root, "codex-home");
      const projectA = join(root, "project-a");
      const projectB = join(root, "project-b");
      const socketPath = join(runtimeDirectory, "app.sock");
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

      const child = spawn(codexBin, ["app-server", "--listen", `unix://${socketPath}`], {
        env: { ...process.env, CODEX_HOME: codexHome },
        stdio: ["ignore", "ignore", "pipe"]
      });
      let appServerStderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        appServerStderr = boundedOutput(appServerStderr, chunk);
      });

      const notifications: CodexConnectionNotification[] = [];
      const protocolIssues: CodexProtocolIssue[] = [];
      const serverRequests: CodexConnectionServerRequest[] = [];
      const connection = createCodexAppServerConnection({
        transport: createCodexUnixWebSocketTransport({ socket_path: socketPath }),
        observed_version: version,
        on_notification: (message) => notifications.push(message),
        on_server_request: (message) => serverRequests.push(message),
        on_protocol_issue: (issue) => protocolIssues.push(issue)
      });
      const threadIds: CodexThreadId[] = [];
      let smokeError: Error | null = null;
      try {
        await waitForSocket(socketPath, child, () => appServerStderr);
        await connection.connect();
        const threads = createCodexThreadClient(connection);
        const threadA = await createManagedThread(threads, projectA, "a");
        const threadB = await createManagedThread(threads, projectB, "b");
        threadIds.push(threadA, threadB);

        const targetA = managedTarget("sess_skills_smoke_a", threadA);
        const targetB = managedTarget("sess_skills_smoke_b", threadB);
        const states = new Map<string, SelectedSessionState>([
          [targetA.session_id, selectedState(targetA, projectA, version)],
          [targetB.session_id, selectedState(targetB, projectB, version)]
        ]);
        const methods: string[] = [];
        const skills = createCodexSkillsClient({
          get compatibility() {
            return connection.compatibility;
          },
          get generation() {
            return connection.generation;
          },
          request(input: CodexRequestInput) {
            methods.push(input.method);
            return connection.request(input);
          }
        });
        const service = withTestOperationDeadlines(createCodexSkillsControlService({
          skills,
          states: { get: (sessionId) => states.get(sessionId) ?? null }
        }), ["list"]);
        const notificationMark = notifications.length;

        const firstA = await service.list(skillsIntent(targetA, "op_skills_smoke_a_0001"));
        const firstB = await service.list(skillsIntent(targetB, "op_skills_smoke_b_0001"));
        const repeatedA = await service.list(skillsIntent(targetA, "op_skills_smoke_a_repeat_0001"));

        for (const snapshot of [firstA, firstB, repeatedA]) assertPublicSnapshot(snapshot);
        expect(stableListing(firstA)).toEqual(stableListing(repeatedA));
        expect(firstA.target).toEqual(targetA);
        expect(firstB.target).toEqual(targetB);
        expect(methods).toEqual(["skills/list", "skills/list", "skills/list"]);
        expect(firstA.runtime_version).toBe("0.144.0");
        expect(firstA.connection_generation).toBe(connection.generation);
        expect(firstA.state).toBe("content");
        expect(firstB.state).toBe("content");
        expect(firstA.error_count).toBe(0);
        expect(firstB.error_count).toBe(0);
        expect(firstA.skills.length).toBeGreaterThan(0);
        expect(firstA.skills.length).toBeLessThanOrEqual(256);

        const publicJson = JSON.stringify([firstA, firstB, repeatedA]);
        expect(publicJson).not.toContain(root);
        expect(publicJson).not.toContain(projectA);
        expect(publicJson).not.toContain(projectB);
        expect(notifications.slice(notificationMark).some((event) => event.method === "turn/started")).toBe(false);
        expect(notifications.slice(notificationMark).some((event) => event.method.startsWith("item/"))).toBe(false);
        expect(serverRequests).toHaveLength(0);
        expect(protocolIssues).toHaveLength(0);

        const [threadAAfter, threadBAfter] = await Promise.all([threads.read(threadA), threads.read(threadB)]);
        expect(threadAAfter).toMatchObject({ id: threadA, status: "idle" });
        expect(threadBAfter).toMatchObject({ id: threadB, status: "idle" });
        expect(threadAAfter.archived).not.toBe(true);
        expect(threadBAfter.archived).not.toBe(true);

        await threads.archive(threadA);
        threadIds.shift();
        await threads.archive(threadB);
        threadIds.shift();
      } catch (error) {
        smokeError = new Error(
          `Real Codex skills control failed (threads=${threadIds.length}, notification_methods=${boundedMethodSummary(notifications)}, issues=${protocolIssues.map((issue) => issue.code).join(",") || "none"}, requests=${serverRequests.length}, stderr_bytes=${Buffer.byteLength(appServerStderr, "utf8")}).`,
          { cause: error }
        );
      }

      const cleanupErrors: unknown[] = [];
      if (connection.state === "ready" && threadIds.length > 0) {
        const threads = createCodexThreadClient(connection);
        for (const threadId of [...threadIds]) await collectCleanupError(threads.archive(threadId), cleanupErrors);
      }
      await collectCleanupError(connection.close("HostDeck skills-control smoke completed."), cleanupErrors);
      await collectCleanupError(stopChild(child), cleanupErrors);
      await collectCleanupError(rm(root, { recursive: true, force: true }), cleanupErrors);
      if (smokeError !== null && cleanupErrors.length > 0) {
        throw new AggregateError([smokeError, ...cleanupErrors], "Codex skills-control smoke and cleanup failed.");
      }
      if (smokeError !== null) throw smokeError;
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Codex skills-control cleanup failed.");
    },
    90_000
  );
});

interface ManagedTarget {
  readonly type: "managed_session";
  readonly session_id: string;
  readonly codex_thread_id: string;
}

async function createManagedThread(
  threads: CodexThreadClient,
  projectDirectory: string,
  suffix: "a" | "b"
): Promise<CodexThreadId> {
  const operationId = `op_skills_smoke_thread_${suffix}_0001`;
  const started = await threads.start({ operation_id: operationId, cwd: projectDirectory });
  await threads.ensureMaterialized({
    thread_id: started.thread.id,
    operation_id: operationId,
    cwd: projectDirectory,
    name: `hostdeck-skills-smoke-${suffix}`
  });
  return started.thread.id;
}

function managedTarget(sessionId: string, threadId: string): ManagedTarget {
  return { type: "managed_session", session_id: sessionId, codex_thread_id: threadId };
}

function skillsIntent(target: ManagedTarget, operationId: string) {
  return { operation_id: operationId, target, kind: "skills" } as const;
}

function selectedState(target: ManagedTarget, cwd: string, runtimeVersion: string): SelectedSessionState {
  const now = new Date().toISOString();
  return {
    mapping: selectedSessionMappingRecordSchema.parse({
      id: target.session_id,
      name: target.session_id,
      codex_thread_id: target.codex_thread_id,
      cwd,
      runtime_source: "codex_app_server",
      runtime_version: runtimeVersion,
      disposition: "selected",
      created_at: now,
      updated_at: now,
      archived_at: null
    }),
    projection: selectedSessionProjectionRecordSchema.parse({
      session: {
        id: target.session_id,
        name: target.session_id,
        codex_thread_id: target.codex_thread_id,
        cwd,
        runtime_source: "codex_app_server",
        runtime_version: runtimeVersion,
        created_at: now,
        archived_at: null,
        session_state: "active",
        turn_state: "idle",
        attention: "none",
        freshness: "current",
        freshness_reason: null,
        updated_at: now,
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

function assertPublicSnapshot(snapshot: SkillsSnapshot): void {
  expect(Object.keys(snapshot).sort()).toEqual([
    "connection_generation",
    "error_count",
    "observed_at",
    "runtime_version",
    "skills",
    "state",
    "target"
  ]);
  expect(new Set(snapshot.skills.map((skill) => skill.name)).size).toBe(snapshot.skills.length);
  expect(snapshot.skills.map((skill) => skill.name)).toEqual(
    [...snapshot.skills.map((skill) => skill.name)].sort(compareStrings)
  );
  for (const skill of snapshot.skills) {
    expect(Object.keys(skill).sort()).toEqual(["description", "enabled", "name", "scope"]);
    expect(["user", "repo", "system", "admin"]).toContain(skill.scope);
    expect(typeof skill.enabled).toBe("boolean");
  }
}

function stableListing(snapshot: SkillsSnapshot) {
  return { state: snapshot.state, skills: snapshot.skills, error_count: snapshot.error_count };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function waitForSocket(socketPath: string, child: ChildProcess, readStderr: () => string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started <= 5_000) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Codex app-server exited before creating its skills-smoke socket: ${readStderr()}`);
    }
    try {
      if ((await lstat(socketPath)).isSocket()) return;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Codex app-server did not create its skills-smoke socket: ${readStderr()}`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").then(() => undefined);
  child.kill("SIGTERM");
  if (await settlesWithin(exited, 2_000)) return;
  child.kill("SIGKILL");
  if (!(await settlesWithin(exited, 1_000))) throw new Error("Codex skills-smoke app-server did not exit after SIGKILL.");
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
    throw new Error("Installed Codex authentication must be a private regular auth.json file for the skills smoke.");
  }
  const destination = join(codexHome, "auth.json");
  await copyFile(source, destination);
  await chmod(destination, 0o600);
  const destinationMetadata = await lstat(destination);
  if (!destinationMetadata.isFile() || (destinationMetadata.mode & 0o077) !== 0) {
    throw new Error("Temporary Codex authentication copy is not private.");
  }
}

function boundedMethodSummary(notifications: readonly CodexConnectionNotification[]): string {
  return notifications.slice(-24).map((notification) => notification.method).join("|") || "none";
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
