# INT-V1-110 Codex Acceptance-Band Spike

Question: can a capability-verified acceptance band replace exact version equality in
`packages/codex-adapter/src/compatibility.ts:127`, and would it accept the versions users
actually have?

Answer: on protocol surface, yes, and the margin is larger than expected. On semantics,
unproven, and this spike cannot prove it without a control binary that no longer exists on
this host. The gate should not change until that gap is closed.

## Why this matters now

`DEC-021` pins HostDeck to exact `codex-cli 0.144.0`. The binary on this workstation is
**0.149.0**, five minor versions ahead. `docs/status.md` recorded the drift as 0.146.0, so
it has moved twice since that was written. Other Codex builds present on the same machine:
0.148.0-alpha.15, 0.149.0-alpha.4, 0.149.0-alpha.4.1. `BUG-083` separately records real
user sessions created by versions from 0.130.0 through 0.146.0.

A shipped package that hard-fails on anything but 0.144.0 is therefore already
incompatible with its own author's machine.

## Method

`codex app-server generate-ts --experimental --out <dir>` is the same invocation
`scripts/codex-bindings.mjs:85` uses to produce the committed binding, so 0.144.0 and
0.149.0 surfaces are directly comparable.

The method-extraction logic was validated before use: running it over the committed
`packages/codex-adapter/src/generated` union files reproduces
`protocol-methods.generated.ts` exactly, for all four unions. An extractor that could not
reproduce the known baseline would make any comparison meaningless.

A first capability matcher was discarded because the 0.144.0 control run reported every
capability missing, which cannot be true of the version HostDeck demonstrably runs on. The
cause was the generated union quoting its discriminator as `"method":` rather than
`method:`. The control run existed precisely to catch that class of error.

## Result: protocol surface is purely additive

| union | 0.144.0 | 0.149.0 | removed | added |
| --- | --- | --- | --- | --- |
| `ClientRequest` | 125 | 153 | **0** | 28 |
| `ClientNotification` | 1 | 1 | **0** | 0 |
| `ServerNotification` | 69 | 77 | **0** | 8 |
| `ServerRequest` | 11 | 11 | **0** | 0 |

Nothing HostDeck depends on was withdrawn across five minor versions. `InitializeParams`
is byte-identical between the two versions.

All eleven `capabilityRules` entries are satisfied by 0.149.0, verified against a 0.144.0
control that also passes:

`thread_lifecycle`, `turn_input`, `turn_steer`, `turn_interrupt`, `model`, `goal`, `plan`,
`usage`, `compact`, `skills`, `approvals` — every required client method, server
notification, server request, and `turn/start` field (`threadId`, `input`, `model`,
`collaborationMode`) is present.

## Result: live handshake inconclusive

A live probe started 0.149.0 on a private Unix socket and attempted the initialize
handshake over `ws+unix:` using the same URL form as
`transport-endpoint.ts:168`. The connection was accepted and then closed without a
response (`socket hang up`).

**This is reported as inconclusive, not as a finding.** No exact 0.144.0 binary exists on
this host, so there is no control run. Without one, a failed hand-rolled probe cannot
distinguish "0.149.0 changed the transport" from "the probe is wrong" — and the capability
matcher above already demonstrated how easily a probe can be wrong in a way that looks
like a real result. Claiming a transport break from this evidence would be unsound.

## Assessment

A capability-verified band is viable and would accept 0.149.0 on surface grounds. The
mechanism already exists: `capabilityRules` enumerates exactly what HostDeck needs, and it
is already evaluated during compatibility assessment.

What the band would **not** prove is semantics. `DEC-023` is the standing counter-example:
real captures showed that loaded `thread/resume.model` is ineffective, that early
`turn/steer` rejects, that active goals autonomously start turns, and that compact `{}` is
not reduction proof. Every one of those is a behaviour that a present-and-correctly-typed
method does not guarantee. A surface band that ignored this would trade a loud, honest
failure for a quiet, wrong one — the exact trade `docs/engineering-style.md` forbids.

## Recommendation

Do not change the gate on this evidence alone. Two things are needed first:

1. An exact 0.144.0 binary retained as a control, so live probes are interpretable.
2. A semantic probe covering the `DEC-023` behaviours plus the four `policy_evidence`
   items this spike could not check statically: `experimental_api`, `plan_mode_catalog`,
   `context_compaction_item_type`, `multi_client_version_policy`.

Interim position, which is strictly better than today and needs no semantic proof: keep
exact equality as the supported configuration, but replace the current flat rejection with
a diagnosis that reports which required capabilities the observed version satisfies. A
user on 0.149.0 would then be told that their runtime carries every required capability and
that only the pinned version differs, instead of an unqualified refusal. That is a message
change, not a trust change.

Recorded as `DEC-031`.

## Limits

- Static schema comparison only. Method presence is not behaviour.
- Alpha builds on this host were not probed; only the release 0.149.0 on `PATH`.
- No turn was started, no thread created, and no account state touched. The probe used a
  private socket in a temp directory and killed its own process group on exit.
