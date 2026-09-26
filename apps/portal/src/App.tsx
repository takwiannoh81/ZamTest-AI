import { api } from "./api";
import { IdleGuard, WhatsNew } from "@zamtest/help";
import type { MessageKey } from "@zamtest/i18n";
import { LanguageSelect, ThemeSelect, useI18n } from "@zamtest/i18n/react";
import { useHashRoute } from "./hooks";
import { Agents } from "./pages/Agents";
import { Assets } from "./pages/Assets";
import { Billing } from "./pages/Billing";
import { Customers } from "./pages/Customers";
import { Connect } from "./pages/Connect";
import { Dashboard } from "./pages/Dashboard";
import { JobDetail, Jobs } from "./pages/Jobs";
import { Restricted } from "./pages/Account";
import { Processes } from "./pages/Processes";
import { QueueDetail, Queues } from "./pages/Queues";
import { Schedules } from "./pages/Schedules";
import { Triggers } from "./pages/Triggers";
import { Security } from "./pages/Security";
import { SourceControl } from "./pages/SourceControl";
import { Settings } from "./pages/Settings";
import { Users } from "./pages/Users";
import { Docs } from "./pages/Docs";
import { TestReports } from "./pages/TestReports";
import { AuditLog } from "./pages/AuditLog";
import { BugReports, ReportPage } from "./pages/BugReports";
import { AGENT_DOWNLOAD_URL, DESIGNER_URL } from "./links";
import { atLeast, signOut, useMe } from "./session";

/** How long the session has been idle, across tabs (for the inactivity warning). */
const whoAmI = () => api<{ idleSeconds?: number }>("/api/auth/me");

const NAV: Array<{ path: string; label: MessageKey; icon: string; admin?: boolean; developer?: boolean; platform?: boolean }> = [
  { path: "/", label: "nav.dashboard", icon: "◎" },
  { path: "/processes", label: "nav.processes", icon: "▣" },
  { path: "/jobs", label: "nav.jobs", icon: "▶" },
  { path: "/schedules", label: "nav.schedules", icon: "◷" },
  { path: "/triggers", label: "nav.triggers", icon: "⚡" },
  { path: "/queues", label: "nav.queues", icon: "☷" },
  { path: "/test-reports", label: "nav.testReports", icon: "📊" },
  { path: "/agents", label: "nav.agents", icon: "⚙" },
  { path: "/assets", label: "nav.assets", icon: "🔑" },
  { path: "/source-control", label: "nav.sourceControl", icon: "⎇", developer: true },
  { path: "/users", label: "nav.users", icon: "👥", admin: true },
  { path: "/audit", label: "nav.audit", icon: "📜", admin: true },
  { path: "/billing", label: "nav.billing", icon: "💳", admin: true },
  { path: "/security", label: "nav.security", icon: "🛡" },
  { path: "/settings", label: "nav.settings", icon: "☰" },
  { path: "/docs", label: "nav.docs", icon: "📖" },
  { path: "/report", label: "nav.report", icon: "🐞" },
  { path: "/customers", label: "nav.customers", icon: "🏢", platform: true },
  { path: "/bug-reports", label: "nav.bugReports", icon: "🧰", platform: true },
];

export function App() {
  const { t } = useI18n();
  const me = useMe();
  const [fullRoute] = useHashRoute();
  // e.g. "/connect?code=ABCD-EFGH&next=designer"
  const [route = "/", query = ""] = fullRoute.split("?");
  const active = NAV.filter((n) => (n.path === "/" ? route === "/" : route.startsWith(n.path))).at(-1)?.path;

  if (me?.restriction) return <Restricted me={me} />;
  const guard =
    me && me.kind !== "open" ? (
      <>
        <IdleGuard minutes={me.idleTimeoutMinutes} check={whoAmI} />
        {me.whatsNew && <WhatsNew api={api} docsHref="#/docs" />}
      </>
    ) : null;

  let page;
  if (route === "/connect") page = <Connect query={query} />;
  else if (route === "/billing") page = <Billing query={query} />;
  else if (route === "/customers") page = <Customers />;
  else if (route.startsWith("/jobs/")) page = <JobDetail id={route.slice("/jobs/".length)} />;
  else if (route.startsWith("/queues/")) page = <QueueDetail id={route.slice("/queues/".length)} />;
  else if (route === "/queues") page = <Queues />;
  else if (route === "/processes") page = <Processes />;
  else if (route === "/test-reports") page = <TestReports query={query} />;
  else if (route === "/audit") page = <AuditLog />;
  else if (route === "/report") page = <ReportPage />;
  else if (route === "/bug-reports") page = <BugReports query={query} />;
  else if (route === "/jobs") page = <Jobs />;
  else if (route === "/schedules") page = <Schedules />;
  else if (route === "/triggers") page = <Triggers />;
  else if (route === "/agents") page = <Agents />;
  else if (route === "/assets") page = <Assets />;
  else if (route === "/settings") page = <Settings />;
  else if (route === "/security") page = <Security />;
  else if (route === "/source-control") page = <SourceControl />;
  else if (route === "/users") page = <Users />;
  else if (route === "/docs" || route.startsWith("/docs/")) page = <Docs section={route.slice("/docs/".length) || undefined} />;
  else page = <Dashboard />;

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo">Z</span>
          <div>
            <strong>ZamTech AI</strong>
            <small>{t("nav.portal")}</small>
          </div>
        </div>
        <nav>
          {NAV.filter((n) => (!n.admin || atLeast(me, "admin")) && (!n.developer || atLeast(me, "developer")) && (!n.platform || me?.platformAdmin)).map((n) => (
            <a key={n.path} href={`#${n.path}`} className={active === n.path ? "active" : ""}>
              <span className="nav-icon">{n.icon}</span>
              {t(n.label)}
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          {me && me.kind !== "open" && (
            <div className="user-chip">
              <strong>{me.kind === "token" ? t("role.token") : me.name}</strong>
              {me.workspace.name && <span className="workspace-name">{me.workspace.name}</span>}
              <span className="role">{t(`role.${me.role}` as MessageKey)}</span>
              <button className="link-btn" onClick={() => void signOut()}>
                {t("auth.signOut")}
              </button>
            </div>
          )}
          <LanguageSelect className="lang-select" />
          <ThemeSelect className="lang-select" />
          <a className="download-link" href={AGENT_DOWNLOAD_URL}>
            {t("agents.downloadWindows")}
          </a>
          <a className="designer-link" href={DESIGNER_URL} target="_blank" rel="noreferrer">
            {t("nav.openDesigner")}
          </a>
        </div>
      </aside>
      <main className="content">{page}</main>
      {guard}
    </div>
  );
}
