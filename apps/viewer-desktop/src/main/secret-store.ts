import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 기기 개인키·refresh 토큰 보관소
 * 운영 구현은 Electron safeStorage(Windows DPAPI)로 암호화해 사용자 프로필에 저장합니다.
 */
export interface SecretStore {
  load(name: string): Promise<Buffer | null>;
  save(name: string, value: Uint8Array): Promise<void>;
  delete(name: string): Promise<void>;
}

/** safeStorage와 같은 형태의 암호화기 (테스트에서 대체) */
export interface Encryptor {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** 이름을 파일명으로 쓸 수 있게 해시 */
const fileNameOf = (name: string) => `${createHash("sha256").update(name).digest("hex")}.bin`;

export class EncryptedFileStore implements SecretStore {
  constructor(
    private readonly dir: string,
    private readonly encryptor: Encryptor,
  ) {}

  async load(name: string): Promise<Buffer | null> {
    let encrypted: Buffer;
    try {
      encrypted = await readFile(join(this.dir, fileNameOf(name)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      return Buffer.from(this.encryptor.decryptString(encrypted), "base64");
    } catch {
      // 다른 사용자 계정·PC에서 복사된 파일은 복호화되지 않습니다. 없는 것으로 취급합니다.
      return null;
    }
  }

  async save(name: string, value: Uint8Array): Promise<void> {
    if (!this.encryptor.isEncryptionAvailable()) {
      throw new Error("OS 보호 저장소(DPAPI)를 사용할 수 없습니다.");
    }
    await mkdir(this.dir, { recursive: true });
    await writeFile(
      join(this.dir, fileNameOf(name)),
      this.encryptor.encryptString(Buffer.from(value).toString("base64")),
      { mode: 0o600 },
    );
  }

  async delete(name: string): Promise<void> {
    await rm(join(this.dir, fileNameOf(name)), { force: true });
  }
}
