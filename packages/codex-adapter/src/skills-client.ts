import {
  absoluteCwdSchema,
  defaultResourceBudget,
  isoTimestampSchema,
  type RuntimeCompatibility,
  resourceBudgetDefinitionByKey,
  type SkillSummary,
  type SkillsSnapshot,
  skillSummarySchema
} from "@hostdeck/contracts";
import type { AbsoluteCwd, IsoTimestamp } from "@hostdeck/core";
import type { CodexRequestInput } from "./broker.js";
import { HostDeckCodexAdapterError } from "./errors.js";
import type { SkillsListParams } from "./generated/v2/SkillsListParams.js";

export interface CodexSkillsListInput {
  readonly cwd: AbsoluteCwd | string;
  readonly signal?: AbortSignal;
}

export interface CodexSkillsListing {
  readonly runtime_version: string;
  readonly connection_generation: number;
  readonly observed_at: IsoTimestamp;
  readonly state: SkillsSnapshot["state"];
  readonly skills: readonly SkillSummary[];
  readonly error_count: number;
}

export interface CodexSkillsRequestPort {
  readonly compatibility: RuntimeCompatibility;
  readonly generation: number;
  readonly request: (input: CodexRequestInput) => Promise<unknown>;
}

export interface CodexSkillsClientOptions {
  readonly max_entries_per_cwd?: number;
  readonly max_errors_per_cwd?: number;
  readonly max_dependencies_per_skill?: number;
  readonly read_timeout_ms?: number;
  readonly now?: () => string;
}

export interface CodexSkillsClient {
  readonly runtime_version: string;
  readonly connection_generation: number;
  readonly listForCwd: (input: CodexSkillsListInput) => Promise<CodexSkillsListing>;
}

interface ParsedOptions {
  readonly max_entries_per_cwd: number;
  readonly max_errors_per_cwd: number;
  readonly max_dependencies_per_skill: number;
  readonly read_timeout_ms: number;
  readonly now: () => string;
}

const skillRequiredKeys = ["description", "enabled", "name", "path", "scope"] as const;
const skillOptionalKeys = ["dependencies", "interface", "shortDescription"] as const;
const interfaceKeys = [
  "brandColor",
  "defaultPrompt",
  "displayName",
  "iconLarge",
  "iconSmall",
  "shortDescription"
] as const;
const dependencyRequiredKeys = ["type", "value"] as const;
const dependencyOptionalKeys = ["command", "description", "transport", "url"] as const;
const skillScopes = new Set(["user", "repo", "system", "admin"]);

const rawLimits = {
  name: 160,
  description: 4_096,
  path: 4_096,
  interfaceName: 160,
  interfaceDescription: 512,
  interfaceColor: 64,
  prompt: 20_000,
  dependencyField: 4_096,
  dependencyCommand: 20_000,
  errorMessage: 4_096
} as const;

export function createCodexSkillsClient(
  port: CodexSkillsRequestPort,
  options: CodexSkillsClientOptions = {}
): CodexSkillsClient {
  const implementation = new DefaultCodexSkillsClient(parsePort(port), parseOptions(options));
  return Object.freeze({
    listForCwd: (input: CodexSkillsListInput) => implementation.listForCwd(input),
    get runtime_version() {
      return implementation.runtime_version;
    },
    get connection_generation() {
      return implementation.connection_generation;
    }
  });
}

class DefaultCodexSkillsClient implements CodexSkillsClient {
  constructor(
    private readonly port: CodexSkillsRequestPort,
    private readonly options: ParsedOptions
  ) {}

  get runtime_version(): string {
    const compatibility = this.port.compatibility;
    const capability = compatibility.capabilities.find((candidate) => candidate.name === "skills");
    if (capability?.state === "unavailable") {
      throw adapterError(
        "unsupported_method",
        "The connected Codex runtime does not support structured skills listing.",
        "not_sent",
        false
      );
    }
    if (
      capability?.state !== "available" ||
      !["degraded", "ready"].includes(compatibility.state) ||
      compatibility.observed_version === null ||
      compatibility.binding_id === null
    ) {
      throw adapterError(
        "handshake_failed",
        "Codex skills listing requires a connected compatible runtime.",
        "not_sent",
        true
      );
    }
    return compatibility.observed_version;
  }

