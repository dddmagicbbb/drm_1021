import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ApiClient } from "./api/client.js";
import { ApiProvider } from "./api/context.js";
import { App } from "./App.js";
import { TOKENS, fakeFetch, sampleSummary } from "./test/fake-server.js";

const renderApp = (client: ApiClient) =>
  render(
    <ApiProvider client={client}>
      <App />
    </ApiProvider>,
  );

describe("로그인 (T1-17)", () => {
  it("로그인하면 배포 목록으로 이동한다", async () => {
    const fetchMock = fakeFetch({
      "POST /auth/login": (body) =>
        (body as { password: string }).password === "correct-password"
          ? { status: 200, body: TOKENS }
          : {
              status: 401,
              body: {
                error: {
                  code: "UNAUTHENTICATED",
                  message: "이메일 또는 비밀번호가 올바르지 않습니다.",
                  correlationId: null,
                },
              },
            },
      "GET /distributions?page=1&size=50": () => ({ status: 200, body: [sampleSummary()] }),
    });
    const user = userEvent.setup();
    renderApp(new ApiClient(fetchMock as never, sessionStorage));

    await user.type(screen.getByLabelText("이메일"), "hong@company.com");
    await user.type(screen.getByLabelText("비밀번호"), "wrong");
    await user.click(screen.getByRole("button", { name: "로그인" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("이메일 또는 비밀번호");

    await user.clear(screen.getByLabelText("비밀번호"));
    await user.type(screen.getByLabelText("비밀번호"), "correct-password");
    await user.click(screen.getByRole("button", { name: "로그인" }));

    expect(await screen.findByText("A사 도면 송부")).toBeInTheDocument();
    expect(screen.getByText("열람 가능")).toBeInTheDocument();
    expect(window.location.hash).toBe("#/");
  });

  it("로그아웃하면 로그인 화면으로 돌아간다", async () => {
    sessionStorage.setItem("drm.portal.refreshToken", "r");
    const fetchMock = fakeFetch({
      "POST /auth/refresh": () => ({ status: 200, body: TOKENS }),
      "GET /distributions?page=1&size=50": () => ({ status: 200, body: [] }),
    });
    const user = userEvent.setup();
    renderApp(new ApiClient(fetchMock as never, sessionStorage));
    expect(await screen.findByText("아직 배포한 문서가 없습니다.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "로그아웃" }));
    await waitFor(() => expect(screen.getByRole("form", { name: "로그인" })).toBeInTheDocument());
    expect(sessionStorage.getItem("drm.portal.refreshToken")).toBeNull();
  });
});
