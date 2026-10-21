import argon2 from "argon2";

/** OWASP 권장 수준의 argon2id 파라미터 */
const HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
} as const;

export const MIN_PASSWORD_LENGTH = 12;

export const hashPassword = (password: string): Promise<string> =>
  argon2.hash(password, HASH_OPTIONS);

/**
 * 존재하지 않는 계정에도 같은 비용의 검증을 수행해 응답 시간으로 계정 존재 여부가 드러나지 않게 합니다.
 */
let dummyHash: Promise<string> | undefined;

export const verifyPassword = async (
  hash: string | null | undefined,
  password: string,
): Promise<boolean> => {
  if (!hash) {
    dummyHash ??= hashPassword("dummy-password-for-timing-equalization");
    await argon2.verify(await dummyHash, password);
    return false;
  }
  try {
    return await argon2.verify(hash, password);
  } catch {
    // 해시 형식 오류는 인증 실패로 처리합니다.
    return false;
  }
};
