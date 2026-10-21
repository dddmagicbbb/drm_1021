/**
 * 테스트용 PDF 생성 (서버·워커·뷰어 테스트 공용)
 * 운영 코드에서는 사용하지 않습니다.
 */

const encoder = new TextEncoder();

export interface TestPdfOptions {
  pages?: number;
  /** 본문에 넣을 임의 바이트 (크기·평문 추적 표식 검증용, 참조되지 않는 스트림 객체로 포함) */
  payload?: Uint8Array;
  /** 표준 보안 핸들러 /Encrypt를 넣어 암호가 걸린 PDF로 만듭니다. */
  encrypted?: boolean;
}

/** xref 오프셋까지 올바른 최소 PDF */
export const makeTestPdf = (options: TestPdfOptions = {}): Uint8Array => {
  const pages = options.pages ?? 1;
  const objects: Uint8Array[] = [];
  const add = (body: string | Uint8Array[]) => {
    objects.push(
      typeof body === "string"
        ? encoder.encode(body)
        : body.reduce((acc, part) => {
            const merged = new Uint8Array(acc.length + part.length);
            merged.set(acc);
            merged.set(part, acc.length);
            return merged;
          }, new Uint8Array()),
    );
    return objects.length;
  };

  const kids = Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(" ");
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  for (let i = 0; i < pages; i += 1) {
    add("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>");
  }
  if (options.payload) {
    add([
      encoder.encode(`<< /Length ${options.payload.length} >>\nstream\n`),
      options.payload,
      encoder.encode("\nendstream"),
    ]);
  }
  let encryptRef = "";
  if (options.encrypted) {
    const hex32 = "00".repeat(32);
    const id = add(`<< /Filter /Standard /V 1 /R 2 /O <${hex32}> /U <${hex32}> /P -4 >>`);
    encryptRef = ` /Encrypt ${id} 0 R /ID [<0123456789ABCDEF0123456789ABCDEF> <0123456789ABCDEF0123456789ABCDEF>]`;
  }

  const parts: Uint8Array[] = [encoder.encode("%PDF-1.7\n")];
  const offsets: number[] = [];
  let length = parts[0]!.length;
  objects.forEach((body, i) => {
    offsets.push(length);
    const head = encoder.encode(`${i + 1} 0 obj\n`);
    const tail = encoder.encode("\nendobj\n");
    parts.push(head, body, tail);
    length += head.length + body.length + tail.length;
  });
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encryptRef} >>\nstartxref\n${length}\n%%EOF\n`;
  parts.push(encoder.encode(xref));

  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
};
