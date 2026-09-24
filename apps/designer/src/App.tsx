import { useCallback, useEffect, useMemo, useState } from "react";
import type { ActionMeta, Step, Workflow } from "@zamtest/core";
import { LanguageSelect, ThemeSelect, useI18n } from "@zamtest/i18n/react";
import { api } from "./api";
import type { Job, WorkflowDraft, WorkflowSummary } from "./api";
import { AiGenerateModal, JsonModal, SelectorAssistModal } from "./components/AiModals";
import { GitHistoryModal } from "./components/GitHistory";
import { TestCases } from "./components/TestCases";
import { Canvas } from "./components/Canvas";
import { Palette } from "./components/Palette";
import { Properties, WorkflowSettings } from "./components/Properties";
import { RunPanel } from "./components/RunPanel";
import type { RunState } from "./components/RunPanel";
import { cloneWithNewIds, createStep, findStep, insertStep, locate, mapStep, moveStep, removeStep } from "./tree";
import type { Location } from "./tree";
import { validate } from "./validate";
import type { Issue } from "./validate";
import { fileSlug, isProjectFile, saveJson } from "./files";
import { signOut, useMe } from "./components/session";
import type { MessageKey } from "@zamtest/i18n";

function UserMenu() {
  const { t } = useI18n();
  const me = useMe();
  if (!me || me.kind === "open") return null;
  return (
    <span className="user-inline">
      <span className="muted">
        {me.kind === "token" ? t("role.token") : t("auth.signedInAs", { name: me.name })} · {t(`role.${me.role}` as MessageKey)}
      </span>
      <button className="link-btn" onClick={() => void signOut()}>
        {t("auth.signOut")}
      </button>
    </span>
  );
}

const PORTAL_URL = import.meta.env.VITE_PORTAL_URL ?? "http://localhost:5173";

