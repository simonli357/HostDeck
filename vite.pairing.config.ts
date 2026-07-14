import { defineConfig } from "vite";

export default defineConfig({
  root: "tests/browser/fixtures",
  server: {
    hmr: false,
    watch: null
  }
});
