import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// API calls go to the orchestrator; override with VITE_API_URL.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": process.env.VITE_API_URL ?? "http://127.0.0.1:4000",
    },
  },
});
