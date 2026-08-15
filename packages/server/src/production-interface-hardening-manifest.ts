import { hostDeckSelectedApiRouteCompositionDescriptor } from "./selected-api-route-composition.js";
import { selectedApiRouteManifest } from "./selected-api-route-manifest.js";

export const productionInterfaceHardeningCriterionIds = Object.freeze([
  "PIH-01",
  "PIH-02",
  "PIH-03",
  "PIH-04",
  "PIH-05",
  "PIH-06",
  "PIH-07",
  "PIH-08",
  "PIH-09",
  "PIH-10",
  "PIH-11",
  "PIH-12",
  "PIH-13",
  "PIH-14",
  "PIH-15",
  "PIH-16",
  "PIH-17",
  "PIH-18",
  "PIH-19",
  "PIH-20",
  "PIH-21",
  "PIH-22",
  "PIH-23",
  "PIH-24"
] as const);

export type ProductionInterfaceHardeningCriterionId =
  (typeof productionInterfaceHardeningCriterionIds)[number];

export const productionInterfaceHardeningRequirementIds = Object.freeze([
  "FR-011",
  "FR-012",
  "FR-017",
  "FR-018",
  "IR-006",
  "IR-008",
  "NFR-001",
  "NFR-002",
  "NFR-005",
  "NFR-009",
  "NFR-010",
  "NFR-011",
  "NFR-012",
  "PR-002",
  "PR-003",
  "PR-004",
  "PR-005",
  "PR-007",
  "PR-008",
  "PR-009",
  "PR-010",
  "PR-011",
  "PR-012",
  "SFR-001",
  "SFR-002",
  "SFR-003",
  "SFR-004",
  "SFR-005",
  "SFR-006",
  "SFR-007",
  "SFR-008",
  "SFR-012",
  "SFR-013",
  "SFR-014",
  "SFR-015",
  "SFR-016",
  "SFR-017",
  "SFR-018"
] as const);

export type ProductionInterfaceHardeningRequirementId =
  (typeof productionInterfaceHardeningRequirementIds)[number];

export const productionInterfaceHardeningDimensions = Object.freeze([
  "identity_and_composition",
  "http_contracts",
  "resource_limits",
  "operation_consistency",
  "sse",
  "ingress_trust",
  "application_security",
  "privacy",
  "remote_observation",
  "remote_control",
  "network_recovery",
  "compatibility_and_health",
  "startup",
  "shutdown",
  "cli",
  "package_and_service"
] as const);

export type ProductionInterfaceHardeningDimension =
  (typeof productionInterfaceHardeningDimensions)[number];

export const productionInterfaceHardeningEvidence = Object.freeze([
  evidence("criteria", "L1", "artifacts/ifc-v1-091-selected-production-interface-hardening.md"),
  evidence(
    "ledger_validator",
    "L1",
    "packages/server/src/production-interface-hardening-manifest.test.ts"
  ),
  evidence(
    "route_manifest",
    "L1",
    "packages/server/src/selected-api-route-manifest.contract.test.ts"
  ),
  evidence(
    "route_composition",
    "L2",
    "packages/server/src/selected-api-route-composition.test.ts"
  ),
  evidence(
    "application_composition",
    "L2",
    "packages/server/src/production-application-composition.test.ts"
  ),
  evidence(
    "resource_aggregate",
    "L2",
    "tests/production-resource-stress.integration.test.ts"
  ),
  evidence(
    "remote_security_aggregate",
    "L2",
    "packages/server/src/remote-ingress-security-acceptance.test.ts"
  ),
  evidence("request_trust", "L2", "packages/server/src/fastify-request-trust.test.ts"),
  evidence(
    "request_authentication",
    "L2",
    "packages/server/src/fastify-request-authentication.test.ts"
  ),
  evidence("sse_transport", "L2", "packages/server/src/fastify-sse-transport.test.ts"),
  evidence(
    "sse_backpressure",
    "L2",
    "packages/server/src/fastify-sse-heartbeat-backpressure.test.ts"
  ),
  evidence(
    "projection_lifecycle",
    "L2",
    "packages/server/src/projection-lifecycle-acceptance.test.ts"
  ),
  evidence(
    "write_gate",
    "L2",
    "packages/server/src/selected-write-gate.test.ts"
  ),
  evidence(
    "deadline_aggregate",
    "L2",
    "packages/server/src/codex-request-deadline-aggregate.test.ts"
  ),
  evidence(
    "remote_control",
    "L2",
    "packages/server/src/remote-ingress-control-service.test.ts"
  ),
  evidence(
    "remote_lifecycle",
    "L2",
    "packages/server/src/remote-ingress-lifecycle.test.ts"
  ),
  evidence("tailscale_observer", "L2", "packages/server/src/tailscale-observer.test.ts"),
  evidence(
    "tailscale_manager",
    "L2",
    "packages/server/src/tailscale-serve-manager.test.ts"
  ),
  evidence(
    "compatibility_diagnostic",
    "L2",
    "packages/server/src/runtime-compatibility-status.test.ts"
  ),
  evidence(
    "application_shutdown",
    "L2",
    "packages/server/src/application-shutdown-real.test.ts"
  ),
  evidence("cli_transport", "L2", "packages/cli/src/loopback-http.test.ts"),
  evidence("cli_grammar", "L1", "packages/cli/src/cli.contract.test.ts"),
  evidence("cli_executable", "L2", "packages/cli/src/executable-cli.test.ts"),
  evidence("service_lifecycle", "L2", "packages/cli/src/service-lifecycle.test.ts"),
  evidence("runtime_boundary", "L2", "scripts/check-selected-runtime-boundary.test.mjs"),
  evidence("production_package", "L3", "scripts/production-package.test.mjs"),
  evidence("production_foreground", "L3", "scripts/production-executable-serve.smoke.mjs"),
  evidence("production_service_host", "L3", "scripts/production-service-host.smoke.mjs"),
  evidence(
    "production_application_smoke",
    "L3",
    "packages/server/src/production-application-composition.smoke.test.ts"
  ),
  evidence("live_remote_control", "L3", "packages/cli/src/remote-control.smoke.test.ts"),
  evidence("systemd_units", "L3", "scripts/production-systemd-user-units.smoke.mjs"),
  evidence("service_manager", "L3", "scripts/production-service-lifecycle.smoke.mjs"),
  acceptedEvidence({
    id: "clean_user_acceptance",
    level: "L4",
    path: "artifacts/ifc-v1-058-clean-environment-parity/evidence.json",
    task: "IFC-V1-058",
    task_field: "task_id",
    commit: "eb77647e8b1e77e42b16fef21b65da0d1b65ea8e",
    commit_field: "source_commit"
  }),
  acceptedEvidence({
    id: "remote_android_acceptance",
    level: "L4",
    path: "artifacts/ifc-v1-079-device/evidence.json",
    task: "IFC-V1-079",
    task_field: "task",
    commit: "b4078b6d411267dec9701ed5ae67037567a9dee9",
    commit_field: "commit"
  })
] as const);

