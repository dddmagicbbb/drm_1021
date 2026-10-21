import { RecipientDocumentSchema } from "@drm/contracts";
import { type ObjectStorage, storageKeys } from "@drm/storage";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaService } from "../src/prisma/prisma.service.js";
import { STORAGE } from "../src/storage/storage.module.js";
import {
  createDistribution,
  createPackagedDocument,
  createSender,
  recipientAuthHeader,
  uniqueEmail,
} from "./support/fixtures.js";
import { createTestApp, type TestContext } from "./support/test-app.js";

describe("수신자 문서 목록·다운로드 (T1-16)", () => {
  let ctx: TestContext;
  let sender: { id: string; name: string; email: string };
  const http = () => request(ctx.app.getHttpServer());

  /** 수신자 1명과 패키지 파일까지 있는 문서 */
  const setup = async () => {
    const email = uniqueEmail();
    const dist = await createDistribution(ctx, { senderId: sender.id, recipients: [email] });
    const { document } = await createPackagedDocument(ctx, dist.id);
    const bytes = randomBytes(4096);
    await ctx.app
      .get<ObjectStorage>(STORAGE)
      .put(storageKeys.package(document.id), Readable.from([bytes]));
    const recipientId = dist.recipients[0]!.recipientId;
    return { dist, document, bytes, auth: await recipientAuthHeader(ctx, recipientId) };
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    sender = await createSender(ctx, { name: "김발신" });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it("열람 가능한 문서만 목록에 나온다", async () => {
    const { dist, document, auth } = await setup();
    const prisma = ctx.app.get(PrismaService);
    const { document: revokedDoc } = await createPackagedDocument(ctx, dist.id);
    await prisma.document.update({ where: { id: revokedDoc.id }, data: { revokedAt: new Date() } });
    await createPackagedDocument(ctx, dist.id, { status: "CONVERTING" });

    const res = await http().get("/api/v1/recipient/documents").set("Authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(RecipientDocumentSchema.parse(res.body[0])).toMatchObject({
      docId: document.id,
      fileName: "도면.pdf",
      distributionTitle: "테스트 배포",
      sender: { name: "김발신", email: sender.email },
    });

    await prisma.distribution.update({
      where: { id: dist.id },
      data: { validUntil: new Date(Date.now() - 1000), validFrom: new Date(Date.now() - 2000) },
    });
    const expired = await http().get("/api/v1/recipient/documents").set("Authorization", auth);
    expect(expired.body).toEqual([]);
  });

  it(".drm을 내려받는다 (한글 파일명 헤더 포함)", async () => {
    const { document, bytes, auth } = await setup();
    const res = await http()
      .get(`/api/v1/recipient/documents/${document.id}/package`)
      .set("Authorization", auth)
      .buffer(true)
      .parse((r, cb) => {
        const parts: Buffer[] = [];
        r.on("data", (c: Buffer) => parts.push(c));
        r.on("end", () => cb(null, Buffer.concat(parts)));
      });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).equals(bytes)).toBe(true);
    expect(res.headers["content-disposition"]).toContain(
      `filename*=UTF-8''${encodeURIComponent("도면.pdf.drm")}`,
    );
    expect(res.headers["cache-control"]).toBe("no-store");

    const { rows } = await ctx.query(
      `SELECT 1 FROM audit_events WHERE type = 'DOCUMENT_DOWNLOADED' AND "documentId" = $1`,
      [document.id],
    );
    expect(rows).toHaveLength(1);
  });

  it("수신자가 아니면 403 NOT_RECIPIENT, 회수되면 사유와 연락처", async () => {
    const a = await setup();
    const b = await setup();
    const denied = await http()
      .get(`/api/v1/recipient/documents/${a.document.id}/package`)
      .set("Authorization", b.auth);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("NOT_RECIPIENT");
    expect(denied.body.error.contact).toBeUndefined();
    const { rows } = await ctx.query<{ detail: { reason: string } }>(
      `SELECT detail FROM audit_events WHERE type = 'DOCUMENT_DOWNLOAD_DENIED' AND "documentId" = $1`,
      [a.document.id],
    );
    expect(rows[0]?.detail).toEqual({ reason: "NOT_RECIPIENT" });

    await ctx.app.get(PrismaService).distribution.update({
      where: { id: a.dist.id },
      data: { revokedAt: new Date() },
    });
    const revoked = await http()
      .get(`/api/v1/recipient/documents/${a.document.id}/package`)
      .set("Authorization", a.auth);
    expect(revoked.body.error).toMatchObject({
      code: "DISTRIBUTION_REVOKED",
      contact: { name: "김발신", email: sender.email },
    });
  });
});
