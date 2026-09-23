import { useCallback, useEffect, useMemo, useState } from "react";
import type { ActionMeta, Step, Workflow } from "@zamtest/core";
import { LanguageSelect, useI18n } from "@zamtest/i18n/react";
import { api } from "./api";
import type { Job, WorkflowDraft, WorkflowSummary } from "./api";
import { AiGenerateModal, JsonModal, SelectorAssistModal } from "./components/AiModals";
import { Canvas } from "./components/Canvas";
import { Palette } from "./components/Palette";
import { Properties, WorkflowSettings } from "./components/Properties";
import { RunPanel } from "./components/RunPanel";
import type { RunState } from "./components/RunPanel";
import { cloneWithNewIds, createStep, findStep, insertStep, locate, mapStep, moveStep, removeStep } from "./tree";
import type { Location } from "./tree";
import { validate } from "./validate";

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
  useEffect(() => {
    api<WorkflowSummary[]>("/api/workflows").then(setList).catch(() => setList([]));
  }, []);

  const create = async () => {
    const wf = await api<WorkflowDraft>("/api/workflows", { method: "POST", body: { name: t("designer.defaultWorkflowName") } });
    onOpen(wf.id);
  };

  const importFile = async (file: File) => {
    try {
      const definition = JSON.parse(await file.text()) as Workflow;
      const wf = await api<WorkflowDraft>("/api/workflows", { method: "POST", body: { definition } });
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
          {t("designer.importJson")}
          <input type="file" accept=".json" hidden onChange={(e) => e.target.files?.[0] && void importFile(e.target.files[0])} />
        </label>
        <a className="btn-ghost" href={PORTAL_URL} target="_blank" rel="noreferrer">
          {t("designer.openPortal")}
        </a>
        <LanguageSelect className="lang-select" />
      </div>
      <h2 className="section-title">{t("designer.workflows")}</h2>
      {list?.length ? (
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
  const [modal, setModal] = useState<null | "ai" | "json" | { selectorProp: string }>(null);
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
      setStatus(t("toolbar.saved", { time: new Date().toLocaleTimeString(i18n.locale) }));
      return true;
    } catch (e) {
      setStatus(t("toolbar.saveFailed", { error: (e as Error).message }));
      return false;
    }
  }, [id, workflow, t, i18n.locale]);

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
      setStatus(t("toolbar.published", { version: pkg.version }));
    } catch (e) {
      setStatus(t("toolbar.publishFailed", { error: (e as Error).message }));
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

  const download = () => {
    const blob = new Blob([JSON.stringify(workflow, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${workflow.name.replace(/[^\w-]+/g, "-").toLowerCase() || "workflow"}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const selectorModal = modal && typeof modal === "object" ? modal : undefined;

  return (
    <div className="designer">
      <header className="toolbar">
        <button className="icon-btn" title={t("toolbar.allWorkflows")} onClick={() => (!dirty || confirm(t("toolbar.discard"))) && onExit()}>
          ←
        </button>
        <span className="logo small">Z</span>
        <input className="wf-name" value={workflow.name} onChange={(e) => update({ ...workflow, name: e.target.value })} />
        {dirty && <span className="dirty" title={t("toolbar.unsaved")}>●</span>}
        <span className="muted tiny status">{status}</span>
        <span className="spacer" />
        <button className="btn-ghost" disabled={!history.past.length} onClick={undo} title={t("toolbar.undo")}>
          ↶
        </button>
        <button className="btn-ghost" disabled={!history.future.length} onClick={redo} title={t("toolbar.redo")}>
          ↷
        </button>
        <button className={`btn-ghost${issues.length ? " warn" : ""}`} onClick={() => setShowIssues(!showIssues)}>
          {issues.length ? t("toolbar.issues", { count: issues.length }) : t("toolbar.valid")}
        </button>
        <button className="btn-ghost" onClick={() => setModal("json")}>
          {"{ }"} JSON
        </button>
        <button className="btn-ghost" onClick={download}>
          {t("toolbar.export")}
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
        <button className="btn" onClick={() => void publish()}>
          {t("toolbar.publish")}
        </button>
        <LanguageSelect className="lang-select" />
      </header>
      {showIssues && issues.length > 0 && (
        <div className="issues">
          {issues.map((i, n) => (
            <button key={n} className="issue" onClick={() => setSelectedId(i.stepId)}>
              ⚠ {i.message}
            </button>
          ))}
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
