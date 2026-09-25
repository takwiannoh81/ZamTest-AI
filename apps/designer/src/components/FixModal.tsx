import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { applyStepChanges } from "@zamtest/core";
import type { Step, StepChange, VariableDef, Workflow } from "@zamtest/core";
import type { MessageKey } from "@zamtest/i18n";
import { useI18n } from "@zamtest/i18n/react";
import { api } from "../api";
import { ErrorBanner, Modal } from "./ui";

type Env = "dev" | "test" | "prod";
type Fix =
  | { kind: "editSteps"; title: string; why: string; changes: StepChange[]; variables?: VariableDef[] }
  | { kind: "createAsset"; title: string; why: string; name: string; assetType: "text" | "number" | "boolean" | "credential"; environment?: Env; description?: string }
  | { kind: "setPcEnvironment"; title: string; why: string; environment: Env }
  | { kind: "manual"; title: string; why: string; instructions: string[] };

interface Diagnosis {
  summary: string;
  cause: string;
  details: string;
  fixes: Fix[];
}

interface FailedJob {
  id: string;
  status: string;
  error?: string;
  agentId?: string;
}

interface RecordingPc {
  id: string;
  name: string;
  canInspect?: boolean;
}

/** At most this many rounds of "keep fixing". */
const MAX_ROUNDS = 3;
const FINAL = ["succeeded", "failed", "cancelled"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The window part of a desktop selector: window[process="x"] > edit[...] -> window[process="x"]. */
export function windowOf(selector: string): string {
  let quote = false;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (c === '"' && selector[i - 1] !== "\\") quote = !quote;
    else if (c === ">" && !quote) return selector.slice(0, i).trim();
  }
  return selector.trim();
}

/** The application window the failed step (or else the workflow) works in. */
function windowFor(workflow: Workflow, stepId?: string): string | undefined {
  const selectors: Array<{ id: string; selector: string }> = [];
  const walk = (s: Step) => {
    if (s.type.startsWith("desktop.")) {
      const sel = s.props.selector ?? s.props.waitFor;
      if (typeof sel === "string" && sel.trim()) selectors.push({ id: s.id, selector: windowOf(sel) });
    }
    for (const list of Object.values(s.slots ?? {})) list.forEach(walk);
  };
  walk(workflow.root);
  return (selectors.find((s) => s.id === stepId) ?? selectors[0])?.selector;
}

/**
 * Fix with AI: looks at the application on the PC (when the run used one),
 * asks AI for the cause with the run's evidence, and shows fixes to apply. It
 * can run again and keep fixing (a few rounds), stopping for what needs a person.
 */