export type ProductionInterfaceHardeningEvidenceId =
  (typeof productionInterfaceHardeningEvidence)[number]["id"];

export const productionInterfaceHardeningCriteria = Object.freeze([
  criterion("PIH-01", ["FR-012", "PR-004"], ["identity_and_composition"], [
    "criteria",
    "ledger_validator",
    "route_manifest"
  ]),
  criterion(
    "PIH-02",
    ["FR-012", "FR-018", "PR-002", "PR-004", "PR-010"],
    ["identity_and_composition"],
    ["route_composition", "application_composition", "runtime_boundary"]
  ),
  criterion("PIH-03", ["FR-012", "NFR-005", "SFR-005"], ["http_contracts"], [
    "route_composition",
    "resource_aggregate"
  ]),
  criterion("PIH-04", ["NFR-010", "NFR-011", "SFR-017"], ["resource_limits"], [
    "resource_aggregate",
    "deadline_aggregate",
    "sse_backpressure"
  ]),
  criterion(
    "PIH-05",
    ["NFR-002", "SFR-005", "SFR-013", "SFR-016"],
    ["operation_consistency"],
    ["resource_aggregate", "write_gate", "deadline_aggregate"]
  ),
  criterion(
    "PIH-06",
    ["SFR-002", "SFR-003", "SFR-004", "SFR-005", "SFR-016"],
    ["operation_consistency", "application_security"],
    ["write_gate", "remote_security_aggregate"]
  ),
  criterion("PIH-07", ["FR-012", "NFR-011", "SFR-017"], ["sse"], [
    "sse_transport",
    "projection_lifecycle"
  ]),
  criterion("PIH-08", ["NFR-002", "NFR-010", "SFR-017"], ["sse", "shutdown"], [
    "sse_backpressure",
    "projection_lifecycle",
    "application_shutdown"
  ]),
  criterion("PIH-09", ["NFR-001", "PR-002", "SFR-012", "SFR-018"], ["ingress_trust"], [
    "request_trust",
    "remote_security_aggregate"
  ]),
  criterion(
    "PIH-10",
    ["SFR-001", "SFR-002", "SFR-003", "SFR-004", "SFR-007", "SFR-013", "SFR-014", "SFR-018"],
    ["application_security"],
    ["request_authentication", "remote_security_aggregate"]
  ),
  criterion("PIH-11", ["SFR-006", "SFR-007", "SFR-014", "SFR-018"], ["privacy"], [
    "remote_security_aggregate",
    "production_package"
  ]),
  criterion("PIH-12", ["NFR-001", "PR-003", "PR-007", "SFR-008"], ["remote_observation"], [
    "tailscale_observer",
    "remote_lifecycle"
  ]),
  criterion("PIH-13", ["FR-011", "PR-003", "SFR-005", "SFR-008", "SFR-016"], ["remote_control"], [
    "remote_control",
    "tailscale_manager",
    "live_remote_control"
  ]),
  criterion("PIH-14", ["NFR-002", "PR-003", "PR-007", "SFR-008"], ["network_recovery"], [
    "remote_lifecycle",
    "remote_security_aggregate",
    "remote_android_acceptance"
  ]),
  criterion(
    "PIH-15",
    ["FR-017", "IR-006", "IR-008", "NFR-005", "NFR-012", "PR-007"],
    ["compatibility_and_health"],
    ["compatibility_diagnostic", "production_application_smoke"]
  ),
  criterion("PIH-16", ["NFR-005", "NFR-010", "PR-007", "SFR-015"], ["startup"], [
    "application_composition",
    "resource_aggregate",
    "production_application_smoke"
  ]),
  criterion("PIH-17", ["NFR-002", "NFR-010", "SFR-016", "SFR-017"], ["shutdown"], [
    "application_shutdown",
    "resource_aggregate"
  ]),
  criterion("PIH-18", ["FR-011", "NFR-005", "PR-009", "SFR-005", "SFR-008"], ["cli"], [
    "cli_grammar",
    "cli_transport",
    "cli_executable",
    "live_remote_control"
  ]),
  criterion("PIH-19", ["NFR-009", "PR-004", "PR-012"], ["package_and_service"], [
    "production_package",
    "production_foreground"
  ]),
  criterion(
    "PIH-20",
    ["FR-018", "NFR-009", "NFR-010", "PR-008", "PR-012", "SFR-015"],
    ["package_and_service"],
    ["service_lifecycle", "production_service_host", "systemd_units", "service_manager", "clean_user_acceptance"]
  ),
  criterion(
    "PIH-21",
    ["FR-012", "NFR-005", "NFR-010", "NFR-011", "SFR-005", "SFR-017"],
    ["identity_and_composition", "resource_limits", "operation_consistency", "sse"],
    ["resource_aggregate", "remote_security_aggregate", "route_composition"]
  ),
  criterion(
    "PIH-22",
    ["FR-017", "FR-018", "PR-002", "PR-004", "PR-008", "PR-010", "PR-012"],
    ["compatibility_and_health", "package_and_service"],
    ["production_application_smoke", "production_foreground", "production_service_host"]
  ),
  criterion(
    "PIH-23",
    ["NFR-001", "NFR-009", "PR-003", "PR-005", "PR-011", "SFR-001", "SFR-008", "SFR-012", "SFR-018"],
    ["ingress_trust", "network_recovery", "package_and_service"],
    ["clean_user_acceptance", "remote_android_acceptance"]
  ),
  criterion(
    "PIH-24",
    ["NFR-005", "SFR-005", "SFR-006", "SFR-015", "SFR-016"],
    ["privacy", "startup", "shutdown"],
    ["criteria", "ledger_validator", "runtime_boundary"]
  )
] as const);

