import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import {
  selectedAccessStateResponseSchema,
  selectedHostLocalHealthComponents,
  selectedHostStatusResponseSchema
} from "../../../packages/contracts/src/index.js";
import {
  type HostDeckRouteOutlets,
  HostDeckRoutes
} from "../../../packages/web/src/app-shell.js";
import type {
  BrowserAppPairingSummary,
  BrowserAppStartupPhase,
  BrowserAppStartupSnapshot
} from "../../../packages/web/src/app-startup.js";
import type {
  BrowserConnectionSnapshot,
  BrowserConnectionStateCoordinator,
  BrowserConnectionWriteBlockCause
} from "../../../packages/web/src/connection-state.js";
import { PairingStartupScreen } from "../../../packages/web/src/pairing-screen.js";
import "../../../packages/web/src/styles.css";

type PairingFixturePhase = Extract<
  BrowserAppStartupPhase,
  | "claiming"
  | "paired"
  | "link_not_accepted"
  | "claim_unknown"
  | "paired_csrf_unavailable"
>;
type AccessFixtureState =
  | "unpaired"
  | "read-only"
  | "writer"
  | "locked"
  | "stale"
  | "reconnecting"
  | "long-origin";

const timestamp = "2026-07-22T12:00:00.000Z";
const standardOrigin = "https://hostdeck-laptop.fixture-tailnet.ts.net";
const longOrigin =
  "https://hostdeck-release-validation-laptop-with-long-name.fixture-tailnet.ts.net";
const rootElement = document.getElementById("root");

if (!(rootElement instanceof HTMLElement)) {
  throw new TypeError("HostDeck browser fixture root is unavailable.");
}

const query = new URLSearchParams(window.location.search);
const view = query.get("view");
const state = query.get("state");
const root = createRoot(rootElement);
const fixtureOutlets: HostDeckRouteOutlets = Object.freeze({
  missionControl: (
    <section className="hostdeck-route" aria-labelledby="fixture-title">
      <div className="hostdeck-route__heading">
        <h1 id="fixture-title">Mission Control</h1>
        <span className="hostdeck-route__meta">Current</span>
      </div>
    </section>
  ),
  sessionDetail: () => null
});

if (view === "pairing") {
  root.render(
    <PairingStartupScreen
      snapshot={pairingSnapshot(readPairingState(state))}
      onContinue={() => undefined}
      onReload={() => undefined}
    />
  );
} else if (view === "access") {
  const coordinator = fixtureCoordinator(accessSnapshot(readAccessState(state)));
  root.render(
    <MemoryRouter>
      <HostDeckRoutes
        coordinator={coordinator}
        outlets={fixtureOutlets}
      />
    </MemoryRouter>
  );
} else {
  throw new TypeError("HostDeck browser fixture view is invalid.");
}

function readPairingState(value: string | null): PairingFixturePhase {
  switch (value) {
    case "claiming":
    case "paired":
    case "link_not_accepted":
    case "claim_unknown":
    case "paired_csrf_unavailable":
      return value;
    default:
      throw new TypeError("HostDeck pairing fixture state is invalid.");
  }
}

function readAccessState(value: string | null): AccessFixtureState {
  switch (value) {
    case "unpaired":
    case "read-only":
    case "writer":
    case "locked":
    case "stale":
    case "reconnecting":
    case "long-origin":
      return value;
    default:
      throw new TypeError("HostDeck access fixture state is invalid.");
  }
}

function pairingSnapshot(phase: PairingFixturePhase): BrowserAppStartupSnapshot {
  const pairing: BrowserAppPairingSummary | null =
    phase === "paired" || phase === "paired_csrf_unavailable"
      ? Object.freeze({
          permission: "write",
          clientLabel: "Xiaomi 15 Pro",
          deviceExpiresAt: "2026-10-20T12:00:00.000Z"
        })
      : null;
  return Object.freeze({ phase, pairing });
}

