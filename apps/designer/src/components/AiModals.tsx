import { useI18n } from "@zamtest/i18n/react";
import type { MessageKey } from "@zamtest/i18n";
import { useState } from "react";
import { safeParseWorkflow } from "@zamtest/core";
import type { Workflow } from "@zamtest/core";
import { api } from "../api";
import { ErrorBanner, Field, Modal } from "./ui";

const EXAMPLES: MessageKey[] = ["ai.example1", "ai.example2", "ai.example3"];

export function AiGenerateModal({ current, onApply, onClose }: { current: Workflow; onApply: (w: Workflow) => void; onClose: () => void }) {
  const { t, locale } = useI18n();
  const hasSteps = (current.root.slots?.body ?? []).length > 0;
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<"new" | "edit">(hasSteps ? "edit" : "new");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<{ workflow: Workflow; notes: string }>();

  const generate = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const res = await api<{ workflow: Workflow; notes: string }>("/api/ai/generate-workflow", {
        method: "POST",
        body: { prompt, existing: mode === "edit" ? current : undefined, language: locale },
      });
      setResult(res);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

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
