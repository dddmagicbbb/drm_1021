/**
 * 키 생성·변환, AES-KW, X25519 기반 CEK 래핑
 * 스펙: docs/specs/license-api.md §6
 */
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
} from "node:crypto";
import { CEK_LENGTH, wipe } from "./aead.js";
import { CryptoError } from "./errors.js";

export const X25519_KEY_LENGTH = 32;
export const ED25519_PUBLIC_KEY_LENGTH = 32;
export const AES_KW_KEY_LENGTH = 32;
/** AES-KW(RFC 3394) 출력은 입력 + 8바이트 */
export const WRAPPED_CEK_LENGTH = CEK_LENGTH + 8;

/** HKDF info 도메인 분리 문자열 */
export const LICENSE_KEK_INFO = "drm-1021:license-kek:v1";

/** RFC 3394 기본 IV */
const AES_KW_IV = Buffer.from("A6A6A6A6A6A6A6A6", "hex");
const AES_KW = "id-aes256-wrap";

export interface RawKeyPair {
  /** raw 공개키 32바이트 */
  publicKey: Buffer;
  privateKey: KeyObject;
}

// ── 키 변환 ──────────────────────────────────────────────────

type OkpCurve = "X25519" | "Ed25519";

const rawPublicKey = (key: KeyObject): Buffer => {
  const jwk = key.export({ format: "jwk" });
  if (typeof jwk.x !== "string") {
    throw new CryptoError("INVALID_KEY", "OKP 공개키가 아닙니다");
  }
  return Buffer.from(jwk.x, "base64url");
};

const importRawPublicKey = (crv: OkpCurve, raw: Uint8Array): KeyObject => {
  if (raw.length !== X25519_KEY_LENGTH) {
    throw new CryptoError("INVALID_PUBLIC_KEY", `${crv} 공개키 길이가 올바르지 않습니다`);
  }
  try {
    return createPublicKey({
      key: { kty: "OKP", crv, x: Buffer.from(raw).toString("base64url") },
      format: "jwk",
    });
  } catch (error) {
    throw new CryptoError("INVALID_PUBLIC_KEY", `${crv} 공개키를 읽을 수 없습니다`, {
      cause: error,
    });
  }
};

export const importX25519PublicKey = (raw: Uint8Array): KeyObject =>
  importRawPublicKey("X25519", raw);

export const importEd25519PublicKey = (raw: Uint8Array): KeyObject =>
  importRawPublicKey("Ed25519", raw);

/** 개인키를 PKCS#8 DER로 내보냅니다. 보관 시 반드시 OS 보호 저장소(DPAPI 등)나 KMS로 감쌉니다. */
export const exportPrivateKeyDer = (key: KeyObject): Buffer =>
  key.export({ format: "der", type: "pkcs8" });

export const importPrivateKeyDer = (der: Uint8Array): KeyObject => {
  try {
    return createPrivateKey({ key: Buffer.from(der), format: "der", type: "pkcs8" });
  } catch (error) {
    throw new CryptoError("INVALID_KEY", "개인키를 읽을 수 없습니다", { cause: error });
  }
};

export const publicKeyOf = (privateKey: KeyObject): Buffer =>
  rawPublicKey(createPublicKey(privateKey));

export const generateX25519KeyPair = (): RawKeyPair => {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return { publicKey: rawPublicKey(publicKey), privateKey };
};

export const generateEd25519KeyPair = (): RawKeyPair => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey: rawPublicKey(publicKey), privateKey };
};

// ── AES-KW (RFC 3394) ────────────────────────────────────────

/** AES-256-KW 래핑. KMS 마스터키 래핑과 라이선스 KEK 래핑에 공통 사용 */
export const aesKwWrap = (kek: Uint8Array, keyData: Uint8Array): Buffer => {
  if (kek.length !== AES_KW_KEY_LENGTH) {
    throw new CryptoError("INVALID_KEY", "KEK 길이가 올바르지 않습니다");
  }
  if (keyData.length < 16 || keyData.length % 8 !== 0) {
    throw new CryptoError("INVALID_ARGUMENT", "래핑할 키 길이가 올바르지 않습니다");
  }
  const cipher = createCipheriv(AES_KW, kek, AES_KW_IV);
  return Buffer.concat([cipher.update(keyData), cipher.final()]);
};

