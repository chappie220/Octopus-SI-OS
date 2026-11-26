import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const require = createRequire(import.meta.url);
const APP_DIR = path.dirname(fileURLToPath(import.meta.url));

function octopusClientServer(): Plugin {
  return {
    name: "octopus-client-server",
    configureServer(server) {
      const { createClientHttpApi } = require("./electron/clientHttpApi.cjs");
      const api = createClientHttpApi({ route: server.middlewares.use.bind(server.middlewares) });
      server.watcher.add(api.labFixturePath);
      server.watcher.on("change", (file) => {
        if (path.resolve(file) === api.labFixturePath) api.reloadFixture();
      });
      server.httpServer?.once("close", () => { void api.close(); });
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [tailwindcss(), react(), octopusClientServer(), {
    name: "support-development-csp",
    transformIndexHtml(html, context) {
      return context.server && context.filename === path.resolve(APP_DIR, "support.html")
        ? html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';")
        : html;
    },
  }],
  worker: { format: "es" },
  build: {
    rollupOptions: {
      input: { main: path.resolve(APP_DIR, "index.html"), support: path.resolve(APP_DIR, "support.html") },
      output: {
        manualChunks(id) {
          if (
            id.includes("/node_modules/react/")
            || id.includes("/node_modules/react-dom/")
            || id.includes("/node_modules/scheduler/")
          ) {
            return "react-vendor";
          }
          return undefined;
        },
      },
    },
  },
  server: { host: "127.0.0.1", port: 5174, fs: { strict: true, allow: [APP_DIR] } },
  preview: { host: "127.0.0.1", port: 4174 },
});
