import { useMemo, useState } from "react";
import type { MessageKey } from "@zamtest/i18n";
import { useI18n } from "@zamtest/i18n/react";
import { BASE } from "../api";
import { usePoll } from "../hooks";
import { Empty, ErrorBanner, PageHeader } from "../ui";

type Outcome = "passed" | "failed" | "cancelled";

interface Report {
  days: number;
  summary: { runs: number; tests: number; passed: number; failed: number; passRate?: number; avgMs?: number; flaky: number };
  daily: Array<{ day: string; passed: number; failed: number }>;
  tests: Array<{
    id: string;
    name: string;
    path: string;
    exists: boolean;
    runs: number;
    passed: number;
    failed: number;
    passRate: number;
    flaky: boolean;
    lastStatus: Outcome;
    lastAt: string;
    lastJobId?: string;
    avgMs?: number;
    lastError?: string;
    history: Outcome[];
  }>;
  failures: Array<{ message: string; count: number; tests: string[]; testCount: number; lastAt: string; lastJobId?: string }>;
  runs: Array<{ id: string; name: string; startedAt: string; startedBy: string; source: "person" | "schedule" | "api"; tests: number; passed: number; failed: number; done: boolean }>;
}

const PERIODS = [7, 30, 90];
const SOURCE_ICON = { person: "👤", schedule: "◷", api: "⚙" } as const;

const percent = (rate?: number) => (rate === undefined ? "–" : `${Math.round(rate * 100)}%`);
const seconds = (ms?: number) => (ms === undefined ? "–" : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);
const reportUrl = (runId: string, download = false) => `${BASE}/api/test-runs/${runId}/report${download ? "?download=1" : ""}`;

