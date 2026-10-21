import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // esbuild는 데코레이터 메타데이터를 만들지 않으므로 SWC로 변환합니다.
  plugins: [swc.vite({ module: { type: "es6" } })],
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // 통합 테스트는 파일마다 별도 DB 스키마를 만듭니다.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
