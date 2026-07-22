import { sessionIdSchema } from "@hostdeck/contracts/scalars";
import type { SessionId } from "@hostdeck/core";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowLeft, Box, Menu, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  BrowserRouter,
  Link,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams
} from "react-router";
import {
  isMissionSource,
  missionControlPath,
  sessionDetailPathPattern
} from "./app-routing.js";
import {
  type BrowserConnectionCoordinatorFactory,
  createProductionBrowserConnectionCoordinator
} from "./browser-runtime.js";
import type { BrowserConnectionStateCoordinator } from "./connection-state.js";
import { ConnectedMissionControl } from "./mission-control.js";
import {
  projectSessionDetail,
  SessionDetailScreen,
  useSessionDetailController
} from "./session-detail.js";

export {
  missionControlPath,
  SessionRouteLink,
  sessionDetailPath,
  sessionDetailPathPattern
} from "./app-routing.js";

export interface HostDeckRouteOutlets {
  readonly missionControl?: ReactNode;
  readonly sessionDetail?: (sessionId: SessionId) => ReactNode;
  readonly hostAccess?: ReactNode;
}

export interface HostDeckAppProps {
  readonly outlets?: HostDeckRouteOutlets | undefined;
  readonly coordinator?: BrowserConnectionStateCoordinator | undefined;
  readonly createCoordinator?: BrowserConnectionCoordinatorFactory | undefined;
}

interface HostDeckRoutesProps {
  readonly outlets?: HostDeckRouteOutlets | undefined;
  readonly coordinator?: BrowserConnectionStateCoordinator | undefined;
  readonly runtimeFailed?: boolean | undefined;
}

interface OwnedCoordinatorState {
  readonly request: OwnedCoordinatorRequest | null;
  readonly coordinator: BrowserConnectionStateCoordinator | null;
  readonly failed: boolean;
}

interface OwnedCoordinatorRequest {
  readonly active: boolean;
  readonly createCoordinator: BrowserConnectionCoordinatorFactory;
}

const initialCoordinatorState = Object.freeze({
  request: null,
  coordinator: null,
  failed: false
});

export function HostDeckBrowserApp({
  outlets,
  coordinator: injectedCoordinator,
  createCoordinator = createProductionBrowserConnectionCoordinator
}: HostDeckAppProps) {
  const needsBrowserRuntime =
    outlets?.missionControl === undefined || outlets?.sessionDetail === undefined;
  const ownsBrowserRuntime = injectedCoordinator === undefined && needsBrowserRuntime;
  const runtimeRequest = useMemo<OwnedCoordinatorRequest>(
    () => Object.freeze({ active: ownsBrowserRuntime, createCoordinator }),
    [createCoordinator, ownsBrowserRuntime]
  );
  const [ownedState, setOwnedState] = useState<OwnedCoordinatorState>(
    initialCoordinatorState
  );

  useEffect(() => {
    if (!runtimeRequest.active) return;
    let coordinator: BrowserConnectionStateCoordinator;
    try {
      coordinator = runtimeRequest.createCoordinator();
    } catch {
      setOwnedState(
        Object.freeze({ request: runtimeRequest, coordinator: null, failed: true })
      );
      return;
    }
    setOwnedState(
      Object.freeze({ request: runtimeRequest, coordinator, failed: false })
    );
    return () => {
      coordinator.close();
    };
  }, [runtimeRequest]);

  const currentOwnedState =
    ownedState.request === runtimeRequest ? ownedState : initialCoordinatorState;

  return (
    <BrowserRouter>
      <HostDeckRoutes
        outlets={outlets}
        coordinator={injectedCoordinator ?? currentOwnedState.coordinator ?? undefined}
        runtimeFailed={injectedCoordinator === undefined && currentOwnedState.failed}
      />
    </BrowserRouter>
  );
}

export function HostDeckRoutes({
  outlets = {},
  coordinator,
  runtimeFailed = false
}: HostDeckRoutesProps) {
  return (
    <Routes>
      <Route
        path={missionControlPath}
        element={
          <MissionControlRoute
            outlets={outlets}
            coordinator={coordinator}
            runtimeFailed={runtimeFailed}
          />
        }
      />
      <Route
        path={sessionDetailPathPattern}
        element={
          <SessionDetailRoute
            outlets={outlets}
            coordinator={coordinator}
            runtimeFailed={runtimeFailed}
          />
        }
      />
      <Route path="*" element={<NotFoundRoute />} />
    </Routes>
  );
}