export function createIfcV1091ProductionInterfaceHardeningLedger(): Readonly<Record<string, unknown>> {
  return deepFreeze({
    schema_version: 1,
    task: "IFC-V1-091",
    criteria: productionInterfaceHardeningCriteria,
    dimensions: productionInterfaceHardeningDimensions,
    evidence: productionInterfaceHardeningEvidence,
    registrations: hostDeckSelectedApiRouteCompositionDescriptor.map((entry) => ({
        id: entry.registrationId,
        surface: entry.surface,
        route_ids: entry.manifestIds
      })),
    requirements: productionInterfaceHardeningRequirementIds,
    routes: selectedApiRouteManifest.map((entry) => ({
        id: entry.id,
        family: entry.family,
        method: entry.method,
        path: entry.path,
        transport: entry.transport,
        owner_task: entry.owner_task
      }))
  });
}

interface EvidenceInput {
  readonly id: string;
  readonly level: "L1" | "L2" | "L3" | "L4";
  readonly path: string;
}

interface AcceptedEvidenceInput extends EvidenceInput {
  readonly task: string;
  readonly task_field: string;
  readonly commit: string;
  readonly commit_field: string;
}

function evidence(id: string, level: EvidenceInput["level"], path: string) {
  return Object.freeze({ id, level, path, disposition: "fresh_required" as const });
}

function acceptedEvidence(input: AcceptedEvidenceInput) {
  return Object.freeze({ ...input, disposition: "accepted_input" as const });
}

function criterion(
  id: ProductionInterfaceHardeningCriterionId,
  requirements: readonly ProductionInterfaceHardeningRequirementId[],
  dimensions: readonly ProductionInterfaceHardeningDimension[],
  evidenceIds: readonly string[]
) {
  return Object.freeze({
    id,
    requirements: Object.freeze([...requirements]),
    dimensions: Object.freeze([...dimensions]),
    evidence_ids: Object.freeze([...evidenceIds])
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
