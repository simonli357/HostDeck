export {
  type AuthDeviceAuthentication,
  type AuthDeviceRepository,
  type AuthorizeSelectedBrowserWriteInput,
  type AuthRepositoryErrorCode,
  type CsrfBootstrapRotation,
  createAuthDeviceRepository,
  createSelectedCsrfAuthorizationRepository,
  type HashSecretOptions,
  HostDeckAuthRepositoryError,
  hashSecret,
  type RotateSelectedCsrfBootstrapInput,
  type SelectedCsrfAuthorizationRepository,
  type SelectedCsrfAuthorizationRepositoryOptions
} from "./auth-repository.js";
export {
  type CaptureGitBranchMetadataInput,
  captureGitBranchMetadata,
  type GitBranchMetadataErrorCode,
  type GitExecFile,
  type GitExecFileOptions,
  HostDeckGitBranchMetadataError
} from "./branch-metadata.js";
export {
  type AcquireHostDeckDaemonLeaseInput,
  acquireHostDeckDaemonLease,
  type HostDeckDaemonLease,
  HostDeckDaemonLeaseError,
  type HostDeckDaemonLeaseErrorCode
} from "./daemon-lease.js";
export {
  createLegacySessionRepository,
  HostDeckLegacySessionRepositoryError,
  type LegacySessionRepository,
  type LegacySessionRepositoryErrorCode,
  type LegacySessionResetResult,
  type LegacySessionSummary
} from "./legacy-session-repository.js";
export {
  HostDeckMigrationError,
  type MigrationResult,
  type OpenMigratedDatabaseOptions,
  openMigratedDatabase,
  type RunMigrationsOptions,
  runMigrations
} from "./migration-runner.js";
export {
  defaultMigrations,
  type StorageMigration
} from "./migrations.js";
export {
  type CommittedProjectionAppend,
  createProductionProjectionAppendPort,
  createProductionProjectionContinuityPort,
  HostDeckProjectionPublicationError,
  type ProductionProjectionAppendInput,
  type ProductionProjectionAppendPort,
  type ProductionProjectionAppendPortOptions,
  type ProductionProjectionContinuityInput,
  type ProductionProjectionContinuityPort,
  type ProductionProjectionContinuityPortOptions,
  type ProjectionAppendPublisher,
  type ProjectionContinuityBoundaryReason,
  type UncommittedManagedSessionProjection,
  type UncommittedSelectedProjectionEvent
} from "./projection-append-port.js";
export {
  assertRemoteIngressAdmissionProofRepository,
  createRemoteIngressAdmissionProofRepository,
  HostDeckRemoteIngressAdmissionProofRepositoryError,
  hostDeckRemoteIngressAdmissionProofId,
  type RemoteIngressAdmissionProofRepository,
  type RemoteIngressAdmissionProofRepositoryErrorCode,
  type RemoteIngressAdmissionProofWriteReceipt
} from "./remote-ingress-admission-proof-repository.js";
export {
  assertRemoteIngressStateRepository,
  type CompareAndSetRemoteIngressStateInput,
  createRemoteIngressStateRepository,
  HostDeckRemoteIngressStateRepositoryError,
  hostDeckRemoteIngressStateId,
  type RemoteIngressStateRepository,
  type RemoteIngressStateRepositoryErrorCode,
  type RemoteIngressStateWriteReceipt
} from "./remote-ingress-state-repository.js";
export {
  createRuntimeCompatibilityRepository,
  HostDeckRuntimeCompatibilityRepositoryError,
  type RuntimeCompatibilityRepository,
  type RuntimeCompatibilityRepositoryErrorCode
} from "./runtime-compatibility-repository.js";
export {
  HostDeckLocalPathError,
  type HostDeckLocalPathErrorCode,
  type HostDeckPathModeRepair,
  type OpenedSecureHostDeckRegularFile,
  type OpenSecureHostDeckRegularFileOptions,
  openSecureHostDeckRegularFile,
  type PreparedHostDeckLocalPaths,
  type PreparedHostDeckStatePaths,
  type PrepareHostDeckLocalPathsInput,
  prepareHostDeckDaemonLeasePath,
  prepareHostDeckLocalPaths,
  prepareHostDeckLocalPathsAfterLease,
  prepareHostDeckStatePaths,
  type ResolvedHostDeckLocalPaths,
  resolveHostDeckLocalPaths,
  type SecureHostDeckRegularFileOptions,
  type SecureHostDeckSocketOptions,
  secureHostDeckRegularFile,
  secureHostDeckSocket
} from "./secure-local-paths.js";
export {
  createHistoricalSelectedNetworkAuditRepository,
  createSelectedAuditRepository,
  HostDeckSelectedAuditRepositoryError,
  maintainSelectedAuditRetentionBatch,
  reconcileSelectedAuditOrphansBatch,
  type SelectedAuditOrphanReconciliationBatchInput,
  type SelectedAuditOrphanReconciliationBatchResult,
  type SelectedAuditRepository,
  type SelectedAuditRepositoryErrorCode,
  type SelectedAuditRetentionBatchInput,
  type SelectedAuditRetentionBatchResult
} from "./selected-audit-repository.js";
export {
  createDeviceListingRepository,
  type DeviceListingRepository
} from "./selected-device-listing-repository.js";
export {
  createDeviceRevocationRepository,
  type DeviceRevocationRepository,
  type RevokeSelectedDeviceInput
} from "./selected-device-revocation-repository.js";
export {
  type ClaimSelectedPairingCodeInput,
  createPairingCodeRepository,
  type IssuedPairingCode,
  type IssuePairingCodeInput,
  type PairingClaimRateSnapshot,
  type PairingCodeRepository,
  type PairingCodeRepositoryOptions,
  type SelectedPairingClaim
} from "./selected-pairing-repository.js";
export {
  createSelectedSessionReadRepository,
  HostDeckSelectedSessionReadRepositoryError,
  type SelectedSessionReadRepository,
  type SelectedSessionReadRepositoryErrorCode
} from "./selected-session-read-repository.js";
export {
  type AppendSelectedEventResult,
  createSelectedStateRepository,
  HostDeckSelectedStateRepositoryError,
  type ListSelectedEventsInput,
  maintainSelectedProjectionRetentionBatch,
  type SelectedProjectionRetentionBatchInput,
  type SelectedProjectionRetentionBatchResult,
  type SelectedSessionState,
  type SelectedStateRepository,
  type SelectedStateRepositoryErrorCode,
  type SelectedStateRevision,
  selectedProjectedEventByteLength,
  selectedStateRevision
} from "./selected-state-repository.js";
export {
  type CreateDefaultSettingsInput,
  createDefaultSettings,
  createSettingsRepository,
  type HostDeckLockState,
  type HostDeckLockTransitionReceipt,
  HostDeckSettingsError,
  type SettingsRepository,
  type TransitionHostDeckLockInput
} from "./settings-repository.js";
export {
  HostDeckStartupAuditOrphanReconciliationError,
  type RunStartupAuditOrphanReconciliationInput,
  runStartupAuditOrphanReconciliation,
  type StartupAuditOrphanReconciliationErrorCode,
  type StartupAuditOrphanReconciliationFailure,
  type StartupAuditOrphanReconciliationReason,
  type StartupAuditOrphanReconciliationResult
} from "./startup-audit-orphan-reconciliation.js";
export {
  HostDeckStartupRetentionMaintenanceError,
  type RunStartupRetentionMaintenanceInput,
  runStartupRetentionMaintenance,
  type StartupRetentionAuditResult,
  type StartupRetentionDegradedReason,
  type StartupRetentionFailure,
  type StartupRetentionFailureScope,
  type StartupRetentionMaintenanceErrorCode,
  type StartupRetentionMaintenanceResult,
  type StartupRetentionOutputResult
} from "./startup-retention-maintenance.js";