  get connection_generation(): number {
    return parseGeneration(this.port.generation, "not_sent");
  }

  async listForCwd(input: CodexSkillsListInput): Promise<CodexSkillsListing> {
    const runtimeVersion = this.runtime_version;
    const generation = this.connection_generation;
    const parsedInput = parseInput(input);
    const params = { cwds: [parsedInput.cwd], forceReload: true } satisfies SkillsListParams;
    const result = await this.port.request({
      method: "skills/list",
      params,
      kind: "read",
      timeout_ms: this.options.read_timeout_ms,
      ...(parsedInput.signal === undefined ? {} : { signal: parsedInput.signal })
    });
    const currentGeneration = this.port.generation;
    if (!Number.isSafeInteger(currentGeneration) || currentGeneration < 1 || currentGeneration !== generation) {
      throw adapterError(
        "transport_closed",
        "Codex connection changed while the skills listing was in flight.",
        "not_applicable",
        true
      );
    }
    const parsed = parseResponse(result, parsedInput.cwd, this.options);
    return deepFreeze({
      runtime_version: runtimeVersion,
      connection_generation: generation,
      observed_at: parseClock(this.options.now()),
      ...parsed
    });
  }
}

function parseResponse(
  candidate: unknown,
  expectedCwd: AbsoluteCwd,
  options: ParsedOptions
): Pick<CodexSkillsListing, "state" | "skills" | "error_count"> {
  const response = requireResponseRecord(candidate, "Codex skills/list result must be an object.");
  assertExactKeys(response, ["data"], "Codex skills/list response fields are invalid.");
  if (!Array.isArray(response.data) || response.data.length !== 1) {
    throw invalidPayload("Codex skills/list must return exactly one selected-cwd entry.");
  }
  const entry = requireResponseRecord(response.data[0], "Codex skills/list entry must be an object.");
  assertExactKeys(entry, ["cwd", "errors", "skills"], "Codex skills/list entry fields are invalid.");
  const cwd = parseAbsolutePath(entry.cwd, "Codex skills/list response cwd");
  if (cwd !== expectedCwd) throw invalidPayload("Codex skills/list response changed the exact selected cwd.");
  if (!Array.isArray(entry.skills)) throw invalidPayload("Codex skills/list skills must be an array.");
  if (entry.skills.length > options.max_entries_per_cwd) {
    throw capacityError("Codex skills/list exceeded the configured per-cwd skill ceiling.");
  }
  if (!Array.isArray(entry.errors)) throw invalidPayload("Codex skills/list errors must be an array.");
  if (entry.errors.length > options.max_errors_per_cwd) {
    throw capacityError("Codex skills/list exceeded the configured per-cwd error ceiling.");
  }

  const skills = entry.skills.map((skill) => parseSkill(skill, options.max_dependencies_per_skill));
  for (const error of entry.errors) validateSkillError(error);
  skills.sort(compareSkillNames);
  if (new Set(skills.map((skill) => skill.name)).size !== skills.length) {
    throw invalidPayload("Codex skills/list returned duplicate public skill names.");
  }
  const errorCount = entry.errors.length;
  const state: SkillsSnapshot["state"] =
    skills.length === 0 ? (errorCount === 0 ? "empty" : "error") : errorCount === 0 ? "content" : "partial";
  return { state, skills: Object.freeze(skills), error_count: errorCount };
}

