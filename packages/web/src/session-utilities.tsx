import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowLeft,
  ChevronRight,
  Ellipsis,
  Gauge,
  Minimize2,
  Sparkles,
  X
} from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import { CompactSheetBody } from "./compact-control.js";
import type { CompactControlController } from "./compact-control-state.js";
import { SkillsSheetBody } from "./skills-control.js";
import type { SkillsControlController } from "./skills-control-state.js";
import { UsageSheetBody } from "./usage-control.js";
import type { UsageControlController } from "./usage-control-state.js";

export interface SessionUtilitiesProps {
  readonly compact: CompactControlController;
  readonly skills: SkillsControlController;
  readonly usage: UsageControlController;
}

type UtilityPage = "menu" | "usage" | "compact" | "skills";

export function SessionUtilities({ compact, skills, usage }: SessionUtilitiesProps) {
  const compactView = useSyncExternalStore(
    compact.subscribe,
    compact.snapshot,
    compact.snapshot
  );
  const usageView = useSyncExternalStore(
    usage.subscribe,
    usage.snapshot,
    usage.snapshot
  );
  const skillsView = useSyncExternalStore(
    skills.subscribe,
    skills.snapshot,
    skills.snapshot
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const [page, setPage] = useState<UtilityPage>("menu");
  const usageItemRef = useRef<HTMLButtonElement>(null);
  const compactItemRef = useRef<HTMLButtonElement>(null);
  const skillsItemRef = useRef<HTMLButtonElement>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const targetId = `${id}-target`;
  const usageStatusId = `${id}-usage-status`;
  const compactStatusId = `${id}-compact-status`;
  const skillsStatusId = `${id}-skills-status`;
  const sameTarget =
    usageView.sessionId === compactView.sessionId &&
    usageView.sessionId === skillsView.sessionId &&
    usageView.targetLabel !== null &&
    usageView.targetLabel === compactView.targetLabel &&
    usageView.targetLabel === skillsView.targetLabel;
  const visible =
    usageView.visible && compactView.visible && skillsView.visible && sameTarget;
  const compactSubmissionActive =
    page === "compact" && compactView.closeDisabled;

  useEffect(() => {
    if (!dialogOpen) return;
    const activeSheetOpen =
      page === "menu" ||
      (page === "usage" && usageView.sheetOpen) ||
      (page === "compact" && compactView.sheetOpen) ||
      (page === "skills" && skillsView.sheetOpen);
    if (!visible || !activeSheetOpen) {
      setDialogOpen(false);
      setPage("menu");
    }
  }, [
    compactView.sheetOpen,
    dialogOpen,
    page,
    skillsView.sheetOpen,
    usageView.sheetOpen,
    visible
  ]);

  useLayoutEffect(() => {
    if (!dialogOpen || page === "menu") return;
    backButtonRef.current?.focus();
  }, [dialogOpen, page]);

  if (!visible) return null;

  const targetLabel = usageView.targetLabel;
  const activeTone = page === "usage"
    ? usageView.tone
    : page === "compact"
      ? compactView.tone
      : page === "skills"
        ? skillsView.tone
        : "focus";
  const title = page === "menu"
    ? "Session utilities"
    : page === "usage"
      ? "/usage"
      : page === "compact"
        ? "/compact"
        : "/skills";
  const statusId = page === "usage"
    ? usageStatusId
    : page === "compact"
      ? compactStatusId
      : page === "skills"
        ? skillsStatusId
        : null;
  const closeLabel = page === "menu"
    ? "Close session utilities"
    : page === "usage"
      ? "Close Usage utility"
      : page === "compact"
        ? "Close Compact utility"
        : "Close Skills utility";

  const setOpen = (open: boolean) => {
    if (open) {
      usage.dismiss();
      compact.dismiss();
      skills.dismiss();
      setPage("menu");
      setDialogOpen(true);
      return;
    }
    if (compactSubmissionActive) return;
    usage.dismiss();
    compact.dismiss();
    skills.dismiss();
    setDialogOpen(false);
    setPage("menu");
  };

  const openUsage = () => {
    if (!usageView.actionEnabled) return;
    compact.dismiss();
    skills.dismiss();
    setPage("usage");
    void usage.open();
  };

  const openCompact = () => {
    if (!compactView.actionEnabled) return;
    usage.dismiss();
    skills.dismiss();
    setPage("compact");
    void compact.open();
  };

  const openSkills = () => {
    if (!skillsView.actionEnabled) return;
    usage.dismiss();
    compact.dismiss();
    setPage("skills");
    void skills.open();
  };

  const returnToMenu = () => {
    if (compactSubmissionActive) return;
    const item = page === "usage"
      ? usageItemRef
      : page === "compact"
        ? compactItemRef
        : skillsItemRef;
    usage.dismiss();
    compact.dismiss();
    skills.dismiss();
    setPage("menu");
    queueMicrotask(() => item.current?.focus());
  };

  return (
    <Dialog.Root open={dialogOpen} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="hostdeck-primary-action-dock__command hostdeck-primary-action-dock__command--icon"
          aria-label={`More session utilities for ${targetLabel}`}
          title="More session utilities"
        >
          <Ellipsis size={22} strokeWidth={2} aria-hidden="true" />
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="hostdeck-sheet-overlay" />
        <Dialog.Content
          className={`hostdeck-sheet hostdeck-usage-sheet hostdeck-usage-sheet--${activeTone}`}
          aria-describedby={statusId === null ? targetId : `${targetId} ${statusId}`}
          onEscapeKeyDown={(event) => {
            if (compactSubmissionActive) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (compactSubmissionActive) event.preventDefault();
          }}
        >
          <span className="hostdeck-sheet__handle" aria-hidden="true" />
          <div className="hostdeck-sheet__header hostdeck-usage-sheet__header">
            <span className="hostdeck-usage-sheet__heading">
              {page === "menu" ? null : (
                <button
                  ref={backButtonRef}
                  type="button"
                  className="hostdeck-icon-button"
                  aria-label="Back to session utilities"
                  title="Back to session utilities"
                  disabled={compactSubmissionActive}
                  onClick={returnToMenu}
                >
                  <ArrowLeft size={22} strokeWidth={2} aria-hidden="true" />
                </button>
              )}
              <span>
                <Dialog.Title className="hostdeck-sheet__title">{title}</Dialog.Title>
                <Dialog.Description className="hostdeck-usage-sheet__target" id={targetId}>
                  Target: <strong>{targetLabel}</strong>
                </Dialog.Description>
              </span>
            </span>
            <button
              type="button"
              className="hostdeck-icon-button"
              aria-label={closeLabel}
              title={closeLabel}
              disabled={compactSubmissionActive}
              onClick={() => setOpen(false)}
            >
              <X size={22} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>

          {page === "menu" ? (
            <UtilityMenu
              compactActionDisabledReason={compactView.actionDisabledReason}
              compactActionEnabled={compactView.actionEnabled}
              compactItemRef={compactItemRef}
              onCompact={openCompact}
              onSkills={openSkills}
              onUsage={openUsage}
              skillsActionDisabledReason={skillsView.actionDisabledReason}
              skillsActionEnabled={skillsView.actionEnabled}
              skillsItemRef={skillsItemRef}
              usageActionDisabledReason={usageView.actionDisabledReason}
              usageActionEnabled={usageView.actionEnabled}
              usageItemRef={usageItemRef}
            />
          ) : page === "usage" ? (
            <UsageSheetBody
              controller={usage}
              statusId={usageStatusId}
              view={usageView}
            />
          ) : page === "compact" ? (
            <CompactSheetBody
              controller={compact}
              statusId={compactStatusId}
              view={compactView}
            />
          ) : (
            <SkillsSheetBody
              controller={skills}
              statusId={skillsStatusId}
              view={skillsView}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function UtilityMenu({
  compactActionDisabledReason,
  compactActionEnabled,
  compactItemRef,
  onCompact,
  onSkills,
  onUsage,
  skillsActionDisabledReason,
  skillsActionEnabled,
  skillsItemRef,
  usageActionDisabledReason,
  usageActionEnabled,
  usageItemRef
}: Readonly<{
  compactActionDisabledReason: string | null;
  compactActionEnabled: boolean;
  compactItemRef: React.RefObject<HTMLButtonElement | null>;
  onCompact: () => void;
  onSkills: () => void;
  onUsage: () => void;
  skillsActionDisabledReason: string | null;
  skillsActionEnabled: boolean;
  skillsItemRef: React.RefObject<HTMLButtonElement | null>;
  usageActionDisabledReason: string | null;
  usageActionEnabled: boolean;
  usageItemRef: React.RefObject<HTMLButtonElement | null>;
}>) {
  return (
    <div className="hostdeck-utility-menu">
      <p className="hostdeck-utility-menu__intro">
        Structured reads and actions for this session.
      </p>
      <ul className="hostdeck-utility-menu__list">
        <UtilityMenuItem
          actionDisabledReason={usageActionDisabledReason}
          actionEnabled={usageActionEnabled}
          description="Account, thread, context, and rate-limit observations"
          icon={Gauge}
          itemRef={usageItemRef}
          label="/usage"
          onClick={onUsage}
        />
        <UtilityMenuItem
          actionDisabledReason={compactActionDisabledReason}
          actionEnabled={compactActionEnabled}
          description="Inspect progress and confirm context compaction"
          icon={Minimize2}
          itemRef={compactItemRef}
          label="/compact"
          onClick={onCompact}
        />
        <UtilityMenuItem
          actionDisabledReason={skillsActionDisabledReason}
          actionEnabled={skillsActionEnabled}
          description="Inspect bounded runtime skill metadata"
          icon={Sparkles}
          itemRef={skillsItemRef}
          label="/skills"
          onClick={onSkills}
        />
      </ul>
    </div>
  );
}

function UtilityMenuItem({
  actionDisabledReason,
  actionEnabled,
  description,
  icon: Icon,
  itemRef,
  label,
  onClick
}: Readonly<{
  actionDisabledReason: string | null;
  actionEnabled: boolean;
  description: string;
  icon: typeof Gauge;
  itemRef: React.RefObject<HTMLButtonElement | null>;
  label: "/usage" | "/compact" | "/skills";
  onClick: () => void;
}>) {
  const descriptionId = useId();
  const reasonId = useId();
  return (
    <li>
      <button
        ref={itemRef}
        type="button"
        className="hostdeck-utility-menu__item"
        aria-describedby={
          actionDisabledReason === null
            ? descriptionId
            : `${descriptionId} ${reasonId}`
        }
        aria-label={`Open ${label}`}
        disabled={!actionEnabled}
        title={actionDisabledReason ?? `Open structured ${label.slice(1)}`}
        onClick={onClick}
      >
        <Icon size={22} strokeWidth={2} aria-hidden="true" />
        <span>
          <strong>{label}</strong>
          <small id={descriptionId}>{description}</small>
          {actionDisabledReason === null ? null : (
            <small id={reasonId} className="hostdeck-utility-menu__reason">
              {actionDisabledReason}
            </small>
          )}
        </span>
        <ChevronRight size={18} strokeWidth={2} aria-hidden="true" />
      </button>
    </li>
  );
}
