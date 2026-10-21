/**
 * 개발·테스트용 로컬 KMS
 * 마스터키를 파일(키링)로 보관합니다. 운영 환경에서는 생성 자체를 거부합니다.
 *
 * 래핑: AES-256-GCM, nonce 12바이트 무작위, AAD = "drm-1021:cek:v1" ‖ 0x00 ‖ docId
 * ciphertext = nonce(12) ‖ 암호문 ‖ tag(16)
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { wipe } from "@drm/crypto";
import { KmsError, type KeyContext, type KmsProvider, type WrappedDataKey } from "./kms.js";

const MASTER_KEY_LENGTH = 32;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const AAD_CONTEXT = "drm-1021:cek:v1";

/** 키링 파일 형식 */
export interface LocalKeyring {
  activeKeyId: string;
  /** keyId → base64url(32바이트 마스터키) */
  keys: Record<string, string>;
}

const contextAad = (context: KeyContext): Buffer =>
  Buffer.concat([
    Buffer.from(AAD_CONTEXT, "ascii"),
    Buffer.from([0]),
    Buffer.from(context.docId, "utf8"),
  ]);

export class LocalKmsProvider implements KmsProvider {
  readonly name = "local";
  private readonly keys: Map<string, Buffer>;
  private readonly activeKeyId: string;

  constructor(keyring: LocalKeyring) {
    this.keys = new Map();
    for (const [keyId, encoded] of Object.entries(keyring.keys)) {
      const key = Buffer.from(encoded, "base64url");
      if (key.length !== MASTER_KEY_LENGTH) {
        throw new KmsError("INVALID_KEYRING", `마스터키 길이가 올바르지 않습니다: ${keyId}`);
      }
      this.keys.set(keyId, key);
    }
    if (!this.keys.has(keyring.activeKeyId)) {
      throw new KmsError("INVALID_KEYRING", "활성 마스터키가 키링에 없습니다");
    }
    this.activeKeyId = keyring.activeKeyId;
  }

  async wrapKey(plaintextKey: Uint8Array, context: KeyContext): Promise<WrappedDataKey> {
    const masterKey = this.keys.get(this.activeKeyId)!;
    const nonce = randomBytes(NONCE_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", masterKey, nonce, { authTagLength: TAG_LENGTH });
    cipher.setAAD(contextAad(context));
    const body = Buffer.concat([cipher.update(plaintextKey), cipher.final()]);
    return {
      keyId: this.activeKeyId,
      ciphertext: Buffer.concat([nonce, body, cipher.getAuthTag()]),
    };
  }

  async unwrapKey(wrapped: WrappedDataKey, context: KeyContext): Promise<Buffer> {
    const masterKey = this.keys.get(wrapped.keyId);
    if (!masterKey) {
      throw new KmsError("KEY_NOT_FOUND", `마스터키를 찾을 수 없습니다: ${wrapped.keyId}`);
    }
    const { ciphertext } = wrapped;
    if (ciphertext.length < NONCE_LENGTH + TAG_LENGTH) {
      throw new KmsError("UNWRAP_FAILED", "래핑된 키 형식이 올바르지 않습니다");
    }
    const nonce = ciphertext.subarray(0, NONCE_LENGTH);
    const tag = ciphertext.subarray(ciphertext.length - TAG_LENGTH);
    const body = ciphertext.subarray(NONCE_LENGTH, ciphertext.length - TAG_LENGTH);
    const decipher = createDecipheriv("aes-256-gcm", masterKey, nonce, {
      authTagLength: TAG_LENGTH,
    });
    decipher.setAAD(contextAad(context));
    decipher.setAuthTag(tag);
    const head = decipher.update(body);
    try {
      return Buffer.concat([head, decipher.final()]);
    } catch (error) {
      wipe(head);
      throw new KmsError("UNWRAP_FAILED", "키 언래핑에 실패했습니다 (문맥 불일치 또는 변조)", {
        cause: error,
      });
    }
  }
}

/** 새 키링 생성 (개발 환경 초기화용) */
export const generateLocalKeyring = (keyId = `local-${Date.now()}`): LocalKeyring => ({
  activeKeyId: keyId,
  keys: { [keyId]: randomBytes(MASTER_KEY_LENGTH).toString("base64url") },
});

/** 키링에 새 마스터키를 추가하고 활성 키로 지정합니다. 기존 키는 언래핑용으로 유지됩니다. */
export const rotateLocalKeyring = (
  keyring: LocalKeyring,
  keyId = `local-${Date.now()}`,
): LocalKeyring => {
  if (keyring.keys[keyId]) {
    throw new KmsError("INVALID_KEYRING", `이미 존재하는 keyId입니다: ${keyId}`);
  }
  return {
    activeKeyId: keyId,
    keys: { ...keyring.keys, [keyId]: randomBytes(MASTER_KEY_LENGTH).toString("base64url") },
  };
};

export interface CreateLocalKmsOptions {
  keyringPath: string;
  nodeEnv: string | undefined;
  /** 파일이 없으면 새로 만듭니다. (개발 환경 편의) */
  createIfMissing?: boolean;
}

/**
 * 키링 파일에서 로컬 KMS를 생성합니다.
 * NODE_ENV=production이면 거부합니다. 운영 마스터키를 파일로 두지 않기 위함입니다.
 */
export const createLocalKmsProvider = async (
  options: CreateLocalKmsOptions,
): Promise<LocalKmsProvider> => {
  if (options.nodeEnv === "production") {
    throw new KmsError(
      "FORBIDDEN_IN_PRODUCTION",
      "운영 환경에서는 LocalKmsProvider를 사용할 수 없습니다. Vault 또는 AWS KMS를 설정하세요.",
    );
  }
  let raw: string;
  try {
    raw = await readFile(options.keyringPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && options.createIfMissing) {
      const keyring = generateLocalKeyring();
      // 소유자만 읽을 수 있도록 생성 (POSIX). Windows에서는 무시됩니다.
      await writeFile(options.keyringPath, JSON.stringify(keyring, null, 2), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      return new LocalKmsProvider(keyring);
    }
    throw new KmsError("INVALID_KEYRING", "키링 파일을 읽을 수 없습니다", { cause: error });
  }
  let keyring: LocalKeyring;
  try {
    keyring = JSON.parse(raw) as LocalKeyring;
  } catch (error) {
    throw new KmsError("INVALID_KEYRING", "키링 파일 형식이 올바르지 않습니다", { cause: error });
  }
  return new LocalKmsProvider(keyring);
};
