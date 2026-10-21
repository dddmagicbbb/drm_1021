import type { INestApplication, Type } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createTestDatabase, type TestDatabase } from "@drm/db/testing";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureApp } from "../../src/app.factory.js";
import { AppModule } from "../../src/app.module.js";
import { loadEnv, type Env } from "../../src/config/env.js";
import { PACKAGING_QUEUE_TOKEN } from "../../src/documents/packaging-queue.js";
import { InMemoryPackagingQueue } from "./queue.js";

export interface TestContext {
  app: INestApplication;
  env: Env;
  /** 등록된 패키징 작업 (기본은 메모리 큐) */
  queue: InMemoryPackagingQueue;
  /** 테스트 전용 스키마에 직접 질의 (검증용) */
  query: TestDatabase["query"];
  close: () => Promise<void>;
}

export interface TestAppOptions {
  env?: Partial<Record<keyof Env, string>>;
  /** DI 토큰 → 대체 구현 (메일러 등) */
  providers?: [token: unknown, value: unknown][];
  /** 테스트 전용 모듈 (가드 검증용 컨트롤러 등) */
  imports?: Type[];
}

/**
 * 테스트 파일마다 독립된 PostgreSQL 스키마와 키링·저장소 디렉터리를 만들고 앱을 띄웁니다.
 * 종료 시 모두 삭제합니다.
 */
export const createTestApp = async (options: TestAppOptions = {}): Promise<TestContext> => {
  const base = loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent" });
  const db = await createTestDatabase(base.DATABASE_URL);
  const workDir = join(tmpdir(), "drm-test", db.schema);

  const env = loadEnv({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: db.url,
    // 테스트마다 별도 키링·저장소 (개발용 데이터를 건드리지 않음)
    KMS_KEYRING_PATH: join(workDir, "kms-keyring.json"),
    SIGNING_KEYRING_PATH: join(workDir, "signing-keyring.json"),
    STORAGE_DIR: join(workDir, "storage"),
    // 테스트는 X-Forwarded-For로 클라이언트 IP를 바꿔 IP 한도를 검증합니다.
    TRUST_PROXY_HOPS: "1",
    ...options.env,
  });

  let builder = Test.createTestingModule({
    imports: [AppModule.forRoot(env), ...(options.imports ?? [])],
  });
  // 기본적으로 Redis 대신 메모리 큐를 사용합니다. (options.providers로 덮어쓸 수 있음)
  const queue = new InMemoryPackagingQueue();
  builder = builder.overrideProvider(PACKAGING_QUEUE_TOKEN).useValue(queue);
  for (const [token, value] of options.providers ?? []) {
    builder = builder.overrideProvider(token).useValue(value);
  }
  const moduleRef = await builder.compile();
  const app = configureApp(moduleRef.createNestApplication({ bufferLogs: true }), env);
  await app.init();

  return {
    app,
    env,
    queue,
    query: db.query,
    close: async () => {
      await app.close();
      await db.drop();
      await rm(workDir, { recursive: true, force: true });
    },
  };
};
