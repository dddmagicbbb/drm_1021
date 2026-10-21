import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  NONCE_LENGTH,
  StreamOpener,
  StreamSealer,
  TAG_LENGTH,
  chunkNonce,
  generateCek,
  generateNoncePrefix,
  openChunk,
  sealChunk,
} from "./aead.js";
import { CryptoError } from "./errors.js";

const aad = randomBytes(32);

/** 평문을 고정 크기 청크로 암호화 */
const sealAll = (cek: Buffer, prefix: Buffer, chunks: Buffer[]) => {
  const sealer = new StreamSealer(cek, prefix, aad);
  return chunks.map((c, i) => sealer.seal(c, i === chunks.length - 1));
};

/** 각 청크를 순서대로 복호화. isLast는 위치로 판정 */
const openAll = (cek: Buffer, prefix: Buffer, sealed: Buffer[]) => {
  const opener = new StreamOpener(cek, prefix, aad);
  const out = sealed.map((c, i) => opener.open(c, i === sealed.length - 1));
  return { out, finished: opener.isFinished };
};

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

describe("chunkNonce", () => {
  it("접두사 ‖ uint32BE(인덱스) ‖ 마지막 플래그로 구성된다", () => {
    const prefix = Buffer.from("01020304050607", "hex");
    expect(chunkNonce(prefix, 0x0a0b0c0d, true).toString("hex")).toBe("010203040506070a0b0c0d01");
    expect(chunkNonce(prefix, 0, false)).toHaveLength(NONCE_LENGTH);
  });

  it("마지막 플래그가 다르면 논스가 다르다", () => {
    const prefix = generateNoncePrefix();
    expect(chunkNonce(prefix, 3, true).equals(chunkNonce(prefix, 3, false))).toBe(false);
  });

  it("잘못된 인덱스·접두사를 거부한다", () => {
    expectCode(() => chunkNonce(generateNoncePrefix(), -1, false), "INVALID_ARGUMENT");
    expectCode(() => chunkNonce(generateNoncePrefix(), 0xffff_ffff, false), "INVALID_ARGUMENT");
    expectCode(() => chunkNonce(randomBytes(8), 0, false), "INVALID_ARGUMENT");
  });
});

