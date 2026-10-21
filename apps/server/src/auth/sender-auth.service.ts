import { Injectable } from "@nestjs/common";
import type { SenderLoginRequest, TokenResponse } from "@drm/contracts";
import { AuditService } from "../audit/audit.service.js";
import { ApiException } from "../common/api-exception.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { verifyPassword } from "./password.js";
import { TokenService } from "./token.service.js";

/** 로그인 실패 제한: 이메일 기준 LOCKOUT_WINDOW 동안 MAX_FAILURES회 실패 시 차단 */
export const MAX_LOGIN_FAILURES = 10;
export const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

@Injectable()
export class SenderAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  async login({ email, password }: SenderLoginRequest): Promise<TokenResponse> {
    const recentFailures = await this.prisma.auditEvent.count({
      where: {
        type: "SENDER_LOGIN_FAILED",
        occurredAt: { gte: new Date(Date.now() - LOCKOUT_WINDOW_MS) },
        detail: { path: ["email"], equals: email },
      },
    });
    if (recentFailures >= MAX_LOGIN_FAILURES) {
      await this.audit.record({
        type: "SENDER_LOGIN_FAILED",
        actorType: "SENDER",
        detail: { email, reason: "LOCKED" },
      });
      throw new ApiException("RATE_LIMITED", "로그인 실패가 많아 잠시 후 다시 시도해 주세요.");
    }

    const user = await this.prisma.user.findUnique({ where: { email } });
    const valid = await verifyPassword(user?.passwordHash, password);
    if (!user || !valid || user.disabledAt) {
      await this.audit.record({
        type: "SENDER_LOGIN_FAILED",
        actorType: "SENDER",
        actorId: user?.id ?? null,
        detail: { email, reason: user?.disabledAt ? "DISABLED" : "INVALID_CREDENTIALS" },
      });
      // 계정 존재·비활성 여부를 구분하지 않습니다.
      throw ApiException.unauthenticated("이메일 또는 비밀번호가 올바르지 않습니다.");
    }

    const tokens = await this.tokens.issue({ type: "SENDER", id: user.id });
    await this.audit.record({
      type: "SENDER_LOGIN_SUCCEEDED",
      actorType: "SENDER",
      actorId: user.id,
      detail: { email },
    });
    return tokens;
  }
}
