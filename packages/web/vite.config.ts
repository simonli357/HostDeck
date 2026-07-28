import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const packageVersionPlaceholder = "__HOSTDECK_PACKAGE_VERSION__";
const exactVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const webRoot = fileURLToPath(new URL(".", import.meta.url));
const rootManifest = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8")
) as { readonly version?: unknown };

if (
  typeof rootManifest.version !== "string" ||
  !exactVersionPattern.test(rootManifest.version)
) {
  throw new TypeError("HostDeck web build requires one exact package version.");
}

export default defineConfig({
  base: "/",
  css: {
    postcss: {}
  },
  envDir: false,
  plugins: [
    react(),
    {
      name: "hostdeck-package-version",
      transformIndexHtml(html) {
        const first = html.indexOf(packageVersionPlaceholder);
        if (
          first === -1 ||
          html.indexOf(packageVersionPlaceholder, first + packageVersionPlaceholder.length) !== -1
        ) {
          throw new TypeError("HostDeck web index package-version marker is invalid.");
        }
        return html.replace(packageVersionPlaceholder, rootManifest.version as string);
      }
    }
  ],
  publicDir: false,
  root: webRoot,
  server: {
    host: "127.0.0.1"
  },
  preview: {
    host: "127.0.0.1"
  },
  build: {
    assetsDir: "assets",
    emptyOutDir: true,
    outDir: "dist",
    sourcemap: false
  }
});
