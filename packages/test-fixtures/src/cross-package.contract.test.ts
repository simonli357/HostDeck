import {
  apiErrorEnvelopeSchema,
  apiSessionSchema,
  auditEventRecordSchema,
  hostStatusResponseSchema,
  uiMissionControlViewModelSchema,
  uiSessionDetailViewModelSchema
} from "@hostdeck/contracts";
import { describe, expect, it } from "vitest";
import { fakeApiSessions, fakeHostStates, fakeMissionControlViewModels, fakeSessionDetailViewModels, fixtureTimestamp } from "./index.js";

describe("cross-package fixture compatibility", () => {
  it("keeps fake sessions, hosts, and UI view models compatible with exported contracts", () => {
    for (const session of Object.values(fakeApiSessions)) {
      expect(apiSessionSchema.parse(session).id).toBe(session.id);
    }

    for (const hostState of Object.values(fakeHostStates)) {
      expect(hostStatusResponseSchema.parse(hostState).version).toBe("0.0.0");
    }

    for (const viewModel of Object.values(fakeMissionControlViewModels)) {
      expect(uiMissionControlViewModelSchema.parse(viewModel).screen).toBe("mission_control");
    }

    for (const viewModel of Object.values(fakeSessionDetailViewModels)) {
      expect(uiSessionDetailViewModelSchema.parse(viewModel).screen).toBe("session_detail");
    }
  });

  it("rejects invalid API and UI fixture drift loudly", () => {
    expect(() =>
      apiSessionSchema.parse({
        ...fakeApiSessions.questionWaiting,
        status: "healthy"
      })
    ).toThrow();

    expect(() =>
      uiSessionDetailViewModelSchema.parse({
        ...fakeSessionDetailViewModels.waitingForUser,
        output: {
          ...fakeSessionDetailViewModels.waitingForUser.output,
          session_id: "sess_other_contract_01"
        }
      })
    ).toThrow();
  });
});

describe("cross-package API errors and audit bounds", () => {
  it("validates shared API error shape", () => {
    expect(
      apiErrorEnvelopeSchema.parse({
        code: "validation_error",
        message: "Invalid fixture.",
        retryable: false,
        field: "status",
        session_id: fakeApiSessions.questionWaiting.id,
        details: {
          reason: "invalid_status"
        }
      }).code
    ).toBe("validation_error");
  });

  it("rejects sensitive or nested API error details", () => {
    expect(() =>
      apiErrorEnvelopeSchema.parse({
        code: "internal_error",
        message: "No sensitive details.",
        details: {
          auth_token: "secret"
        }
      })
    ).toThrow();

    expect(() =>
      apiErrorEnvelopeSchema.parse({
        code: "internal_error",
        message: "No nested details.",
        details: {
          nested: {
            value: true
          }
        }
      })
    ).toThrow();
  });

  it("keeps audit payload summaries bounded and sanitized", () => {
    expect(
      auditEventRecordSchema.parse({
        id: "audit_cross_package_01",
        at: fixtureTimestamp,
        actor: {
          type: "dashboard",
          client_id: "fixture-phone",
          permission: "write"
        },
        action: "prompt",
        session_id: fakeApiSessions.questionWaiting.id,
        payload_summary: {
          text_preview: "Continue",
          text_length: 8
        },
        result: "accepted",
        error_code: null
      }).id
    ).toBe("audit_cross_package_01");

    expect(() =>
      auditEventRecordSchema.parse({
        id: "audit_secret_payload",
        at: fixtureTimestamp,
        actor: {
          type: "dashboard",
          client_id: "fixture-phone",
          permission: "write"
        },
        action: "prompt",
        session_id: fakeApiSessions.questionWaiting.id,
        payload_summary: {
          token: "secret"
        },
        result: "accepted",
        error_code: null
      })
    ).toThrow();

    expect(() =>
      auditEventRecordSchema.parse({
        id: "audit_unbounded_payload",
        at: fixtureTimestamp,
        actor: {
          type: "dashboard",
          client_id: "fixture-phone",
          permission: "write"
        },
        action: "prompt",
        session_id: fakeApiSessions.questionWaiting.id,
        payload_summary: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`field_${index}`, index])),
        result: "accepted",
        error_code: null
      })
    ).toThrow();
  });
});
