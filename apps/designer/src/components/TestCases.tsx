import { useCallback, useEffect, useMemo, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { VariableDef } from "@zamtest/core";
import { useI18n } from "@zamtest/i18n/react";
import type { MessageKey } from "@zamtest/i18n";
import { api, BASE } from "../api";
import type { Agent, WorkflowDraft, WorkflowSummary } from "../api";
import { ErrorBanner, Field } from "./ui";
import { TestDataModal } from "./TestDataModal";

type Status = "pending" | "running" | "passed" | "failed" | "cancelled";

interface Folder {
  id: string;
  name: string;
  parentId?: string;
}
interface TestCase {
  id: string;
  name: string;
  folderId?: string;
  /** Older test cases run a workflow; new ones have their own steps. */
  workflowId?: string;
  workflowName?: string;
  /** How many steps a test case with its own steps has. */
  steps?: number;
  inputs: Record<string, unknown>;
  expectedOutputs?: Record<string, unknown>;
  targetAgentId?: string;
  last?: { jobId: string; at: string; status: Status; message?: string };
  /** Test data: runs once per row. */
  dataSize?: { columns: number; rows: number };
}
interface TestRun {
  id: string;
  name: string;
  startedBy: string;
  startedAt: string;
  done: boolean;
  passed: number;
  failed: number;
  running: number;
  items: Array<{ testCaseId: string; name: string; path: string; jobId?: string; status: Status; message?: string; row?: number; rowLabel?: string }>;
}

/** What is selected in the tree: everything (the root), a folder, or a test case. */
type Selection = { kind: "root" } | { kind: "folder"; id: string } | { kind: "case"; id: string };
interface Menu {
  x: number;
  y: number;
  target: Selection;
}

const PORTAL_URL = import.meta.env.VITE_PORTAL_URL ?? "http://localhost:5173";
const jobLink = (jobId: string) => `${PORTAL_URL}/#/jobs/${jobId}`;
const reportLink = (runId: string) => `${BASE}/api/test-runs/${runId}/report`;
const STATUS_ICON: Record<Status, string> = { pending: "◌", running: "◔", passed: "✓", failed: "✕", cancelled: "–" };

/** Typed values stay typed: numbers, true/false and JSON; anything else is text. */
const parseValue = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
const showValue = (value: unknown) => (value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value));

