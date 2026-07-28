export type SupportedBrowserName = "chromium" | "firefox";
export type SupportedBrowserProjectId =
  | "chromium-phone"
  | "chromium-desktop"
  | "firefox-phone"
  | "firefox-desktop";

export interface SupportedBrowserEngine {
  readonly browser_name: SupportedBrowserName;
  readonly browser_version: string;
  readonly revision: string;
  readonly executable_directory_markers: readonly string[];
}

export interface SupportedBrowserProject {
  readonly id: SupportedBrowserProjectId;
  readonly browser_name: SupportedBrowserName;
  readonly regime: "phone" | "desktop";
  readonly viewport: Readonly<{ width: number; height: number }>;
  readonly has_touch: boolean;
  readonly is_mobile: boolean;
  readonly input_modes: readonly ("keyboard" | "pointer" | "touch")[];
}

export interface SupportedBrowserManifest {
  readonly schema_version: 1;
  readonly name: "hostdeck-supported-browser-matrix";
  readonly task_id: "FE-V1-040";
  readonly playwright_version: "1.61.1";
  readonly platform: "linux";
  readonly architecture: "x64";
  readonly evidence_schema_version: 1;
  readonly package: Readonly<{
    package_version: "0.0.0";
    content_sha256: string;
    manifest_sha256: string;
    web_sha256: string;
    web_manifest_sha256: string;
  }>;
  readonly engines: readonly SupportedBrowserEngine[];
  readonly projects: readonly SupportedBrowserProject[];
  readonly scenarios: readonly Readonly<{
    id: string;
    interaction_ids: readonly string[];
  }>[];
  readonly automated_interaction_ids: readonly string[];
}

export const supportedBrowserManifestPath: string;
export function readSupportedBrowserManifest(path?: string): SupportedBrowserManifest;
export function parseSupportedBrowserManifest(candidate: unknown): SupportedBrowserManifest;
