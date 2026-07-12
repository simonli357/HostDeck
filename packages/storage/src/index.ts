export {
  type AuditEventRepository,
  createAuditEventRepository,
  HostDeckAuditRepositoryError,
  type ListAuditEventsInput
} from "./audit-repository.js";
export {
  type AuthDeviceAuthentication,
  type AuthDeviceRepository,
  type AuthDeviceRepositoryOptions,
  type AuthRepositoryErrorCode,
  type CsrfBootstrapRotation,
  createAuthDeviceRepository,
  createLegacyPairingCodeRepository,
  type HashSecretOptions,
  HostDeckAuthRepositoryError,
  hashSecret,
  type LegacyPairingClaim,
  type LegacyPairingCodeRepository,
  type RotateCsrfBootstrapInput
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
  HostDeckMigrationError,
  type MigrationResult,
  type OpenMigratedDatabaseOptions,
  openMigratedDatabase,
  type RunMigrationsOptions,
  runMigrations
} from "./migration-runner.js";
export {
  defaultMigrations,
  hostDeckAuthDeviceCsrfRotationMigration,
  hostDeckBaseSchemaMigration,
  hostDeckRetentionBoundaryScopeChecksMigration,
  hostDeckSelectedAuditStateMigration,
  hostDeckSelectedPairingClaimMigration,
  hostDeckSelectedRetentionIndexesMigration,
  hostDeckSelectedRuntimeStateMigration,
  hostDeckSessionMetadataFailedStatusMigration,
  type StorageMigration
} from "./migrations.js";
export {
  type CommittedProjectionAppend,
  createProductionProjectionAppendPort,
  HostDeckProjectionPublicationError,
  type ProductionProjectionAppendInput,
  type ProductionProjectionAppendPort,
  type ProductionProjectionAppendPortOptions,
  type ProjectionAppendPublisher,
  type UncommittedManagedSessionProjection,
  type UncommittedSelectedProjectionEvent
} from "./projection-append-port.js";
export {
  type AppendOutputEventInput,
  type AppendOutputEventResult,
  type CleanupRetentionInput,
  createRetentionRepository,
  type GetLatestBoundaryInput,
  HostDeckRetentionRepositoryError,
  type ListOutputReplayInput,
  type OutputReplayResult,
  type RetentionRepository
} from "./retention-repository.js";
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
  createSessionMetadataRepository,
  createSessionRepository,
  HostDeckSessionRepositoryError,
  type SessionMetadataRepository,
  type SessionRepository
} from "./session-repository.js";
export {
  type CreateDefaultSettingsInput,
  createDefaultSettings,
  createSettingsRepository,
  HostDeckSettingsError,
  type SettingsRepository
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
