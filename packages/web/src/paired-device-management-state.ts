import {
  clientOperationIdSchema,
  decodeSelectedDeviceListCursor,
  type SelectedDeviceListResponseItem,
  type SelectedDeviceRevokeResponse,
  selectedDeviceListResponseSchema,
  selectedDeviceRevokeResponseSchema
} from "@hostdeck/contracts";
import type {
  BrowserConnectionSnapshot,
  BrowserConnectionStateCoordinator
} from "./connection-state.js";
import { HostDeckBrowserCsrfError } from "./csrf-client.js";
import type { BrowserHttpRouteResponse } from "./http-client.js";
import type { BrowserHttpRouteRequest } from "./http-route-contracts.js";

export const pairedDeviceManagementPageSize = 20;

export const pairedDeviceManagementPhases = Object.freeze([
  "unavailable",
  "loading",
  "ready",
  "stale",
  "failed",
  "closed"
] as const);

export type PairedDeviceManagementPhase =
  (typeof pairedDeviceManagementPhases)[number];
export type PairedDeviceManagementTone =
  | "connected"
  | "attention"
  | "danger"
  | "muted";
export type PairedDeviceStatus = "active" | "expired" | "revoked";
export type PairedDeviceManagementResultKind =
  | "success"
  | "self_revoked"
  | "conflict"
  | "uncertain"
  | "failure";

export interface PairedDeviceManagementRowView {
  readonly key: string;
  readonly label: string;
  readonly cue: string;
  readonly permission: "read" | "write";
  readonly permissionLabel: string;
  readonly status: PairedDeviceStatus;
  readonly statusLabel: string;
  readonly lastUsedLabel: string;
  readonly expiresLabel: string;
  readonly current: boolean;
  readonly revokeVisible: boolean;
  readonly revokeEnabled: boolean;
  readonly revokeDisabledReason: string | null;
}

export interface PairedDeviceManagementResultView {
  readonly kind: PairedDeviceManagementResultKind;
  readonly tone: PairedDeviceManagementTone;
  readonly title: string;
  readonly detail: string;
  readonly urgent: boolean;
}

export interface PairedDeviceRevokeConfirmationView {
  readonly rowKey: string;
  readonly title: string;
  readonly targetLabel: string;
  readonly detail: string;
  readonly warning: string | null;
  readonly confirmLabel: string;
  readonly busy: boolean;
  readonly confirmEnabled: boolean;
}

export interface PairedDeviceManagementView {
  readonly phase: PairedDeviceManagementPhase;
  readonly tone: PairedDeviceManagementTone;
  readonly title: "Paired devices";
  readonly detail: string;
  readonly rows: readonly PairedDeviceManagementRowView[];
  readonly pageOrdinal: number;
  readonly hasNextPage: boolean;
  readonly readOnly: boolean;
  readonly busy: boolean;
  readonly refreshVisible: boolean;
  readonly refreshEnabled: boolean;
  readonly refreshLabel: string;
  readonly nextEnabled: boolean;
  readonly startOverVisible: boolean;
  readonly startOverEnabled: boolean;
  readonly result: PairedDeviceManagementResultView | null;
  readonly confirmation: PairedDeviceRevokeConfirmationView | null;
}

export interface PairedDeviceManagementPort {
  readonly snapshot: () => BrowserConnectionSnapshot;
  readonly list: (
    input: BrowserHttpRouteRequest<"device_list">,
    options?: Readonly<{ readonly signal?: AbortSignal }>
  ) => Promise<BrowserHttpRouteResponse<"device_list">>;
  readonly revoke: (
    input: BrowserHttpRouteRequest<"device_revoke">,
    options?: Readonly<{ readonly signal?: AbortSignal }>
  ) => Promise<BrowserHttpRouteResponse<"device_revoke">>;
}

export interface CreatePairedDeviceManagementControllerOptions {
  readonly port: PairedDeviceManagementPort;
  readonly createOperationId: () => string;
  readonly clock?: Readonly<{ readonly now: () => number }>;
}

export interface PairedDeviceManagementController {
  readonly snapshot: () => PairedDeviceManagementView;
  readonly subscribe: (listener: () => void) => () => void;
  readonly synchronize: () => PairedDeviceManagementView;
  readonly ensureLoaded: () => Promise<PairedDeviceManagementView>;
  readonly refresh: () => Promise<PairedDeviceManagementView>;
  readonly nextPage: () => Promise<PairedDeviceManagementView>;
  readonly startOver: () => Promise<PairedDeviceManagementView>;
  readonly beginRevoke: (rowKey: string) => PairedDeviceManagementView;
  readonly cancelRevoke: () => PairedDeviceManagementView;
  readonly confirmRevoke: () => Promise<PairedDeviceManagementView>;
  readonly close: () => PairedDeviceManagementView;
}

