import { randomBytes, randomInt } from "node:crypto";
import { closeSync } from "node:fs";
import type { AuditEventRecord, PairingCodeRecord } from "@hostdeck/contracts";
import {
  createAuditEventRepository,
  createLegacyPairingCodeRepository,
  createSettingsRepository,
  HostDeckAuthRepositoryError,
  HostDeckLocalPathError,
  openMigratedDatabase,
  openSecureHostDeckRegularFile,
  prepareHostDeckStatePaths
} from "@hostdeck/storage";
import { configFailure, internalFailure } from "./errors.js";

export interface CreateLocalAdminOptions {
  readonly stateDir: string;
  readonly databasePath: string;
  readonly now?: () => Date;
  readonly makePairingCode?: () => string;
  readonly makePairingId?: () => string;
  readonly makeAuditEventId?: () => string;
  readonly prepareStatePaths?: typeof prepareHostDeckStatePaths;
}

export interface LocalAdmin {
  readonly createPairingCode: (input: CreatePairingCommandInput) => PairingCommandResult;
  readonly setLock: (input: SetLockCommandInput) => LockCommandResult;
}

export interface CreatePairingCommandInput {
  readonly permission: PairingCodeRecord["permission"];
  readonly ttlMinutes: number;
  readonly label?: string;
}

export interface SetLockCommandInput {
  readonly locked: boolean;
  readonly reason?: string;
}

export interface PairingCommandResult {
  readonly pairing_id: string;
  readonly code: string;
  readonly permission: PairingCodeRecord["permission"];
  readonly client_label: string | null;
  readonly created_at: string;
  readonly expires_at: string;
  readonly audit_event_id: string;
}

export interface LockCommandResult {
  readonly locked: boolean;
  readonly updated_at: string;
  readonly audit_event_id: string;
}

type OpenedDatabase = ReturnType<typeof openMigratedDatabase>["db"];

interface LocalAdminRepos {
  readonly db: OpenedDatabase;
  readonly pairingCodes: ReturnType<typeof createLegacyPairingCodeRepository>;
  readonly settings: ReturnType<typeof createSettingsRepository>;
  readonly auditEvents: ReturnType<typeof createAuditEventRepository>;
}

const localAdminActor: AuditEventRecord["actor"] = {
  type: "cli",
  client_id: "local_admin",
  permission: "write"
};
const maxPairingCreateAttempts = 5;

export function createLocalAdmin(options: CreateLocalAdminOptions): LocalAdmin {
  const now = options.now ?? (() => new Date());

  return {
    createPairingCode(input) {
      assertPairingTtl(input.ttlMinutes);

      for (let attempt = 0; attempt < maxPairingCreateAttempts; attempt += 1) {
        const createdAt = now();
        const expiresAt = new Date(createdAt.getTime() + input.ttlMinutes * 60_000);
        const rawCode = (options.makePairingCode ?? makePairingCode)();
        const pairingId = (options.makePairingId ?? makePairingId)();
        const auditEventId = (options.makeAuditEventId ?? makeAuditEventId)();

        try {
          return withLocalAdminRepos(options, now, (repos) => {
            const transaction = repos.db.transaction(() => {
              const pairingCode = repos.pairingCodes.createLegacy({
                id: pairingId,
                rawCode,
                permission: input.permission,
                clientLabel: input.label ?? null,
                createdAt,
                expiresAt
              });
              const auditEvent = repos.auditEvents.append({
                id: auditEventId,
                at: createdAt.toISOString(),
                actor: localAdminActor,
                action: "pair",
                session_id: null,
                payload_summary: {
                  permission: input.permission,
                  client_label: input.label ?? null,
                  ttl_minutes: input.ttlMinutes,
                  expires_at: expiresAt.toISOString()
                },
                result: "succeeded",
                error_code: null
              });

              return {
                pairing_id: pairingCode.id,
                code: rawCode,
                permission: pairingCode.permission,
                client_label: pairingCode.client_label,
                created_at: pairingCode.created_at,
                expires_at: pairingCode.expires_at,
                audit_event_id: auditEvent.id
              };
            });

            return transaction();
          });
        } catch (error) {
          if (isPairingCollision(error) && attempt < maxPairingCreateAttempts - 1) {
            continue;
          }

          throw error;
        }
      }

      throw internalFailure("Unable to create a unique HostDeck pairing code.");
    },
    setLock(input) {
      const at = now();
      return withLocalAdminRepos(options, now, (repos) => {
        const transaction = repos.db.transaction(() => {
          const settings = repos.settings.setLocked(input.locked, { now: () => at });
          const auditEvent = repos.auditEvents.append({
            id: (options.makeAuditEventId ?? makeAuditEventId)(),
            at: at.toISOString(),
            actor: localAdminActor,
            action: input.locked ? "lock" : "unlock",
            session_id: null,
            payload_summary: {
              locked: input.locked,
              reason: input.reason ?? null
            },
            result: "succeeded",
            error_code: null
          });

          return {
            locked: settings.locked,
            updated_at: settings.updated_at,
            audit_event_id: auditEvent.id
          };
        });

        return transaction();
      });
    }
  };
}

