import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * 운영 빌드에만 CSP를 넣습니다. (개발 서버는 HMR용 인라인 스크립트를 쓰므로 제외)
 * 외부 스크립트·외부 연결을 막아 XSS가 생겨도 토큰을 밖으로 보내기 어렵게 합니다.
 * 운영 웹 서버에서도 같은 정책과 frame-ancestors 'none'을 응답 헤더로 설정합니다.
 */
export const PORTAL_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

const productionCsp = (): Plugin => ({
  name: "drm-production-csp",
  apply: "build",
  transformIndexHtml: () => [
    {
      tag: "meta",
      attrs: { "http-equiv": "Content-Security-Policy", content: PORTAL_CSP },
      injectTo: "head-prepend",
    },
  ],
});

export default defineConfig({
  plugins: [react(), productionCsp()],
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
