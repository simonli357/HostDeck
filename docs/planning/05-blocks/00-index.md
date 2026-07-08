# V1 Blocks

Owns the active-version capability block map and V1 completion matrix. Blocks are the middle layer between global planning docs and backlog leaf tasks.

Use blocks for meaningful V1 capabilities, workflows, screen groups, native capabilities, infrastructure areas, or release paths. Do not create a separate block for every epic.

## Rules

- Block IDs use `BLK-V1-01`, `BLK-V1-02`, and so on.
- The global planning docs own cross-block scope, architecture, UX contracts, validation strategy, and release truth.
- Block specs own local architecture, detailed design, implementation sequence, validation, epics, and task links.
- Every active-version requirement must map to a block, explicit spike, or explicit release deferral.
- Every backlog group and epic should reference one or more block IDs.
- V1 is not complete until every required block has completion evidence.

## Block Map

| Block ID | Block | Required for V1? | Spec | Requirements | Depends on | Backlog groups | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BLK-V1-01 |  | Yes | `block-template.md` |  |  |  | Planned |

## V1 Completion Matrix

| Block ID | Required outcome | Task coverage | Automated evidence | Manual/device evidence | Release impact | Status |
| --- | --- | --- | --- | --- | --- | --- |
| BLK-V1-01 |  |  |  |  |  | Not started |

## Coverage Checks

- Every user journey and critical failure state maps to a required block.
- Every native capability, integration, datastore, credential, platform, and store-release dependency maps to a block or explicit deferral.
- Every mobile screen group has a block or is covered inside a larger workflow block.
- Every block has at least one hardening task before V1 completion.
- Every block has validation evidence before it is marked complete.
