import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import pg from "pg";
import { configureApp } from "../../src/app.factory.js";
import { AppModule } from "../../src/app.module.js";
import { loadEnv, type Env } from "../../src/config/env.js";

export interface TestContext {
  app: INestApplication;
  env: Env;
  /** 테스트 전용 스키마에 직접 질의 (검증용) */
  query: <T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: unknown[],
  ) => Promise<pg.QueryResult<T>>;
  close: () => Promise<void>;
}

export interface TestAppOptions {
  env?: Partial<Record<keyof Env, string>>;
  /** DI 토큰 → 대체 구현 (메일러 등) */
  providers?: [token: unknown, value: unknown][];
}

/**
 * 테스트 파일마다 독립된 PostgreSQL 스키마를 만들고 마이그레이션을 적용한 뒤 앱을 띄웁니다.
 * 종료 시 스키마를 삭제합니다. (감사 로그 트리거 때문에 TRUNCATE로 정리할 수 없음)
 */
export const createTestApp = async (options: TestAppOptions = {}): Promise<TestContext> => {
  const base = loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent" });
  const schema = `test_${randomBytes(6).toString("hex")}`;
  const url = new URL(base.DATABASE_URL);
  url.searchParams.set("schema", schema);
  const databaseUrl = url.toString();

  // 셸을 거치지 않고 Prisma CLI를 현재 Node로 직접 실행합니다.
  const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js");
  execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
  });

  const env = loadEnv({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: databaseUrl,
    ...options.env,
  });

  let builder = Test.createTestingModule({ imports: [AppModule.forRoot(env)] });
  for (const [token, value] of options.providers ?? []) {
    builder = builder.overrideProvider(token).useValue(value);
  }
  const moduleRef = await builder.compile();
  const app = configureApp(moduleRef.createNestApplication({ bufferLogs: true }));
  await app.init();

  const admin = new pg.Client({ connectionString: base.DATABASE_URL });
  await admin.connect();
  await admin.query(`SET search_path TO "${schema}"`);

  return {
    app,
    env,
    query: (sql, params) => admin.query(sql, params as unknown[]),
    close: async () => {
      await app.close();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    },
  };
};
