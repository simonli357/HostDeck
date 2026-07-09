import { execFileSync } from "node:child_process";
import { absoluteCwdSchema } from "@hostdeck/contracts";

export type GitBranchMetadataErrorCode = "invalid_cwd";

export class HostDeckGitBranchMetadataError extends Error {
  constructor(
    readonly code: GitBranchMetadataErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "HostDeckGitBranchMetadataError";
  }
}

export interface GitExecFileOptions {
  readonly encoding: "utf8";
  readonly stdio: readonly ["ignore", "pipe", "ignore"];
  readonly timeout: number;
}

export type GitExecFile = (file: string, args: readonly string[], options: GitExecFileOptions) => Buffer | string;

export interface CaptureGitBranchMetadataInput {
  readonly execFile?: GitExecFile;
  readonly gitBinary?: string;
  readonly timeoutMs?: number;
}

const defaultTimeoutMs = 2_000;
const maxBranchLength = 240;

export function captureGitBranchMetadata(cwd: string, input: CaptureGitBranchMetadataInput = {}): string | null {
  const parsedCwd = parseCwd(cwd);
  const execFile = input.execFile ?? defaultExecFile;

  try {
    const output = execFile(input.gitBinary ?? "git", ["-C", parsedCwd, "symbolic-ref", "--quiet", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: input.timeoutMs ?? defaultTimeoutMs
    });

    return parseBranchOutput(output);
  } catch {
    return null;
  }
}

function parseCwd(cwd: string): string {
  const result = absoluteCwdSchema.safeParse(cwd);

  if (!result.success) {
    throw new HostDeckGitBranchMetadataError("invalid_cwd", `Working directory ${cwd} is invalid for git metadata capture.`, {
      cause: result.error
    });
  }

  return result.data;
}

function parseBranchOutput(output: Buffer | string): string | null {
  const branch = String(output).trim();

  if (branch.length === 0 || branch.length > maxBranchLength || branch === "HEAD" || branch.includes("\n") || branch.includes("\r")) {
    return null;
  }

  return branch;
}

function defaultExecFile(file: string, args: readonly string[], options: GitExecFileOptions): string {
  return execFileSync(file, [...args], {
    encoding: options.encoding,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: options.timeout
  });
}
