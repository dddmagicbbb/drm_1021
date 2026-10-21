import type { NextFunction, Request, Response } from "express";

/**
 * API 응답 공통 보안 헤더
 * API는 JSON·파일만 반환하므로 브라우저가 문서로 해석·삽입하지 못하게 막습니다.
 * 토큰·문서 목록 등이 캐시에 남지 않도록 no-store를 기본으로 합니다.
 */
export const securityHeaders =
  (options: { hsts: boolean }) =>
  (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Cache-Control", "no-store");
    if (options.hsts) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  };
