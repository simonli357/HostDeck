import {
  ArrowRight,
  Box,
  Check,
  Circle,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  TriangleAlert,
  Wifi
} from "lucide-react";
import type {
  BrowserAppStartupPhase,
  BrowserAppStartupSnapshot
} from "./app-startup.js";

export interface PairingStartupScreenProps {
  readonly snapshot: BrowserAppStartupSnapshot;
  readonly onContinue: () => void;
  readonly onReload: () => void;
}

interface PairingScreenProjection {
  readonly title: string;
  readonly body: string;
  readonly tone: "connected" | "attention" | "danger" | "muted";
  readonly urgent: boolean;
  readonly stages: readonly PairingStageProjection[];
  readonly action: "continue" | "reload" | null;
}

interface PairingStageProjection {
  readonly label: "Secure link" | "Pair phone" | "Ready";
  readonly state: "complete" | "active" | "pending" | "failed";
}

export function PairingStartupScreen({
  snapshot,
  onContinue,
  onReload
}: PairingStartupScreenProps) {
  const view = projectPairingStartup(snapshot);
  const pairing = snapshot.pairing;
  return (
    <div className="hostdeck-app hostdeck-pairing-app">
      <a className="hostdeck-skip-link" href="#hostdeck-pairing-main">
        Skip to content
      </a>
      <header className="hostdeck-app-bar">
        <div className="hostdeck-app-bar__identity">
          <span className="hostdeck-brand-mark" aria-hidden="true">
            <Box size={24} strokeWidth={2} />
          </span>
          <div className="hostdeck-app-bar__titles">
            <span className="hostdeck-app-bar__title">Pair a phone</span>
            <span className="hostdeck-app-bar__subtitle">Private HTTPS</span>
          </div>
        </div>
        <Smartphone className="hostdeck-pairing-app__phone" size={22} aria-hidden="true" />
      </header>
      <main id="hostdeck-pairing-main" className="hostdeck-pairing" tabIndex={-1}>
        <ol className="hostdeck-pairing-rail" aria-label="Pairing progress">
          {view.stages.map((stage, index) => (
            <li
              key={stage.label}
              className={`hostdeck-pairing-stage hostdeck-pairing-stage--${stage.state}`}
              aria-current={stage.state === "active" ? "step" : undefined}
            >
              <span className="hostdeck-pairing-stage__node" aria-hidden="true">
                {stage.state === "complete" ? (
                  <Check size={16} strokeWidth={3} />
                ) : stage.state === "active" ? (
                  <LoaderCircle className="hostdeck-spin" size={17} strokeWidth={2.5} />
                ) : stage.state === "failed" ? (
                  <TriangleAlert size={16} strokeWidth={2.5} />
                ) : (
                  <Circle size={13} strokeWidth={2} />
                )}
              </span>
              <span>
                <small>Step {index + 1}</small>
                <strong>{stage.label}</strong>
              </span>
            </li>
          ))}
        </ol>

        <section
          className={`hostdeck-pairing-result hostdeck-pairing-result--${view.tone}`}
          aria-labelledby="hostdeck-pairing-title"
          aria-live={view.urgent ? "assertive" : "polite"}
        >
          <span className="hostdeck-pairing-result__icon" aria-hidden="true">
            {resultIcon(snapshot.phase)}
          </span>
          <div className="hostdeck-pairing-result__copy">
            <h1 id="hostdeck-pairing-title">{view.title}</h1>
            <p>{view.body}</p>
          </div>

          {pairing === null ? null : (
            <dl className="hostdeck-pairing-facts">
              <div>
                <dt>Permission</dt>
                <dd>{pairing.permission === "write" ? "Read & write" : "Read only"}</dd>
              </div>
              <div>
                <dt>Device</dt>
                <dd>{pairing.clientLabel ?? "This phone"}</dd>
              </div>
              <div>
                <dt>Transport</dt>
                <dd>Private HTTPS</dd>
              </div>
              <div>
                <dt>Expires</dt>
                <dd>
                  <time dateTime={pairing.deviceExpiresAt}>
                    {formatUtcDate(pairing.deviceExpiresAt)}
                  </time>
                </dd>
              </div>
            </dl>
          )}

          {view.action === "continue" ? (
            <button
              type="button"
              className="hostdeck-primary-button hostdeck-pairing-result__action"
              onClick={onContinue}
            >
              <span>Open Mission Control</span>
              <ArrowRight size={19} strokeWidth={2} aria-hidden="true" />
            </button>
          ) : view.action === "reload" ? (
            <button
              type="button"
              className="hostdeck-action-button hostdeck-pairing-result__action"
              onClick={onReload}
            >
              <RefreshCw size={18} strokeWidth={2} aria-hidden="true" />
              <span>Reload to check</span>
            </button>
          ) : null}
        </section>
      </main>
    </div>
  );
}

