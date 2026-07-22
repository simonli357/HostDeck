// @vitest-environment jsdom

import {
  type SelectedAccessStateResponse,
  type SelectedHostStatusResponse,
  selectedAccessStateResponseSchema,
  selectedHostLocalHealthComponents,
  selectedHostStatusResponseSchema
} from "@hostdeck/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  type BrowserConnectionPhase,
  type BrowserConnectionResourceState,
  type BrowserConnectionSnapshot,
  type BrowserConnectionWriteBlockCause,
  browserConnectionPhases,
  browserConnectionResourceStates,
  browserConnectionWriteBlockCauses
} from "./connection-state.js";
import { HostAccessPanel, projectHostAccess } from "./host-access.js";

const timestamp = "2026-07-22T12:00:00.000Z";
const nowMs = Date.parse(timestamp);
const remoteOrigin = "https://hostdeck-laptop.fixture-tailnet.ts.net";

afterEach(() => cleanup());

describe("host and access projection", () => {
  it("projects current writer truth without device, CSRF, or source identity", () => {
    const projection = projectHostAccess(snapshot(), nowMs);

    expect(projection.title).toBe("Secure control ready");
    expect(projection.tone).toBe("connected");
    expect(factValues(projection)).toMatchObject({
      connection: "Private HTTPS",
      origin: remoteOrigin,
      permission: "Read & write",
      expiry: "Oct 20, 2026",
      lock: "Unlocked",
      reads: "Available",
      writes: "Ready",
      host: "Ready",
      remote: "Reached"
    });
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("device_access_fixture");
    expect(serialized).not.toContain("csrf");
    expect(serialized).not.toContain("generation");
    expect(serialized).not.toContain("source");
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.facts)).toBe(true);
    expect(projection.facts.every(Object.isFrozen)).toBe(true);
  });

  it("distinguishes read-only, locked, and every denied authority", () => {
    const readOnly = projectHostAccess(
      snapshot({ permission: "read", writeCauses: ["read_only_access"] }),
      nowMs
    );
    expect(readOnly.title).toBe("Read-only access");
    expect(factValues(readOnly).writes).toBe("Read only");
    expect(factValues(readOnly).reads).toBe("Available");

    const locked = projectHostAccess(
      snapshot({ locked: true, writeCauses: ["host_locked"] }),
      nowMs
    );
    expect(locked.title).toBe("Remote writes are locked");
    expect(factValues(locked).lock).toBe("Locked");
    expect(factValues(locked).writes).toBe("Locked");
    expect(factValues(locked).reads).toBe("Available");

    const denied = [
      ["unpaired", "Pairing required", "Pair required"],
      ["invalid_device", "Device access is invalid", "Invalid device"],
      ["expired_device", "Pairing expired", "Expired"],
      ["revoked_device", "Device access was revoked", "Revoked"]
    ] as const;
    for (const [authenticationState, title, permission] of denied) {
      const projection = projectHostAccess(
        snapshot({ authenticationState, writeCauses: [writeCause(authenticationState)] }),
        nowMs
      );
      expect(projection.title, authenticationState).toBe(title);
      expect(factValues(projection).permission, authenticationState).toBe(permission);
      expect(factValues(projection).reads, authenticationState).toBe("Blocked");
      expect(factValues(projection).host, authenticationState).toBe("Hidden until authorized");
      expect(JSON.stringify(projection), authenticationState).not.toContain("fixture private host");
    }

    const localAdmin = projectHostAccess(
      snapshot({ authenticationState: "local_admin", writeCauses: ["permission_denied"] }),
      nowMs
    );
    expect(localAdmin.title).toBe("Invalid browser authority");
    expect(factValues(localAdmin).permission).toBe("Invalid browser authority");
    expect(factValues(localAdmin).reads).toBe("Blocked");
    expect(factValues(localAdmin).host).toBe("Hidden until authorized");
    expect(
      localAdmin.facts.some(({ id }) => id === "remote" || id === "stream")
    ).toBe(false);
  });

  it("keeps stale, host health, remote, and detail-stream truth independent", () => {
    const stale = projectHostAccess(
      snapshot({ accessState: "stale", hostState: "stale", writeCauses: ["connection_not_current"] }),
      nowMs
    );
    expect(stale.title).toBe("Access state is stale");
    expect(factValues(stale).permission).toBe("Read & write");
    expect(factValues(stale).reads).toBe("Blocked");
    expect(factValues(stale).host).toBe("Stale");

    for (const [phase, expected] of [
      ["offline", "Runtime offline"],
      ["incompatible", "Incompatible"],
      ["fatal", "Unavailable"]
    ] as const) {
      expect(factValues(projectHostAccess(snapshot({ phase }), nowMs)).host).toBe(expected);
    }

    const detail = projectHostAccess(
      snapshot({ target: "detail", streamState: "reconnecting", streamContinuity: "boundary" }),
      nowMs
    );
    expect(factValues(detail).stream).toBe("Reconnecting");
    expect(detail.facts.find(({ id }) => id === "stream")?.detail).toBe("History boundary visible");
    expect(projectHostAccess(snapshot(), nowMs).facts.some(({ id }) => id === "stream")).toBe(false);
  });

  it("uses only generic copy when no access response exists", () => {
    const loading = projectHostAccess(
      snapshot({ access: null, accessState: "loading", host: null, hostState: "loading", phase: "loading" }),
      nowMs
    );
    expect(loading.title).toBe("Checking access");
    expect(factValues(loading)).toEqual({ connection: "Checking" });

    const unreachable = projectHostAccess(
      snapshot({ access: null, accessState: "failed", host: null, hostState: "blocked", phase: "unreachable" }),
      nowMs
    );
    expect(unreachable.title).toBe("Access unavailable");
    expect(factValues(unreachable)).toEqual({
      connection: "Unreachable",
      reads: "Blocked",
      writes: "Blocked"
    });
    expect(unreachable.body).not.toMatch(/profile|serve|runtime/iu);
  });

  it("renders semantic definition rows and wraps the selected origin as inert text", () => {
    render(<HostAccessPanel projection={projectHostAccess(snapshot(), nowMs)} />);

    expect(screen.getByRole("region", { name: "Host and access details" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Secure control ready");
    expect(screen.getByText(remoteOrigin).tagName).toBe("DD");
    expect(screen.queryByRole("link", { name: remoteOrigin })).toBeNull();
    expect(screen.getAllByRole("term").length).toBeGreaterThanOrEqual(8);
    expect(screen.getAllByRole("definition").length).toBeGreaterThanOrEqual(8);
  });

  it("rejects mutable snapshots and invalid time", () => {
    expect(() => projectHostAccess({ ...snapshot() }, nowMs)).toThrow(TypeError);
    expect(() => projectHostAccess(snapshot(), Number.NaN)).toThrow(TypeError);
    expect(() => projectHostAccess(snapshot(), -1)).toThrow(TypeError);
  });

  it("keeps every coordinator phase, resource state, stream state, and write cause bounded", () => {
    for (const phase of browserConnectionPhases) {
      const projection = projectHostAccess(snapshot({ phase }), nowMs);
      expect(projection.title, phase).not.toBe("");
      expect(projection.facts.length, phase).toBeGreaterThan(0);
    }

    for (const state of browserConnectionResourceStates) {
      const projection = projectHostAccess(
        snapshot({
          accessState: state,
          hostState: state,
          writeCauses: state === "current" ? [] : ["connection_not_current"]
        }),
        nowMs
      );
      expect(projection.title, state).not.toBe("");
      expect(factValues(projection).reads, state).toBe(
        state === "current" ? "Available" : "Blocked"
      );
    }

    for (const streamState of [
      "not_applicable",
      "idle",
      "connecting",
      "connected",
      "reconnecting",
      "failed",
      "closed"
    ] as const) {
      const projection = projectHostAccess(
        snapshot({ target: "detail", streamState }),
        nowMs
      );
      expect(factValues(projection).stream, streamState).toBeTypeOf("string");
    }

    for (const cause of browserConnectionWriteBlockCauses) {
      const projection = projectHostAccess(snapshot({ writeCauses: [cause] }), nowMs);
      expect(factValues(projection).writes, cause).not.toBe("Ready");
    }
  });
});

function snapshot(
  options: {
    readonly authenticationState?: SelectedAccessStateResponse["authentication_state"];
    readonly permission?: "read" | "write";
    readonly locked?: boolean;
    readonly access?: SelectedAccessStateResponse | null;
    readonly accessState?: BrowserConnectionResourceState;
    readonly host?: SelectedHostStatusResponse | null;
    readonly hostState?: BrowserConnectionResourceState;
    readonly phase?: BrowserConnectionPhase;
    readonly target?: "mission" | "detail";
    readonly streamState?: BrowserConnectionSnapshot["stream"]["state"];
    readonly streamContinuity?: BrowserConnectionSnapshot["stream"]["continuity"];
    readonly writeCauses?: readonly BrowserConnectionWriteBlockCause[];
  } = {}
): BrowserConnectionSnapshot {
  const authenticationState = options.authenticationState ?? "paired_device";
  const access = options.access === undefined
    ? accessState(authenticationState, options.permission ?? "write", options.locked ?? false)
    : options.access;
  const readable = access?.can_read_sessions === true;
  const host = options.host === undefined ? (readable ? hostStatus(access) : null) : options.host;
  const causes = Object.freeze([...(options.writeCauses ?? [])]);
  const accessResourceState = options.accessState ?? (access === null ? "loading" : "current");
  const hostResourceState = options.hostState ?? (host === null ? "blocked" : "current");
  const detail = options.target === "detail";
  return Object.freeze({
    epoch: 1,
    target: detail
      ? Object.freeze({ kind: "session_detail" as const, sessionId: "sess_access_fixture" })
      : Object.freeze({ kind: "mission_control" as const }),
    phase: options.phase ?? (readable ? "ready" : "access_limited"),
    access: resource(accessResourceState, access),
    host: resource(hostResourceState, host),
    targetState: resource(readable ? "loading" : "blocked", null),
    stream: Object.freeze({
      state: options.streamState ?? (detail ? "idle" : "not_applicable"),
      snapshot: null,
      continuity: options.streamContinuity ?? (detail ? "unproven" : "not_applicable"),
      boundary: null,
      failure: null
    }),
    csrf: Object.freeze({
      phase: causes.includes("csrf_not_ready") ? "idle" as const : "ready" as const,
      generation: causes.includes("csrf_not_ready") ? null : 1,
      rotatedAt: causes.includes("csrf_not_ready") ? null : timestamp,
      failure: null,
      invalidationReason: causes.includes("csrf_not_ready") ? "not_bootstrapped" as const : null
    }),
    writeEligibility: Object.freeze({
      scope: "browser_shell" as const,
      eligible: causes.length === 0,
      causes
    }),
    lastFailure: null
  });
}

function accessState(
  authenticationState: SelectedAccessStateResponse["authentication_state"],
  permission: "read" | "write",
  locked: boolean
): SelectedAccessStateResponse {
  const paired = authenticationState === "paired_device";
  const localAdmin = authenticationState === "local_admin";
  const loopback = localAdmin;
  const localRead = authenticationState === "unpaired" && loopback;
  return selectedAccessStateResponseSchema.parse({
    authentication_state: authenticationState,
    device_id: paired ? "device_access_fixture" : null,
    permission: localAdmin ? "local_admin" : paired ? permission : null,
    device_expires_at: paired ? "2026-10-20T12:00:00.000Z" : null,
    configured_origin: loopback ? "http://127.0.0.1:4175" : remoteOrigin,
    network_mode: loopback ? "loopback" : "remote",
    transport: loopback ? "http" : "https",
    locked,
    can_read_sessions: localAdmin || paired || localRead,
    can_write_sessions: (localAdmin || (paired && permission === "write")) && !locked,
    can_lock: localAdmin || (paired && permission === "write"),
    can_unlock: localAdmin
  });
}

function hostStatus(access: SelectedAccessStateResponse): SelectedHostStatusResponse {
  const mode = access.authentication_state === "local_admin"
    ? "local_admin"
    : access.network_mode === "loopback"
      ? "loopback_read"
      : access.permission === "read"
        ? "paired_read"
        : "paired_write";
  const readOnly = mode === "loopback_read" || mode === "paired_read";
  return selectedHostStatusResponseSchema.parse({
    local: {
      generation: 1,
      state: "ready",
      readiness: "ready",
      updated_at: timestamp,
      components: selectedHostLocalHealthComponents.map((component) => ({
        component,
        state: "ready",
        checked_at: timestamp,
        causes: []
      })),
      mutation_admission: "open"
    },
    remote: {
      generation: 1,
      state_generation: 1,
      availability: "ready",
      cause: null,
      external_origin: remoteOrigin,
      laptop_action_required: false,
      observed_at: timestamp,
      checked_at: timestamp,
      updated_at: timestamp
    },
    access: {
      mode,
      network_mode: access.network_mode,
      transport: access.transport,
      write_eligibility: {
        scope: "host_health_and_authority",
        eligible: !readOnly,
        causes: readOnly ? ["read_only_access"] : []
      }
    }
  });
}

function resource<Data>(
  state: BrowserConnectionResourceState,
  data: Data | null
) {
  return Object.freeze({
    state,
    data,
    failure: null,
    observedAt: data === null ? null : timestamp
  });
}

function factValues(projection: ReturnType<typeof projectHostAccess>) {
  return Object.fromEntries(projection.facts.map(({ id, value }) => [id, value]));
}

function writeCause(
  state: "unpaired" | "invalid_device" | "expired_device" | "revoked_device"
): BrowserConnectionWriteBlockCause {
  return state === "unpaired" ? "unpaired" : state;
}
