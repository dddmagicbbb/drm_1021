import { config } from "dotenv";
import { defineConfig } from "prisma/config";

// 저장소 루트의 .env를 사용합니다. (apps/server 에서 실행 기준)
config({ path: ["../../.env", ".env"], quiet: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // prisma generate는 DB 접속이 필요 없으므로 CI 등에서 미설정을 허용합니다.
    url: process.env.DATABASE_URL ?? "",
  },
});
