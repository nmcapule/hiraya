import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { predefinedDesktopPlugin } from "./build/predefined";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "HIRAYA_");
  return {
    plugins: [
      predefinedDesktopPlugin(process.cwd(), env.HIRAYA_PREDEFINED_DIR),
      react(),
      VitePWA({
        injectRegister: "auto",
        includeAssets: ["favicon.svg", "apple-touch-icon.png"],
        manifest: {
          name: "Hiraya Desktop",
          short_name: "Hiraya",
          description: "A private, browser-native desktop for your files.",
          theme_color: "#24333b",
          background_color: "#172329",
          display: "standalone",
          start_url: ".",
          scope: ".",
          icons: [
            { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
            { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
            { src: "pwa-maskable-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          ],
        },
        workbox: {
          globPatterns: ["**/*.{js,css,html,ico,png,svg,webmanifest}"],
        },
      }),
    ],
    server: {
      allowedHosts: [".exe.xyz"],
      proxy: {
        "/api": "http://127.0.0.1:8080",
      },
    },
  };
});
