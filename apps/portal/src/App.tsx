import type { MessageKey } from "@zamtest/i18n";
import { LanguageSelect, useI18n } from "@zamtest/i18n/react";
import { useHashRoute } from "./hooks";
import { Agents } from "./pages/Agents";
import { Assets } from "./pages/Assets";
import { Dashboard } from "./pages/Dashboard";
import { JobDetail, Jobs } from "./pages/Jobs";
import { Processes } from "./pages/Processes";
import { Schedules } from "./pages/Schedules";
import { Settings } from "./pages/Settings";

const DESIGNER_URL = import.meta.env.VITE_DESIGNER_URL ?? "http://localhost:5174";

const NAV: Array<{ path: string; label: MessageKey; icon: string }> = [
  { path: "/", label: "nav.dashboard", icon: "◎" },
  { path: "/processes", label: "nav.processes", icon: "▣" },
  { path: "/jobs", label: "nav.jobs", icon: "▶" },
  { path: "/schedules", label: "nav.schedules", icon: "◷" },
  { path: "/agents", label: "nav.agents", icon: "⚙" },
  { path: "/assets", label: "nav.assets", icon: "🔑" },
  { path: "/settings", label: "nav.settings", icon: "☰" },
];

export function App() {
  const { t } = useI18n();
  const [route] = useHashRoute();
  const active = NAV.filter((n) => (n.path === "/" ? route === "/" : route.startsWith(n.path))).at(-1)?.path ?? "/";

  let page;
  if (route.startsWith("/jobs/")) page = <JobDetail id={route.slice("/jobs/".length)} />;
  else if (route === "/processes") page = <Processes />;
  else if (route === "/jobs") page = <Jobs />;
  else if (route === "/schedules") page = <Schedules />;
  else if (route === "/agents") page = <Agents />;
  else if (route === "/assets") page = <Assets />;
  else if (route === "/settings") page = <Settings />;
  else page = <Dashboard />;

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo">Z</span>
          <div>
            <strong>ZamTest AI</strong>
            <small>{t("nav.portal")}</small>
          </div>
        </div>
        <nav>
          {NAV.map((n) => (
            <a key={n.path} href={`#${n.path}`} className={active === n.path ? "active" : ""}>
              <span className="nav-icon">{n.icon}</span>
              {t(n.label)}
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          <LanguageSelect className="lang-select" />
          <a className="designer-link" href={DESIGNER_URL} target="_blank" rel="noreferrer">
            {t("nav.openDesigner")}
          </a>
        </div>
      </aside>
      <main className="content">{page}</main>
    </div>
  );
}
