import {
  historicalSelectedNetworkAuditActions,
  selectedAuditActions,
  selectedOperationKinds
} from "@hostdeck/core";
import { describe, expect, it } from "vitest";
import { apiRouteContracts } from "./api-route-contracts.js";
import * as serverPackage from "./index.js";
import { historicalLanRouteInventory } from "./lan-network-routes.js";
import {
  selectedApiAuditActions,
  selectedApiAuthMechanisms,
  selectedApiAuthorities,
  selectedApiCredentialEffects,
  selectedApiRouteFamilies,
  selectedApiRouteManifest,
  selectedApiRouteMethods,
  selectedApiRouteOwnerTasks,
  selectedApiSchemaIds
} from "./selected-api-route-manifest.js";

const expectedRouteIds = [
  "health_liveness",
  "health_readiness",
  "host_status",
  "session_list",
  "session_start",
  "session_detail",
  "session_events",
  "session_event_stream",
  "session_resume_metadata",
  "session_archive",
  "prompt_dispatch",
  "model_read",
  "model_select",
  "goal_read",
  "goal_mutate",
  "plan_read",
  "plan_select",
  "usage_read",
  "compact_read",
  "compact_start",
  "skills_read",
  "approval_list",
  "approval_respond",
  "turn_interrupt",
  "pair_request",
  "pair_claim",
  "csrf_bootstrap",
  "access_state",
  "device_list",
  "device_revoke",
  "host_lock",
  "host_unlock",
  "remote_status",
  "remote_enable",
  "remote_disable"
] as const;

const expectedMutationActions = [
  "approval_response",
  "archive",
  "compact",
  "csrf_bootstrap",
  "device_revoke",
  "goal",
  "interrupt",
  "lock",
  "model",
  "pair_claim",
  "pair_request",
  "plan",
  "prompt",
  "remote_disable",
  "remote_enable",
  "session_start",
  "unlock"
] as const;

