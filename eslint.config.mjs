// 저장소 공통 ESLint 설정 (flat config)
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/.turbo/**",
      "**/generated/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    // NestJS DI는 생성자 파라미터 타입의 런타임 참조가 필요합니다.
    // type-only import로 자동 변환되면 주입이 깨지므로 서버에서는 해제합니다.
    files: ["apps/server/**/*.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "off",
    },
  },
  {
    // Node에서 직접 실행하는 빌드 스크립트
    files: ["**/scripts/**/*.mjs", "eslint.config.mjs"],
    languageOptions: {
      globals: { process: "readonly", Buffer: "readonly", console: "readonly", fetch: "readonly" },
    },
  },
  {
    // Electron sandbox preload는 CommonJS여야 하므로 import = require 문법을 허용합니다.
    files: ["**/*.cts"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