function MissionControlRoute({
  outlets,
  coordinator,
  runtimeFailed
}: Readonly<{
  outlets: HostDeckRouteOutlets;
  coordinator: BrowserConnectionStateCoordinator | undefined;
  runtimeFailed: boolean;
}>) {
  let content = outlets.missionControl;
  if (content === undefined) {
    content = coordinator !== undefined
      ? <ConnectedMissionControl coordinator={coordinator} />
      : runtimeFailed
        ? <MissionControlRuntimeFailure />
        : <MissionControlLoading />;
  }
  return (
    <HostDeckFrame hostAccess={outlets.hostAccess}>
      {content}
    </HostDeckFrame>
  );
}

function SessionDetailRoute({
  outlets,
  coordinator,
  runtimeFailed
}: Readonly<{
  outlets: HostDeckRouteOutlets;
  coordinator: BrowserConnectionStateCoordinator | undefined;
  runtimeFailed: boolean;
}>) {
  const rawSessionId = useParams<"session_id">().session_id;
  const parsed = sessionIdSchema.safeParse(rawSessionId);

  if (!parsed.success) {
    return <NotFoundRoute />;
  }

  const sessionId = parsed.data;
  const injectedContent = outlets.sessionDetail?.(sessionId);
  if (injectedContent === undefined && coordinator !== undefined) {
    return (
      <ConnectedSessionDetailRoute
        coordinator={coordinator}
        hostAccess={outlets.hostAccess}
        sessionId={sessionId}
      />
    );
  }
  return (
    <HostDeckFrame
      back={<SessionBackButton />}
      hostAccess={outlets.hostAccess}
      subtitle={
        injectedContent === undefined
          ? runtimeFailed
            ? "Detail unavailable"
            : "Loading session"
          : undefined
      }
      title="Session Detail"
    >
      {injectedContent ??
        (runtimeFailed ? (
          <SessionDetailRuntimeFailure />
        ) : (
          <SessionDetailLoading sessionId={sessionId} />
        ))}
    </HostDeckFrame>
  );
}

function ConnectedSessionDetailRoute({
  coordinator,
  hostAccess,
  sessionId
}: Readonly<{
  coordinator: BrowserConnectionStateCoordinator;
  hostAccess: ReactNode | undefined;
  sessionId: SessionId;
}>) {
  const controller = useSessionDetailController(coordinator, sessionId);
  const projection = projectSessionDetail(
    controller.snapshot,
    sessionId,
    controller.feed,
    controller.nowMs
  );
  return (
    <HostDeckFrame
      back={<SessionBackButton />}
      hostAccess={hostAccess}
      subtitle={projection.headerSubtitle}
      title={projection.headerTitle}
    >
      <SessionDetailScreen
        sessionId={sessionId}
        snapshot={controller.snapshot}
        feed={controller.feed}
        nowMs={controller.nowMs}
        pendingAction={controller.pendingAction}
        actionError={controller.actionError}
        feedError={controller.feedError}
        onRefresh={controller.onRefresh}
        projection={projection}
      />
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
  subtitle?: string | undefined;
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

function MissionControlRuntimeFailure() {
  return (
    <section
      className="hostdeck-route hostdeck-route--error"
      aria-labelledby="mission-control-runtime-title"
      role="alert"
    >
      <span className="hostdeck-error-rail" aria-hidden="true" />
      <div>
        <h1 id="mission-control-runtime-title">Mission Control unavailable</h1>
        <p>The secure browser connection could not start. Reload after checking this address.</p>
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

function SessionDetailRuntimeFailure() {
  return (
    <section
      className="hostdeck-route hostdeck-route--error"
      aria-labelledby="session-detail-runtime-title"
      role="alert"
    >
      <span className="hostdeck-error-rail" aria-hidden="true" />
      <div>
        <h1 id="session-detail-runtime-title">Session Detail unavailable</h1>
        <p>The secure browser connection could not start. Reload after checking this address.</p>
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
