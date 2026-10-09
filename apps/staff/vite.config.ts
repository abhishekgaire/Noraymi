import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API is same-origin in development: /v1 is proxied to the API on port
// 3000 (unless STAFF_API_URL names another, as the isolated browser tests do),
// so the session cookie travels with every call and with the WebSocket.
// Staging and production put the staff app and the API behind one hostname.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/v1": { target: process.env["STAFF_API_URL"] ?? "http://127.0.0.1:3000", ws: true },
    },
  },
});
