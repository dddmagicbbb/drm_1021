import { FuseV1Options } from "@electron/fuses";
import { describe, expect, it } from "vitest";
// @ts-expect-error JS 모듈 (electron-builder afterPack 훅)
import { FUSE_CONFIG } from "./fuses.mjs";

describe("Electron 퓨즈 (T1-20)", () => {
  it("RunAsNode·NODE_OPTIONS·--inspect를 끄고 asar 무결성을 켠다", () => {
    expect(FUSE_CONFIG[FuseV1Options.RunAsNode]).toBe(false);
    expect(FUSE_CONFIG[FuseV1Options.EnableNodeOptionsEnvironmentVariable]).toBe(false);
    expect(FUSE_CONFIG[FuseV1Options.EnableNodeCliInspectArguments]).toBe(false);
    expect(FUSE_CONFIG[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]).toBe(true);
    expect(FUSE_CONFIG[FuseV1Options.OnlyLoadAppFromAsar]).toBe(true);
  });
});