export function projectPairingStartup(
  snapshot: BrowserAppStartupSnapshot
): PairingScreenProjection {
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    !Object.isFrozen(snapshot)
  ) {
    throw new TypeError("HostDeck pairing screen snapshot is invalid.");
  }
  const complete = "complete" as const;
  const pending = "pending" as const;
  const failed = "failed" as const;
  switch (snapshot.phase) {
    case "checking":
      return projection(
        "Checking secure link",
        "HostDeck is preparing the private pairing entry.",
        "muted",
        false,
        ["active", pending, pending]
      );
    case "claiming":
      return projection(
        "Pairing this phone",
        "Keep this page open while HostDeck verifies the one-time link.",
        "attention",
        false,
        [complete, "active", pending]
      );
    case "paired":
      return projection(
        "Phone paired",
        "This phone can now open the private HostDeck dashboard.",
        "connected",
        false,
        [complete, complete, complete],
        "continue"
      );
    case "invalid_link":
      return projection(
        "Pairing link is invalid",
        "Create a new pairing link on the laptop and open that link on this phone.",
        "danger",
        true,
        [failed, pending, pending]
      );
    case "secure_entry_failed":
      return projection(
        "Secure entry failed",
        "Close this tab, create a new pairing link on the laptop, and open it in a new tab.",
        "danger",
        true,
        [failed, pending, pending]
      );
    case "link_not_accepted":
      return projection(
        "Pairing link was not accepted",
        "The link may be invalid, expired, or already used. Create a new link on the laptop.",
        "danger",
        true,
        [complete, failed, pending]
      );
    case "origin_rejected":
      return projection(
        "Pairing address was rejected",
        "Open a new link created for this HostDeck address.",
        "danger",
        true,
        [complete, failed, pending]
      );
    case "rate_limited":
      return projection(
        "Pairing attempts are limited",
        "Wait before creating and opening a new pairing link on the laptop.",
        "attention",
        false,
        [complete, failed, pending]
      );
    case "claim_unavailable":
      return projection(
        "Pairing is temporarily unavailable",
        "Check HostDeck on the laptop before creating a new pairing link.",
        "danger",
        false,
        [complete, failed, pending]
      );
    case "claim_unknown":
      return projection(
        "Pairing outcome is unknown",
        "The request may have completed. Reload once to check this phone's access.",
        "attention",
        true,
        [complete, failed, pending],
        "reload"
      );
    case "paired_csrf_unavailable":
      return projection(
        "Phone paired, secure access incomplete",
        "Pairing completed, but this page could not finish secure write setup.",
        "attention",
        true,
        [complete, complete, failed],
        "reload"
      );
    case "startup_failed":
      return projection(
        "HostDeck could not start",
        "Reload once to check the secure browser connection.",
        "danger",
        true,
        [complete, failed, pending],
        "reload"
      );
    case "reloading":
      return projection(
        "Checking this phone",
        "HostDeck is reloading the current secure access state.",
        "muted",
        false,
        [complete, "active", pending]
      );
    case "closed":
      return projection(
        "HostDeck is closed",
        "Open HostDeck again to check access.",
        "muted",
        false,
        [complete, pending, pending]
      );
    case "ready":
      throw new TypeError("Ready HostDeck startup cannot render the pairing screen.");
  }
}

function projection(
  title: string,
  body: string,
  tone: PairingScreenProjection["tone"],
  urgent: boolean,
  stageStates: readonly PairingStageProjection["state"][],
  action: PairingScreenProjection["action"] = null
): PairingScreenProjection {
  return Object.freeze({
    title,
    body,
    tone,
    urgent,
    stages: Object.freeze(
      (["Secure link", "Pair phone", "Ready"] as const).map((label, index) =>
        Object.freeze({ label, state: stageStates[index] ?? "pending" })
      )
    ),
    action
  });
}

function resultIcon(phase: BrowserAppStartupPhase) {
  if (phase === "paired") {
    return <ShieldCheck size={50} strokeWidth={1.8} />;
  }
  if (phase === "claiming" || phase === "checking" || phase === "reloading") {
    return <LoaderCircle className="hostdeck-spin" size={46} strokeWidth={1.8} />;
  }
  if (phase === "paired_csrf_unavailable") {
    return <LockKeyhole size={46} strokeWidth={1.8} />;
  }
  if (phase === "closed") return <Wifi size={46} strokeWidth={1.8} />;
  return <TriangleAlert size={46} strokeWidth={1.8} />;
}

function formatUtcDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Unavailable";
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric"
  }).format(parsed);
}
