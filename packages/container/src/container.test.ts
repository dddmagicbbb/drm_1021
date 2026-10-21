import { generateCek, generateEd25519KeyPair } from "@drm/crypto";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bufferSource } from "./byte-reader.js";
import { ContainerError } from "./errors.js";
import { FIXED_PREFIX_LENGTH, containerSize } from "./layout.js";
import { decryptContainer, inspectContainer, openContainer } from "./reader.js";
import { localContainerSigner, writeContainer, type WriteContainerOptions } from "./writer.js";

const KID = "test-2026-10";
const signingKey = generateEd25519KeyPair();
const resolveKey = (kid: string) => (kid === KID ? signingKey.publicKey : undefined);
const signer = localContainerSigner(KID, signingKey.privateKey);
const CHUNK = 4096;

const collect = async (gen: AsyncIterable<Buffer>): Promise<Buffer> => {
  const parts: Buffer[] = [];
  for await (const p of gen) parts.push(p);
  return Buffer.concat(parts);
};

const pack = async (plaintext: Buffer, overrides: Partial<WriteContainerOptions> = {}) => {
  const cek = generateCek();
  const drm = await collect(
    writeContainer(bufferSource(plaintext, 1000), {
      docId: randomUUID(),
      contentType: "application/pdf",
      plaintextSize: plaintext.length,
      cek,
      signer,
      chunkSize: CHUNK,
      ...overrides,
    }),
  );
  return { cek, drm };
};

const expectCode = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `${code} 오류가 발생해야 합니다`).toBeInstanceOf(ContainerError);
  expect((error as ContainerError).code).toBe(code);
};

/** 헤더 길이 */
const headerLength = (drm: Buffer) => drm.readUInt32BE(6);

describe("왕복", () => {
  it.each([0, 1, CHUNK - 1, CHUNK, CHUNK + 1, CHUNK * 3, CHUNK * 3 + 17])(
    "평문 %i바이트를 복원한다",
    async (size) => {
      const plaintext = randomBytes(size);
      const { cek, drm } = await pack(plaintext);
      expect(drm.length).toBe(containerSize(headerLength(drm), size, CHUNK));
      const { header, plaintext: restored } = await decryptContainer(drm, cek, resolveKey);
      expect(restored.equals(plaintext)).toBe(true);
      expect(header.plaintextSize).toBe(size);
      expect(header.kid).toBe(KID);
    },
  );

  it("헤더만 먼저 검증·조회할 수 있다 (라이선스 요청 전)", async () => {
    const docId = randomUUID();
    const { drm } = await pack(randomBytes(100), { docId });
    const header = await inspectContainer(drm, resolveKey);
    expect(header.docId).toBe(docId);
    expect(header.contentType).toBe("application/pdf");
  });

  it("100MB를 스트리밍으로 암·복호화한다 (전체 메모리 적재 없음)", async () => {
    const size = 100 * 1024 * 1024;
    const piece = randomBytes(1024 * 1024);
    const inputHash = createHash("sha256");
    async function* source() {
      for (let i = 0; i < size / piece.length; i += 1) {
        piece.writeUInt32BE(i, 0);
        inputHash.update(piece);
        yield piece;
      }
    }
    const cek = generateCek();
    const drmStream = writeContainer(source(), {
      docId: randomUUID(),
      contentType: "application/pdf",
      plaintextSize: size,
      cek,
      signer,
    });
    const opened = await openContainer(drmStream, resolveKey);
    const outputHash = createHash("sha256");
    let total = 0;
    for await (const out of opened.decrypt(cek)) {
      outputHash.update(out);
      total += out.length;
    }
    expect(total).toBe(size);
    expect(outputHash.digest("hex")).toBe(inputHash.digest("hex"));
  }, 60_000);
});