describe("청크 암·복호화", () => {
  it("왕복 시 원문을 복원한다 (빈 청크 포함)", () => {
    const cek = generateCek();
    const prefix = generateNoncePrefix();
    const chunks = [randomBytes(4096), randomBytes(4096), randomBytes(17)];
    const sealed = sealAll(cek, prefix, chunks);
    expect(sealed[0]).toHaveLength(4096 + TAG_LENGTH);
    const { out, finished } = openAll(cek, prefix, sealed);
    expect(Buffer.concat(out).equals(Buffer.concat(chunks))).toBe(true);
    expect(finished).toBe(true);

    const empty = sealAll(cek, generateNoncePrefix(), [Buffer.alloc(0)]);
    expect(empty[0]).toHaveLength(TAG_LENGTH);
  });

  it("청크 순서를 바꾸면 복호화에 실패한다", () => {
    const cek = generateCek();
    const prefix = generateNoncePrefix();
    const sealed = sealAll(cek, prefix, [randomBytes(64), randomBytes(64), randomBytes(64)]);
    const swapped = [sealed[1]!, sealed[0]!, sealed[2]!];
    expectCode(() => openAll(cek, prefix, swapped), "DECRYPTION_FAILED");
  });

  it("청크를 복제하면 복호화에 실패한다", () => {
    const cek = generateCek();
    const prefix = generateNoncePrefix();
    const sealed = sealAll(cek, prefix, [randomBytes(64), randomBytes(64), randomBytes(64)]);
    expectCode(
      () => openAll(cek, prefix, [sealed[0]!, sealed[0]!, sealed[2]!]),
      "DECRYPTION_FAILED",
    );
  });

  it("마지막 청크를 잘라내면 복호화에 실패한다 (절단 탐지)", () => {
    const cek = generateCek();
    const prefix = generateNoncePrefix();
    const sealed = sealAll(cek, prefix, [randomBytes(64), randomBytes(64), randomBytes(64)]);
    // 두 번째 청크를 마지막으로 취급하면 lastFlag 불일치로 실패
    expectCode(() => openAll(cek, prefix, sealed.slice(0, 2)), "DECRYPTION_FAILED");
  });

  it("마지막 청크 플래그 없이 끝나면 isFinished가 false다", () => {
    const cek = generateCek();
    const prefix = generateNoncePrefix();
    const sealed = sealAll(cek, prefix, [randomBytes(64), randomBytes(64)]);
    const opener = new StreamOpener(cek, prefix, aad);
    opener.open(sealed[0]!, false);
    expect(opener.isFinished).toBe(false);
  });

  it("암호문·태그 1비트 변조를 탐지한다", () => {
    const cek = generateCek();
    const prefix = generateNoncePrefix();
    const [sealed] = sealAll(cek, prefix, [randomBytes(128)]);
    for (const pos of [0, 64, sealed!.length - 1]) {
      const tampered = Buffer.from(sealed!);
      tampered[pos]! ^= 0x01;
      expectCode(() => openChunk(cek, prefix, 0, true, tampered, aad), "DECRYPTION_FAILED");
    }
  });

  it("AAD(헤더)가 다르면 복호화에 실패한다", () => {
    const cek = generateCek();
    const prefix = generateNoncePrefix();
    const sealed = sealChunk(cek, prefix, 0, true, randomBytes(32), aad);
    expectCode(() => openChunk(cek, prefix, 0, true, sealed, randomBytes(32)), "DECRYPTION_FAILED");
  });

  it("다른 키·다른 접두사로는 복호화할 수 없다", () => {
    const cek = generateCek();
    const prefix = generateNoncePrefix();
    const sealed = sealChunk(cek, prefix, 0, true, randomBytes(32), aad);
    expectCode(() => openChunk(generateCek(), prefix, 0, true, sealed, aad), "DECRYPTION_FAILED");
    expectCode(
      () => openChunk(cek, generateNoncePrefix(), 0, true, sealed, aad),
      "DECRYPTION_FAILED",
    );
  });

  it("태그보다 짧은 입력을 거부한다", () => {
    expectCode(
      () => openChunk(generateCek(), generateNoncePrefix(), 0, true, randomBytes(15), aad),
      "DECRYPTION_FAILED",
    );
  });

  it("잘못된 길이의 CEK를 거부한다", () => {
    expectCode(() => new StreamSealer(randomBytes(16), generateNoncePrefix(), aad), "INVALID_KEY");
  });
});

describe("StreamSealer / StreamOpener 상태", () => {
  it("마지막 청크 이후 추가 암호화를 거부한다 (논스 재사용 방지)", () => {
    const sealer = new StreamSealer(generateCek(), generateNoncePrefix(), aad);
    sealer.seal(randomBytes(8), true);
    expect(sealer.isFinished).toBe(true);
    expectCode(() => sealer.seal(randomBytes(8), true), "INVALID_STATE");
  });

  it("마지막 청크 이후 데이터를 거부한다 (꼬리 데이터 탐지)", () => {
    const cek = generateCek();
    const prefix = generateNoncePrefix();
    const sealed = sealAll(cek, prefix, [randomBytes(8)]);
    const opener = new StreamOpener(cek, prefix, aad);
    opener.open(sealed[0]!, true);
    expectCode(() => opener.open(sealed[0]!, true), "INVALID_STATE");
  });

  it("같은 평문이라도 파일(CEK·접두사)이 다르면 암호문이 다르다", () => {
    const plain = Buffer.alloc(64, 7);
    const a = sealChunk(generateCek(), generateNoncePrefix(), 0, true, plain, aad);
    const b = sealChunk(generateCek(), generateNoncePrefix(), 0, true, plain, aad);
    expect(a.equals(b)).toBe(false);
  });
});
