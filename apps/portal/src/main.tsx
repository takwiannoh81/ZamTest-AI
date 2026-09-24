import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "@zamtest/i18n/react";
import { App } from "./App";
import { AuthGate } from "./AuthGate";
import { ResetPassword, VerifyEmail } from "./pages/Account";
import "./styles.css";

// Links from emails open without signing in first.
const [route = "", query = ""] = window.location.hash.replace(/^#/, "").split("?");
const token = new URLSearchParams(query).get("token") ?? "";
const page =
  route === "/verify" && token ? (
    <VerifyEmail token={token} />
  ) : route === "/reset-password" && token ? (
    <ResetPassword token={token} />
  ) : (
    <AuthGate>
      <App />
    </AuthGate>
  );
// Pasted into a portal tab that is already open: only the hash changes.
window.addEventListener("hashchange", () => {
  if (/^#\/(verify|reset-password)\?/.test(window.location.hash)) window.location.reload();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>{page}</I18nProvider>
  </StrictMode>,
);
