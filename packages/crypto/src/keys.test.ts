import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CEK_LENGTH, generateCek } from "./aead.js";
import { CryptoError } from "./errors.js";
import {
  WRAPPED_CEK_LENGTH,
  aesKwUnwrap,
  aesKwWrap,
  exportPrivateKeyDer,
  generateEd25519KeyPair,
  generateX25519KeyPair,
  importPrivateKeyDer,
  publicKeyOf,
  unwrapCekOnDevice,
  wrapCekForDevice,
} from "./keys.js";
import { SIGNING_CONTEXT, signWithContext, verifyWithContext } from "./sign.js";

const expectCode = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CryptoError);
    expect((error as CryptoError).code).toBe(code);
    return;
  }
  throw new Error("예외가 발생하지 않았습니다");
};

const binding = () => ({ licenseId: randomUUID(), docId: randomUUID() });

describe("AES-KW", () => {
  it("RFC 3394 테스트 벡터 (4.6: 256비트 KEK, 256비트 키)", () => {
    const kek = Buffer.from(
      "000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F",
      "hex",
    );
    const keyData = Buffer.from(
      "00112233445566778899AABBCCDDEEFF000102030405060708090A0B0C0D0E0F",
      "hex",
    );
    const expected =
      "28c9f404c4b810f4cbccb35cfb87f8263f5786e2d80ed326cbc7f0e71a99f43bfb988b9b7a02dd21";
    expect(aesKwWrap(kek, keyData).toString("hex")).toBe(expected);
    expect(aesKwUnwrap(kek, Buffer.from(expected, "hex")).equals(keyData)).toBe(true);
  });

  it("다른 KEK·변조된 입력으로 언래핑하면 실패한다", () => {
    const kek = randomBytes(32);
    const wrapped = aesKwWrap(kek, generateCek());
    expect(wrapped).toHaveLength(WRAPPED_CEK_LENGTH);
    expectCode(() => aesKwUnwrap(randomBytes(32), wrapped), "UNWRAP_FAILED");
    const tampered = Buffer.from(wrapped);
    tampered[10]! ^= 0x80;
    expectCode(() => aesKwUnwrap(kek, tampered), "UNWRAP_FAILED");
    expectCode(() => aesKwUnwrap(kek, wrapped.subarray(0, 20)), "UNWRAP_FAILED");
  });
});

describe("라이선스 CEK 래핑", () => {
  it("기기 개인키로 왕복 복원한다", () => {
    const device = generateX25519KeyPair();
    const cek = generateCek();
    const b = binding();
    const wrapped = wrapCekForDevice(cek, device.publicKey, b);
    expect(wrapped.ephemeralPublicKey).toHaveLength(32);
    expect(wrapped.wrappedKey).toHaveLength(WRAPPED_CEK_LENGTH);
    const restored = unwrapCekOnDevice(device.privateKey, wrapped, b);
    expect(restored).toHaveLength(CEK_LENGTH);
    expect(restored.equals(cek)).toBe(true);
  });

  it("라이선스마다 임시 키가 달라 래핑 결과가 매번 다르다", () => {
    const device = generateX25519KeyPair();
    const cek = generateCek();
    const b = binding();
    const w1 = wrapCekForDevice(cek, device.publicKey, b);
    const w2 = wrapCekForDevice(cek, device.publicKey, b);
    expect(w1.ephemeralPublicKey.equals(w2.ephemeralPublicKey)).toBe(false);
    expect(w1.wrappedKey.equals(w2.wrappedKey)).toBe(false);
  });

  it("다른 기기는 언래핑할 수 없다", () => {
    const device = generateX25519KeyPair();
    const other = generateX25519KeyPair();
    const b = binding();
    const wrapped = wrapCekForDevice(generateCek(), device.publicKey, b);
    expectCode(() => unwrapCekOnDevice(other.privateKey, wrapped, b), "UNWRAP_FAILED");
  });

  it("licenseId·docId가 다르면 언래핑할 수 없다 (라이선스 바인딩)", () => {
    const device = generateX25519KeyPair();
    const b = binding();
    const wrapped = wrapCekForDevice(generateCek(), device.publicKey, b);
    expectCode(
      () => unwrapCekOnDevice(device.privateKey, wrapped, { ...b, licenseId: randomUUID() }),
      "UNWRAP_FAILED",
    );
    expectCode(
      () => unwrapCekOnDevice(device.privateKey, wrapped, { ...b, docId: randomUUID() }),
      "UNWRAP_FAILED",
    );
  });

  it("임시 공개키를 바꾸면 언래핑할 수 없다", () => {
    const device = generateX25519KeyPair();
    const b = binding();
    const wrapped = wrapCekForDevice(generateCek(), device.publicKey, b);
    const swapped = { ...wrapped, ephemeralPublicKey: generateX25519KeyPair().publicKey };
    expectCode(() => unwrapCekOnDevice(device.privateKey, swapped, b), "UNWRAP_FAILED");
  });

  it("저차수 점(전부 0) 공개키를 거부한다", () => {
    expectCode(
      () => wrapCekForDevice(generateCek(), Buffer.alloc(32), binding()),
      "INVALID_PUBLIC_KEY",
    );
  });

  it("잘못된 길이의 공개키를 거부한다", () => {
    expectCode(
      () => wrapCekForDevice(generateCek(), randomBytes(31), binding()),
      "INVALID_PUBLIC_KEY",
    );
  });

  it("개인키 DER 내보내기·가져오기 후에도 동일하게 동작한다", () => {
    const device = generateX25519KeyPair();
    const restoredKey = importPrivateKeyDer(exportPrivateKeyDer(device.privateKey));
    expect(publicKeyOf(restoredKey).equals(device.publicKey)).toBe(true);
    const b = binding();
    const cek = generateCek();
    const wrapped = wrapCekForDevice(cek, device.publicKey, b);
    expect(unwrapCekOnDevice(restoredKey, wrapped, b).equals(cek)).toBe(true);
  });
});

