import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 개발 중 API는 로컬 서버로 프록시합니다. (같은 출처로 동작 → CORS 불필요)
    proxy: { "/api": "http://127.0.0.1:3000" },
  },
  build: { sourcemap: false },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
