export const cliExitCodes = {
  ok: 0,
  usage: 64,
  daemonUnavailable: 69,
  apiError: 70,
  config: 78,
  internal: 1
} as const;

export type CliExitCode = (typeof cliExitCodes)[keyof typeof cliExitCodes];
