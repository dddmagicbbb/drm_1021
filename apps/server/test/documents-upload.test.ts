import { DocumentSchema } from "@drm/contracts";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaService } from "../src/prisma/prisma.service.js";
import {
  createDistribution,
  createSender,
  senderAuthHeader,
  uniqueEmail,
} from "./support/fixtures.js";
import { createTestApp, type TestContext } from "./support/test-app.js";

const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(50_000, 1)]);

describe("문서 업로드·작업 등록 (T1-13)", () => {
  let ctx: TestContext;
  let senderId: string;
  let auth: string;
  let otherAuth: string;
  const http = () => request(ctx.app.getHttpServer());

  const upload = (distributionId: string, fileName: string, content: Buffer, as = auth) =>
    http()
      .post(`/api/v1/distributions/${distributionId}/documents`)
      .set("Authorization", as)
      .attach("file", content, { filename: fileName, contentType: "application/octet-stream" });

  const newDistribution = () => createDistribution(ctx, { senderId, recipients: [uniqueEmail()] });
  const uploadsDir = () => join(ctx.env.STORAGE_DIR, "uploads");
  const uploadedFiles = async () => readdir(uploadsDir()).catch(() => [] as string[]);

  beforeAll(async () => {
    ctx = await createTestApp();
    const sender = await createSender(ctx);
    senderId = sender.id;
    auth = await senderAuthHeader(ctx, sender.email);
    otherAuth = await senderAuthHeader(ctx, (await createSender(ctx)).email);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it("업로드 → 원본 저장 → 작업 등록 → 상태 조회", async () => {
    const dist = await newDistribution();
    const res = await upload(dist.id, "A사 설계 도면.pdf", PDF);
    expect(res.status).toBe(202);
    const doc = DocumentSchema.parse(res.body);
    expect(doc).toMatchObject({
      distributionId: dist.id,
      fileName: "A사 설계 도면.pdf",
      sourceFormat: "PDF",
      sourceSize: PDF.length,
      status: "UPLOADED",
    });

    // 원본이 저장소에 그대로 저장됨
    expect((await readFile(join(uploadsDir(), doc.id))).equals(PDF)).toBe(true);
    // 패키징 작업 등록
    expect(ctx.queue.jobs).toContainEqual({ docId: doc.id });
    // 배포 건 조회에 문서 상태가 보임
    const got = await http().get(`/api/v1/distributions/${dist.id}`).set("Authorization", auth);
    expect(got.body.documents).toEqual([res.body]);

    const { rows } = await ctx.query(
      `SELECT 1 FROM audit_events WHERE type = 'DOCUMENT_UPLOADED' AND "documentId" = $1`,
      [doc.id],
    );
    expect(rows).toHaveLength(1);
  });

  it("Office 문서도 업로드할 수 있다", async () => {
    const dist = await newDistribution();
    const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100)]);
    const res = await upload(dist.id, "사양서.docx", docx);
    expect(res.status).toBe(202);
    expect(res.body.sourceFormat).toBe("DOCX");
  });

  it("거부된 업로드는 문서·파일·작업을 남기지 않는다", async () => {
    const dist = await newDistribution();
    const before = { files: (await uploadedFiles()).length, jobs: ctx.queue.jobs.length };
    const cases: [string, Buffer][] = [
      ["drawing.dwg", Buffer.from("AC1032")],
      ["fake.pdf", Buffer.from("PK\x03\x04 not a pdf")],
      ["empty.pdf", Buffer.alloc(0)],
    ];
    for (const [name, content] of cases) {
      const res = await upload(dist.id, name, content);
      expect(res.status, name).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_FAILED");
    }
    const docs = await ctx.app
      .get(PrismaService)
      .document.count({ where: { distributionId: dist.id } });
    expect(docs).toBe(0);
    expect((await uploadedFiles()).filter((f) => !f.endsWith(".partial"))).toHaveLength(
      before.files,
    );
    expect(ctx.queue.jobs).toHaveLength(before.jobs);
  });

  it("다른 발신자의 배포 건은 404, 회수된 배포 건은 409", async () => {
    const dist = await newDistribution();
    expect((await upload(dist.id, "a.pdf", PDF, otherAuth)).status).toBe(404);
    await ctx.app.get(PrismaService).distribution.update({
      where: { id: dist.id },
      data: { revokedAt: new Date() },
    });
    expect((await upload(dist.id, "a.pdf", PDF)).status).toBe(409);
  });

  it("multipart가 아닌 요청은 400", async () => {
    const dist = await newDistribution();
    const res = await http()
      .post(`/api/v1/distributions/${dist.id}/documents`)
      .set("Authorization", auth)
      .send({ file: "x" });
    expect(res.status).toBe(400);
  });
});
