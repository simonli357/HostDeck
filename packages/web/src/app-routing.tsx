import { sessionIdSchema } from "@hostdeck/contracts/scalars";
import type { SessionId } from "@hostdeck/core";
import type { ComponentPropsWithoutRef } from "react";
import { Link } from "react-router";

export const missionControlPath = "/" as const;
export const sessionDetailPathPattern = "/sessions/:session_id" as const;

const missionSourceKey = "hostdeck_source";
const missionSourceValue = "mission_control";
const missionSourceState = Object.freeze({ [missionSourceKey]: missionSourceValue });

export interface SessionRouteLinkProps
  extends Omit<ComponentPropsWithoutRef<"a">, "href"> {
  readonly sessionId: unknown;
}

export function sessionDetailPath(sessionId: unknown): `/sessions/${string}` {
  const parsed = sessionIdSchema.parse(sessionId) as SessionId;
  return `/sessions/${encodeURIComponent(parsed)}`;
}

export function SessionRouteLink({
  sessionId,
  children,
  ...anchorProps
}: SessionRouteLinkProps) {
  return (
    <Link {...anchorProps} to={sessionDetailPath(sessionId)} state={missionSourceState}>
      {children}
    </Link>
  );
}

export function isMissionSource(state: unknown): boolean {
  if (state === null || typeof state !== "object" || Array.isArray(state)) return false;
  try {
    return Reflect.get(state, missionSourceKey) === missionSourceValue;
  } catch {
    return false;
  }
}