describe("Ed25519 서명", () => {
  it("서명을 검증한다 (raw 공개키·KeyObject 모두)", () => {
    const signer = generateEd25519KeyPair();
    const msg = randomBytes(100);
    const sig = signWithContext(signer.privateKey, SIGNING_CONTEXT.license, msg);
    expect(sig).toHaveLength(64);
    expect(verifyWithContext(signer.publicKey, SIGNING_CONTEXT.license, msg, sig)).toBe(true);
  });

  it("메시지·서명 변조를 탐지한다", () => {
    const signer = generateEd25519KeyPair();
    const msg = randomBytes(100);
    const sig = signWithContext(signer.privateKey, SIGNING_CONTEXT.license, msg);
    const badMsg = Buffer.from(msg);
    badMsg[0]! ^= 1;
    const badSig = Buffer.from(sig);
    badSig[5]! ^= 1;
    expect(verifyWithContext(signer.publicKey, SIGNING_CONTEXT.license, badMsg, sig)).toBe(false);
    expect(verifyWithContext(signer.publicKey, SIGNING_CONTEXT.license, msg, badSig)).toBe(false);
  });

  it("다른 문맥의 서명은 통과하지 않는다 (도메인 분리)", () => {
    const signer = generateEd25519KeyPair();
    const msg = randomBytes(100);
    const sig = signWithContext(signer.privateKey, SIGNING_CONTEXT.license, msg);
    expect(verifyWithContext(signer.publicKey, SIGNING_CONTEXT.containerHeader, msg, sig)).toBe(
      false,
    );
  });

  it("다른 키·잘못된 형식은 false를 반환한다", () => {
    const signer = generateEd25519KeyPair();
    const msg = randomBytes(10);
    const sig = signWithContext(signer.privateKey, SIGNING_CONTEXT.license, msg);
    const other = generateEd25519KeyPair();
    expect(verifyWithContext(other.publicKey, SIGNING_CONTEXT.license, msg, sig)).toBe(false);
    expect(verifyWithContext(randomBytes(31), SIGNING_CONTEXT.license, msg, sig)).toBe(false);
    expect(verifyWithContext(signer.publicKey, SIGNING_CONTEXT.license, msg, sig.subarray(1))).toBe(
      false,
    );
  });

  it("Ed25519가 아닌 키로 서명하면 거부한다", () => {
    expectCode(
      () =>
        signWithContext(
          generateX25519KeyPair().privateKey,
          SIGNING_CONTEXT.license,
          randomBytes(1),
        ),
      "INVALID_KEY",
    );
  });
});
