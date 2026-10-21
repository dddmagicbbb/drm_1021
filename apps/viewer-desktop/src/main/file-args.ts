import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";

/**
 * 실행 인자에서 .drm 파일 경로를 찾습니다. (파일 더블클릭 = 파일 연결로 실행)
 * Windows는 실행 인자로, 두 번째 실행은 second-instance 이벤트의 argv로 전달됩니다.
 */
export const findDrmPath = (
  argv: readonly string[],
  exists: (path: string) => boolean = existsSync,
): string | null => {
  for (const arg of argv.slice(1)) {
    if (arg.startsWith("-")) continue;
    if (extname(arg).toLowerCase() !== ".drm") continue;
    const full = resolve(arg);
    if (exists(full)) return full;
  }
  return null;
};
