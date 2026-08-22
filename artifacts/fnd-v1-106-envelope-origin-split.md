# FND-V1-106 Error-Envelope Produce/Parse Split

Closes `BUG-092`. The sensitive-detail-key guard is widened from 5 terms to 23 credential
shapes, which was previously impossible because one validation path served both directions.

## Problem

`sensitiveDetailKeyPattern` was `/(authorization|cookie|password|secret|token)/iu`.
Measured, it accepted `credential`, `csrf`, `csrf_hash`, `bearer`, `pairing_code`,
`passphrase`, `signature`, `nonce`, `otp`, `pin`, `api_key`, `node_key`, and
`private_key`. In a codebase whose stated doctrine is that no secret is reflected, the
guard was close to cosmetic.

The first attempt simply widened the pattern. It broke ten CLI client suites and was
reverted. The cause was structural, not cosmetic: `throwCliApiFailure`
(`packages/cli/src/loopback-http.ts:161`) validates the **inbound** server envelope through
`apiRouteErrorBodySchema`, whose `superRefine` calls the same core validator that the server
uses when **producing** an envelope. Widening the guard therefore made a hostile-but-typed
server response fail structural validation, so an actionable `validation_error` collapsed
into `internal_error` and the caller lost the code and message.

That is a strictly worse outcome, and it bought nothing: `:170` already discards `details`
entirely before the second parse, so rejecting on a key name at `:161` protected nothing.

## Change

An envelope now carries an explicit origin.

- `packages/core/src/errors.ts` adds `errorEnvelopeOrigins` and threads an
  `ErrorEnvelopeOrigin` through `parseErrorEnvelope` and `createErrorEnvelope`, defaulting
  to `"produced"` so no existing caller changes behaviour.
  - `produced` — an envelope HostDeck is about to emit. A credential-shaped detail key is a
    defect in our own code and is rejected outright, as before.
  - `received` — an envelope read back from a peer. Credential-shaped keys are **stripped**,
    and the typed failure still surfaces. Every other validation stays strict: a malformed
    detail value in a received envelope is still rejected rather than silently dropped.
- `packages/contracts/src/api-error.ts` parameterises the shared shape by origin and exports
  `receivedApiErrorEnvelopeSchema` and `receivedApiRouteErrorBodySchema` alongside the
  existing strict ones.
- `packages/cli/src/loopback-http.ts` parses inbound bodies with the received variant.
- The guard is widened to 23 credential shapes. Short ambiguous terms are anchored to the
  final `_` segment so ordinary identifiers survive.

## Behaviour

Produced side, all rejected:

```
private_key csrf bearer pairing_code credential api_key
passphrase signature nonce otp device_pin auth        -> all blocked
```

Received side, typed failure preserved and credentials stripped:

```
in   { code: validation_error, details: { private_key, csrf, session_id, key_count_total } }
out  { code: validation_error, details: { session_id, key_count_total } }
```

Public product vocabulary stays usable on both sides: `session_id`, `device_id`,
`operation_id`, `thread_id`, `turn_id`, `request_id`, `reason`, `cursor`, `limit`,
`key_count_total`, `pin_count`. These are public in this API and blocking them would make
truthful errors unexpressible. Ordinary words that merely contain a credential substring —
`keyboard`, `monkey`, `mapping`, `author`, `pinned` — are also unaffected.

## Evidence

- The ten CLI suites that failed the first attempt now pass: 72 tests across
  archive, compact, goal, model, plan, prompt, resume, skills, start, and usage clients.
- New regressions: four in `packages/core/src/errors.test.ts` covering produced rejection of
  23 credential keys, produced acceptance of 11 public keys, received stripping with the
  typed code and message preserved, and received rejection of a malformed detail value.
  Three in `packages/contracts/src/api-error.contract.test.ts` covering both schemas.
- Full gates: unit 3,233 passed with 32 skipped, contract 290 passed, integration 36 passed,
  typecheck, lint over 900 files, runtime boundary at 638 modules.

## Limits

- The guard matches key **names**, not values. A credential placed under an innocuous key is
  not caught here; that remains the caller's responsibility.
- No production code passes `details` today, so this is defence in depth rather than a fix
  for a live leak.
