import { PACKAGING_QUEUE } from "@drm/contracts";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";
import { BullPackagingQueue } from "../src/documents/packaging-queue.js";

describe("BullPackagingQueue (Redis)", () => {
  it("문서 ID를 jobId로 등록하고 같은 문서는 중복 등록하지 않는다", async () => {
    const env = loadEnv({ NODE_ENV: "test" });
    const producer = new BullPackagingQueue(env);
    const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    const inspector = new Queue(PACKAGING_QUEUE, { connection: redis });
    const docId = randomUUID();
    try {
      await producer.enqueue({ docId });
      await producer.enqueue({ docId });
      const job = await inspector.getJob(docId);
      expect(job?.data).toEqual({ docId });
      expect(job?.opts.attempts).toBe(3);
      await job?.remove();
    } finally {
      await producer.onModuleDestroy();
      await inspector.close();
      await redis.quit();
    }
  });
});
