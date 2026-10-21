import { Inject, Injectable } from "@nestjs/common";
import type { TokenResponse } from "@drm/contracts";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { ApiException } from "../common/api-exception.js";
import { toBytes } from "../common/bytes.js";
import { ENV, type Env } from "../config/env.js";
import type { SubjectType } from "@drm/db";
import { PrismaService } from "../prisma/prisma.service.js";

/** access 토큰 유효 시간 (초) — docs/specs/license-api.md §2 */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
/** refresh 토큰 유효 시간 (초) */
export const REFRESH_TOKEN_TTL_SECONDS: Record<SubjectType, number> = {
  SENDER: 8 * 60 * 60,
  RECIPIENT: 7 * 24 * 60 * 60,
};

const ISSUER = "drm-1021";
const AUDIENCE = "drm-1021-api";
const CLAIM_TYPE: Record<SubjectType, "sender" | "recipient"> = {
  SENDER: "sender",
  RECIPIENT: "recipient",
};

export interface AuthSubject {
  type: SubjectType;
  id: string;
}

const hashToken = (token: string) => toBytes(createHash("sha256").update(token).digest());

/**
 * access 토큰(JWT)과 refresh 토큰(불투명, 해시 저장) 발급·검증
 * refresh 토큰은 사용할 때마다 회전하며, 이미 사용된 토큰이 다시 오면 계열 전체를 폐기합니다.
 */
@Injectable()
export class TokenService {
  private readonly secret: Uint8Array;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) env: Env,
  ) {
    this.secret = new TextEncoder().encode(env.JWT_SECRET);
  }

  /** 새 로그인: 새 토큰 계열을 시작합니다. */
  async issue(subject: AuthSubject): Promise<TokenResponse> {
    return this.issueInFamily(subject, randomUUID());
  }

  async verifyAccessToken(token: string, expected: SubjectType): Promise<AuthSubject> {
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ["HS256"],
      });
      if (payload["typ"] !== CLAIM_TYPE[expected] || typeof payload.sub !== "string") {
        throw new Error("토큰 유형 불일치");
      }
      return { type: expected, id: payload.sub };
    } catch {
      // 만료·서명 오류·유형 불일치를 구분하지 않고 401로 응답합니다.
      throw ApiException.unauthenticated("인증이 만료되었거나 올바르지 않습니다.");
    }
  }

  /** refresh 토큰 회전 */
  async rotate(refreshToken: string, expected: SubjectType): Promise<TokenResponse> {
    const invalid = () => ApiException.unauthenticated("다시 로그인해 주세요.");
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
    });
    if (!record || record.subjectType !== expected) throw invalid();

    if (record.usedAt || record.revokedAt) {
      // 이미 사용·폐기된 토큰 재사용 → 탈취 가능성. 계열 전체 폐기
      await this.revokeFamily(record.family);
      throw invalid();
    }
    if (record.expiresAt <= new Date()) throw invalid();

    // 동시 요청 경쟁 시 한쪽만 성공하도록 조건부 갱신
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { id: record.id, usedAt: null, revokedAt: null },
      data: { usedAt: new Date() },
    });
    if (count === 0) {
      await this.revokeFamily(record.family);
      throw invalid();
    }
    return this.issueInFamily({ type: record.subjectType, id: record.subjectId }, record.family);
  }

  async revokeFamily(family: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { family, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async issueInFamily(subject: AuthSubject, family: string): Promise<TokenResponse> {
    const accessToken = await new SignJWT({ typ: CLAIM_TYPE[subject.type] })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(subject.id)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setJti(randomUUID())
      .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
      .sign(this.secret);

    const refreshToken = randomBytes(32).toString("base64url");
    await this.prisma.refreshToken.create({
      data: {
        tokenHash: hashToken(refreshToken),
        family,
        subjectType: subject.type,
        subjectId: subject.id,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS[subject.type] * 1000),
      },
    });
    return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
  }
}