describe("헤더·서명 검증", () => {
  it("매직 바이트가 다르면 INVALID_MAGIC", async () => {
    const { drm } = await pack(randomBytes(10));
    drm.write("XXXX", 0, "ascii");
    await expectCode(inspectContainer(drm, resolveKey), "INVALID_MAGIC");
  });

  it("지원하지 않는 버전이면 UNSUPPORTED_VERSION", async () => {
    const { drm } = await pack(randomBytes(10));
    drm.writeUInt16BE(2, 4);
    await expectCode(inspectContainer(drm, resolveKey), "UNSUPPORTED_VERSION");
  });

  it("헤더 길이가 비정상이면 INVALID_HEADER", async () => {
    const { drm } = await pack(randomBytes(10));
    drm.writeUInt32BE(0, 6);
    await expectCode(inspectContainer(drm, resolveKey), "INVALID_HEADER");
    drm.writeUInt32BE(1024 * 1024, 6);
    await expectCode(inspectContainer(drm, resolveKey), "INVALID_HEADER");
  });

  it("헤더 내용을 바꾸면 INVALID_SIGNATURE", async () => {
    const { drm } = await pack(randomBytes(10));
    const start = FIXED_PREFIX_LENGTH;
    const json = drm.subarray(start, start + headerLength(drm)).toString("utf8");
    // 같은 길이로 contentType만 바꿔 서명 우회를 시도
    const forged = json.replace("application/pdf", "application/pdX");
    expect(forged).not.toBe(json);
    drm.write(forged, start, "utf8");
    // 스키마 위반으로 먼저 걸리지 않도록 유효한 값으로 교체한 경우도 검사
    const { drm: drm2 } = await pack(randomBytes(10));
    const json2 = drm2.subarray(start, start + headerLength(drm2)).toString("utf8");
    const forged2 = json2.replace(/"plaintextSize":10/, '"plaintextSize":11');
    drm2.write(forged2, start, "utf8");
    await expectCode(inspectContainer(drm, resolveKey), "INVALID_HEADER");
    await expectCode(inspectContainer(drm2, resolveKey), "INVALID_SIGNATURE");
  });

  it("서명 바이트를 바꾸면 INVALID_SIGNATURE", async () => {
    const { drm } = await pack(randomBytes(10));
    const sigOffset = FIXED_PREFIX_LENGTH + headerLength(drm) + 2;
    drm[sigOffset + 10]! ^= 0x01;
    await expectCode(inspectContainer(drm, resolveKey), "INVALID_SIGNATURE");
  });

  it("다른 서버 키로 서명된 파일은 INVALID_SIGNATURE", async () => {
    const attacker = generateEd25519KeyPair();
    const { drm } = await pack(randomBytes(10), {
      signer: localContainerSigner(KID, attacker.privateKey),
    });
    await expectCode(inspectContainer(drm, resolveKey), "INVALID_SIGNATURE");
  });

  it("모르는 kid면 UNKNOWN_KEY_ID", async () => {
    const { drm } = await pack(randomBytes(10));
    await expectCode(
      inspectContainer(drm, () => undefined),
      "UNKNOWN_KEY_ID",
    );
  });
});

