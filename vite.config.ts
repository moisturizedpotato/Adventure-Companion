import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createOverpassHandler } from "./server/overpass.mjs";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "wayfarer-nearby-api",
      configureServer(server) {
        const handleOverpassRequest = createOverpassHandler();
        server.middlewares.use((request, response, next) => {
          void handleOverpassRequest(request, response).then((handled) => {
            if (!handled) next();
          }, next);
        });
      },
    },
  ],
});
