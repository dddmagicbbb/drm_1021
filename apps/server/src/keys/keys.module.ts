import { Controller, Get, Global, Inject, Module } from "@nestjs/common";
import {
  type KmsProvider,
  type SigningKeyProvider,
  type SigningPublicKey,
  createLocalKmsProvider,
  createLocalSigningKeyProvider,
} from "@drm/kms";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { ENV, type Env } from "../config/env.js";

export const KMS = Symbol("KMS");
export const SIGNING_KEYS = Symbol("SIGNING_KEYS");

/**
 * 서명 공개키 목록 (인증 불필요)
 * 운영 뷰어는 빌드 시 공개키를 내장하며, 이 API는 개발·키 교체 확인용입니다.
 */
@Controller("keys")
export class KeysController {
  constructor(@Inject(SIGNING_KEYS) private readonly signing: SigningKeyProvider) {}

  @Get("signing")
  signingKeys(): { activeKid: string; keys: SigningPublicKey[] } {
    return { activeKid: this.signing.activeKid, keys: this.signing.publicKeys() };
  }
}

const ensureDir = (path: string) => mkdir(dirname(path), { recursive: true });

/**
 * 키 관리 (1단계: 로컬 파일 키링)
 * 운영 환경(NODE_ENV=production)에서는 로컬 키링 생성 자체가 거부되므로,
 * 운영 KMS 구현(T2-10) 전에는 운영 모드로 기동할 수 없습니다.
 */
@Global()
@Module({
  controllers: [KeysController],
  providers: [
    {
      provide: KMS,
      inject: [ENV],
      useFactory: async (env: Env): Promise<KmsProvider> => {
        await ensureDir(env.KMS_KEYRING_PATH);
        return createLocalKmsProvider({
          keyringPath: env.KMS_KEYRING_PATH,
          nodeEnv: env.NODE_ENV,
          createIfMissing: true,
        });
      },
    },
    {
      provide: SIGNING_KEYS,
      inject: [ENV],
      useFactory: async (env: Env): Promise<SigningKeyProvider> => {
        await ensureDir(env.SIGNING_KEYRING_PATH);
        return createLocalSigningKeyProvider({
          keyringPath: env.SIGNING_KEYRING_PATH,
          nodeEnv: env.NODE_ENV,
          createIfMissing: true,
        });
      },
    },
  ],
  exports: [KMS, SIGNING_KEYS],
})
export class KeysModule {}
