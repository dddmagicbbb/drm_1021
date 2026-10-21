/**
 * Office(DOCX/XLSX/PPTX) → PDF 변환 (Gotenberg = LibreOffice HTTP 서버)
 * 변환 중 평문이 임시 파일로 존재하므로, 작업 디렉터리는 소유자 전용 권한으로 만들고 즉시 삭제합니다.
 */
import type { SourceFormat } from "@drm/contracts";
import { createReadStream, createWriteStream, openAsBlob } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import {
  type ContentConverter,
  PermanentPackagingError,
  type PreparedContent,
} from "./converter.js";

const EXTENSIONS: Partial<Record<SourceFormat, string>> = {
  DOCX: "docx",
  XLSX: "xlsx",
  PPTX: "pptx",
};

export const CONVERSION_FAILED_MESSAGE =
  "문서를 PDF로 변환할 수 없습니다. 파일이 손상되었거나 암호가 걸려 있는지 확인하세요.";

export interface GotenbergOptions {
  baseUrl: string;
  timeoutMs: number;
  /** 임시 작업 디렉터리 상위 경로 (기본: OS 임시 폴더) */
  tempRoot?: string;
}

export class GotenbergOfficeConverter implements ContentConverter {
  constructor(private readonly options: GotenbergOptions) {}

  supports(format: SourceFormat): boolean {
    return format in EXTENSIONS;
  }

  async prepare(input: Parameters<ContentConverter["prepare"]>[0]): Promise<PreparedContent> {
    const ext = EXTENSIONS[input.format];
    if (!ext) throw new PermanentPackagingError(`지원하지 않는 형식입니다: ${input.format}`);
    if (input.size === 0) throw new PermanentPackagingError("빈 파일입니다.");

    const dir = await mkdtemp(join(this.options.tempRoot ?? tmpdir(), "drm-convert-"));
    const cleanup = () => rm(dir, { recursive: true, force: true });
    try {
      // 원래 파일명은 보내지 않습니다. (변환 서버 로그에 남지 않도록)
      const sourcePath = join(dir, `source.${ext}`);
      await pipeline(await input.source(), createWriteStream(sourcePath, { mode: 0o600 }));

      const form = new FormData();
      form.append("files", await openAsBlob(sourcePath), `source.${ext}`);

      let res: Response;
      try {
        res = await fetch(`${this.options.baseUrl}/forms/libreoffice/convert`, {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });
      } catch (error) {
        // 연결 실패·시간 초과는 일시적 오류로 보고 재시도에 맡깁니다.
        throw new Error("변환 서버에 연결할 수 없거나 응답이 없습니다.", { cause: error });
      }
      if (res.status >= 400 && res.status < 500) {
        throw new PermanentPackagingError(CONVERSION_FAILED_MESSAGE, {
          cause: new Error(`Gotenberg ${res.status}`),
        });
      }
      if (!res.ok || !res.body) throw new Error(`변환 서버 오류: HTTP ${res.status}`);

      const outputPath = join(dir, "converted.pdf");
      await pipeline(
        Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
        createWriteStream(outputPath, { mode: 0o600 }),
      );
      await assertPdf(outputPath);
      const { size } = await stat(outputPath);

      return {
        contentType: "application/pdf",
        size,
        stream: async () => createReadStream(outputPath),
        cleanup,
      };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }
}

const assertPdf = async (path: string): Promise<void> => {
  const file = await open(path, "r");
  try {
    const head = Buffer.alloc(5);
    const { bytesRead } = await file.read(head, 0, 5, 0);
    if (bytesRead < 5 || head.toString("ascii") !== "%PDF-") {
      throw new PermanentPackagingError(CONVERSION_FAILED_MESSAGE, {
        cause: new Error("변환 결과가 PDF가 아님"),
      });
    }
  } finally {
    await file.close();
  }
};
