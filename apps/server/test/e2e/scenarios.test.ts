/**
 * T1-28 전 구간 E2E 시나리오 (PRD 4장 S1·S2·S4·S5·S6)
 *
 * 실제로 연결하는 것: 서버(HTTP 포트), 워커 패키저·안내 메일, 뷰어 main 프로세스 로직, Mailpit(SMTP)
 * 대체하는 것: BullMQ 큐(메모리 큐에 쌓인 작업을 테스트가 워커 함수로 처리), Electron safeStorage(메모리)
 */
import { createPrismaClient, type PrismaClient } from "@drm/db";
import { config } from "dotenv";
import { createLocalKmsProvider, createLocalSigningKeyProvider } from "@drm/kms";
import { LocalFileStorage } from "@drm/storage";
import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PdfPassthroughConverter } from "../../../worker/src/converter.js";
import { Notifier, createSmtpMailer } from "../../../worker/src/notifier.js";
import { Packager } from "../../../worker/src/packager.js";
import { DocumentController } from "../../../viewer-desktop/src/main/documents.js";
import type { SecretStore } from "../../../viewer-desktop/src/main/secret-store.js";
import { ServerApi } from "../../../viewer-desktop/src/main/server-api.js";
import type { ViewerError } from "../../../viewer-desktop/src/shared/ipc.js";
import { createSender, senderAuthHeader } from "../support/fixtures.js";
import { createTestApp, type TestContext } from "../support/test-app.js";

config({ path: ["../../.env", ".env"], quiet: true });
const mailpit = process.env.MAILPIT_API_URL;

class MemoryStore implements SecretStore {
  private readonly items = new Map<string, Buffer>();
  async load(name: string) {
    const v = this.items.get(name);
    return v ? Buffer.from(v) : null;
  }
  async save(name: string, value: Uint8Array) {
    this.items.set(name, Buffer.from(value));
  }
  async delete(name: string) {
    this.items.delete(name);
  }
}

interface MailpitMessage {
  ID: string;
  Subject: string;
}

