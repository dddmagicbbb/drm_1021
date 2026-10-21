import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { ApiClient } from "./client.js";

const ApiContext = createContext<ApiClient | null>(null);

export const ApiProvider = ({ client, children }: { client: ApiClient; children: ReactNode }) => (
  <ApiContext.Provider value={client}>{children}</ApiContext.Provider>
);

export const useApi = (): ApiClient => {
  const client = useContext(ApiContext);
  if (!client) throw new Error("ApiProvider가 필요합니다");
  return client;
};

/** 로그인 상태 변화에 따라 다시 렌더링 */
export const useAuthenticated = (): boolean => {
  const api = useApi();
  return useSyncExternalStore(
    (cb) => api.subscribe(cb),
    () => api.isAuthenticated,
  );
};
