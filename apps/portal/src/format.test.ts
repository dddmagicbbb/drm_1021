import { describe, expect, it } from "vitest";
import { formatBytes, fromLocalInput, parseRecipients, toLocalInput } from "./format.js";

describe("parseRecipients", () => {
  it("줄바꿈·쉼표·세미콜론으로 나누고 정규화·중복 제거한다", () => {
    expect(parseRecipients("Kim@Customer.co.kr, lee@customer.co.kr;\nkim@customer.co.kr")).toEqual({
      valid: ["kim@customer.co.kr", "lee@customer.co.kr"],
      invalid: [],
    });
  });

  it("CSV 머리글·이름은 무시하고 잘못된 주소만 표시한다", () => {
    const csv = 'email,이름\n"park@customer.co.kr",박과장\nbad@,홍';
    expect(parseRecipients(csv)).toEqual({ valid: ["park@customer.co.kr"], invalid: ["bad@"] });
  });

  it("<주소> 형식도 받는다", () => {
    expect(parseRecipients("<choi@customer.co.kr>").valid).toEqual(["choi@customer.co.kr"]);
  });
});

describe("기타 형식", () => {
  it("datetime-local 값과 ISO를 왕복 변환한다", () => {
    const iso = new Date(2026, 9, 21, 9, 30).toISOString();
    expect(fromLocalInput(toLocalInput(iso))).toBe(iso);
  });

  it("바이트를 읽기 쉽게 표시한다", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB");
  });
});
