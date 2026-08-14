# INT-V1-112 Standard Broker Lifecycle

## Result

- Resolves only the standard `$CODEX_HOME/app-server-control/app-server-control.sock` endpoint and admits exact Codex 0.147.0 only.
- Creates or validates an owner-only control directory, socket, coordination lock, and durable HostDeck ownership record without permission repair.
- Serializes HostDeck starts, attaches to compatible external brokers, and starts one detached exact broker only when the endpoint is absent.
- Binds ownership to stable process-group identity, exact argv/executable/start ticks, filesystem socket identity, and the listening kernel socket held by that process group.
- Attachment close leaves the broker running. Explicit stop signals only a complete matching proof; stale, insecure, replaced, malformed, or external state fails without killing or unlinking it.
- Compatibility admission now also requires the broker-reported Codex home to match the selected standard endpoint.

## Validation

- Focused lifecycle/adapter tests: 3 files and 35 tests passed.
- Real Linux ownership tests: 7 scenarios passed for detached survival, reattachment, concurrent-start serialization, external attachment/non-ownership, stale/insecure rejection, proof tampering, and pre-readiness crash cleanup.
- Real no-model Codex 0.147.0 smoke passed: standard socket mode `0600`, actual initialize/capability admission, independent Codex daemon version observation, same-generation reattachment, no broker stop on attachment close, and proof-gated explicit cleanup.
- Full unit and contract suites passed; contract result was 44 files and 307 tests.
- Typecheck, Biome/package exports, planning graph, selected-runtime boundary, and deterministic 723-file Codex binding checks passed.

## Remaining Boundary

`INT-V1-113` consumes the admitted shared connection for loaded-thread reconciliation, automatic enrollment, bounded notification buffering, and reconnect behavior. Production CLI/service composition changes remain owned by their downstream interface/package tasks.
