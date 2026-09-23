import { useState } from "react";
import { getToken, setToken } from "../api";
import { usePoll } from "../hooks";
import { Field, PageHeader } from "../ui";

export function Settings() {
  const [token, setLocal] = useState(getToken());
  const [saved, setSaved] = useState(false);
  const ai = usePoll<{ configured: boolean; model: string | null }>("/api/ai/status", 0);

  return (
    <>
      <PageHeader title="Settings" />
      <section className="card">
        <h2>API access</h2>
        <p className="muted">If the orchestrator runs with ZAMTEST_ADMIN_TOKEN, paste the token here. It is stored in this browser only.</p>
        <Field label="Admin token">
          <input type="password" value={token} onChange={(e) => setLocal(e.target.value)} />
        </Field>
        <button
          className="btn"
          onClick={() => {
            setToken(token);
            setSaved(true);
          }}
        >
          Save
        </button>
        {saved && <span className="muted"> Saved.</span>}
      </section>
      <section className="card">
        <h2>AI</h2>
        {ai.data?.configured ? (
          <p>
            AI is enabled on the orchestrator (model <code>{ai.data.model}</code>).
          </p>
        ) : (
          <p className="muted">AI is not configured. Set ANTHROPIC_API_KEY for the orchestrator (Designer AI) and for each bot agent (self-healing, AI actions).</p>
        )}
      </section>
    </>
  );
}