/** AES-256-KW 언래핑. 무결성 검사 실패 시 UNWRAP_FAILED */
export const aesKwUnwrap = (kek: Uint8Array, wrapped: Uint8Array): Buffer => {
  if (kek.length !== AES_KW_KEY_LENGTH) {
    throw new CryptoError("INVALID_KEY", "KEK 길이가 올바르지 않습니다");
  }
  if (wrapped.length < 24 || wrapped.length % 8 !== 0) {
    throw new CryptoError("UNWRAP_FAILED", "래핑된 키 길이가 올바르지 않습니다");
  }
  try {
    const decipher = createDecipheriv(AES_KW, kek, AES_KW_IV);
    return Buffer.concat([decipher.update(wrapped), decipher.final()]);
  } catch (error) {
    throw new CryptoError("UNWRAP_FAILED", "키 언래핑에 실패했습니다 (키 불일치 또는 변조)", {
      cause: error,
    });
  }
};

// ── 라이선스 CEK 래핑 (X25519-HKDF-SHA256-A256KW) ────────────

export interface LicenseKeyBinding {
  licenseId: string;
  docId: string;
}

export interface WrappedCek {
  ephemeralPublicKey: Buffer;
  wrappedKey: Buffer;
}

const x25519Shared = (privateKey: KeyObject, peerPublicRaw: Uint8Array): Buffer => {
  const publicKey = importX25519PublicKey(peerPublicRaw);
  let shared: Buffer;
  try {
    shared = diffieHellman({ privateKey, publicKey });
  } catch (error) {
    // OpenSSL은 저차수 점(low-order point)을 자체적으로 거부합니다.
    throw new CryptoError("INVALID_PUBLIC_KEY", "유효하지 않은 X25519 공개키입니다", {
      cause: error,
    });
  }
  // OpenSSL 버전과 무관하게 공유 비밀이 0인 경우를 한 번 더 차단합니다.
  if (shared.every((b) => b === 0)) {
    throw new CryptoError("INVALID_PUBLIC_KEY", "유효하지 않은 X25519 공개키입니다");
  }
  return shared;
};

const deriveLicenseKek = (
  shared: Buffer,
  ephemeralPublicKey: Uint8Array,
  devicePublicKey: Uint8Array,
  binding: LicenseKeyBinding,
): Buffer => {
  const salt = Buffer.concat([ephemeralPublicKey, devicePublicKey]);
  const info = Buffer.concat([
    Buffer.from(LICENSE_KEK_INFO, "ascii"),
    Buffer.from([0]),
    Buffer.from(binding.licenseId, "ascii"),
    Buffer.from([0]),
    Buffer.from(binding.docId, "ascii"),
  ]);
  return Buffer.from(hkdfSync("sha256", shared, salt, info, AES_KW_KEY_LENGTH));
};

/** 서버: CEK를 기기 공개키로 래핑합니다. 라이선스마다 임시 키쌍을 새로 만듭니다. */
export const wrapCekForDevice = (
  cek: Uint8Array,
  devicePublicKey: Uint8Array,
  binding: LicenseKeyBinding,
): WrappedCek => {
  if (cek.length !== CEK_LENGTH) {
    throw new CryptoError("INVALID_KEY", "CEK 길이가 올바르지 않습니다");
  }
  const ephemeral = generateX25519KeyPair();
  const shared = x25519Shared(ephemeral.privateKey, devicePublicKey);
  const kek = deriveLicenseKek(shared, ephemeral.publicKey, devicePublicKey, binding);
  try {
    return { ephemeralPublicKey: ephemeral.publicKey, wrappedKey: aesKwWrap(kek, cek) };
  } finally {
    wipe(shared, kek);
  }
};

/** 뷰어: 라이선스의 래핑된 CEK를 기기 개인키로 풉니다. */
export const unwrapCekOnDevice = (
  devicePrivateKey: KeyObject,
  wrapped: WrappedCek,
  binding: LicenseKeyBinding,
): Buffer => {
  const devicePublicKey = publicKeyOf(devicePrivateKey);
  const shared = x25519Shared(devicePrivateKey, wrapped.ephemeralPublicKey);
  const kek = deriveLicenseKek(shared, wrapped.ephemeralPublicKey, devicePublicKey, binding);
  try {
    const cek = aesKwUnwrap(kek, wrapped.wrappedKey);
    if (cek.length !== CEK_LENGTH) {
      wipe(cek);
      throw new CryptoError("UNWRAP_FAILED", "CEK 길이가 올바르지 않습니다");
    }
    return cek;
  } finally {
    wipe(shared, kek);
  }
};
