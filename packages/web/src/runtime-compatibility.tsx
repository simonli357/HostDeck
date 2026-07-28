import {
  AlertTriangle,
  CircleCheck,
  CircleHelp,
  LoaderCircle,
  type LucideIcon,
  RefreshCw,
  ShieldAlert,
  Unplug
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef
} from "react";
import type {
  BrowserConnectionSnapshot,
  BrowserConnectionStateCoordinator
} from "./connection-state.js";
import {
  createRuntimeCompatibilityController,
  type RuntimeCompatibilityController,
  type RuntimeCompatibilityView
} from "./runtime-compatibility-state.js";

export interface RuntimeCompatibilityPanelProps {
  readonly view: RuntimeCompatibilityView;
  readonly onCheck?: (() => Promise<RuntimeCompatibilityView>) | undefined;
}

export function useRuntimeCompatibilityController(
  coordinator: BrowserConnectionStateCoordinator,
  snapshot: BrowserConnectionSnapshot
): RuntimeCompatibilityController {
  const owner = useMemo(
    () =>
      createRuntimeCompatibilityController({
        port: Object.freeze({
          snapshot: coordinator.snapshot,
          refresh: coordinator.refresh
        })
      }),
    [coordinator]
  );
  const activeOwner = useRef<Readonly<{
    controller: RuntimeCompatibilityController;
    token: object;
  }> | null>(null);

  useLayoutEffect(() => {
    void snapshot;
    owner.synchronize();
  }, [owner, snapshot]);

  useEffect(() => {
    const token = Object.freeze({});
    activeOwner.current = Object.freeze({ controller: owner, token });
    return () => {
      queueMicrotask(() => {
        const active = activeOwner.current;
        if (active?.controller === owner && active.token !== token) return;
        owner.close();
      });
    };
  }, [owner]);

  return owner;
}

export function RuntimeCompatibilityPanel({
  view,
  onCheck
}: RuntimeCompatibilityPanelProps) {
  if (view.action !== null && onCheck === undefined) {
    throw new TypeError("HostDeck compatibility action is missing its owner.");
  }
  const Icon = compatibilityIcon(view);
  const showFacts =
    view.state !== null ||
    view.phase === "unavailable" ||
    view.phase === "check_failed" ||
    view.phase === "recovery_unconfirmed";
  return (
    <section
      className={`hostdeck-runtime-compatibility hostdeck-tone--${view.tone}`}
      aria-labelledby="hostdeck-runtime-compatibility-title"
      aria-describedby="hostdeck-runtime-compatibility-detail"
      aria-busy={view.busy || undefined}
    >
      <div className="hostdeck-runtime-compatibility__owner">
        <span>{view.ownerLabel}</span>
        <small>{view.sourceLabel}</small>
      </div>
      <div
        className="hostdeck-runtime-compatibility__state"
        role={view.urgent || view.phase === "check_failed" ? "alert" : "status"}
        aria-atomic="true"
      >
        <Icon
          className={view.busy ? "hostdeck-spin" : undefined}
          size={24}
          strokeWidth={2}
          aria-hidden="true"
        />
        <div className="hostdeck-runtime-compatibility__copy">
          <h2 id="hostdeck-runtime-compatibility-title">{view.title}</h2>
          <p id="hostdeck-runtime-compatibility-detail">{view.detail}</p>
        </div>
      </div>
      {showFacts ? (
        <dl className="hostdeck-runtime-compatibility__facts">
          <CompatibilityFact label="Installed" value={view.observedVersionLabel} />
          <CompatibilityFact label="HostDeck supports" value={view.supportedVersionLabel} />
          <CompatibilityFact label="Controls" value={view.capabilityLabel} />
          <CompatibilityFact
            label="Evidence"
            value={view.evidenceLabel}
            detail={view.checkedLabel}
          />
        </dl>
      ) : null}
      {view.action === null ? null : (
        <button
          type="button"
          className="hostdeck-action-button hostdeck-runtime-compatibility__action"
          disabled={!view.actionEnabled}
          aria-busy={view.busy || undefined}
          onClick={() => {
            if (onCheck !== undefined) void onCheck();
          }}
        >
          {view.busy ? (
            <LoaderCircle className="hostdeck-spin" size={18} strokeWidth={2} aria-hidden="true" />
          ) : (
            <RefreshCw size={18} strokeWidth={2} aria-hidden="true" />
          )}
          <span>{view.actionLabel}</span>
        </button>
      )}
    </section>
  );
}

function CompatibilityFact({
  label,
  value,
  detail
}: Readonly<{
  label: string;
  value: string;
  detail?: string | undefined;
}>) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <span>{value}</span>
        {detail === undefined ? null : <small>{detail}</small>}
      </dd>
    </div>
  );
}

function compatibilityIcon(view: RuntimeCompatibilityView): LucideIcon {
  switch (view.phase) {
    case "supported":
      return CircleCheck;
    case "checking":
    case "loading":
      return LoaderCircle;
    case "version_drift":
    case "incompatible":
    case "check_failed":
    case "recovery_unconfirmed":
      return ShieldAlert;
    case "disconnected":
      return Unplug;
    case "degraded":
    case "unavailable":
      return AlertTriangle;
    case "unknown":
    case "hidden":
    case "closed":
      return CircleHelp;
  }
}
