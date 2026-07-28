import type {
  SupportedBrowserManifest,
  SupportedBrowserName
} from "./browser-support-manifest.mjs";

interface BrowserPort {
  version(): string;
  close(): Promise<void>;
}

interface BrowserTypePort {
  executablePath(): string;
  launch(options: Readonly<{ headless: true }>): Promise<BrowserPort>;
}

interface ExecutableInspection {
  readonly pathSegments: readonly string[];
  readonly regularFile: boolean;
  readonly symbolicLink: boolean;
  readonly executable: boolean;
}

export interface SupportedBrowserRuntimeInspection {
  readonly schema_version: 1;
  readonly playwright_version: string;
  readonly platform: string;
  readonly architecture: string;
  readonly engines: readonly Readonly<{
    browser_name: SupportedBrowserName;
    browser_version: string;
    revision: string;
  }>[];
}

export function inspectSupportedBrowserRuntime(options?: Readonly<{
  manifest?: SupportedBrowserManifest;
  platform?: string;
  architecture?: string;
  playwrightVersion?: string;
  browserTypes?: Readonly<Record<SupportedBrowserName, BrowserTypePort>>;
  inspectExecutable?: (path: string) => ExecutableInspection;
}>): Promise<SupportedBrowserRuntimeInspection>;
