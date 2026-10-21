import {
  KEY_WRAP_ALG,
  LicensePayloadSchema,
  type LicensePayload,
  type SignedLicense,
} from "@drm/contracts";
import { bufferSource, localContainerSigner, writeContainer } from "@drm/container";
import {
  SIGNING_CONTEXT,
  generateCek,
  generateEd25519KeyPair,
  generateX25519KeyPair,
  signWithContext,
  wrapCekForDevice,
} from "@drm/crypto";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DocumentSession } from "./document-session.js";
import { LicenseVerificationError, renewalDelayMs, verifyLicense } from "./license.js";
import { ServerApiError } from "./server-api.js";

const KID = "srv-test";
const server = generateEd25519KeyPair();
const trusted = new Map([[KID, server.publicKey]]);
const device = generateX25519KeyPair();
const DEVICE_ID = randomUUID();
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(200_000)]);

/** 서버가 하는 일을 흉내: 패키징 + 라이선스 발급 */
const packageDocument = async (plaintext = PDF) => {
  const docId = randomUUID();
  const cek = generateCek();
  const parts: Buffer[] = [];
  for await (const p of writeContainer(bufferSource(plaintext), {
    docId,
    contentType: "application/pdf",
    plaintextSize: plaintext.length,
    cek,
    signer: localContainerSigner(KID, server.privateKey),
  })) {
    parts.push(p);
  }
  return { docId, cek, drm: Buffer.concat(parts) };
};

const issueLicense = (
  docId: string,
  cek: Buffer,
  overrides: Partial<LicensePayload> = {},
  signingKey = server.privateKey,
): SignedLicense => {
  const licenseId = randomUUID();
  const wrapped = wrapCekForDevice(cek, device.publicKey, { licenseId, docId });
  const issuedAt = new Date();
  const payload = LicensePayloadSchema.parse({
    v: 1,
    licenseId,
    docId,
    recipientId: randomUUID(),
    deviceId: DEVICE_ID,
    contentType: "application/pdf",
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 600_000).toISOString(),
    permissions: { view: true },
    watermark: { text: "kim@customer.co.kr · 2026-10-21 09:00 · abcd1234" },
    key: {
      alg: KEY_WRAP_ALG,
      ephemeralPublicKey: wrapped.ephemeralPublicKey.toString("base64url"),
      wrappedKey: wrapped.wrappedKey.toString("base64url"),
    },
    ...overrides,
  });
  const bytes = Buffer.from(JSON.stringify(payload));
  return {
    payload: bytes.toString("base64url"),
    signature: signWithContext(signingKey, SIGNING_CONTEXT.license, bytes).toString("base64url"),
    kid: KID,
  };
};

const expected = (docId: string) => ({
  docId,
  deviceId: DEVICE_ID,
  devicePrivateKey: device.privateKey,
});

describe("라이선스 검증 (T1-22)", () => {
  it("서명·대상을 확인하고 CEK를 복원한다", async () => {
    const { docId, cek } = await packageDocument();
    const { payload, cek: restored } = verifyLicense(
      issueLicense(docId, cek),
      trusted,
      expected(docId),
    );
    expect(restored.equals(cek)).toBe(true);
    expect(payload.docId).toBe(docId);
    expect(renewalDelayMs(payload)).toBe(540_000);
  });

  it("신뢰하지 않는 키·위조 서명·변조된 본문을 거부한다", async () => {
    const { docId, cek } = await packageDocument();
    const attacker = generateEd25519KeyPair();
    expect(() =>
      verifyLicense(issueLicense(docId, cek, {}, attacker.privateKey), trusted, expected(docId)),
    ).toThrow(LicenseVerificationError);
    expect(() =>
      verifyLicense({ ...issueLicense(docId, cek), kid: "unknown" }, trusted, expected(docId)),
    ).toThrow(/신뢰할 수 없는/);

    const signed = issueLicense(docId, cek);
    const tampered = JSON.parse(Buffer.from(signed.payload, "base64url").toString());
    tampered.watermark.text = "다른 사람";
    expect(() =>
      verifyLicense(
        { ...signed, payload: Buffer.from(JSON.stringify(tampered)).toString("base64url") },
        trusted,
        expected(docId),
      ),
    ).toThrow(/서명/);
  });

  it("다른 기기·다른 문서의 라이선스를 거부한다", async () => {
    const { docId, cek } = await packageDocument();
    expect(() =>
      verifyLicense(issueLicense(docId, cek, { deviceId: randomUUID() }), trusted, expected(docId)),
    ).toThrow(/다른 기기/);
    expect(() => verifyLicense(issueLicense(docId, cek), trusted, expected(randomUUID()))).toThrow(
      /다른 문서/,
    );
    // 다른 기기 개인키로는 CEK를 풀 수 없음
    expect(() =>
      verifyLicense(issueLicense(docId, cek), trusted, {
        ...expected(docId),
        devicePrivateKey: generateX25519KeyPair().privateKey,
      }),
    ).toThrow(/문서 키를 풀 수 없습니다/);
  });
});

