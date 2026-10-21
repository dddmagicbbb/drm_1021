import { DistributionSchema, DistributionSummarySchema, type Policy } from "@drm/contracts";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaService } from "../src/prisma/prisma.service.js";
import { createSender, senderAuthHeader, uniqueEmail } from "./support/fixtures.js";
import { createTestApp, type TestContext } from "./support/test-app.js";

const DAY = 86400_000;
const policy = (overrides: Partial<Policy> = {}): Policy => ({
  validFrom: new Date(Date.now() - 60_000).toISOString(),
  validUntil: new Date(Date.now() + 30 * DAY).toISOString(),
  allowWeb: true,
  securityLevel: "NORMAL",
  offlineGraceHours: 0,
  maxViews: null,
  maxDevices: 2,
  ...overrides,
});

describe("배포 관리 API (T1-09)", () => {
  let ctx: TestContext;
  let auth: string;
  let otherAuth: string;
  const http = () => request(ctx.app.getHttpServer());

  const create = (body: Record<string, unknown>, as = auth) =>
    http().post("/api/v1/distributions").set("Authorization", as).send(body);

  const createValid = async (recipients = [uniqueEmail(), uniqueEmail()]) => {
    const res = await create({ title: "A사 도면 송부", recipients, policy: policy() });
    expect(res.status).toBe(201);
    return DistributionSchema.parse(res.body);
  };

  const auditTypes = async (distributionId: string) =>
    (
      await ctx.query<{ type: string }>(
        `SELECT type FROM audit_events WHERE "distributionId" = $1 ORDER BY "occurredAt", type`,
        [distributionId],
      )
    ).rows.map((r) => r.type);

  beforeAll(async () => {
    ctx = await createTestApp();
    const sender = await createSender(ctx);
    const other = await createSender(ctx);
    auth = await senderAuthHeader(ctx, sender.email);
    otherAuth = await senderAuthHeader(ctx, other.email);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  describe("생성·조회", () => {
    it("배포 건을 만들고 수신자 이메일을 정규화한다", async () => {
      const email = uniqueEmail();
      const res = await create({
        title: "A사 도면 송부",
        recipients: [email.toUpperCase(), uniqueEmail()],
        policy: policy(),
      });
      expect(res.status).toBe(201);
      const dist = DistributionSchema.parse(res.body);
      expect(dist.state).toBe("ACTIVE");
      expect(dist.recipients.map((r) => r.email)).toContain(email);
      expect(dist.documents).toEqual([]);

      const got = await http().get(`/api/v1/distributions/${dist.id}`).set("Authorization", auth);
      expect(got.status).toBe(200);
      expect(got.body).toEqual(res.body);

      expect(await auditTypes(dist.id)).toEqual([
        "DISTRIBUTION_CREATED",
        "RECIPIENT_ADDED",
        "RECIPIENT_ADDED",
      ]);
    });

    it("여러 배포 건에 같은 수신자를 등록하면 같은 recipientId를 쓴다", async () => {
      const email = uniqueEmail();
      const a = await createValid([email]);
      const b = await createValid([email]);
      expect(a.recipients[0]?.recipientId).toBe(b.recipients[0]?.recipientId);
    });

    it("시작 전·만료 상태를 계산한다", async () => {
      const scheduled = await create({
        title: "예약",
        recipients: [uniqueEmail()],
        policy: policy({
          validFrom: new Date(Date.now() + DAY).toISOString(),
          validUntil: new Date(Date.now() + 2 * DAY).toISOString(),
        }),
      });
      expect(scheduled.body.state).toBe("SCHEDULED");
      const expired = await create({
        title: "만료",
        recipients: [uniqueEmail()],
        policy: policy({
          validFrom: new Date(Date.now() - 2 * DAY).toISOString(),
          validUntil: new Date(Date.now() - DAY).toISOString(),
        }),
      });
      expect(expired.body.state).toBe("EXPIRED");
    });

    it("잘못된 입력은 400 VALIDATION_FAILED", async () => {
      const cases = [
        { title: "", recipients: [uniqueEmail()], policy: policy() },
        { title: "중복", recipients: ["a@x.com", "A@x.com"], policy: policy() },
        { title: "수신자 없음", recipients: [], policy: policy() },
        {
          title: "기간 역전",
          recipients: [uniqueEmail()],
          policy: policy({ validUntil: new Date(Date.now() - DAY).toISOString() }),
        },
      ];
      for (const body of cases) {
        const res = await create(body);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("VALIDATION_FAILED");
      }
    });

    it("다른 발신자의 배포 건은 404로 숨긴다", async () => {
      const dist = await createValid();
      const res = await http()
        .get(`/api/v1/distributions/${dist.id}`)
        .set("Authorization", otherAuth);
      expect(res.status).toBe(404);
      const patch = await http()
        .patch(`/api/v1/distributions/${dist.id}`)
        .set("Authorization", otherAuth)
        .send({ title: "탈취" });
      expect(patch.status).toBe(404);
    });

    it("목록은 본인 배포 건만 최신순으로 페이지 단위 반환한다", async () => {
      const ownerAuth = await senderAuthHeader(ctx, (await createSender(ctx)).email);
      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const res = await create(
          { title: `건 ${i}`, recipients: [uniqueEmail()], policy: policy() },
          ownerAuth,
        );
        ids.push(res.body.id);
      }
      const page1 = await http()
        .get("/api/v1/distributions?page=1&size=2")
        .set("Authorization", ownerAuth);
      expect(page1.status).toBe(200);
      const list = page1.body.map((s: unknown) => DistributionSummarySchema.parse(s));
      expect(list.map((s: { id: string }) => s.id)).toEqual([ids[2], ids[1]]);
      expect(list[0].recipientCount).toBe(1);

      const page2 = await http()
        .get("/api/v1/distributions?page=2&size=2")
        .set("Authorization", ownerAuth);
      expect(page2.body.map((s: { id: string }) => s.id)).toEqual([ids[0]]);

      const bad = await http()
        .get("/api/v1/distributions?size=1000")
        .set("Authorization", ownerAuth);
      expect(bad.status).toBe(400);
    });

    it("UUID가 아닌 ID는 400", async () => {
      const res = await http().get("/api/v1/distributions/not-a-uuid").set("Authorization", auth);
      expect(res.status).toBe(400);
    });
  });

  describe("수정 (FR-106)", () => {
    it("기간을 연장하고 수신자를 추가·삭제한다", async () => {
      const dist = await createValid();
      const removeId = dist.recipients[0]!.recipientId;
      const added = uniqueEmail();
      const newUntil = new Date(Date.now() + 60 * DAY).toISOString();

      const res = await http()
        .patch(`/api/v1/distributions/${dist.id}`)
        .set("Authorization", auth)
        .send({
          policy: { ...dist.policy, validUntil: newUntil },
          addRecipients: [added],
          removeRecipientIds: [removeId],
        });
      expect(res.status).toBe(200);
      const updated = DistributionSchema.parse(res.body);
      expect(updated.policy.validUntil).toBe(newUntil);
      expect(updated.recipients.map((r) => r.email)).toContain(added);
      expect(updated.recipients.map((r) => r.recipientId)).not.toContain(removeId);

      const types = await auditTypes(dist.id);
      expect(types).toContain("DISTRIBUTION_UPDATED");
      expect(types).toContain("RECIPIENT_REMOVED");
      expect(types.filter((t) => t === "RECIPIENT_ADDED")).toHaveLength(3);

      const { rows } = await ctx.query<{ detail: { policy: { from: Policy; to: Policy } } }>(
        `SELECT detail FROM audit_events WHERE "distributionId" = $1 AND type = 'DISTRIBUTION_UPDATED'`,
        [dist.id],
      );
      expect(rows[0]?.detail.policy.from.validUntil).toBe(dist.policy.validUntil);
      expect(rows[0]?.detail.policy.to.validUntil).toBe(newUntil);
    });

    it("이미 있는 수신자 추가는 무시한다", async () => {
      const dist = await createValid();
      const res = await http()
        .patch(`/api/v1/distributions/${dist.id}`)
        .set("Authorization", auth)
        .send({ addRecipients: [dist.recipients[0]!.email] });
      expect(res.body.recipients).toHaveLength(2);
    });

    it("모든 수신자를 삭제할 수 없다", async () => {
      const dist = await createValid();
      const res = await http()
        .patch(`/api/v1/distributions/${dist.id}`)
        .set("Authorization", auth)
        .send({ removeRecipientIds: dist.recipients.map((r) => r.recipientId) });
      expect(res.status).toBe(400);
      // 트랜잭션 롤백 확인
      const got = await http().get(`/api/v1/distributions/${dist.id}`).set("Authorization", auth);
      expect(got.body.recipients).toHaveLength(2);
    });

    it("회수된 배포 건은 수정할 수 없다", async () => {
      const dist = await createValid();
      await http().post(`/api/v1/distributions/${dist.id}/revoke`).set("Authorization", auth);
      const res = await http()
        .patch(`/api/v1/distributions/${dist.id}`)
        .set("Authorization", auth)
        .send({ title: "변경" });
      expect(res.status).toBe(409);
    });
  });

  describe("회수 (FR-107)", () => {
    it("배포 건 회수는 멱등이며 감사 로그는 한 번만 남는다", async () => {
      const dist = await createValid();
      const first = await http()
        .post(`/api/v1/distributions/${dist.id}/revoke`)
        .set("Authorization", auth);
      const second = await http()
        .post(`/api/v1/distributions/${dist.id}/revoke`)
        .set("Authorization", auth);
      expect(first.status).toBe(200);
      expect(first.body.state).toBe("REVOKED");
      expect(second.body.revokedAt).toBe(first.body.revokedAt);
      expect((await auditTypes(dist.id)).filter((t) => t === "DISTRIBUTION_REVOKED")).toHaveLength(
        1,
      );
    });

    it("수신자 회수", async () => {
      const dist = await createValid();
      const target = dist.recipients[1]!;
      const res = await http()
        .post(`/api/v1/distributions/${dist.id}/recipients/${target.recipientId}/revoke`)
        .set("Authorization", auth);
      expect(res.status).toBe(200);
      const revoked = res.body.recipients.find(
        (r: { recipientId: string }) => r.recipientId === target.recipientId,
      );
      expect(revoked.revokedAt).not.toBeNull();
      expect(await auditTypes(dist.id)).toContain("RECIPIENT_REVOKED");

      const missing = await http()
        .post(`/api/v1/distributions/${dist.id}/recipients/${crypto.randomUUID()}/revoke`)
        .set("Authorization", auth);
      expect(missing.status).toBe(404);
    });

    it("문서 회수 (본인 배포 건의 문서만)", async () => {
      const dist = await createValid();
      const doc = await ctx.app.get(PrismaService).document.create({
        data: {
          distributionId: dist.id,
          fileName: "도면.pdf",
          sourceFormat: "PDF",
          sourceSize: 1024n,
          status: "PACKAGED",
        },
      });
      const denied = await http()
        .post(`/api/v1/documents/${doc.id}/revoke`)
        .set("Authorization", otherAuth);
      expect(denied.status).toBe(404);

      const res = await http()
        .post(`/api/v1/documents/${doc.id}/revoke`)
        .set("Authorization", auth);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: doc.id, sourceSize: 1024, status: "PACKAGED" });
      expect(res.body.revokedAt).not.toBeNull();
      expect(await auditTypes(dist.id)).toContain("DOCUMENT_REVOKED");
    });
  });

  it("인증 없이 호출하면 401", async () => {
    expect((await http().get("/api/v1/distributions")).status).toBe(401);
  });
});
