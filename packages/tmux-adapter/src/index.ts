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
  type SessionName
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
  | "target_not_running";

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
