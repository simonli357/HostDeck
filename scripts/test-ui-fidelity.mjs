#!/usr/bin/env node

import { runFidelityEvidence } from "./ui-fidelity-evidence.mjs";

const allowDirty = process.env.HOSTDECK_FIDELITY_ALLOW_DIRTY === "1";
const result = await runFidelityEvidence({ allowDirty });
process.stdout.write(
  `FE-V1-017 fidelity evidence passed at ${result.gitRevision}: ${result.deterministicFileCount} files, source clean=${result.sourceClean}.\n`
);