export type PairedDeviceManagementErrorReason =
  | "client_contract"
  | "not_ready"
  | "closed";

export class HostDeckPairedDeviceManagementError extends Error {
  readonly reason: PairedDeviceManagementErrorReason;

  constructor(reason: PairedDeviceManagementErrorReason) {
    super(`HostDeck paired-device management is ${reason.replaceAll("_", " ")}.`);
    this.name = "HostDeckPairedDeviceManagementError";
    this.reason = reason;
    this.stack = `${this.name}: ${this.message}`;
    Object.freeze(this);
  }
}

interface PairedAuthority {
  readonly key: string;
  readonly deviceId: string;
  readonly permission: "read" | "write";
  readonly csrfReady: boolean;
}

interface DevicePage {
  readonly devices: readonly SelectedDeviceListResponseItem[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

interface RevokeSelection {
  readonly rowKey: string;
  readonly deviceId: string;
  readonly label: string;
  readonly cue: string;
  readonly self: boolean;
  readonly expired: boolean;
  readonly finalActive: boolean;
  readonly pageOrdinal: number;
  readonly authorityKey: string;
}

interface PendingList {
  active: boolean;
  settled: boolean;
  readonly authorityKey: string;
  readonly cursor: string | null;
  readonly pageOrdinal: number;
  readonly controller: AbortController;
  readonly promise: Promise<PairedDeviceManagementView>;
  readonly settle: (view: PairedDeviceManagementView) => void;
}

interface PendingRevoke {
  active: boolean;
  settled: boolean;
  readonly authorityKey: string;
  readonly selection: RevokeSelection;
  readonly operationId: string;
  readonly controller: AbortController;
  readonly promise: Promise<PairedDeviceManagementView>;
  readonly settle: (view: PairedDeviceManagementView) => void;
}

const createOptionKeys = ["port", "createOperationId", "clock"] as const;
const requiredCreateOptionKeys = ["port", "createOperationId"] as const;
const portKeys = ["snapshot", "list", "revoke"] as const;
const clockKeys = ["now"] as const;
const maximumSubscribers = 32;
const defaultClock = Object.freeze({ now: () => Date.now() });

export function createPairedDeviceManagementController(
  input: CreatePairedDeviceManagementControllerOptions
): PairedDeviceManagementController {
  const options = readOptions(input);
  const subscribers = new Set<() => void>();

  let closed = false;
  let authority: PairedAuthority | null = null;
  let autoAttemptedAuthority: string | null = null;
  let phase: PairedDeviceManagementPhase = "unavailable";
  let page: DevicePage | null = null;
  let pageCursor: string | null = null;
  let pageOrdinal = 1;
  let selection: RevokeSelection | null = null;
  let result: PairedDeviceManagementResultView | null = null;
  let pendingList: PendingList | null = null;
  let pendingRevoke: PendingRevoke | null = null;
  let lastNowMs: number | null = null;
  let currentView = unavailableView(null);

  const notify = (): void => {
    for (const listener of [...subscribers]) {
      try {
        listener();
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  };

  const publish = (): PairedDeviceManagementView => {
    currentView = buildView({
      authority,
      closed,
      phase,
      page,
      pageOrdinal,
      pageCursor,
      pendingList: pendingList !== null,
      pendingRevoke: pendingRevoke !== null,
      result,
      selection,
      nowMs: lastNowMs ?? 0
    });
    notify();
    return currentView;
  };

  const readSnapshot = (): BrowserConnectionSnapshot => {
    let candidate: unknown;
    try {
      candidate = Reflect.apply(options.port.snapshot, undefined, []);
    } catch {
      throw managementError("client_contract");
    }
    try {
      if (!isConnectionSnapshot(candidate)) throw managementError("client_contract");
    } catch (error) {
      if (error instanceof HostDeckPairedDeviceManagementError) throw error;
      throw managementError("client_contract");
    }
    return candidate;
  };

  const readNow = (): number => {
    let candidate: unknown;
    try {
      candidate = Reflect.apply(options.clock.now, undefined, []);
    } catch {
      throw managementError("client_contract");
    }
    if (
      typeof candidate !== "number" ||
      !Number.isSafeInteger(candidate) ||
      candidate < 0 ||
      (lastNowMs !== null && candidate < lastNowMs)
    ) {
      throw managementError("client_contract");
    }
    lastNowMs = candidate;
    return candidate;
  };

  const settleList = (owner: PendingList): void => {
    if (owner.settled) return;
    owner.settled = true;
    owner.settle(currentView);
  };

  const settleRevoke = (owner: PendingRevoke): void => {
    if (owner.settled) return;
    owner.settled = true;
    owner.settle(currentView);
  };

  const suppressList = (): void => {
    const owner = pendingList;
    pendingList = null;
    if (owner === null) return;
    owner.active = false;
    safeAbort(owner.controller);
    queueMicrotask(() => settleList(owner));
  };

  const suppressRevoke = (): void => {
    const owner = pendingRevoke;
    pendingRevoke = null;
    if (owner === null) return;
    owner.active = false;
    safeAbort(owner.controller);
    queueMicrotask(() => settleRevoke(owner));
  };

  const purgePage = (): void => {
    page = null;
    pageCursor = null;
    pageOrdinal = 1;
    selection = null;
  };

  const synchronize = (): PairedDeviceManagementView => {
    if (closed) return currentView;
    const snapshot = readSnapshot();
    let nextAuthority: PairedAuthority | null;
    try {
      nextAuthority = authorityFromSnapshot(snapshot);
    } catch {
      throw managementError("client_contract");
    }
    if (nextAuthority?.key === authority?.key) {
      authority = nextAuthority;
      return publish();
    }

    const ownSelfRevokeTransition =
      pendingRevoke?.selection.self === true &&
      nextAuthority === null &&
      authority?.key === pendingRevoke.authorityKey;
    suppressList();
    if (!ownSelfRevokeTransition) suppressRevoke();
    purgePage();
    authority = nextAuthority;
    autoAttemptedAuthority = null;
    phase = nextAuthority === null ? "unavailable" : "loading";
    if (!ownSelfRevokeTransition) result = null;
    return publish();
  };

  const executeList = async (owner: PendingList): Promise<void> => {
    try {
      if (
        closed ||
        !owner.active ||
        pendingList !== owner ||
        authority?.key !== owner.authorityKey
      ) {
        return;
      }
      const input: BrowserHttpRouteRequest<"device_list"> = Object.freeze({
        query: Object.freeze({
          limit: String(pairedDeviceManagementPageSize),
          ...(owner.cursor === null ? {} : { cursor: owner.cursor })
        })
      });
      const candidate = Reflect.apply(options.port.list, undefined, [
        input,
        Object.freeze({ signal: owner.controller.signal })
      ]) as Promise<BrowserHttpRouteResponse<"device_list">>;
      const response = await Promise.resolve(candidate);
      if (
        closed ||
        !owner.active ||
        pendingList !== owner ||
        authority?.key !== owner.authorityKey
      ) {
        return;
      }
      const nextPage = parseDevicePage(response, owner.cursor);
      if (nextPage === null) throw managementError("client_contract");
      page = nextPage;
      pageCursor = owner.cursor;
      pageOrdinal = owner.pageOrdinal;
      phase = "ready";
      selection = null;
      result = null;
      readNow();
    } catch {
      if (
        !closed &&
        owner.active &&
        pendingList === owner &&
        authority?.key === owner.authorityKey
      ) {
        phase = page === null ? "failed" : "stale";
        selection = null;
      }
    } finally {
      if (pendingList === owner) pendingList = null;
      if (!closed && owner.active) publish();
      settleList(owner);
    }
  };

  const beginList = (
    cursor: string | null,
    nextPageOrdinal: number
  ): Promise<PairedDeviceManagementView> => {
    if (closed) return Promise.reject(managementError("closed"));
    if (pendingList !== null) return pendingList.promise;
    if (pendingRevoke !== null || authority === null) {
      return Promise.reject(managementError("not_ready"));
    }
    if (!Number.isSafeInteger(nextPageOrdinal) || nextPageOrdinal < 1) {
      return Promise.reject(managementError("client_contract"));
    }
    const deferred = createDeferredView();
    const owner: PendingList = {
      active: true,
      settled: false,
      authorityKey: authority.key,
      cursor,
      pageOrdinal: nextPageOrdinal,
      controller: new AbortController(),
      promise: deferred.promise,
      settle: deferred.resolve
    };
    pendingList = owner;
    phase = "loading";
    selection = null;
    publish();
    void executeList(owner);
    return owner.promise;
  };

  const executeRevoke = async (owner: PendingRevoke): Promise<void> => {
    try {
      if (
        closed ||
        !owner.active ||
        pendingRevoke !== owner ||
        authority?.key !== owner.authorityKey
      ) {
        return;
      }
      const input: BrowserHttpRouteRequest<"device_revoke"> = Object.freeze({
        params: Object.freeze({ device_id: owner.selection.deviceId }),
        body: Object.freeze({ operation_id: owner.operationId, confirmed: true as const })
      });
      const candidate = Reflect.apply(options.port.revoke, undefined, [
        input,
        Object.freeze({ signal: owner.controller.signal })
      ]) as Promise<BrowserHttpRouteResponse<"device_revoke">>;
      const response = await Promise.resolve(candidate);
      if (closed || !owner.active || pendingRevoke !== owner) return;
      const parsed = selectedDeviceRevokeResponseSchema.safeParse(response.data);
      if (
        response.status !== 200 ||
        !parsed.success ||
        !revokeResponseMatches(parsed.data, owner)
      ) {
        throw managementError("client_contract");
      }

      if (owner.selection.self) {
        const snapshot = readSnapshot();
        if (
          snapshot.access.state !== "current" ||
          snapshot.access.data?.authentication_state !== "revoked_device" ||
          snapshot.host.data !== null ||
          snapshot.targetState.data !== null ||
          snapshot.csrf.invalidationReason !== "device_revoked"
        ) {
          throw managementError("client_contract");
        }
        suppressList();
        purgePage();
        authority = null;
        autoAttemptedAuthority = null;
        phase = "unavailable";
        result = resultView(
          "self_revoked",
          "This phone was revoked",
          "Create a new pairing link on the laptop before using HostDeck here again."
        );
      } else {
        if (authority?.key !== owner.authorityKey || page === null) {
          throw managementError("not_ready");
        }
        const patched = patchRevokedDevice(page, parsed.data);
        if (patched === null) throw managementError("client_contract");
        page = patched;
        phase = "ready";
        result = resultView(
          "success",
          "Device revoked",
          `${owner.selection.label} (${owner.selection.cue}) no longer has HostDeck access.`
        );
      }
      selection = null;
    } catch (error) {
      if (!closed && owner.active && pendingRevoke === owner) {
        selection = null;
        if (owner.selection.self) {
          suppressList();
          purgePage();
          try {
            authority = authorityFromSnapshot(readSnapshot());
          } catch {
            authority = null;
          }
          phase = authority === null ? "unavailable" : "stale";
          result = resultView(
            "uncertain",
            "Revocation outcome is unconfirmed",
            "This phone's access is blocked until HostDeck checks current pairing state."
          );
        } else {
          phase = page === null ? "failed" : "stale";
          result = isConflictFailure(error)
            ? resultView(
                "conflict",
                "Device changed before revocation",
                "Reload this device page to see its current state."
              )
            : resultView(
                "uncertain",
                "Revocation outcome is unconfirmed",
                "Reload this device page before attempting another revocation."
              );
        }
      }
    } finally {
      if (pendingRevoke === owner) pendingRevoke = null;
      if (!closed && owner.active) publish();
      settleRevoke(owner);
    }
  };

  const controller: PairedDeviceManagementController = Object.freeze({
    snapshot: () => currentView,
    subscribe(listener: () => void): () => void {
      if (closed) throw managementError("closed");
      if (
        typeof listener !== "function" ||
        subscribers.has(listener) ||
        subscribers.size >= maximumSubscribers
      ) {
        throw managementError("client_contract");
      }
      subscribers.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscribers.delete(listener);
      };
    },
    synchronize,
    ensureLoaded(): Promise<PairedDeviceManagementView> {
      if (closed) return Promise.reject(managementError("closed"));
      synchronize();
      if (authority === null) return Promise.resolve(currentView);
      if (pendingList !== null) return pendingList.promise;
      if (page !== null || autoAttemptedAuthority === authority.key) {
        return Promise.resolve(currentView);
      }
      autoAttemptedAuthority = authority.key;
      return beginList(null, 1);
    },
    refresh(): Promise<PairedDeviceManagementView> {
      if (closed) return Promise.reject(managementError("closed"));
      synchronize();
      if (authority === null) return Promise.reject(managementError("not_ready"));
      return beginList(pageCursor, pageOrdinal);
    },
    nextPage(): Promise<PairedDeviceManagementView> {
      if (closed) return Promise.reject(managementError("closed"));
      synchronize();
      if (pendingList !== null) return pendingList.promise;
      if (
        authority === null ||
        phase !== "ready" ||
        page === null ||
        !page.hasMore ||
        page.nextCursor === null
      ) {
        return Promise.reject(managementError("not_ready"));
      }
      return beginList(page.nextCursor, pageOrdinal + 1);
    },
    startOver(): Promise<PairedDeviceManagementView> {
      if (closed) return Promise.reject(managementError("closed"));
      synchronize();
      if (pendingList !== null) return pendingList.promise;
      if (authority === null || pageOrdinal === 1) {
        return Promise.reject(managementError("not_ready"));
      }
      return beginList(null, 1);
    },
    beginRevoke(rowKey: string): PairedDeviceManagementView {
      if (closed) throw managementError("closed");
      synchronize();
      if (
        typeof rowKey !== "string" ||
        authority?.permission !== "write" ||
        !authority.csrfReady ||
        phase !== "ready" ||
        page === null ||
        pendingList !== null ||
        pendingRevoke !== null
      ) {
        throw managementError("not_ready");
      }
      const row = findRow(page, pageOrdinal, rowKey);
      if (row === null || row.device.revoked_at !== null) {
        throw managementError("not_ready");
      }
      const nowMs = readNow();
      selection = Object.freeze({
        rowKey,
        deviceId: row.device.device_id,
        label: visibleDeviceLabel(row.device.client_label),
        cue: row.cue,
        self: row.device.device_id === authority.deviceId,
        expired: isExpired(row.device, nowMs),
        finalActive: isProvenFinalActive(page, pageCursor, row.device.device_id, nowMs),
        pageOrdinal,
        authorityKey: authority.key
      });
      result = null;
      return publish();
    },
    cancelRevoke(): PairedDeviceManagementView {
      if (closed) throw managementError("closed");
      if (pendingRevoke !== null) throw managementError("not_ready");
      selection = null;
      return publish();
    },
    confirmRevoke(): Promise<PairedDeviceManagementView> {
      if (closed) return Promise.reject(managementError("closed"));
      if (pendingRevoke !== null) return pendingRevoke.promise;
      synchronize();
      if (
        selection === null ||
        authority?.key !== selection.authorityKey ||
        authority.permission !== "write" ||
        !authority.csrfReady ||
        page === null ||
        phase !== "ready" ||
        selection.pageOrdinal !== pageOrdinal
      ) {
        return Promise.reject(managementError("not_ready"));
      }
      let operationId: string;
      try {
        operationId = clientOperationIdSchema.parse(
          Reflect.apply(options.createOperationId, undefined, [])
        );
      } catch {
        selection = null;
        result = resultView(
          "failure",
          "Revocation could not start",
          "HostDeck could not prepare a secure operation. No request was sent."
        );
        publish();
        return Promise.resolve(currentView);
      }
      const deferred = createDeferredView();
      const owner: PendingRevoke = {
        active: true,
        settled: false,
        authorityKey: authority.key,
        selection,
        operationId,
        controller: new AbortController(),
        promise: deferred.promise,
        settle: deferred.resolve
      };
      pendingRevoke = owner;
      publish();
      void executeRevoke(owner);
      return owner.promise;
    },
    close(): PairedDeviceManagementView {
      if (closed) return currentView;
      closed = true;
      suppressList();
      suppressRevoke();
      authority = null;
      autoAttemptedAuthority = null;
      purgePage();
      phase = "closed";
      result = null;
      currentView = buildView({
        authority,
        closed,
        phase,
        page,
        pageOrdinal,
        pageCursor,
        pendingList: false,
        pendingRevoke: false,
        result,
        selection,
        nowMs: lastNowMs ?? 0
      });
      notify();
      subscribers.clear();
      return currentView;
    }
  });

  synchronize();
  return controller;
}

interface BuildViewInput {
  readonly authority: PairedAuthority | null;
  readonly closed: boolean;
  readonly phase: PairedDeviceManagementPhase;
  readonly page: DevicePage | null;
  readonly pageOrdinal: number;
  readonly pageCursor: string | null;
  readonly pendingList: boolean;
  readonly pendingRevoke: boolean;
  readonly result: PairedDeviceManagementResultView | null;
  readonly selection: RevokeSelection | null;
  readonly nowMs: number;
}

function buildView(input: BuildViewInput): PairedDeviceManagementView {
  const busy = input.pendingList || input.pendingRevoke;
  const rows = input.page === null
    ? Object.freeze([])
    : Object.freeze(
        input.page.devices.map((device, index) =>
          rowView(device, index, input, busy)
        )
      );
  const copy = phaseCopy(input);
  const refreshVisible =
    !input.closed &&
    input.authority !== null &&
    (input.page !== null || input.phase === "failed");
  return Object.freeze({
    phase: input.phase,
    tone: copy.tone,
    title: "Paired devices",
    detail: copy.detail,
    rows,
    pageOrdinal: input.pageOrdinal,
    hasNextPage: input.page?.hasMore ?? false,
    readOnly: input.authority?.permission === "read",
    busy,
    refreshVisible,
    refreshEnabled: refreshVisible && !busy,
    refreshLabel: input.phase === "failed" || input.phase === "stale"
      ? "Reload devices"
      : "Refresh devices",
    nextEnabled:
      input.phase === "ready" &&
      input.page?.hasMore === true &&
      input.page.nextCursor !== null &&
      !busy,
    startOverVisible: input.pageOrdinal > 1,
    startOverEnabled: input.pageOrdinal > 1 && input.authority !== null && !busy,
    result: input.result,
    confirmation: confirmationView(input.selection, input.pendingRevoke)
  });
}

function unavailableView(
  result: PairedDeviceManagementResultView | null
): PairedDeviceManagementView {
  return Object.freeze({
    phase: "unavailable",
    tone: "muted",
    title: "Paired devices",
    detail: "Pair this browser to inspect devices.",
    rows: Object.freeze([]),
    pageOrdinal: 1,
    hasNextPage: false,
    readOnly: false,
    busy: false,
    refreshVisible: false,
    refreshEnabled: false,
    refreshLabel: "Refresh devices",
    nextEnabled: false,
    startOverVisible: false,
    startOverEnabled: false,
    result,
    confirmation: null
  });
}

function phaseCopy(input: BuildViewInput): {
  readonly tone: PairedDeviceManagementTone;
  readonly detail: string;
} {
  if (input.closed) return { tone: "muted", detail: "Device management is closed." };
  switch (input.phase) {
    case "unavailable":
      return {
        tone: input.result?.kind === "self_revoked" || input.result?.kind === "uncertain"
          ? "danger"
          : "muted",
        detail: input.result?.kind === "self_revoked" || input.result?.kind === "uncertain"
          ? "This browser no longer has current paired-device authority."
          : "Pair this browser to inspect devices."
      };
    case "loading":
      return {
        tone: "muted",
        detail: input.page === null
          ? "Checking paired devices."
          : "Loading another device page."
      };
    case "ready":
      if (input.page?.devices.length === 0) {
        return { tone: "muted", detail: "No paired devices were returned." };
      }
      return {
        tone: input.authority?.permission === "read" ? "attention" : "connected",
        detail: input.authority?.permission === "read"
          ? "Read-only access can inspect devices but cannot revoke them."
          : `Showing device page ${String(input.pageOrdinal)}.`
      };
    case "stale":
      return {
        tone: "attention",
        detail: "This device page is stale. Reload it before revoking another device."
      };
    case "failed":
      return {
        tone: "danger",
        detail: "HostDeck could not confirm the device list."
      };
    case "closed":
      return { tone: "muted", detail: "Device management is closed." };
  }
}

function rowView(
  device: SelectedDeviceListResponseItem,
  index: number,
  input: BuildViewInput,
  busy: boolean
): PairedDeviceManagementRowView {
  const key = rowKey(input.pageOrdinal, index);
  const cue = deviceCue(input.pageOrdinal, index);
  const status = deviceStatus(device, input.nowMs);
  const writer = input.authority?.permission === "write";
  const currentPage = input.phase === "ready";
  const csrfReady = input.authority?.csrfReady === true;
  const revokeVisible = writer;
  const revokeEnabled =
    writer &&
    csrfReady &&
    currentPage &&
    status !== "revoked" &&
    !busy;
  const disabledReason = (() => {
    if (!revokeVisible || revokeEnabled) return null;
    if (status === "revoked") return "This device is already revoked.";
    if (!csrfReady) return "Secure this page before revoking a device.";
    if (!currentPage) return "Reload this device page before revoking.";
    return "Another device operation is in progress.";
  })();
  return Object.freeze({
    key,
    label: visibleDeviceLabel(device.client_label),
    cue,
    permission: device.permission,
    permissionLabel: device.permission === "write" ? "Read & write" : "Read only",
    status,
    statusLabel: status[0]?.toUpperCase() + status.slice(1),
    lastUsedLabel: device.last_used_at === null
      ? "Never"
      : formatUtcTimestamp(device.last_used_at),
    expiresLabel: device.expires_at === null
      ? "No expiry"
      : formatUtcTimestamp(device.expires_at),
    current: device.device_id === input.authority?.deviceId,
    revokeVisible,
    revokeEnabled,
    revokeDisabledReason: disabledReason
  });
}

function confirmationView(
  selection: RevokeSelection | null,
  busy: boolean
): PairedDeviceRevokeConfirmationView | null {
  if (selection === null) return null;
  const targetLabel = selection.self
    ? "This phone"
    : `${selection.label} (${selection.cue})`;
  const detail = selection.self
    ? "This phone will immediately lose HostDeck reads, controls, and live updates. Pair it again from the laptop to restore access."
    : selection.expired
      ? "This pairing is already expired. Revocation makes that loss of access permanent."
      : "This device will immediately lose HostDeck reads, controls, and live updates.";
  return Object.freeze({
    rowKey: selection.rowKey,
    title: selection.self ? "Revoke this phone?" : "Revoke paired device?",
    targetLabel,
    detail,
    warning: selection.finalActive
      ? "This is the last active paired device. A new pairing link must be created on the laptop."
      : null,
    confirmLabel: selection.self ? "Revoke this phone" : "Revoke device",
    busy,
    confirmEnabled: !busy
  });
}

function parseDevicePage(
  response: BrowserHttpRouteResponse<"device_list">,
  cursor: string | null
): DevicePage | null {
  if (response.status !== 200) return null;
  const parsed = selectedDeviceListResponseSchema.safeParse(response.data);
  if (!parsed.success || parsed.data.devices.length > pairedDeviceManagementPageSize) {
    return null;
  }
  let afterDeviceId: string | null = null;
  if (cursor !== null) {
    try {
      afterDeviceId = decodeSelectedDeviceListCursor(cursor);
    } catch {
      return null;
    }
  }
  if (
    parsed.data.devices.some(
      (device) => afterDeviceId !== null && device.device_id <= afterDeviceId
    ) ||
    (parsed.data.has_more &&
      (parsed.data.devices.length !== pairedDeviceManagementPageSize ||
        parsed.data.next_cursor === null))
  ) {
    return null;
  }
  return Object.freeze({
    devices: Object.freeze(
      parsed.data.devices.map((device) => Object.freeze({ ...device }))
    ),
    nextCursor: parsed.data.next_cursor,
    hasMore: parsed.data.has_more
  });
}

function patchRevokedDevice(
  page: DevicePage,
  response: SelectedDeviceRevokeResponse
): DevicePage | null {
  let matches = 0;
  const devices = page.devices.map((device) => {
    if (device.device_id !== response.device_id) return device;
    matches += 1;
    if (device.revoked_at !== null) return device;
    return Object.freeze({ ...device, revoked_at: response.revoked_at });
  });
  if (matches !== 1) return null;
  return Object.freeze({
    devices: Object.freeze(devices),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore
  });
}

function revokeResponseMatches(
  response: SelectedDeviceRevokeResponse,
  owner: PendingRevoke
): boolean {
  return (
    response.operation_id === owner.operationId &&
    response.device_id === owner.selection.deviceId &&
    response.authority_invalidated &&
    response.self_revoked === owner.selection.self
  );
}

function resultView(
  kind: PairedDeviceManagementResultKind,
  title: string,
  detail: string
): PairedDeviceManagementResultView {
  const tone: PairedDeviceManagementTone = kind === "success"
    ? "connected"
    : kind === "failure"
      ? "attention"
      : "danger";
  return Object.freeze({
    kind,
    tone,
    title,
    detail,
    urgent: kind === "conflict" || kind === "uncertain" || kind === "self_revoked"
  });
}

function authorityFromSnapshot(snapshot: BrowserConnectionSnapshot): PairedAuthority | null {
  const access = snapshot.access.data;
  if (
    snapshot.access.state !== "current" ||
    access === null ||
    access.authentication_state !== "paired_device" ||
    access.device_id === null ||
    (access.permission !== "read" && access.permission !== "write")
  ) {
    return null;
  }
  return Object.freeze({
    key: JSON.stringify([
      access.configured_origin,
      access.network_mode,
      access.transport,
      access.device_id,
      access.permission,
      access.device_expires_at
    ]),
    deviceId: access.device_id,
    permission: access.permission,
    csrfReady: snapshot.csrf.phase === "ready"
  });
}

function findRow(
  page: DevicePage,
  ordinal: number,
  key: string
): { readonly device: SelectedDeviceListResponseItem; readonly cue: string } | null {
  for (let index = 0; index < page.devices.length; index += 1) {
    const device = page.devices[index];
    if (device !== undefined && rowKey(ordinal, index) === key) {
      return Object.freeze({ device, cue: deviceCue(ordinal, index) });
    }
  }
  return null;
}

function isProvenFinalActive(
  page: DevicePage,
  pageCursor: string | null,
  targetDeviceId: string,
  nowMs: number
): boolean {
  if (pageCursor !== null || page.hasMore) return false;
  const active = page.devices.filter(
    (device) => device.revoked_at === null && !isExpired(device, nowMs)
  );
  return active.length === 1 && active[0]?.device_id === targetDeviceId;
}

function deviceStatus(
  device: SelectedDeviceListResponseItem,
  nowMs: number
): PairedDeviceStatus {
  if (device.revoked_at !== null) return "revoked";
  return isExpired(device, nowMs) ? "expired" : "active";
}

function isExpired(device: SelectedDeviceListResponseItem, nowMs: number): boolean {
  return device.expires_at !== null && Date.parse(device.expires_at) <= nowMs;
}

function visibleDeviceLabel(label: string | null): string {
  if (label === null) return "Unlabeled device";
  const normalized = label
    .replace(/[\p{Bidi_Control}\p{Cc}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized.length === 0 ? "Unlabeled device" : normalized;
}

function rowKey(pageOrdinal: number, index: number): string {
  return `device-${String(pageOrdinal)}-${String(index + 1)}`;
}

function deviceCue(pageOrdinal: number, index: number): string {
  const position = (pageOrdinal - 1) * pairedDeviceManagementPageSize + index + 1;
  return `Device ${String(position)}`;
}

function formatUtcTimestamp(value: string): string {
  return `${value.slice(0, 10)} ${value.slice(11, 16)} UTC`;
}

function isConflictFailure(error: unknown): boolean {
  return error instanceof HostDeckBrowserCsrfError && error.status === 409;
}

function isConnectionSnapshot(candidate: unknown): candidate is BrowserConnectionSnapshot {
  return (
    candidate !== null &&
    typeof candidate === "object" &&
    Object.isFrozen(candidate) &&
    Object.hasOwn(candidate, "access") &&
    Object.hasOwn(candidate, "host") &&
    Object.hasOwn(candidate, "targetState") &&
    Object.hasOwn(candidate, "csrf")
  );
}

function readOptions(input: CreatePairedDeviceManagementControllerOptions): {
  readonly port: PairedDeviceManagementPort;
  readonly createOperationId: () => string;
  readonly clock: Readonly<{ readonly now: () => number }>;
} {
  const values = readExactRecord(input, requiredCreateOptionKeys, createOptionKeys);
  if (values === null || typeof values.createOperationId !== "function") {
    throw new TypeError("HostDeck paired-device management options are invalid.");
  }
  const port = readExactRecord(values.port, portKeys, portKeys);
  if (
    port === null ||
    typeof port.snapshot !== "function" ||
    typeof port.list !== "function" ||
    typeof port.revoke !== "function"
  ) {
    throw new TypeError("HostDeck paired-device management port is invalid.");
  }
  const clock = values.clock === undefined
    ? defaultClock
    : readExactRecord(values.clock, clockKeys, clockKeys);
  if (clock === null || typeof clock.now !== "function") {
    throw new TypeError("HostDeck paired-device management clock is invalid.");
  }
  return Object.freeze({
    port: Object.freeze({
      snapshot: port.snapshot as PairedDeviceManagementPort["snapshot"],
      list: port.list as PairedDeviceManagementPort["list"],
      revoke: port.revoke as PairedDeviceManagementPort["revoke"]
    }),
    createOperationId: values.createOperationId as () => string,
    clock: Object.freeze({ now: clock.now as () => number })
  });
}

function createDeferredView(): {
  readonly promise: Promise<PairedDeviceManagementView>;
  readonly resolve: (view: PairedDeviceManagementView) => void;
} {
  let resolve!: (view: PairedDeviceManagementView) => void;
  const promise = new Promise<PairedDeviceManagementView>((settle) => {
    resolve = settle;
  });
  return Object.freeze({ promise, resolve });
}

function readExactRecord<
  const Required extends string,
  const Allowed extends string
>(
  candidate: unknown,
  requiredKeys: readonly Required[],
  allowedKeys: readonly Allowed[]
): Readonly<Record<Allowed, unknown>> | null {
  try {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      return null;
    }
    const prototype: unknown = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.some(
        (key) => typeof key !== "string" || !(allowedKeys as readonly string[]).includes(key)
      ) ||
      requiredKeys.some((key) => !Object.hasOwn(descriptors, key))
    ) {
      return null;
    }
    const result = Object.create(null) as Record<Allowed, unknown>;
    for (const key of keys as Allowed[]) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.enumerable !== true
      ) {
        return null;
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function safeAbort(controller: AbortController): void {
  try {
    controller.abort();
  } catch {
    // A hostile realm must not block owner cleanup.
  }
}

function managementError(
  reason: PairedDeviceManagementErrorReason
): HostDeckPairedDeviceManagementError {
  return new HostDeckPairedDeviceManagementError(reason);
}

export function pairedDeviceManagementPortFromCoordinator(
  coordinator: BrowserConnectionStateCoordinator
): PairedDeviceManagementPort {
  return Object.freeze({
    snapshot: coordinator.snapshot,
    list: coordinator.requestDeviceList,
    revoke: coordinator.requestDeviceRevoke
  });
}
