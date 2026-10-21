import { createContext, useContext, type ReactNode } from "react";
import type { DrmBridge } from "../shared/ipc.js";

declare global {
  interface Window {
    drm?: DrmBridge;
  }
}

const BridgeContext = createContext<DrmBridge | null>(null);

export const BridgeProvider = ({
  bridge,
  children,
}: {
  bridge: DrmBridge;
  children: ReactNode;
}) => <BridgeContext.Provider value={bridge}>{children}</BridgeContext.Provider>;

export const useBridge = (): DrmBridge => {
  const bridge = useContext(BridgeContext);
  if (!bridge) throw new Error("BridgeProvider가 필요합니다");
  return bridge;
};
