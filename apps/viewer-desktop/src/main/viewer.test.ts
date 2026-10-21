import { generateX25519KeyPair, publicKeyOf, importPrivateKeyDer } from "@drm/crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ViewerController, asResult } from "./controller.js";
import { ensureDevice } from "./device.js";
import { findDrmPath } from "./file-args.js";
import { EncryptedFileStore, type Encryptor, type SecretStore } from "./secret-store.js";
import { ServerApi } from "./server-api.js";

/** DPAPI 대신 쓰는 테스트 암호화기 (뒤집기 + 표식) */
const fakeEncryptor: Encryptor = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`ENC:${[...plain].reverse().join("")}`),
  decryptString: (buf) => {
    const s = buf.toString();
    if (!s.startsWith("ENC:")) throw new Error("복호화 실패");
    return [...s.slice(4)].reverse().join("");
  },
};

class MemoryStore implements SecretStore {
  readonly items = new Map<string, Buffer>();
  async load(name: string) {
    return this.items.get(name) ? Buffer.from(this.items.get(name)!) : null;
  }
  async save(name: string, value: Uint8Array) {
    this.items.set(name, Buffer.from(value));
  }
  async delete(name: string) {
    this.items.delete(name);
  }
}

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("EncryptedFileStore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "drm-viewer-store-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("값을 암호화해 저장하고, 파일에는 평문이 없다", async () => {
    const store = new EncryptedFileStore(dir, fakeEncryptor);
    const secret = Buffer.from("refresh-token-plain-value");
    await store.save("recipient-refresh-token", secret);
    expect((await store.load("recipient-refresh-token"))?.equals(secret)).toBe(true);

    const [file] = await readdir(dir);
    expect(file).not.toContain("refresh");
    const raw = await readFile(join(dir, file!));
    expect(raw.includes(secret)).toBe(false);
    expect(raw.includes(Buffer.from(secret.toString("base64")))).toBe(false);

    await store.delete("recipient-refresh-token");
    expect(await store.load("recipient-refresh-token")).toBeNull();
  });

  it("다른 계정에서 복사된(복호화 불가) 파일은 없는 것으로 취급한다", async () => {
    await new EncryptedFileStore(dir, fakeEncryptor).save("k", Buffer.from("v"));
    const otherUser: Encryptor = {
      ...fakeEncryptor,
      decryptString: () => {
        throw new Error("DPAPI");
      },
    };
    expect(await new EncryptedFileStore(dir, otherUser).load("k")).toBeNull();
  });

  it("OS 보호 저장소를 쓸 수 없으면 저장을 거부한다", async () => {
    const unavailable = { ...fakeEncryptor, isEncryptionAvailable: () => false };
    await expect(
      new EncryptedFileStore(dir, unavailable).save("k", Buffer.from("v")),
    ).rejects.toThrow(/DPAPI/);
  });
});

describe("기기 키 (T1-21)", () => {
  it("처음에는 키를 만들어 저장·등록하고, 다음에는 같은 키를 쓴다", async () => {
    const store = new MemoryStore();
    const registered: Buffer[] = [];
    const api = {
      registerDevice: vi.fn(async (pub: Buffer) => {
        registered.push(pub);
        return "11111111-2222-4333-8444-555555555555";
      }),
    };
    const first = await ensureDevice("kim@customer.co.kr", store, api);
    const second = await ensureDevice("kim@customer.co.kr", store, api);
    expect(first.publicKey.equals(second.publicKey)).toBe(true);
    expect(registered[0]!.equals(registered[1]!)).toBe(true);
    expect(first.deviceId).toBe("11111111-2222-4333-8444-555555555555");

    const savedDer = await store.load("device-key:kim@customer.co.kr");
    expect(publicKeyOf(importPrivateKeyDer(savedDer!)).equals(first.publicKey)).toBe(true);

    // 다른 수신자 계정은 다른 키
    const other = await ensureDevice("lee@customer.co.kr", store, api);
    expect(other.publicKey.equals(first.publicKey)).toBe(false);
  });
});

