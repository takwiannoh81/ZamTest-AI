import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "@zamtest/i18n/react";
import { Site } from "./Site";
import "./site.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <Site />
    </I18nProvider>
  </StrictMode>,
);
