import { randomUUID } from "node:crypto";
import request from "supertest";
import { hashPassword } from "../../src/auth/password.js";
import { TokenService } from "../../src/auth/token.service.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";
import type { TestContext } from "./test-app.js";

export const TEST_PASSWORD = "correct-horse-battery-staple";

/** 발신자 계정 생성 */
export const createSender = async (
  ctx: TestContext,
  overrides: { email?: string; name?: string; disabled?: boolean } = {},
) => {
  const prisma = ctx.app.get(PrismaService);
  return prisma.user.create({
    data: {
      email: overrides.email ?? `sender-${randomUUID().slice(0, 8)}@company.com`,
      name: overrides.name ?? "홍길동",
      passwordHash: await hashPassword(TEST_PASSWORD),
      disabledAt: overrides.disabled ? new Date() : null,
    },
  });
};

/** 발신자 로그인 후 Authorization 헤더 값 */
export const senderAuthHeader = async (ctx: TestContext, email: string): Promise<string> => {
  const res = await request(ctx.app.getHttpServer())
    .post("/api/v1/auth/login")
    .send({ email, password: TEST_PASSWORD });
  if (res.status !== 200) throw new Error(`로그인 실패: ${res.status} ${JSON.stringify(res.body)}`);
  return `Bearer ${res.body.accessToken as string}`;
};

/** 수신자 토큰 직접 발급 (OTP 흐름을 거치지 않는 테스트용) */
export const recipientAuthHeader = async (ctx: TestContext, recipientId: string) => {
  const tokens = await ctx.app.get(TokenService).issue({ type: "RECIPIENT", id: recipientId });
  return `Bearer ${tokens.accessToken}`;
};