function useHashId(): [string | undefined, (id?: string) => void] {
  const read = () => /^#\/wf\/(.+)$/.exec(window.location.hash)?.[1];
  const [id, setId] = useState(read);
  useEffect(() => {
    const on = () => setId(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [id, (next) => (window.location.hash = next ? `/wf/${next}` : "/")];
}

export function App() {
  const { t } = useI18n();
  const [catalog, setCatalog] = useState<ActionMeta[]>([]);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [error, setError] = useState<string>();
  const [workflowId, openWorkflow] = useHashId();

  useEffect(() => {
    api<ActionMeta[]>("/api/actions").then(setCatalog).catch((e: Error) => setError(t("designer.cannotReach", { error: e.message })));
    api<{ configured: boolean }>("/api/ai/status").then((s) => setAiEnabled(s.configured)).catch(() => undefined);
  }, [t]);

  if (error) {
    return (
      <div className="start">
        <div className="error-banner">{error}</div>
        <p className="muted">{t("designer.startIt", { command: "pnpm dev:orchestrator" })}</p>
      </div>
    );
  }
  if (!workflowId) return <StartScreen onOpen={openWorkflow} />;
  return <Editor key={workflowId} id={workflowId} catalog={catalog} aiEnabled={aiEnabled} onExit={() => openWorkflow(undefined)} />;
}

function StartScreen({ onOpen }: { onOpen: (id: string) => void }) {
  const { t, dateTime } = useI18n();
  const [list, setList] = useState<WorkflowSummary[]>();
  const [tab, setTab] = useState<"workflows" | "tests">(() => (window.location.hash === "#/tests" ? "tests" : "workflows"));
  const [notice, setNotice] = useState<string>();
  const loadList = useCallback(() => {
    api<WorkflowSummary[]>("/api/workflows").then(setList).catch(() => setList([]));
  }, []);
  useEffect(() => loadList(), [loadList]);
  const showTab = (next: "workflows" | "tests") => {
    setTab(next);
    window.history.replaceState(null, "", next === "tests" ? "#/tests" : "#/");
  };

  /** Everything (workflows, test folders and test cases) as one file on this PC. */
  const exportProject = async () => {
    try {
      const project = await api<unknown>("/api/project/export");
      if (await saveJson(`zamtech-ai-project-${new Date().toISOString().slice(0, 10)}.json`, project, t("files.projectKind"))) setNotice(t("files.savedToPc"));
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const create = async () => {
    try {
      const wf = await api<WorkflowDraft>("/api/workflows", { method: "POST", body: { name: t("designer.defaultWorkflowName") } });
      onOpen(wf.id);
    } catch {
      /* permission and connection errors are shown by the app shell */
    }
  };

  /** A workflow file opens in the editor; a project file adds all its workflows and test cases. */
  const importFile = async (file: File) => {
    try {
      const data = JSON.parse(await file.text()) as unknown;
      if (isProjectFile(data)) {
        const r = await api<{ workflows: number; testCases: number }>("/api/project/import", { method: "POST", body: data });
        setNotice(t("files.projectImported", { workflows: r.workflows, tests: r.testCases }));
        loadList();
        return;
      }
      const wf = await api<WorkflowDraft>("/api/workflows", { method: "POST", body: { definition: data as Workflow } });
      onOpen(wf.id);
    } catch (e) {
      alert(t("designer.importFailed", { error: (e as Error).message }));
    }
  };

  const remove = async (w: WorkflowSummary) => {
    if (!confirm(t("designer.confirmDeleteWorkflow", { name: w.name }))) return;
    await api(`/api/workflows/${w.id}`, { method: "DELETE" });
    setList((l) => l?.filter((x) => x.id !== w.id));
  };

  return (
    <div className="start">
      <div className="start-head">
        <span className="logo">Z</span>
        <div>
          <h1>{t("designer.title")}</h1>
          <p className="muted">{t("designer.tagline")}</p>
        </div>
      </div>
      <div className="actions">
        <button className="btn" onClick={() => void create()}>
          {t("designer.newWorkflow")}
        </button>
        <label className="btn-ghost">
          {t("files.import")}
          <input
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void importFile(file);
            }}
          />
        </label>
        <button className="btn-ghost" onClick={() => void exportProject()} title={t("files.exportProjectHint")}>
          {t("files.exportProject")}
        </button>
        <a className="btn-ghost" href={PORTAL_URL} target="_blank" rel="noreferrer">
          {t("designer.openPortal")}
        </a>
        <LanguageSelect className="lang-select" />
        <ThemeSelect className="lang-select" />
        <UserMenu />
      </div>
      {notice && <p className="notice">{notice}</p>}
      <div className="segmented start-tabs" role="tablist">
        <button role="tab" className={tab === "workflows" ? "on" : ""} onClick={() => showTab("workflows")}>
          {t("designer.workflows")}
        </button>
        <button role="tab" className={tab === "tests" ? "on" : ""} onClick={() => showTab("tests")}>
          {t("tests.title")}
        </button>
      </div>
      {tab === "tests" ? (
        <TestCases workflows={list ?? []} />
      ) : list?.length ? (
        <div className="wf-grid">
          {list.map((w) => (
            <div key={w.id} className="wf-card" onClick={() => onOpen(w.id)}>
              <strong>{w.name}</strong>
              <span className="muted">{w.description || t("designer.stepCount", { count: w.steps })}</span>
              <small className="muted">{t("designer.updatedAt", { time: dateTime(w.updatedAt) })}</small>
              <button className="icon-btn" title={t("common.delete")} onClick={(e) => { e.stopPropagation(); void remove(w); }}>
                🗑
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty">{list ? t("designer.noWorkflows") : t("common.loading")}</div>
      )}
    </div>
  );
}

function Editor({ id, catalog, aiEnabled, onExit }: { id: string; catalog: ActionMeta[]; aiEnabled: boolean; onExit: () => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const metas = useMemo(() => new Map(catalog.map((m) => [m.type, m])), [catalog]);
  const [workflow, setWorkflow] = useState<Workflow>();
  const [history, setHistory] = useState<{ past: Workflow[]; future: Workflow[] }>({ past: [], future: [] });
  const [dirty, setDirty] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [modal, setModal] = useState<null | "ai" | "json" | "history" | { selectorProp: string }>(null);
  // Fix with AI: the request prepared for the AI dialog (issues, or a failed run's error).
  const [fixPrompt, setFixPrompt] = useState<string>();
  // Source control: whether the workspace has a Git repository, and uses Development/Test/Production.
  const [gitConnected, setGitConnected] = useState(false);
  const [envsOn, setEnvsOn] = useState(false);
  useEffect(() => {
    api<{ connected: boolean }>("/api/git/settings").then((g) => setGitConnected(g.connected)).catch(() => undefined);
    api<{ enabled: boolean }>("/api/environments").then((e) => setEnvsOn(e.enabled)).catch(() => undefined);
  }, []);
  const [run, setRun] = useState<RunState>();
  const [runStatus, setRunStatus] = useState<Record<string, "running" | "ok" | "error">>({});
  const [showIssues, setShowIssues] = useState(false);

  useEffect(() => {
    api<WorkflowDraft>(`/api/workflows/${id}`)
      .then((d) => setWorkflow(d.definition))
      .catch((e: Error) => setStatus(e.message));
  }, [id]);

  const update = (next: Workflow) => {
    if (workflow) setHistory((h) => ({ past: [...h.past.slice(-99), workflow], future: [] }));
    setWorkflow(next);
    setDirty(true);
  };

  const undo = () => {
    const prev = history.past.at(-1);
    if (!prev || !workflow) return;
    setHistory({ past: history.past.slice(0, -1), future: [workflow, ...history.future] });
    setWorkflow(prev);
    setDirty(true);
  };

  const redo = () => {
    const next = history.future[0];
    if (!next || !workflow) return;
    setHistory({ past: [...history.past, workflow], future: history.future.slice(1) });
    setWorkflow(next);
    setDirty(true);
  };

  const save = useCallback(async () => {
    if (!workflow) return false;
    try {
      await api(`/api/workflows/${id}`, { method: "PUT", body: { name: workflow.name, description: workflow.description ?? "", definition: workflow } });
      setDirty(false);
      setStatus(t("toolbar.saved", { time: i18n.time(Date.now()) }));
      return true;
    } catch (e) {
      setStatus(t("toolbar.saveFailed", { error: (e as Error).message }));
      return false;
    }
  }, [id, workflow, t, i18n]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (mod && e.key === "s") {
        e.preventDefault();
        void save();
      } else if (mod && e.key === "z" && !typing) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key === "y" && !typing) {
        e.preventDefault();
        redo();
      } else if ((e.key === "Delete" || e.key === "Backspace") && !typing && selectedId && workflow && selectedId !== workflow.root.id) {
        update({ ...workflow, root: removeStep(workflow.root, selectedId) });
        setSelectedId(undefined);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, undo, redo, selectedId, workflow, update]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  if (!workflow) return <div className="start">{status ?? t("common.loading")}</div>;

  const root = workflow.root;
  const selected = selectedId ? findStep(root, selectedId) : undefined;
  const issues = validate(workflow, metas, i18n);
  const setRoot = (r: Step) => update({ ...workflow, root: r });

  /** Where a new step goes: after the selected step, inside an empty selected container, or at the end. */
  const insertionPoint = (): Location => {
    if (selected && selected.id !== root.id) {
      const meta = metas.get(selected.type);
      if (meta?.slots?.length) return { parentId: selected.id, slot: meta.slots[0]!, index: selected.slots?.[meta.slots[0]!]?.length ?? 0 };
      const loc = locate(root, selected.id);
      if (loc) return { ...loc, index: loc.index + 1 };
    }
    return { parentId: root.id, slot: "body", index: root.slots?.body?.length ?? 0 };
  };

  const addStep = (meta: ActionMeta, loc: Location = insertionPoint()) => {
    const step = createStep(meta);
    setRoot(insertStep(root, loc, step));
    setSelectedId(step.id);
  };

  const publish = async () => {
    if (issues.length && !confirm(t("toolbar.publishConfirm", { count: issues.length }))) return;
    if (!(await save())) return;
    const releaseNotes = prompt(t("toolbar.releaseNotes")) ?? undefined;
    try {
      const pkg = await api<{ version: number }>(`/api/workflows/${id}/publish`, { method: "POST", body: { releaseNotes } });
      setStatus(envsOn ? t("toolbar.publishedDev", { version: pkg.version }) : t("toolbar.published", { version: pkg.version }));
    } catch (e) {
      setStatus(t("toolbar.publishFailed", { error: (e as Error).message }));
    }
  };

  const commit = async () => {
    if (!(await save())) return;
    const message = prompt(t("git.commitMessage"), t("git.commitDefault", { name: workflow.name }));
    if (!message) return;
    try {
      const result = await api<{ commit: string | null }>(`/api/workflows/${id}/commit`, { method: "POST", body: { message } });
      setStatus(result.commit ? t("git.committed", { sha: result.commit.slice(0, 7) }) : t("git.nothingToCommit"));
    } catch (e) {
      setStatus(t("git.commitFailed", { error: (e as Error).message }));
    }
  };

  const testRun = async () => {
    await save();
    try {
      const job = await api<Job>("/api/jobs", { method: "POST", body: { definition: workflow, source: "designer" } });
      setRun({ jobId: job.id });
    } catch (e) {
      setStatus(t("toolbar.runFailed", { error: (e as Error).message }));
    }
  };

  /** Saves the workflow as a file on this PC, where the person chooses. */
  const saveToPc = async () => {
    if (await saveJson(`${fileSlug(workflow.name)}.json`, workflow, t("files.workflowKind"))) setStatus(t("files.savedToPc"));
  };

  const deleteWorkflow = async () => {
    if (!confirm(t("designer.confirmDeleteWorkflow", { name: workflow.name }))) return;
    try {
      await api(`/api/workflows/${id}`, { method: "DELETE" });
      setDirty(false);
      onExit();
    } catch (e) {
      setStatus((e as Error).message);
    }
  };

  /** Selects the step of an issue and puts the cursor in the field to fill in. */
  const goToIssue = (issue: Issue) => {
    setSelectedId(issue.stepId);
    if (!issue.prop) return;
    setTimeout(() => {
      const row = document.querySelector<HTMLElement>(`.inspector [data-prop="${CSS.escape(issue.prop!)}"]`);
      const input = row?.querySelector<HTMLElement>("input, textarea, select");
      row?.scrollIntoView({ block: "center", behavior: "smooth" });
      input?.focus();
      row?.classList.add("flash");
      setTimeout(() => row?.classList.remove("flash"), 1500);
    }, 60);
  };

  const fixIssuesWithAi = () =>
    setFixPrompt(`${t("fix.issuesPrompt")}\n${issues.map((i) => `- ${i.message} (step ${i.stepId})`).join("\n")}`);
  const fixRunWithAi = (error: string, stepId?: string) =>
    setFixPrompt(`${t("fix.runPrompt")}\n${stepId ? `Step ${stepId}: ` : ""}${error}`);

  const selectorModal = modal && typeof modal === "object" ? modal : undefined;

  return (
    <div className="designer">
      <header className="toolbar">
        <button className="icon-btn" title={t("toolbar.allWorkflows")} onClick={() => (!dirty || confirm(t("toolbar.discard"))) && onExit()}>
          <span className="flip-rtl">←</span>
        </button>
        <span className="logo small">Z</span>
        <input className="wf-name" value={workflow.name} onChange={(e) => update({ ...workflow, name: e.target.value })} />
        {dirty && <span className="dirty" title={t("toolbar.unsaved")}>●</span>}
        <span className="muted tiny status">{status}</span>
        <span className="spacer" />
        <button className="btn-ghost" disabled={!history.past.length} onClick={undo} title={t("toolbar.undo")}>
          <span className="flip-rtl">↶</span>
        </button>
        <button className="btn-ghost" disabled={!history.future.length} onClick={redo} title={t("toolbar.redo")}>
          <span className="flip-rtl">↷</span>
        </button>
        <button className={`btn-ghost${issues.length ? " warn" : ""}`} onClick={() => setShowIssues(!showIssues)}>
          {issues.length ? t("toolbar.issues", { count: issues.length }) : t("toolbar.valid")}
        </button>
        <button className="btn-ghost" onClick={() => setModal("json")}>
          {"{ }"} JSON
        </button>
        <button className="btn-ghost" onClick={() => void saveToPc()} title={t("files.saveToPcHint")}>
          {t("files.saveToPc")}
        </button>
        <button className="btn-ghost ai" disabled={!aiEnabled} title={aiEnabled ? "" : t("toolbar.aiNeedsKey")} onClick={() => setModal("ai")}>
          {t("toolbar.buildWithAi")}
        </button>
        <button className="btn-ghost" onClick={() => void save()}>
          {t("common.save")}
        </button>
        <button className="btn-ghost" onClick={() => void testRun()}>
          {t("toolbar.run")}
        </button>
        {gitConnected && (
          <>
            <button className="btn-ghost" onClick={() => setModal("history")}>
              {t("git.history")}
            </button>
            <button className="btn-ghost" onClick={() => void commit()}>
              {t("git.commit")}
            </button>
          </>
        )}
        <button className="btn" onClick={() => void publish()}>
          {t("toolbar.publish")}
        </button>
        <button className="icon-btn danger" title={t("designer.deleteWorkflow")} aria-label={t("designer.deleteWorkflow")} onClick={() => void deleteWorkflow()}>
          🗑
        </button>
        <LanguageSelect className="lang-select" />
        <ThemeSelect className="lang-select" />
      </header>
      {showIssues && issues.length > 0 && (
        <div className="issues">
          {issues.map((i, n) => (
            <button key={n} className="issue" onClick={() => goToIssue(i)} title={t("fix.goTo")}>
              ⚠ {i.message}
            </button>
          ))}
          <button className="issue issue-fix" disabled={!aiEnabled} title={aiEnabled ? t("fix.withAiHint") : t("toolbar.aiNeedsKey")} onClick={fixIssuesWithAi}>
            {t("fix.withAi")}
          </button>
        </div>
      )}
      <div className="workspace">
        <Palette catalog={catalog} onAdd={(m) => addStep(m)} />
        <main className="center">
          <Canvas
            root={root}
            metas={metas}
            selectedId={selectedId}
            runStatus={runStatus}
            onSelect={setSelectedId}
            onDropAction={(type, loc) => {
              const meta = metas.get(type);
              if (meta) addStep(meta, loc);
            }}
            onMoveStep={(stepId, loc) => setRoot(moveStep(root, stepId, loc))}
            onDelete={(stepId) => {
              setRoot(removeStep(root, stepId));
              if (selectedId === stepId) setSelectedId(undefined);
            }}
            onDuplicate={(stepId) => {
              const step = findStep(root, stepId);
              const loc = locate(root, stepId);
              if (!step || !loc) return;
              const copy = cloneWithNewIds(step);
              setRoot(insertStep(root, { ...loc, index: loc.index + 1 }, copy));
              setSelectedId(copy.id);
            }}
          />
          {run && (
            <RunPanel
              run={run}
              onClose={() => {
                setRun(undefined);
                setRunStatus({});
              }}
              onStepStatus={setRunStatus}
              onSelectStep={setSelectedId}
              onFixWithAi={aiEnabled ? fixRunWithAi : undefined}
              onApplyHealed={(stepId, selector) => {
                setRoot(mapStep(root, stepId, (s) => ({ ...s, props: { ...s.props, selector } })));
                setStatus(t("toolbar.healedApplied"));
              }}
            />
          )}
        </main>
        <aside className="inspector">
          {selected && selected.id !== root.id ? (
            <Properties
              step={selected}
              meta={metas.get(selected.type)}
              variables={workflow.variables}
              aiEnabled={aiEnabled}
              onChange={(s) => setRoot(mapStep(root, s.id, () => s))}
              onSelectorAssist={(selectorProp) => setModal({ selectorProp })}
            />
          ) : (
            <WorkflowSettings workflow={workflow} onChange={update} />
          )}
        </aside>
      </div>
      {modal === "ai" && (
        <AiGenerateModal
          current={workflow}
          onClose={() => setModal(null)}
          onApply={(w) => {
            update({ ...w, name: w.name || workflow.name });
            setSelectedId(undefined);
            setModal(null);
            setStatus(t("toolbar.aiApplied"));
          }}
        />
      )}
      {fixPrompt && (
        <AiGenerateModal
          current={workflow}
          initialPrompt={fixPrompt}
          autoStart
          onClose={() => setFixPrompt(undefined)}
          onApply={(w) => {
            update({ ...w, name: w.name || workflow.name });
            setSelectedId(undefined);
            setFixPrompt(undefined);
            setStatus(t("fix.applied"));
          }}
        />
      )}
      {modal === "history" && (
        <GitHistoryModal
          workflowId={id}
          onClose={() => setModal(null)}
          onOpen={(definition, sha) => {
            update({ ...definition, id: workflow.id });
            setSelectedId(undefined);
            setModal(null);
            setStatus(t("git.opened", { sha: sha.slice(0, 7) }));
          }}
        />
      )}
      {modal === "json" && (
        <JsonModal
          workflow={workflow}
          onClose={() => setModal(null)}
          onApply={(w) => {
            update(w);
            setModal(null);
          }}
        />
      )}
      {selectorModal && selected && (
        <SelectorAssistModal
          description={typeof selected.props.description === "string" ? selected.props.description : undefined}
          currentSelector={typeof selected.props[selectorModal.selectorProp] === "string" ? String(selected.props[selectorModal.selectorProp]) : undefined}
          onClose={() => setModal(null)}
          onPick={(selector, description) => {
            setRoot(mapStep(root, selected.id, (s) => ({ ...s, props: { ...s.props, [selectorModal.selectorProp]: selector, description } })));
            setModal(null);
          }}
        />
      )}
    </div>
  );
}