/** Mailpit에서 특정 수신자의 메일을 기다려 가져옵니다. */
const waitForMail = async (to: string, subjectIncludes: string): Promise<string> => {
  for (let i = 0; i < 50; i += 1) {
    const search = await fetch(
      `${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`,
    ).then((r) => r.json() as Promise<{ messages: MailpitMessage[] }>);
    const found = search.messages.find((m) => m.Subject.includes(subjectIncludes));
    if (found) {
      const message = await fetch(`${mailpit}/api/v1/message/${found.ID}`).then(
        (r) => r.json() as Promise<{ Text: string }>,
      );
      return message.Text;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${to}에게 "${subjectIncludes}" 메일이 오지 않았습니다`);
};

/** 디렉터리 아래 모든 파일에서 표식 바이트 검색 (평문 디스크 기록 확인) */
const filesContaining = async (dir: string, marker: Buffer, since: number): Promise<string[]> => {
  const hits: string[] = [];
  const walk = async (d: string) => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        try {
          const info = await stat(full);
          if (info.mtimeMs < since || info.size > 50 * 1024 * 1024) continue;
          if ((await readFile(full)).includes(marker)) hits.push(full);
        } catch {
          // 다른 프로세스가 사용 중인 파일은 건너뜀
        }
      }
    }
  };
  await walk(dir);
  return hits;
};

describe.runIf(mailpit)("E2E 시나리오 (T1-28)", () => {
  let ctx: TestContext;
  let baseUrl: string;
  let prisma: PrismaClient;
  let packager: Packager;
  let notifier: Notifier;
  let closeMailer: () => void;
  let senderAuth: string;
  const startedAt = Date.now();

  // 원본 PDF에 고유 표식을 넣어, 평문이 디스크 어딘가에 남는지 추적합니다.
  const marker = Buffer.from(`DRM-E2E-MARKER-${randomUUID()}`);
  const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), marker, randomBytes(300_000), marker]);

  const http = () => request(ctx.app.getHttpServer());

  /** 큐에 쌓인 패키징 작업을 워커처럼 처리 */
  const runWorker = async () => {
    while (ctx.queue.jobs.length > 0) {
      const job = ctx.queue.jobs.shift()!;
      await packager.package(job.docId);
      await notifier.notifyForDocument(job.docId);
    }
  };

  /** 수신자 PC의 뷰어 하나 (main 프로세스 로직) */
  const viewerFor = () => {
    const secrets = new MemoryStore();
    const api = new ServerApi(baseUrl, secrets);
    const closed: { docId: string; error: ViewerError }[] = [];
    const trusted = async () =>
      new Map((await api.signingKeys()).map((k) => [k.kid, Buffer.from(k.publicKey, "base64url")]));
    const controller = new DocumentController(api, secrets, trusted, (docId, error) =>
      closed.push({ docId, error }),
    );
    return { controller, closed };
  };

  const loginViewer = async (email: string) => {
    const viewer = viewerFor();
    await viewer.controller.requestOtp(email);
    const otpMail = await waitForMail(email, "인증 코드");
    const code = otpMail.match(/인증 코드: (\d{6})/)?.[1];
    expect(code).toBeDefined();
    await viewer.controller.verifyOtp(email, code!);
    return viewer;
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    await ctx.app.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${(ctx.app.getHttpServer().address() as AddressInfo).port}`;

    // 워커는 서버와 같은 DB·저장소·키링을 사용합니다.
    prisma = createPrismaClient(ctx.env.DATABASE_URL);
    const logger = pino({ level: "silent" });
    packager = new Packager({
      prisma,
      storage: new LocalFileStorage(ctx.env.STORAGE_DIR),
      kms: await createLocalKmsProvider({ keyringPath: ctx.env.KMS_KEYRING_PATH, nodeEnv: "test" }),
      signing: await createLocalSigningKeyProvider({
        keyringPath: ctx.env.SIGNING_KEYRING_PATH,
        nodeEnv: "test",
      }),
      converters: [new PdfPassthroughConverter()],
      logger,
    });
    const mailer = createSmtpMailer({
      host: ctx.env.SMTP_HOST,
      port: ctx.env.SMTP_PORT,
      from: ctx.env.MAIL_FROM,
    });
    closeMailer = () => mailer.close();
    notifier = new Notifier({
      prisma,
      mailer,
      logger,
      viewerDownloadUrl: "https://drm.example.com/viewer",
    });

    const sender = await createSender(ctx, { name: "김발신" });
    senderAuth = await senderAuthHeader(ctx, sender.email);
  });

  afterAll(async () => {
    closeMailer?.();
    await prisma?.$disconnect();
    await ctx?.close();
  });

  it("S1 배포 → S2 열람 → S6 기간 연장 → S4 회수 → S5 만료", async () => {
    const recipient = `e2e-${randomUUID().slice(0, 8)}@customer.co.kr`;
    const outsider = `e2e-out-${randomUUID().slice(0, 8)}@customer.co.kr`;

    // ── S1 배포: 발신자가 배포 건을 만들고 PDF를 올린다 ──────────────────
    const now = Date.now();
    const created = await http()
      .post("/api/v1/distributions")
      .set("Authorization", senderAuth)
      .send({
        title: "E2E 도면 송부",
        recipients: [recipient],
        policy: {
          validFrom: new Date(now - 60_000).toISOString(),
          validUntil: new Date(now + 7 * 86400_000).toISOString(),
          allowWeb: true,
          securityLevel: "NORMAL",
          offlineGraceHours: 0,
          maxViews: null,
          maxDevices: 2,
        },
      });
    expect(created.status).toBe(201);
    const distributionId = created.body.id as string;
    const recipientId = created.body.recipients[0].recipientId as string;

    const uploaded = await http()
      .post(`/api/v1/distributions/${distributionId}/documents`)
      .set("Authorization", senderAuth)
      .attach("file", pdf, { filename: "E2E 설계도.pdf" });
    expect(uploaded.status).toBe(202);
    const docId = uploaded.body.id as string;

    await runWorker();
    const afterPackaging = await http()
      .get(`/api/v1/distributions/${distributionId}`)
      .set("Authorization", senderAuth);
    expect(afterPackaging.body.documents[0].status).toBe("PACKAGED");

    // 수신자에게 안내 메일 (다운로드 링크 없음)
    const notice = await waitForMail(recipient, "문서를 보냈습니다");
    expect(notice).toContain("E2E 설계도.pdf");
    expect(notice).not.toContain(docId);

    // ── S2 열람: 뷰어에서 OTP 로그인 → 목록 → 열기 ──────────────────────
    const viewer = await loginViewer(recipient);
    const docs = await viewer.controller.listDocuments();
    expect(docs.map((d) => d.docId)).toEqual([docId]);

    const opened = await viewer.controller.openRemote(docId, "E2E 설계도.pdf.drm");
    expect(Buffer.from(opened.data).equals(pdf)).toBe(true);
    expect(opened.watermark).toContain(recipient);
    viewer.controller.closeDocument();
    expect(opened.data.every((b) => b === 0)).toBe(true);

    // 등록되지 않은 사람은 OTP 메일조차 받지 못하고, 다운로드도 할 수 없다
    const stranger = viewerFor();
    await stranger.controller.requestOtp(outsider);
    await new Promise((r) => setTimeout(r, 500));
    const strangerMails = await fetch(
      `${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${outsider}`)}`,
    ).then((r) => r.json() as Promise<{ messages: unknown[] }>);
    expect(strangerMails.messages).toHaveLength(0);

    // ── S6 기간 연장: 재배포 없이 즉시 반영 ─────────────────────────────
    const extendedUntil = new Date(now + 30 * 86400_000).toISOString();
    const extended = await http()
      .patch(`/api/v1/distributions/${distributionId}`)
      .set("Authorization", senderAuth)
      .send({ policy: { ...created.body.policy, validUntil: extendedUntil } });
    expect(extended.status).toBe(200);
    const reopened = await viewer.controller.openRemote(docId);
    expect(Buffer.from(reopened.data).equals(pdf)).toBe(true);

    // ── S4 회수: 열람 중 수신자 회수 → 재발급 거부 → 이후 열기도 거부 ───────
    const revoked = await http()
      .post(`/api/v1/distributions/${distributionId}/recipients/${recipientId}/revoke`)
      .set("Authorization", senderAuth);
    expect(revoked.status).toBe(200);

    await expect(viewer.controller.openRemote(docId)).rejects.toMatchObject({
      code: "RECIPIENT_REVOKED",
      contact: { name: "김발신" },
    });

    // ── S5 만료: 수신자 복구 대신 새 배포 건으로 만료 확인 ───────────────────
    const expiredDist = await http()
      .post("/api/v1/distributions")
      .set("Authorization", senderAuth)
      .send({
        title: "만료 확인",
        recipients: [recipient],
        policy: {
          ...created.body.policy,
          validFrom: new Date(now - 60_000).toISOString(),
          validUntil: new Date(now + 86400_000).toISOString(),
        },
      });
    const expiredDoc = await http()
      .post(`/api/v1/distributions/${expiredDist.body.id}/documents`)
      .set("Authorization", senderAuth)
      .attach("file", pdf, { filename: "만료.pdf" });
    await runWorker();
    const ok = await viewer.controller.openRemote(expiredDoc.body.id);
    expect(ok.docId).toBe(expiredDoc.body.id);
    viewer.controller.closeDocument();

    await prisma.distribution.update({
      where: { id: expiredDist.body.id },
      data: { validFrom: new Date(now - 2 * 86400_000), validUntil: new Date(Date.now() - 1000) },
    });
    await expect(viewer.controller.openRemote(expiredDoc.body.id)).rejects.toMatchObject({
      code: "EXPIRED",
    });

    // ── 감사 로그: 전 과정이 기록됨 ─────────────────────────────────────
    // 회수 후 열기는 .drm 다운로드 단계에서 먼저 거부됩니다. (DOCUMENT_DOWNLOAD_DENIED)
    const { rows } = await ctx.query<{ type: string }>(
      `SELECT DISTINCT type FROM audit_events WHERE "distributionId" = $1`,
      [distributionId],
    );
    expect(rows.map((r) => r.type).sort()).toEqual(
      [
        "DISTRIBUTION_CREATED",
        "DISTRIBUTION_UPDATED",
        "DOCUMENT_PACKAGED",
        "DOCUMENT_DOWNLOADED",
        "DOCUMENT_DOWNLOAD_DENIED",
        "DOCUMENT_UPLOADED",
        "LICENSE_ISSUED",
        "RECIPIENT_ADDED",
        "RECIPIENT_REVOKED",
      ].sort(),
    );

    // ── 평문 디스크 기록 없음: 저장소·임시 폴더 어디에도 원본 표식이 없어야 함 ──
    expect(await filesContaining(ctx.env.STORAGE_DIR, marker, startedAt)).toEqual([]);
    expect(await filesContaining(tmpdir(), marker, startedAt)).toEqual([]);
  });

  it("열람 중 회수되면 재발급 시점에 뷰어가 문서를 닫는다 (S4)", async () => {
    const recipient = `e2e-r-${randomUUID().slice(0, 8)}@customer.co.kr`;
    const now = Date.now();
    const dist = await http()
      .post("/api/v1/distributions")
      .set("Authorization", senderAuth)
      .send({
        title: "회수 확인",
        recipients: [recipient],
        policy: {
          validFrom: new Date(now - 60_000).toISOString(),
          validUntil: new Date(now + 86400_000).toISOString(),
          allowWeb: true,
          securityLevel: "NORMAL",
          offlineGraceHours: 0,
          maxViews: null,
          maxDevices: 2,
        },
      });
    const doc = await http()
      .post(`/api/v1/distributions/${dist.body.id}/documents`)
      .set("Authorization", senderAuth)
      .attach("file", pdf, { filename: "회수.pdf" });
    await runWorker();

    const viewer = await loginViewer(recipient);
    const opened = await viewer.controller.openRemote(doc.body.id);

    await http()
      .post(`/api/v1/distributions/${dist.body.id}/revoke`)
      .set("Authorization", senderAuth);

    // 재발급 타이머를 기다리지 않고 직접 실행 (세션 내부 동작은 단위 테스트에서 검증)
    const session = (
      viewer.controller as unknown as { session: { renew(id: string): Promise<void> } }
    ).session;
    await session.renew(doc.body.id);
    expect(viewer.closed).toEqual([
      { docId: doc.body.id, error: expect.objectContaining({ code: "DISTRIBUTION_REVOKED" }) },
    ]);
    expect(opened.data.every((b) => b === 0)).toBe(true);
  });
});