function parseSkill(candidate: unknown, maximumDependencies: number): SkillSummary {
  const skill = requireResponseRecord(candidate, "Codex skill metadata must be an object.");
  assertRequiredAndOptionalKeys(
    skill,
    skillRequiredKeys,
    skillOptionalKeys,
    "Codex skill metadata fields are invalid."
  );
  const name = parseText(skill.name, "Codex skill name", rawLimits.name, false, true);
  const description = parseText(skill.description, "Codex skill description", rawLimits.description, true, false);
  parseAbsolutePath(skill.path, "Codex skill path");
  if (typeof skill.scope !== "string" || !skillScopes.has(skill.scope)) {
    throw invalidPayload("Codex skill scope is unsupported.");
  }
  if (typeof skill.enabled !== "boolean") throw invalidPayload("Codex skill enabled state must be boolean.");
  validateNullableOptionalText(skill, "shortDescription", rawLimits.interfaceDescription, true);
  if (Object.hasOwn(skill, "interface") && skill.interface === undefined) {
    throw invalidPayload("Codex optional skill interface cannot be undefined on the wire.");
  }
  if (Object.hasOwn(skill, "dependencies") && skill.dependencies === undefined) {
    throw invalidPayload("Codex optional skill dependencies cannot be undefined on the wire.");
  }
  validateSkillInterface(skill.interface);
  validateSkillDependencies(skill.dependencies, maximumDependencies);

  const parsed = skillSummarySchema.safeParse({
    name,
    description: description.length === 0 ? null : description,
    scope: skill.scope,
    enabled: skill.enabled
  });
  if (!parsed.success) throw invalidPayload("Codex skill public summary is invalid.", parsed.error);
  return Object.freeze(parsed.data);
}

function validateSkillInterface(candidate: unknown): void {
  if (candidate === undefined || candidate === null) return;
  const value = requireResponseRecord(candidate, "Codex skill interface must be an object, null, or omitted.");
  assertRequiredAndOptionalKeys(value, [], interfaceKeys, "Codex skill interface fields are invalid.");
  validateNullableOptionalText(value, "displayName", rawLimits.interfaceName, true);
  validateNullableOptionalText(value, "shortDescription", rawLimits.interfaceDescription, true);
  validateNullableOptionalText(value, "brandColor", rawLimits.interfaceColor, true);
  validateNullableOptionalText(value, "defaultPrompt", rawLimits.prompt, true);
  validateNullableOptionalPath(value, "iconSmall", "Codex skill small icon path");
  validateNullableOptionalPath(value, "iconLarge", "Codex skill large icon path");
}

function validateSkillDependencies(candidate: unknown, maximumDependencies: number): void {
  if (candidate === undefined || candidate === null) return;
  const dependencies = requireResponseRecord(candidate, "Codex skill dependencies must be an object, null, or omitted.");
  assertExactKeys(dependencies, ["tools"], "Codex skill dependency fields are invalid.");
  if (!Array.isArray(dependencies.tools)) throw invalidPayload("Codex skill dependency tools must be an array.");
  if (dependencies.tools.length > maximumDependencies) {
    throw capacityError("Codex skill dependencies exceeded the configured per-skill ceiling.");
  }
  for (const candidateTool of dependencies.tools) {
    const tool = requireResponseRecord(candidateTool, "Codex skill tool dependency must be an object.");
    assertRequiredAndOptionalKeys(
      tool,
      dependencyRequiredKeys,
      dependencyOptionalKeys,
      "Codex skill tool dependency fields are invalid."
    );
    parseText(tool.type, "Codex skill dependency type", rawLimits.dependencyField, false, true);
    parseText(tool.value, "Codex skill dependency value", rawLimits.dependencyField, false, false);
    validateNullableOptionalText(tool, "description", rawLimits.dependencyField, true);
    validateNullableOptionalText(tool, "transport", rawLimits.dependencyField, true);
    validateNullableOptionalText(tool, "command", rawLimits.dependencyCommand, true);
    validateNullableOptionalText(tool, "url", rawLimits.dependencyField, true);
  }
}

function validateSkillError(candidate: unknown): void {
  const error = requireResponseRecord(candidate, "Codex skill error must be an object.");
  assertExactKeys(error, ["message", "path"], "Codex skill error fields are invalid.");
  parseText(error.path, "Codex skill error path", rawLimits.path, false, false);
  parseText(error.message, "Codex skill error message", rawLimits.errorMessage, false, false);
}

