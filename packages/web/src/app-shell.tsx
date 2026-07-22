import { sessionIdSchema } from "@hostdeck/contracts/scalars";
import type { SessionId } from "@hostdeck/core";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowLeft, Box, Menu, X } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import {
  BrowserRouter,
  Link,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams
} from "react-router";

export const missionControlPath = "/" as const;
export const sessionDetailPathPattern = "/sessions/:session_id" as const;

const missionSourceKey = "hostdeck_source";
const missionSourceValue = "mission_control";
const missionSourceState = Object.freeze({ [missionSourceKey]: missionSourceValue });

export interface HostDeckRouteOutlets {
  readonly missionControl?: ReactNode;
  readonly sessionDetail?: (sessionId: SessionId) => ReactNode;
  readonly hostAccess?: ReactNode;
}

export interface HostDeckAppProps {
  readonly outlets?: HostDeckRouteOutlets | undefined;
}

export interface SessionRouteLinkProps
  extends Omit<ComponentPropsWithoutRef<"a">, "href"> {
  readonly sessionId: unknown;
}

export function sessionDetailPath(sessionId: unknown): `/sessions/${string}` {
  const parsed = sessionIdSchema.parse(sessionId);
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

export function HostDeckBrowserApp({ outlets }: HostDeckAppProps) {
  return (
    <BrowserRouter>
      <HostDeckRoutes outlets={outlets} />
    </BrowserRouter>
  );
}

export function HostDeckRoutes({ outlets = {} }: HostDeckAppProps) {
  return (
    <Routes>
      <Route path={missionControlPath} element={<MissionControlRoute outlets={outlets} />} />
      <Route path={sessionDetailPathPattern} element={<SessionDetailRoute outlets={outlets} />} />
      <Route path="*" element={<NotFoundRoute />} />
    </Routes>
  );
}

function MissionControlRoute({ outlets }: Readonly<{ outlets: HostDeckRouteOutlets }>) {
  return (
    <HostDeckFrame hostAccess={outlets.hostAccess}>
      {outlets.missionControl ?? <MissionControlLoading />}
    </HostDeckFrame>
  );
}

function SessionDetailRoute({ outlets }: Readonly<{ outlets: HostDeckRouteOutlets }>) {
  const rawSessionId = useParams<"session_id">().session_id;
  const parsed = sessionIdSchema.safeParse(rawSessionId);

  if (!parsed.success) {
    return <NotFoundRoute />;
  }

  const sessionId = parsed.data;
  return (
    <HostDeckFrame
      back={<SessionBackButton />}
      hostAccess={outlets.hostAccess}
      subtitle={sessionId}
      title="Session Detail"
    >
      {outlets.sessionDetail?.(sessionId) ?? <SessionDetailLoading sessionId={sessionId} />}
    </HostDeckFrame>
  );
}

function HostDeckFrame({
  back,
  children,
  hostAccess,
  subtitle,
  title = "HostDeck"
}: Readonly<{
  back?: ReactNode;
  children: ReactNode;
  hostAccess?: ReactNode;
  subtitle?: string;
  title?: string;
}>) {
  return (
    <div className="hostdeck-app">
      <a className="hostdeck-skip-link" href="#hostdeck-main">
        Skip to content
      </a>
      <header className="hostdeck-app-bar">
        <div className="hostdeck-app-bar__identity">
          {back ?? (
            <span className="hostdeck-brand-mark" aria-hidden="true">
              <Box size={24} strokeWidth={2} />
            </span>
          )}
          <div className="hostdeck-app-bar__titles">
            <span className="hostdeck-app-bar__title">{title}</span>
            {subtitle === undefined ? null : (
              <span className="hostdeck-app-bar__subtitle">{subtitle}</span>
            )}
          </div>
        </div>
        <HostAccessSheet>{hostAccess ?? <HostAccessLoading />}</HostAccessSheet>
      </header>
      <main id="hostdeck-main" className="hostdeck-main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}

function SessionBackButton() {
  const location = useLocation();
  const navigate = useNavigate();

  const navigateBack = () => {
    if (isMissionSource(location.state)) {
      navigate(-1);
      return;
    }
    navigate(missionControlPath, { replace: true });
  };

  return (
    <button
      type="button"
      className="hostdeck-icon-button"
      aria-label="Back to Mission Control"
      onClick={navigateBack}
    >
      <ArrowLeft size={24} strokeWidth={2} />
    </button>
  );
}

function isMissionSource(state: unknown): boolean {
  if (state === null || typeof state !== "object" || Array.isArray(state)) return false;
  try {
    return Reflect.get(state, missionSourceKey) === missionSourceValue;
  } catch {
    return false;
  }
}

function HostAccessSheet({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button type="button" className="hostdeck-icon-button" aria-label="Open Host and access">
          <Menu size={24} strokeWidth={2} />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="hostdeck-sheet-overlay" />
        <Dialog.Content className="hostdeck-sheet">
          <span className="hostdeck-sheet__handle" aria-hidden="true" />
          <div className="hostdeck-sheet__header">
            <Dialog.Title className="hostdeck-sheet__title">Host &amp; access</Dialog.Title>
            <Dialog.Description className="hostdeck-visually-hidden">
              Host access details.
            </Dialog.Description>
            <Dialog.Close asChild>
              <button type="button" className="hostdeck-icon-button" aria-label="Close Host and access">
                <X size={22} strokeWidth={2} />
              </button>
            </Dialog.Close>
          </div>
          <div className="hostdeck-sheet__body">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function MissionControlLoading() {
  return (
    <section className="hostdeck-route" aria-labelledby="mission-control-title" aria-busy="true">
      <div className="hostdeck-status-loading" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="hostdeck-route__heading">
        <h1 id="mission-control-title">Mission Control</h1>
        <span className="hostdeck-route__meta" role="status">
          Loading sessions
        </span>
      </div>
      <div className="hostdeck-queue-loading" aria-hidden="true">
        <span className="hostdeck-loading-line hostdeck-loading-line--short" />
        <span className="hostdeck-loading-item" />
        <span className="hostdeck-loading-item" />
        <span className="hostdeck-loading-line hostdeck-loading-line--short" />
        <span className="hostdeck-loading-item hostdeck-loading-item--compact" />
      </div>
    </section>
  );
}

function SessionDetailLoading({ sessionId }: Readonly<{ sessionId: SessionId }>) {
  return (
    <section className="hostdeck-route" aria-labelledby="session-detail-title" aria-busy="true">
      <div className="hostdeck-route__heading hostdeck-route__heading--detail">
        <h1 id="session-detail-title">Session Detail</h1>
        <span className="hostdeck-route__meta" role="status">
          Loading session
        </span>
      </div>
      <div className="hostdeck-session-target">
        <span>Target</span>
        <strong>{sessionId}</strong>
      </div>
      <div className="hostdeck-timeline-loading" aria-hidden="true">
        <span className="hostdeck-timeline-loading__rail" />
        <span className="hostdeck-timeline-loading__item" />
        <span className="hostdeck-timeline-loading__item" />
        <span className="hostdeck-timeline-loading__item" />
      </div>
    </section>
  );
}

function HostAccessLoading() {
  return (
    <div className="hostdeck-access-loading" aria-busy="true">
      <span className="hostdeck-visually-hidden" role="status">
        Loading host access
      </span>
      <span className="hostdeck-loading-line" aria-hidden="true" />
      <span className="hostdeck-loading-line" aria-hidden="true" />
      <span className="hostdeck-loading-line hostdeck-loading-line--short" aria-hidden="true" />
    </div>
  );
}

function NotFoundRoute() {
  return (
    <HostDeckFrame>
      <section className="hostdeck-route hostdeck-route--error" aria-labelledby="not-found-title">
        <span className="hostdeck-error-rail" aria-hidden="true" />
        <div>
          <h1 id="not-found-title">Page not found</h1>
          <p>The requested HostDeck page is unavailable.</p>
          <Link className="hostdeck-text-link" to={missionControlPath} replace>
            Mission Control
          </Link>
        </div>
      </section>
    </HostDeckFrame>
  );
}