export function FixModal({
  jobId: firstJobId,
  stepId,
  workflow,
  describe,
  onApply,
  onRunAgain,
  onClose,
}: {
  jobId: string;
  stepId?: string;
  workflow: Workflow;
  describe: (step: Step) => string;
  /** Puts the fixed workflow in the editor. */
  onApply: (workflow: Workflow) => void;
  /** Saves this workflow and runs it; the new run's job id. */
  onRunAgain: (workflow: Workflow) => Promise<string | undefined>;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const [jobId, setJobId] = useState(firstJobId);
  const [phase, setPhase] = useState<"inspecting" | "thinking" | "ready" | "running" | "passed" | "failedAgain" | "gaveUp">("thinking");
  const [pcName, setPcName] = useState<string>();
  const [looked, setLooked] = useState(false);
  const [diagnosis, setDiagnosis] = useState<Diagnosis>();
  const [done, setDone] = useState<Set<number>>(new Set());
  const [round, setRound] = useState(1);
  const [auto, setAuto] = useState(false);
  const [needsYou, setNeedsYou] = useState(false);
  const [lastError, setLastError] = useState<string>();
  const [error, setError] = useState<string>();
  const current = useRef(workflow);
  /** The workflow as it was when diagnosed: changes are shown against it. */
  const baseline = useRef(workflow);
  const attempts = useRef<string[]>([]);
  const alive = useRef(true);
  const agentRef = useRef<{ id: string; name: string } | undefined>(undefined);
  const roundRef = useRef(1);
  const started = useRef(false);

  useEffect(() => {
    alive.current = true;
    // Once, even when React runs effects twice (development): a second look at the PC would be refused.
    if (!started.current) {
      started.current = true;
      void diagnose(firstJobId, stepId);
    }
    return () => {
      alive.current = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Asks the PC for the application window as it is now; the inspect's id, if it worked. */
  const inspect = async (agentId: string, selector: string): Promise<string | undefined> => {
    const pcs = await api<RecordingPc[]>("/api/recordings/agents").catch(() => [] as RecordingPc[]);
    const pc = pcs.find((p) => p.id === agentId);
    if (!pc?.canInspect) return undefined;
    setPcName(pc.name);
    setPhase("inspecting");
    const started = await api<{ id: string }>("/api/recordings", { method: "POST", body: { agentId, kind: "inspect", selector } }).catch(() => undefined);
    if (!started) return undefined;
    for (let waited = 0; waited < 30_000 && alive.current; waited += 700) {
      await sleep(700);
      const r = await api<{ status: string }>(`/api/recordings/${started.id}`).catch(() => undefined);
      if (r?.status === "done") return started.id;
      if (!r || r.status === "failed" || r.status === "cancelled") return undefined;
    }
    return undefined;
  };

  const diagnose = async (id: string, failedStep?: string) => {
    setError(undefined);
    setDiagnosis(undefined);
    setDone(new Set());
    setNeedsYou(false);
    try {
      const job = await api<FailedJob>(`/api/jobs/${id}`);
      let inspectId: string | undefined;
      const selector = windowFor(current.current, failedStep);
      if (job.agentId) {
        const agents = await api<Array<{ id: string; name: string }>>("/api/agents").catch(() => []);
        const agent = agents.find((a) => a.id === job.agentId);
        if (agent) agentRef.current = agent;
        if (selector) inspectId = await inspect(job.agentId, selector);
      }
      setLooked(Boolean(inspectId));
      if (!alive.current) return;
      setPhase("thinking");
      const result = await api<Diagnosis>("/api/ai/diagnose", {
        method: "POST",
        body: { jobId: id, workflow: current.current, inspectId, previousAttempts: attempts.current, language: locale },
      });
      if (!alive.current) return;
      baseline.current = current.current;
      setDiagnosis(result);
      setPhase("ready");
      return result;
    } catch (e) {
      setError((e as Error).message);
      setPhase("ready");
      return undefined;
    }
  };

  const markDone = (i: number) => setDone((d) => new Set(d).add(i));

  const applyEdit = (i: number, fix: Extract<Fix, { kind: "editSteps" }>) => {
    try {
      current.current = applyStepChanges(current.current, fix.changes, fix.variables);
      onApply(current.current);
      markDone(i);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  /** Applies the step fixes, then runs again; with keepGoing, diagnoses and repeats while it fails. */
  const applyAndRun = async (keepGoing: boolean, from = diagnosis, doneNow = done) => {
    if (!from) return;
    setAuto(keepGoing);
    from.fixes.forEach((fix, i) => {
      if (fix.kind === "editSteps" && !doneNow.has(i)) applyEdit(i, fix);
    });
    // Assets, settings and manual steps need the person: keep fixing stops for them.
    const open = from.fixes.some((fix, i) => fix.kind !== "editSteps" && !doneNow.has(i));
    if (keepGoing && open) {
      setNeedsYou(true);
      return;
    }
    setNeedsYou(false);
    setPhase("running");
    attempts.current = [...attempts.current, `${from.summary} Applied: ${from.fixes.map((f) => f.title).join("; ") || "nothing"}`];
    const next = await onRunAgain(current.current);
    if (!next) {
      setPhase("ready");
      return;
    }
    setJobId(next);
    let job: FailedJob | undefined;
    for (let waited = 0; alive.current && waited < 15 * 60_000; waited += 1500) {
      await sleep(1500);
      job = await api<FailedJob>(`/api/jobs/${next}`).catch(() => undefined);
      if (job && FINAL.includes(job.status)) break;
    }
    if (!alive.current || !job) return;
    if (job.status === "succeeded") {
      setPhase("passed");
      return;
    }
    setLastError(job.error ?? job.status);
    if (roundRef.current >= MAX_ROUNDS) {
      setPhase("gaveUp");
      return;
    }
    roundRef.current += 1;
    setRound(roundRef.current);
    if (keepGoing) {
      const again = await diagnose(next);
      if (again && alive.current) await applyAndRun(true, again, new Set());
    } else setPhase("failedAgain");
  };

  const describeChange = (c: StepChange): string => {
    const find = (id: string): Step | undefined => {
      let hit: Step | undefined;
      const walk = (s: Step) => {
        if (s.id === id) hit = s;
        for (const list of Object.values(s.slots ?? {})) list.forEach(walk);
      };
      walk(baseline.current.root);
      return hit;
    };
    const show = (v: unknown) => (v === null || v === undefined ? "—" : typeof v === "string" ? v : JSON.stringify(v));
    if (c.op === "insert") return t("fixai.changeInsert", { step: describe(c.step) });
    const step = find(c.stepId);
    if (c.op === "remove") return t("fixai.changeRemove", { step: step ? describe(step) : c.stepId });
    const name = step?.label || (step ? describe(step).split(": ")[0]! : c.stepId);
    const parts = Object.entries(c.props ?? {}).map(([k, v]) => `${k}: ${show(step?.props[k])} → ${show(v)}`);
    if (c.label !== undefined) parts.push(`label: ${c.label}`);
    if (c.retry) parts.push(`retry: ${c.retry.count}×`);
    if (c.timeoutMs) parts.push(`timeout: ${c.timeoutMs} ms`);
    if (c.disabled !== undefined) parts.push(c.disabled ? "disabled" : "enabled");
    return t("fixai.changeUpdate", { step: name, change: parts.join(", ") });
  };

  const busy = phase === "inspecting" || phase === "thinking" || phase === "running";
  const hasEdits = diagnosis?.fixes.some((f, i) => f.kind === "editSteps" && !done.has(i));

  const status: Record<typeof phase, ReactNode> = {
    inspecting: t("fixai.inspecting", { pc: pcName ?? "" }),
    thinking: t("fixai.thinking"),
    running: t("fixai.running"),
    passed: t("fixai.passed"),
    failedAgain: t("fixai.failedAgain", { error: lastError ?? "" }),
    gaveUp: t("fixai.gaveUp", { max: MAX_ROUNDS }),
    ready: null,
  };

  return (
    <Modal
      title={t("fixai.title")}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            {t("common.close")}
          </button>
          {phase === "failedAgain" && (
            <button className="btn" onClick={() => void diagnose(jobId).then(() => undefined)}>
              {t("fixai.diagnoseAgain")}
            </button>
          )}
          {phase === "ready" && diagnosis && (
            <>
              <button className="btn-ghost" disabled={busy} onClick={() => void applyAndRun(false)}>
                {hasEdits ? t("fixai.applyRun") : t("fixai.runAgain")}
              </button>
              <button className="btn ai-btn" disabled={busy} onClick={() => void applyAndRun(true)}>
                {needsYou ? t("fixai.continue") : t("fixai.keepFixing")}
              </button>
            </>
          )}
        </>
      }
    >
      <ErrorBanner error={error} />
      {round > 1 && <p className="muted tiny">{t("fixai.round", { n: round, max: MAX_ROUNDS })}</p>}
      {status[phase] && (
        <p className={`fix-status${busy ? " busy" : ""}${phase === "passed" ? " ok" : ""}${phase === "failedAgain" || phase === "gaveUp" ? " bad" : ""}`}>
          {busy && <span className="spinner" />}
          {status[phase]}
        </p>
      )}
      {diagnosis && phase !== "thinking" && phase !== "inspecting" && (
        <div className="diagnosis">
          <div className="diagnosis-head">
            <span className="tag">{t(`fixai.cause_${diagnosis.cause}` as MessageKey)}</span>
            {looked && <span className="tag">{t("fixai.looked", { pc: pcName ?? "" })}</span>}
          </div>
          <p className="diagnosis-summary">{diagnosis.summary}</p>
          {diagnosis.details && (
            <details>
              <summary>{t("fixai.evidence")}</summary>
              <p className="muted">{diagnosis.details}</p>
            </details>
          )}
          {!diagnosis.fixes.length && <p className="muted">{t("fixai.noFixes")}</p>}
          <ol className="fix-list">
            {diagnosis.fixes.map((fix, i) => (
              <li key={i} className={`fix-card${done.has(i) ? " done" : ""}${needsYou && !done.has(i) && fix.kind !== "editSteps" ? " needs-you" : ""}`}>
                <div className="fix-card-head">
                  <strong>{fix.title}</strong>
                  {done.has(i) && <span className="tag ok">✓ {t("fixai.done")}</span>}
                </div>
                {fix.why && <p className="muted tiny">{fix.why}</p>}
                {fix.kind === "editSteps" && (
                  <>
                    <ul className="fix-changes">
                      {fix.changes.map((c, j) => (
                        <li key={j}>{describeChange(c)}</li>
                      ))}
                    </ul>
                    {!done.has(i) && (
                      <button className="btn small" disabled={busy} onClick={() => applyEdit(i, fix)}>
                        {t("fixai.apply")}
                      </button>
                    )}
                  </>
                )}
                {fix.kind === "createAsset" && !done.has(i) && <AssetForm fix={fix} onCreated={() => markDone(i)} />}
                {fix.kind === "setPcEnvironment" && !done.has(i) && (
                  <PcEnvironmentButton agent={agentRef.current} environment={fix.environment} onDone={() => markDone(i)} />
                )}
                {fix.kind === "manual" && (
                  <>
                    <ol className="fix-changes">
                      {fix.instructions.map((s, j) => (
                        <li key={j}>{s}</li>
                      ))}
                    </ol>
                    {!done.has(i) && (
                      <button className="btn-ghost small" onClick={() => markDone(i)}>
                        {t("fixai.markDone")}
                      </button>
                    )}
                  </>
                )}
              </li>
            ))}
          </ol>
          {needsYou && diagnosis.fixes.some((f, i) => f.kind !== "editSteps" && !done.has(i)) && <p className="fix-status bad">{t("fixai.needsYou")}</p>}
          {auto && phase === "ready" && !needsYou && <p className="muted tiny">{t("fixai.round", { n: round, max: MAX_ROUNDS })}</p>}
        </div>
      )}
    </Modal>
  );
}

/** Creates the missing asset; the value goes to ZamTech AI only, never to AI. */
function AssetForm({ fix, onCreated }: { fix: Extract<Fix, { kind: "createAsset" }>; onCreated: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState(fix.name);
  const [type, setType] = useState(fix.assetType);
  const [value, setValue] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [environment, setEnvironment] = useState<Env | "">(fix.environment ?? "");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const create = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const typed = type === "credential" ? { username, password } : type === "number" ? Number(value) : type === "boolean" ? value === "true" : value;
      await api("/api/assets", { method: "POST", body: { name, type, value: typed, description: fix.description, environment: environment || undefined } });
      onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fix-form">
      <ErrorBanner error={error} />
      <div className="fix-form-row">
        <label>
          <span>{t("fixai.assetName")}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          <span>{t("fixai.assetType")}</span>
          <select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            <option value="credential">{t("assets.typeCredential")}</option>
            <option value="text">{t("assets.typeText")}</option>
            <option value="number">{t("assets.typeNumber")}</option>
            <option value="boolean">{t("assets.typeBoolean")}</option>
          </select>
        </label>
      </div>
      {type === "credential" ? (
        <div className="fix-form-row">
          <label>
            <span>{t("assets.username")}</span>
            <input value={username} autoComplete="off" onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label>
            <span>{t("assets.password")}</span>
            <input type="password" value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
          </label>
        </div>
      ) : type === "boolean" ? (
        <select value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">—</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : (
        <label>
          <span>{t("fixai.value")}</span>
          <input value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
      )}
      <div className="fix-form-row">
        <select value={environment} onChange={(e) => setEnvironment(e.target.value as Env | "")}>
          <option value="">{t("assets.allEnvironments")}</option>
          <option value="dev">{t("env.dev")}</option>
          <option value="test">{t("env.test")}</option>
          <option value="prod">{t("env.prod")}</option>
        </select>
        <button className="btn small" disabled={saving || !name || (type === "credential" ? !password : !value)} onClick={() => void create()}>
          {t("fixai.createAsset")}
        </button>
      </div>
      <p className="muted tiny">🔒 {t("fixai.secretNote")}</p>
    </div>
  );
}

function PcEnvironmentButton({ agent, environment, onDone }: { agent?: { id: string; name: string }; environment: Env; onDone: () => void }) {
  const { t } = useI18n();
  const [error, setError] = useState<string>();
  if (!agent) return null;
  const set = () =>
    api(`/api/agents/${agent.id}/environment`, { method: "PUT", body: { environment } }).then(onDone, (e: Error) => setError(e.message));
  return (
    <>
      <ErrorBanner error={error} />
      <button className="btn small" onClick={() => void set()}>
        {t("fixai.setEnv", { pc: agent.name, env: t(`env.${environment}` as MessageKey) })}
      </button>
    </>
  );
}
