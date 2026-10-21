/**
 * Prisma Bytes 컬럼은 ArrayBuffer 기반 Uint8Array만 받습니다.
 * Node Buffer(풀 공유 가능)를 독립 복사본으로 변환합니다.
 */
export const toBytes = (data: Uint8Array): Uint8Array<ArrayBuffer> => Uint8Array.from(data);
