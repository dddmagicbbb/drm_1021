import { describe, expect, it } from "vitest";
import {
  RENDERER_CSP,
  createWindowOptions,
  isAllowedNavigation,
  shouldBlockInput,
} from "./hardening.js";

const key = (
  k: string,
  mods: Partial<Record<"control" | "meta" | "shift" | "alt", boolean>> = {},
) => ({
  type: "keyDown" as const,
  key: k,
  control: false,
  meta: false,
  shift: false,
  alt: false,
  ...mods,
});

describe("창 보안 설정 (T1-20)", () => {
  it("렌더러 격리·샌드박스를 켜고 Node 통합을 끈다", () => {
    const { webPreferences } = createWindowOptions({ preloadPath: "p.cjs", allowDevTools: false });
    expect(webPreferences).toMatchObject({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: false,
    });
  });

  it("CSP는 렌더러의 네트워크 접근과 외부 스크립트를 막는다", () => {
    expect(RENDERER_CSP).toContain("connect-src 'none'");
    expect(RENDERER_CSP).toContain("script-src 'self'");
    expect(RENDERER_CSP).toContain("object-src 'none'");
    expect(RENDERER_CSP).not.toContain("unsafe-eval");
  });

  it("앱 페이지 외의 이동을 차단한다", () => {
    const index = "file:///C:/app/dist/renderer/index.html";
    expect(isAllowedNavigation(index, index)).toBe(true);
    expect(isAllowedNavigation(`${index}#/doc`, index)).toBe(true);
    expect(isAllowedNavigation("https://evil.example.com", index)).toBe(false);
    expect(isAllowedNavigation("file:///C:/Windows/system32/x.html", index)).toBe(false);
    expect(isAllowedNavigation("not a url", index)).toBe(false);
  });

  it("인쇄·저장·복사·새로고침·캡처 단축키를 차단한다", () => {
    for (const k of ["p", "s", "c", "x", "a", "r", "u"]) {
      expect(shouldBlockInput(key(k, { control: true }), false), `Ctrl+${k}`).toBe(true);
    }
    expect(shouldBlockInput(key("PrintScreen"), false)).toBe(true);
    expect(shouldBlockInput(key("F5"), false)).toBe(true);
    expect(shouldBlockInput(key("ArrowRight"), false)).toBe(false);
    expect(shouldBlockInput(key("p"), false)).toBe(false);
    expect(shouldBlockInput({ ...key("p", { control: true }), type: "keyUp" }, false)).toBe(false);
  });

  it("운영에서는 개발자 도구 단축키를 차단한다", () => {
    expect(shouldBlockInput(key("F12"), false)).toBe(true);
    expect(shouldBlockInput(key("I", { control: true, shift: true }), false)).toBe(true);
    expect(shouldBlockInput(key("F12"), true)).toBe(false);
  });
});
