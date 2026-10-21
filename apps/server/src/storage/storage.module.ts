import { Global, Module } from "@nestjs/common";
import { LocalFileStorage, type ObjectStorage } from "@drm/storage";
import { ENV, type Env } from "../config/env.js";

export const STORAGE = Symbol("STORAGE");

@Global()
@Module({
  providers: [
    {
      provide: STORAGE,
      inject: [ENV],
      useFactory: (env: Env): ObjectStorage => new LocalFileStorage(env.STORAGE_DIR),
    },
  ],
  exports: [STORAGE],
})
export class StorageModule {}
