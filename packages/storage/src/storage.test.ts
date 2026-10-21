import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFileStorage, StorageNotFoundError, storageKeys } from "./storage.js";

const collect = async (stream: Readable) => {
  const parts: Buffer[] = [];
  for await (const p of stream) parts.push(p as Buffer);
  return Buffer.concat(parts);
};

describe("LocalFileStorage", () => {
  let dir: string;
  let storage: LocalFileStorage;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "drm-storage-"));
    storage = new LocalFileStorage(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("스트림을 저장하고 읽고 지운다", async () => {
    const data = randomBytes(300_000);
    const key = storageKeys.package("0b0f8c2e-1111-4222-8333-444455556666");
    const { size } = await storage.put(
      key,
      Readable.from([data.subarray(0, 1000), data.subarray(1000)]),
    );
    expect(size).toBe(data.length);
    expect(await storage.stat(key)).toEqual({ size: data.length });
    expect((await collect(await storage.get(key))).equals(data)).toBe(true);

    await storage.delete(key);
    await storage.delete(key);
    expect(await storage.stat(key)).toBeNull();
    await expect(storage.get(key)).rejects.toBeInstanceOf(StorageNotFoundError);
  });

  it("쓰기 도중 실패하면 파일을 남기지 않는다", async () => {
    async function* failing() {
      yield Buffer.from("partial");
      throw new Error("업로드 중단");
    }
    await expect(storage.put("uploads/x", failing())).rejects.toThrow("업로드 중단");
    expect(await storage.stat("uploads/x")).toBeNull();
    expect(await readdir(join(dir, "uploads"))).toEqual([]);
  });

  it("경로 탐색 키를 거부한다", async () => {
    for (const key of [
      "../escape",
      "uploads/../../x",
      "/abs",
      "a//b",
      "a\\b",
      "",
      "uploads/..",
      ".",
    ]) {
      await expect(storage.put(key, Readable.from([Buffer.from("x")])), key).rejects.toThrow();
    }
  });
});
