import { Injectable, type NestMiddleware } from "@nestjs/common";
import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";

export interface RequestContext {
  correlationId: string | null;
  ip: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** 현재 요청의 추적 ID·IP. 요청 밖(배치, 워커)에서는 null 값을 반환합니다. */
export const currentRequestContext = (): RequestContext =>
  storage.getStore() ?? { correlationId: null, ip: null };

/**
 * 요청마다 컨텍스트를 만들어 이후 서비스 계층(감사 로그 등)에서 참조할 수 있게 합니다.
 * pino-http가 먼저 req.id(correlation ID)를 설정합니다.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request & { id?: unknown }, _res: Response, next: NextFunction): void {
    const context: RequestContext = {
      correlationId: typeof req.id === "string" ? req.id : null,
      ip: req.ip ?? req.socket.remoteAddress ?? null,
    };
    storage.run(context, next);
  }
}