function parsePort(candidate: unknown): CodexSkillsRequestPort {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    typeof (candidate as { readonly request?: unknown }).request !== "function" ||
    !("compatibility" in candidate) ||
    !("generation" in candidate)
  ) {
    throw new TypeError("Codex skills client requires an exact connection request port.");
  }
  return candidate as CodexSkillsRequestPort;
}

function parseOptions(candidate: unknown): ParsedOptions {
  const value = requireInputRecord(candidate, "Codex skills options must be a plain object.");
  const allowed = new Set([
    "max_dependencies_per_skill",
    "max_entries_per_cwd",
    "max_errors_per_cwd",
    "now",
    "read_timeout_ms"
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw invalidInput("Codex skills option fields are invalid.");
  if (value.now !== undefined && typeof value.now !== "function") throw invalidInput("Codex skills clock must be a function.");
  return Object.freeze({
    max_entries_per_cwd: parseBoundedInteger(
      value.max_entries_per_cwd,
      defaultResourceBudget.protocol_skills_max_entries_per_cwd,
      resourceBudgetDefinitionByKey.protocol_skills_max_entries_per_cwd,
      "per-cwd skill ceiling"
    ),
    max_errors_per_cwd: parseBoundedInteger(
      value.max_errors_per_cwd,
      defaultResourceBudget.protocol_skills_max_errors_per_cwd,
      resourceBudgetDefinitionByKey.protocol_skills_max_errors_per_cwd,
      "per-cwd error ceiling"
    ),
    max_dependencies_per_skill: parseBoundedInteger(
      value.max_dependencies_per_skill,
      defaultResourceBudget.protocol_skills_max_dependencies_per_skill,
      resourceBudgetDefinitionByKey.protocol_skills_max_dependencies_per_skill,
      "per-skill dependency ceiling"
    ),
    read_timeout_ms: parseBoundedInteger(
      value.read_timeout_ms,
      defaultResourceBudget.protocol_read_timeout_ms,
      resourceBudgetDefinitionByKey.protocol_read_timeout_ms,
      "read timeout"
    ),
    now: (value.now as (() => string) | undefined) ?? (() => new Date().toISOString())
  });
}

function parseInput(candidate: unknown): { readonly cwd: AbsoluteCwd; readonly signal?: AbortSignal } {
  const value = requireInputRecord(candidate, "Codex skills input must be a plain object.");
  if (
    Object.keys(value).some((key) => !["cwd", "signal"].includes(key)) ||
    !Object.hasOwn(value, "cwd")
  ) {
    throw invalidInput("Codex skills input fields are invalid.");
  }
  const cwd = absoluteCwdSchema.safeParse(value.cwd);
  if (!cwd.success) throw invalidInput("Codex skills cwd is invalid.", cwd.error);
  if (value.signal !== undefined && !(value.signal instanceof AbortSignal)) {
    throw invalidInput("Codex skills signal must be an AbortSignal.");
  }
  return {
    cwd: cwd.data,
    ...(value.signal === undefined ? {} : { signal: value.signal as AbortSignal })
  };
}

function parseClock(candidate: unknown): IsoTimestamp {
  const parsed = isoTimestampSchema.safeParse(candidate);
  if (!parsed.success) throw invalidPayload("Codex skills clock returned an invalid timestamp.", parsed.error);
  return parsed.data;
}

function parseGeneration(candidate: unknown, outcome: "not_applicable" | "not_sent"): number {
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 1) {
    throw adapterError(
      "protocol_violation",
      "Codex skills connection generation is invalid.",
      outcome,
      outcome === "not_sent"
    );
  }
  return candidate as number;
}

function parseAbsolutePath(candidate: unknown, label: string): AbsoluteCwd {
  parseText(candidate, label, rawLimits.path, false, true);
  const parsed = absoluteCwdSchema.safeParse(candidate);
  if (!parsed.success) throw invalidPayload(`${label} is invalid.`, parsed.error);
  return parsed.data;
}

function parseText(
  candidate: unknown,
  label: string,
  maximumBytes: number,
  allowEmpty: boolean,
  requireTrimmed: boolean
): string {
  if (typeof candidate !== "string") throw invalidPayload(`${label} must be a string.`);
  if ((!allowEmpty && candidate.length === 0) || (requireTrimmed && candidate !== candidate.trim())) {
    throw invalidPayload(`${label} is empty or whitespace-padded.`);
  }
  if (new TextEncoder().encode(candidate).byteLength > maximumBytes) {
    throw capacityError(`${label} exceeds its UTF-8 byte ceiling.`);
  }
  for (let index = 0; index < candidate.length; index += 1) {
    const code = candidate.charCodeAt(index);
    if ((code <= 31 && ![9, 10, 13].includes(code)) || code === 127) {
      throw invalidPayload(`${label} contains an unsupported control character.`);
    }
  }
  return candidate;
}

function validateNullableOptionalText(
  value: Readonly<Record<string, unknown>>,
  key: string,
  maximumBytes: number,
  allowEmpty: boolean
): void {
  if (!Object.hasOwn(value, key) || value[key] === null) return;
  if (value[key] === undefined) throw invalidPayload(`Codex optional ${key} cannot be undefined on the wire.`);
  parseText(value[key], `Codex optional ${key}`, maximumBytes, allowEmpty, false);
}

function validateNullableOptionalPath(
  value: Readonly<Record<string, unknown>>,
  key: string,
  label: string
): void {
  if (!Object.hasOwn(value, key) || value[key] === null) return;
  if (value[key] === undefined) throw invalidPayload(`Codex optional ${key} cannot be undefined on the wire.`);
  parseAbsolutePath(value[key], label);
}

function requireInputRecord(candidate: unknown, message: string): Readonly<Record<string, unknown>> {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) throw invalidInput(message);
  const prototype = Object.getPrototypeOf(candidate);
  if (prototype !== Object.prototype && prototype !== null) throw invalidInput(message);
  return candidate as Readonly<Record<string, unknown>>;
}

