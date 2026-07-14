# IFC-V1-075 Remote Route Manifest Rebaseline

Date: 2026-07-13

Task: `IFC-V1-075`

Implementation evidence: `dddbf47`

## Outcome

The selected `/api/v1` manifest is now an exact 35-route contract. The former selected direct-LAN/certificate family is replaced by one remote status read and two explicit local-admin remote mutations:

| Route | Authority | Audit ownership |
| --- | --- | --- |
| `GET /api/v1/remote/status` | Paired device read | None; read-only |
| `POST /api/v1/remote/enable` | Loopback local admin | `remote_enable` |
| `POST /api/v1/remote/disable` | Loopback local admin | `remote_disable` |

Enable and disable accept exact confirmed operation bodies and return only the normalized public remote-ingress state. The manifest gives all three routes explicit schema, transport, authentication, authority, target, handler, and downstream ownership. It rejects browser profile mutation, Tailscale identity as application authority, unaudited mutation, mixed LAN/remote policy, and identity, credential, profile-detail, node-key, raw-output, pairing-code, or external-origin fields.

The former LAN route module now owns a frozen historical inventory instead of consulting the selected manifest. Its factories and certificate/service helpers are absent from the selected server package root. The active CLI parser, dispatch, local-admin client, renderer, help, and contract no longer expose `codexdeck lan`; historical source and tests remain isolated pending the broader custom-listener disposition in `IFC-V1-067`.

## Validation

Passed on implementation `dddbf47`:

- focused remote-ingress and selected-manifest contracts: 2 files/28 tests;
- focused CLI and historical-LAN behavior: 3 files/14 tests, including explicit unknown-command rejection for `lan`;
- root and affected package typechecks;
- `pnpm lint`: 349 files and all nine package exports;
- `pnpm vitest run --maxWorkers=2`: 116 files passed, 16 device-gated files skipped; 1,056 tests passed and 30 skipped;
- `pnpm test:contract`: 26 files/227 tests;
- `pnpm test:integration`: 2 files/16 tests;
- `pnpm test:web`: 2 files/14 tests;
- `pnpm check:scaffold`: nine packages and 18 root scripts;
- `pnpm check:planning`: 212 tasks, 84 requirements, 649 dependencies, and 20 queued tasks before closure synchronization;
- `git diff --check` and manual manifest/auth/audit/schema/export/CLI/privacy review.

One retained certificate-generating historical test exceeded the default five-second timeout only under the first full parallel suite. Its focused behavior passed; the test received a bounded 15-second test timeout and the complete suite then passed.

ADB reported no connected device during the full unit gate, so the 30 existing device-gated cases remained skipped. This contract task makes no physical-phone claim; `IFC-V1-079` owns production remote-phone acceptance.

## Explicit Non-Claims

- The three remote handlers, application service, and CLI commands are not implemented; `IFC-V1-076` owns them.
- Tailscale observation, Serve mutation, proxy/source trust, pairing-link composition, lifecycle assembly, and physical-phone behavior remain in `IFC-V1-071` to `IFC-V1-079`.
- Most selected manifest entries remain metadata until their route owners register them.
- Historical custom-listener composition is not the selected production entrypoint and remains owned by `IFC-V1-067`.
