import { Inject, Injectable, Logger } from "@nestjs/common";
import { OTP_LENGTH, type TokenResponse } from "@drm/contracts";
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { AuditService } from "../audit/audit.service.js";
import { ApiException } from "../common/api-exception.js";
import { toBytes } from "../common/bytes.js";
import { currentRequestContext } from "../common/request-context.js";
import { ENV, type Env } from "../config/env.js";
import { MAILER, type Mailer } from "../mail/mailer.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { TokenService } from "./token.service.js";

/** docs/specs/license-api.md §3.2 OTP 규칙 */
export const OTP_TTL_MS = 5 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_LIMIT_PER_EMAIL_PER_HOUR = 5;
export const OTP_LIMIT_PER_IP_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;

type NotSentReason = "NOT_ELIGIBLE" | "EMAIL_RATE_LIMITED" | "IP_RATE_LIMITED" | "MAIL_FAILED";

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  private readonly pepper: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(ENV) env: Env,
  ) {
    this.pepper = env.OTP_PEPPER;
  }

  /**
   * OTP 발급 요청
   * 계정 존재 여부를 드러내지 않도록 결과와 관계없이 반환값이 없습니다. (컨트롤러는 항상 202)
   */
  async request(email: string): Promise<void> {
    const { ip } = currentRequestContext();
    const notSent = async (reason: NotSentReason) => {
      await this.audit.record({
        type: "OTP_REQUESTED",
        actorType: "RECIPIENT",
        detail: { email, sent: false, reason },
      });
    };

    const recipient = await this.findEligibleRecipient(email);
    if (!recipient) return notSent("NOT_ELIGIBLE");

    const since = new Date(Date.now() - HOUR_MS);
    const [byEmail, byIp] = await Promise.all([
      this.prisma.otpChallenge.count({ where: { email, createdAt: { gte: since } } }),
      ip ? this.prisma.otpChallenge.count({ where: { ip, createdAt: { gte: since } } }) : 0,
    ]);
    if (byEmail >= OTP_LIMIT_PER_EMAIL_PER_HOUR) return notSent("EMAIL_RATE_LIMITED");
    if (byIp >= OTP_LIMIT_PER_IP_PER_HOUR) return notSent("IP_RATE_LIMITED");

    const code = randomInt(0, 10 ** OTP_LENGTH)
      .toString()
      .padStart(OTP_LENGTH, "0");
    await this.prisma.$transaction([
      // 새 OTP를 발급하면 이전 OTP는 무효
      this.prisma.otpChallenge.updateMany({
        where: { email, consumedAt: null },
        data: { consumedAt: new Date() },
      }),
      this.prisma.otpChallenge.create({
        data: {
          email,
          codeHash: this.hash(email, code),
          expiresAt: new Date(Date.now() + OTP_TTL_MS),
          ip,
        },
      }),
    ]);

    try {
      await this.mailer.send({
        to: email,
        subject: "[DRM] 문서 열람 인증 코드",
        text: [
          "문서 열람을 위한 인증 코드입니다.",
          "",
          `인증 코드: ${code}`,
          "",
          `이 코드는 ${OTP_TTL_MS / 60000}분 동안 유효하며 한 번만 사용할 수 있습니다.`,
          "본인이 요청하지 않았다면 이 메일을 무시하세요.",
        ].join("\n"),
      });
    } catch (error) {
      this.logger.error({ err: error }, "OTP 메일 발송 실패");
      return notSent("MAIL_FAILED");
    }

    await this.audit.record({
      type: "OTP_REQUESTED",
      actorType: "RECIPIENT",
      recipientId: recipient.id,
      detail: { email, sent: true },
    });
  }

  /** OTP 검증 후 수신자 토큰 발급 */
  async verify(email: string, code: string): Promise<TokenResponse> {
    const fail = async (
      errorCode: "OTP_INVALID" | "OTP_EXPIRED" | "OTP_ATTEMPTS_EXCEEDED",
      message: string,
    ): Promise<never> => {
      await this.audit.record({
        type: "OTP_FAILED",
        actorType: "RECIPIENT",
        detail: { email, reason: errorCode },
      });
      throw new ApiException(errorCode, message);
    };

    const challenge = await this.prisma.otpChallenge.findFirst({
      where: { email, consumedAt: null },
      orderBy: { createdAt: "desc" },
    });
    if (!challenge) return fail("OTP_INVALID", "인증 코드가 올바르지 않습니다.");
    if (challenge.expiresAt <= new Date()) {
      return fail("OTP_EXPIRED", "인증 코드가 만료되었습니다. 다시 요청해 주세요.");
    }

    // 비교 전에 시도 횟수를 원자적으로 증가시켜 병렬 요청으로 횟수 제한을 우회하지 못하게 합니다.
    const { count } = await this.prisma.otpChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null, attempts: { lt: OTP_MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    if (count === 0) {
      return fail("OTP_ATTEMPTS_EXCEEDED", "인증 시도 횟수를 초과했습니다. 다시 요청해 주세요.");
    }

    const expected = Buffer.from(challenge.codeHash);
    const actual = this.hash(email, code);
    if (!timingSafeEqual(expected, actual)) {
      if (challenge.attempts + 1 >= OTP_MAX_ATTEMPTS) {
        await this.prisma.otpChallenge.update({
          where: { id: challenge.id },
          data: { consumedAt: new Date() },
        });
        return fail("OTP_ATTEMPTS_EXCEEDED", "인증 시도 횟수를 초과했습니다. 다시 요청해 주세요.");
      }
      return fail("OTP_INVALID", "인증 코드가 올바르지 않습니다.");
    }

    // 1회용: 동시에 같은 코드로 들어온 요청 중 하나만 성공
    const consumed = await this.prisma.otpChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    const recipient = await this.prisma.recipient.findUnique({ where: { email } });
    if (consumed.count === 0 || !recipient) {
      return fail("OTP_INVALID", "인증 코드가 올바르지 않습니다.");
    }

    const tokens = await this.tokens.issue({ type: "RECIPIENT", id: recipient.id });
    await this.audit.record({
      type: "OTP_VERIFIED",
      actorType: "RECIPIENT",
      actorId: recipient.id,
      recipientId: recipient.id,
      detail: { email },
    });
    return tokens;
  }

  /** 열람 가능한(회수·만료되지 않은) 배포 건의 수신자인 경우에만 반환 */
  private findEligibleRecipient(email: string) {
    return this.prisma.recipient.findFirst({
      where: {
        email,
        distributions: {
          some: {
            revokedAt: null,
            distribution: { revokedAt: null, validUntil: { gt: new Date() } },
          },
        },
      },
      select: { id: true },
    });
  }

  private hash(email: string, code: string) {
    return toBytes(
      createHmac("sha256", this.pepper).update(email).update("\0").update(code).digest(),
    );
  }
}
