import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { PACKAGING_QUEUE, type PackagingJob } from "@drm/contracts";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { ENV, type Env } from "../config/env.js";

/** 패키징 작업 등록. 테스트에서는 메모리 구현으로 대체합니다. */
export interface PackagingQueue {
  enqueue(job: PackagingJob): Promise<void>;
}

export const PACKAGING_QUEUE_TOKEN = Symbol("PACKAGING_QUEUE");

@Injectable()
export class BullPackagingQueue implements PackagingQueue, OnModuleDestroy {
  private readonly connection: Redis;
  private readonly queue: Queue<PackagingJob>;

  constructor(@Inject(ENV) env: Env) {
    // BullMQ 6은 ESM에서 생성된 클라이언트를 직접 넘겨야 합니다.
    this.connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    this.queue = new Queue<PackagingJob>(PACKAGING_QUEUE, {
      connection: this.connection,
      defaultJobOptions: {
        // 일시적 오류(DB·저장소)만 재시도합니다. 형식 오류 등은 워커가 즉시 실패 처리합니다.
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });
  }

  async enqueue(job: PackagingJob): Promise<void> {
    // jobId를 문서 ID로 고정해 같은 문서가 중복 등록되지 않게 합니다.
    await this.queue.add("package", job, { jobId: job.docId });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    // 외부에서 넘긴 연결은 BullMQ가 닫지 않습니다.
    await this.connection.quit();
  }
}
