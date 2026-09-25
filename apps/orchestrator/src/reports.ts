/**
 * Test reports: pass rate over time, flaky tests, the slowest tests and the most
 * common failures, from the results test runs keep. Plus a report of one run as
 * a page to print or save as PDF (with the screens of failed tests), and a CSV.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { parse } from "./errors.js";
import { resultOf, folderSubtree } from "./testcases.js";
import type { ScreenshotStore } from "./screenshots.js";
import type { Store } from "./store.js";
import type { Principal, TestRun, TestRunItem } from "./types.js";

type Outcome = "passed" | "failed" | "cancelled";

/** A finished test in a run, with its outcome (kept in the run, or from its job for runs from before results were kept). */
interface Done {
  run: TestRun;
  item: TestRunItem;
  status: Outcome;
  message?: string;
  durationMs?: number;
  at: string;
}

/** How many of a test's latest results decide whether it is flaky. */
const FLAKY_WINDOW = 10;

export interface ReportContext {
  store: Store;
  screenshots: ScreenshotStore;
  me(req: FastifyRequest): Principal;
  own<T extends { workspaceId: string }>(collection: Record<string, T>, id: string, what: string, req: FastifyRequest): T;
}

/** "Timed out after 30000 ms waiting for #id-123" and "... 25000 ms ... #id-9" are the same failure. */
export function failureKey(message: string): string {
  return message
    .replace(/\s+/g, " ")
    .replace(/\b[0-9a-f]{8,}\b/gi, "…")
    .replace(/\d+/g, "#")
    .trim()
    .slice(0, 160);
}

