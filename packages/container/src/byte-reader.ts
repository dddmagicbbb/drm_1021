import { ContainerError } from "./errors.js";

/**
 * 비동기 바이트 스트림에서 정확한 길이만큼 읽는 버퍼링 리더
 * 청크 경계가 입력 조각 경계와 달라도 동작합니다.
 */
export class ByteReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private pending: Buffer[] = [];
  private pendingLength = 0;
  private done = false;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  /** 지정 길이를 읽습니다. 스트림이 먼저 끝나면 TRUNCATED */
  async readExact(length: number): Promise<Buffer> {
    while (this.pendingLength < length) {
      if (!(await this.pull())) {
        throw new ContainerError("TRUNCATED", "파일이 예상보다 짧습니다");
      }
    }
    const joined = this.pending.length === 1 ? this.pending[0]! : Buffer.concat(this.pending);
    const out = joined.subarray(0, length);
    const rest = joined.subarray(length);
    this.pending = rest.length > 0 ? [rest] : [];
    this.pendingLength = rest.length;
    return out;
  }

  /** 남은 데이터가 없는지 확인합니다. (빈 조각은 무시) */
  async isAtEnd(): Promise<boolean> {
    while (this.pendingLength === 0) {
      if (!(await this.pull())) return true;
    }
    return false;
  }

  private async pull(): Promise<boolean> {
    if (this.done) return false;
    const { value, done } = await this.iterator.next();
    if (done) {
      this.done = true;
      return false;
    }
    if (value.length > 0) {
      const buf = Buffer.isBuffer(value)
        ? value
        : Buffer.from(value.buffer, value.byteOffset, value.length);
      this.pending.push(buf);
      this.pendingLength += buf.length;
    }
    return true;
  }
}

/** Uint8Array를 일정 크기 조각의 비동기 스트림으로 변환 (테스트·메모리 입력용) */
export async function* bufferSource(
  data: Uint8Array,
  pieceSize = 64 * 1024,
): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < data.length; offset += pieceSize) {
    yield data.subarray(offset, offset + pieceSize);
  }
}
