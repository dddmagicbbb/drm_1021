import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ApiErrorSchema,
  ContainerHeaderSchema,
  CreateDistributionRequestSchema,
  DEFAULT_POLICY_VALUES,
  EmailSchema,
  LicensePayloadSchema,
  OtpVerifyRequestSchema,
  PolicySchema,
  RegisterDeviceRequestSchema,
  UpdateDistributionRequestSchema,
  base64UrlBytes,
  base64UrlDecodedLength,
  type Policy,
} from "./index.js";

const b64u = (n: number) => randomBytes(n).toString("base64url");

const validPolicy = (): Policy => ({
  validFrom: "2026-10-21T00:00:00.000Z",
  validUntil: "2026-11-20T00:00:00.000Z",
  ...DEFAULT_POLICY_VALUES,
});

describe("common", () => {
  it("이메일을 소문자·공백 제거로 정규화한다", () => {
    expect(EmailSchema.parse("  Kim@Customer.CO.KR ")).toBe("kim@customer.co.kr");
  });

  it("잘못된 이메일을 거부한다", () => {
    expect(EmailSchema.safeParse("not-an-email").success).toBe(false);
  });

  it("base64url 디코딩 길이를 Buffer와 동일하게 계산한다", () => {
    for (const n of [0, 1, 2, 3, 7, 32, 40, 64]) {
      const encoded = b64u(n);
      expect(base64UrlDecodedLength(encoded)).toBe(Buffer.from(encoded, "base64url").length);
    }
  });

  it("바이트 길이가 다르면 거부한다", () => {
    const schema = base64UrlBytes(32);
    expect(schema.safeParse(b64u(32)).success).toBe(true);
    expect(schema.safeParse(b64u(31)).success).toBe(false);
    expect(schema.safeParse("abc+/=").success).toBe(false);
  });
});

describe("PolicySchema", () => {
  it("기본값으로 만든 정책을 허용한다", () => {
    expect(PolicySchema.safeParse(validPolicy()).success).toBe(true);
  });

  it("만료일이 시작일보다 같거나 이르면 거부한다", () => {
    const p = { ...validPolicy(), validUntil: "2026-10-21T00:00:00.000Z" };
    const result = PolicySchema.safeParse(p);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["validUntil"]);
  });

  it("오프라인 유예·기기 수 범위를 검사한다", () => {
    expect(PolicySchema.safeParse({ ...validPolicy(), offlineGraceHours: 73 }).success).toBe(false);
    expect(PolicySchema.safeParse({ ...validPolicy(), maxDevices: 0 }).success).toBe(false);
    expect(PolicySchema.safeParse({ ...validPolicy(), maxViews: 0 }).success).toBe(false);
  });
});

describe("배포 요청", () => {
  it("대소문자만 다른 수신자도 중복으로 판정한다", () => {
    const result = CreateDistributionRequestSchema.safeParse({
      title: "도면 송부",
      recipients: ["a@x.com", "A@X.com"],
      policy: validPolicy(),
    });
    expect(result.success).toBe(false);
  });

  it("수신자가 없으면 거부한다", () => {
    const result = CreateDistributionRequestSchema.safeParse({
      title: "도면 송부",
      recipients: [],
      policy: validPolicy(),
    });
    expect(result.success).toBe(false);
  });

  it("수정 요청에 변경 항목이 없으면 거부한다", () => {
    expect(UpdateDistributionRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateDistributionRequestSchema.safeParse({ title: "새 제목" }).success).toBe(true);
  });
});

describe("인증·기기", () => {
  it("OTP는 숫자 6자리만 허용한다", () => {
    const email = "a@x.com";
    expect(OtpVerifyRequestSchema.safeParse({ email, code: "123456" }).success).toBe(true);
    expect(OtpVerifyRequestSchema.safeParse({ email, code: "12345" }).success).toBe(false);
    expect(OtpVerifyRequestSchema.safeParse({ email, code: "12345a" }).success).toBe(false);
  });

  it("기기 공개키는 32바이트여야 한다", () => {
    const base = { name: "설계팀 PC", platform: "WINDOWS" };
    expect(RegisterDeviceRequestSchema.safeParse({ ...base, publicKey: b64u(32) }).success).toBe(
      true,
    );
    expect(RegisterDeviceRequestSchema.safeParse({ ...base, publicKey: b64u(33) }).success).toBe(
      false,
    );
  });
});

describe("라이선스·컨테이너", () => {
  it("라이선스 본문을 검증한다", () => {
    const payload = {
      v: 1,
      licenseId: randomUUID(),
      docId: randomUUID(),
      recipientId: randomUUID(),
      deviceId: randomUUID(),
      contentType: "application/pdf",
      issuedAt: "2026-10-21T00:00:00.000Z",
      expiresAt: "2026-10-21T00:10:00.000Z",
      permissions: { view: true },
      watermark: { text: "kim@customer.co.kr · 2026-10-21 09:00" },
      key: {
        alg: "X25519-HKDF-SHA256-A256KW",
        ephemeralPublicKey: b64u(32),
        wrappedKey: b64u(40),
      },
    };
    expect(LicensePayloadSchema.safeParse(payload).success).toBe(true);
    expect(
      LicensePayloadSchema.safeParse({ ...payload, permissions: { view: false } }).success,
    ).toBe(false);
  });

  it("컨테이너 헤더의 청크 크기 범위를 검사한다", () => {
    const header = {
      v: 1,
      docId: randomUUID(),
      alg: "AES-256-GCM-STREAM",
      contentType: "application/pdf",
      chunkSize: 1024 * 1024,
      plaintextSize: 0,
      noncePrefix: b64u(7),
      kid: "srv-2026-10",
      createdAt: "2026-10-21T00:00:00.000Z",
    };
    expect(ContainerHeaderSchema.safeParse(header).success).toBe(true);
    expect(ContainerHeaderSchema.safeParse({ ...header, chunkSize: 100 }).success).toBe(false);
  });

  it("오류 응답은 거부 사유 코드를 허용한다", () => {
    const result = ApiErrorSchema.safeParse({
      error: {
        code: "EXPIRED",
        message: "열람 기간이 만료되었습니다.",
        correlationId: "abc",
        contact: { name: "홍길동", email: "hong@company.com" },
      },
    });
    expect(result.success).toBe(true);
  });
});
