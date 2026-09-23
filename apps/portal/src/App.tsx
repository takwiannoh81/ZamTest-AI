import { useHashRoute } from "./hooks";
import { Agents } from "./pages/Agents";
import { Assets } from "./pages/Assets";
import { Dashboard } from "./pages/Dashboard";
import { JobDetail, Jobs } from "./pages/Jobs";
import { Processes } from "./pages/Processes";
import { Schedules } from "./pages/Schedules";
import { Settings } from "./pages/Settings";

const DESIGNER_URL = import.meta.env.VITE_DESIGNER_URL ?? "http://localhost:5174";

const NAV = [
  { path: "/", label: "Dashboard", icon: "◎" },
  { path: "/processes", label: "Processes", icon: "▣" },
  { path: "/jobs", label: "Jobs", icon: "▶" },
  { path: "/schedules", label: "Schedules", icon: "◷" },
  { path: "/agents", label: "Bot Agents", icon: "⚙" },
  { path: "/assets", label: "Assets", icon: "🔑" },
  { path: "/settings", label: "Settings", icon: "☰" },
];

export function App() {
  const [route] = useHashRoute();
  const active = NAV.filter((n) => n.path === "/" ? route === "/" : route.startsWith(n.path)).at(-1)?.path ?? "/";

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
            <small>Portal</small>
          </div>
        </div>
        <nav>
          {NAV.map((n) => (
            <a key={n.path} href={`#${n.path}`} className={active === n.path ? "active" : ""}>
              <span className="nav-icon">{n.icon}</span>
              {n.label}
            </a>
          ))}
        </nav>
        <a className="designer-link" href={DESIGNER_URL} target="_blank" rel="noreferrer">
          Open Designer ↗
        </a>
      </aside>
      <main className="content">{page}</main>
    </div>
  );
}
