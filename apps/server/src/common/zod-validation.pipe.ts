import { Injectable, type PipeTransform } from "@nestjs/common";
import type { ZodType } from "zod";
import { ApiException } from "./api-exception.js";

/**
 * @drm/contracts 의 zod 스키마로 요청 본문·파라미터를 검증합니다.
 * 사용: @Body(new ZodValidationPipe(CreateDistributionRequestSchema))
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new ApiException("VALIDATION_FAILED", "입력값이 올바르지 않습니다.", {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    return result.data;
  }
}
