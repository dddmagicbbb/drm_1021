/**
 * 해시 기반 최소 라우터 (화면 4개 규모라 라이브러리 없이 구현)
 * #/login, #/, #/new, #/d/<id>
 */
import { useSyncExternalStore } from "react";

export type Route =
  { name: "login" } | { name: "list" } | { name: "new" } | { name: "detail"; id: string };

export const parseRoute = (hash: string): Route => {
  const path = hash.replace(/^#/, "") || "/";
  if (path === "/login") return { name: "login" };
  if (path === "/new") return { name: "new" };
  const detail = path.match(/^\/d\/([0-9a-f-]{36})$/i);
  if (detail) return { name: "detail", id: detail[1]! };
  return { name: "list" };
};

export const hrefOf = (route: Route): string => {
  switch (route.name) {
    case "login":
      return "#/login";
    case "new":
      return "#/new";
    case "detail":
      return `#/d/${route.id}`;
    default:
      return "#/";
  }
};

export const navigate = (route: Route): void => {
  window.location.hash = hrefOf(route);
};

const subscribe = (callback: () => void) => {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
};

export const useRoute = (): Route =>
  parseRoute(useSyncExternalStore(subscribe, () => window.location.hash));