function accessSnapshot(state: AccessFixtureState): BrowserConnectionSnapshot {
  const unpaired = state === "unpaired";
  const readOnly = state === "read-only";
  const locked = state === "locked";
  const stale = state === "stale";
  const reconnecting = state === "reconnecting";
  const origin = state === "long-origin" ? longOrigin : standardOrigin;
  const permission = readOnly ? "read" : "write";
  const access = selectedAccessStateResponseSchema.parse({
    authentication_state: unpaired ? "unpaired" : "paired_device",
    device_id: unpaired ? null : "device_pairing_access_fixture",
    permission: unpaired ? null : permission,
    device_expires_at: unpaired ? null : "2026-10-20T12:00:00.000Z",
    configured_origin: origin,
    network_mode: "remote",
    transport: "https",
    locked,
    can_read_sessions: !unpaired,
    can_write_sessions: !unpaired && !readOnly && !locked,
    can_lock: !unpaired && !readOnly,
    can_unlock: false
  });
  const host = unpaired ? null : selectedHostStatusResponseSchema.parse({
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
      external_origin: origin,
      laptop_action_required: false,
      observed_at: timestamp,
      checked_at: timestamp,
      updated_at: timestamp
    },
    access: {
      mode: readOnly ? "paired_read" : "paired_write",
      network_mode: "remote",
      transport: "https",
      write_eligibility: {
        scope: "host_health_and_authority",
        eligible: !readOnly,
        causes: readOnly ? ["read_only_access"] : []
      }
    }
  });
  const causes: readonly BrowserConnectionWriteBlockCause[] = Object.freeze(
    unpaired
      ? ["unpaired"]
      : stale
        ? ["connection_not_current"]
        : readOnly
          ? ["read_only_access"]
          : locked
            ? ["host_locked"]
            : []
  );
  const target = reconnecting
    ? Object.freeze({ kind: "session_detail" as const, sessionId: "sess_access_fixture" })
    : Object.freeze({ kind: "mission_control" as const });
  return Object.freeze({
    epoch: 1,
    target,
    phase: unpaired ? "access_limited" : stale || reconnecting ? "degraded" : "ready",
    access: resource(stale ? "stale" : "current", access),
    host: resource(unpaired ? "blocked" : stale ? "stale" : "current", host),
    targetState: resource(unpaired ? "blocked" : "loading", null),
    stream: Object.freeze({
      state: reconnecting ? "reconnecting" : "not_applicable",
      snapshot: null,
      continuity: reconnecting ? "boundary" : "not_applicable",
      boundary: null,
      failure: null
    }),
    csrf: Object.freeze({
      phase: causes.length === 0 ? "ready" as const : "idle" as const,
      generation: causes.length === 0 ? 1 : null,
      rotatedAt: causes.length === 0 ? timestamp : null,
      failure: null,
      invalidationReason: causes.length === 0 ? null : "not_bootstrapped" as const
    }),
    writeEligibility: Object.freeze({
      scope: "browser_shell" as const,
      eligible: causes.length === 0,
      causes
    }),
    lastFailure: null
  });
}

function resource<Data>(state: "current" | "stale" | "loading" | "blocked", data: Data | null) {
  return Object.freeze({
    state,
    data,
    failure: null,
    observedAt: data === null ? null : timestamp
  });
}

function fixtureCoordinator(
  snapshot: BrowserConnectionSnapshot
): BrowserConnectionStateCoordinator {
  const unexpected = () => {
    throw new TypeError("HostDeck fixture coordinator received an unexpected command.");
  };
  return Object.freeze({
    snapshot: () => snapshot,
    subscribe: () => () => undefined,
    setTarget: unexpected,
    refresh: unexpected,
    loadMoreSessions: unexpected,
    connectSessionStream: unexpected,
    disconnectSessionStream: unexpected,
    bootstrapCsrf: unexpected,
    adoptCsrfBootstrap: unexpected,
    requestProtected: unexpected,
    close: () => snapshot
  }) as never;
}