/** How the tests do over time: pass rate, flaky tests, common failures, and each run's report. */
export function TestReports({ query }: { query: string }) {
  const { t, dateTime } = useI18n();
  const [days, setDays] = useState(30);
  const [folderId, setFolderId] = useState("");
  const [sort, setSort] = useState<"passRate" | "slowest" | "runs">("passRate");
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const params = `days=${days}&tz=${encodeURIComponent(tz)}${folderId ? `&folderId=${folderId}` : ""}`;
  const report = usePoll<Report>(`/api/test-reports?${params}`, 30_000);
  const tree = usePoll<{ folders: Array<{ id: string; name: string; parentId?: string }> }>("/api/tests", 0);
  const openRun = new URLSearchParams(query).get("run");

  const r = report.data;
  const folders = useMemo(() => {
    const all = tree.data?.folders ?? [];
    const pathOf = (id?: string): string => {
      const f = all.find((x) => x.id === id);
      return f ? (f.parentId ? `${pathOf(f.parentId)} / ${f.name}` : f.name) : "";
    };
    return all.map((f) => ({ id: f.id, path: pathOf(f.id) })).sort((a, b) => a.path.localeCompare(b.path));
  }, [tree.data]);
  const tests = useMemo(() => {
    const list = [...(r?.tests ?? [])];
    if (sort === "slowest") list.sort((a, b) => (b.avgMs ?? 0) - (a.avgMs ?? 0));
    if (sort === "runs") list.sort((a, b) => b.runs - a.runs);
    return list;
  }, [r, sort]);
  const peak = Math.max(1, ...(r?.daily ?? []).map((d) => d.passed + d.failed));

  return (
    <>
      <PageHeader
        title={t("reports.title")}
        subtitle={t("reports.subtitle")}
        actions={
          <a className="btn-ghost" href={`${BASE}/api/test-reports/export.csv?${params}`}>
            ⤓ {t("reports.csv")}
          </a>
        }
      />
      {openRun && (
        <div className="notice">
          {t("reports.runLinked")}{" "}
          <a href={reportUrl(openRun)} target="_blank" rel="noreferrer">
            {t("reports.openReport")}
          </a>
        </div>
      )}
      <div className="report-filters">
        <div className="segmented">
          {PERIODS.map((p) => (
            <button key={p} className={days === p ? "active" : ""} onClick={() => setDays(p)}>
              {t("reports.days", { count: p })}
            </button>
          ))}
        </div>
        <select value={folderId} onChange={(e) => setFolderId(e.target.value)} aria-label={t("reports.folder")}>
          <option value="">{t("reports.allFolders")}</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              📁 {f.path}
            </option>
          ))}
        </select>
      </div>
      <ErrorBanner error={report.error} />
      {!r ? null : !r.summary.tests ? (
        <Empty>{t("reports.empty")}</Empty>
      ) : (
        <>
          <section className="tiles">
            <Tile label={t("reports.passRate")} value={percent(r.summary.passRate)} tone={(r.summary.passRate ?? 0) >= 0.9 ? "ok" : (r.summary.passRate ?? 0) >= 0.7 ? "warn" : "bad"} />
            <Tile label={t("reports.testsRun")} value={String(r.summary.tests)} hint={t("reports.inRuns", { count: r.summary.runs })} />
            <Tile label={t("reports.failed")} value={String(r.summary.failed)} tone={r.summary.failed ? "bad" : "ok"} />
            <Tile label={t("reports.flaky")} value={String(r.summary.flaky)} hint={t("reports.flakyHint")} tone={r.summary.flaky ? "warn" : "ok"} />
            <Tile label={t("reports.avgTime")} value={seconds(r.summary.avgMs)} />
          </section>

          <section className="card wide">
            <h2>{t("reports.perDay")}</h2>
            <div className="day-chart" role="img" aria-label={t("reports.perDay")}>
              {r.daily.map((d) => (
                <div key={d.day} className="day-col" title={`${d.day}: ✓ ${d.passed} · ✕ ${d.failed}`}>
                  <span className="day-bar failed" style={{ height: `${(d.failed / peak) * 100}%` }} />
                  <span className="day-bar passed" style={{ height: `${(d.passed / peak) * 100}%` }} />
                </div>
              ))}
            </div>
            <div className="day-axis muted small">
              <span>{r.daily[0]?.day}</span>
              <span>
                <span className="dot passed" /> {t("tests.status.passed")} <span className="dot failed" /> {t("tests.status.failed")}
              </span>
              <span>{r.daily.at(-1)?.day}</span>
            </div>
          </section>

          <section className="card wide">
            <div className="section-head">
              <h2>{t("reports.tests")}</h2>
              <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label={t("reports.sortBy")}>
                <option value="passRate">{t("reports.sortPassRate")}</option>
                <option value="slowest">{t("reports.sortSlowest")}</option>
                <option value="runs">{t("reports.sortRuns")}</option>
              </select>
            </div>
            <table>
              <thead>
                <tr>
                  <th>{t("reports.test")}</th>
                  <th>{t("reports.latest")}</th>
                  <th>{t("reports.passRate")}</th>
                  <th>{t("reports.runs")}</th>
                  <th>{t("reports.avgTime")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tests.map((c) => (
                  <tr key={c.id}>
                    <td>
                      {c.path && <span className="muted">{c.path} / </span>}
                      <strong>{c.name}</strong>
                      {c.flaky && <span className="chip warn-chip" title={t("reports.flakyHint")}>{t("reports.flakyBadge")}</span>}
                      {!c.exists && <span className="muted small"> ({t("reports.deleted")})</span>}
                      {c.lastStatus !== "passed" && c.lastError && <div className="muted small clamp">{c.lastError}</div>}
                    </td>
                    <td>
                      <span className="history" aria-label={c.history.join(", ")}>
                        {c.history.map((h, i) => (
                          <span key={i} className={`dot ${h === "passed" ? "passed" : "failed"}`} title={t(`tests.status.${h}` as MessageKey)} />
                        ))}
                      </span>
                    </td>
                    <td className={c.passRate >= 0.9 ? "ok-text" : c.passRate >= 0.7 ? "warn-text" : "error-text"}>{percent(c.passRate)}</td>
                    <td>
                      {c.runs} <span className="muted small">(✕ {c.failed})</span>
                    </td>
                    <td>{seconds(c.avgMs)}</td>
                    <td className="row-actions">{c.lastJobId && <a href={`#/jobs/${c.lastJobId}`}>{t("reports.lastJob")}</a>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {r.failures.length > 0 && (
            <section className="card wide">
              <h2>{t("reports.failures")}</h2>
              <p className="muted small">{t("reports.failuresHelp")}</p>
              <table>
                <tbody>
                  {r.failures.map((f, i) => (
                    <tr key={i}>
                      <td className="error-text nowrap">× {f.count}</td>
                      <td>
                        <code className="clamp">{f.message}</code>
                        <div className="muted small">
                          {f.tests.join(", ")}
                          {f.testCount > f.tests.length ? ` +${f.testCount - f.tests.length}` : ""} · {dateTime(f.lastAt)}
                        </div>
                      </td>
                      <td className="row-actions">{f.lastJobId && <a href={`#/jobs/${f.lastJobId}`}>{t("reports.lastJob")}</a>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}

      {r && r.runs.length > 0 && (
        <section className="card wide">
          <h2>{t("reports.recentRuns")}</h2>
          <table>
            <tbody>
              {r.runs.map((run) => (
                <tr key={run.id} className={run.id === openRun ? "highlight" : ""}>
                  <td title={t(`reports.source.${run.source}` as MessageKey)}>{SOURCE_ICON[run.source]}</td>
                  <td>
                    <strong>{run.name}</strong>
                    <div className="muted small">
                      {dateTime(run.startedAt)} · {run.startedBy}
                    </div>
                  </td>
                  <td className="nowrap">
                    <span className="ok-text">✓ {run.passed}</span> <span className="error-text">✕ {run.failed}</span>
                    {!run.done && <span className="muted"> · {t("tests.status.running")}</span>}
                  </td>
                  <td className="row-actions">
                    <a href={reportUrl(run.id)} target="_blank" rel="noreferrer">
                      {t("reports.openReport")}
                    </a>
                    <a href={reportUrl(run.id, true)}>{t("reports.download")}</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

function Tile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "ok" | "warn" | "bad" }) {
  return (
    <div className="tile">
      <span className="muted">{label}</span>
      <strong className={tone ? `${tone}-text` : undefined}>{value}</strong>
      {hint && <small className="muted">{hint}</small>}
    </div>
  );
}
