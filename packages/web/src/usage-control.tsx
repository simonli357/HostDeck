import type { SessionId } from "@hostdeck/core";
import {
  Activity,
  AlertTriangle,
  CalendarDays,
  CircleCheck,
  CircleDot,
  Clock3,
  Database,
  Info,
  LoaderCircle,
  RefreshCw,
  TimerReset
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
  createUsageControlController,
  type UsageControlController,
  type UsageControlPhase,
  type UsageControlTone,
  type UsageMetricView,
  type UsageRateWindowView,
  type UsageTokenBreakdownView
} from "./usage-control-state.js";

export interface UsageSheetBodyProps {
  readonly controller: UsageControlController;
  readonly view: ReturnType<UsageControlController["snapshot"]>;
  readonly statusId: string;
}

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit"
});
const calendarDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  timeZone: "UTC"
});

export function useUsageControlController(
  coordinator: BrowserConnectionStateCoordinator,
  sessionId: SessionId,
  snapshot: BrowserConnectionSnapshot
): UsageControlController {
  const contextRef = useRef(Object.freeze({ snapshot }));
  contextRef.current = Object.freeze({ snapshot });
  const owner = useMemo(
    () =>
      createUsageControlController({
        sessionId,
        context: contextRef.current,
        port: Object.freeze({
          async read(input: { readonly sessionId: SessionId; readonly signal: AbortSignal }) {
            const response = await coordinator.requestSelectedSessionRead(
              "usage_read",
              { params: { session_id: input.sessionId } },
              { signal: input.signal }
            );
            return response.data;
          }
        })
      }),
    [coordinator, sessionId]
  );
  const activeOwner = useRef<Readonly<{
    controller: UsageControlController;
    token: object;
  }> | null>(null);

  useLayoutEffect(() => {
    owner.updateContext(Object.freeze({ snapshot }));
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

export function UsageSheetBody({
  controller,
  view,
  statusId
}: UsageSheetBodyProps) {
  const hasData =
    view.capture !== null &&
    view.account !== null &&
    view.thread !== null &&
    view.rateLimits !== null;
  return (
    <div className="hostdeck-usage-sheet__body">
      <section
        className="hostdeck-usage-sheet__scroller"
        aria-label="Usage details"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The read-only overflow owner must be keyboard-scrollable.
        tabIndex={0}
      >
        {!hasData && view.phase === "loading" ? <UsageLoading /> : null}
        {hasData ? (
          <div className="hostdeck-usage-content">
            <UsageCapture view={view} />
            <UsageScopeSummary view={view} />
            <UsageAccount account={view.account} />
            <UsageThread thread={view.thread} />
            <UsageRateLimits rateLimits={view.rateLimits} />
          </div>
        ) : view.phase === "unsupported" || view.phase === "failure" ? (
          <UsageUnavailable phase={view.phase} />
        ) : null}
      </section>
      <UsageStatus controller={controller} view={view} statusId={statusId} />
    </div>
  );
}

function UsageCapture({ view }: Readonly<{ view: ReturnType<UsageControlController["snapshot"]> }>) {
  if (view.capture === null) return null;
  return (
    <section className={`hostdeck-usage-capture hostdeck-tone--${view.tone}`}>
      <Clock3 size={20} strokeWidth={2} aria-hidden="true" />
      <span>
        <small>Capture</small>
        <strong>{view.capture.freshness === "current" ? "Current" : "Stale"}</strong>
        <span>
          <UsageTime value={view.capture.measuredAt} />
          <span aria-hidden="true"> / </span>
          <span>Codex {view.capture.runtimeVersion}</span>
        </span>
      </span>
    </section>
  );
}

function UsageScopeSummary({
  view
}: Readonly<{ view: ReturnType<UsageControlController["snapshot"]> }>) {
  if (view.account === null || view.thread === null || view.rateLimits === null) return null;
  const accountMetric = view.account.metrics[0] ?? null;
  const threadBreakdown = view.thread.state === "observed" ? view.thread.total : null;
  const rateValue =
    view.rateLimits.state === "observed"
      ? view.rateLimits.primary?.usedPercent ?? "Not reported"
      : "Not observed";
  return (
    <dl className="hostdeck-usage-summary" aria-label="Usage scope summary">
      <div>
        <dt>Account</dt>
        <dd>
          {accountMetric === null ? (
            "Not reported"
          ) : (
            <UsageCompactValue
              value={accountMetric.displayValue}
              exact={accountMetric.value}
            />
          )}
          <small>lifetime tokens</small>
        </dd>
      </div>
      <div>
        <dt>This thread</dt>
        <dd>
          {threadBreakdown === null ? (
            "Not observed"
          ) : (
            <UsageCompactValue
              value={threadBreakdown.total}
              exact={threadBreakdown.totalExact}
            />
          )}
          <small>cumulative tokens</small>
        </dd>
      </div>
      <div>
        <dt>Primary limit</dt>
        <dd>{rateValue}<small>used</small></dd>
      </div>
    </dl>
  );
}

function UsageAccount({
  account
}: Readonly<{
  account: NonNullable<ReturnType<UsageControlController["snapshot"]>["account"]>;
}>) {
  return (
    <section className="hostdeck-usage-section" aria-labelledby="hostdeck-usage-account-title">
      <div className="hostdeck-usage-section__heading">
        <Database size={19} strokeWidth={2} aria-hidden="true" />
        <span>
          <h2 id="hostdeck-usage-account-title">Account</h2>
          <small>Account scope, not this session</small>
        </span>
      </div>
      <UsageMetrics metrics={account.metrics} />
      <div className="hostdeck-usage-daily">
        <h3>
          <CalendarDays size={17} strokeWidth={2} aria-hidden="true" />
          Daily history
        </h3>
        {account.dailyHistory.state === "not_reported" ? (
          <p>Daily history not reported.</p>
        ) : account.dailyHistory.state === "empty" ? (
          <p>No daily buckets reported.</p>
        ) : (
          <>
            <dl>
              {account.dailyHistory.buckets.map((bucket) => (
                <div key={bucket.date}>
                  <dt><UsageCalendarDate value={bucket.date} /></dt>
                  <dd>
                    {bucket.tokens} {bucket.tokens === "1" ? "token" : "tokens"}
                  </dd>
                </div>
              ))}
            </dl>
            {account.dailyHistory.omittedCount === 0 ? null : (
              <p>
                {account.dailyHistory.omittedCount} older {account.dailyHistory.omittedCount === 1 ? "bucket" : "buckets"} omitted.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function UsageThread({
  thread
}: Readonly<{
  thread: NonNullable<ReturnType<UsageControlController["snapshot"]>["thread"]>;
}>) {
  return (
    <section className="hostdeck-usage-section" aria-labelledby="hostdeck-usage-thread-title">
      <div className="hostdeck-usage-section__heading">
        <Activity size={19} strokeWidth={2} aria-hidden="true" />
        <span>
          <h2 id="hostdeck-usage-thread-title">This thread</h2>
          <small>{thread.state === "observed" ? <UsageTime value={thread.observedAt} /> : "No same-generation observation"}</small>
        </span>
      </div>
      {thread.state === "not_observed" ? (
        <UsageAbsent text="Thread usage not observed." />
      ) : (
        <>
          <UsageMetrics metrics={[thread.contextWindow]} />
          <TokenBreakdown label="Cumulative" breakdown={thread.total} />
          <TokenBreakdown label="Last update" breakdown={thread.last} />
        </>
      )}
    </section>
  );
}

function UsageRateLimits({
  rateLimits
}: Readonly<{
  rateLimits: NonNullable<ReturnType<UsageControlController["snapshot"]>["rateLimits"]>;
}>) {
  return (
    <section className="hostdeck-usage-section" aria-labelledby="hostdeck-usage-rates-title">
      <div className="hostdeck-usage-section__heading">
        <TimerReset size={19} strokeWidth={2} aria-hidden="true" />
        <span>
          <h2 id="hostdeck-usage-rates-title">Rate limits</h2>
          <small>{rateLimits.state === "observed" ? <UsageTime value={rateLimits.observedAt} /> : "No same-generation observation"}</small>
        </span>
      </div>
      {rateLimits.state === "not_observed" ? (
        <UsageAbsent text="Rate limits not observed." />
      ) : (
        <>
          <div className="hostdeck-usage-rate-windows">
            <RateWindow label="Primary" window={rateLimits.primary} />
            <RateWindow label="Secondary" window={rateLimits.secondary} />
          </div>
          {rateLimits.reachedLabel === null ? null : (
            <p className="hostdeck-usage-limit-reached" role="alert">
              <AlertTriangle size={17} strokeWidth={2} aria-hidden="true" />
              <span>{rateLimits.reachedLabel}</span>
            </p>
          )}
        </>
      )}
    </section>
  );
}

function UsageMetrics({ metrics }: Readonly<{ metrics: readonly UsageMetricView[] }>) {
  return (
    <dl className="hostdeck-usage-metrics">
      {metrics.map((metric) => (
        <div key={metric.label}>
          <dt>{metric.label}</dt>
          <dd className={metric.reported ? undefined : "hostdeck-usage-value--muted"}>
            {metric.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function TokenBreakdown({
  label,
  breakdown
}: Readonly<{ label: string; breakdown: UsageTokenBreakdownView }>) {
  return (
    <div className="hostdeck-usage-breakdown">
      <h3>{label}</h3>
      <dl>
        <div><dt>Total</dt><dd><UsageCompactValue value={breakdown.total} exact={breakdown.totalExact} /></dd></div>
        <div><dt>Input</dt><dd><UsageCompactValue value={breakdown.input} exact={breakdown.inputExact} /></dd></div>
        <div><dt>Cached input</dt><dd><UsageCompactValue value={breakdown.cachedInput} exact={breakdown.cachedInputExact} /></dd></div>
        <div><dt>Output</dt><dd><UsageCompactValue value={breakdown.output} exact={breakdown.outputExact} /></dd></div>
        <div><dt>Reasoning output</dt><dd><UsageCompactValue value={breakdown.reasoningOutput} exact={breakdown.reasoningOutputExact} /></dd></div>
      </dl>
    </div>
  );
}

function UsageCompactValue({ value, exact }: Readonly<{ value: string; exact: string }>) {
  return (
    <span className="hostdeck-usage-compact-value" title={exact}>
      <span aria-hidden="true">{value}</span>
      <span className="hostdeck-visually-hidden">{exact}</span>
    </span>
  );
}

function RateWindow({
  label,
  window
}: Readonly<{ label: string; window: UsageRateWindowView | null }>) {
  return (
    <section className="hostdeck-usage-rate-window">
      <h3>{label}</h3>
      {window === null ? (
        <p>Not reported</p>
      ) : (
        <dl>
          <div><dt>Used</dt><dd>{window.usedPercent}</dd></div>
          <div><dt>Window</dt><dd>{window.duration}</dd></div>
          <div><dt>Resets</dt><dd>{window.resetsAt === null ? "Not reported" : <UsageTime value={window.resetsAt} />}</dd></div>
        </dl>
      )}
    </section>
  );
}

function UsageAbsent({ text }: Readonly<{ text: string }>) {
  return (
    <p className="hostdeck-usage-absent">
      <CircleDot size={17} strokeWidth={2} aria-hidden="true" />
      <span>{text}</span>
    </p>
  );
}

function UsageStatus({
  controller,
  view,
  statusId
}: Readonly<{
  controller: UsageControlController;
  view: ReturnType<UsageControlController["snapshot"]>;
  statusId: string;
}>) {
  const StatusIcon = view.busy ? LoaderCircle : usageStatusIcon(view.tone);
  return (
    <div
      className={`hostdeck-usage-status hostdeck-tone--${view.tone}`}
      id={statusId}
      role={view.tone === "danger" ? "alert" : "status"}
      aria-live={view.tone === "danger" ? "assertive" : "polite"}
      aria-atomic="true"
    >
      <StatusIcon
        size={18}
        strokeWidth={2}
        className={view.busy ? "hostdeck-spin" : undefined}
        aria-hidden="true"
      />
      <span>
        <strong>{view.status}</strong>
        {view.statusDetail === null ? null : <small>{view.statusDetail}</small>}
      </span>
      <button
        type="button"
        className="hostdeck-icon-button hostdeck-usage-status__refresh"
        aria-label="Refresh structured usage"
        title="Refresh structured usage"
        disabled={!view.refreshEnabled}
        onClick={() => void controller.refresh()}
      >
        <RefreshCw size={18} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}

function UsageLoading() {
  return (
    <div className="hostdeck-usage-loading" aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}

function UsageUnavailable({ phase }: Readonly<{ phase: UsageControlPhase }>) {
  const Icon = phase === "unsupported" ? Info : AlertTriangle;
  return (
    <div className="hostdeck-usage-unavailable" aria-hidden="true">
      <Icon size={24} strokeWidth={2} />
    </div>
  );
}

function UsageTime({ value }: Readonly<{ value: string }>) {
  const date = new Date(value);
  return (
    <time dateTime={value} title={value}>
      {Number.isNaN(date.valueOf()) ? "Unknown" : timestampFormatter.format(date)}
    </time>
  );
}

function UsageCalendarDate({ value }: Readonly<{ value: string }>) {
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    <time dateTime={value} title={value}>
      {Number.isNaN(date.valueOf()) ? value : calendarDateFormatter.format(date)}
    </time>
  );
}

function usageStatusIcon(tone: UsageControlTone) {
  if (tone === "danger") return AlertTriangle;
  if (tone === "connected") return CircleCheck;
  return CircleDot;
}
