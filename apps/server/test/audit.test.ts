import type { AuditEventType } from "@drm/contracts";
import { AuditEventTypeSchema } from "@drm/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditService } from "../src/audit/audit.service.js";
import { RequestContextMiddleware } from "../src/common/request-context.js";
import { PrismaService } from "../src/prisma/prisma.service.js";
import { createTestApp, type TestContext } from "./support/test-app.js";

describe("감사 로그", () => {
  let ctx: TestContext;
  let audit: AuditService;

  beforeAll(async () => {
    ctx = await createTestApp();
    audit = ctx.app.get(AuditService);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it("모든 이벤트 유형을 기록할 수 있다", async () => {
    const types = AuditEventTypeSchema.options as AuditEventType[];
    await audit.recordMany(types.map((type) => ({ type, actorType: "SYSTEM" })));
    const { rows } = await ctx.query<{ type: string }>(`SELECT DISTINCT type FROM audit_events`);
    expect(rows.map((r) => r.type).sort()).toEqual([...types].sort());
  });

  it("detail의 민감정보를 가려서 저장한다", async () => {
    await audit.record({
      type: "OTP_FAILED",
      actorType: "RECIPIENT",
      detail: { email: "kim@customer.co.kr", code: "123456" },
    });
    const { rows } = await ctx.query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM audit_events WHERE type = 'OTP_FAILED' ORDER BY "occurredAt" DESC LIMIT 1`,
    );
    expect(rows[0]?.detail).toEqual({ email: "kim@customer.co.kr", code: "[REDACTED]" });
  });

  it("트랜잭션이 롤백되면 감사 로그도 남지 않는다", async () => {
    const prisma = ctx.app.get(PrismaService);
    await expect(
      prisma.$transaction(async (tx) => {
        await audit.record({ type: "DEVICE_REVOKED", actorType: "SYSTEM", detail: { t: 1 } }, tx);
        throw new Error("롤백");
      }),
    ).rejects.toThrow("롤백");
    const { rows } = await ctx.query(
      `SELECT 1 FROM audit_events WHERE type = 'DEVICE_REVOKED' AND detail->>'t' = '1'`,
    );
    expect(rows).toHaveLength(0);
  });

  it("DB에서 UPDATE/DELETE가 불가능하다", async () => {
    await expect(ctx.query(`UPDATE audit_events SET ip = 'x'`)).rejects.toThrow(/append-only/);
    await expect(ctx.query(`DELETE FROM audit_events`)).rejects.toThrow(/append-only/);
  });
});

describe("감사 로그 요청 컨텍스트", () => {
  it("요청 컨텍스트의 correlation ID와 IP를 함께 기록한다", async () => {
    const ctx = await createTestApp();
    try {
      const audit = ctx.app.get(AuditService);
      const middleware = new RequestContextMiddleware();
      await new Promise<void>((resolve, reject) => {
        middleware.use(
          { id: "corr-123", ip: "203.0.113.7", socket: {} } as never,
          {} as never,
          () => {
            audit
              .record({ type: "OTP_REQUESTED", actorType: "SYSTEM", detail: { probe: true } })
              .then(resolve, reject);
          },
        );
      });
      const { rows } = await ctx.query<{ ip: string; correlationId: string }>(
        `SELECT ip, "correlationId" FROM audit_events WHERE detail->>'probe' = 'true'`,
      );
      expect(rows).toEqual([{ ip: "203.0.113.7", correlationId: "corr-123" }]);
    } finally {
      await ctx.close();
    }
  });

  it("요청 밖에서 기록하면 IP·correlation ID는 null이다", async () => {
    const ctx = await createTestApp();
    try {
      await ctx.app.get(AuditService).record({ type: "OTP_REQUESTED", actorType: "SYSTEM" });
      const { rows } = await ctx.query(`SELECT ip, "correlationId" FROM audit_events`);
      expect(rows).toEqual([{ ip: null, correlationId: null }]);
    } finally {
      await ctx.close();
    }
  });
});
