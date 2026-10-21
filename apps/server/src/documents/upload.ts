import { MAX_UPLOAD_BYTES, type SourceFormat } from "@drm/contracts";
import busboy from "busboy";
import type { Request } from "express";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ApiException } from "../common/api-exception.js";

const EXTENSION_FORMATS: Record<string, SourceFormat> = {
  pdf: "PDF",
  docx: "DOCX",
  xlsx: "XLSX",
  pptx: "PPTX",
};

/** 확장자와 실제 내용이 일치하는지 확인하는 파일 시그니처 */
const SIGNATURES: Record<SourceFormat, Buffer> = {
  PDF: Buffer.from("%PDF-", "ascii"),
  // OOXML은 ZIP 컨테이너
  DOCX: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  XLSX: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  PPTX: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
};

export const MAX_FILE_NAME_LENGTH = 255;

export const sourceFormatOf = (fileName: string): SourceFormat | null => {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_FORMATS[ext] ?? null;
};

/** 경로 구분자·제어 문자 제거 */
export const sanitizeFileName = (name: string): string =>
  name
    .replace(/[\\/]/g, "_")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MAX_FILE_NAME_LENGTH);

/**
 * 앞부분이 파일 시그니처와 일치하는지 확인하면서 그대로 통과시키는 스트림
 * 불일치하면 오류로 스트림을 중단합니다.
 */
class SignatureCheck extends Transform {
  private head = Buffer.alloc(0);
  private verified = false;

  constructor(private readonly signature: Buffer) {
    super();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback): void {
    if (!this.verified) {
      this.head = Buffer.concat([this.head, chunk]).subarray(0, this.signature.length);
      if (this.head.length >= this.signature.length) {
        if (!this.head.equals(this.signature)) {
          done(invalidFile("파일 내용이 확장자와 일치하지 않습니다."));
          return;
        }
        this.verified = true;
      }
    }
    done(null, chunk);
  }

  override _flush(done: TransformCallback): void {
    done(this.verified ? null : invalidFile("파일이 비어 있거나 손상되었습니다."));
  }
}

const invalidFile = (message: string) =>
  new ApiException("VALIDATION_FAILED", message, { issues: [{ path: "file", message }] });

export interface UploadedFile {
  fileName: string;
  sourceFormat: SourceFormat;
  /** 시그니처 검사·크기 제한이 적용된 본문 스트림. 반드시 끝까지 소비해야 합니다. */
  stream: Readable;
}

/**
 * multipart/form-data 요청에서 `file` 필드 하나를 스트리밍으로 받습니다.
 * 파일 전체를 메모리에 올리지 않습니다.
 */
export const receiveSingleFile = (
  req: Pick<Request, "headers" | "pipe">,
  maxBytes: number = MAX_UPLOAD_BYTES,
): Promise<UploadedFile> =>
  new Promise((resolve, reject) => {
    let parser: busboy.Busboy;
    try {
      parser = busboy({
        headers: req.headers,
        defParamCharset: "utf8",
        limits: { files: 1, fileSize: maxBytes, fields: 5 },
      });
    } catch (error) {
      reject(invalidFile(`multipart/form-data 요청이 아닙니다. (${(error as Error).message})`));
      return;
    }

    let received = false;
    parser.on("file", (field, file, info) => {
      if (field !== "file" || received) {
        file.resume();
        return;
      }
      received = true;
      const fileName = sanitizeFileName(info.filename ?? "");
      const sourceFormat = sourceFormatOf(fileName);
      if (!fileName || !sourceFormat) {
        file.resume();
        reject(invalidFile("지원하지 않는 파일 형식입니다. (PDF, DOCX, XLSX, PPTX)"));
        return;
      }
      const checked = new SignatureCheck(SIGNATURES[sourceFormat]);
      file.on("limit", () => {
        checked.destroy(invalidFile(`파일 크기 제한(${maxBytes}바이트)을 넘었습니다.`));
      });
      // pipeline은 양쪽 스트림 오류를 전파·정리합니다. 오류는 checked를 읽는 쪽에서 처리하므로
      // 여기서는 처리되지 않은 거부(unhandled rejection)만 막습니다.
      pipeline(file, checked).catch(() => undefined);
      resolve({ fileName, sourceFormat, stream: checked });
    });
    parser.on("error", (error) =>
      reject(invalidFile(`업로드 형식 오류: ${(error as Error).message}`)),
    );
    parser.on("close", () => {
      if (!received) reject(invalidFile("file 필드가 없습니다."));
    });
    req.pipe(parser);
  });
