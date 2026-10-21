// Electron 퓨즈 설정 (electron-builder afterPack 훅)
// 패키징된 실행 파일의 런타임 기능을 바이너리 수준에서 끕니다.
import { FuseV1Options, FuseVersion, flipFuses } from "@electron/fuses";
import { join } from "node:path";

/** 퓨즈 값. 테스트에서 검증합니다. */
export const FUSE_CONFIG = {
  version: FuseVersion.V1,
  // ELECTRON_RUN_AS_NODE로 일반 Node처럼 실행해 앱 코드를 우회하는 것을 차단
  [FuseV1Options.RunAsNode]: false,
  // NODE_OPTIONS 환경 변수로 코드 주입 차단
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  // --inspect 등 디버거 연결 인자 차단
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  // app.asar 변조 탐지
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  // asar 밖의 앱 코드 로드 차단
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
};

export default async function afterPack(context) {
  const exe = join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  await flipFuses(exe, FUSE_CONFIG);
}