describe("본문 무결성", () => {
  it("다른 CEK로는 DECRYPTION_FAILED", async () => {
    const { drm } = await pack(randomBytes(CHUNK * 2));
    await expectCode(decryptContainer(drm, generateCek(), resolveKey), "DECRYPTION_FAILED");
  });

  it("본문 1바이트 변조는 DECRYPTION_FAILED", async () => {
    const { cek, drm } = await pack(randomBytes(CHUNK * 2));
    drm[drm.length - 100]! ^= 0x01;
    await expectCode(decryptContainer(drm, cek, resolveKey), "DECRYPTION_FAILED");
  });

  it("청크 두 개의 위치를 바꾸면 DECRYPTION_FAILED", async () => {
    const { cek, drm } = await pack(randomBytes(CHUNK * 3));
    const bodyStart = drm.length - 3 * (CHUNK + 16);
    const c0 = Buffer.from(drm.subarray(bodyStart, bodyStart + CHUNK + 16));
    const c1 = Buffer.from(drm.subarray(bodyStart + CHUNK + 16, bodyStart + 2 * (CHUNK + 16)));
    c1.copy(drm, bodyStart);
    c0.copy(drm, bodyStart + CHUNK + 16);
    await expectCode(decryptContainer(drm, cek, resolveKey), "DECRYPTION_FAILED");
  });

  it("파일 끝을 자르면 TRUNCATED (크기 확인 / 스트리밍 모두)", async () => {
    const { cek, drm } = await pack(randomBytes(CHUNK * 2));
    const cut = drm.subarray(0, drm.length - 1);
    await expectCode(decryptContainer(cut, cek, resolveKey), "TRUNCATED");
    const opened = await openContainer(bufferSource(cut), resolveKey);
    await expectCode(collect(opened.decrypt(cek)), "TRUNCATED");
  });

  it("마지막 청크 전체를 잘라도 탐지한다", async () => {
    const { cek, drm } = await pack(randomBytes(CHUNK * 3));
    const cut = drm.subarray(0, drm.length - (CHUNK + 16));
    const opened = await openContainer(bufferSource(cut), resolveKey);
    await expectCode(collect(opened.decrypt(cek)), "TRUNCATED");
  });

  it("꼬리 데이터를 붙이면 TRAILING_DATA (크기 확인 / 스트리밍 모두)", async () => {
    const { cek, drm } = await pack(randomBytes(100));
    const extended = Buffer.concat([drm, Buffer.from([0])]);
    await expectCode(decryptContainer(extended, cek, resolveKey), "TRAILING_DATA");
    const opened = await openContainer(bufferSource(extended), resolveKey);
    await expectCode(collect(opened.decrypt(cek)), "TRAILING_DATA");
  });

  it("다른 파일의 유효한 헤더로 바꿔치기하면 DECRYPTION_FAILED", async () => {
    const plaintext = randomBytes(500);
    const a = await pack(plaintext);
    const b = await pack(plaintext);
    const prefixLenA = FIXED_PREFIX_LENGTH + headerLength(a.drm) + 66;
    const prefixLenB = FIXED_PREFIX_LENGTH + headerLength(b.drm) + 66;
    // A의 헤더·서명 + B의 본문
    const spliced = Buffer.concat([a.drm.subarray(0, prefixLenA), b.drm.subarray(prefixLenB)]);
    await expectCode(decryptContainer(spliced, a.cek, resolveKey), "DECRYPTION_FAILED");
    await expectCode(decryptContainer(spliced, b.cek, resolveKey), "DECRYPTION_FAILED");
  });

  it("복호화 실패 시 부분 평문을 반환하지 않는다", async () => {
    const { cek, drm } = await pack(randomBytes(CHUNK * 3));
    drm[drm.length - 1]! ^= 0x01;
    const result = await decryptContainer(drm, cek, resolveKey).catch(() => null);
    expect(result).toBeNull();
  });
});

describe("작성기 입력 검증", () => {
  it("입력이 plaintextSize보다 작거나 크면 SIZE_MISMATCH", async () => {
    await expectCode(pack(randomBytes(10), { plaintextSize: 11 }), "SIZE_MISMATCH");
    await expectCode(pack(randomBytes(10), { plaintextSize: 9 }), "SIZE_MISMATCH");
  });

  it("같은 평문·같은 CEK라도 파일마다 noncePrefix가 달라 암호문이 다르다", async () => {
    const plaintext = randomBytes(100);
    const cek = generateCek();
    const opts = {
      docId: randomUUID(),
      contentType: "application/pdf" as const,
      plaintextSize: 100,
      cek,
      signer,
    };
    const a = await collect(writeContainer(bufferSource(plaintext), opts));
    const b = await collect(writeContainer(bufferSource(plaintext), opts));
    expect(a.subarray(-116).equals(b.subarray(-116))).toBe(false);
  });
});
