import { makeTestPdf } from "@drm/contracts/testing";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PermanentPackagingError } from "../src/converter.js";
import { PDF_MESSAGES, inspectPdf } from "../src/pdf-inspect.js";

const reasonOf = async (data: Uint8Array) => {
  const error = await inspectPdf(data).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(PermanentPackagingError);
  return (error as PermanentPackagingError).userMessage;
};

describe("PDF 사전 검사", () => {
  it("정상 PDF의 페이지 수를 확인한다", async () => {
    expect(await inspectPdf(makeTestPdf({ pages: 3 }))).toEqual({ pages: 3 });
    expect(await inspectPdf(makeTestPdf({ payload: randomBytes(100_000) }))).toEqual({ pages: 1 });
  });

  it("암호가 걸린 PDF를 거부한다", async () => {
    expect(await reasonOf(makeTestPdf({ encrypted: true }))).toBe(PDF_MESSAGES.password);
  });

  it("손상된 PDF·PDF가 아닌 파일을 거부한다", async () => {
    expect(await reasonOf(Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(5000)]))).toBe(
      PDF_MESSAGES.invalid,
    );
    expect(await reasonOf(Buffer.from("not a pdf"))).toBe(PDF_MESSAGES.invalid);
  });

  it("검사에 넘긴 버퍼를 비우지 않는다 (pdf.js는 사본 사용)", async () => {
    const pdf = makeTestPdf();
    const before = Buffer.from(pdf);
    await inspectPdf(pdf);
    expect(Buffer.from(pdf).equals(before)).toBe(true);
  });
});