describe("로그인 흐름 (T1-21)", () => {
  const DEVICE_ID = "11111111-2222-4333-8444-555555555555";
  const tokens = { accessToken: "a1", refreshToken: "r1", expiresIn: 900 };

  it("OTP 요청 → 검증 → 기기 등록, 재시작 후 저장된 로그인으로 복구", async () => {
    const store = new MemoryStore();
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url).replace("http://srv/api/v1", "");
      calls.push(`${init?.method} ${path}`);
      if (path === "/recipient-auth/otp/request") return json(202);
      if (path === "/recipient-auth/otp/verify") return json(200, tokens);
      if (path === "/devices") {
        const auth = (init?.headers as Record<string, string>).Authorization;
        return auth === "Bearer a1" ? json(201, { deviceId: DEVICE_ID }) : json(401);
      }
      return json(404);
    });
    const api = new ServerApi("http://srv", store, fetchMock as never);
    const controller = new ViewerController(api, store);

    expect(await controller.authStatus()).toEqual({ loggedIn: false, email: null });
    await controller.requestOtp(" Kim@Customer.co.kr ");
    expect(await controller.verifyOtp("kim@customer.co.kr", " 123456 ")).toEqual({
      loggedIn: true,
      email: "kim@customer.co.kr",
    });
    expect(calls).toEqual([
      "POST /recipient-auth/otp/request",
      "POST /recipient-auth/otp/verify",
      "POST /devices",
    ]);

    // 앱 재시작: 새 컨트롤러가 저장된 refresh 토큰·이메일로 복구
    const restarted = new ViewerController(
      new ServerApi("http://srv", store, fetchMock as never),
      store,
    );
    expect(await restarted.authStatus()).toEqual({ loggedIn: true, email: "kim@customer.co.kr" });

    await restarted.logout();
    expect(await new ViewerController(api, store).authStatus()).toEqual({
      loggedIn: false,
      email: null,
    });
  });

  it("잘못된 입력·서버 오류를 렌더러용 오류로 바꾼다", async () => {
    const store = new MemoryStore();
    const fetchMock = vi.fn(async () =>
      json(400, {
        error: {
          code: "OTP_INVALID",
          message: "인증 코드가 올바르지 않습니다.",
          correlationId: null,
        },
      }),
    );
    const controller = new ViewerController(
      new ServerApi("http://srv", store, fetchMock as never),
      store,
    );

    expect(await asResult(() => controller.requestOtp("not-email"))).toEqual({
      ok: false,
      error: { code: "VALIDATION_FAILED", message: "이메일 주소를 확인하세요." },
    });
    expect(await asResult(() => controller.verifyOtp("a@b.co", "12"))).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED" },
    });
    expect(await asResult(() => controller.verifyOtp("a@b.co", "123456"))).toEqual({
      ok: false,
      error: { code: "OTP_INVALID", message: "인증 코드가 올바르지 않습니다." },
    });
    // 내부 예외는 상세를 숨김
    expect(
      await asResult(async () => {
        throw new Error("secret detail");
      }),
    ).toEqual({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "처리 중 오류가 발생했습니다." },
    });
  });

  it("서버에 연결할 수 없으면 NETWORK_ERROR", async () => {
    const store = new MemoryStore();
    const controller = new ViewerController(
      new ServerApi("http://srv", store, (async () => {
        throw new TypeError("ECONNREFUSED");
      }) as never),
      store,
    );
    expect(await asResult(() => controller.requestOtp("a@b.co"))).toMatchObject({
      ok: false,
      error: { code: "NETWORK_ERROR" },
    });
  });
});

describe("파일 연결 실행 인자 (T1-21)", () => {
  it(".drm 경로를 찾는다", () => {
    const exists = (p: string) => p.endsWith("도면.pdf.drm");
    expect(findDrmPath(["viewer.exe", "--flag", "C:\\Docs\\도면.pdf.drm"], exists)).toMatch(
      /도면\.pdf\.drm$/,
    );
    expect(findDrmPath(["viewer.exe", "C:\\Docs\\a.pdf"], exists)).toBeNull();
    expect(findDrmPath(["viewer.exe", "C:\\missing.drm"], () => false)).toBeNull();
    expect(findDrmPath(["viewer.exe"], exists)).toBeNull();
  });

  it("생성된 기기 키는 유효한 X25519 키다", () => {
    expect(generateX25519KeyPair().publicKey).toHaveLength(32);
  });
});
