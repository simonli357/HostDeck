import type {
  AppendSelectedEventResult,
  AutomaticSelectedSessionEnrollmentResult,
  SelectedNativeSessionUnmanageResult,
  SelectedSessionState,
  SelectedStateRepository
} from "@hostdeck/storage";
import {
  assertSessionCatalogHub,
  type SessionCatalogHub
} from "./session-catalog-hub.js";

export interface CreateCatalogPublishingStateRepositoryInput {
  readonly catalog: SessionCatalogHub;
  readonly observe_failure: (error: unknown) => void;
  readonly states: SelectedStateRepository;
}

export function createCatalogPublishingStateRepository(
  input: CreateCatalogPublishingStateRepositoryInput
): SelectedStateRepository {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Reflect.ownKeys(input).length !== 3 ||
    typeof input.observe_failure !== "function" ||
    input.states === null ||
    typeof input.states !== "object"
  ) {
    throw new TypeError("Catalog-publishing state repository configuration is invalid.");
  }
  assertSessionCatalogHub(input.catalog);
  assertSelectedStateRepository(input.states);
  const catalog = input.catalog;
  const states = input.states;

  const publish = (
    sessionId: string,
    reason: "archived" | "ineligible" | "missing" | "reconciled"
  ): void => {
    try {
      catalog.synchronize(sessionId, reason);
    } catch (error) {
      try {
        input.observe_failure(error);
      } catch {
        // Publication failure remains authoritative even when diagnostics fail.
      }
      throw error;
    }
  };

  return Object.freeze<SelectedStateRepository>({
    get: states.get.bind(states),
    require: states.require.bind(states),
    getByThreadId: states.getByThreadId.bind(states),
    getByTargetId: states.getByTargetId.bind(states),
    requireByTargetId: states.requireByTargetId.bind(states),
    list: states.list.bind(states),
    create(candidate): SelectedSessionState {
      const committed = states.create(candidate);
      publish(committed.mapping.id, absenceReason(committed));
      return committed;
    },
    adopt(candidate): SelectedSessionState {
      const committed = states.adopt(candidate);
      publish(committed.mapping.id, absenceReason(committed));
      return committed;
    },
    enrollAutomatic(candidate): AutomaticSelectedSessionEnrollmentResult {
      const committed = states.enrollAutomatic(candidate);
      publish(committed.state.mapping.id, absenceReason(committed.state));
      return committed;
    },
    replace(candidate, expectedRevision): SelectedSessionState {
      const committed = states.replace(candidate, expectedRevision);
      publish(committed.mapping.id, absenceReason(committed));
      return committed;
    },
    appendEvent(
      event,
      nextProjection,
      expectedRevision,
      retention
    ): AppendSelectedEventResult {
      const committed = states.appendEvent(
        event,
        nextProjection,
        expectedRevision,
        retention
      );
      const current = states.require(committed.event.event.session_id);
      publish(current.mapping.id, absenceReason(current));
      return committed;
    },
    replaceEventsWithBoundary(
      event,
      nextProjection,
      expectedRevision
    ): AppendSelectedEventResult {
      const committed = states.replaceEventsWithBoundary(
        event,
        nextProjection,
        expectedRevision
      );
      const current = states.require(committed.event.event.session_id);
      publish(current.mapping.id, absenceReason(current));
      return committed;
    },
    listEvents: states.listEvents.bind(states),
    getNativeMembership: states.getNativeMembership.bind(states),
    listNativeMemberships: states.listNativeMemberships.bind(states),
    getSharedMembership: states.getSharedMembership.bind(states),
    getSharedMembershipByThreadId:
      states.getSharedMembershipByThreadId.bind(states),
    listSharedMemberships: states.listSharedMemberships.bind(states),
    unmanageAdopted(
      sessionId,
      expectedRevision
    ): SelectedNativeSessionUnmanageResult {
      const committed = states.unmanageAdopted(sessionId, expectedRevision);
      publish(committed.state.mapping.id, "reconciled");
      return committed;
    },
    getLegacyDisposition: states.getLegacyDisposition.bind(states),
    listLegacyDispositions: states.listLegacyDispositions.bind(states),
    getRecovery: states.getRecovery.bind(states),
    listRecoveries: states.listRecoveries.bind(states),
    putRecovery: states.putRecovery.bind(states),
    deleteRecovery: states.deleteRecovery.bind(states)
  });
}

function absenceReason(
  state: SelectedSessionState
): "archived" | "ineligible" {
  return state.mapping.archived_at !== null ||
    state.projection.session.session_state === "archived"
    ? "archived"
    : "ineligible";
}

function assertSelectedStateRepository(
  candidate: SelectedStateRepository
): void {
  const methods: readonly (keyof SelectedStateRepository)[] = [
    "get",
    "require",
    "getByThreadId",
    "getByTargetId",
    "requireByTargetId",
    "list",
    "create",
    "adopt",
    "enrollAutomatic",
    "replace",
    "appendEvent",
    "replaceEventsWithBoundary",
    "listEvents",
    "getNativeMembership",
    "listNativeMemberships",
    "getSharedMembership",
    "getSharedMembershipByThreadId",
    "listSharedMemberships",
    "unmanageAdopted",
    "getLegacyDisposition",
    "listLegacyDispositions",
    "getRecovery",
    "listRecoveries",
    "putRecovery",
    "deleteRecovery"
  ];
  if (methods.some((method) => typeof candidate[method] !== "function")) {
    throw new TypeError("Catalog publication requires a complete selected-state repository.");
  }
}
