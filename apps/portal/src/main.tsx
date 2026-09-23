import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "@zamtest/i18n/react";
import { App } from "./App";
import { AuthGate } from "./AuthGate";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <AuthGate>
        <App />
      </AuthGate>
    </I18nProvider>
  </StrictMode>,
);
