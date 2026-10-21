/**
 * Ed25519 서명 (도메인 분리)
 * 서명 대상 = ASCII(context) ‖ 0x00 ‖ message
 * 컨테이너 헤더 서명과 라이선스 서명이 서로 대체되지 않도록 문맥 문자열을 분리합니다.
 */
import { sign, verify, type KeyObject } from "node:crypto";
import { CryptoError } from "./errors.js";
import { importEd25519PublicKey } from "./keys.js";

export const SIGNATURE_LENGTH = 64;

export const SIGNING_CONTEXT = {
  containerHeader: "drm-1021:container-header:v1",
  license: "drm-1021:license:v1",
} as const;
export type SigningContext = (typeof SIGNING_CONTEXT)[keyof typeof SIGNING_CONTEXT];

const signingInput = (context: SigningContext, message: Uint8Array): Buffer =>
  Buffer.concat([Buffer.from(context, "ascii"), Buffer.from([0]), message]);

export const signWithContext = (
  privateKey: KeyObject,
  context: SigningContext,
  message: Uint8Array,
): Buffer => {
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new CryptoError("INVALID_KEY", "Ed25519 개인키가 아닙니다");
  }
  return sign(null, signingInput(context, message), privateKey);
};

/** 서명 검증. 형식 오류를 포함한 모든 실패는 false를 반환합니다. */
export const verifyWithContext = (
  publicKey: KeyObject | Uint8Array,
  context: SigningContext,
  message: Uint8Array,
  signature: Uint8Array,
): boolean => {
  if (signature.length !== SIGNATURE_LENGTH) return false;
  let key: KeyObject;
  try {
    key = publicKey instanceof Uint8Array ? importEd25519PublicKey(publicKey) : publicKey;
  } catch {
    // 공개키 형식 오류는 검증 실패로 처리합니다.
    return false;
  }
  if (key.asymmetricKeyType !== "ed25519") return false;
  return verify(null, signingInput(context, message), key, signature);
};
