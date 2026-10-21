/**
 * 라이선스 검증과 CEK 언래핑 (뷰어)
 * 스펙: docs/specs/license-api.md §7 뷰어 검증 순서
 */
import { LicensePayloadSchema, type LicensePayload, type SignedLicense } from "@drm/contracts";
import { SIGNING_CONTEXT, unwrapCekOnDevice, verifyWithContext } from "@drm/crypto";
import type { KeyObject } from "node:crypto";

export class LicenseVerificationError extends Error {
  override readonly name = "LicenseVerificationError";
}

/** kid → Ed25519 공개키 (빌드 시 내장, 개발 모드는 서버에서 조회) */
export type TrustedKeys = ReadonlyMap<string, Uint8Array>;

export interface VerifiedLicense {
  payload: LicensePayload;
  /** 언래핑된 CEK. 사용 후 반드시 0으로 덮어씁니다. */
  cek: Buffer;
}

export const verifyLicense = (
  signed: SignedLicense,
  trustedKeys: TrustedKeys,
  expected: { docId: string; deviceId: string; devicePrivateKey: KeyObject },
): VerifiedLicense => {
  // 1. kid가 신뢰 목록에 있는지
  const publicKey = trustedKeys.get(signed.kid);
  if (!publicKey) throw new LicenseVerificationError("신뢰할 수 없는 서명 키입니다.");

  // 2. 서명 검증 (도메인 분리 문자열 포함)
  const payloadBytes = Buffer.from(signed.payload, "base64url");
  const signature = Buffer.from(signed.signature, "base64url");
  if (!verifyWithContext(publicKey, SIGNING_CONTEXT.license, payloadBytes, signature)) {
    throw new LicenseVerificationError("라이선스 서명이 올바르지 않습니다.");
  }

  // 3. 본문 스키마 검증
  let json: unknown;
  try {
    json = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    throw new LicenseVerificationError("라이선스 형식이 올바르지 않습니다.");
  }
  const parsed = LicensePayloadSchema.safeParse(json);
  if (!parsed.success) throw new LicenseVerificationError("라이선스 형식이 올바르지 않습니다.");
  const payload = parsed.data;

  // 4. 대상 기기·문서 일치
  if (payload.deviceId !== expected.deviceId) {
    throw new LicenseVerificationError("다른 기기에 발급된 라이선스입니다.");
  }
  if (payload.docId !== expected.docId) {
    throw new LicenseVerificationError("다른 문서의 라이선스입니다.");
  }

  // 5. CEK 언래핑 (licenseId·docId 바인딩)
  try {
    const cek = unwrapCekOnDevice(
      expected.devicePrivateKey,
      {
        ephemeralPublicKey: Buffer.from(payload.key.ephemeralPublicKey, "base64url"),
        wrappedKey: Buffer.from(payload.key.wrappedKey, "base64url"),
      },
      { licenseId: payload.licenseId, docId: payload.docId },
    );
    return { payload, cek };
  } catch {
    throw new LicenseVerificationError("문서 키를 풀 수 없습니다.");
  }
};

/**
 * 재발급까지 남은 시간 (ms)
 * 로컬 시계와 서버 시계가 달라도 동작하도록 서버가 준 유효 기간(expiresAt - issuedAt)을 기준으로,
 * 수신 시점부터 계산합니다. 만료 1분 전에 재발급합니다. (§7-6)
 */
export const renewalDelayMs = (payload: LicensePayload, marginMs = 60_000): number => {
  const ttl = Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt);
  return Math.max(ttl - marginMs, 5_000);
};
