import { randomBytes, randomInt } from "node:crypto";
import { accessSync, constants as fsConstants, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { AuditEventRecord, PairingCodeRecord, SettingsRecord } from "@hostdeck/contracts";
import {
  createAuditEventRepository,
  createPairingCodeRepository,
  createSettingsRepository,
  HostDeckAuthRepositoryError,
  openMigratedDatabase
} from "@hostdeck/storage";
import { configFailure, internalFailure } from "./errors.js";

export interface CreateLocalAdminOptions {
  readonly stateDir: string;
  readonly databasePath: string;
  readonly now?: () => Date;
  readonly makePairingCode?: () => string;
  readonly makePairingId?: () => string;
  readonly makeAuditEventId?: () => string;
  readonly ensureStateDirectory?: (stateDir: string, databasePath: string) => void;
}

export interface LocalAdmin {
  readonly createPairingCode: (input: CreatePairingCommandInput) => PairingCommandResult;
  readonly setLock: (input: SetLockCommandInput) => LockCommandResult;
  readonly setLanEnabled: (input: SetLanCommandInput) => LanCommandResult;
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

export interface SetLanCommandInput {
  readonly enabled: boolean;
  readonly bindHost?: string;
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

export interface LanCommandResult {
  readonly lan_enabled: boolean;
  readonly bind_mode: SettingsRecord["bind_mode"];
  readonly bind_host: string;
  readonly bind_port: number;
  readonly updated_at: string;
  readonly audit_event_id: string;
}

type OpenedDatabase = ReturnType<typeof openMigratedDatabase>["db"];

interface LocalAdminRepos {
  readonly db: OpenedDatabase;
  readonly pairingCodes: ReturnType<typeof createPairingCodeRepository>;
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
              const pairingCode = repos.pairingCodes.create({
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
    },
    setLanEnabled(input) {
      const at = now();
      return withLocalAdminRepos(options, now, (repos) => {
        const transaction = repos.db.transaction(() => {
          const settings = repos.settings.setLanEnabled(input.enabled, {
            ...(input.bindHost !== undefined ? { bindHost: input.bindHost } : {}),
            now: () => at
          });
          const auditEvent = repos.auditEvents.append({
            id: (options.makeAuditEventId ?? makeAuditEventId)(),
            at: at.toISOString(),
            actor: localAdminActor,
            action: input.enabled ? "lan_enable" : "lan_disable",
            session_id: null,
            payload_summary: {
              lan_enabled: settings.lan_enabled,
              bind_mode: settings.bind_mode,
              bind_host: settings.bind_host,
              bind_port: settings.bind_port,
              restart_required: true
            },
            result: "succeeded",
            error_code: null
          });

          return {
            lan_enabled: settings.lan_enabled,
            bind_mode: settings.bind_mode,
            bind_host: settings.bind_host,
            bind_port: settings.bind_port,
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
  (options.ensureStateDirectory ?? ensureUsableStatePaths)(options.stateDir, options.databasePath);
  const opened = openMigratedDatabase(options.databasePath, { now });

  try {
    const repos = {
      db: opened.db,
      pairingCodes: createPairingCodeRepository(opened.db),
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

function ensureUsableStatePaths(stateDir: string, databasePath: string): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    const state = statSync(stateDir);

    if (!state.isDirectory()) {
      throw new Error("State path is not a directory.");
    }

    accessSync(stateDir, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
    mkdirSync(dirname(databasePath), { recursive: true });

    try {
      const database = statSync(databasePath);

      if (database.isDirectory()) {
        throw new Error("Database path is a directory.");
      }
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }

    accessSync(dirname(databasePath), fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
  } catch (_error) {
    throw configFailure(`HostDeck state directory or database path is not usable: ${stateDir}.`, "state_dir");
  }
}

function assertPairingTtl(ttlMinutes: number): void {
  if (!Number.isSafeInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 1440) {
    throw configFailure("Pairing code TTL must be between 1 and 1440 minutes.", "--ttl-minutes");
  }
}

function isPairingCollision(error: unknown): boolean {
  return error instanceof HostDeckAuthRepositoryError && error.code === "pairing_code_exists";
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
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
