import type { StorageSessionRecord } from "@hostdeck/contracts";
import type { SessionRepository } from "@hostdeck/storage";
import type { RealTmuxDiscoveredTarget, RealTmuxTargetDiscovery, TmuxTarget } from "@hostdeck/tmux-adapter";

export interface CreateRestartReconcilerInput {
  readonly sessions: SessionRepository;
  readonly discovery: RealTmuxTargetDiscovery;
  readonly now?: () => Date;
  readonly startOutputReader?: (target: TmuxTarget) => Promise<void> | void;
}

export interface RestartReconcileResult {
  readonly liveTargets: readonly TmuxTarget[];
  readonly staleSessionIds: readonly string[];
  readonly unmanagedTargets: readonly RealTmuxDiscoveredTarget[];
}

export interface RestartReconciler {
  readonly reconcile: () => Promise<RestartReconcileResult>;
}

export function createRestartReconciler(input: CreateRestartReconcilerInput): RestartReconciler {
  const now = input.now ?? (() => new Date());

  return {
    async reconcile() {
      const durableSessions = input.sessions.list().filter((session) => session.lifecycle_state !== "stopped");
      const reconciled = await input.discovery.reconcileTargets(durableSessions.map(expectedTargetForSession));
      const sessionById = new Map(durableSessions.map((session) => [session.id, session]));
      const liveTargets: TmuxTarget[] = [];
      const staleSessionIds: string[] = [];

      for (const target of reconciled.liveTargets) {
        const session = sessionById.get(target.sessionId);

        if (session === undefined) {
          continue;
        }

        input.sessions.update({
          ...session,
          backend: {
            type: "tmux",
            tmux_session: target.tmuxSession,
            tmux_window: target.tmuxWindow,
            tmux_pane: target.tmuxPane
          },
          lifecycle_state: "running",
          updated_at: now().toISOString(),
          stale_reason: null
        });
        await input.startOutputReader?.(target);
        liveTargets.push(target);
      }

      for (const stale of reconciled.staleTargets) {
        input.sessions.markStale(stale.sessionId, stale.staleReason, { now });
        staleSessionIds.push(stale.sessionId);
      }

      return {
        liveTargets,
        staleSessionIds,
        unmanagedTargets: reconciled.unmanagedTargets
      };
    }
  };
}

function expectedTargetForSession(session: StorageSessionRecord) {
  return {
    sessionId: session.id,
    sessionName: session.name,
    cwd: session.cwd,
    tmuxSession: session.backend.tmux_session,
    tmuxWindow: session.backend.tmux_window,
    tmuxPane: session.backend.tmux_pane,
    createdAt: session.created_at
  };
}