/** The day of a moment in the viewer's time zone (YYYY-MM-DD). */
function dayOf(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

export function registerReports(app: FastifyInstance, ctx: ReportContext): void {
  const { store } = ctx;

  const finished = (run: TestRun): Done[] => {
    const out: Done[] = [];
    for (const item of run.items) {
      if (item.result) {
        out.push({ run, item, status: item.result.status, message: item.result.message, durationMs: item.result.durationMs, at: item.result.finishedAt });
        continue;
      }
      const job = item.jobId ? store.data.jobs[item.jobId] : undefined;
      const r = resultOf(job, store.data.testCases[item.testCaseId]?.expectedOutputs);
      if (!r || r.status === "pending" || r.status === "running") continue;
      const started = job?.startedAt ? Date.parse(job.startedAt) : NaN;
      const ended = job?.finishedAt ? Date.parse(job.finishedAt) : NaN;
      out.push({
        run,
        item,
        status: r.status,
        message: r.message,
        durationMs: Number.isFinite(started) && Number.isFinite(ended) ? ended - started : undefined,
        at: job?.finishedAt ?? run.startedAt,
      });
    }
    return out;
  };

  const Query = z.object({
    days: z.coerce.number().int().min(1).max(366).default(30),
    folderId: z.string().optional(),
    tz: z.string().max(64).default("UTC"),
  });

  /** Everything the Reports page shows, for the last `days` days. */
  const report = (req: FastifyRequest) => {
    const q = parse(Query, req.query);
    const workspaceId = ctx.me(req).workspaceId;
    if (q.folderId) ctx.own(store.data.testFolders, q.folderId, "Folder", req);
    const inFolder = q.folderId ? folderSubtree(store, workspaceId, q.folderId) : undefined;
    const since = new Date(Date.now() - q.days * 24 * 60 * 60 * 1000).toISOString();
    const runs = Object.values(store.data.testRuns)
      .filter((r) => r.workspaceId === workspaceId && r.startedAt >= since)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const keep = (d: Done) => {
      if (!inFolder) return true;
      const folderId = store.data.testCases[d.item.testCaseId]?.folderId;
      return Boolean(folderId && inFolder.has(folderId));
    };
    const results = runs.flatMap(finished).filter(keep);

    const passed = results.filter((d) => d.status === "passed").length;
    const durations = results.map((d) => d.durationMs).filter((ms): ms is number => typeof ms === "number");

    // Per day, in the viewer's time zone; days without runs are shown too.
    const daily = new Map<string, { day: string; passed: number; failed: number }>();
    for (let i = q.days - 1; i >= 0; i--) {
      const day = dayOf(new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString(), q.tz);
      daily.set(day, { day, passed: 0, failed: 0 });
    }
    for (const d of results) {
      const slot = daily.get(dayOf(d.at, q.tz));
      if (slot) slot[d.status === "passed" ? "passed" : "failed"]++;
    }

    // Per test case (every row of a data-driven test counts).
    const byCase = new Map<string, Done[]>();
    for (const d of results) byCase.set(d.item.testCaseId, [...(byCase.get(d.item.testCaseId) ?? []), d]);
    const tests = [...byCase.entries()].map(([id, list]) => {
      list.sort((a, b) => a.at.localeCompare(b.at));
      const last = list.at(-1)!;
      const recent = list.slice(-FLAKY_WINDOW);
      const ok = list.filter((d) => d.status === "passed").length;
      const times = list.map((d) => d.durationMs).filter((ms): ms is number => typeof ms === "number");
      const testCase = store.data.testCases[id];
      const lastFailure = [...list].reverse().find((d) => d.status !== "passed");
      return {
        id,
        name: testCase?.name ?? last.item.name,
        path: last.item.path,
        exists: Boolean(testCase),
        runs: list.length,
        passed: ok,
        failed: list.length - ok,
        passRate: list.length ? ok / list.length : 0,
        // Both passed and failed among its latest results: often timing, not the app.
        flaky: recent.some((d) => d.status === "passed") && recent.some((d) => d.status !== "passed"),
        lastStatus: last.status,
        lastAt: last.at,
        lastJobId: last.item.jobId,
        avgMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : undefined,
        maxMs: times.length ? Math.max(...times) : undefined,
        lastError: lastFailure?.message,
        history: recent.map((d) => d.status),
      };
    });
    tests.sort((a, b) => a.passRate - b.passRate || b.runs - a.runs || a.name.localeCompare(b.name));

    // The most common failures, alike messages together.
    const failures = new Map<string, { message: string; count: number; tests: Set<string>; lastAt: string; lastJobId?: string }>();
    for (const d of results) {
      if (d.status === "passed" || !d.message) continue;
      const key = failureKey(d.message);
      const f = failures.get(key) ?? { message: d.message, count: 0, tests: new Set<string>(), lastAt: d.at, lastJobId: d.item.jobId };
      f.count++;
      f.tests.add(d.item.name);
      if (d.at >= f.lastAt) Object.assign(f, { message: d.message, lastAt: d.at, lastJobId: d.item.jobId });
      failures.set(key, f);
    }

    const runSummary = (r: TestRun) => {
      const done = finished(r).filter(keep);
      const ok = done.filter((d) => d.status === "passed").length;
      return { id: r.id, name: r.name, startedAt: r.startedAt, startedBy: r.startedBy, source: r.source ?? "person", tests: r.items.length, passed: ok, failed: done.length - ok, done: Boolean(r.finishedAt) || done.length === r.items.length };
    };

    return {
      days: q.days,
      summary: {
        runs: runs.length,
        tests: results.length,
        passed,
        failed: results.length - passed,
        passRate: results.length ? passed / results.length : undefined,
        avgMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : undefined,
        flaky: tests.filter((t) => t.flaky).length,
      },
      daily: [...daily.values()],
      tests,
      failures: [...failures.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, 10)
        .map((f) => ({ message: f.message, count: f.count, tests: [...f.tests].slice(0, 5), testCount: f.tests.size, lastAt: f.lastAt, lastJobId: f.lastJobId })),
      runs: runs.slice(-50).reverse().map(runSummary),
    };
  };

  app.get("/api/test-reports", async (req) => report(req));

  /** Per test: its numbers, for a spreadsheet. */
  app.get("/api/test-reports/export.csv", async (req, reply) => {
    const r = report(req);
    const cell = (v: unknown) => {
      const s = v === undefined || v === null ? "" : String(v);
      // A cell starting with = + - @ would be a formula in Excel.
      const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const lines = [
      ["Folder", "Test", "Runs", "Passed", "Failed", "Pass rate %", "Flaky", "Average seconds", "Last result", "Last run (UTC)", "Last error"].join(","),
      ...r.tests.map((t) =>
        [t.path, t.name, t.runs, t.passed, t.failed, Math.round(t.passRate * 100), t.flaky ? "yes" : "no", t.avgMs !== undefined ? (t.avgMs / 1000).toFixed(1) : "", t.lastStatus, t.lastAt, t.lastError ?? ""].map(cell).join(","),
      ),
    ];
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="test-report-${r.days}-days.csv"`)
      .send(`﻿${lines.join("\r\n")}\r\n`);
  });

  /** One run as a page to read, print or save as PDF. */
  app.get<{ Params: { id: string }; Querystring: { download?: string } }>("/api/test-runs/:id/report", async (req, reply) => {
    const run = ctx.own(store.data.testRuns, req.params.id, "Test run", req);
    const workspace = store.data.workspaces[run.workspaceId];
    const done = new Map(finished(run).map((d) => [d.item, d]));
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
    const secs = (ms?: number) => (ms === undefined ? "" : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);
    const rows = run.items.map((item) => ({ item, d: done.get(item) }));
    const passed = rows.filter((r) => r.d?.status === "passed").length;
    const failed = rows.filter((r) => r.d && r.d.status !== "passed").length;
    const pending = rows.length - passed - failed;
    const total = rows.reduce((sum, r) => sum + (r.d?.durationMs ?? 0), 0);
    let images = 0;
    const screenOf = (jobId?: string) => {
      // The screen when it failed, for the first 30 failures (the page stays a reasonable size).
      if (!jobId || images >= 30) return "";
      try {
        const shots = ctx.screenshots.list(jobId);
        const shot = [...shots].reverse().find((s) => s.status === "error") ?? shots.at(-1);
        const data = shot ? ctx.screenshots.read(jobId, shot.seq) : undefined;
        if (!data) return "";
        images++;
        return `<img src="data:image/jpeg;base64,${data.toString("base64")}" alt="">`;
      } catch {
        return "";
      }
    };
    const statusText: Record<string, string> = { passed: "✓ Passed", failed: "✕ Failed", cancelled: "– Cancelled" };
    const body = rows
      .map(({ item, d }) => {
        const status = d?.status ?? "running";
        const name = `${item.path ? `<span class="muted">${esc(item.path)} / </span>` : ""}${esc(item.name)}${item.row ? ` <span class="muted">· row ${item.row}${item.rowLabel ? `: ${esc(item.rowLabel)}` : ""}</span>` : ""}`;
        const detail = d && d.status !== "passed" ? `<div class="error">${esc(d.message ?? "Failed")}</div>${screenOf(item.jobId)}` : "";
        return `<tr class="${status}"><td class="st">${statusText[status] ?? "◔ Running"}</td><td>${name}${detail}</td><td class="num">${secs(d?.durationMs)}</td></tr>`;
      })
      .join("\n");
    const rate = passed + failed ? Math.round((passed / (passed + failed)) * 100) : 0;
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Test report - ${esc(run.name)}</title>
<style>
:root{--ok:#1a8f4c;--bad:#c62f3b;--muted:#6b7080;--line:#e3e5ec}
body{font-family:Segoe UI,Arial,sans-serif;color:#1f2330;margin:0;background:#f6f7fb}
main{max-width:960px;margin:0 auto;padding:28px 20px;background:#fff;min-height:100vh}
h1{font-size:22px;margin:0 0 4px}.muted{color:var(--muted)}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin:20px 0}
.card{border:1px solid var(--line);border-radius:8px;padding:12px 16px;min-width:120px}
.card b{display:block;font-size:24px}.ok b{color:var(--ok)}.bad b{color:var(--bad)}
.bar{display:flex;height:10px;border-radius:5px;overflow:hidden;background:var(--line);margin:8px 0 22px}
.bar span{display:block}.bar .p{background:var(--ok)}.bar .f{background:var(--bad)}
table{width:100%;border-collapse:collapse}td{border-top:1px solid var(--line);padding:9px 8px;vertical-align:top}
.st{white-space:nowrap;font-weight:600;width:110px}.passed .st{color:var(--ok)}.failed .st,.cancelled .st{color:var(--bad)}
.num{text-align:right;white-space:nowrap;color:var(--muted)}
.error{margin-top:6px;color:var(--bad);font-family:Consolas,monospace;font-size:12.5px;white-space:pre-wrap;word-break:break-word}
img{display:block;max-width:100%;margin-top:8px;border:1px solid var(--line);border-radius:4px}
.print{float:right;background:#6d5dfc;color:#fff;border:0;border-radius:6px;padding:8px 14px;font-size:14px;cursor:pointer}
footer{margin-top:28px;font-size:12px;color:var(--muted)}
@media print{body{background:#fff}main{padding:0}.print{display:none}tr{break-inside:avoid}}
</style></head><body><main>
<button class="print" onclick="window.print()">Print / Save as PDF</button>
<h1>${esc(run.name)}</h1>
<div class="muted">Test run · ${esc(workspace?.name ?? "")} · started ${esc(new Date(run.startedAt).toUTCString())} by ${esc(run.startedBy)}</div>
<div class="cards">
<div class="card"><b>${rows.length}</b>tests</div>
<div class="card ok"><b>${passed}</b>passed</div>
<div class="card bad"><b>${failed}</b>failed</div>
${pending ? `<div class="card"><b>${pending}</b>still running</div>` : ""}
<div class="card"><b>${rate}%</b>pass rate</div>
<div class="card"><b>${secs(total) || "-"}</b>total time</div>
</div>
<div class="bar"><span class="p" style="width:${rows.length ? (passed / rows.length) * 100 : 0}%"></span><span class="f" style="width:${rows.length ? (failed / rows.length) * 100 : 0}%"></span></div>
<table><tbody>
${body}
</tbody></table>
<footer>ZamTech AI · report made ${esc(new Date().toUTCString())}</footer>
</main></body></html>`;
    const fileName = `test-report-${run.name.replace(/[^\w.-]+/g, "-").slice(0, 60) || "run"}.html`;
    return reply
      .header("content-type", "text/html; charset=utf-8")
      .header("content-disposition", `${req.query.download ? "attachment" : "inline"}; filename="${fileName}"`)
      .header("content-security-policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-hashes' 'sha256-MguIPR6qNR8D3B+eAlK+bIRTZe8t3wkOY4B/56Me9FU='")
      .send(html);
  });
}