function withLocalAdminRepos<T>(options: CreateLocalAdminOptions, now: () => Date, work: (repos: LocalAdminRepos) => T): T {
  let paths: ReturnType<typeof prepareHostDeckStatePaths>;
  try {
    paths = (options.prepareStatePaths ?? prepareHostDeckStatePaths)({
      state_dir: options.stateDir,
      database_path: options.databasePath
    });
  } catch (error) {
    throw configFailure(`HostDeck state directory or database path is not secure: ${options.stateDir}.`, "state_dir", error);
  }
  let databaseGuard: ReturnType<typeof openSecureHostDeckRegularFile>;
  try {
    databaseGuard = openSecureHostDeckRegularFile(paths.database_path, {
      label: "database",
      mode: 0o600,
      repair_mode: true
    });
  } catch (error) {
    throw configFailure("HostDeck database path changed or became insecure before open.", "database_path", error);
  }
  let opened: ReturnType<typeof openMigratedDatabase> | null = null;
  try {
    opened = openMigratedDatabase(paths.database_path, { now });
    databaseGuard.verifyPath();
  } catch (error) {
    const cleanupErrors = closeLocalAdminValidationResources(opened, databaseGuard.descriptor);
    const cause = cleanupErrors.length === 0 ? error : new AggregateError([error, ...cleanupErrors], "Database open and validation cleanup failed.");
    if (error instanceof HostDeckLocalPathError) {
      throw configFailure("HostDeck database path changed or became insecure during open.", "database_path", cause);
    }
    if (cleanupErrors.length > 0) throw cause;
    throw error;
  }
  try {
    closeSync(databaseGuard.descriptor);
  } catch (error) {
    const cleanupErrors = closeLocalAdminValidationResources(opened, null);
    throw configFailure(
      "HostDeck database validation descriptor could not be closed.",
      "database_path",
      cleanupErrors.length === 0 ? error : new AggregateError([error, ...cleanupErrors], "Database validation close failed.")
    );
  }

  try {
    const repos = {
      db: opened.db,
      pairingCodes: createLegacyPairingCodeRepository(opened.db),
      settings: createSettingsRepository(opened.db),
      auditEvents: createAuditEventRepository(opened.db)
    };
    repos.settings.getOrCreateDefault({
      stateDir: options.stateDir,
      now
    });

    return work(repos);
  } finally {
    opened.db.close();
  }
}

function closeLocalAdminValidationResources(
  opened: ReturnType<typeof openMigratedDatabase> | null,
  descriptor: number | null
): unknown[] {
  const errors: unknown[] = [];
  try {
    opened?.db.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    if (descriptor !== null) closeSync(descriptor);
  } catch (error) {
    errors.push(error);
  }
  return errors;
}

function assertPairingTtl(ttlMinutes: number): void {
  if (!Number.isSafeInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 1440) {
    throw configFailure("Pairing code TTL must be between 1 and 1440 minutes.", "--ttl-minutes");
  }
}

function isPairingCollision(error: unknown): boolean {
  return error instanceof HostDeckAuthRepositoryError && error.code === "pairing_code_exists";
}

function makePairingCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function makePairingId(): string {
  return `pair_${randomBytes(10).toString("hex")}`;
}

function makeAuditEventId(): string {
  return `audit_${randomBytes(10).toString("hex")}`;
}
