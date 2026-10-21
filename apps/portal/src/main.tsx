import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApiClient } from "./api/client.js";
import { ApiProvider } from "./api/context.js";
import { App } from "./App.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ApiProvider client={new ApiClient()}>
      <App />
    </ApiProvider>
  </StrictMode>,
);
