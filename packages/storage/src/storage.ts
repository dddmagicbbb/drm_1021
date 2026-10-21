import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * 파일 저장소 추상화
 * 1단계는 로컬 디스크, 운영에서는 S3 호환 저장소 등으로 교체합니다.
 */
export interface ObjectStorage {
  /** 스트림을 저장합니다. 중간에 실패하면 파일이 남지 않습니다. */
  put(key: string, body: AsyncIterable<Uint8Array> | Readable): Promise<{ size: number }>;
  /** 없으면 StorageNotFoundError */
  get(key: string): Promise<Readable>;
  /** 없으면 null */
  stat(key: string): Promise<{ size: number } | null>;
  /** 없어도 오류 없음 (멱등) */
  delete(key: string): Promise<void>;
}

export class StorageNotFoundError extends Error {
  override readonly name = "StorageNotFoundError";
  constructor(readonly key: string) {
    super(`저장소에 없는 키입니다: ${key}`);
  }
}

/** 저장 키 규칙: 업로드 원본과 패키지 위치 */
export const storageKeys = {
  upload: (docId: string) => `uploads/${docId}`,
  package: (docId: string) => `packages/${docId}.drm`,
} as const;

/** 경로 탐색을 막기 위해 키는 영숫자·하이픈·밑줄·점·슬래시만 허용합니다. */
const VALID_KEY = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*(\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/;

export class LocalFileStorage implements ObjectStorage {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  async put(key: string, body: AsyncIterable<Uint8Array> | Readable): Promise<{ size: number }> {
    const target = this.pathOf(key);
    await mkdir(dirname(target), { recursive: true });
    // 임시 파일에 쓴 뒤 이름을 바꿔, 실패하거나 읽는 도중에 불완전한 파일이 보이지 않게 합니다.
    const temp = `${target}.${randomUUID()}.partial`;
    let size = 0;
    try {
      await pipeline(
        body instanceof Readable ? body : Readable.from(body),
        async function* (source: AsyncIterable<Uint8Array>) {
          for await (const chunk of source) {
            size += chunk.length;
            yield chunk;
          }
        },
        createWriteStream(temp, { flags: "wx", mode: 0o600 }),
      );
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    return { size };
  }

  async get(key: string): Promise<Readable> {
    const path = this.pathOf(key);
    if (!(await this.stat(key))) throw new StorageNotFoundError(key);
    return createReadStream(path);
  }

  async stat(key: string): Promise<{ size: number } | null> {
    try {
      const info = await stat(this.pathOf(key));
      return info.isFile() ? { size: info.size } : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }

  private pathOf(key: string): string {
    if (!VALID_KEY.test(key) || key.split("/").some((part) => part === "." || part === "..")) {
      throw new Error(`허용되지 않는 저장소 키입니다: ${key}`);
    }
    const full = resolve(join(this.root, key));
    if (!full.startsWith(this.root + sep)) {
      throw new Error(`저장소 루트를 벗어난 키입니다: ${key}`);
    }
    return full;
  }
}
