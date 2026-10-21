/**
 * 패키징 전 PDF 검사
 * 수신자가 뷰어에서 열 수 없는 문서(손상·암호·빈 문서·너무 큼)를 배포 전에 걸러냅니다.
 * 뷰어와 같은 pdf.js로 실제로 열어 확인합니다.
 */
import { MAX_VIEWABLE_BYTES } from "@drm/contracts";
import type * as PdfJsModule from "pdfjs-dist/legacy/build/pdf.mjs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { PermanentPackagingError } from "./converter.js";

export const PDF_MESSAGES = {
  tooLarge: `문서가 너무 큽니다. (최대 ${MAX_VIEWABLE_BYTES / 1024 / 1024}MB)`,
  password: "암호가 걸린 PDF는 배포할 수 없습니다. 암호를 해제한 뒤 다시 올려 주세요.",
  invalid: "손상되었거나 올바르지 않은 PDF입니다.",
  empty: "페이지가 없는 PDF입니다.",
} as const;

type PdfJs = typeof PdfJsModule;
let pdfjs: Promise<PdfJs> | null = null;

/** Node용 legacy 빌드를 한 번만 불러와 워커 경로를 지정합니다. */
const loadPdfJs = (): Promise<PdfJs> => {
  pdfjs ??= import("pdfjs-dist/legacy/build/pdf.mjs").then((lib) => {
    const workerPath = createRequire(import.meta.url).resolve(
      "pdfjs-dist/legacy/build/pdf.worker.mjs",
    );
    lib.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
    return lib;
  });
  return pdfjs;
};

export interface PdfInfo {
  pages: number;
}

export const inspectPdf = async (data: Uint8Array): Promise<PdfInfo> => {
  if (data.length > MAX_VIEWABLE_BYTES) throw new PermanentPackagingError(PDF_MESSAGES.tooLarge);
  const lib = await loadPdfJs();
  // pdf.js는 버퍼를 워커로 넘기며 비우므로 사본을 전달합니다. (Node Buffer는 받지 않아 일반 Uint8Array로 복사)
  let task: ReturnType<PdfJs["getDocument"]> | null = null;
  try {
    task = lib.getDocument({ data: new Uint8Array(data), enableXfa: false, verbosity: 0 });
    const doc = await task.promise;
    if (doc.numPages < 1) throw new PermanentPackagingError(PDF_MESSAGES.empty);
    // 첫 페이지까지 실제로 읽어 구조 손상을 확인합니다.
    await doc.getPage(1);
    return { pages: doc.numPages };
  } catch (error) {
    if (error instanceof PermanentPackagingError) throw error;
    const name = (error as { name?: string }).name;
    if (name === "PasswordException") {
      throw new PermanentPackagingError(PDF_MESSAGES.password, { cause: error });
    }
    throw new PermanentPackagingError(PDF_MESSAGES.invalid, { cause: error });
  } finally {
    await task?.destroy();
  }
};
