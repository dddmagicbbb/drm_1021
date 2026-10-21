import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: "src/renderer",
  // file:// 로 로드되므로 상대 경로 사용
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
    sourcemap: false,
  },
  test: {
    root: ".",
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
    setupFiles: ["./src/renderer/test-setup.ts"],
    testTimeout: 30_000,
  },
});
