import { describe, expect, it } from "vitest";
import {
  evaluateRemoteIngressAvailability,
  remoteIngressIntentStates,
  remoteIngressObservationStates,
  remoteIngressOperationFailureReasons,
  remoteIngressUnavailableReasons,
  remoteProfileStates,
  remoteServeStates,
  tailscaleClientStates
} from "./remote-ingress.js";

const readyInput = {
  intent: "enabled",
  observation: "current",
  client: "available",
  profile: "dedicated",
  serve: "exact",
  externalOriginValid: true,
  operationFailure: null
} as const;

describe("remote ingress availability", () => {
  it("opens admission only for a current dedicated profile and exact private Serve mapping", () => {
    expect(evaluateRemoteIngressAvailability(readyInput)).toEqual({
      availability: "ready",
      admission: "open",
      reason: null
    });
  });

  it("keeps explicit disable closed even when an exact Serve mapping remains", () => {
    expect(evaluateRemoteIngressAvailability({ ...readyInput, intent: "disabled" })).toEqual({
      availability: "disabled",
      admission: "closed",
      reason: null
    });
    expect(
      evaluateRemoteIngressAvailability({
        ...readyInput,
        intent: "disabled",
        operationFailure: "cleanup_incomplete"
      })
    ).toEqual({ availability: "disabled", admission: "closed", reason: "cleanup_incomplete" });
  });

  it.each([
    [{ observation: "stale" as const }, "observation_stale"],
    [{ observation: "failed" as const }, "observation_failed"],
    [{ client: "not_installed" as const }, "client_not_installed"],
    [{ client: "unsupported" as const }, "client_unsupported"],
    [{ client: "error" as const }, "client_error"],
    [{ profile: "absent" as const }, "profile_absent"],
    [{ profile: "stopped" as const }, "client_stopped"],
    [{ profile: "signed_out" as const }, "client_signed_out"],
    [{ profile: "other" as const }, "profile_other"],
    [{ profile: "unknown" as const }, "profile_unknown"],
    [{ serve: "absent" as const }, "serve_absent"],
    [{ serve: "foreign" as const }, "serve_foreign"],
    [{ serve: "colliding" as const }, "serve_colliding"],
    [{ serve: "drifted" as const }, "serve_drifted"],
    [{ serve: "public" as const }, "serve_public"],
    [{ serve: null }, "observation_failed"],
    [{ externalOriginValid: false }, "external_origin_invalid"]
  ])("fails closed with one stable reason", (override, reason) => {
    expect(evaluateRemoteIngressAvailability({ ...readyInput, ...override })).toEqual({
      availability: "unavailable",
      admission: "closed",
      reason
    });
  });

  it.each(remoteIngressOperationFailureReasons)("preserves the %s operation failure without opening admission", (reason) => {
    expect(evaluateRemoteIngressAvailability({ ...readyInput, serve: "absent", operationFailure: reason })).toEqual({
      availability: "unavailable",
      admission: "closed",
      reason
    });
  });

  it("preserves a verified post-command profile change instead of collapsing it into a generic mismatch", () => {
    expect(
      evaluateRemoteIngressAvailability({
        ...readyInput,
        profile: "other",
        serve: null,
        operationFailure: "profile_changed"
      })
    ).toEqual({ availability: "unavailable", admission: "closed", reason: "profile_changed" });
  });

  it("keeps every profile, Serve, and failure category finite and unique", () => {
    expect(remoteProfileStates).toEqual(["absent", "stopped", "signed_out", "dedicated", "other", "unknown"]);
    expect(remoteServeStates).toEqual(["absent", "exact", "foreign", "colliding", "drifted", "public"]);
    expect(new Set(remoteIngressUnavailableReasons).size).toBe(remoteIngressUnavailableReasons.length);
  });

  it("keeps the complete finite input product fail-closed except for the one exact ready tuple", () => {
    const serves = [...remoteServeStates, null] as const;
    const failures = [...remoteIngressOperationFailureReasons, null] as const;
    let examined = 0;
    let open = 0;

    for (const intent of remoteIngressIntentStates) {
      for (const observation of remoteIngressObservationStates) {
        for (const client of tailscaleClientStates) {
          for (const profile of remoteProfileStates) {
            for (const serve of serves) {
              for (const externalOriginValid of [false, true]) {
                for (const operationFailure of failures) {
                  const decision = evaluateRemoteIngressAvailability({
                    intent,
                    observation,
                    client,
                    profile,
                    serve,
                    externalOriginValid,
                    operationFailure
                  });
                  const exactReadyTuple =
                    intent === "enabled" &&
                    observation === "current" &&
                    client === "available" &&
                    profile === "dedicated" &&
                    serve === "exact" &&
                    externalOriginValid &&
                    operationFailure === null;

                  examined += 1;
                  if (decision.admission === "open") open += 1;
                  expect(decision.admission === "open").toBe(exactReadyTuple);
                  expect(decision.availability === "ready").toBe(exactReadyTuple);
                  if (decision.availability === "unavailable") {
                    expect(decision.reason).not.toBeNull();
                    expect(remoteIngressUnavailableReasons).toContain(decision.reason);
                  }
                }
              }
            }
          }
        }
      }
    }

    expect(examined).toBe(18_144);
    expect(open).toBe(1);
  });
});
