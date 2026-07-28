import { sessionIdSchema } from "@hostdeck/contracts/scalars";

export type HostDeckNavigationType = "POP" | "PUSH" | "REPLACE";

export interface HostDeckRouteFocusLocation {
  readonly pathname: string;
  readonly missionSource: boolean;
}

export type HostDeckRouteFocusRequest =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "main" }>
  | Readonly<{ kind: "mission_session"; sessionPath: string }>;

export interface ApprovalAnnouncementItem {
  readonly handle: string;
  readonly action: string;
  readonly riskLabel: string;
  readonly actionable: boolean;
}

export interface ApprovalAnnouncementState {
  readonly initialized: boolean;
  readonly seenHandles: readonly string[];
}

export interface ApprovalAnnouncementResult {
  readonly state: ApprovalAnnouncementState;
  readonly message: string | null;
}

const noRouteFocus = Object.freeze({ kind: "none" as const });
const mainRouteFocus = Object.freeze({ kind: "main" as const });

export const initialApprovalAnnouncementState: ApprovalAnnouncementState = Object.freeze({
  initialized: false,
  seenHandles: Object.freeze([])
});

export function resolveHostDeckRouteFocus(
  previous: HostDeckRouteFocusLocation | null,
  current: HostDeckRouteFocusLocation,
  navigationType: HostDeckNavigationType,
  focusMainOnMount: boolean
): HostDeckRouteFocusRequest {
  assertRouteLocation(current);
  if (previous === null) return focusMainOnMount ? mainRouteFocus : noRouteFocus;
  assertRouteLocation(previous);
  if (previous.pathname === current.pathname) return noRouteFocus;
  if (
    current.pathname === "/" &&
    previous.missionSource &&
    navigationType === "POP" &&
    isSessionDetailPath(previous.pathname)
  ) {
    return Object.freeze({ kind: "mission_session" as const, sessionPath: previous.pathname });
  }
  return mainRouteFocus;
}

export function hostDeckDocumentTitle(pathname: string): string {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) {
    throw new TypeError("HostDeck document-title path is invalid.");
  }
  if (pathname === "/") return "Mission Control | HostDeck";
  if (isSessionDetailPath(pathname)) return "Session Detail | HostDeck";
  return "Page not found | HostDeck";
}

export function advanceApprovalAnnouncement(
  previous: ApprovalAnnouncementState,
  items: readonly ApprovalAnnouncementItem[],
  baselineReady: boolean,
  targetLabel: string | null
): ApprovalAnnouncementResult {
  assertApprovalAnnouncementState(previous);
  if (!Array.isArray(items) || typeof baselineReady !== "boolean") {
    throw new TypeError("HostDeck approval announcement input is invalid.");
  }
  if (targetLabel !== null && (typeof targetLabel !== "string" || targetLabel.trim().length === 0)) {
    throw new TypeError("HostDeck approval announcement target is invalid.");
  }
  if (!baselineReady) return Object.freeze({ state: previous, message: null });

  const seen = new Set(previous.seenHandles);
  if (!previous.initialized) {
    for (const item of items) {
      assertApprovalAnnouncementItem(item);
      seen.add(item.handle);
    }
    return Object.freeze({
      state: Object.freeze({ initialized: true, seenHandles: Object.freeze([...seen]) }),
      message: null
    });
  }

  const newlyActionable: ApprovalAnnouncementItem[] = [];
  for (const item of items) {
    assertApprovalAnnouncementItem(item);
    if (!seen.has(item.handle) && item.actionable) {
      newlyActionable.push(item);
      seen.add(item.handle);
    }
  }
  const state = Object.freeze({
    initialized: true,
    seenHandles: Object.freeze([...seen])
  });
  if (newlyActionable.length === 0) {
    return Object.freeze({ state, message: null });
  }
  const target = targetLabel ?? "this session";
  if (newlyActionable.length === 1) {
    const item = newlyActionable[0];
    if (item === undefined) throw new TypeError("HostDeck approval announcement is missing its item.");
    return Object.freeze({
      state,
      message: `Approval required for ${target}: ${item.action}. ${item.riskLabel} risk.`
    });
  }
  return Object.freeze({
    state,
    message: `${newlyActionable.length} new approval requests require a decision for ${target}.`
  });
}

export function newActivityAnnouncement(count: number): string {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new TypeError("HostDeck new-activity announcement count is invalid.");
  }
  return `${count} new ${count === 1 ? "event" : "events"}.`;
}

function isSessionDetailPath(pathname: string): boolean {
  const match = /^\/sessions\/([^/]+)$/u.exec(pathname);
  if (match === null) return false;
  const encoded = match[1];
  if (encoded === undefined) return false;
  try {
    return sessionIdSchema.safeParse(decodeURIComponent(encoded)).success;
  } catch {
    return false;
  }
}

function assertRouteLocation(value: HostDeckRouteFocusLocation): void {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.pathname !== "string" ||
    !value.pathname.startsWith("/") ||
    typeof value.missionSource !== "boolean"
  ) {
    throw new TypeError("HostDeck route-focus location is invalid.");
  }
}

function assertApprovalAnnouncementState(value: ApprovalAnnouncementState): void {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.initialized !== "boolean" ||
    !Array.isArray(value.seenHandles) ||
    value.seenHandles.some((handle) => typeof handle !== "string" || handle.length === 0)
  ) {
    throw new TypeError("HostDeck approval announcement state is invalid.");
  }
}

function assertApprovalAnnouncementItem(value: ApprovalAnnouncementItem): void {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.handle !== "string" ||
    value.handle.length === 0 ||
    typeof value.action !== "string" ||
    value.action.trim().length === 0 ||
    typeof value.riskLabel !== "string" ||
    value.riskLabel.trim().length === 0 ||
    typeof value.actionable !== "boolean"
  ) {
    throw new TypeError("HostDeck approval announcement item is invalid.");
  }
}
