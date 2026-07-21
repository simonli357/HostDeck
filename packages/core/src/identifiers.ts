const sessionIdBrand: unique symbol = Symbol("SessionId");
const sessionNameBrand: unique symbol = Symbol("SessionName");
const absoluteCwdBrand: unique symbol = Symbol("AbsoluteCwd");
const isoTimestampBrand: unique symbol = Symbol("IsoTimestamp");
const outputCursorBrand: unique symbol = Symbol("OutputCursor");

export type SessionId = string & { readonly [sessionIdBrand]: "SessionId" };
export type SessionName = string & { readonly [sessionNameBrand]: "SessionName" };
export type AbsoluteCwd = string & { readonly [absoluteCwdBrand]: "AbsoluteCwd" };
export type IsoTimestamp = string & { readonly [isoTimestampBrand]: "IsoTimestamp" };
export type OutputCursor = number & { readonly [outputCursorBrand]: "OutputCursor" };

export type ValidationIssueCode =
  | "empty"
  | "too_short"
  | "too_long"
  | "invalid_format"
  | "not_absolute"
  | "not_integer"
  | "unsafe_integer"
  | "negative";

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: ValidationIssueCode; readonly message: string };

const sessionIdPattern = /^sess_[a-z0-9][a-z0-9_-]{5,63}$/u;
const sessionNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u;
const isoTimestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})(Z|[+-]\d{2}:\d{2})$/u;

export function parseSessionId(value: string): ValidationResult<SessionId> {
  if (value.length === 0) return invalid("empty", "Session id is required.");
  if (value.length < 11) return invalid("too_short", "Session id is too short.");
  if (!sessionIdPattern.test(value)) {
    return invalid("invalid_format", "Session id must match sess_<lowercase-id>.");
  }
  return valid(value as SessionId);
}

export function isSessionId(value: string): value is SessionId {
  return parseSessionId(value).ok;
}

export function parseSessionName(value: string): ValidationResult<SessionName> {
  const trimmed = value.trim();
  if (trimmed.length === 0) return invalid("empty", "Session name is required.");
  if (trimmed.length > 64) return invalid("too_long", "Session name must be 64 characters or fewer.");
  if (!sessionNamePattern.test(trimmed)) {
    return invalid(
      "invalid_format",
      "Session name must start with a letter or number and use letters, numbers, dots, underscores, or dashes."
    );
  }
  return valid(trimmed as SessionName);
}

export function isSessionName(value: string): value is SessionName {
  return parseSessionName(value).ok;
}

export function hasSessionNameCollision(existingNames: readonly SessionName[], candidate: SessionName): boolean {
  return existingNames.some((name) => name === candidate);
}

export function parseAbsoluteCwd(value: string): ValidationResult<AbsoluteCwd> {
  if (value.length === 0) return invalid("empty", "Working directory is required.");
  if (!value.startsWith("/")) return invalid("not_absolute", "Working directory must be an absolute path.");
  if (value.includes("\0")) return invalid("invalid_format", "Working directory must not contain NUL bytes.");
  return valid(value as AbsoluteCwd);
}

export function parseIsoTimestamp(value: string): ValidationResult<IsoTimestamp> {
  const match = isoTimestampPattern.exec(value);
  if (match === null) {
    return invalid("invalid_format", "Timestamp must be an RFC 3339 string with milliseconds and a UTC or numeric offset.");
  }

  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const offset = match[8];
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    offset === undefined ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    !validTimestampOffset(offset)
  ) {
    return invalid("invalid_format", "Timestamp must be a valid calendar date and time.");
  }

  const parsedTime = Date.parse(value);
  if (Number.isNaN(parsedTime)) return invalid("invalid_format", "Timestamp must be a valid date.");
  return valid(new Date(parsedTime).toISOString() as IsoTimestamp);
}

export function parseOutputCursor(value: number): ValidationResult<OutputCursor> {
  if (!Number.isInteger(value)) return invalid("not_integer", "Output cursor must be an integer.");
  if (value < 0) return invalid("negative", "Output cursor must be non-negative.");
  if (!Number.isSafeInteger(value)) return invalid("unsafe_integer", "Output cursor must be a safe integer.");
  return valid(value as OutputCursor);
}

function valid<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

function invalid(code: ValidationIssueCode, message: string): ValidationResult<never> {
  return { ok: false, code, message };
}

function daysInMonth(year: number, month: number): number {
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[month - 1] ?? 0;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function validTimestampOffset(offset: string): boolean {
  if (offset === "Z") return true;
  const hours = Number(offset.slice(1, 3));
  const minutes = Number(offset.slice(4, 6));
  return hours <= 23 && minutes <= 59;
}
