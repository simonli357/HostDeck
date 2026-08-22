import { deepFreezeExactData } from "@hostdeck/contracts";
export const releaseSecurityReviewCriterionIds = Object.freeze([
  "SPR-01",
  "SPR-02",
  "SPR-03",
  "SPR-04",
  "SPR-05",
  "SPR-06",
  "SPR-07",
  "SPR-08",
  "SPR-09",
  "SPR-10",
  "SPR-11",
  "SPR-12",
  "SPR-13",
  "SPR-14",
  "SPR-15",
  "SPR-16",
  "SPR-17",
  "SPR-18",
  "SPR-19",
  "SPR-20",
  "SPR-21",
  "SPR-22",
  "SPR-23",
  "SPR-24"
] as const);

export type ReleaseSecurityReviewCriterionId =
  (typeof releaseSecurityReviewCriterionIds)[number];

export const releaseSecurityReviewRequirementIds = Object.freeze([
  "NFR-001",
  "NFR-013",
  "SFR-001",
  "SFR-002",
  "SFR-003",
  "SFR-004",
  "SFR-005",
  "SFR-006",
  "SFR-007",
  "SFR-008",
  "SFR-009",
  "SFR-010",
  "SFR-011",
  "SFR-012",
  "SFR-013",
  "SFR-014",
  "SFR-015",
  "SFR-016",
  "SFR-017",
  "SFR-018"
] as const);

export type ReleaseSecurityReviewRequirementId =
  (typeof releaseSecurityReviewRequirementIds)[number];

export const releaseSecurityReviewThreatClasses = Object.freeze([
  "public_network_exposure",
  "proxy_header_spoofing",
  "origin_dns_cors_confusion",
  "application_authorization_bypass",
  "pairing_theft_replay",
  "csrf_cookie_browser_storage",
  "permission_lock_revocation_race",
  "target_replay_audit_contradiction",
  "tailscale_profile_serve_mutation",
  "arbitrary_execution_legacy_bypass",
  "local_permission_secret_retention",
  "resource_exhaustion_slow_client",
  "process_service_persistence",
  "supply_chain_package_tampering",
  "evidence_support_disclosure",
  "compatibility_config_downgrade"
] as const);

export type ReleaseSecurityReviewThreatClass =
  (typeof releaseSecurityReviewThreatClasses)[number];

export const releaseSecurityReviewTrustBoundaries = Object.freeze([
  "release_input_to_verified_package",
  "verified_package_to_current_user_install",
  "local_user_cli_to_loopback_admin",
  "hostdeck_to_codex_unix_socket",
  "tailscale_serve_to_loopback_proxy",
  "unpaired_browser_to_pair_claim",
  "paired_browser_to_protected_api",
  "application_to_local_state_audit",
  "runtime_output_to_ui_evidence_support"
] as const);

export type ReleaseSecurityReviewTrustBoundary =
  (typeof releaseSecurityReviewTrustBoundaries)[number];

