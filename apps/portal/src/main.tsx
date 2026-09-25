import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "@zamtest/i18n/react";
import { App } from "./App";
import { AuthGate } from "./AuthGate";
import { ResetPassword, VerifyEmail } from "./pages/Account";
import { BASE } from "./api";
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

/**
 * signin=1 (the page a newly installed agent opens to approve its PC): whoever
 * is signed in in this browser is signed out first, so the person signs in
 * again before the PC is approved and the Designer opens.
 */
async function freshSignIn(): Promise<void> {
  const params = new URLSearchParams(query);
  if (params.get("signin") !== "1") return;
  await fetch(`${BASE}/api/auth/logout`, { method: "POST", credentials: "include", headers: { "x-zamtech-client": "portal" } }).catch(() => undefined);
  params.delete("signin");
  // Without it, so the page does not sign out again after the person signs in (it reloads).
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${route}${params.toString() ? `?${params}` : ""}`);
}

void freshSignIn().then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <I18nProvider>{page}</I18nProvider>
    </StrictMode>,
  ),
);
