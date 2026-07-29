import type { SessionId } from "@hostdeck/core";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  CircleOff,
  Clock3,
  Info,
  ListFilter,
  LoaderCircle,
  RefreshCw,
  Search,
  Sparkles,
  X
} from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type {
  BrowserConnectionSnapshot,
  BrowserConnectionStateCoordinator
} from "./connection-state.js";
import {
  createSkillsControlController,
  type SkillItemView,
  type SkillsControlController,
  type SkillsControlPhase,
  type SkillsControlTone
} from "./skills-control-state.js";

export interface SkillsSheetBodyProps {
  readonly controller: SkillsControlController;
  readonly view: ReturnType<SkillsControlController["snapshot"]>;
  readonly statusId: string;
}

export const skillsVisiblePageSize = 24;
export const skillsSearchMaximumLength = 160;
const longDescriptionThreshold = 240;
const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit"
});

export function useSkillsControlController(
  coordinator: BrowserConnectionStateCoordinator,
  sessionId: SessionId,
  snapshot: BrowserConnectionSnapshot
): SkillsControlController {
  const contextRef = useRef(Object.freeze({ snapshot }));
  contextRef.current = Object.freeze({ snapshot });
  const owner = useMemo(
    () =>
      createSkillsControlController({
        sessionId,
        context: contextRef.current,
        port: Object.freeze({
          async read(input: { readonly sessionId: SessionId; readonly signal: AbortSignal }) {
            const response = await coordinator.requestSelectedSessionRead(
              "skills_read",
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
    controller: SkillsControlController;
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

export function SkillsSheetBody({
  controller,
  view,
  statusId
}: SkillsSheetBodyProps) {
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(skillsVisiblePageSize);

  useEffect(() => {
    if (view.captureRevision === null) return;
    setQuery("");
    setVisibleCount(skillsVisiblePageSize);
  }, [view.captureRevision]);

  const normalizedQuery = query.trim().toLowerCase();
  const sourceSkills = view.skills ?? [];
  const matchingSkills = useMemo(
    () => normalizedQuery.length === 0
      ? sourceSkills
      : sourceSkills.filter((skill) =>
          skill.name.toLowerCase().includes(normalizedQuery) ||
          (skill.description?.toLowerCase().includes(normalizedQuery) ?? false)
        ),
    [normalizedQuery, sourceSkills]
  );
  const visibleSkills = matchingSkills.slice(0, visibleCount);
  const remainingCount = matchingSkills.length - visibleSkills.length;
  const showLoading = view.phase === "loading" && view.capture === null;
  const showUnavailable =
    view.capture === null &&
    (view.phase === "unsupported" || view.phase === "failure");

  const updateQuery = (value: string) => {
    setQuery(value.slice(0, skillsSearchMaximumLength));
    setVisibleCount(skillsVisiblePageSize);
  };

  return (
    <div className="hostdeck-skills-sheet__body">
      <div className="hostdeck-skills-sheet__scroller">
        {showLoading ? (
          <SkillsLoading />
        ) : showUnavailable ? (
          <SkillsUnavailable phase={view.phase} />
        ) : (
          <div className="hostdeck-skills-content">
            <SkillsCapture view={view} />
            <SkillsSummary view={view} />
            <SkillsStateBoundary view={view} />
            {sourceSkills.length === 0 ? null : (
              <SkillsDiscovery
                matchingSkills={matchingSkills}
                onQuery={updateQuery}
                onShowMore={() => setVisibleCount((count) => count + skillsVisiblePageSize)}
                query={query}
                remainingCount={remainingCount}
                statusId={statusId}
                visibleSkills={visibleSkills}
              />
            )}
          </div>
        )}
      </div>
      <SkillsFooter controller={controller} statusId={statusId} view={view} />
    </div>
  );
}

function SkillsCapture({
  view
}: Readonly<{ view: ReturnType<SkillsControlController["snapshot"]> }>) {
  const capture = view.capture;
  const stale = capture?.freshness === "stale";
  return (
    <section className={`hostdeck-skills-capture hostdeck-tone--${stale ? "attention" : "connected"}`}>
      <Clock3 size={19} strokeWidth={2} aria-hidden="true" />
      <span>
        <small>Capture</small>
        <strong>{stale ? "Stale" : "Current"}</strong>
        {capture === null ? null : (
          <span>
            <SkillsTime value={capture.observedAt} />
            <span aria-hidden="true"> / </span>
            <span>Codex {capture.runtimeVersion}</span>
          </span>
        )}
      </span>
    </section>
  );
}

function SkillsSummary({
  view
}: Readonly<{ view: ReturnType<SkillsControlController["snapshot"]> }>) {
  const summary = view.summary;
  if (summary === null) return null;
  return (
    <section className="hostdeck-skills-summary" aria-label="Skills summary">
      <SkillMetric label="Skills" value={summary.total} />
      <SkillMetric label="Enabled" value={summary.enabled} />
      <SkillMetric label="Disabled" value={summary.disabled} />
      <SkillMetric label="Reported errors" value={summary.errorCount} />
    </section>
  );
}

function SkillMetric({ label, value }: Readonly<{ label: string; value: number }>) {
  return (
    <span>
      <small>{label}</small>
      <strong>{value.toLocaleString()}</strong>
    </span>
  );
}

function SkillsStateBoundary({
  view
}: Readonly<{ view: ReturnType<SkillsControlController["snapshot"]> }>) {
  const state = view.snapshotState;
  if (state === null || state === "content") return null;
  const tone: SkillsControlTone = state === "error"
    ? "danger"
    : state === "partial"
      ? "attention"
      : "muted";
  const Icon = state === "error" || state === "partial" ? AlertTriangle : Info;
  const summary = view.summary;
  const copy = state === "empty"
    ? "No skills or reported errors are present in this result."
    : state === "partial"
      ? `${summary?.errorCount ?? 0} reported ${summary?.errorCount === 1 ? "error is" : "errors are"} redacted; readable skills remain listed.`
      : `${summary?.errorCount ?? 0} reported ${summary?.errorCount === 1 ? "error is" : "errors are"} redacted; no readable skills were returned.`;
  return (
    <section className={`hostdeck-skills-boundary hostdeck-tone--${tone}`}>
      <Icon size={19} strokeWidth={2} aria-hidden="true" />
      <span>
        <strong>{state === "empty" ? "Empty snapshot" : state === "partial" ? "Partial snapshot" : "Snapshot error"}</strong>
        <small>{copy}</small>
      </span>
    </section>
  );
}

function SkillsDiscovery({
  matchingSkills,
  onQuery,
  onShowMore,
  query,
  remainingCount,
  statusId,
  visibleSkills
}: Readonly<{
  matchingSkills: readonly SkillItemView[];
  onQuery: (value: string) => void;
  onShowMore: () => void;
  query: string;
  remainingCount: number;
  statusId: string;
  visibleSkills: readonly SkillItemView[];
}>) {
  const searchId = useId();
  const resultsId = `${statusId}-results`;
  return (
    <section className="hostdeck-skills-discovery" aria-labelledby={`${searchId}-heading`}>
      <div className="hostdeck-skills-discovery__heading">
        <ListFilter size={19} strokeWidth={2} aria-hidden="true" />
        <span>
          <h2 id={`${searchId}-heading`}>Skills</h2>
          <small id={resultsId} role="status" aria-live="polite">
            {query.length === 0
              ? `${matchingSkills.length.toLocaleString()} reported`
              : `${matchingSkills.length.toLocaleString()} matching`}
          </small>
        </span>
      </div>
      <div className="hostdeck-skills-search">
        <label className="hostdeck-visually-hidden" htmlFor={searchId}>Search skills</label>
        <Search size={18} strokeWidth={2} aria-hidden="true" />
        <input
          id={searchId}
          type="search"
          value={query}
          maxLength={skillsSearchMaximumLength}
          placeholder="Search skills"
          aria-describedby={resultsId}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onQuery(event.currentTarget.value)}
        />
        {query.length === 0 ? null : (
          <button
            type="button"
            className="hostdeck-icon-button"
            aria-label="Clear Skills search"
            title="Clear Skills search"
            onClick={() => onQuery("")}
          >
            <X size={18} strokeWidth={2} aria-hidden="true" />
          </button>
        )}
      </div>
      {matchingSkills.length === 0 ? (
        <div className="hostdeck-skills-no-match">
          <Search size={22} strokeWidth={2} aria-hidden="true" />
          <strong>No skills match this search</strong>
        </div>
      ) : (
        <ul className="hostdeck-skills-list">
          {visibleSkills.map((skill) => (
            <SkillRow key={skill.name} skill={skill} />
          ))}
        </ul>
      )}
      {remainingCount <= 0 ? null : (
        <button
          type="button"
          className="hostdeck-skills-show-more"
          onClick={onShowMore}
        >
          <ChevronDown size={18} strokeWidth={2} aria-hidden="true" />
          Show {Math.min(skillsVisiblePageSize, remainingCount)} more
        </button>
      )}
    </section>
  );
}

function SkillRow({ skill }: Readonly<{ skill: SkillItemView }>) {
  const [expanded, setExpanded] = useState(false);
  const descriptionId = useId();
  const hasLongDescription =
    skill.descriptionState === "content" &&
    (skill.description?.length ?? 0) > longDescriptionThreshold;
  const StateIcon = skill.enabled ? CircleCheck : CircleOff;
  const description = skill.descriptionState === "not_reported"
    ? "Description not reported"
    : skill.descriptionState === "empty"
      ? "No description provided"
      : skill.description;

  return (
    <li className={`hostdeck-skill-row${skill.enabled ? "" : " hostdeck-skill-row--disabled"}`}>
      <div className="hostdeck-skill-row__heading">
        <Sparkles size={18} strokeWidth={2} aria-hidden="true" />
        <span>
          <strong>{skill.name}</strong>
          <small>{skill.scopeLabel}</small>
        </span>
        <span className={`hostdeck-skill-row__state hostdeck-tone--${skill.enabled ? "connected" : "muted"}`}>
          <StateIcon size={16} strokeWidth={2} aria-hidden="true" />
          {skill.enabled ? "Enabled" : "Disabled"}
        </span>
      </div>
      <p
        id={descriptionId}
        className={hasLongDescription && !expanded ? "hostdeck-skill-row__description--collapsed" : undefined}
      >
        {description}
      </p>
      {!hasLongDescription ? null : (
        <button
          type="button"
          className="hostdeck-skill-row__disclosure"
          aria-expanded={expanded}
          aria-controls={descriptionId}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? (
            <ChevronUp size={17} strokeWidth={2} aria-hidden="true" />
          ) : (
            <ChevronDown size={17} strokeWidth={2} aria-hidden="true" />
          )}
          {expanded ? "Collapse description" : "Expand description"}
        </button>
      )}
    </li>
  );
}

function SkillsFooter({
  controller,
  statusId,
  view
}: Readonly<{
  controller: SkillsControlController;
  statusId: string;
  view: ReturnType<SkillsControlController["snapshot"]>;
}>) {
  const StatusIcon = statusIcon(view.phase, view.tone);
  return (
    <footer className="hostdeck-skills-footer">
      <div
        id={statusId}
        className={`hostdeck-skills-status hostdeck-tone--${view.tone}`}
        role="status"
        aria-live="polite"
        aria-busy={view.busy}
      >
        <StatusIcon
          className={view.busy ? "hostdeck-spin" : undefined}
          size={19}
          strokeWidth={2}
          aria-hidden="true"
        />
        <span>
          <strong>{view.status}</strong>
          {view.statusDetail === null ? null : <small>{view.statusDetail}</small>}
        </span>
        <button
          type="button"
          className="hostdeck-icon-button hostdeck-skills-status__refresh"
          aria-label="Refresh Skills"
          title="Refresh Skills"
          disabled={!view.refreshEnabled}
          onClick={() => void controller.refresh()}
        >
          <RefreshCw size={19} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    </footer>
  );
}

function SkillsLoading() {
  return (
    <div className="hostdeck-skills-loading" aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}

function SkillsUnavailable({ phase }: Readonly<{ phase: SkillsControlPhase }>) {
  return (
    <div className="hostdeck-skills-unavailable" aria-hidden="true">
      {phase === "unsupported" ? (
        <Info size={26} strokeWidth={2} />
      ) : (
        <AlertTriangle size={26} strokeWidth={2} />
      )}
    </div>
  );
}

function SkillsTime({ value }: Readonly<{ value: string }>) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("HostDeck Skills time is invalid.");
  }
  return <time dateTime={value}>{timestampFormatter.format(date)}</time>;
}

function statusIcon(phase: SkillsControlPhase, tone: SkillsControlTone) {
  if (phase === "loading") return LoaderCircle;
  if (tone === "danger") return AlertTriangle;
  if (tone === "connected") return Check;
  if (tone === "attention") return Clock3;
  return Sparkles;
}