export const releaseSecurityReviewEvidence = Object.freeze([
  evidence(
    "criteria",
    "L1",
    "artifacts/rel-v1-005-security-privacy-release-review.md"
  ),
  evidence(
    "ledger_validator",
    "L1",
    "packages/test-fixtures/src/release-security-review.test.ts"
  ),
  evidence("requirements", "L1", "docs/planning/02-requirements.md"),
  evidence(
    "foundation_hardening",
    "L2",
    "artifacts/fnd-v1-092-remote-ingress-hardening.md"
  ),
  evidence(
    "storage_hardening",
    "L2",
    "artifacts/dat-v1-092-remote-storage-hardening.md"
  ),
  evidence(
    "runtime_hardening",
    "L3",
    "artifacts/int-v1-091-selected-runtime-hardening.md"
  ),
  evidence(
    "interface_hardening",
    "L3",
    "artifacts/ifc-v1-091-selected-production-interface-hardening/evidence.json"
  ),
  evidence(
    "route_manifest",
    "L1",
    "packages/server/src/selected-api-route-manifest.contract.test.ts"
  ),
  evidence("request_trust", "L2", "packages/server/src/fastify-request-trust.test.ts"),
  evidence(
    "request_authentication",
    "L2",
    "packages/server/src/fastify-request-authentication.test.ts"
  ),
  evidence(
    "remote_security",
    "L2",
    "packages/server/src/remote-ingress-security-acceptance.test.ts"
  ),
  evidence("write_admission", "L2", "packages/server/src/selected-write-gate.test.ts"),
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
  evidence(
    "resource_stress",
    "L2",
    "tests/production-resource-stress.integration.test.ts"
  ),
  evidence(
    "runtime_boundary",
    "L2",
    "scripts/check-selected-runtime-boundary.test.mjs"
  ),
  evidence(
    "service_lifecycle",
    "L3",
    "artifacts/ifc-v1-057-safe-uninstall-retention.md"
  ),
  evidence("package_contract", "L3", "scripts/production-package.test.mjs"),
  evidence(
    "browser_matrix",
    "L3",
    "artifacts/fe-v1-040-supported-browser-interaction-matrix/manifest.json"
  ),
  evidence("user_guide", "L3", "docs/delivery/08-user-guide.md"),
  evidence("command_reference", "L3", "docs/delivery/11-command-reference.md"),
  evidence("lockfile", "L1", "pnpm-lock.yaml"),
  acceptedEvidence({
    id: "clean_user_acceptance",
    level: "L4",
    path: "artifacts/ifc-v1-058-clean-environment-parity/evidence.json",
    task: "IFC-V1-058",
    taskField: "task_id",
    commit: "eb77647e8b1e77e42b16fef21b65da0d1b65ea8e",
    commitField: "source_commit"
  }),
  acceptedEvidence({
    id: "remote_android_acceptance",
    level: "L4",
    path: "artifacts/ifc-v1-079-device/evidence.json",
    task: "IFC-V1-079",
    taskField: "task",
    commit: "b4078b6d411267dec9701ed5ae67037567a9dee9",
    commitField: "commit"
  }),
  evidence(
    "release_review_evidence",
    "L4",
    "artifacts/rel-v1-005-security-privacy-release-review/evidence.json"
  )
] as const);

export type ReleaseSecurityReviewEvidenceId =
  (typeof releaseSecurityReviewEvidence)[number]["id"];

