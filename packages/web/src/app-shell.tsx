import { sessionIdSchema } from "@hostdeck/contracts/scalars";
import type { SessionId } from "@hostdeck/core";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowLeft, Box, Menu, X } from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import {
  BrowserRouter,
  Link,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useNavigationType,
  useParams
} from "react-router";
import {
  type HostDeckRouteFocusLocation,
  hostDeckDocumentTitle,
  resolveHostDeckRouteFocus
} from "./accessibility-state.js";
import {
  isMissionSource,
  missionControlPath,
  sessionDetailPathPattern
} from "./app-routing.js";
import type { BrowserAppStartupController } from "./app-startup.js";
import {
  type BrowserConnectionCoordinatorFactory,
  createProductionBrowserConnectionCoordinator
} from "./browser-runtime.js";
import type { BrowserConnectionStateCoordinator } from "./connection-state.js";
import { ConnectedHostAccess } from "./host-access.js";
import { ConnectedHostLock } from "./host-lock.js";
import { SessionActionsSheet } from "./interrupt-control.js";
import {
  ConnectedMissionControl,
  ResponsiveMissionNavigation
} from "./mission-control.js";
import { PairingStartupScreen } from "./pairing-screen.js";
import {
  type BrowserMissionNavigationContext,
  synchronizeResponsiveMissionContext
} from "./responsive-layout-state.js";
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
  readonly startup?: BrowserAppStartupController | undefined;
  readonly coordinator?: BrowserConnectionStateCoordinator | undefined;
  readonly createCoordinator?: BrowserConnectionCoordinatorFactory | undefined;
}

interface HostDeckRoutesProps {
  readonly outlets?: HostDeckRouteOutlets | undefined;
  readonly coordinator?: BrowserConnectionStateCoordinator | undefined;
  readonly runtimeFailed?: boolean | undefined;
  readonly focusMainOnMount?: boolean | undefined;
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
  startup,
  coordinator: injectedCoordinator,
  createCoordinator = createProductionBrowserConnectionCoordinator
}: HostDeckAppProps) {
  if (startup !== undefined) {
    return <StartedHostDeckBrowserApp outlets={outlets} startup={startup} />;
  }
  return (
    <OwnedHostDeckBrowserApp
      outlets={outlets}
      coordinator={injectedCoordinator}
      createCoordinator={createCoordinator}
    />
  );
}

function StartedHostDeckBrowserApp({
  outlets,
  startup
}: Readonly<{
  outlets: HostDeckRouteOutlets | undefined;
  startup: BrowserAppStartupController;
}>) {
  const snapshot = useSyncExternalStore(
    startup.subscribe,
    startup.snapshot,
    startup.snapshot
  );
  const enteredFromPairing = useRef(snapshot.phase !== "ready");
  if (snapshot.phase !== "ready") enteredFromPairing.current = true;
  if (snapshot.phase !== "ready") {
    return (
      <PairingStartupScreen
        snapshot={snapshot}
        onContinue={() => startup.continueToApp()}
        onReload={() => startup.reload()}
      />
    );
  }
  const coordinator = startup.coordinator();
  if (coordinator === null) {
    throw new TypeError("HostDeck ready startup is missing its browser coordinator.");
  }
  return (
    <BrowserRouter>
      <HostDeckRoutes
        outlets={outlets}
        coordinator={coordinator}
        focusMainOnMount={enteredFromPairing.current}
      />
    </BrowserRouter>
  );
}

function OwnedHostDeckBrowserApp({
  outlets,
  coordinator: injectedCoordinator,
  createCoordinator
}: Readonly<{
  outlets: HostDeckRouteOutlets | undefined;
  coordinator: BrowserConnectionStateCoordinator | undefined;
  createCoordinator: BrowserConnectionCoordinatorFactory;
}>) {
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
  runtimeFailed = false,
  focusMainOnMount = false
}: HostDeckRoutesProps) {
  if (coordinator !== undefined) {
    return (
      <ResponsiveMissionContextOwner coordinator={coordinator}>
        {(missionContext) => (
          <ConnectedHostLock coordinator={coordinator}>
            {(hostLock) =>
              outlets.hostAccess === undefined ? (
                <ConnectedHostAccess coordinator={coordinator} hostLock={hostLock}>
                  {(content) => (
                    <HostDeckRouteTable
                      outlets={Object.freeze({ ...outlets, hostAccess: content })}
                      coordinator={coordinator}
                      focusMainOnMount={focusMainOnMount}
                      missionContext={missionContext}
                      runtimeFailed={runtimeFailed}
                    />
                  )}
                </ConnectedHostAccess>
              ) : (
                <HostDeckRouteTable
                  outlets={outlets}
                  coordinator={coordinator}
                  focusMainOnMount={focusMainOnMount}
                  missionContext={missionContext}
                  runtimeFailed={runtimeFailed}
                />
              )
            }
          </ConnectedHostLock>
        )}
      </ResponsiveMissionContextOwner>
    );
  }
  return (
    <HostDeckRouteTable
      outlets={outlets}
      coordinator={coordinator}
      focusMainOnMount={focusMainOnMount}
      missionContext={null}
      runtimeFailed={runtimeFailed}
    />
  );
}

