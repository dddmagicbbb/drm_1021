import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const CORRELATION_HEADER = "x-correlation-id";
const VALID_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 요청 추적 ID (NFR-O2)
 * 클라이언트가 보낸 값이 형식에 맞으면 그대로 쓰고, 아니면 새로 만듭니다.
 * pino-http의 genReqId로 사용되어 모든 로그와 오류 응답에 포함됩니다.
 */
export const correlationIdFor = (req: IncomingMessage, res: ServerResponse): string => {
  const incoming = req.headers[CORRELATION_HEADER];
  const id = typeof incoming === "string" && VALID_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader("X-Correlation-Id", id);
  return id;
};