export const releaseSecurityReviewCriteria = Object.freeze([
  criterion(
    "SPR-01",
    ["NFR-001", "NFR-013"],
    ["evidence_support_disclosure"],
    ["release_input_to_verified_package"],
    ["criteria", "ledger_validator", "requirements"]
  ),
  criterion(
    "SPR-02",
    ["NFR-001", "NFR-013", "SFR-012", "SFR-015"],
    ["supply_chain_package_tampering", "compatibility_config_downgrade"],
    ["release_input_to_verified_package"],
    ["ledger_validator", "route_manifest", "interface_hardening", "lockfile"]
  ),
  criterion(
    "SPR-03",
    ["NFR-001", "SFR-001", "SFR-002", "SFR-012"],
    ["proxy_header_spoofing", "application_authorization_bypass"],
    [
      "local_user_cli_to_loopback_admin",
      "tailscale_serve_to_loopback_proxy",
      "unpaired_browser_to_pair_claim",
      "paired_browser_to_protected_api"
    ],
    ["foundation_hardening", "interface_hardening"]
  ),
  criterion(
    "SPR-04",
    ["NFR-001", "SFR-009", "SFR-012", "SFR-015"],
    ["public_network_exposure", "arbitrary_execution_legacy_bypass"],
    ["hostdeck_to_codex_unix_socket", "tailscale_serve_to_loopback_proxy"],
    ["runtime_boundary", "package_contract", "clean_user_acceptance"]
  ),
  criterion(
    "SPR-05",
    ["SFR-001", "SFR-002", "SFR-012", "SFR-013"],
    ["proxy_header_spoofing", "origin_dns_cors_confusion"],
    ["tailscale_serve_to_loopback_proxy"],
    ["request_trust", "remote_security"]
  ),
  criterion(
    "SPR-06",
    ["SFR-001", "SFR-007", "SFR-012", "SFR-014", "SFR-018"],
    ["origin_dns_cors_confusion", "csrf_cookie_browser_storage"],
    ["tailscale_serve_to_loopback_proxy", "unpaired_browser_to_pair_claim"],
    ["request_trust", "request_authentication", "browser_matrix"]
  ),
  criterion(
    "SPR-07",
    ["SFR-001", "SFR-002", "SFR-007", "SFR-013", "SFR-014", "SFR-018"],
    ["pairing_theft_replay", "csrf_cookie_browser_storage"],
    ["unpaired_browser_to_pair_claim"],
    ["storage_hardening", "request_authentication", "remote_security"]
  ),
  criterion(
    "SPR-08",
    ["SFR-001", "SFR-002", "SFR-010"],
    ["application_authorization_bypass", "permission_lock_revocation_race"],
    ["paired_browser_to_protected_api"],
    ["request_authentication", "write_admission", "remote_security"]
  ),
  criterion(
    "SPR-09",
    ["SFR-002", "SFR-007", "SFR-013", "SFR-014"],
    ["csrf_cookie_browser_storage", "permission_lock_revocation_race"],
    ["paired_browser_to_protected_api", "application_to_local_state_audit"],
    ["storage_hardening", "request_authentication", "browser_matrix"]
  ),
  criterion(
    "SPR-10",
    ["SFR-002", "SFR-004", "SFR-016"],
    ["permission_lock_revocation_race", "target_replay_audit_contradiction"],
    ["local_user_cli_to_loopback_admin", "paired_browser_to_protected_api"],
    ["storage_hardening", "write_admission", "remote_security"]
  ),
  criterion(
    "SPR-11",
    ["SFR-003", "SFR-005", "SFR-010", "SFR-016"],
    ["target_replay_audit_contradiction"],
    ["paired_browser_to_protected_api", "application_to_local_state_audit"],
    ["write_admission", "interface_hardening", "browser_matrix"]
  ),
  criterion(
    "SPR-12",
    ["SFR-002", "SFR-005", "SFR-010", "SFR-016"],
    ["target_replay_audit_contradiction", "compatibility_config_downgrade"],
    ["hostdeck_to_codex_unix_socket", "application_to_local_state_audit"],
    ["runtime_hardening", "write_admission", "interface_hardening"]
  ),
  criterion(
    "SPR-13",
    ["SFR-005", "SFR-008", "SFR-016"],
    ["tailscale_profile_serve_mutation", "target_replay_audit_contradiction"],
    ["local_user_cli_to_loopback_admin", "tailscale_serve_to_loopback_proxy"],
    ["remote_control", "remote_lifecycle", "remote_android_acceptance"]
  ),
  criterion(
    "SPR-14",
    ["NFR-001", "SFR-005", "SFR-008", "SFR-017"],
    ["tailscale_profile_serve_mutation", "resource_exhaustion_slow_client"],
    ["tailscale_serve_to_loopback_proxy"],
    ["remote_control", "remote_lifecycle", "remote_security"]
  ),
  criterion(
    "SPR-15",
    ["SFR-002", "SFR-009", "SFR-010", "SFR-012"],
    ["arbitrary_execution_legacy_bypass", "compatibility_config_downgrade"],
    [
      "local_user_cli_to_loopback_admin",
      "hostdeck_to_codex_unix_socket",
      "paired_browser_to_protected_api"
    ],
    ["route_manifest", "runtime_boundary", "package_contract"]
  ),
  criterion(
    "SPR-16",
    ["NFR-013", "SFR-006", "SFR-015"],
    ["local_permission_secret_retention", "process_service_persistence"],
    [
      "verified_package_to_current_user_install",
      "hostdeck_to_codex_unix_socket",
      "application_to_local_state_audit"
    ],
    ["storage_hardening", "service_lifecycle", "clean_user_acceptance"]
  ),
  criterion(
    "SPR-17",
    ["NFR-013", "SFR-006", "SFR-007", "SFR-014", "SFR-018"],
    ["local_permission_secret_retention", "evidence_support_disclosure"],
    ["application_to_local_state_audit", "runtime_output_to_ui_evidence_support"],
    ["storage_hardening", "interface_hardening", "release_review_evidence"]
  ),
  criterion(
    "SPR-18",
    ["SFR-005", "SFR-013", "SFR-017"],
    ["resource_exhaustion_slow_client"],
    ["tailscale_serve_to_loopback_proxy", "paired_browser_to_protected_api"],
    ["resource_stress", "remote_security", "interface_hardening"]
  ),
  criterion(
    "SPR-19",
    ["NFR-013", "SFR-015", "SFR-017"],
    ["process_service_persistence", "local_permission_secret_retention"],
    ["verified_package_to_current_user_install", "hostdeck_to_codex_unix_socket"],
    ["service_lifecycle", "clean_user_acceptance"]
  ),
  criterion(
    "SPR-20",
    ["NFR-001", "NFR-013", "SFR-006", "SFR-015"],
    ["supply_chain_package_tampering", "local_permission_secret_retention"],
    ["release_input_to_verified_package", "verified_package_to_current_user_install"],
    ["lockfile", "package_contract", "release_review_evidence"]
  ),
  criterion(
    "SPR-21",
    ["SFR-002", "SFR-005", "SFR-009", "SFR-010"],
    ["compatibility_config_downgrade", "arbitrary_execution_legacy_bypass"],
    ["release_input_to_verified_package", "hostdeck_to_codex_unix_socket"],
    ["runtime_hardening", "interface_hardening", "runtime_boundary"]
  ),
  criterion(
    "SPR-22",
    [
      "NFR-001",
      "NFR-013",
      "SFR-001",
      "SFR-002",
      "SFR-004",
      "SFR-008",
      "SFR-011",
      "SFR-012",
      "SFR-018"
    ],
    [
      "public_network_exposure",
      "application_authorization_bypass",
      "tailscale_profile_serve_mutation"
    ],
    [
      "verified_package_to_current_user_install",
      "tailscale_serve_to_loopback_proxy",
      "paired_browser_to_protected_api"
    ],
    ["clean_user_acceptance", "remote_android_acceptance"]
  ),
  criterion(
    "SPR-23",
    ["NFR-001", "SFR-001", "SFR-005", "SFR-006", "SFR-008", "SFR-018"],
    ["pairing_theft_replay", "evidence_support_disclosure"],
    ["local_user_cli_to_loopback_admin", "runtime_output_to_ui_evidence_support"],
    ["user_guide", "command_reference", "remote_android_acceptance"]
  ),
  criterion(
    "SPR-24",
    ["NFR-001", "NFR-013", "SFR-005", "SFR-006", "SFR-016"],
    ["evidence_support_disclosure", "supply_chain_package_tampering"],
    ["release_input_to_verified_package", "runtime_output_to_ui_evidence_support"],
    ["criteria", "ledger_validator", "release_review_evidence"]
  )
] as const);

