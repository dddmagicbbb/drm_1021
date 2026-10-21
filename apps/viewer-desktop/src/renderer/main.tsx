import { configurePdfWorker } from "@drm/renderer";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { BridgeProvider } from "./bridge.js";
import "./styles.css";

void configurePdfWorker(workerUrl);

const bridge = window.drm;
const root = createRoot(document.getElementById("root")!);
root.render(
  bridge ? (
    <StrictMode>
      <BridgeProvider bridge={bridge}>
        <App />
      </BridgeProvider>
    </StrictMode>
  ) : (
    <p>보안 뷰어 앱에서만 실행할 수 있습니다.</p>
  ),
);
