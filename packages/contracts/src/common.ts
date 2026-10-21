import { z } from "zod";

/** 모든 엔티티 식별자는 UUID 문자열을 사용합니다. */
export const IdSchema = z.uuid();
export type Id = z.infer<typeof IdSchema>;

/** 시각은 UTC ISO 8601 문자열로 주고받습니다. (예: 2026-10-21T09:00:00.000Z) */
export const IsoDateTimeSchema = z.iso.datetime();
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

/** 이메일은 앞뒤 공백 제거 후 소문자로 정규화합니다. 수신자 비교의 기준값입니다. */
export const EmailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
export type Email = z.infer<typeof EmailSchema>;

/** 바이너리 값(키, 서명 등)은 패딩 없는 base64url로 인코딩합니다. */
export const Base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]*$/, "base64url 형식이 아닙니다");
export type Base64Url = z.infer<typeof Base64UrlSchema>;

/** 패딩 없는 base64url 문자열의 디코딩 바이트 수. 유효하지 않은 길이면 -1 */
export const base64UrlDecodedLength = (value: string): number =>
  value.length % 4 === 1 ? -1 : Math.floor((value.length * 3) / 4);

/**
 * 지정한 바이트 길이를 갖는 base64url 문자열
 * 브라우저에서도 쓰이므로 Buffer 없이 길이만 계산합니다.
 */
export const base64UrlBytes = (byteLength: number) =>
  Base64UrlSchema.refine(
    (value) => base64UrlDecodedLength(value) === byteLength,
    `디코딩 결과가 ${byteLength}바이트여야 합니다`,
  );
