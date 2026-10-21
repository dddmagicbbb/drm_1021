/**
 * 서버 서명 키 (Ed25519)
 * 컨테이너 헤더 서명과 라이선스 서명에 사용합니다. 뷰어는 kid → 공개키 목록으로 검증합니다.
 * 운영 환경은 KMS/HSM 서명 구현으로 교체합니다.
 */
import {
  type SigningContext,
  exportPrivateKeyDer,
  generateEd25519KeyPair,
  importPrivateKeyDer,
  publicKeyOf,
  signWithContext,
} from "@drm/crypto";
import type { KeyObject } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { KmsError } from "./kms.js";

export interface SigningPublicKey {
  kid: string;
  /** raw Ed25519 공개키 32바이트 (base64url) */
  publicKey: string;
}

export interface SigningKeyProvider {
  /** 새 서명에 사용하는 키 ID */
  readonly activeKid: string;
  sign(context: SigningContext, message: Uint8Array): Promise<Buffer>;
  /** 검증용 공개키 목록 (교체 전 키 포함) */
  publicKeys(): SigningPublicKey[];
}

/** 서명 키링 파일 형식 */
export interface LocalSigningKeyringFile {
  activeKid: string;
  /** kid → base64url(PKCS#8 DER Ed25519 개인키) */
  keys: Record<string, string>;
}

export class LocalSigningKeyProvider implements SigningKeyProvider {
  readonly activeKid: string;
  private readonly keys: Map<string, KeyObject>;

  constructor(file: LocalSigningKeyringFile) {
    this.keys = new Map();
    for (const [kid, encoded] of Object.entries(file.keys)) {
      let key: KeyObject;
      try {
        key = importPrivateKeyDer(Buffer.from(encoded, "base64url"));
      } catch (error) {
        throw new KmsError("INVALID_KEYRING", `서명 키를 읽을 수 없습니다: ${kid}`, {
          cause: error,
        });
      }
      if (key.asymmetricKeyType !== "ed25519") {
        throw new KmsError("INVALID_KEYRING", `Ed25519 키가 아닙니다: ${kid}`);
      }
      this.keys.set(kid, key);
    }
    if (!this.keys.has(file.activeKid)) {
      throw new KmsError("INVALID_KEYRING", "활성 서명 키가 키링에 없습니다");
    }
    this.activeKid = file.activeKid;
  }

  async sign(context: SigningContext, message: Uint8Array): Promise<Buffer> {
    return signWithContext(this.keys.get(this.activeKid)!, context, message);
  }

  publicKeys(): SigningPublicKey[] {
    return [...this.keys.entries()].map(([kid, key]) => ({
      kid,
      publicKey: publicKeyOf(key).toString("base64url"),
    }));
  }
}

export const generateLocalSigningKeyring = (
  kid = `srv-${new Date().toISOString().slice(0, 10)}`,
): LocalSigningKeyringFile => ({
  activeKid: kid,
  keys: { [kid]: exportPrivateKeyDer(generateEd25519KeyPair().privateKey).toString("base64url") },
});

export interface CreateLocalSigningOptions {
  keyringPath: string;
  nodeEnv: string | undefined;
  createIfMissing?: boolean;
}

/** 키링 파일에서 로컬 서명 키를 생성합니다. NODE_ENV=production이면 거부합니다. */
export const createLocalSigningKeyProvider = async (
  options: CreateLocalSigningOptions,
): Promise<LocalSigningKeyProvider> => {
  if (options.nodeEnv === "production") {
    throw new KmsError(
      "FORBIDDEN_IN_PRODUCTION",
      "운영 환경에서는 로컬 서명 키를 사용할 수 없습니다. KMS/HSM 서명을 설정하세요.",
    );
  }
  let raw: string;
  try {
    raw = await readFile(options.keyringPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && options.createIfMissing) {
      const keyring = generateLocalSigningKeyring();
      try {
        await writeFile(options.keyringPath, JSON.stringify(keyring, null, 2), {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
        return new LocalSigningKeyProvider(keyring);
      } catch (writeError) {
        // 다른 프로세스(서버·워커)가 먼저 만든 경우 그 파일을 사용합니다.
        if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
        raw = await readFile(options.keyringPath, "utf8");
      }
    } else {
      throw new KmsError("INVALID_KEYRING", "서명 키링 파일을 읽을 수 없습니다", { cause: error });
    }
  }
  try {
    return new LocalSigningKeyProvider(JSON.parse(raw) as LocalSigningKeyringFile);
  } catch (error) {
    if (error instanceof KmsError) throw error;
    throw new KmsError("INVALID_KEYRING", "서명 키링 파일 형식이 올바르지 않습니다", {
      cause: error,
    });
  }
};
