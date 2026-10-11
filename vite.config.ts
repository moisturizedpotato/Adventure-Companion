import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createOverpassHandler } from "./server/overpass.mjs";
import { createElevenLabsHandler } from "./server/elevenlabs.mjs";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "wayfarer-nearby-api",
      configureServer(server) {
        const handleOverpassRequest = createOverpassHandler();
        const handleElevenLabsRequest = createElevenLabsHandler();
        server.middlewares.use((request, response, next) => {
          void (async () => await handleElevenLabsRequest(request, response) || await handleOverpassRequest(request, response))().then((handled) => {
            if (!handled) next();
          }, next);
        });
      },
    },
  ],
});
