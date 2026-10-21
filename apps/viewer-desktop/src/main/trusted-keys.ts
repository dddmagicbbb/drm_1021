/**
 * 서버 서명 공개키 (신뢰 목록)
 * 운영 빌드: 설치 패키지에 포함된 trusted-keys.json만 신뢰합니다. (서버가 바뀌어도 위조 키를 받지 않음)
 * 개발 모드: 파일이 없으면 개발 서버의 /keys/signing을 조회합니다.
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { TrustedKeys } from "./license.js";

const TrustedKeysFileSchema = z.object({
  keys: z.array(z.object({ kid: z.string().min(1), publicKey: z.string().min(1) })).min(1),
});

const toMap = (keys: { kid: string; publicKey: string }[]): TrustedKeys =>
  new Map(keys.map((k) => [k.kid, Buffer.from(k.publicKey, "base64url")]));

export const loadTrustedKeys = async (options: {
  filePath: string;
  allowServerFetch: boolean;
  fetchFromServer: () => Promise<{ kid: string; publicKey: string }[]>;
}): Promise<TrustedKeys> => {
  try {
    const raw = await readFile(options.filePath, "utf8");
    return toMap(TrustedKeysFileSchema.parse(JSON.parse(raw)).keys);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    if (!missing || !options.allowServerFetch) {
      throw new Error("신뢰할 서버 서명 키 목록을 읽을 수 없습니다.", { cause: error });
    }
  }
  return toMap(await options.fetchFromServer());
};
