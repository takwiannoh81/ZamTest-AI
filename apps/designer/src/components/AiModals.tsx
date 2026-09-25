import { useI18n } from "@zamtest/i18n/react";
import type { MessageKey } from "@zamtest/i18n";
import { useEffect, useRef, useState } from "react";
import { safeParseWorkflow } from "@zamtest/core";
import type { Workflow } from "@zamtest/core";
import { api } from "../api";
import { ErrorBanner, Field, Modal } from "./ui";

const EXAMPLES: MessageKey[] = ["ai.example1", "ai.example2", "ai.example3"];

/** Builds or changes the workflow with AI; `initialPrompt` + `autoStart` open it already working (Fix with AI). */
export function AiGenerateModal({
  current,
  onApply,
  onClose,
  initialPrompt,
  autoStart,
}: {
  current: Workflow;
  onApply: (w: Workflow) => void;
  onClose: () => void;
  initialPrompt?: string;
  autoStart?: boolean;
}) {
  const { t, locale } = useI18n();
  const hasSteps = (current.root.slots?.body ?? []).length > 0;
  const [prompt, setPrompt] = useState(initialPrompt ?? "");
  const [mode, setMode] = useState<"new" | "edit">(hasSteps || initialPrompt ? "edit" : "new");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<{ workflow: Workflow; notes: string }>();
  /** An application on the person's PC that AI builds the steps from (an inspect's id). */
  const [inspectId, setInspectId] = useState<string>();

  const generate = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const res = await api<{ workflow: Workflow; notes: string }>("/api/ai/generate-workflow", {
        method: "POST",
        body: { prompt, existing: mode === "edit" ? current : undefined, language: locale, inspectId },
      });
      setResult(res);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const started = useRef(false);
  useEffect(() => {
    if (autoStart && !started.current) {
      started.current = true;
      void generate();
    }
  }); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Modal
      title={t("ai.title")}
      onClose={onClose}
      footer={
        result ? (
          <>
            <button className="btn-ghost" onClick={() => setResult(undefined)}>
              {t("common.back")}
            </button>
            <button className="btn" onClick={() => onApply({ ...result.workflow, id: current.id })}>
              {t("ai.apply")}
            </button>
          </>
        ) : (
          <>
            <button className="btn-ghost" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button className="btn" disabled={busy || prompt.trim().length < 3} onClick={() => void generate()}>
              {busy ? t("ai.designing") : t("ai.generate")}
            </button>
          </>
        )
      }
    >
      <ErrorBanner error={error} />
      {result ? (
        <>
          <p>
            <strong>{result.workflow.name}</strong> - {t("ai.variableCount", { count: result.workflow.variables.length })}
          </p>
          <pre className="notes">{result.notes || t("ai.noNotes")}</pre>
          <p className="muted tiny">{t("ai.replaceWarning")}</p>
        </>
      ) : (
        <>
          {hasSteps && (
            <div className="segmented">
              <button className={mode === "edit" ? "on" : ""} onClick={() => setMode("edit")}>
                {t("ai.modify")}
              </button>
              <button className={mode === "new" ? "on" : ""} onClick={() => setMode("new")}>
                {t("ai.scratch")}
              </button>
            </div>
          )}
          <Field label={mode === "edit" ? t("ai.whatChange") : t("ai.describe")}>
            <textarea rows={6} value={prompt} autoFocus onChange={(e) => setPrompt(e.target.value)} />
          </Field>
          {!initialPrompt && <AppLook onReady={setInspectId} />}
          {!prompt && (
            <div className="examples">
              <span className="muted tiny">{t("ai.try")}</span>
              {EXAMPLES.map((key) => (
                <button key={key} className="example" onClick={() => setPrompt(t(key))}>
                  {t(key)}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

interface LookPc {
  id: string;
  name: string;
  canIndicate?: boolean;
  canInspect?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits for a request to a PC (indicate, inspect) to end; its final state. */
async function settle<T extends { status: string }>(id: string, limitMs: number, alive: () => boolean): Promise<T | undefined> {
  for (let waited = 0; waited < limitMs && alive(); waited += 700) {
    await sleep(700);
    const r = await api<T>(`/api/recordings/${id}`).catch(() => undefined);
    if (r && ["done", "failed", "cancelled"].includes(r.status)) return r;
  }
  return undefined;
}

/**
 * "Use an application on my PC": the person indicates the application, the PC's
 * agent sends its window's controls (and the screen), and AI builds real selectors.
 */
function AppLook({ onReady }: { onReady: (inspectId: string | undefined) => void }) {
  const { t } = useI18n();
  const [pcs, setPcs] = useState<LookPc[]>([]);
  const [pcId, setPcId] = useState("");
  const [state, setState] = useState<{ step: "idle" | "indicating" | "looking" | "ready" | "notFound"; app?: string; count?: number }>({ step: "idle" });
  const [error, setError] = useState<string>();
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    api<LookPc[]>("/api/recordings/agents")
      .then((list) => {
        setPcs(list);
        setPcId((list.find((p) => p.canInspect) ?? list[0])?.id ?? "");
      })
      .catch(() => undefined);
    return () => {
      alive.current = false;
    };
  }, []);

  const pc = pcs.find((p) => p.id === pcId);
  const look = async () => {
    setError(undefined);
    onReady(undefined);
    try {
      setState({ step: "indicating" });
      const pick = await api<{ id: string }>("/api/recordings", { method: "POST", body: { agentId: pcId, kind: "indicate", hint: t("record.indicateScreen") } });
      const picked = await settle<{ status: string; error?: string; picked?: { process: string; title: string } }>(pick.id, 75_000, () => alive.current);
      if (!picked?.picked) {
        setState({ step: "idle" });
        if (picked?.error) setError(picked.error);
        return;
      }
      const app = picked.picked.title || picked.picked.process;
      setState({ step: "looking", app });
      const look = await api<{ id: string }>("/api/recordings", {
        method: "POST",
        body: { agentId: pcId, kind: "inspect", selector: `window[process="${picked.picked.process}"]` },
      });
      const seen = await settle<{ status: string; inspected?: { found: boolean; tree: string } }>(look.id, 45_000, () => alive.current);
      if (!seen?.inspected?.found) {
        setState({ step: "notFound", app });
        return;
      }
      setState({ step: "ready", app, count: seen.inspected.tree.split("\n").length });
      onReady(look.id);
    } catch (e) {
      setState({ step: "idle" });
      setError((e as Error).message);
    }
  };

  if (!pcs.length) return null;
  const working = state.step === "indicating" || state.step === "looking";
  return (
    <details className="app-look" open={state.step !== "idle"}>
      <summary>{t("ailook.title")}</summary>
      <p className="muted tiny">{t("ailook.hint")}</p>
      <ErrorBanner error={error} />
      <div className="indicate-row">
        <select value={pcId} disabled={working} onChange={(e) => setPcId(e.target.value)}>
          {pcs.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button type="button" className="btn-ghost indicate-btn" disabled={!pc?.canInspect || working} onClick={() => void look()}>
          ◎ {t("record.indicate")}
        </button>
      </div>
      {pc && !pc.canInspect && <p className="muted tiny">{t("ailook.tooOld")}</p>}
      {state.step === "indicating" && <p className="indicate-status">{t("record.indicating", { pc: pc?.name ?? "" })}</p>}
      {state.step === "looking" && <p className="indicate-status">{t("ailook.looking", { app: state.app ?? "" })}</p>}
      {state.step === "ready" && <p className="ok-text tiny">✓ {t("ailook.ready", { app: state.app ?? "", pc: pc?.name ?? "", count: state.count ?? 0 })}</p>}
      {state.step === "notFound" && <p className="error-text tiny">{t("ailook.notFound", { app: state.app ?? "", pc: pc?.name ?? "" })}</p>}
    </details>
  );
}

interface Candidate {
  selector: string;
  strategy: string;
  confidence: number;
  reason: string;
}

export function SelectorAssistModal({
  description,
  currentSelector,
  onPick,
  onClose,
}: {
  description?: string;
  currentSelector?: string;
  onPick: (selector: string, description: string) => void;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const [html, setHtml] = useState("");
  const [desc, setDesc] = useState(description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [candidates, setCandidates] = useState<Candidate[]>();

  const suggest = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const res = await api<{ candidates: Candidate[] }>("/api/ai/suggest-selectors", {
        method: "POST",
        body: { html, description: desc, currentSelector: currentSelector || undefined, language: locale },
      });
      setCandidates(res.candidates);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("selector.title")}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            {t("common.close")}
          </button>
          <button className="btn" disabled={busy || !html.trim() || !desc.trim()} onClick={() => void suggest()}>
            {busy ? t("selector.analysing") : t("selector.suggest")}
          </button>
        </>
      }
    >
      <ErrorBanner error={error} />
      <Field label={t("selector.which")} hint={t("selector.whichHint")}>
        <input value={desc} onChange={(e) => setDesc(e.target.value)} />
      </Field>
      <Field label={t("selector.html")} hint={t("selector.htmlHint")}>
        <textarea className="mono" rows={7} value={html} onChange={(e) => setHtml(e.target.value)} />
      </Field>
      {candidates && (
        <div className="candidates">
          {candidates.length === 0 && <p className="muted">{t("selector.none")}</p>}
          {candidates.map((c) => (
            <div className="candidate" key={c.selector}>
              <div>
                <code>{c.selector}</code>
                <div className="muted tiny">
                  {c.strategy} · {Math.round(c.confidence * 100)}% · {c.reason}
                </div>
              </div>
              <button className="btn small" onClick={() => onPick(c.selector, desc)}>
                {t("selector.use")}
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

export function JsonModal({ workflow, onApply, onClose }: { workflow: Workflow; onApply: (w: Workflow) => void; onClose: () => void }) {
  const { t } = useI18n();
  const [text, setText] = useState(JSON.stringify(workflow, null, 2));
  const [error, setError] = useState<string>();

  const apply = () => {
    try {
      const parsed = safeParseWorkflow(JSON.parse(text));
      if (!parsed.success) {
        setError(parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"));
        return;
      }
      onApply({ ...parsed.data, id: workflow.id });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal
      title={t("json.title")}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={() => void navigator.clipboard?.writeText(text)}>
            {t("common.copy")}
          </button>
          <button className="btn" onClick={apply}>
            {t("common.apply")}
          </button>
        </>
      }
    >
      <ErrorBanner error={error} />
      <textarea className="mono json-editor" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
    </Modal>
  );
}
