import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { ApiException } from "../common/api-exception.js";
import { receiveSingleFile, sanitizeFileName, sourceFormatOf } from "./upload.js";

const BOUNDARY = "----drmtestboundary";

/** multipart/form-data 요청 흉내 */
const multipart = (fileName: string, content: Buffer, field = "file") => {
  const body = Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${field}"; filename="${fileName}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
  const req = Readable.from([body]) as Readable & { headers: Record<string, string> };
  req.headers = { "content-type": `multipart/form-data; boundary=${BOUNDARY}` };
  return req;
};

const consume = async (stream: Readable) => {
  const parts: Buffer[] = [];
  for await (const p of stream) parts.push(p as Buffer);
  return Buffer.concat(parts);
};

describe("업로드 파싱", () => {
  it("확장자로 원본 포맷을 판정한다", () => {
    expect(sourceFormatOf("도면.PDF")).toBe("PDF");
    expect(sourceFormatOf("a.docx")).toBe("DOCX");
    expect(sourceFormatOf("a.dwg")).toBeNull();
    expect(sourceFormatOf("noext")).toBeNull();
  });

  it("파일명에서 경로 구분자와 제어 문자를 제거한다", () => {
    expect(sanitizeFileName("..\\..\\etc/passwd\u0000.pdf")).toBe(".._.._etc_passwd.pdf");
  });

  it("시그니처가 맞으면 본문을 그대로 통과시킨다", async () => {
    const content = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(10_000, 7)]);
    const file = await receiveSingleFile(multipart("설계 도면.pdf", content) as never);
    expect(file).toMatchObject({ fileName: "설계 도면.pdf", sourceFormat: "PDF" });
    expect((await consume(file.stream)).equals(content)).toBe(true);
  });

  it("확장자와 내용이 다르면 스트림 오류", async () => {
    const file = await receiveSingleFile(
      multipart("fake.pdf", Buffer.from("PK\x03\x04zip")) as never,
    );
    await expect(consume(file.stream)).rejects.toBeInstanceOf(ApiException);
  });

  it("빈 파일은 스트림 오류", async () => {
    const file = await receiveSingleFile(multipart("empty.pdf", Buffer.alloc(0)) as never);
    await expect(consume(file.stream)).rejects.toThrow(/비어 있거나/);
  });

  it("크기 제한을 넘으면 스트림 오류", async () => {
    const content = Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(2000)]);
    const file = await receiveSingleFile(multipart("big.pdf", content) as never, 1000);
    await expect(consume(file.stream)).rejects.toThrow(/크기 제한/);
  });

  it("지원하지 않는 형식·file 필드 없음은 거부", async () => {
    await expect(
      receiveSingleFile(multipart("a.dwg", Buffer.from("AC1032")) as never),
    ).rejects.toThrow(/지원하지 않는/);
    await expect(
      receiveSingleFile(multipart("a.pdf", Buffer.from("%PDF-"), "other") as never),
    ).rejects.toThrow(/file 필드/);
  });
});
