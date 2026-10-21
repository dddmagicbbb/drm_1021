import type { PackagedContentType, SourceFormat } from "@drm/contracts";
import type { Readable } from "node:stream";

/** 패키징 직전의 콘텐츠 (중간 포맷) */
export interface PreparedContent {
  contentType: PackagedContentType;
  /** 평문 크기. 컨테이너 헤더에 기록되므로 정확해야 합니다. */
  size: number;
  stream: () => Promise<Readable>;
  /** 변환 중 생긴 임시 파일 정리 */
  cleanup: () => Promise<void>;
}

/**
 * 원본 → 중간 포맷 변환기
 * 1단계: PDF(그대로), Office → PDF. 2단계 이후 DWG → PDF, 3D → glTF를 추가합니다.
 */
export interface ContentConverter {
  supports(format: SourceFormat): boolean;
  prepare(input: {
    docId: string;
    fileName: string;
    format: SourceFormat;
    source: () => Promise<Readable>;
    size: number;
  }): Promise<PreparedContent>;
}

/**
 * 재시도해도 결과가 같은 오류 (손상 파일, 지원하지 않는 형식 등)
 * 워커는 이 오류를 받으면 재시도하지 않고 즉시 FAILED로 처리합니다.
 */
export class PermanentPackagingError extends Error {
  override readonly name = "PermanentPackagingError";

  /** @param userMessage 발신자에게 보여줄 사유 (민감정보 미포함) */
  constructor(
    readonly userMessage: string,
    options?: { cause?: unknown },
  ) {
    super(userMessage, options);
  }
}

/** PDF는 변환 없이 그대로 패키징합니다. */
export class PdfPassthroughConverter implements ContentConverter {
  supports(format: SourceFormat): boolean {
    return format === "PDF";
  }

  async prepare(input: Parameters<ContentConverter["prepare"]>[0]): Promise<PreparedContent> {
    if (input.size === 0) throw new PermanentPackagingError("빈 파일입니다.");
    return {
      contentType: "application/pdf",
      size: input.size,
      stream: input.source,
      cleanup: async () => {},
    };
  }
}
