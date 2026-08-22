import { cpus } from "node:os";

/**
 * Upper bound on concurrent Vitest workers, shared by every runner config.
 *
 * This suite composes real Fastify applications and real jsdom trees rather than mocking
 * them, so each worker holds a large resident set. Left unbounded, Vitest sizes its pool
 * from the CPU count alone and the workers then contend for memory instead of running,
 * which turns ordinary tests into timeout failures at the 5,000 ms default.
 *
 * Measured on a 16-core host with roughly 12 GB free, full `test:unit` run:
 *
 *   workers        failures   wall     slowest test
 *   default (~15)     9       ~245 s     89,968 ms
 *   8                 3        286 s     62,163 ms
 *   6                 0        196 s     37,800 ms
 *   4                 0        443 s     30,667 ms
 *
 * Six is both the stable point and the fastest: over-subscription costs more wall time
 * than it buys. That table was measured in a quiet window; see `vitestTestTimeoutMs` for
 * the separate problem of load this suite does not control.
 *
 * This is a cap, not a target. It only binds on hosts with more than seven cores, so
 * small CI runners keep the parallelism they already use and their timings are unchanged.
 */
export const vitestMaxWorkers = Math.max(1, Math.min(6, cpus().length - 1));

/**
 * Declared per-test budget, shared by every runner config.
 *
 * Bounding workers removes the contention this suite inflicts on itself, but not the
 * contention it receives. This repository is developed on a shared workstation that also
 * runs a ROS2 simulation; observed load average there reaches 36 to 48 on 16 cores. Under
 * that load the heaviest ordinary tests, which each compose about twenty real Fastify
 * applications, were measured at 5.0 to 6.1 seconds and failed against Vitest's implicit
 * 5,000 ms default.
 *
 * Twenty seconds is roughly three times the slowest ordinary test observed under load. It
 * is declared rather than inherited, in the same spirit as the 99 explicit runtime
 * resource limits in `@hostdeck/contracts`: a budget nobody chose is not a budget.
 *
 * Trade-off, stated plainly: a larger budget detects a gradual slowdown later than a tight
 * one would. Tests that are heavy by nature already carry their own longer per-test
 * timeouts, and a test that becomes pathological still fails here. Guarding against
 * gradual drift belongs in duration tracking, not in a timeout tuned so tightly that
 * unrelated load decides the result.
 */
export const vitestTestTimeoutMs = 20_000;

/** Hook budget. Setup and teardown pay the same contention as the test body. */
export const vitestHookTimeoutMs = 30_000;