/** Folders of test cases (right-click for actions), a test case's settings, and test runs. */
export function TestCases({ workflows, onOpen }: { workflows: WorkflowSummary[]; onOpen: (testCaseId: string) => void }) {
  const { t, dateTime } = useI18n();
  const [folders, setFolders] = useState<Folder[]>([]);
  const [cases, setCases] = useState<TestCase[]>([]);
  const [runs, setRuns] = useState<TestRun[]>([]);
  const [selected, setSelected] = useState<Selection>({ kind: "root" });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<Menu>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      const [tree, recent] = await Promise.all([api<{ folders: Folder[]; cases: TestCase[] }>("/api/tests"), api<TestRun[]>("/api/test-runs")]);
      setFolders(tree.folders);
      setCases(tree.cases);
      setRuns(recent);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => void load(), [load]);

  // While a run is going, follow it.
  const active = runs.some((r) => !r.done);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [active, load]);

  useEffect(() => {
    const close = () => setMenu(undefined);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const act = async (action: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    }
    await load();
  };
  const folderIdOf = (target: Selection) => (target.kind === "folder" ? target.id : target.kind === "case" ? cases.find((c) => c.id === target.id)?.folderId : undefined);

  const newFolder = (parentId?: string) =>
    act(async () => {
      const name = prompt(t("tests.folderName"));
      if (!name?.trim()) return;
      const folder = await api<Folder>("/api/test-folders", { method: "POST", body: { name: name.trim(), parentId } });
      if (parentId) setOpen((o) => new Set(o).add(parentId));
      setSelected({ kind: "folder", id: folder.id });
    });
  const newCase = (folderId?: string) =>
    act(async () => {
      const name = prompt(t("tests.caseName"));
      if (!name?.trim()) return;
      // A new test case starts empty and opens in the editor.
      const created = await api<TestCase>("/api/test-cases", { method: "POST", body: { name: name.trim(), folderId } });
      onOpen(created.id);
    });
  const rename = (target: Selection) =>
    act(async () => {
      const current = target.kind === "folder" ? folders.find((f) => f.id === target.id)?.name : cases.find((c) => c.id === (target as { id: string }).id)?.name;
      const name = prompt(t("tests.rename"), current);
      if (!name?.trim() || target.kind === "root") return;
      await api(`/api/${target.kind === "folder" ? "test-folders" : "test-cases"}/${target.id}`, { method: "PUT", body: { name: name.trim() } });
    });
  const remove = (target: Selection) =>
    act(async () => {
      if (target.kind === "root") return;
      const name = target.kind === "folder" ? folders.find((f) => f.id === target.id)?.name : cases.find((c) => c.id === target.id)?.name;
      if (!confirm(t(target.kind === "folder" ? "tests.confirmDeleteFolder" : "tests.confirmDeleteCase", { name: name ?? "" }))) return;
      await api(`/api/${target.kind === "folder" ? "test-folders" : "test-cases"}/${target.id}`, { method: "DELETE" });
      setSelected({ kind: "root" });
    });
  const run = (target: Selection) =>
    act(async () => {
      const body = target.kind === "folder" ? { folderId: target.id } : target.kind === "case" ? { caseIds: [target.id] } : {};
      await api("/api/test-runs", { method: "POST", body });
      if (target.kind !== "case") setSelected(target);
    });

  const openMenu = (e: ReactMouseEvent, target: Selection) => {
    e.preventDefault();
    e.stopPropagation();
    setSelected(target);
    setMenu({ x: e.clientX, y: e.clientY, target });
  };

  const children = useMemo(() => {
    const byParent = new Map<string, { folders: Folder[]; cases: TestCase[] }>();
    const slot = (key: string) => byParent.get(key) ?? byParent.set(key, { folders: [], cases: [] }).get(key)!;
    for (const f of folders) slot(f.parentId ?? "").folders.push(f);
    for (const c of cases) slot(c.folderId ?? "").cases.push(c);
    return (key: string) => byParent.get(key) ?? { folders: [], cases: [] };
  }, [folders, cases]);

  const isSelected = (s: Selection) => selected.kind === s.kind && (s.kind === "root" || (selected as { id: string }).id === (s as { id: string }).id);

  const renderLevel = (parentKey: string, depth: number) => {
    const level = children(parentKey);
    return (
      <>
        {level.folders.map((f) => {
          const expanded = open.has(f.id);
          const target: Selection = { kind: "folder", id: f.id };
          return (
            <div key={f.id}>
              <div
                className={`tree-row${isSelected(target) ? " selected" : ""}`}
                style={{ paddingInlineStart: 8 + depth * 16 }}
                onClick={() => setSelected(target)}
                onDoubleClick={() => setOpen((o) => (o.delete(f.id) ? new Set(o) : new Set(o).add(f.id)))}
                onContextMenu={(e) => openMenu(e, target)}
              >
                <button
                  className="tree-toggle"
                  aria-label={expanded ? t("tests.collapse") : t("tests.expand")}
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen((o) => (o.delete(f.id) ? new Set(o) : new Set(o).add(f.id)));
                  }}
                >
                  {expanded ? "▾" : "▸"}
                </button>
                <span className="tree-icon">📁</span>
                <span className="tree-name">{f.name}</span>
              </div>
              {expanded && renderLevel(f.id, depth + 1)}
            </div>
          );
        })}
        {level.cases.map((c) => {
          const target: Selection = { kind: "case", id: c.id };
          return (
            <div
              key={c.id}
              className={`tree-row${isSelected(target) ? " selected" : ""}`}
              style={{ paddingInlineStart: 26 + depth * 16 }}
              onClick={() => setSelected(target)}
              onDoubleClick={() => !c.workflowId && onOpen(c.id)}
              onContextMenu={(e) => openMenu(e, target)}
            >
              <span className={`test-dot status-${c.last?.status ?? "none"}`} title={c.last ? t(`tests.status.${c.last.status}` as MessageKey) : t("tests.neverRun")} />
              <span className="tree-name">{c.name}</span>
            </div>
          );
        })}
      </>
    );
  };

  const selectedCase = selected.kind === "case" ? cases.find((c) => c.id === selected.id) : undefined;
  const scopeRuns = runs.filter((r) => selected.kind === "root" || selected.kind === "case" || r.name.startsWith(pathOf(folders, selected.id)));

  return (
    <div className="tests">
      <div className="tests-toolbar">
        <button className="btn" disabled={!cases.length} onClick={() => void run({ kind: "root" })}>
          ▷ {t("tests.runAll")}
        </button>
        <button className="btn-ghost" onClick={() => void newFolder(folderIdOf(selected))}>
          + {t("tests.newFolder")}
        </button>
        <button className="btn-ghost" onClick={() => void newCase(folderIdOf(selected))}>
          + {t("tests.newCase")}
        </button>
        <span className="muted tiny">{t("tests.rightClickHint")}</span>
      </div>
      <ErrorBanner error={error} />
      <div className="tests-body">
        <nav className="tests-tree" onContextMenu={(e) => openMenu(e, { kind: "root" })} onClick={() => setSelected({ kind: "root" })}>
          <div
            className={`tree-row root${isSelected({ kind: "root" }) ? " selected" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              setSelected({ kind: "root" });
            }}
            onContextMenu={(e) => openMenu(e, { kind: "root" })}
          >
            <span className="tree-icon">🧪</span>
            <span className="tree-name">{t("tests.all", { count: cases.length })}</span>
          </div>
          <div onClick={(e) => e.stopPropagation()}>{renderLevel("", 0)}</div>
          {!folders.length && !cases.length && <p className="muted tiny tree-empty">{t("tests.empty")}</p>}
        </nav>
        <section className="tests-detail">
          {selectedCase && !selectedCase.workflowId ? (
            <CaseSummary testCase={selectedCase} onOpen={() => onOpen(selectedCase.id)} onRun={() => void run({ kind: "case", id: selectedCase.id })} onChanged={() => void load()} />
          ) : selectedCase ? (
            <CaseEditor key={selectedCase.id} testCase={selectedCase} workflows={workflows} onSaved={load} onRun={() => void run({ kind: "case", id: selectedCase.id })} />
          ) : (
            <RunList runs={scopeRuns} dateTime={dateTime} />
          )}
        </section>
      </div>
      {menu && (
        <ul className="context-menu" style={{ top: menu.y, left: menu.x }} onClick={(e) => e.stopPropagation()} role="menu">
          {menu.target.kind !== "case" && (
            <>
              <MenuItem label={menu.target.kind === "root" ? t("tests.newFolder") : t("tests.newSubfolder")} onClick={() => { setMenu(undefined); void newFolder(folderIdOf(menu.target)); }} />
              <MenuItem label={t("tests.newCase")} onClick={() => { setMenu(undefined); void newCase(folderIdOf(menu.target)); }} />
              <li className="separator" />
            </>
          )}
          {menu.target.kind === "case" && !cases.find((c) => c.id === (menu.target as { id: string }).id)?.workflowId && (
            <MenuItem label={t("tests.open")} onClick={() => { setMenu(undefined); onOpen((menu.target as { id: string }).id); }} />
          )}
          <MenuItem
            label={menu.target.kind === "root" ? t("tests.runAll") : menu.target.kind === "folder" ? t("tests.runFolder") : t("tests.run")}
            onClick={() => { setMenu(undefined); void run(menu.target); }}
          />
          {menu.target.kind !== "root" && (
            <>
              <MenuItem label={t("tests.renameItem")} onClick={() => { setMenu(undefined); void rename(menu.target); }} />
              <li className="separator" />
              <MenuItem label={t("common.delete")} danger onClick={() => { setMenu(undefined); void remove(menu.target); }} />
            </>
          )}
        </ul>
      )}
    </div>
  );
}

function pathOf(folders: Folder[], id: string): string {
  const names: string[] = [];
  for (let current: string | undefined = id, guard = 0; current && guard < 100; guard++) {
    const f = folders.find((x) => x.id === current);
    if (!f) break;
    names.unshift(f.name);
    current = f.parentId;
  }
  return names.join(" / ");
}

/** A test case with its own steps: its last result, and Open (in the editor) / Run. */
function CaseSummary({ testCase, onOpen, onRun, onChanged }: { testCase: TestCase; onOpen: () => void; onRun: () => void; onChanged: () => void }) {
  const { t, dateTime } = useI18n();
  const [editData, setEditData] = useState(false);
  return (
    <div className="case-editor">
      <div className="case-head">
        <h2>{testCase.name}</h2>
        <span className="spacer" />
        <button className="btn-ghost" onClick={onOpen}>
          {t("tests.open")}
        </button>
        <button className="btn" onClick={onRun}>
          ▷ {t("tests.run")}
        </button>
      </div>
      <p className="muted">{t("tests.stepCount", { count: testCase.steps ?? 0 })}</p>
      {testCase.last ? (
        <p className={`case-last status-${testCase.last.status}`}>
          {STATUS_ICON[testCase.last.status]} {t(`tests.status.${testCase.last.status}` as MessageKey)} · {dateTime(testCase.last.at)}
          {testCase.last.message && <span className="muted"> · {testCase.last.message}</span>}{" "}
          <a href={jobLink(testCase.last.jobId)} target="_blank" rel="noreferrer">
            {t("tests.viewJob")}
          </a>
        </p>
      ) : (
        <p className="muted">{t("tests.neverRun")}</p>
      )}
      <h3 className="case-sub">{t("testData.title")}</h3>
      <p className="muted small">
        {testCase.dataSize?.rows ? t("testData.summary", { rows: testCase.dataSize.rows, columns: testCase.dataSize.columns }) : t("testData.none")}{" "}
        <button className="link-btn" onClick={() => setEditData(true)}>
          {testCase.dataSize ? t("testData.edit") : t("testData.add")}
        </button>
      </p>
      <p className="muted small">{t("tests.howTo")}</p>
      {editData && <TestDataModal testCaseId={testCase.id} onClose={() => setEditData(false)} onSaved={onChanged} />}
    </div>
  );
}

function MenuItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <li role="menuitem" className={danger ? "danger" : ""} onClick={onClick}>
      {label}
    </li>
  );
}

/** A test case's settings: the workflow, its inputs, expected outputs and PC. */
function CaseEditor({ testCase, workflows, onSaved, onRun }: { testCase: TestCase; workflows: WorkflowSummary[]; onSaved: () => void; onRun: () => void }) {
  const { t, dateTime } = useI18n();
  const [workflowId, setWorkflowId] = useState(testCase.workflowId);
  const [variables, setVariables] = useState<VariableDef[]>([]);
  const [inputs, setInputs] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(testCase.inputs).map(([k, v]) => [k, showValue(v)])));
  const [expected, setExpected] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(testCase.expectedOutputs ?? {}).map(([k, v]) => [k, showValue(v)])));
  const [agentId, setAgentId] = useState(testCase.targetAgentId ?? "");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api<Agent[]>("/api/agents").then(setAgents).catch(() => undefined);
  }, []);
  useEffect(() => {
    api<WorkflowDraft>(`/api/workflows/${workflowId}`)
      .then((w) => setVariables(w.definition.variables))
      .catch(() => setVariables([]));
  }, [workflowId]);

  const ins = variables.filter((v) => v.direction === "in" || v.direction === "inout");
  const outs = variables.filter((v) => v.direction === "out" || v.direction === "inout");
  const values = (entries: Record<string, string>) => Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== "").map(([k, v]) => [k, parseValue(v)]));

  const save = async () => {
    setError(undefined);
    try {
      await api(`/api/test-cases/${testCase.id}`, {
        method: "PUT",
        body: { workflowId, inputs: values(inputs), expectedOutputs: Object.keys(values(expected)).length ? values(expected) : null, targetAgentId: agentId || null },
      });
      setSaved(true);
      onSaved();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  return (
    <div className="case-editor">
      <div className="case-head">
        <h2>{testCase.name}</h2>
        <span className="spacer" />
        <button className="btn-ghost" onClick={() => void save()}>
          {t("common.save")}
        </button>
        <button className="btn" onClick={() => void save().then((ok) => ok && onRun())}>
          ▷ {t("tests.run")}
        </button>
      </div>
      {testCase.last && (
        <p className={`case-last status-${testCase.last.status}`}>
          {STATUS_ICON[testCase.last.status]} {t(`tests.status.${testCase.last.status}` as MessageKey)} · {dateTime(testCase.last.at)}
          {testCase.last.message && <span className="muted"> · {testCase.last.message}</span>}{" "}
          <a href={jobLink(testCase.last.jobId)} target="_blank" rel="noreferrer">
            {t("tests.viewJob")}
          </a>
        </p>
      )}
      <ErrorBanner error={error} />
      {saved && <p className="muted tiny">{t("tests.saved")}</p>}
      <Field label={t("tests.workflow")}>
        <select value={workflowId} onChange={(e) => setWorkflowId(e.target.value)}>
          {workflows.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
          {!workflows.some((w) => w.id === workflowId) && <option value={workflowId}>{t("tests.missingWorkflow")}</option>}
        </select>
      </Field>
      <h3 className="case-sub">{t("tests.inputs")}</h3>
      {ins.length ? (
        ins.map((v) => (
          <Field key={v.name} label={`${v.name} (${v.type})`} hint={v.description}>
            <input value={inputs[v.name] ?? ""} placeholder={showValue(v.default)} onChange={(e) => setInputs({ ...inputs, [v.name]: e.target.value })} />
          </Field>
        ))
      ) : (
        <p className="muted tiny">{t("tests.noInputs")}</p>
      )}
      <h3 className="case-sub">{t("tests.expected")}</h3>
      <p className="muted tiny">{t("tests.expectedHelp")}</p>
      {outs.length ? (
        outs.map((v) => (
          <Field key={v.name} label={`${v.name} (${v.type})`}>
            <input value={expected[v.name] ?? ""} placeholder={t("tests.anyValue")} onChange={(e) => setExpected({ ...expected, [v.name]: e.target.value })} />
          </Field>
        ))
      ) : (
        <p className="muted tiny">{t("tests.noOutputs")}</p>
      )}
      <Field label={t("tests.runOn")}>
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          <option value="">{t("tests.anyPc")}</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

function RunList({ runs, dateTime }: { runs: TestRun[]; dateTime: (d: string | number | Date) => string }) {
  const { t } = useI18n();
  if (!runs.length) return <p className="muted">{t("tests.noRuns")}</p>;
  return (
    <div className="run-list">
      <h2>{t("tests.runs")}</h2>
      {runs.map((r) => (
        <details key={r.id} className="test-run" open={r === runs[0]}>
          <summary>
            <strong>{r.name}</strong>
            <span className="run-counts">
              <span className="status-passed">✓ {r.passed}</span> <span className="status-failed">✕ {r.failed}</span>
              {r.running > 0 && <span className="status-running"> ◔ {r.running}</span>}
            </span>
            <span className="muted tiny">
              {dateTime(r.startedAt)} · {r.startedBy}
            </span>
            <a className="tiny" href={reportLink(r.id)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
              📄 {t("tests.report")}
            </a>
          </summary>
          <table>
            <tbody>
              {r.items.map((i) => (
                <tr key={i.testCaseId + (i.jobId ?? "") + (i.row ?? "")}>
                  <td className={`status-${i.status}`}>{STATUS_ICON[i.status]}</td>
                  <td>
                    {i.path && <span className="muted">{i.path} / </span>}
                    {i.name}
                    {i.row && (
                      <span className="muted">
                        {" "}
                        · {t("testData.row", { row: i.row })}
                        {i.rowLabel ? `: ${i.rowLabel}` : ""}
                      </span>
                    )}
                    {i.message && <div className="muted tiny">{i.message}</div>}
                  </td>
                  <td>{t(`tests.status.${i.status}` as MessageKey)}</td>
                  <td>
                    {i.jobId && (
                      <a href={jobLink(i.jobId)} target="_blank" rel="noreferrer">
                        {t("tests.viewJob")}
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ))}
    </div>
  );
}
