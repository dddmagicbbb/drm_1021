import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IPC } from "../shared/ipc.js";

describe("IPC 계약", () => {
  it("preload가 노출하는 채널은 IPC 목록과 정확히 같다", () => {
    const preload = readFileSync(new URL("../preload/preload.cts", import.meta.url), "utf8");
    const used = new Set([...preload.matchAll(/"([a-z]+:[a-z-]+)"/g)].map((m) => m[1]));
    expect([...used].sort()).toEqual(Object.values(IPC).sort());
  });

  it("preload는 ipcRenderer 자체나 Node API를 노출하지 않는다", () => {
    const preload = readFileSync(new URL("../preload/preload.cts", import.meta.url), "utf8");
    expect(preload).not.toMatch(/exposeInMainWorld\([^)]*ipcRenderer\s*[,)]/);
    expect(preload).not.toMatch(/require\("(fs|child_process|node:)/);
  });
});
