import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API is same-origin in development: /v1 is proxied to the API on port
// 3000, so the Console's cookies stay first-party, as they are on its own
// hostname in staging and production.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/v1": { target: "http://127.0.0.1:3000", ws: true },
    },
  },
});
