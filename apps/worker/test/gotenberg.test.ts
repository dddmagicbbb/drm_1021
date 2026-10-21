import { makeTestPdf } from "@drm/contracts/testing";
import { randomBytes } from "node:crypto";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PermanentPackagingError } from "../src/converter.js";
import { CONVERSION_FAILED_MESSAGE, GotenbergOfficeConverter } from "../src/gotenberg.js";

type Mode = "ok" | "bad-request" | "server-error" | "unavailable" | "flaky" | "not-pdf" | "slow";

const CONVERTED = Buffer.from(makeTestPdf({ pages: 2, payload: randomBytes(20_000) }));
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), randomBytes(5000)]);

const collect = async (stream: Readable) => {
  const parts: Buffer[] = [];
  for await (const p of stream) parts.push(p as Buffer);
  return Buffer.concat(parts);
};

/** Gotenberg API를 흉내 내는 스텁 서버 */
describe("GotenbergOfficeConverter (T1-15)", () => {
  let server: Server;
  let baseUrl: string;
  let mode: Mode = "ok";
  let requests = 0;
  let lastRequest: { path: string; contentType: string; body: Buffer } | null = null;
  let tempRoot: string;

  const converter = (timeoutMs = 5000) =>
    new GotenbergOfficeConverter({ baseUrl, timeoutMs, tempRoot });

  const prepare = (format: "DOCX" | "XLSX" | "PPTX" = "DOCX", content = DOCX) =>
    converter(mode === "slow" ? 200 : 5000).prepare({
      docId: "d",
      fileName: "비밀 사양서.docx",
      format,
      size: content.length,
      source: async () => Readable.from([content]),
    });

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "drm-gotenberg-test-"));
    server = createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on("data", (c: Buffer) => parts.push(c));
      req.on("end", () => {
        lastRequest = {
          path: req.url ?? "",
          contentType: req.headers["content-type"] ?? "",
          body: Buffer.concat(parts),
        };
        if (mode === "bad-request") return res.writeHead(400).end("LibreOffice failed");
        requests += 1;
        if (mode === "server-error") return res.writeHead(500).end("uno exception");
        if (mode === "unavailable") return res.writeHead(503).end();
        if (mode === "flaky" && requests === 1) return res.writeHead(500).end("uno exception");
        if (mode === "not-pdf") return res.writeHead(200).end("<html>");
        if (mode === "slow") return setTimeout(() => res.writeHead(200).end(CONVERTED), 1000);
        res.writeHead(200, { "Content-Type": "application/pdf" }).end(CONVERTED);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(() => {
    mode = "ok";
    requests = 0;
    lastRequest = null;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("Office 문서를 PDF로 변환하고 정확한 크기를 알려준다", async () => {
    const prepared = await prepare();
    expect(prepared.contentType).toBe("application/pdf");
    expect(prepared.size).toBe(CONVERTED.length);
    expect((await collect(await prepared.stream())).equals(CONVERTED)).toBe(true);

    expect(lastRequest?.path).toBe("/forms/libreoffice/convert");
    expect(lastRequest?.contentType).toContain("multipart/form-data");
    expect(lastRequest?.body.includes(DOCX)).toBe(true);
    // 원래 파일명은 변환 서버로 보내지 않음
    expect(lastRequest?.body.toString("utf8")).not.toContain("비밀 사양서");
    expect(lastRequest?.body.toString("utf8")).toContain('filename="source.docx"');

    await prepared.cleanup();
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it("DOCX·XLSX·PPTX만 지원한다", () => {
    const c = converter();
    expect(["DOCX", "XLSX", "PPTX"].every((f) => c.supports(f as never))).toBe(true);
    expect(c.supports("PDF")).toBe(false);
  });

  it("변환 서버가 4xx면 영구 오류 (재시도하지 않음)", async () => {
    mode = "bad-request";
    const error = await prepare().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PermanentPackagingError);
    expect((error as PermanentPackagingError).userMessage).toBe(CONVERSION_FAILED_MESSAGE);
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it("결과가 PDF가 아니면 영구 오류", async () => {
    mode = "not-pdf";
    await expect(prepare()).rejects.toBeInstanceOf(PermanentPackagingError);
  });

  it("500이 반복되면 변환할 수 없는 문서(영구 오류), 한 번만 500이면 재시도로 성공", async () => {
    mode = "server-error";
    const error = await prepare().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PermanentPackagingError);
    expect(requests).toBe(2);

    mode = "flaky";
    requests = 0;
    const prepared = await prepare();
    expect(prepared.size).toBe(CONVERTED.length);
    await prepared.cleanup();
  });

  it("503·시간 초과·연결 실패는 일시적 오류 (재시도 대상)", async () => {
    for (const m of ["unavailable", "slow"] as const) {
      mode = m;
      const error = await prepare().catch((e: unknown) => e);
      expect(error, m).toBeInstanceOf(Error);
      expect(error, m).not.toBeInstanceOf(PermanentPackagingError);
    }
    const offline = new GotenbergOfficeConverter({
      baseUrl: "http://127.0.0.1:1",
      timeoutMs: 1000,
      tempRoot,
    });
    const error = await offline
      .prepare({
        docId: "d",
        fileName: "a.docx",
        format: "DOCX",
        size: DOCX.length,
        source: async () => Readable.from([DOCX]),
      })
      .catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(PermanentPackagingError);
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it("빈 파일은 영구 오류", async () => {
    await expect(prepare("DOCX", Buffer.alloc(0))).rejects.toBeInstanceOf(PermanentPackagingError);
  });
});
