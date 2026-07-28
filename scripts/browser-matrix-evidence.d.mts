import type { SupportedBrowserManifest } from "./browser-support-manifest.mjs";

export interface BrowserMatrixEvidenceBundle {
  readonly manifest: SupportedBrowserManifest;
  readonly reports: readonly Readonly<{
    file: string;
    report: Readonly<Record<string, unknown>>;
    sha256: string;
    text: string;
  }>[];
}

export const browserMatrixEvidenceArtifactRoot: string;
export function validateBuiltPackageIdentity(
  packageManifest: unknown,
  manifest?: SupportedBrowserManifest
): Readonly<Record<string, string>>;
export function readBrowserMatrixEvidence(
  evidenceRoot: string,
  manifest?: SupportedBrowserManifest
): BrowserMatrixEvidenceBundle;
export function parseBrowserMatrixProjectReport(
  candidate: unknown,
  manifest: SupportedBrowserManifest,
  projectId: string
): Readonly<Record<string, unknown>>;
export function createBrowserMatrixAggregate(
  bundle: BrowserMatrixEvidenceBundle,
  cleanup: Readonly<{
    web_servers_stopped: true;
    temporary_root_removed: true;
    playwright_output_removed: true;
  }>
): Readonly<Record<string, unknown>>;
export function publishBrowserMatrixEvidence(
  bundle: BrowserMatrixEvidenceBundle,
  aggregate: Readonly<Record<string, unknown>>,
  artifactRoot?: string
): void;
