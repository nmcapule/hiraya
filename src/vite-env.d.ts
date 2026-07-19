/// <reference types="vite/client" />

declare module "virtual:hiraya-predefined" {
  import type { PredefinedManifest } from "./lib/predefined-manifest";

  const manifest: PredefinedManifest | null;
  export default manifest;
}
