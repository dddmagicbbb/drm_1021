import { type PrismaClient, createPrismaClient } from "@drm/db";
import { type TestDatabase, createTestDatabase } from "@drm/db/testing";
import { randomUUID } from "node:crypto";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadWorkerEnv } from "../src/env.js";
import { type MailMessage, Notifier } from "../src/notifier.js";

describe("수신자 안내 메일 (T1-16)", () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let notifier: Notifier;
  let senderId: string;
  const sent: MailMessage[] = [];
  let failSends = false;

  type Status = "UPLOADED" | "CONVERTING" | "PACKAGED" | "FAILED";

  const distribution = async (
    statuses: Status[],
    options: { recipients?: string[]; revokedRecipient?: string; revoked?: boolean } = {},
  ) => {
    const recipients = options.recipients ?? [`a-${randomUUID()}@c.kr`, `b-${randomUUID()}@c.kr`];
    const dist = await prisma.distribution.create({
      data: {
        title: "A사 도면",
        createdById: senderId,
        validFrom: new Date(Date.now() - 1000),
        validUntil: new Date(Date.now() + 86400_000),
        allowWeb: true,
        securityLevel: "NORMAL",
        offlineGraceHours: 0,
        maxDevices: 2,
        revokedAt: options.revoked ? new Date() : null,
        recipients: {
          create: recipients.map((email) => ({
            revokedAt: email === options.revokedRecipient ? new Date() : null,
            recipient: { connectOrCreate: { where: { email }, create: { email } } },
          })),
        },
      },
    });
    const docs = [];
    for (const [i, status] of statuses.entries()) {
      docs.push(
        await prisma.document.create({
          data: {
            distributionId: dist.id,
            fileName: `문서${i + 1}.pdf`,
            sourceFormat: "PDF",
            sourceSize: 10n,
            status,
          },
        }),
      );
    }
    return { dist, docs, recipients };
  };

  beforeAll(async () => {
    db = await createTestDatabase(loadWorkerEnv({ NODE_ENV: "test" }).DATABASE_URL);
    prisma = createPrismaClient(db.url);
    notifier = new Notifier({
      prisma,
      logger: pino({ level: "silent" }),
      viewerDownloadUrl: "https://drm.example.com/viewer",
      mailer: {
        send: async (m) => {
          if (failSends) throw new Error("SMTP 장애");
          sent.push(m);
        },
      },
    });
    senderId = (
      await prisma.user.create({
        data: { email: `s-${randomUUID()}@company.com`, name: "김발신", passwordHash: "x" },
      })
    ).id;
  });

  beforeEach(() => {
    sent.length = 0;
    failSends = false;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.drop();
  });

  it("모든 문서 처리가 끝나면 수신자마다 한 번, 패키징된 문서를 묶어 보낸다", async () => {
    const { docs, recipients } = await distribution(["PACKAGED", "FAILED", "PACKAGED"]);
    expect(await notifier.notifyForDocument(docs[2]!.id)).toBe(2);
    expect(sent.map((m) => m.to).sort()).toEqual([...recipients].sort());
    const text = sent[0]!.text;
    expect(sent[0]!.subject).toContain("김발신");
    expect(text).toContain("문서1.pdf");
    expect(text).toContain("문서3.pdf");
    expect(text).not.toContain("문서2.pdf");
    expect(text).toContain("https://drm.example.com/viewer");

    // 이미 안내한 문서는 다시 보내지 않음
    expect(await notifier.notifyForDocument(docs[0]!.id)).toBe(0);
  });

  it("처리 중인 문서가 있으면 보내지 않는다", async () => {
    const { docs } = await distribution(["PACKAGED", "CONVERTING"]);
    expect(await notifier.notifyForDocument(docs[0]!.id)).toBe(0);
    await prisma.document.update({ where: { id: docs[1]!.id }, data: { status: "PACKAGED" } });
    expect(await notifier.notifyForDocument(docs[1]!.id)).toBe(2);
  });

  it("동시에 여러 문서가 끝나도 한 번만 보낸다", async () => {
    const { docs } = await distribution(["PACKAGED", "PACKAGED", "PACKAGED"]);
    const results = await Promise.all(docs.map((d) => notifier.notifyForDocument(d.id)));
    expect(results.reduce((a, b) => a + b, 0)).toBe(2);
    expect(sent).toHaveLength(2);
  });

  it("나중에 추가된 문서는 따로 안내한다", async () => {
    const { dist, docs } = await distribution(["PACKAGED"]);
    await notifier.notifyForDocument(docs[0]!.id);
    const added = await prisma.document.create({
      data: {
        distributionId: dist.id,
        fileName: "추가.pdf",
        sourceFormat: "PDF",
        sourceSize: 1n,
        status: "PACKAGED",
      },
    });
    sent.length = 0;
    expect(await notifier.notifyForDocument(added.id)).toBe(2);
    expect(sent[0]!.text).toContain("추가.pdf");
    expect(sent[0]!.text).not.toContain("문서1.pdf");
  });

  it("회수된 수신자·배포 건, 패키징 문서 없음은 보내지 않는다", async () => {
    const revokedEmail = `r-${randomUUID()}@c.kr`;
    const a = await distribution(["PACKAGED"], {
      recipients: [revokedEmail, `ok-${randomUUID()}@c.kr`],
      revokedRecipient: revokedEmail,
    });
    expect(await notifier.notifyForDocument(a.docs[0]!.id)).toBe(1);
    expect(sent.map((m) => m.to)).not.toContain(revokedEmail);

    const b = await distribution(["PACKAGED"], { revoked: true });
    expect(await notifier.notifyForDocument(b.docs[0]!.id)).toBe(0);
    const c = await distribution(["FAILED"]);
    expect(await notifier.notifyForDocument(c.docs[0]!.id)).toBe(0);
  });

  it("발송이 모두 실패하면 선점을 풀어 다음에 다시 시도한다", async () => {
    const { docs } = await distribution(["PACKAGED"]);
    failSends = true;
    expect(await notifier.notifyForDocument(docs[0]!.id)).toBe(0);
    failSends = false;
    expect(await notifier.notifyForDocument(docs[0]!.id)).toBe(2);
  });
});
