/**
 * 실제 Gotenberg(LibreOffice)로 Office → PDF 변환 검증
 * GOTENBERG_URL이 설정된 환경(로컬 docker compose, CI 서비스)에서만 실행합니다.
 */
import { config } from "dotenv";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { readAll } from "../src/converter.js";
import { GotenbergOfficeConverter } from "../src/gotenberg.js";
import { inspectPdf } from "../src/pdf-inspect.js";
import { makeDocx, makePptx, makeXlsx } from "./support/office-fixtures.js";

config({ path: ["../../.env", ".env"], quiet: true });
const gotenbergUrl = process.env.GOTENBERG_URL;

/** 변환된 PDF의 모든 텍스트 */
const pdfText = async (data: Uint8Array): Promise<string> => {
  const lib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  lib.GlobalWorkerOptions.workerSrc = pathToFileURL(
    createRequire(import.meta.url).resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"),
  ).href;
  const task = lib.getDocument({ data: new Uint8Array(data), verbosity: 0 });
  const doc = await task.promise;
  const texts: string[] = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const content = await (await doc.getPage(i)).getTextContent();
    texts.push(content.items.map((item) => ("str" in item ? item.str : "")).join(""));
  }
  await task.destroy();
  return texts.join("\n");
};

describe.runIf(gotenbergUrl)("Gotenberg 실제 변환 (T1-15)", () => {
  const converter = new GotenbergOfficeConverter({ baseUrl: gotenbergUrl!, timeoutMs: 120_000 });

  const convert = async (format: "DOCX" | "XLSX" | "PPTX", content: Buffer) => {
    const prepared = await converter.prepare({
      docId: "d",
      fileName: `sample.${format.toLowerCase()}`,
      format,
      size: content.length,
      source: async () => Readable.from([content]),
    });
    try {
      const pdf = await readAll(await prepared.stream());
      expect(pdf.length).toBe(prepared.size);
      return { pdf, info: await inspectPdf(pdf), text: await pdfText(pdf) };
    } finally {
      await prepared.cleanup();
    }
  };

  it.each([
    ["DOCX", () => makeDocx("A사 설비 사양서 검증 문서"), "A사 설비 사양서"],
    [
      "XLSX",
      () =>
        makeXlsx([
          ["품목", "수량", "단가"],
          ["볼트 M8", "120", "350"],
        ]),
      "볼트 M8",
    ],
    ["PPTX", () => makePptx("2차 설계 검토 회의"), "2차 설계 검토 회의"],
  ] as const)(
    "%s → PDF (한글 내용 보존)",
    async (format, make, expected) => {
      const { info, text } = await convert(format, make());
      expect(info.pages).toBeGreaterThanOrEqual(1);
      // 글꼴에 따라 공백이 달라질 수 있어 공백을 제거하고 비교합니다.
      expect(text.replace(/\s/g, "")).toContain(expected.replace(/\s/g, ""));
    },
    180_000,
  );

  it("손상된 Office 파일은 영구 오류", async () => {
    const broken = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 7)]);
    await expect(convert("DOCX", broken)).rejects.toMatchObject({
      name: "PermanentPackagingError",
    });
  }, 180_000);
});
