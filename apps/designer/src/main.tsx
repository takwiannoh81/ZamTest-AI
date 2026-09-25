import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "@zamtest/i18n/react";
import { App } from "./App";
import { AuthGate } from "./components/AuthGate";
import { BASE } from "./api";
import "./base.css";
import "./designer.css";

/**
 * ?signin=1 (opened by a newly installed agent): whoever is signed in in this
 * browser is signed out first, so the Designer asks for a sign-in (in the Portal).
 */
async function freshSignIn(): Promise<void> {
  const url = new URL(window.location.href);
  if (url.searchParams.get("signin") !== "1") return;
  await fetch(`${BASE}/api/auth/logout`, { method: "POST", credentials: "include", headers: { "x-zamtech-client": "designer" } }).catch(() => undefined);
  url.searchParams.delete("signin");
  window.history.replaceState(null, "", url.toString());
}

void freshSignIn().then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <I18nProvider>
        <AuthGate>
          <App />
        </AuthGate>
      </I18nProvider>
    </StrictMode>,
  ),
);
