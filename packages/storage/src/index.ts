export {
  type AuditEventRepository,
  createAuditEventRepository,
  HostDeckAuditRepositoryError,
  type ListAuditEventsInput
} from "./audit-repository.js";
export {
  type AuthDeviceAuthentication,
  type AuthDeviceRepository,
  createAuthDeviceRepository,
  createPairingCodeRepository,
  type HashSecretOptions,
  HostDeckAuthRepositoryError,
  hashSecret,
  type PairingClaim,
  type PairingCodeRepository
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
  hostDeckBaseSchemaMigration,
  hostDeckRetentionBoundaryScopeChecksMigration,
  hostDeckSelectedAuditStateMigration,
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
  type SelectedAuditRepository,
  type SelectedAuditRepositoryErrorCode
} from "./selected-audit-repository.js";
export {
  type AppendSelectedEventResult,
  createSelectedStateRepository,
  HostDeckSelectedStateRepositoryError,
  type ListSelectedEventsInput,
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
