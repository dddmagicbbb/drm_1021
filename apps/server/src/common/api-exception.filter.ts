import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { ApiError } from "@drm/contracts";
import type { Request, Response } from "express";
import { Prisma } from "@drm/db";
import { ApiException } from "./api-exception.js";

/** HttpException 상태 → 공통 오류 코드 (프레임워크가 던지는 404, 413 등 대응) */
const codeForHttpStatus = (status: number): ApiError["error"]["code"] => {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
    case HttpStatus.PAYLOAD_TOO_LARGE:
    case HttpStatus.UNSUPPORTED_MEDIA_TYPE:
      return "VALIDATION_FAILED";
    case HttpStatus.UNAUTHORIZED:
      return "UNAUTHENTICATED";
    case HttpStatus.FORBIDDEN:
      return "FORBIDDEN";
    case HttpStatus.NOT_FOUND:
      return "NOT_FOUND";
    case HttpStatus.CONFLICT:
      return "CONFLICT";
    case HttpStatus.TOO_MANY_REQUESTS:
      return "RATE_LIMITED";
    default:
      return "INTERNAL_ERROR";
  }
};

/**
 * 모든 예외를 ApiErrorSchema 형식으로 응답합니다.
 * 예상하지 못한 오류는 상세 내용을 로그에만 남기고 클라이언트에는 노출하지 않습니다.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request & { id?: string }>();
    const res = http.getResponse<Response>();
    const correlationId = typeof req.id === "string" ? req.id : null;

    let status: number;
    let body: ApiError;

    if (exception instanceof ApiException) {
      status = exception.status;
      body = {
        error: {
          code: exception.code,
          message: exception.message,
          correlationId,
          ...exception.extra,
        },
      };
    } else if (
      exception instanceof Prisma.PrismaClientKnownRequestError &&
      exception.code === "P2002"
    ) {
      // 유니크 제약 위반: 동시 요청 경쟁 등. 어떤 컬럼인지는 노출하지 않습니다.
      status = HttpStatus.CONFLICT;
      body = {
        error: { code: "CONFLICT", message: "이미 존재하는 데이터와 충돌합니다.", correlationId },
      };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const code = codeForHttpStatus(status);
      body = {
        error: {
          code,
          message: code === "INTERNAL_ERROR" ? "서버 오류가 발생했습니다." : exception.message,
          correlationId,
        },
      };
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      this.logger.error({ err: exception, correlationId }, "처리되지 않은 예외");
      body = {
        error: { code: "INTERNAL_ERROR", message: "서버 오류가 발생했습니다.", correlationId },
      };
    }

    if (exception instanceof HttpException && status >= 500) {
      this.logger.error({ err: exception, correlationId }, "서버 오류 응답");
    }
    res.status(status).json(body);
  }
}
