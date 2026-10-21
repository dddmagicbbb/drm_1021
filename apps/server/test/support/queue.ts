import type { PackagingJob } from "@drm/contracts";
import type { PackagingQueue } from "../../src/documents/packaging-queue.js";

/** 등록된 패키징 작업을 메모리에 보관하는 테스트용 큐 */
export class InMemoryPackagingQueue implements PackagingQueue {
  readonly jobs: PackagingJob[] = [];
  failNext = false;

  async enqueue(job: PackagingJob): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("Redis 연결 실패 (테스트)");
    }
    this.jobs.push(job);
  }
}
