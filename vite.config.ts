import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { predefinedDesktopPlugin } from "./build/predefined";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "HIRAYA_");
  return {
    plugins: [predefinedDesktopPlugin(process.cwd(), env.HIRAYA_PREDEFINED_DIR), react()],
    server: {
      allowedHosts: [".exe.xyz"],
    },
  };
});
