import { useState } from "react";
import { safeParseWorkflow } from "@zamtest/core";
import type { Workflow } from "@zamtest/core";
import { api } from "../api";
import { ErrorBanner, Field, Modal } from "./ui";

const EXAMPLES = [
  "Every morning, log into our ERP web portal with the 'erp' credential asset, download today's open invoices table, and post a summary to our Slack webhook.",
  "Read orders.json, and for each order with status 'new' call POST https://api.example.com/fulfil with the order id. Log failures but keep going.",
  "Open https://news.ycombinator.com, read the titles of the top 5 stories and have AI write a one-paragraph digest.",
];

export function AiGenerateModal({ current, onApply, onClose }: { current: Workflow; onApply: (w: Workflow) => void; onClose: () => void }) {
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
        body: { prompt, existing: mode === "edit" ? current : undefined },
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
      title="✨ Build with AI"
      onClose={onClose}
      footer={
        result ? (
          <>
            <button className="btn-ghost" onClick={() => setResult(undefined)}>
              Back
            </button>
            <button className="btn" onClick={() => onApply({ ...result.workflow, id: current.id })}>
              Apply to canvas
            </button>
          </>
        ) : (
          <>
            <button className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn" disabled={busy || prompt.trim().length < 3} onClick={() => void generate()}>
              {busy ? "Designing..." : "Generate"}
            </button>
          </>
        )
      }
    >
      <ErrorBanner error={error} />
      {result ? (
        <>
          <p>
            <strong>{result.workflow.name}</strong> - {result.workflow.variables.length} variables
          </p>
          <pre className="notes">{result.notes || "No notes."}</pre>
          <p className="muted tiny">Applying replaces the current canvas. You can undo with Ctrl+Z.</p>
        </>
      ) : (
        <>
          {hasSteps && (
            <div className="segmented">
              <button className={mode === "edit" ? "on" : ""} onClick={() => setMode("edit")}>
                Modify current workflow
              </button>
              <button className={mode === "new" ? "on" : ""} onClick={() => setMode("new")}>
                Start from scratch
              </button>
            </div>
          )}
          <Field label={mode === "edit" ? "What should change?" : "Describe the process to automate"}>
            <textarea rows={6} value={prompt} autoFocus onChange={(e) => setPrompt(e.target.value)} />
          </Field>
          {!prompt && (
            <div className="examples">
              <span className="muted tiny">Try:</span>
              {EXAMPLES.map((ex) => (
                <button key={ex} className="example" onClick={() => setPrompt(ex)}>
                  {ex}
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
        body: { html, description: desc, currentSelector: currentSelector || undefined },
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
      title="✨ AI selector assistant"
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Close
          </button>
          <button className="btn" disabled={busy || !html.trim() || !desc.trim()} onClick={() => void suggest()}>
            {busy ? "Analysing..." : "Suggest selectors"}
          </button>
        </>
      }
    >
      <ErrorBanner error={error} />
      <Field label="Which element?" hint="Plain language, e.g. 'the Submit button under the shipping form'. Saved as the step's target description for run-time self-healing.">
        <input value={desc} onChange={(e) => setDesc(e.target.value)} />
      </Field>
      <Field label="Page HTML" hint="In the browser: right-click the page → Inspect → right-click <html> → Copy → Copy outerHTML, then paste here.">
        <textarea className="mono" rows={7} value={html} onChange={(e) => setHtml(e.target.value)} />
      </Field>
      {candidates && (
        <div className="candidates">
          {candidates.length === 0 && <p className="muted">No matching element found.</p>}
          {candidates.map((c) => (
            <div className="candidate" key={c.selector}>
              <div>
                <code>{c.selector}</code>
                <div className="muted tiny">
                  {c.strategy} · {Math.round(c.confidence * 100)}% · {c.reason}
                </div>
              </div>
              <button className="btn small" onClick={() => onPick(c.selector, desc)}>
                Use
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

export function JsonModal({ workflow, onApply, onClose }: { workflow: Workflow; onApply: (w: Workflow) => void; onClose: () => void }) {
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
      title="Workflow JSON"
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={() => void navigator.clipboard?.writeText(text)}>
            Copy
          </button>
          <button className="btn" onClick={apply}>
            Apply
          </button>
        </>
      }
    >
      <ErrorBanner error={error} />
      <textarea className="mono json-editor" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
    </Modal>
  );
}
