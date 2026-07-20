/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly HIRAYA_FRONTEND_ONLY: string;
}

declare module "virtual:hiraya-seeded" {
  import type { SeededManifest } from "./lib/seeded-manifest";

  const manifest: SeededManifest | null;
  export default manifest;
}
