import { useEffect } from "react";
import { useApi, useAuthenticated } from "./api/context.js";
import { DistributionDetailPage } from "./pages/DistributionDetailPage.js";
import { DistributionListPage } from "./pages/DistributionListPage.js";
import { LoginPage } from "./pages/LoginPage.js";
import { NewDistributionPage } from "./pages/NewDistributionPage.js";
import { navigate, useRoute } from "./router.js";

export const App = () => {
  const api = useApi();
  const authenticated = useAuthenticated();
  const route = useRoute();

  // 로그인하지 않았으면 로그인 화면으로, 로그인했는데 로그인 화면이면 목록으로
  useEffect(() => {
    if (!authenticated && route.name !== "login") navigate({ name: "login" });
    if (authenticated && route.name === "login") navigate({ name: "list" });
  }, [authenticated, route.name]);

  if (!authenticated || route.name === "login") return <LoginPage />;

  return (
    <>
      <header className="app-header">
        <h1>
          <a href="#/" style={{ color: "inherit", textDecoration: "none" }}>
            DRM 배포 포털
          </a>
        </h1>
        <button type="button" onClick={() => api.logout()}>
          로그아웃
        </button>
      </header>
      <main>
        {route.name === "list" && <DistributionListPage />}
        {route.name === "new" && <NewDistributionPage />}
        {route.name === "detail" && <DistributionDetailPage id={route.id} />}
      </main>
    </>
  );
};