function ResponsiveMissionContextOwner({
  children,
  coordinator
}: Readonly<{
  children: (context: BrowserMissionNavigationContext | null) => ReactNode;
  coordinator: BrowserConnectionStateCoordinator;
}>) {
  const snapshot = useSyncExternalStore(
    coordinator.subscribe,
    coordinator.snapshot,
    coordinator.snapshot
  );
  const owner = useRef<{
    coordinator: BrowserConnectionStateCoordinator;
    context: BrowserMissionNavigationContext | null;
  }>({ coordinator, context: null });
  if (owner.current.coordinator !== coordinator) {
    owner.current = { coordinator, context: null };
  }
  owner.current.context = synchronizeResponsiveMissionContext(
    owner.current.context,
    snapshot
  );
  return children(owner.current.context);
}

function HostDeckRouteTable({
  outlets,
  coordinator,
  focusMainOnMount,
  missionContext,
  runtimeFailed
}: Readonly<{
  outlets: HostDeckRouteOutlets;
  coordinator: BrowserConnectionStateCoordinator | undefined;
  focusMainOnMount: boolean;
  missionContext: BrowserMissionNavigationContext | null;
  runtimeFailed: boolean;
}>) {
  return (
    <RouteAccessibilityOwner focusMainOnMount={focusMainOnMount}>
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
            missionContext={missionContext}
            runtimeFailed={runtimeFailed}
          />
        }
      />
        <Route
        path="*"
        element={
          <NotFoundRoute hostAccess={outlets.hostAccess} />
        }
      />
      </Routes>
    </RouteAccessibilityOwner>
  );
}

