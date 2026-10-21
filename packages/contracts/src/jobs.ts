import { z } from "zod";
import { IdSchema } from "./common.js";

/** 서버 → 변환 워커 작업 큐 (BullMQ) */
export const PACKAGING_QUEUE = "packaging" as const;

export const PackagingJobSchema = z.object({
  docId: IdSchema,
});
export type PackagingJob = z.infer<typeof PackagingJobSchema>;
