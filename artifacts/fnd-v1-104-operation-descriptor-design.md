# FND-V1-104 Operation Descriptor Design

Design and decomposition only. No production code is changed by this task.

## Measured surface

Each of nine Codex operations carries the same five-layer vertical:

| operation | service | routes | cli client | web state | web control | total |
| --- | --- | --- | --- | --- | --- | --- |
| model | 1,018 | 695 | 246 | 1,164 | 386 | 3,509 |
| plan | 1,144 | 713 | 237 | 1,158 | 494 | 3,746 |
| goal | 822 | 735 | 235 | 1,393 | 486 | 3,671 |
| compact | 1,074 | 730 | 252 | 1,126 | 451 | 3,633 |
| usage | 643 | 429 | 199 | 850 | 468 | 2,589 |
| skills | 401 | 428 | 196 | 797 | 463 | 2,285 |
| interrupt | 1,025 | 657 | 190 | 1,185 | 848 | 3,905 |
| approval | 1,202 | 787 | 232 | 1,568 | 568 | 4,357 |
| archive | — | 674 | 225 | 932 | 337 | 2,168 |
| **total** | **7,329** | **5,848** | **2,012** | **10,173** | **4,501** | **29,863** |

## What actually differs

Normalising the operation name out of `model-client.ts` and `plan-client.ts` leaves **42 diff
lines out of ~250**, and every one falls into three buckets:

1. **Message strings** — the usage failure text and the per-code error copy.
2. **Request field names** — `model_id` / `reasoning_effort` versus `action`.
3. **The correlation assertion** — `assertSelectionCorrelation`, which checks that the
   returned snapshot actually reflects the request.

Everything else is identical: loopback base-URL validation, bounded fetch construction,
option parsing, request building, `requestCliJson`, status handling, envelope sanitisation.

Bucket 3 is the only one carrying real meaning. It encodes `DEC-023`: pending model and Plan
are next-turn settings, an active goal starts turns autonomously, compact stays incomplete
until authoritative completion. **It must stay per-operation.** A descriptor that tried to
generalise it would be generalising the one part of the system that is genuinely different,
which is how the repository's own no-hidden-fallback rule gets broken by accident.

## The descriptor

```ts
interface OperationDescriptor<Request, Snapshot> {
  readonly id: OperationId;                       // "model" | "plan" | ...
  readonly routePath: `/api/v1/sessions/:session_id/${string}`;
  readonly requestSchema: z.ZodType<Request>;
  readonly snapshotSchema: z.ZodType<Snapshot>;
  readonly usageMessage: string;                  // bucket 1
  readonly errorMessages: Partial<Record<ApiErrorCode, string>>; // bucket 1, over a shared default map
  readonly auditAction: SelectedAuditAction;
  readonly lockPolicy: SelectedApiLockPolicy;
  readonly assertCorrelation: (snapshot: Snapshot, request: Request) => void; // bucket 3
}
```

Three factories consume it — one per layer that is genuinely repetitive:

- `createOperationRouteRegistration(descriptor)` replaces the nine `*-routes.ts` modules.
- `createOperationClient(descriptor)` replaces the nine `cli/*-client.ts` modules.
- `createOperationControlState(descriptor)` replaces the nine `web/*-control-state.ts` modules.

`selectedApiRouteManifest` already proves this shape works: it is a single declarative table
binding every route to method, transport, auth mechanism, authority, CSRF policy, lock policy,
target kind, audit executor, audit action and schema id. The descriptor extends the same idea
across the layers the manifest does not reach.

### Worked example

```ts
export const modelOperation: OperationDescriptor<ModelSelectionRequest, ModelControlSnapshot> = {
  id: "model",
  routePath: "/api/v1/sessions/:session_id/model",
  requestSchema: modelSelectionRequestSchema,
  snapshotSchema: modelControlSnapshotSchema,
  usageMessage:
    "Model selection requires one valid session, operation id, catalog model, effort, and expected revision.",
  errorMessages: {
    validation_error: "Requested model is absent from the live catalog.",
    operation_conflict: "Pending model state changed or cannot be replaced."
  },
  auditAction: "model_select",
  lockPolicy: "requires_unlocked_host",
  assertCorrelation: assertModelSelectionCorrelation   // unchanged, still per-operation
};

export const planOperation: OperationDescriptor<PlanSelectionRequest, PlanControlSnapshot> = {
  id: "plan",
  routePath: "/api/v1/sessions/:session_id/plan",
  requestSchema: planSelectionRequestSchema,
  snapshotSchema: planControlSnapshotSchema,
  usageMessage:
    "Plan selection requires one valid session, operation id, action, and expected revision.",
  errorMessages: { validation_error: "Requested collaboration mode is unavailable." },
  auditAction: "plan_select",
  lockPolicy: "requires_unlocked_host",
  assertCorrelation: assertPlanSelectionCorrelation
};
```

## What is deliberately NOT consolidated

The nine `codex-*-control-service.ts` modules, 7,329 lines. They hold the exact runtime
semantics `DEC-023` was written from — event gating, pending-settings composition, turn
correlation, approval expiry ownership. They are long because the behaviour is genuinely
different per operation, not because the code was retyped. Folding them into a factory would
convert reviewed, tested semantics into configuration.

Realistic reduction is therefore against the other three layers, roughly 22,500 lines, not the
full 29,863.

## Decomposition

`AGENTS.md` forbids executing this as one task, so it becomes five leaf tasks. Each is
independently testable and reversible.

| task | scope | blocked by |
| --- | --- | --- |
| `FND-V1-108` | Descriptor contract, the nine descriptor instances, and fixtures. No consumer changes. | none |
| `IFC-V1-113` | Shared route registration factory; migrate the nine `*-routes.ts`. | `FND-V1-108` |
| `IFC-V1-114` | Shared CLI operation client factory; migrate the nine `cli/*-client.ts`. | `FND-V1-108` |
| `FE-V1-107` | Shared web control-state factory; migrate the nine `web/*-control-state.ts`. | `FND-V1-108` |
| `REL-V1-109` | Prove behaviour equivalence across all nine verticals before the old modules are deleted. | the three migrations |

`FND-V1-105`, the `selected-` rename, stays behind this work: renaming 20 modules while their
contents are being replaced would make both diffs unreviewable.

## Risks

- The route factory touches the 38-route/23-registration graph asserted in
  `run-production-package-smoke.mjs`. The counts must not move; if they do, the factory has
  changed the surface rather than its implementation.
- `productionPackageSourceCount = 638` will fall as modules are deleted. Five assertion sites
  and six doc records cite it, and `check:planning` now enforces the technical plan's copy.
- The web control states are the largest layer (10,173 lines) and the least uniform, because
  each owns its own optimistic-update and failure-recovery shape. `FE-V1-107` should expect
  the lowest consolidation ratio and should not force uniformity that is not there.
