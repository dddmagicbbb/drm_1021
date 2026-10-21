// 서버 서명 키링에서 "공개키만" 뽑아 trusted-keys.json을 만듭니다. (설치 패키지에 내장)
// 사용: node scripts/export-trusted-keys.mjs [키링 경로]
//   또는 node scripts/export-trusted-keys.mjs --from-server https://drm.example.com
// 개인키는 절대 출력하지 않습니다.
import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const [arg, value] = process.argv.slice(2);
let keys;
if (arg === "--from-server") {
  const res = await fetch(`${value}/api/v1/keys/signing`);
  if (!res.ok) throw new Error(`서버 응답 오류: ${res.status}`);
  keys = (await res.json()).keys;
} else {
  const path = arg ?? "../../.local/signing-keyring.json";
  const keyring = JSON.parse(await readFile(path, "utf8"));
  keys = Object.entries(keyring.keys).map(([kid, der]) => {
    const privateKey = createPrivateKey({
      key: Buffer.from(der, "base64url"),
      format: "der",
      type: "pkcs8",
    });
    return { kid, publicKey: createPublicKey(privateKey).export({ format: "jwk" }).x };
  });
}
await writeFile("trusted-keys.json", `${JSON.stringify({ keys }, null, 2)}\n`);
console.log(`trusted-keys.json: ${keys.map((k) => k.kid).join(", ")}`);
