import type { RecipientDocument } from "@drm/contracts";
import { RENDERER_STYLES, type PdfLoader } from "@drm/renderer";
import { useCallback, useEffect, useRef, useState } from "react";
import type { IpcResult, OpenedDocument, ViewerError } from "../shared/ipc.js";
import { useBridge } from "./bridge.js";
import { DocumentListScreen } from "./screens/DocumentListScreen.js";
import { ErrorScreen } from "./screens/ErrorScreen.js";
import { LoginScreen } from "./screens/LoginScreen.js";
import { ViewerScreen } from "./screens/ViewerScreen.js";

type View =
  | { name: "checking" }
  | { name: "login" }
  | { name: "list" }
  | { name: "opening"; label: string }
  | { name: "viewing"; doc: OpenedDocument }
  | { name: "error"; error: ViewerError };

/** 렌더러가 보관한 평문 사본을 지웁니다. */
const wipeDoc = (doc: OpenedDocument | null) => doc?.data.fill(0);

export const App = ({ pdfLoader }: { pdfLoader?: PdfLoader }) => {
  const drm = useBridge();
  const [view, setView] = useState<View>({ name: "checking" });
  const [email, setEmail] = useState<string | null>(null);
  const openDoc = useRef<OpenedDocument | null>(null);

  const showError = useCallback((error: ViewerError) => {
    wipeDoc(openDoc.current);
    openDoc.current = null;
    if (error.code === "UNAUTHENTICATED") {
      setEmail(null);
      setView({ name: "login" });
    } else {
      setView({ name: "error", error });
    }
  }, []);

  const show = useCallback(
    async (label: string, open: () => Promise<IpcResult<OpenedDocument | null>>) => {
      setView({ name: "opening", label });
      const res = await open();
      if (!res.ok) return showError(res.error);
      if (!res.value) return setView({ name: "list" });
      wipeDoc(openDoc.current);
      openDoc.current = res.value;
      setView({ name: "viewing", doc: res.value });
    },
    [showError],
  );

  /** 파일 더블클릭으로 전달된 .drm이 있으면 엽니다. (로그인 후) */
  const openPending = useCallback(
    () => show("문서를 여는 중…", () => drm.openPendingFile()),
    [drm, show],
  );

  useEffect(() => {
    void drm.authStatus().then((res) => {
      if (res.ok && res.value.loggedIn) {
        setEmail(res.value.email);
        void openPending();
      } else {
        setView({ name: "login" });
      }
    });
  }, [drm, openPending]);

  useEffect(() => {
    // 재발급 거부(회수·만료 등)로 main이 문서를 닫으면 사유를 보여줍니다.
    const offClosed = drm.onDocumentClosed((event) => showError(event.error));
    const offPending = drm.onPendingFile(() => {
      if (email) void openPending();
    });
    return () => {
      offClosed();
      offPending();
    };
  }, [drm, email, openPending, showError]);

  const close = async () => {
    wipeDoc(openDoc.current);
    openDoc.current = null;
    await drm.closeDocument();
    setView({ name: "list" });
  };

  const logout = async () => {
    wipeDoc(openDoc.current);
    openDoc.current = null;
    await drm.logout();
    setEmail(null);
    setView({ name: "login" });
  };

  return (
    <>
      <style>{RENDERER_STYLES}</style>
      {view.name === "checking" && <main className="center">확인 중…</main>}
      {view.name === "login" && (
        <LoginScreen
          onLoggedIn={(status) => {
            setEmail(status.email);
            void openPending();
          }}
        />
      )}
      {view.name === "list" && email && (
        <DocumentListScreen
          email={email}
          onOpen={(d: RecipientDocument) =>
            void show(`${d.fileName} 여는 중…`, () => drm.openRemote(d.docId, `${d.fileName}.drm`))
          }
          onLogout={() => void logout()}
          onError={showError}
        />
      )}
      {view.name === "opening" && <main className="center">{view.label}</main>}
      {view.name === "viewing" && (
        <ViewerScreen
          doc={view.doc}
          onClose={() => void close()}
          {...(pdfLoader ? { loader: pdfLoader } : {})}
        />
      )}
      {view.name === "error" && (
        <ErrorScreen
          error={view.error}
          onBack={() => setView(email ? { name: "list" } : { name: "login" })}
        />
      )}
    </>
  );
};
