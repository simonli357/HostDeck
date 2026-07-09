import { type ExecFileException, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  type AbsoluteCwd,
  type IsoTimestamp,
  type LifecycleState,
  type OutputCursor,
  parseAbsoluteCwd,
  parseIsoTimestamp,
  parseOutputCursor,
  parseSessionId,
  type SessionId,
  type SessionName,
  type ValidationResult
} from "@hostdeck/core";

export type TmuxAdapterErrorCode =
  | "duplicate_session"
  | "duplicate_session_name"
  | "invalid_cwd"
  | "invalid_output_cursor"
  | "invalid_start_command"
  | "invalid_target"
  | "missing_target"
  | "stale_target"
  | "target_not_running"
  | "tmux_unavailable";

export class HostDeckTmuxAdapterError extends Error {
  constructor(
    readonly code: TmuxAdapterErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostDeckTmuxAdapterError";
  }
}

export interface TmuxTarget {
  readonly sessionId: SessionId;
  readonly sessionName: SessionName;
  readonly cwd: AbsoluteCwd;
  readonly tmuxSession: string;
  readonly tmuxWindow: string | null;
  readonly tmuxPane: string;
  readonly lifecycleState: LifecycleState;
  readonly staleReason: string | null;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface TmuxStartSessionInput {
  readonly sessionId: SessionId;
  readonly sessionName: SessionName;
  readonly cwd: AbsoluteCwd;
  readonly command: readonly string[];
}

export interface TmuxSessionRef {
  readonly sessionId: SessionId;
}

export interface TmuxSendInput extends TmuxSessionRef {
  readonly text: string;
  readonly enter?: boolean;
}

export interface TmuxSentInput {
  readonly sessionId: SessionId;
  readonly tmuxPane: string;
  readonly text: string;
  readonly enter: boolean;
  readonly sentAt: IsoTimestamp;
}

export interface TmuxAttachMetadata {
  readonly sessionId: SessionId;
  readonly tmuxSession: string;
  readonly tmuxWindow: string | null;
  readonly tmuxPane: string;
  readonly command: readonly string[];
}

export interface TmuxOutputEvent {
  readonly sessionId: SessionId;
  readonly cursor: OutputCursor;
  readonly capturedAt: IsoTimestamp;
  readonly text: string;
}

export interface TmuxReadOutputInput extends TmuxSessionRef {
  readonly after?: OutputCursor | null;
  readonly limit?: number;
}

export interface TmuxAdapter {
  readonly startSession: (input: TmuxStartSessionInput) => Promise<TmuxTarget>;
  readonly listTargets: () => Promise<readonly TmuxTarget[]>;
  readonly getTarget: (sessionId: SessionId) => Promise<TmuxTarget | null>;
  readonly sendInput: (input: TmuxSendInput) => Promise<TmuxSentInput>;
  readonly stopSession: (input: TmuxSessionRef) => Promise<TmuxTarget>;
  readonly attachMetadata: (input: TmuxSessionRef) => Promise<TmuxAttachMetadata>;
  readonly readOutput: (input: TmuxReadOutputInput) => Promise<readonly TmuxOutputEvent[]>;
}

export interface RealTmuxTargetDiscoveryOptions {
  readonly tmuxBinary?: string;
  readonly socketName?: string;
}

export interface RealTmuxDiscoveredTarget {
  readonly sessionId: SessionId;
  readonly tmuxSession: string;
  readonly tmuxWindow: string;
  readonly tmuxPane: string;
  readonly currentPath: AbsoluteCwd;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface ExpectedTmuxTarget {
  readonly sessionId: SessionId;
  readonly sessionName: SessionName;
  readonly cwd: AbsoluteCwd;
  readonly tmuxSession?: string | null;
  readonly tmuxWindow?: string | null;
  readonly tmuxPane?: string | null;
  readonly createdAt?: IsoTimestamp | null;
}

export interface StaleTmuxTarget {
  readonly sessionId: SessionId;
  readonly sessionName: SessionName;
  readonly cwd: AbsoluteCwd;
  readonly tmuxSession: string;
  readonly staleReason: string;
}

export interface RealTmuxReconcileResult {
  readonly liveTargets: readonly TmuxTarget[];
  readonly staleTargets: readonly StaleTmuxTarget[];
  readonly unmanagedTargets: readonly RealTmuxDiscoveredTarget[];
}

export interface RealTmuxTargetDiscovery {
  readonly tmuxSessionNameForSession: (sessionId: SessionId) => string;
  readonly parseSessionIdFromTmuxSessionName: (tmuxSession: string) => SessionId | null;
  readonly listTargets: () => Promise<readonly RealTmuxDiscoveredTarget[]>;
  readonly getTargetBySessionId: (sessionId: SessionId) => Promise<RealTmuxDiscoveredTarget | null>;
  readonly reconcileTargets: (expectedTargets: readonly ExpectedTmuxTarget[]) => Promise<RealTmuxReconcileResult>;
}

export interface FakeTmuxAdapterOptions {
  readonly now?: () => Date;
}

export interface FakeAppendOutputInput extends TmuxSessionRef {
  readonly text: string;
}

export interface FakeMarkStaleInput extends TmuxSessionRef {
  readonly reason: string;
}

export interface FakeTmuxAdapter extends TmuxAdapter {
  readonly appendOutput: (input: FakeAppendOutputInput) => Promise<TmuxOutputEvent>;
  readonly markStale: (input: FakeMarkStaleInput) => Promise<TmuxTarget>;
  readonly sentInputs: () => readonly TmuxSentInput[];
}

interface MutableTmuxTarget {
  sessionId: SessionId;
  sessionName: SessionName;
  cwd: AbsoluteCwd;
  tmuxSession: string;
  tmuxWindow: string | null;
  tmuxPane: string;
  lifecycleState: LifecycleState;
  staleReason: string | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

const defaultOutputLimit = 100;
const maxOutputLimit = 1_000;
const hostDeckTmuxSessionPrefix = "hostdeck_";
const tmuxFieldSeparator = "\\037";
const execFileAsync = promisify(execFile);

export function tmuxSessionNameForSession(sessionId: SessionId): string {
  return `${hostDeckTmuxSessionPrefix}${sessionId}`;
}

export function parseSessionIdFromTmuxSessionName(tmuxSession: string): SessionId | null {
  if (!tmuxSession.startsWith(hostDeckTmuxSessionPrefix)) {
    return null;
  }

  const result = parseSessionId(tmuxSession.slice(hostDeckTmuxSessionPrefix.length));
  return result.ok ? result.value : null;
}

export function createRealTmuxTargetDiscovery(options: RealTmuxTargetDiscoveryOptions = {}): RealTmuxTargetDiscovery {
  const tmuxBinary = options.tmuxBinary ?? "tmux";
  const socketArgs = options.socketName === undefined ? [] : ["-L", options.socketName];

  async function runTmux(args: readonly string[], input: { readonly allowMissingServer?: boolean } = {}): Promise<string> {
    try {
      const result = await execFileAsync(tmuxBinary, [...socketArgs, ...args], {
        encoding: "utf8",
        maxBuffer: 1_000_000
      });

      return result.stdout;
    } catch (error) {
      const execError = error as ExecFileException & { readonly stderr?: string };
      const stderr = execError.stderr ?? "";

      if (input.allowMissingServer === true && isMissingTmuxServerError(stderr)) {
        return "";
      }

      if (execError.code === "ENOENT") {
        throw new HostDeckTmuxAdapterError("tmux_unavailable", `tmux binary "${tmuxBinary}" is not available.`, { cause: error });
      }

      throw new HostDeckTmuxAdapterError("invalid_target", boundedTmuxError(stderr, execError.message), { cause: error });
    }
  }

  async function listTargets(): Promise<readonly RealTmuxDiscoveredTarget[]> {
    const stdout = await runTmux(
      [
        "list-panes",
        "-a",
        "-F",
        [
          "#{session_name}",
          "#{window_name}",
          "#{pane_id}",
          "#{pane_current_path}",
          "#{session_created}",
          "#{session_activity}"
        ].join(tmuxFieldSeparator)
      ],
      { allowMissingServer: true }
    );

    return stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map(parseDiscoveredTarget)
      .filter((target): target is RealTmuxDiscoveredTarget => target !== null)
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  }

  return {
    tmuxSessionNameForSession,
    parseSessionIdFromTmuxSessionName,
    listTargets,
    async getTargetBySessionId(sessionId) {
      const tmuxSession = tmuxSessionNameForSession(sessionId);
      return (await listTargets()).find((target) => target.tmuxSession === tmuxSession) ?? null;
    },
    async reconcileTargets(expectedTargets) {
      const discoveredTargets = await listTargets();
      const discoveredBySession = new Map(discoveredTargets.map((target) => [target.sessionId, target]));
      const expectedSessionIds = new Set(expectedTargets.map((target) => target.sessionId));
      const liveTargets: TmuxTarget[] = [];
      const staleTargets: StaleTmuxTarget[] = [];

      for (const expected of expectedTargets) {
        const expectedTmuxSession = expected.tmuxSession ?? tmuxSessionNameForSession(expected.sessionId);
        const discovered = discoveredBySession.get(expected.sessionId);

        if (discovered === undefined || discovered.tmuxSession !== expectedTmuxSession) {
          staleTargets.push(staleTarget(expected, expectedTmuxSession, "tmux target missing"));
          continue;
        }

        if (expected.tmuxWindow !== undefined && expected.tmuxWindow !== null && discovered.tmuxWindow !== expected.tmuxWindow) {
          staleTargets.push(staleTarget(expected, expectedTmuxSession, "tmux window metadata mismatch"));
          continue;
        }

        if (expected.tmuxPane !== undefined && expected.tmuxPane !== null && discovered.tmuxPane !== expected.tmuxPane) {
          staleTargets.push(staleTarget(expected, expectedTmuxSession, "tmux pane metadata mismatch"));
          continue;
        }

        liveTargets.push({
          sessionId: expected.sessionId,
          sessionName: expected.sessionName,
          cwd: expected.cwd,
          tmuxSession: discovered.tmuxSession,
          tmuxWindow: discovered.tmuxWindow,
          tmuxPane: discovered.tmuxPane,
          lifecycleState: "running",
          staleReason: null,
          createdAt: expected.createdAt ?? discovered.createdAt,
          updatedAt: discovered.updatedAt
        });
      }

      const unmanagedTargets = discoveredTargets.filter((target) => !expectedSessionIds.has(target.sessionId));

      return {
        liveTargets,
        staleTargets,
        unmanagedTargets
      };
    }
  };
}

export function createFakeTmuxAdapter(options: FakeTmuxAdapterOptions = {}): FakeTmuxAdapter {
  const now = options.now ?? (() => new Date());
  const targets = new Map<string, MutableTmuxTarget>();
  const outputs = new Map<string, TmuxOutputEvent[]>();
  const sentInputs: TmuxSentInput[] = [];
  let nextPaneNumber = 1;

  function timestamp(): IsoTimestamp {
    return parseRequiredIsoTimestamp(now().toISOString());
  }

  function requireTarget(sessionId: SessionId): MutableTmuxTarget {
    const target = targets.get(sessionId);

    if (target === undefined) {
      throw new HostDeckTmuxAdapterError("missing_target", `Tmux target for ${sessionId} does not exist.`);
    }

    return target;
  }

  function requireUsableTarget(sessionId: SessionId): MutableTmuxTarget {
    const target = requireTarget(sessionId);

    if (target.lifecycleState === "stale") {
      throw new HostDeckTmuxAdapterError("stale_target", `Tmux target for ${sessionId} is stale.`);
    }

    if (target.lifecycleState !== "running") {
      throw new HostDeckTmuxAdapterError("target_not_running", `Tmux target for ${sessionId} is not running.`);
    }

    return target;
  }

  return {
    async startSession(input) {
      const sessionId = parseRequiredSessionId(input.sessionId);
      const cwd = parseRequiredCwd(input.cwd);
      const command = normalizeCommand(input.command);

      if (targets.has(sessionId)) {
        throw new HostDeckTmuxAdapterError("duplicate_session", `Tmux target for ${sessionId} already exists.`);
      }

      for (const target of targets.values()) {
        if (target.sessionName === input.sessionName) {
          throw new HostDeckTmuxAdapterError("duplicate_session_name", `Tmux target name ${input.sessionName} already exists.`);
        }
      }

      const createdAt = timestamp();
      const target: MutableTmuxTarget = {
        sessionId,
        sessionName: input.sessionName,
        cwd,
        tmuxSession: tmuxSessionName(sessionId),
        tmuxWindow: command[0],
        tmuxPane: `%${nextPaneNumber}`,
        lifecycleState: "running",
        staleReason: null,
        createdAt,
        updatedAt: createdAt
      };
      nextPaneNumber += 1;
      targets.set(sessionId, target);
      outputs.set(sessionId, []);

      return cloneTarget(target);
    },
    async listTargets() {
      return [...targets.values()].map(cloneTarget);
    },
    async getTarget(sessionId) {
      const target = targets.get(parseRequiredSessionId(sessionId));
      return target === undefined ? null : cloneTarget(target);
    },
    async sendInput(input) {
      if (input.text.length === 0) {
        throw new HostDeckTmuxAdapterError("invalid_target", "Tmux input text must not be empty.");
      }

      const target = requireUsableTarget(parseRequiredSessionId(input.sessionId));
      const sent: TmuxSentInput = {
        sessionId: target.sessionId,
        tmuxPane: target.tmuxPane,
        text: input.text,
        enter: input.enter ?? true,
        sentAt: timestamp()
      };
      sentInputs.push(sent);
      target.updatedAt = sent.sentAt;

      return sent;
    },
    async stopSession(input) {
      const sessionId = parseRequiredSessionId(input.sessionId);
      const target = requireTarget(sessionId);

      if (target.lifecycleState === "stale") {
        throw new HostDeckTmuxAdapterError("stale_target", `Tmux target for ${sessionId} is stale.`);
      }

      const stopped = cloneTarget({
        ...target,
        lifecycleState: "stopped",
        staleReason: null,
        updatedAt: timestamp()
      });
      targets.delete(sessionId);

      return stopped;
    },
    async attachMetadata(input) {
      const target = requireUsableTarget(parseRequiredSessionId(input.sessionId));
      return {
        sessionId: target.sessionId,
        tmuxSession: target.tmuxSession,
        tmuxWindow: target.tmuxWindow,
        tmuxPane: target.tmuxPane,
        command: ["tmux", "attach-session", "-t", target.tmuxSession]
      };
    },
    async readOutput(input) {
      const sessionId = parseRequiredSessionId(input.sessionId);
      requireTarget(sessionId);

      const after = input.after === undefined || input.after === null ? null : parseRequiredOutputCursor(input.after);
      const limit = parseOutputLimit(input.limit ?? defaultOutputLimit);
      const events = outputs.get(sessionId) ?? [];

      return events.filter((event) => after === null || event.cursor > after).slice(0, limit);
    },
    async appendOutput(input) {
      const sessionId = parseRequiredSessionId(input.sessionId);
      requireTarget(sessionId);

      if (input.text.length === 0) {
        throw new HostDeckTmuxAdapterError("invalid_target", "Fake output text must not be empty.");
      }

      const events = outputs.get(sessionId) ?? [];
      const previousCursor = events.at(-1)?.cursor ?? parseRequiredOutputCursor(0);
      const event: TmuxOutputEvent = {
        sessionId,
        cursor: parseRequiredOutputCursor(previousCursor + 1),
        capturedAt: timestamp(),
        text: input.text
      };
      events.push(event);
      outputs.set(sessionId, events);

      return event;
    },
    async markStale(input) {
      const target = requireTarget(parseRequiredSessionId(input.sessionId));
      const reason = input.reason.trim();

      if (reason.length === 0) {
        throw new HostDeckTmuxAdapterError("invalid_target", "Stale tmux targets must record a reason.");
      }

      target.lifecycleState = "stale";
      target.staleReason = reason;
      target.updatedAt = timestamp();

      return cloneTarget(target);
    },
    sentInputs() {
      return [...sentInputs];
    }
  };
}

function parseDiscoveredTarget(line: string): RealTmuxDiscoveredTarget | null {
  const [tmuxSession, tmuxWindow, tmuxPane, currentPath, createdAtSeconds, updatedAtSeconds] = line.split(tmuxFieldSeparator);

  if (
    tmuxSession === undefined ||
    tmuxWindow === undefined ||
    tmuxPane === undefined ||
    currentPath === undefined ||
    createdAtSeconds === undefined ||
    updatedAtSeconds === undefined
  ) {
    throw new HostDeckTmuxAdapterError("invalid_target", "tmux list-panes returned an incomplete target row.");
  }

  const sessionId = parseSessionIdFromTmuxSessionName(tmuxSession);

  if (sessionId === null) {
    return null;
  }

  return {
    sessionId,
    tmuxSession,
    tmuxWindow,
    tmuxPane,
    currentPath: requireParsed(parseAbsoluteCwd(currentPath), "tmux pane cwd is invalid"),
    createdAt: epochSecondsToIsoTimestamp(createdAtSeconds, "tmux session created timestamp is invalid"),
    updatedAt: epochSecondsToIsoTimestamp(updatedAtSeconds, "tmux session activity timestamp is invalid")
  };
}

function staleTarget(expected: ExpectedTmuxTarget, tmuxSession: string, staleReason: string): StaleTmuxTarget {
  return {
    sessionId: expected.sessionId,
    sessionName: expected.sessionName,
    cwd: expected.cwd,
    tmuxSession,
    staleReason
  };
}

function epochSecondsToIsoTimestamp(value: string, message: string): IsoTimestamp {
  const seconds = Number(value);

  if (!Number.isInteger(seconds) || seconds < 0) {
    throw new HostDeckTmuxAdapterError("invalid_target", message);
  }

  return requireParsed(parseIsoTimestamp(new Date(seconds * 1000).toISOString()), message);
}

function requireParsed<T>(result: ValidationResult<T>, message: string): T {
  if (!result.ok) {
    throw new HostDeckTmuxAdapterError("invalid_target", message);
  }

  return result.value;
}

function isMissingTmuxServerError(stderr: string): boolean {
  return stderr.includes("No such file or directory") || stderr.includes("no server running");
}

function boundedTmuxError(stderr: string, fallback: string): string {
  const message = stderr.trim() || fallback.trim() || "tmux command failed.";
  return message.length <= 240 ? message : `${message.slice(0, 237)}...`;
}

function parseRequiredSessionId(sessionId: SessionId | string): SessionId {
  const result = parseSessionId(String(sessionId));

  if (!result.ok) {
    throw new HostDeckTmuxAdapterError("invalid_target", result.message);
  }

  return result.value;
}

function parseRequiredCwd(cwd: AbsoluteCwd | string): AbsoluteCwd {
  const result = parseAbsoluteCwd(String(cwd));

  if (!result.ok) {
    throw new HostDeckTmuxAdapterError("invalid_cwd", result.message);
  }

  return result.value;
}

function parseRequiredIsoTimestamp(value: string): IsoTimestamp {
  const result = parseIsoTimestamp(value);

  if (!result.ok) {
    throw new HostDeckTmuxAdapterError("invalid_target", result.message);
  }

  return result.value;
}

function parseRequiredOutputCursor(value: number): OutputCursor {
  const result = parseOutputCursor(value);

  if (!result.ok) {
    throw new HostDeckTmuxAdapterError("invalid_output_cursor", result.message);
  }

  return result.value;
}

function parseOutputLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > maxOutputLimit) {
    throw new HostDeckTmuxAdapterError("invalid_output_cursor", `Output limit must be between 1 and ${maxOutputLimit}.`);
  }

  return limit;
}

function normalizeCommand(command: readonly string[]): readonly [string, ...string[]] {
  const [binary, ...args] = command;

  if (binary === undefined || binary.trim().length === 0 || command.some((part) => part.length === 0 || part.includes("\0"))) {
    throw new HostDeckTmuxAdapterError("invalid_start_command", "Start command must include non-empty command parts.");
  }

  return [binary, ...args];
}

function tmuxSessionName(sessionId: SessionId): string {
  return `hostdeck-${sessionId.replace(/^sess_/u, "").replace(/_/gu, "-")}`;
}

function cloneTarget(target: MutableTmuxTarget): TmuxTarget {
  return {
    sessionId: target.sessionId,
    sessionName: target.sessionName,
    cwd: target.cwd,
    tmuxSession: target.tmuxSession,
    tmuxWindow: target.tmuxWindow,
    tmuxPane: target.tmuxPane,
    lifecycleState: target.lifecycleState,
    staleReason: target.staleReason,
    createdAt: target.createdAt,
    updatedAt: target.updatedAt
  };
}
