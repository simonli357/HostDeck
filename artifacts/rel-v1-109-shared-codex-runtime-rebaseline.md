# REL-V1-109 Shared Codex Runtime Rebaseline

- Decision: exact Codex 0.147.0, its standard Unix app-server control socket, automatic loaded-root enrollment, native UUID user targeting, and independent broker/dashboard lifecycle replace the selected discover/adopt/unmanage handoff flow.
- Platform: Ubuntu 24.04 x64 is V1. Windows shared-session delivery is deferred to V2; completed Windows work remains historical evidence.
- Runtime boundary observed before planning: plain `codex resume <uuid>` connected to the standard socket; `thread/loaded/list` and thread-created notifications provide loaded-before and created-after enrollment inputs; a client already attached elsewhere cannot be intercepted and needs one close/resume transition.
- Delivery chain: `INT-V1-110` -> `FND-V1-103` -> `INT-V1-111`/`DAT-V1-106` -> `INT-V1-112` -> `INT-V1-113` -> `IFC-V1-111` -> `IFC-V1-112` -> `FE-V1-107` -> `INT-V1-114` -> `IFC-V1-113` -> `FE-V1-108` -> `REL-V1-110`.
- Validation: `pnpm check:planning` passes with 289 tasks, 94 requirements, 777 dependencies, and one ready task; targeted owner-doc drift scan and `git diff --check` pass.
