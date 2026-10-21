import { describe, expect, it } from "vitest";
import { maskSensitive } from "./audit.service.js";

describe("maskSensitive", () => {
  it("민감한 이름의 필드를 재귀적으로 가린다", () => {
    expect(
      maskSensitive({
        email: "a@x.com",
        password: "p@ss",
        refreshToken: "t",
        nested: { otpCode: "123456", reason: "EXPIRED", list: [{ cek: "k" }] },
      }),
    ).toEqual({
      email: "a@x.com",
      password: "[REDACTED]",
      refreshToken: "[REDACTED]",
      nested: { otpCode: "[REDACTED]", reason: "EXPIRED", list: [{ cek: "[REDACTED]" }] },
    });
  });

  it("바이너리 값은 이름과 관계없이 가리고, Date·BigInt는 문자열로 바꾼다", () => {
    expect(
      maskSensitive({ blob: Buffer.from("x"), at: new Date("2026-10-21T00:00:00Z"), size: 10n }),
    ).toEqual({ blob: "[REDACTED]", at: "2026-10-21T00:00:00.000Z", size: "10" });
  });

  it("너무 깊은 객체는 잘라낸다", () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
    expect(JSON.stringify(maskSensitive(deep))).toContain("[REDACTED]");
  });
});
