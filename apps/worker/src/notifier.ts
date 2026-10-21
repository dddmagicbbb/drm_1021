/**
 * 수신자 안내 메일 (FR-104)
 * 배포 건의 문서 처리가 모두 끝나면, 아직 안내하지 않은 문서를 묶어 수신자마다 한 번 발송합니다.
 */
import type { PrismaClient } from "@drm/db";
import nodemailer from "nodemailer";
import type { Logger } from "pino";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export const createSmtpMailer = (options: {
  host: string;
  port: number;
  user?: string;
  password?: string;
  from: string;
}): Mailer & { close(): void } => {
  const transport = nodemailer.createTransport({
    host: options.host,
    port: options.port,
    secure: options.port === 465,
    ...(options.user ? { auth: { user: options.user, pass: options.password } } : {}),
  });
  return {
    send: async (message) => {
      await transport.sendMail({ from: options.from, ...message });
    },
    close: () => transport.close(),
  };
};

const KST = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  dateStyle: "long",
  timeStyle: "short",
});

export interface NotifierDeps {
  prisma: PrismaClient;
  mailer: Mailer;
  logger: Logger;
  viewerDownloadUrl: string;
}

export class Notifier {
  constructor(private readonly deps: NotifierDeps) {}

  /**
   * 문서가 속한 배포 건의 처리가 모두 끝났으면 안내 메일을 보냅니다.
   * @returns 발송한 메일 수
   */
  async notifyForDocument(docId: string): Promise<number> {
    const { prisma, logger } = this.deps;
    const doc = await prisma.document.findUnique({
      where: { id: docId },
      select: { distributionId: true },
    });
    if (!doc) return 0;
    const { distributionId } = doc;

    // 여러 문서가 동시에 끝나도 한 번만 보내도록, 잠금 안에서 대상 문서를 선점합니다.
    const claimed = await prisma.$transaction(async (tx) => {
      const lockKey = `notify:${distributionId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const pending = await tx.document.count({
        where: { distributionId, status: { in: ["UPLOADED", "CONVERTING"] } },
      });
      if (pending > 0) return null;

      const now = new Date();
      const distribution = await tx.distribution.findUnique({
        where: { id: distributionId },
        include: {
          createdBy: true,
          recipients: { where: { revokedAt: null }, include: { recipient: true } },
        },
      });
      if (!distribution || distribution.revokedAt || distribution.validUntil <= now) return null;

      const documents = await tx.document.findMany({
        where: { distributionId, status: "PACKAGED", revokedAt: null, notifiedAt: null },
        orderBy: { createdAt: "asc" },
      });
      if (documents.length === 0) return null;
      await tx.document.updateMany({
        where: { id: { in: documents.map((d) => d.id) } },
        data: { notifiedAt: now },
      });
      return { distribution, documents };
    });
    if (!claimed) return 0;

    const { distribution, documents } = claimed;
    let sent = 0;
    for (const { recipient } of distribution.recipients) {
      try {
        await this.deps.mailer.send({
          to: recipient.email,
          subject: `[DRM] ${distribution.createdBy.name}님이 문서를 보냈습니다: ${distribution.title}`,
          text: [
            `${distribution.createdBy.name}(${distribution.createdBy.email})님이 보안 문서를 보냈습니다.`,
            "",
            `■ 배포 제목: ${distribution.title}`,
            `■ 열람 기간: ${KST.format(distribution.validFrom)} ~ ${KST.format(distribution.validUntil)}`,
            "■ 문서",
            ...documents.map((d) => `  - ${d.fileName}`),
            "",
            "■ 열람 방법",
            `  1. 전용 뷰어를 설치합니다: ${this.deps.viewerDownloadUrl}`,
            `  2. 뷰어에서 이 메일 주소(${recipient.email})로 로그인합니다. (인증 코드가 메일로 발송됩니다)`,
            "  3. 문서 목록에서 문서를 선택해 열람합니다.",
            "",
            "문서는 등록된 수신자만 열람 기간 내에 볼 수 있으며, 저장·인쇄·복사가 제한됩니다.",
            `문의: ${distribution.createdBy.name} <${distribution.createdBy.email}>`,
          ].join("\n"),
        });
        sent += 1;
      } catch (error) {
        logger.error(
          { err: error, distributionId, recipientId: recipient.id },
          "안내 메일 발송 실패",
        );
      }
    }

    if (sent === 0 && distribution.recipients.length > 0) {
      // 전부 실패하면 선점을 풀어 다음 처리 때 다시 시도합니다.
      await prisma.document.updateMany({
        where: { id: { in: documents.map((d) => d.id) } },
        data: { notifiedAt: null },
      });
    }
    logger.info({ distributionId, documents: documents.length, sent }, "안내 메일 발송");
    return sent;
  }
}
