import { describe, expect, it } from "vitest";
import {
  advanceApprovalAnnouncement,
  hostDeckDocumentTitle,
  initialApprovalAnnouncementState,
  newActivityAnnouncement,
  resolveHostDeckRouteFocus
} from "./accessibility-state.js";

const mission = Object.freeze({ pathname: "/", missionSource: false });
const detail = Object.freeze({
  pathname: "/sessions/sess_accessibility_001",
  missionSource: true
});

describe("HostDeck accessibility state", () => {
  it("moves route focus without stealing focus on a direct initial load", () => {
    expect(resolveHostDeckRouteFocus(null, mission, "POP", false)).toEqual({ kind: "none" });
    expect(resolveHostDeckRouteFocus(null, mission, "POP", true)).toEqual({ kind: "main" });
    expect(resolveHostDeckRouteFocus(mission, detail, "PUSH", false)).toEqual({ kind: "main" });
    expect(resolveHostDeckRouteFocus(detail, mission, "POP", false)).toEqual({
      kind: "mission_session",
      sessionPath: detail.pathname
    });
    expect(resolveHostDeckRouteFocus(detail, mission, "REPLACE", false)).toEqual({ kind: "main" });
    expect(
      resolveHostDeckRouteFocus({ ...detail, missionSource: false }, mission, "POP", false)
    ).toEqual({ kind: "main" });
    expect(resolveHostDeckRouteFocus(mission, mission, "PUSH", false)).toEqual({ kind: "none" });
  });

  it("sets bounded titles only for validated routes", () => {
    expect(hostDeckDocumentTitle("/")).toBe("Mission Control | HostDeck");
    expect(hostDeckDocumentTitle(detail.pathname)).toBe("Session Detail | HostDeck");
    expect(hostDeckDocumentTitle("/sessions/private-secret")).toBe("Page not found | HostDeck");
    expect(hostDeckDocumentTitle("/settings")).toBe("Page not found | HostDeck");
  });

  it("baselines approvals silently and announces only unseen actionable handles", () => {
    const baseline = advanceApprovalAnnouncement(
      initialApprovalAnnouncementState,
      [approval("approval-1")],
      true,
      "Release session"
    );
    expect(baseline.message).toBeNull();

    const next = advanceApprovalAnnouncement(
      baseline.state,
      [approval("approval-2"), approval("approval-1")],
      true,
      "Release session"
    );
    expect(next.message).toBe(
      "Approval required for Release session: Write release marker. Elevated risk."
    );

    const reordered = advanceApprovalAnnouncement(
      next.state,
      [approval("approval-1"), approval("approval-2")],
      true,
      "Release session"
    );
    expect(reordered.message).toBeNull();
    const replayed = advanceApprovalAnnouncement(
      reordered.state,
      [approval("approval-2")],
      true,
      "Release session"
    );
    expect(replayed.message).toBeNull();
  });

  it("does not initialize during replay and marks nonactionable handles as seen", () => {
    const replay = advanceApprovalAnnouncement(
      initialApprovalAnnouncementState,
      [approval("approval-1")],
      false,
      null
    );
    expect(replay).toEqual({ state: initialApprovalAnnouncementState, message: null });
    const baseline = advanceApprovalAnnouncement(
      replay.state,
      [approval("approval-1", false)],
      true,
      null
    );
    const enabledLater = advanceApprovalAnnouncement(
      baseline.state,
      [approval("approval-1")],
      true,
      null
    );
    expect(enabledLater.message).toBeNull();
  });

  it("waits to announce a post-baseline handle until it becomes actionable", () => {
    const baseline = advanceApprovalAnnouncement(
      initialApprovalAnnouncementState,
      [approval("approval-1")],
      true,
      "Release session"
    );
    const refreshing = advanceApprovalAnnouncement(
      baseline.state,
      [approval("approval-1"), approval("approval-2", false)],
      true,
      "Release session"
    );
    expect(refreshing.message).toBeNull();
    expect(refreshing.state.seenHandles).toEqual(["approval-1"]);

    const ready = advanceApprovalAnnouncement(
      refreshing.state,
      [approval("approval-1"), approval("approval-2")],
      true,
      "Release session"
    );
    expect(ready.message).toBe(
      "Approval required for Release session: Write release marker. Elevated risk."
    );
  });

  it("uses bounded singular and plural activity copy", () => {
    expect(newActivityAnnouncement(1)).toBe("1 new event.");
    expect(newActivityAnnouncement(4)).toBe("4 new events.");
    expect(() => newActivityAnnouncement(0)).toThrow(TypeError);
  });
});

function approval(handle: string, actionable = true) {
  return Object.freeze({
    handle,
    action: "Write release marker",
    riskLabel: "Elevated",
    actionable
  });
}