describe("selected API route manifest", () => {
  it("freezes exactly the rebaselined 35-route V1 inventory", () => {
    expect(selectedApiRouteManifest.map((route) => route.id)).toEqual(expectedRouteIds);
    expect(selectedApiRouteManifest).toHaveLength(35);
    expect(new Set(selectedApiRouteManifest.map((route) => route.id)).size).toBe(35);
    expect(new Set(selectedApiRouteManifest.map((route) => `${route.method} ${route.path}`)).size).toBe(35);
    expect(new Set(selectedApiRouteManifest.map((route) => route.family))).toEqual(
      new Set(selectedApiRouteFamilies)
    );
    expectRecursivelyFrozen(selectedApiRouteManifest);
  });

  it("keeps every path versioned, explicit, bounded, and structurally unambiguous", () => {
    const routePath = /^\/api\/v1\/[a-z][a-z0-9-]*(?:\/(?:[a-z][a-z0-9-]*|:[a-z][a-z0-9_]*))*$/u;
    for (const route of selectedApiRouteManifest) {
      expect(selectedApiRouteMethods).toContain(route.method);
      expect(route.path).toMatch(routePath);
      expect(route.path).not.toMatch(/[?*]|\/\//u);
    }

    for (const [index, left] of selectedApiRouteManifest.entries()) {
      for (const right of selectedApiRouteManifest.slice(index + 1)) {
        if (left.method === right.method) expect(routesCanOverlap(left.path, right.path)).toBe(false);
      }
    }
  });

  it("assigns exact request/response contracts, handlers, and downstream owners", () => {
    const schemas = new Set(selectedApiSchemaIds);
    const owners = new Set(selectedApiRouteOwnerTasks);
    const usedSchemas = new Set(["selected_api_error_v1"]);
    const usedOwners = new Set<string>();

    for (const route of selectedApiRouteManifest) {
      expect(Object.keys(route).sort()).toEqual([
        "audit",
        "auth",
        "authority",
        "credential_effect",
        "csrf",
        "family",
        "handler",
        "id",
        "lock",
        "method",
        "operation_kind",
        "owner_task",
        "path",
        "request",
        "response",
        "target",
        "transport"
      ]);
      expect(Object.keys(route.request).sort()).toEqual(["body", "params", "query"]);
      expect(Object.keys(route.response).sort()).toEqual(["error", "success"]);
      expect(route.id).toMatch(/^[a-z][a-z0-9_]*$/u);
      expect(route.handler).toMatch(/^[a-z][a-zA-Z]*(?:\.[a-z][a-zA-Z]*)+$/u);
      expect(owners.has(route.owner_task)).toBe(true);
      expect(route.response.error).toBe("selected_api_error_v1");
      expect(schemas.has(route.response.success)).toBe(true);
      usedOwners.add(route.owner_task);
      usedSchemas.add(route.response.success);
      for (const contract of Object.values(route.request)) {
        if (contract !== null) {
          expect(schemas.has(contract)).toBe(true);
          usedSchemas.add(contract);
        }
      }
    }

    expect(usedOwners).toEqual(owners);
    expect(usedSchemas).toEqual(schemas);
  });

  it("keeps HTTP method, transport, path parameters, and body ownership coherent", () => {
    for (const route of selectedApiRouteManifest) {
      const parameters = route.path.split("/").filter((part) => part.startsWith(":"));
      expect(route.request.params === null).toBe(parameters.length === 0);

      if (route.method === "GET") {
        expect(route.request.body).toBeNull();
        expect(route.audit).toBeNull();
        expect(route.csrf).toBe("none");
      } else {
        expect(route.transport).toBe("json");
        expect(route.request.query).toBeNull();
        expect(route.request.body).not.toBeNull();
        expect(route.audit).not.toBeNull();
      }

      if (route.transport === "sse") {
        expect(route).toMatchObject({ method: "GET", id: "session_event_stream" });
      }

      if (parameters.includes(":request_id")) expect(route.request.params).toBe("session_approval_params_v1");
      else if (parameters.includes(":turn_id")) expect(route.request.params).toBe("session_turn_params_v1");
      else if (parameters.includes(":device_id")) expect(route.request.params).toBe("device_id_params_v1");
      else if (parameters.includes(":session_id")) expect(route.request.params).toBe("session_id_params_v1");
    }
  });

  it("covers every selected operation and gives every mutation one exact audit action", () => {
    expect(new Set(selectedApiRouteManifest.flatMap((route) => route.operation_kind ?? []))).toEqual(
      new Set(selectedOperationKinds)
    );
    expect(
      selectedApiRouteManifest
        .filter((route) => route.method === "POST")
        .map((route) => route.audit?.action)
        .sort()
    ).toEqual(expectedMutationActions);

    for (const route of selectedApiRouteManifest) {
      if (route.audit?.executor === "selected_write_gate") {
        expect(route).toMatchObject({
          auth: "local_admin_or_device_cookie",
          authority: "session_write",
          csrf: "required_for_device",
          lock: "requires_unlocked_host"
        });
        expect(["new_managed_session", "managed_session", "approval", "turn"]).toContain(route.target);
      }
      if (route.audit?.executor === "security_executor") {
        expect(route.operation_kind).toBeNull();
        expect(route.lock).not.toBe("requires_unlocked_host");
      }
      if (route.operation_kind !== null && route.audit?.catalog_state === "selected") {
        expect(route.audit.action).toBe(route.operation_kind);
      }
    }
  });

  it("uses only selected audit-catalog actions and leaves no extension open", () => {
    const knownActions = new Set<string>(selectedApiAuditActions);
    const selectedActions = new Set(selectedAuditActions);
    const ownedExtensions = selectedApiRouteManifest
      .filter((route) => route.audit?.catalog_state === "owned_extension")
      .map((route) => route.audit?.action)
      .sort();
    expect(ownedExtensions).toEqual([]);
    expect(
      Object.fromEntries(
        selectedApiRouteManifest
          .filter((route) => route.audit?.catalog_state === "owned_extension")
          .map((route) => [route.audit?.action, route.audit?.catalog_owner_task])
      )
    ).toEqual({});
    for (const action of historicalSelectedNetworkAuditActions) {
      expect(knownActions.has(action)).toBe(false);
      expect(
        selectedApiRouteManifest.some(
          (route) => route.audit !== null && String(route.audit.action) === action
        )
      ).toBe(false);
    }
    for (const route of selectedApiRouteManifest) {
      if (route.audit === null) continue;
      expect(knownActions.has(route.audit.action)).toBe(true);
      expect(selectedActions.has(route.audit.action as (typeof selectedAuditActions)[number])).toBe(true);
      expect(route.audit.catalog_state).toBe("selected");
      expect(route.audit.catalog_owner_task).toBeNull();
    }
  });

  it("keeps authentication, authority, CSRF, lock, and target policies non-contradictory", () => {
    const auth = new Set(selectedApiAuthMechanisms);
    const authority = new Set(selectedApiAuthorities);
    for (const route of selectedApiRouteManifest) {
      expect(auth.has(route.auth)).toBe(true);
      expect(authority.has(route.authority)).toBe(true);
      if (route.csrf === "required_for_device") expect(route.auth).toBe("local_admin_or_device_cookie");
      if (route.csrf === "rotate") {
        expect(route).toMatchObject({ id: "csrf_bootstrap", auth: "device_cookie", authority: "csrf_rotate" });
      }
      if (route.lock === "requires_unlocked_host") {
        expect(route.audit?.executor).toBe("selected_write_gate");
      }
      if (route.auth === "local_admin") expect(route.authority).toBe("local_admin");
    }

    expect(byId("health_liveness")).toMatchObject({ auth: "none", authority: "public" });
    expect(byId("device_list")).toMatchObject({
      method: "GET",
      auth: "device_cookie",
      authority: "device_admin"
    });
    expect(byId("pair_claim")).toMatchObject({ auth: "pairing_code", authority: "pair_claim" });
    expect(byId("access_state")).toMatchObject({ auth: "optional_device_cookie", authority: "access_read" });
    expect(byId("remote_status")).toMatchObject({
      auth: "local_admin_or_device_cookie",
      authority: "access_read"
    });
    expect(byId("host_unlock")).toMatchObject({ auth: "local_admin", lock: "lock_transition" });
    for (const id of ["pair_request", "remote_enable", "remote_disable"] as const) {
      expect(byId(id)).toMatchObject({ auth: "local_admin", authority: "local_admin" });
    }

    expect(new Set(selectedApiCredentialEffects)).toEqual(
      new Set(["none", "set_device_cookie", "rotate_csrf", "invalidate_device"])
    );
    expect(
      Object.fromEntries(
        selectedApiRouteManifest
          .filter((route) => route.credential_effect !== "none")
          .map((route) => [route.id, route.credential_effect])
      )
    ).toEqual({
      pair_claim: "set_device_cookie",
      csrf_bootstrap: "rotate_csrf",
      device_revoke: "invalidate_device"
    });
  });

  it("pins remote status and local-admin mutation ownership without a transport or identity fallback", () => {
    const remoteRoutes = selectedApiRouteManifest.filter((route) => route.family === "remote");
    expect(remoteRoutes).toEqual([
      expect.objectContaining({
        id: "remote_status",
        method: "GET",
        path: "/api/v1/remote/status",
        transport: "json",
        request: { params: null, query: null, body: null },
        response: {
          success: "remote_ingress_public_state_v1",
          error: "selected_api_error_v1"
        },
        auth: "local_admin_or_device_cookie",
        authority: "access_read",
        csrf: "none",
        lock: "not_applicable",
        target: "host",
        audit: null,
        handler: "remote.readStatus",
        owner_task: "IFC-V1-076"
      }),
      expect.objectContaining({
        id: "remote_enable",
        method: "POST",
        path: "/api/v1/remote/enable",
        request: { params: null, query: null, body: "remote_enable_request_v1" },
        response: {
          success: "remote_ingress_public_state_v1",
          error: "selected_api_error_v1"
        },
        auth: "local_admin",
        authority: "local_admin",
        csrf: "none",
        lock: "not_applicable",
        audit: {
          executor: "security_executor",
          action: "remote_enable",
          catalog_state: "selected",
          catalog_owner_task: null
        },
        handler: "remote.enable",
        owner_task: "IFC-V1-076"
      }),
      expect.objectContaining({
        id: "remote_disable",
        method: "POST",
        path: "/api/v1/remote/disable",
        request: { params: null, query: null, body: "remote_disable_request_v1" },
        response: {
          success: "remote_ingress_public_state_v1",
          error: "selected_api_error_v1"
        },
        auth: "local_admin",
        authority: "local_admin",
        csrf: "none",
        lock: "not_applicable",
        audit: {
          executor: "security_executor",
          action: "remote_disable",
          catalog_state: "selected",
          catalog_owner_task: null
        },
        handler: "remote.disable",
        owner_task: "IFC-V1-076"
      })
    ]);

    const remoteContract = JSON.stringify(remoteRoutes);
    expect(remoteContract).not.toMatch(
      /pairing_code|tailscale|tailnet_identity|profile|node_key|auth_key|raw_|secret|token/iu
    );
    expect(remoteRoutes.every((route) => route.transport === "json")).toBe(true);
    expect(remoteRoutes.filter((route) => route.method === "POST").every((route) => route.audit !== null)).toBe(true);
    expect(byId("pair_request")).toMatchObject({
      path: "/api/v1/access/pairing-codes",
      audit: { action: "pair_request" },
      handler: "access.createPairingCode",
      owner_task: "IFC-V1-028"
    });
  });

  it("contains no selected LAN or custom-certificate route, schema, action, or owner", () => {
    const serialized = JSON.stringify({
      actions: selectedApiAuditActions,
      routes: selectedApiRouteManifest,
      schemas: selectedApiSchemaIds
    });
    expect(serialized).not.toMatch(/"lan_|\/network(?:\/|")|certificate/iu);
    expect(selectedApiRouteOwnerTasks).not.toContain("IFC-V1-031");
  });

  it("isolates the frozen LAN route inventory outside the selected manifest and package exports", () => {
    expect(historicalLanRouteInventory).toEqual([
      { id: "network_state", method: "GET", path: "/api/v1/network" },
      { id: "network_configure", method: "POST", path: "/api/v1/network/configure" },
      { id: "network_enable", method: "POST", path: "/api/v1/network/enable" },
      { id: "network_disable", method: "POST", path: "/api/v1/network/disable" }
    ]);
    expectRecursivelyFrozen(historicalLanRouteInventory);

    const selectedRoutes = new Set(
      selectedApiRouteManifest.map((route) => `${route.method} ${route.path}`)
    );
    expect(
      historicalLanRouteInventory.every(
        (route) => !selectedRoutes.has(`${route.method} ${route.path}`)
      )
    ).toBe(true);
    for (const exportName of [
      "createHostDeckLanCertificatePolicy",
      "createHostDeckLanNetworkRouteRegistration",
      "createHostDeckLanNetworkService",
      "historicalLanRouteInventory",
      "hostDeckLanNetworkRouteRegistrationId"
    ]) {
      expect(Reflect.has(serverPackage, exportName), exportName).toBe(false);
    }
  });

  it("excludes the historical terminal surface and keeps it explicitly separate", () => {
    const forbiddenSegments = new Set(["output", "raw-input", "slash", "stop", "delete", "import", "bulk", "tmux"]);
    for (const route of selectedApiRouteManifest) {
      expect(route.path.startsWith("/api/v1/")).toBe(true);
      expect(route.path.split("/").some((segment) => forbiddenSegments.has(segment))).toBe(false);
      expect(JSON.stringify(route)).not.toMatch(/tmux|raw_input|slash_command|terminal_output/iu);
    }

    expect(apiRouteContracts).toHaveLength(17);
    expect(apiRouteContracts.some((route) => route.path.endsWith("/raw-input"))).toBe(true);
    expect(apiRouteContracts.some((route) => route.path.endsWith("/slash"))).toBe(true);
    expect(apiRouteContracts.every((route) => !route.path.startsWith("/api/v1/"))).toBe(true);
    const selectedRoutes = new Set(selectedApiRouteManifest.map((route) => `${route.method} ${route.path}`));
    expect(apiRouteContracts.every((route) => !selectedRoutes.has(`${route.method} ${route.path}`))).toBe(true);
  });
});

function byId(id: (typeof expectedRouteIds)[number]) {
  const route = selectedApiRouteManifest.find((candidate) => candidate.id === id);
  if (route === undefined) throw new Error(`Missing selected API route ${id}.`);
  return route;
}

function routesCanOverlap(left: string, right: string): boolean {
  const leftParts = left.split("/");
  const rightParts = right.split("/");
  if (leftParts.length !== rightParts.length) return false;
  return leftParts.every(
    (part, index) => part === rightParts[index] || part.startsWith(":") || rightParts[index]?.startsWith(":")
  );
}

function expectRecursivelyFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value as Record<string, unknown>)) expectRecursivelyFrozen(child);
}
