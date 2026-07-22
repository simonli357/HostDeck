import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: "tests/browser/fixtures",
  resolve: {
    alias: [
      {
        find: /^react$/u,
        replacement: webRuntime("react/index.js")
      },
      {
        find: /^react\/jsx-dev-runtime$/u,
        replacement: webRuntime("react/jsx-dev-runtime.js")
      },
      {
        find: /^react\/jsx-runtime$/u,
        replacement: webRuntime("react/jsx-runtime.js")
      },
      {
        find: /^react-dom\/client$/u,
        replacement: webRuntime("react-dom/client.js")
      },
      {
        find: /^react-router$/u,
        replacement: webRuntime("react-router/dist/development/index.js")
      }
    ]
  },
  server: {
    hmr: false,
    watch: null
  }
});

function webRuntime(path: string): string {
  return fileURLToPath(new URL(`./packages/web/node_modules/${path}`, import.meta.url));
}
