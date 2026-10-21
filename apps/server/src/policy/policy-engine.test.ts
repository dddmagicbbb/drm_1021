import { DenyReasonSchema } from "@drm/contracts";
import { describe, expect, it } from "vitest";
import {
  DENY_MESSAGES,
  evaluateAccess,
  type AccessFacts,
  type AccessPurpose,
} from "./policy-engine.js";

const FROM = new Date("2026-10-21T00:00:00.000Z");
const UNTIL = new Date("2026-11-20T00:00:00.000Z");
const MID = new Date("2026-11-01T00:00:00.000Z");
const ms = (d: Date, delta: number) => new Date(d.getTime() + delta);

const facts = (overrides: Partial<AccessFacts> = {}): AccessFacts => ({
  membership: { revokedAt: null },
  distribution: { revokedAt: null, validFrom: FROM, validUntil: UNTIL, maxViews: null },
  document: { revokedAt: null, status: "PACKAGED" },
  ...overrides,
});

const license = (overrides: Partial<Extract<AccessPurpose, { kind: "license" }>> = {}) =>
  ({ kind: "license", device: { revokedAt: null }, issuedCount: 0, ...overrides }) as const;

const download = { kind: "download" } as const;
/** 거부 사유만 꺼냄 (허용이면 null) */
const reasonOf = (...args: Parameters<typeof evaluateAccess>) => {
  const decision = evaluateAccess(...args);
  return decision.allowed ? null : decision.reason;
};
const revoked = new Date("2026-10-25T00:00:00.000Z");

describe("evaluateAccess", () => {
  it("모든 조건을 만족하면 허용한다", () => {
    expect(evaluateAccess(facts(), license(), MID)).toEqual({ allowed: true });
    expect(evaluateAccess(facts(), download, MID)).toEqual({ allowed: true });
  });

  describe("기간 경계 [validFrom, validUntil)", () => {
    it.each([
      ["시작 1초 전", ms(FROM, -1000), "NOT_YET_VALID"],
      ["시작 1ms 전", ms(FROM, -1), "NOT_YET_VALID"],
      ["시작 시각 정각", FROM, null],
      ["시작 1초 후", ms(FROM, 1000), null],
      ["만료 1초 전", ms(UNTIL, -1000), null],
      ["만료 1ms 전", ms(UNTIL, -1), null],
      ["만료 시각 정각", UNTIL, "EXPIRED"],
      ["만료 1초 후", ms(UNTIL, 1000), "EXPIRED"],
    ] as const)("%s", (_label, now, reason) => {
      const expected = reason ? { allowed: false, reason } : { allowed: true };
      expect(evaluateAccess(facts(), license(), now)).toEqual(expected);
      expect(evaluateAccess(facts(), download, now)).toEqual(expected);
    });
  });

  describe("단일 조건 위반", () => {
    it.each([
      ["수신자 목록에 없음", facts({ membership: null }), license(), "NOT_RECIPIENT"],
      [
        "배포 건 회수",
        facts({ distribution: { ...facts().distribution, revokedAt: revoked } }),
        license(),
        "DISTRIBUTION_REVOKED",
      ],
      [
        "수신자 회수",
        facts({ membership: { revokedAt: revoked } }),
        license(),
        "RECIPIENT_REVOKED",
      ],
      [
        "문서 회수",
        facts({ document: { status: "PACKAGED", revokedAt: revoked } }),
        license(),
        "DOCUMENT_REVOKED",
      ],
      ...(["UPLOADED", "CONVERTING", "FAILED"] as const).map(
        (status) =>
          [
            `문서 상태 ${status}`,
            facts({ document: { status, revokedAt: null } }),
            license(),
            "DOCUMENT_NOT_READY",
          ] as const,
      ),
      ["미등록 기기", facts(), license({ device: null }), "DEVICE_NOT_REGISTERED"],
      ["등록 해제 기기", facts(), license({ device: { revokedAt: revoked } }), "DEVICE_REVOKED"],
    ] as const)("%s → %s", (_label, input, purpose, reason) => {
      expect(evaluateAccess(input, purpose, MID)).toEqual({ allowed: false, reason });
    });
  });

  describe("열람 횟수", () => {
    const limited = facts({ distribution: { ...facts().distribution, maxViews: 3 } });

    it("발급 횟수가 maxViews 미만이면 허용, 같거나 크면 거부한다", () => {
      expect(evaluateAccess(limited, license({ issuedCount: 2 }), MID).allowed).toBe(true);
      expect(evaluateAccess(limited, license({ issuedCount: 3 }), MID)).toEqual({
        allowed: false,
        reason: "VIEW_LIMIT_EXCEEDED",
      });
    });

    it("maxViews가 null이면 무제한이다", () => {
      expect(evaluateAccess(facts(), license({ issuedCount: 1_000_000 }), MID).allowed).toBe(true);
    });
  });

  describe("판정 순서 (스펙 §4)", () => {
    const everythingWrong = (): AccessFacts => ({
      membership: { revokedAt: revoked },
      distribution: { revokedAt: revoked, validFrom: FROM, validUntil: UNTIL, maxViews: 0 },
      document: { revokedAt: revoked, status: "FAILED" },
    });
    const afterExpiry = ms(UNTIL, 1000);
    const badDevice = license({ device: null, issuedCount: 99 });

    it("수신자 목록에 없으면 다른 사유보다 먼저 NOT_RECIPIENT", () => {
      expect(
        evaluateAccess({ ...everythingWrong(), membership: null }, badDevice, afterExpiry),
      ).toEqual({ allowed: false, reason: "NOT_RECIPIENT" });
    });

    it("회수가 만료보다 우선한다", () => {
      expect(evaluateAccess(everythingWrong(), badDevice, afterExpiry)).toEqual({
        allowed: false,
        reason: "DISTRIBUTION_REVOKED",
      });
      const f = everythingWrong();
      f.distribution.revokedAt = null;
      expect(reasonOf(f, badDevice, afterExpiry)).toBe("RECIPIENT_REVOKED");
      f.membership = { revokedAt: null };
      expect(reasonOf(f, badDevice, afterExpiry)).toBe("DOCUMENT_REVOKED");
      f.document.revokedAt = null;
      expect(reasonOf(f, badDevice, afterExpiry)).toBe("DOCUMENT_NOT_READY");
      f.document.status = "PACKAGED";
      expect(reasonOf(f, badDevice, afterExpiry)).toBe("EXPIRED");
    });

    it("기간이 기기보다, 기기가 열람 횟수보다 우선한다", () => {
      const f = facts({ distribution: { ...facts().distribution, maxViews: 1 } });
      expect(reasonOf(f, badDevice, ms(FROM, -1))).toBe("NOT_YET_VALID");
      expect(reasonOf(f, badDevice, MID)).toBe("DEVICE_NOT_REGISTERED");
      expect(reasonOf(f, license({ device: { revokedAt: revoked }, issuedCount: 5 }), MID)).toBe(
        "DEVICE_REVOKED",
      );
    });

    it("다운로드는 기기·열람 횟수 조건을 보지 않는다", () => {
      const f = facts({ distribution: { ...facts().distribution, maxViews: 0 } });
      expect(evaluateAccess(f, download, MID)).toEqual({ allowed: true });
    });
  });

  it("모든 거부 사유에 안내 문구가 있다", () => {
    for (const reason of DenyReasonSchema.options) {
      expect(DENY_MESSAGES[reason]).toMatch(/\S/);
    }
  });
});
