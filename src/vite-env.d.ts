/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly HIRAYA_FRONTEND_ONLY: string;
}

declare module "virtual:hiraya-predefined" {
  import type { PredefinedManifest } from "./lib/predefined-manifest";

  const manifest: PredefinedManifest | null;
  export default manifest;
}