export function createReleaseSecurityReviewLedger(): Readonly<Record<string, unknown>> {
  return deepFreezeExactData({
    schema_version: 1,
    task: "REL-V1-005",
    criteria: releaseSecurityReviewCriteria,
    requirements: [...releaseSecurityReviewRequirementIds],
    threat_classes: [...releaseSecurityReviewThreatClasses],
    trust_boundaries: [...releaseSecurityReviewTrustBoundaries],
    evidence: releaseSecurityReviewEvidence
  });
}

interface EvidenceInput {
  readonly id: string;
  readonly level: "L1" | "L2" | "L3" | "L4";
  readonly path: string;
}

interface AcceptedEvidenceInput extends EvidenceInput {
  readonly task: string;
  readonly taskField: string;
  readonly commit: string;
  readonly commitField: string;
}

function evidence(id: string, level: EvidenceInput["level"], path: string) {
  return Object.freeze({
    id,
    level,
    path,
    disposition: "fresh_required" as const
  });
}

function acceptedEvidence(input: AcceptedEvidenceInput) {
  return Object.freeze({
    id: input.id,
    level: input.level,
    path: input.path,
    disposition: "accepted_input" as const,
    task: input.task,
    task_field: input.taskField,
    commit: input.commit,
    commit_field: input.commitField
  });
}

function criterion(
  id: ReleaseSecurityReviewCriterionId,
  requirements: readonly ReleaseSecurityReviewRequirementId[],
  threatClasses: readonly ReleaseSecurityReviewThreatClass[],
  trustBoundaries: readonly ReleaseSecurityReviewTrustBoundary[],
  evidenceIds: readonly ReleaseSecurityReviewEvidenceId[]
) {
  return Object.freeze({
    id,
    requirements: Object.freeze([...requirements]),
    threat_classes: Object.freeze([...threatClasses]),
    trust_boundaries: Object.freeze([...trustBoundaries]),
    evidence_ids: Object.freeze([...evidenceIds])
  });
}

