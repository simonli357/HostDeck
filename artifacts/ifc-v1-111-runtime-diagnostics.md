# IFC-V1-111 Runtime Diagnostics

Gives the host a bounded, non-reflecting record of failures it could not previously account
for, and surfaces it on the failure an operator actually sees.

## Problem

`packages/server`, `packages/storage` and `packages/codex-adapter` contained zero
`console.*`, `process.stdout` or `process.stderr` writes in production code, and Fastify is
constructed at `fastify-app.ts:208` with no `logger`. An internal 500 flowed
`handleHostDeckFastifyError` to `observeInternalFailure` to `reportHttpIssue`
(`production-foreground-serve.ts:981`) to `report("http", "internal_error")`, discarding the
`Error`, its message and its stack. `createIssueReporter` then kept a count and one last
`{source, code}`. A `req_<uuid>` was minted per request and correlated with nothing.

So a production 500 produced a counter, and the operator saw
`HostDeck foreground service terminated in a failed state.` with nothing attached.

## Why the obvious design was not built

An earlier design wrote a local diagnostic file. It was refuted on eight grounds, all
verified against source:

1. `error.message` leaks private paths — `branch-metadata.ts:55` interpolates `cwd`, and Node
   errno messages embed absolute paths (measured: `ENOENT ... open '/home/…'`).
2. `HostDeckInternalErrorObservation` is exactly `{error, request_id, framework_code?}`; it
   carries no route, so any route-template promise was unobtainable at that seam.
3. `production-application-composition.ts:250` enforces an exact `inputKeys` allowlist.
4. There is no `O_APPEND` in the secure path adapter, so "reuse the secure open" was false.
5. `selectedHostLocalHealthCauses` is a closed 26-member enum.
6. Uninstall's allowlist would not remove a new state file, contradicting `IFC-V1-057`.
7. `SFR-006` via `REL-V1-005` criterion `SPR-17` bans retained prompt or transcript text, raw
   output, and private origin, IP or path values.
8. The serve test harness `resources` fixture has no `paths`, and the startup `catch` runs
   before the owner that would close a descriptor exists.

## Design

Keep a bounded in-memory ring instead of a file. Every one of the eight grounds is avoided
by construction rather than by mitigation: nothing is written to disk, no input shape
changes, no health cause is added, no descriptor is opened, and nothing survives the process.

Each record carries only values that are already safe to retain:

| field | source | why it is safe |
| --- | --- | --- |
| `sequence` | monotonic counter | ours |
| `source`, `code` | existing issue vocabulary | already a closed set |
| `error_class` | the PROTOTYPE's constructor name, filtered | an own `constructor` cannot spoof it |
| `framework_code` | Fastify `FST_ERR_*`, validated | bounded to 96 identifier characters |
| `request_id` | `genReqId` `req_<uuid>` | server-generated; `requestIdHeader: false` means a caller cannot set it |

`error.message` and `error.stack` are never read.

Three corrections came out of adversarial review of the first implementation, and all three
were real:

- **The class-name guard was weaker than claimed.** It read `error.constructor.name` off the
  VALUE, so an own `constructor` spoofed it — and an own `constructor` is trivially reachable,
  since `JSON.parse` preserves it (only `__proto__` is special-cased). The charset rule
  permits underscores, so `Object.create({constructor: {name: "home_simonli_private_path"}})`
  returned that string verbatim. It now reads the constructor from the prototype and requires
  it to be a function. Residual, stated rather than claimed away: a caller who fully controls
  the thrown value can still present a genuine constructor whose name they chose, so up to 64
  identifier characters may be influenced. That is bounded and cannot carry a path or break
  the output contract, but it is not immunity.
- **`framework_code` had no validation at all.** `fastifyErrorCode` returns `.code` off any
  object carrying a string `code`, so it is not guaranteed to be a Fastify constant, and it
  was rendered raw into operator stderr. An oversized value would exceed
  `cli_response_max_bytes` and trip `assertCliOutput`, replacing the operator's real failure
  with a limit error — precisely what the CLI renderer claims to prevent. It is now bounded to
  96 identifier characters.
- **The first version could suppress the evidence it existed to record.** The class-name read
  was an argument expression to `report(...)`, so a throwing `constructor` accessor propagated
  before `report` ran: the counter never incremented, no record was appended, and the throw
  was swallowed by `observeInternalFailure`. A caller shaping the thrown value could make
  their own failures invisible — strictly worse than the counter this replaced. Detail
  extraction is now wrapped, and `report` is always called.

The first round of tests passed for the wrong reason and are replaced. Every hostile payload
in them contained a `/`, a space, or 200 characters, so the charset and length rules rejected
them without the spoofing mechanism ever being exercised. The current tests use
identifier-shaped payloads that pass those rules.

Capacity is 32, trimmed on every append by `appendBoundedDiagnostic`.

## Surfacing

Recording without surfacing would be barely better than the counter it replaced, so the
operator-visible failure now carries the newest records:

```
before  HostDeck foreground service terminated in a failed state.

after   HostDeck foreground service terminated in a failed state. Recent diagnostics:
        #9 http/internal_error TypeError req_8f2c1d90;
        #10 http/framework_error FastifyError FST_ERR_CTP_INVALID_MEDIA_TYPE req_11ab77e2;
        #11 serve/runtime_exit.
```

Bounded to the newest five with a `(+N earlier)` suffix. The renderer is deliberately
defensive about a missing or malformed field: it degrades to the previous bare message rather
than throwing, because it runs on an already-failing path and must never replace the
operator's real failure with a rendering error. A regression covers exactly that case.

## Evidence

- `production-foreground-serve.test.ts`: 13 tests. A reported issue produces a record whose
  key set is exactly the six permitted fields, whose values are all string, number or null,
  and whose serialization contains none of `message`, `stack`, `cwd`, `path`, `origin`,
  `prompt`, `transcript`. The ring holds 32 of 103 appended records, keeps the newest, and
  freezes every entry.
- `errorClassName` attack cases, all rejected: hostile `constructor.name` carrying a path, a
  Proxy whose constructor getter returns attacker text, a 200-character name, a name with a
  space, and a null-prototype object. A `TypeError` whose message embeds
  `/home/simonli/private/secret` contributes only `TypeError`.
- `executable-cli.test.ts`: the failure message carries the rendered diagnostics, a snapshot
  without the field still produces the bare message and no `Recent diagnostics` text, and
  neither path exposes the fixture root.
- Gates: unit 3,236 passed with 32 skipped, contract 290, integration 36, typecheck, lint over
  900 files, runtime boundary at 638 modules with no change to the production source count.

## Limits

- In memory only. A hard crash loses the ring; this covers failures the process survives,
  which is the case that previously produced only a counter.
- `error_class` is coarse. If most 500s are one error type it discriminates little; the
  `request_id` is what makes a record correlatable.
- No route is recorded, because the observation seam does not carry one. Adding it would need
  a contract change to `HostDeckInternalErrorObservation`.
- Adversarial review of the first implementation confirmed five findings, three of which were
  defects in this change rather than in its description. They are corrected above and covered
  by regressions. The privacy lens separately confirmed that `request_id`, `sequence`,
  `source` and `code` hold up, that no `error.message` or `error.stack` is read anywhere, and
  that nothing reaches a file, a route, the dashboard, or the systemd journal.