function requireResponseRecord(candidate: unknown, message: string): Readonly<Record<string, unknown>> {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) throw invalidPayload(message);
  const prototype = Object.getPrototypeOf(candidate);
  if (prototype !== Object.prototype && prototype !== null) throw invalidPayload(message);
  return candidate as Readonly<Record<string, unknown>>;
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  message: string
): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) throw invalidPayload(message);
}

function assertRequiredAndOptionalKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[],
  message: string
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw invalidPayload(message);
  }
}

function parseBoundedInteger(
  candidate: unknown,
  fallback: number,
  definition: { readonly minimum: number; readonly maximum: number },
  label: string
): number {
  const value = candidate ?? fallback;
  if (!Number.isSafeInteger(value) || (value as number) < definition.minimum || (value as number) > definition.maximum) {
    throw invalidInput(
      `Codex skills ${label} must be a safe integer between ${definition.minimum} and ${definition.maximum}.`
    );
  }
  return value as number;
}

function compareSkillNames(left: SkillSummary, right: SkillSummary): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function invalidInput(message: string, cause?: unknown): HostDeckCodexAdapterError {
  return adapterError("invalid_protocol_message", message, "not_sent", true, cause);
}

function invalidPayload(message: string, cause?: unknown): HostDeckCodexAdapterError {
  return adapterError("invalid_protocol_message", message, "not_applicable", false, cause);
}

function capacityError(message: string): HostDeckCodexAdapterError {
  return adapterError("broker_overloaded", message, "not_applicable", false);
}

function adapterError(
  code: HostDeckCodexAdapterError["code"],
  message: string,
  outcome: HostDeckCodexAdapterError["outcome"],
  retrySafe: boolean,
  cause?: unknown
): HostDeckCodexAdapterError {
  return new HostDeckCodexAdapterError(code, message, { outcome, retry_safe: retrySafe, cause });
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
