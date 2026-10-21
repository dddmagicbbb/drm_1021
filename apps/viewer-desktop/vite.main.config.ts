import { builtinModules } from "node:module";
import { defineConfig } from "vite";

/**
 * main 프로세스 번들 (설치 패키지에 node_modules를 넣지 않기 위해 의존성을 모두 포함)
 * electron과 Node 내장 모듈만 외부로 둡니다.
 */
export default defineConfig({
  build: {
    outDir: "dist/main",
    emptyOutDir: true,
    target: "node22",
    minify: true,
    sourcemap: false,
    ssr: "src/main/main.ts",
    rollupOptions: {
      external: ["electron", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
      output: { format: "es", entryFileNames: "main.js" },
    },
  },
  ssr: { noExternal: true },
});
