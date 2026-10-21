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

export interface DistributionFixtureOptions {
  senderId: string;
  recipients: string[];
  validFrom?: Date;
  validUntil?: Date;
  revoked?: boolean;
  maxDevices?: number;
  maxViews?: number | null;
}

/** 배포 건과 수신자를 DB에 직접 생성 (API를 거치지 않는 준비용) */
export const createDistribution = async (ctx: TestContext, options: DistributionFixtureOptions) => {
  const prisma = ctx.app.get(PrismaService);
  const now = Date.now();
  return prisma.distribution.create({
    data: {
      title: "테스트 배포",
      createdById: options.senderId,
      validFrom: options.validFrom ?? new Date(now - 60_000),
      validUntil: options.validUntil ?? new Date(now + 30 * 24 * 3600_000),
      allowWeb: true,
      securityLevel: "NORMAL",
      offlineGraceHours: 0,
      maxViews: options.maxViews ?? null,
      maxDevices: options.maxDevices ?? 2,
      revokedAt: options.revoked ? new Date() : null,
      recipients: {
        create: options.recipients.map((email) => ({
          recipient: { connectOrCreate: { where: { email }, create: { email } } },
        })),
      },
    },
    include: { recipients: { include: { recipient: true } } },
  });
};

export const uniqueEmail = (prefix = "user") =>
  `${prefix}-${randomUUID().slice(0, 8)}@customer.co.kr`;

/** 패키징 완료 상태의 문서를 만들고 CEK를 서버 KMS로 래핑해 저장 (워커 없이 라이선스 테스트용) */
export const createPackagedDocument = async (
  ctx: TestContext,
  distributionId: string,
  overrides: { status?: "UPLOADED" | "CONVERTING" | "PACKAGED" | "FAILED" } = {},
) => {
  const { generateCek } = await import("@drm/crypto");
  const { KMS } = await import("../../src/keys/keys.module.js");
  const kms = ctx.app.get<import("@drm/kms").KmsProvider>(KMS);
  const prisma = ctx.app.get(PrismaService);
  const id = randomUUID();
  const cek = generateCek();
  const wrapped = await kms.wrapKey(cek, { docId: id });
  const document = await prisma.document.create({
    data: {
      id,
      distributionId,
      fileName: "도면.pdf",
      sourceFormat: "PDF",
      sourceSize: 1024n,
      status: overrides.status ?? "PACKAGED",
      contentType: "application/pdf",
      wrappedCek: Uint8Array.from(wrapped.ciphertext),
      kmsKeyId: wrapped.keyId,
    },
  });
  return { document, cek };
};