describe("열람 세션 (T1-22)", () => {
  const sessionWith = (
    requestLicense: (docId: string, deviceId: string) => Promise<SignedLicense>,
  ) => {
    const timers: { fn: () => void; ms: number }[] = [];
    const closed: { docId: string; code: string }[] = [];
    const session = new DocumentSession({
      api: { requestLicense: vi.fn(requestLicense) },
      trustedKeys: async () => trusted,
      device: async () => ({ deviceId: DEVICE_ID, privateKey: device.privateKey }),
      onClosed: (docId, error) => closed.push({ docId, code: error.code }),
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimer: () => undefined,
    });
    return { session, timers, closed };
  };

  it(".drm을 메모리에서 복호화해 원문을 돌려준다", async () => {
    const { docId, cek, drm } = await packageDocument();
    const { session, timers } = sessionWith(async (id) => issueLicense(id, cek));
    const opened = await session.open(drm, "도면.pdf.drm");
    expect(Buffer.from(opened.data).equals(PDF)).toBe(true);
    expect(opened).toMatchObject({ docId, fileName: "도면.pdf", contentType: "application/pdf" });
    expect(opened.watermark).toContain("kim@customer.co.kr");
    expect(timers[0]?.ms).toBe(540_000);
  });

  it("닫으면 main 프로세스의 평문을 0으로 지운다", async () => {
    const { cek, drm } = await packageDocument();
    const { session } = sessionWith(async (id) => issueLicense(id, cek));
    const opened = await session.open(drm, "a.drm");
    const view = opened.data;
    session.close();
    expect(view.every((b) => b === 0)).toBe(true);
    expect(session.openDocId).toBeNull();
  });

  it("재발급이 거부(회수)되면 문서를 닫고 사유를 알린다", async () => {
    const { docId, cek, drm } = await packageDocument();
    let revoked = false;
    const { session, timers, closed } = sessionWith(async (id) => {
      if (revoked)
        throw new ServerApiError(403, "DOCUMENT_REVOKED", "발신자가 이 문서를 회수했습니다.");
      return issueLicense(id, cek);
    });
    const opened = await session.open(drm, "a.drm");
    revoked = true;
    timers[0]!.fn();
    await vi.waitFor(() => expect(closed).toEqual([{ docId, code: "DOCUMENT_REVOKED" }]));
    expect(opened.data.every((b) => b === 0)).toBe(true);
  });

  it("재발급이 성공하면 다음 재발급을 예약하고 계속 열어 둔다", async () => {
    const { cek, drm } = await packageDocument();
    const { session, timers, closed } = sessionWith(async (id) => issueLicense(id, cek));
    await session.open(drm, "a.drm");
    timers[0]!.fn();
    await vi.waitFor(() => expect(timers).toHaveLength(2));
    expect(closed).toEqual([]);
    expect(session.openDocId).not.toBeNull();
  });

  it("라이선스가 거부되면 열지 않는다", async () => {
    const { drm } = await packageDocument();
    const { session } = sessionWith(async () => {
      throw new ServerApiError(403, "EXPIRED", "열람 기간이 만료되었습니다.");
    });
    await expect(session.open(drm, "a.drm")).rejects.toMatchObject({ code: "EXPIRED" });
    expect(session.openDocId).toBeNull();
  });

  it("다른 서버 키로 서명된(위조) .drm은 라이선스 요청 전에 거부한다", async () => {
    const forged = generateEd25519KeyPair();
    const cek = generateCek();
    const parts: Buffer[] = [];
    for await (const p of writeContainer(bufferSource(PDF), {
      docId: randomUUID(),
      contentType: "application/pdf",
      plaintextSize: PDF.length,
      cek,
      signer: localContainerSigner(KID, forged.privateKey),
    })) {
      parts.push(p);
    }
    const requestLicense = vi.fn();
    const { session } = sessionWith(requestLicense);
    await expect(session.open(Buffer.concat(parts), "a.drm")).rejects.toMatchObject({
      code: "INVALID_SIGNATURE",
    });
    expect(requestLicense).not.toHaveBeenCalled();
  });
});
