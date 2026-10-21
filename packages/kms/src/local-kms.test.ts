import { generateCek } from "@drm/crypto";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KmsError } from "./kms.js";
import {
  LocalKmsProvider,
  createLocalKmsProvider,
  generateLocalKeyring,
  rotateLocalKeyring,
} from "./local-kms.js";

const expectCode = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(KmsError);
  expect((error as KmsError).code).toBe(code);
};

describe("LocalKmsProvider", () => {
  it("CEK를 래핑·언래핑한다", async () => {
    const kms = new LocalKmsProvider(generateLocalKeyring("k1"));
    const cek = generateCek();
    const ctx = { docId: randomUUID() };
    const wrapped = await kms.wrapKey(cek, ctx);
    expect(wrapped.keyId).toBe("k1");
    expect(wrapped.ciphertext.includes(cek)).toBe(false);
    expect((await kms.unwrapKey(wrapped, ctx)).equals(cek)).toBe(true);
  });

  it("다른 문서 문맥으로는 언래핑할 수 없다 (CEK 바꿔치기 방지)", async () => {
    const kms = new LocalKmsProvider(generateLocalKeyring());
    const wrapped = await kms.wrapKey(generateCek(), { docId: randomUUID() });
    await expectCode(kms.unwrapKey(wrapped, { docId: randomUUID() }), "UNWRAP_FAILED");
  });

  it("변조된 래핑 키를 거부한다", async () => {
    const kms = new LocalKmsProvider(generateLocalKeyring());
    const ctx = { docId: randomUUID() };
    const wrapped = await kms.wrapKey(generateCek(), ctx);
    wrapped.ciphertext[20]! ^= 0x01;
    await expectCode(kms.unwrapKey(wrapped, ctx), "UNWRAP_FAILED");
    await expectCode(
      kms.unwrapKey({ keyId: wrapped.keyId, ciphertext: Buffer.alloc(10) }, ctx),
      "UNWRAP_FAILED",
    );
  });

  it("같은 CEK도 매번 다른 암호문으로 래핑한다", async () => {
    const kms = new LocalKmsProvider(generateLocalKeyring());
    const cek = generateCek();
    const ctx = { docId: randomUUID() };
    const a = await kms.wrapKey(cek, ctx);
    const b = await kms.wrapKey(cek, ctx);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("키 교체 후 새 키로 래핑하고 기존 문서도 언래핑한다 (NFR-O3)", async () => {
    const v1 = generateLocalKeyring("k1");
    const oldKms = new LocalKmsProvider(v1);
    const ctx = { docId: randomUUID() };
    const cek = generateCek();
    const oldWrapped = await oldKms.wrapKey(cek, ctx);

    const newKms = new LocalKmsProvider(rotateLocalKeyring(v1, "k2"));
    expect((await newKms.wrapKey(generateCek(), ctx)).keyId).toBe("k2");
    expect((await newKms.unwrapKey(oldWrapped, ctx)).equals(cek)).toBe(true);
  });

  it("키링에 없는 keyId면 KEY_NOT_FOUND", async () => {
    const kms = new LocalKmsProvider(generateLocalKeyring("k1"));
    await expectCode(
      kms.unwrapKey({ keyId: "unknown", ciphertext: Buffer.alloc(60) }, { docId: randomUUID() }),
      "KEY_NOT_FOUND",
    );
  });

  it("잘못된 키링을 거부한다", () => {
    expect(() => new LocalKmsProvider({ activeKeyId: "x", keys: {} })).toThrow(KmsError);
    expect(
      () =>
        new LocalKmsProvider({
          activeKeyId: "x",
          keys: { x: Buffer.alloc(16).toString("base64url") },
        }),
    ).toThrow(KmsError);
  });
});

describe("createLocalKmsProvider", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "drm-kms-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("운영 환경에서는 기동을 거부한다", async () => {
    const keyringPath = join(dir, "keyring.json");
    await writeFile(keyringPath, JSON.stringify(generateLocalKeyring()));
    await expectCode(
      createLocalKmsProvider({ keyringPath, nodeEnv: "production" }),
      "FORBIDDEN_IN_PRODUCTION",
    );
  });

  it("파일이 없으면 생성하고, 다시 열면 같은 키를 사용한다", async () => {
    const keyringPath = join(dir, "keyring.json");
    const first = await createLocalKmsProvider({
      keyringPath,
      nodeEnv: "development",
      createIfMissing: true,
    });
    const ctx = { docId: randomUUID() };
    const cek = generateCek();
    const wrapped = await first.wrapKey(cek, ctx);
    const second = await createLocalKmsProvider({ keyringPath, nodeEnv: "development" });
    expect((await second.unwrapKey(wrapped, ctx)).equals(cek)).toBe(true);
    expect(JSON.parse(await readFile(keyringPath, "utf8")).activeKeyId).toBe(wrapped.keyId);
  });

  it("파일이 없고 createIfMissing이 아니면 INVALID_KEYRING", async () => {
    await expectCode(
      createLocalKmsProvider({ keyringPath: join(dir, "none.json"), nodeEnv: "test" }),
      "INVALID_KEYRING",
    );
  });
});
