import { SIGNING_CONTEXT, verifyWithContext } from "@drm/crypto";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KmsError } from "./kms.js";
import {
  LocalSigningKeyProvider,
  createLocalSigningKeyProvider,
  generateLocalSigningKeyring,
} from "./signing.js";

describe("LocalSigningKeyProvider", () => {
  it("활성 키로 서명하고 공개키 목록으로 검증할 수 있다", async () => {
    const signer = new LocalSigningKeyProvider(generateLocalSigningKeyring("k1"));
    const msg = randomBytes(64);
    const sig = await signer.sign(SIGNING_CONTEXT.license, msg);
    const [pub] = signer.publicKeys();
    expect(pub?.kid).toBe("k1");
    expect(
      verifyWithContext(
        Buffer.from(pub!.publicKey, "base64url"),
        SIGNING_CONTEXT.license,
        msg,
        sig,
      ),
    ).toBe(true);
  });

  it("키 교체 후에도 이전 공개키를 계속 제공한다", () => {
    const old = generateLocalSigningKeyring("k1");
    const next = generateLocalSigningKeyring("k2");
    const signer = new LocalSigningKeyProvider({
      activeKid: "k2",
      keys: { ...old.keys, ...next.keys },
    });
    expect(signer.activeKid).toBe("k2");
    expect(
      signer
        .publicKeys()
        .map((k) => k.kid)
        .sort(),
    ).toEqual(["k1", "k2"]);
  });

  it("잘못된 키링을 거부한다", () => {
    expect(() => new LocalSigningKeyProvider({ activeKid: "x", keys: {} })).toThrow(KmsError);
    expect(
      () => new LocalSigningKeyProvider({ activeKid: "x", keys: { x: "bm90LWEta2V5" } }),
    ).toThrow(KmsError);
  });
});

describe("createLocalSigningKeyProvider", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "drm-sign-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("운영 환경에서는 거부한다", async () => {
    await expect(
      createLocalSigningKeyProvider({ keyringPath: join(dir, "k.json"), nodeEnv: "production" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_IN_PRODUCTION" });
  });

  it("없으면 생성하고, 동시에 생성해도 같은 키를 쓴다", async () => {
    const keyringPath = join(dir, "k.json");
    const [a, b] = await Promise.all([
      createLocalSigningKeyProvider({ keyringPath, nodeEnv: "test", createIfMissing: true }),
      createLocalSigningKeyProvider({ keyringPath, nodeEnv: "test", createIfMissing: true }),
    ]);
    expect(a.publicKeys()).toEqual(b.publicKeys());
  });
});
