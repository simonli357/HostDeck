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
| `error_class` | `error.constructor.name`, filtered | an identifier from our own or Node's type space |
| `framework_code` | Fastify `FST_ERR_*` | a framework constant, not caller data |
| `request_id` | `genReqId` `req_<uuid>` | server-generated; `requestIdHeader: false` means a caller cannot set it |

`error.message` and `error.stack` are never read. `errorClassName` additionally requires the
name to match `^[A-Za-z0-9_$]+$` and be at most 64 characters, so hostile text cannot ride in
through a constructor name.

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
- The three adversarial verification agents commissioned for this diff all failed with a
  transient API error, so the claims above rest on the direct tests and measurements listed,
  not on an independent review.
