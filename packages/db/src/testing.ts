/**
 * 테스트 전용: 격리된 PostgreSQL 스키마 생성·삭제
 * 운영 코드에서 import하지 않습니다. (@drm/db/testing)
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export interface TestDatabase {
  /** 테스트 스키마를 가리키는 DATABASE_URL */
  url: string;
  schema: string;
  /** 테스트 스키마에 직접 질의 (검증용) */
  query: <T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: unknown[],
  ) => Promise<pg.QueryResult<T>>;
  /** 스키마 삭제 (감사 로그 트리거 때문에 TRUNCATE로 정리할 수 없음) */
  drop: () => Promise<void>;
}

/** dist/testing.js 기준 패키지 루트 */
const packageDir = fileURLToPath(new URL("../", import.meta.url));

/** 무작위 스키마를 만들고 마이그레이션을 적용합니다. */
export const createTestDatabase = async (baseUrl: string): Promise<TestDatabase> => {
  const schema = `test_${randomBytes(6).toString("hex")}`;
  const url = new URL(baseUrl);
  url.searchParams.set("schema", schema);

  // 셸을 거치지 않고 Prisma CLI를 현재 Node로 직접 실행합니다.
  const prismaCli = createRequire(join(packageDir, "package.json")).resolve(
    "prisma/build/index.js",
  );
  execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: packageDir,
    env: { ...process.env, DATABASE_URL: url.toString() },
    stdio: "pipe",
  });

  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`SET search_path TO "${schema}"`);

  return {
    url: url.toString(),
    schema,
    query: (sql, params) => admin.query(sql, params as unknown[]),
    drop: async () => {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    },
  };
};
