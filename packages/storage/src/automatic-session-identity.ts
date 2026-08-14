import {
  nativeCodexThreadIdSchema,
  sessionIdSchema,
  sessionNameSchema,
  sharedCodexRuntimeContractLimits
} from "@hostdeck/contracts";

export type AutomaticSessionIdentityErrorCode = "invalid_native_thread_id" | "invalid_project_cue";

export class HostDeckAutomaticSessionIdentityError extends Error {
  constructor(
    readonly code: AutomaticSessionIdentityErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostDeckAutomaticSessionIdentityError";
  }
}

export interface AutomaticSessionIdentity {
  readonly alias: ReturnType<typeof sessionNameSchema.parse>;
  readonly internal_session_id: ReturnType<typeof sessionIdSchema.parse>;
}

const nativeIdHexLength = 32;
const aliasSeparatorLength = 1;
const maximumAliasLength = 64;
const maximumAliasCueLength = maximumAliasLength - aliasSeparatorLength - nativeIdHexLength;

export function deriveAutomaticSessionIdentity(
  nativeThreadId: string,
  projectCue: string
): AutomaticSessionIdentity {
  const nativeId = nativeCodexThreadIdSchema.safeParse(nativeThreadId);
  if (!nativeId.success) {
    throw new HostDeckAutomaticSessionIdentityError(
      "invalid_native_thread_id",
      "Automatic session identity requires one canonical native Codex UUID.",
      { cause: nativeId.error }
    );
  }
  if (
    projectCue.length < 1 ||
    projectCue.length > sharedCodexRuntimeContractLimits.projectCueLength ||
    projectCue.trim().length === 0
  ) {
    throw new HostDeckAutomaticSessionIdentityError(
      "invalid_project_cue",
      "Automatic session identity requires one bounded non-empty project cue."
    );
  }

  const nativeHex = String(nativeId.data).replaceAll("-", "");
  const normalizedCue = projectCue
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  const boundedCue = normalizedCue.slice(0, maximumAliasCueLength).replace(/-+$/gu, "") || "codex";

  return Object.freeze({
    alias: sessionNameSchema.parse(`${boundedCue}-${nativeHex}`),
    internal_session_id: sessionIdSchema.parse(`sess_${nativeHex}`)
  });
}
