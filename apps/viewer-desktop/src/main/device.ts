/**
 * 기기 키 (X25519)
 * 개인키는 PC 밖으로 나가지 않으며 SecretStore(DPAPI)에만 저장합니다.
 * 수신자 계정마다 별도 키를 씁니다. (한 PC를 여러 수신자가 쓰는 경우 서버의 키 중복 거부 회피)
 */
import {
  exportPrivateKeyDer,
  generateX25519KeyPair,
  importPrivateKeyDer,
  publicKeyOf,
} from "@drm/crypto";
import type { KeyObject } from "node:crypto";
import { hostname } from "node:os";
import type { SecretStore } from "./secret-store.js";
import type { ServerApi } from "./server-api.js";

export interface DeviceIdentity {
  privateKey: KeyObject;
  publicKey: Buffer;
  deviceId: string;
}

const keyName = (email: string) => `device-key:${email}`;
const idName = (email: string) => `device-id:${email}`;

/** 기기 키를 불러오거나 만들고, 서버에 등록해 deviceId를 확보합니다. */
export const ensureDevice = async (
  email: string,
  secrets: SecretStore,
  api: Pick<ServerApi, "registerDevice">,
): Promise<DeviceIdentity> => {
  let privateKey: KeyObject;
  const saved = await secrets.load(keyName(email));
  if (saved) {
    privateKey = importPrivateKeyDer(saved);
    saved.fill(0);
  } else {
    privateKey = generateX25519KeyPair().privateKey;
    const der = exportPrivateKeyDer(privateKey);
    await secrets.save(keyName(email), der);
    der.fill(0);
  }
  const publicKey = publicKeyOf(privateKey);

  // 같은 공개키 재등록은 서버가 기존 deviceId를 돌려줍니다(멱등).
  const deviceId = await api.registerDevice(publicKey, hostname().slice(0, 100) || "PC", "WINDOWS");
  await secrets.save(idName(email), Buffer.from(deviceId));
  return { privateKey, publicKey, deviceId };
};