function RouteAccessibilityOwner({
  children,
  focusMainOnMount
}: Readonly<{ children: ReactNode; focusMainOnMount: boolean }>) {
  const location = useLocation();
  const navigationType = useNavigationType();
  const previous = useRef<HostDeckRouteFocusLocation | null>(null);

  useLayoutEffect(() => {
    const current = Object.freeze({
      pathname: location.pathname,
      missionSource: isMissionSource(location.state)
    });
    const request = resolveHostDeckRouteFocus(
      previous.current,
      current,
      navigationType,
      focusMainOnMount
    );
    previous.current = current;
    document.title = hostDeckDocumentTitle(current.pathname);
    if (request.kind === "none") return;
    const main = document.getElementById("hostdeck-main");
    if (request.kind === "main") {
      main?.focus({ preventScroll: true });
      return;
    }

    main?.focus({ preventScroll: true });
    let ownedTarget: HTMLElement | null = main;
    let timeoutId: number | null = null;
    const findTarget = () => {
      const candidates = [...document.querySelectorAll<HTMLElement>("[data-hostdeck-session-path]")]
        .filter((candidate) =>
          candidate.getAttribute("data-hostdeck-session-path") === request.sessionPath &&
          candidate.closest('[aria-hidden="true"], [hidden], [inert]') === null
        );
      return candidates.find((candidate) =>
        candidate.offsetParent !== null || candidate.getClientRects().length > 0
      ) ?? candidates[0] ?? null;
    };
    const observer = new MutationObserver(() => restoreOwnedFocus());
    const stop = () => {
      observer.disconnect();
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
    const restoreOwnedFocus = () => {
      const active = document.activeElement;
      if (
        active !== document.body &&
        active !== ownedTarget &&
        !(ownedTarget !== null && !ownedTarget.isConnected && active === null)
      ) {
        stop();
        return;
      }
      const target = findTarget();
      if (target === null || target === active) return;
      target.focus({ preventScroll: true });
      ownedTarget = target;
    };
    if (main !== null) {
      observer.observe(main, { childList: true, subtree: true });
    }
    restoreOwnedFocus();
    timeoutId = window.setTimeout(stop, 2_000);
    return stop;
  }, [focusMainOnMount, location.pathname, location.state, navigationType]);

  return children;
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
  missionContext,
  runtimeFailed
}: Readonly<{
  outlets: HostDeckRouteOutlets;
  coordinator: BrowserConnectionStateCoordinator | undefined;
  missionContext: BrowserMissionNavigationContext | null;
  runtimeFailed: boolean;
}>) {
  const rawSessionId = useParams<"session_id">().session_id;
  const parsed = sessionIdSchema.safeParse(rawSessionId);

  if (!parsed.success) {
    return (
      <NotFoundRoute hostAccess={outlets.hostAccess} />
    );
  }

  const sessionId = parsed.data;
  const injectedContent = outlets.sessionDetail?.(sessionId);
  if (injectedContent === undefined && coordinator !== undefined) {
    return (
      <ConnectedSessionDetailRoute
        coordinator={coordinator}
        hostAccess={outlets.hostAccess}
        missionContext={missionContext}
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
      <ResponsiveSessionLayout
        missionContext={missionContext}
        nowMs={Date.now()}
        sessionId={sessionId}
      >
        {injectedContent ??
          (runtimeFailed ? (
            <SessionDetailRuntimeFailure />
          ) : (
            <SessionDetailLoading sessionId={sessionId} />
          ))}
      </ResponsiveSessionLayout>
    </HostDeckFrame>
  );
}

function ConnectedSessionDetailRoute({
  coordinator,
  hostAccess,
  missionContext,
  sessionId
}: Readonly<{
  coordinator: BrowserConnectionStateCoordinator;
  hostAccess: ReactNode | undefined;
  missionContext: BrowserMissionNavigationContext | null;
  sessionId: SessionId;
}>) {
  const navigate = useNavigate();
  const controller = useSessionDetailController(coordinator, sessionId);
  const projection = projectSessionDetail(
    controller.snapshot,
    sessionId,
    controller.feed,
    controller.nowMs
  );
  return (
    <HostDeckFrame
      action={
        <SessionActionsSheet
          archive={controller.archive}
          controller={controller.interrupt}
          hostAccess={hostAccess ?? <HostAccessLoading />}
          laptopResume={controller.laptopResume}
          onArchiveSucceeded={() => navigate(missionControlPath, { replace: true })}
        />
      }
      back={<SessionBackButton />}
      subtitle={projection.headerSubtitle}
      title={projection.headerTitle}
    >
      <ResponsiveSessionLayout
        missionContext={missionContext}
        nowMs={controller.nowMs}
        sessionId={sessionId}
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
          goal={controller.goal}
          model={controller.model}
          plan={controller.plan}
          prompt={controller.prompt}
          usage={controller.usage}
          compact={controller.compact}
          skills={controller.skills}
          approvals={controller.approvals}
          eventDiagnostics={controller.eventDiagnostics}
          projection={projection}
        />
      </ResponsiveSessionLayout>
    </HostDeckFrame>
  );
}

function ResponsiveSessionLayout({
  children,
  missionContext,
  nowMs,
  sessionId
}: Readonly<{
  children: ReactNode;
  missionContext: BrowserMissionNavigationContext | null;
  nowMs: number;
  sessionId: SessionId;
}>) {
  return (
    <div className="hostdeck-responsive-detail-layout">
      <aside className="hostdeck-responsive-detail-layout__mission">
        <ResponsiveMissionNavigation
          context={missionContext}
          nowMs={nowMs}
          selectedSessionId={sessionId}
        />
      </aside>
      <div className="hostdeck-responsive-detail-layout__detail">{children}</div>
    </div>
  );
}

function HostDeckFrame({
  action,
  back,
  children,
  hostAccess,
  subtitle,
  title = "HostDeck"
}: Readonly<{
  action?: ReactNode;
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
        {action !== undefined ? action : hostAccess !== undefined ? (
          <HostAccessSheet>{hostAccess}</HostAccessSheet>
        ) : (
          <HostAccessSheet>
            <HostAccessLoading />
          </HostAccessSheet>
        )}
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
        <Dialog.Content className="hostdeck-sheet hostdeck-host-access-sheet">
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
          <section
            className="hostdeck-sheet__body"
            aria-label="Host and access content"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: The sheet's overflow owner must remain keyboard-scrollable even when its current state has no controls.
            tabIndex={0}
          >
            {children}
          </section>
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

function NotFoundRoute({
  hostAccess
}: Readonly<{
  hostAccess?: ReactNode;
}>) {
  return (
    <HostDeckFrame hostAccess={hostAccess}>
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
