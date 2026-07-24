import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      "@hiraya/apps-sdk": fileURLToPath(new URL("../../packages/apps-sdk/src/index.ts", import.meta.url)),
    },
  },
});
