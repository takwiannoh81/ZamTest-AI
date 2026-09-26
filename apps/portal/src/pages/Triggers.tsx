import { useI18n } from "@zamtest/i18n/react";
import type { MessageKey } from "@zamtest/i18n";
import { useState } from "react";
import { api } from "../api";
import type { Agent, Asset, Package, Trigger, TriggerKind } from "../api";
import { EnvironmentBadge, EnvironmentSelect, useEnvironmentsOn } from "../env";
import { usePoll } from "../hooks";
import { Empty, ErrorBanner, Field, Modal, PageHeader } from "../ui";
import { collectInputs, formatInput, InputsEditor } from "./StartJobModal";

/** Where other systems send web requests (the API's public address). */
const API_URL = (import.meta.env.VITE_AGENT_SERVER_URL || import.meta.env.VITE_API_URL || window.location.origin).replace(/\/+$/, "");

const ICONS: Record<TriggerKind, string> = { webhook: "🔗", email: "✉", file: "📁" };

interface TestsTree {
  folders: Array<{ id: string; name: string; parentId?: string }>;
  cases: Array<{ id: string; name: string; folderId?: string }>;
}

/** Agent 0.3.9 and newer watch folders. */
const canWatch = (version?: string) => {
  const [a = 0, b = 0, c = 0] = (version ?? "").split(".").map(Number);
  return a > 0 || b > 3 || (b === 3 && c >= 9);
};

function CopyField({ value }: { value: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-field">
      <code>{value}</code>
      <button
        className="btn-ghost"
        onClick={() =>
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? t("triggers.copied") : t("common.copy")}
      </button>
    </div>
  );
}

export function Triggers() {
  const { t, timeAgo } = useI18n();
  const { data, error, reload } = usePoll<Trigger[]>("/api/triggers", 10_000);
  const packages = usePoll<Package[]>("/api/packages", 0);
  const tests = usePoll<TestsTree>("/api/tests", 0);
  const envsOn = useEnvironmentsOn();
  const [editing, setEditing] = useState<Partial<Trigger> | null>(null);
  const [notice, setNotice] = useState<string>();
  const [actionError, setActionError] = useState<string>();

  const whatRuns = (tr: Trigger) => {
    if (tr.tests) {
      const c = tr.tests.caseIds?.[0] ? tests.data?.cases.find((x) => x.id === tr.tests!.caseIds![0])?.name : undefined;
      const f = tr.tests.folderId ? tests.data?.folders.find((x) => x.id === tr.tests!.folderId)?.name : undefined;
      return t("schedules.testsLabel", { name: c ?? f ?? t("schedules.allTests") });
    }
    const p = packages.data?.find((x) => x.id === tr.packageId);
    return p ? `${p.name} v${p.version}` : (tr.packageId ?? "");
  };
  const whenText = (tr: Trigger) =>
    tr.kind === "webhook"
      ? t("triggers.whenWebhook")
      : tr.kind === "email"
        ? t("triggers.whenEmail", { folder: tr.email?.folder ?? "INBOX", credential: tr.email?.credential ?? "" }) +
          (tr.email?.from ? ` · ${t("triggers.fromShort", { text: tr.email.from })}` : "") +
          (tr.email?.subject ? ` · ${t("triggers.subjectShort", { text: tr.email.subject })}` : "")
        : t("triggers.whenFile", { pattern: tr.file?.pattern || "*", folder: tr.file?.folder ?? "", pc: tr.agentName ?? "?" });

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setActionError(undefined);
    setNotice(undefined);
    try {
      await fn();
      if (done) setNotice(done);
      reload();
    } catch (e) {
      setActionError((e as Error).message);
    }
  };
  const toggle = (tr: Trigger) => act(() => api(`/api/triggers/${tr.id}`, { method: "PUT", body: { enabled: !tr.enabled } }));
  const test = (tr: Trigger) => act(() => api(`/api/triggers/${tr.id}/test`, { method: "POST" }), t("triggers.tested"));
  const remove = (tr: Trigger) => confirm(t("triggers.confirmDelete", { name: tr.name })) && void act(() => api(`/api/triggers/${tr.id}`, { method: "DELETE" }));
  const newSecret = (tr: Trigger) =>
    confirm(t("triggers.newSecretConfirm")) && void act(() => api(`/api/triggers/${tr.id}/new-secret`, { method: "POST" }), t("triggers.newSecretDone"));

  return (
    <>
      <PageHeader
        title={t("triggers.title")}
        subtitle={t("triggers.subtitle")}
        actions={
          <button className="btn" onClick={() => setEditing({ kind: "webhook", enabled: true, inputs: {}, eventArgument: "trigger" })}>
            {t("triggers.new")}
          </button>
        }
      />
      <ErrorBanner error={error ?? actionError} />
      {notice && <div className="notice">{notice}</div>}
      {data?.length ? (
        <div className="trigger-list">
          {data.map((tr) => (
            <div key={tr.id} className={`trigger-card${tr.enabled ? "" : " off"}`}>
              <div className="trigger-head">
                <span className="trigger-icon" aria-hidden>
                  {ICONS[tr.kind]}
                </span>
                <div className="trigger-title">
                  <strong>{tr.name}</strong> {envsOn && <EnvironmentBadge env={tr.environment ?? "prod"} />}
                  <div className="muted small">
                    {whenText(tr)} → {whatRuns(tr)}
                  </div>
                </div>
                <label className="switch-row" title={t("schedules.enabled")}>
                  <input type="checkbox" checked={tr.enabled} onChange={() => void toggle(tr)} />
                  {tr.enabled ? t("triggers.on") : t("triggers.off")}
                </label>
              </div>
              {tr.kind === "webhook" && tr.webhook && (
                <div className="trigger-detail">
                  <span className="muted small">{t("triggers.webhookUrl")}</span>
                  <CopyField value={`${API_URL}${tr.webhook.path}`} />
                  <span className="muted tiny">{t("triggers.webhookHow")}</span>
                </div>
              )}
              <div className="trigger-foot">
                <span className="muted small">
                  {tr.lastFiredAt ? t("triggers.lastFired", { time: timeAgo(tr.lastFiredAt), count: tr.fired ?? 0 }) : t("triggers.neverFired")}
                </span>
                {tr.lastError && <span className="warn-text small">⚠ {tr.lastError.message}</span>}
                <span className="spacer" />
                <button className="btn-ghost" onClick={() => void test(tr)} title={t("triggers.testHint")}>
                  {t("triggers.test")}
                </button>
                {tr.kind === "webhook" && (
                  <button className="btn-ghost" onClick={() => newSecret(tr)}>
                    {t("triggers.newSecret")}
                  </button>
                )}
                <button className="btn-ghost" onClick={() => setEditing(tr)}>
                  {t("common.edit")}
                </button>
                <button className="btn-ghost danger" onClick={() => remove(tr)}>
                  {t("common.delete")}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Empty>{t("triggers.empty")}</Empty>
      )}
      {editing && (
        <TriggerModal
          initial={editing}
          packages={packages.data ?? []}
          tests={tests.data}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </>
  );
}

function TriggerModal({
  initial,
  packages,
  tests,
  onClose,
  onSaved,
}: {
  initial: Partial<Trigger>;
  packages: Package[];
  tests?: TestsTree;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const agents = usePoll<Agent[]>("/api/agents", 0);
  const assets = usePoll<Asset[]>("/api/assets", 0);
  const envsOn = useEnvironmentsOn();
  const [form, setForm] = useState<Partial<Trigger>>(initial);
  const [email, setEmail] = useState(initial.email ?? { server: "", credential: "", folder: "INBOX", from: "", subject: "", markAsRead: false });
  const [file, setFile] = useState(initial.file ?? { folder: "", pattern: "*" });
  const [runs, setRuns] = useState<"process" | "tests">(initial.tests ? "tests" : "process");
  const [inputs, setInputs] = useState<Record<string, string>>(Object.fromEntries(Object.entries(initial.inputs ?? {}).map(([k, v]) => [k, formatInput(v)])));
  const [error, setError] = useState<string>();
  const kind = form.kind ?? "webhook";
  const eventArgument = form.eventArgument || "trigger";
  const pkg = runs === "process" ? packages.find((p) => p.id === form.packageId) : undefined;
  // The event fills its argument by itself: only the other inputs are typed here.
  const otherInputs = pkg ? { ...pkg, variables: pkg.variables.filter((v) => v.name !== eventArgument) } : undefined;
  const hasEventArgument = !pkg || pkg.variables.some((v) => v.name === eventArgument && (v.direction === "in" || v.direction === "inout"));
  const credentials = assets.data?.filter((a) => a.type === "credential") ?? [];
  const pc = agents.data?.find((a) => a.id === form.targetAgentId);
  const testsValue = !form.tests ? "" : form.tests.caseIds?.[0] ? `c:${form.tests.caseIds[0]}` : form.tests.folderId ? `f:${form.tests.folderId}` : "all";

  const save = async () => {
    const body = {
      name: form.name,
      kind,
      enabled: form.enabled ?? true,
      packageId: runs === "process" ? form.packageId || null : null,
      tests: runs === "tests" ? (form.tests ?? null) : null,
      inputs: runs === "process" ? collectInputs(inputs) : {},
      targetAgentId: form.targetAgentId || null,
      environment: form.environment || null,
      eventArgument,
      email: kind === "email" ? email : null,
      file: kind === "file" ? file : null,
    };
    try {
      if (initial.id) await api(`/api/triggers/${initial.id}`, { method: "PUT", body });
      else await api("/api/triggers", { method: "POST", body });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal
      title={initial.id ? t("triggers.editTitle") : t("triggers.newTitle")}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn" onClick={() => void save()}>
            {t("common.save")}
          </button>
        </>
      }
    >
      <ErrorBanner error={error} />
      <Field label={t("triggers.when")}>
        <div className="segmented">
          {(["webhook", "email", "file"] as TriggerKind[]).map((k) => (
            <button key={k} type="button" className={kind === k ? "active" : ""} onClick={() => setForm({ ...form, kind: k })} disabled={Boolean(initial.id) && initial.kind !== k}>
              {ICONS[k]} {t(`triggers.kind.${k}` as MessageKey)}
            </button>
          ))}
        </div>
      </Field>
      <p className="muted small">{t(`triggers.kindHelp.${kind}` as MessageKey)}</p>
      <Field label={t("common.name")}>
        <input value={form.name ?? ""} placeholder={t(`triggers.namePlaceholder.${kind}` as MessageKey)} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>

      {kind === "email" && (
        <>
          <div className="form-row">
            <Field label={t("triggers.imapServer")} hint={t("triggers.imapServerHint")}>
              <input value={email.server} placeholder="outlook.office365.com:993" onChange={(e) => setEmail({ ...email, server: e.target.value })} />
            </Field>
            <Field label={t("triggers.mailFolder")}>
              <input value={email.folder} onChange={(e) => setEmail({ ...email, folder: e.target.value })} />
            </Field>
          </div>
          <Field label={t("triggers.mailbox")} hint={credentials.length ? t("triggers.mailboxHint") : t("triggers.noCredentials")}>
            <select value={email.credential} onChange={(e) => setEmail({ ...email, credential: e.target.value })}>
              <option value="">{t("triggers.chooseCredential")}</option>
              {credentials.map((a) => (
                <option key={a.id} value={a.name}>
                  🔑 {a.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="form-row">
            <Field label={t("triggers.fromContains")}>
              <input value={email.from ?? ""} placeholder="billing@supplier.com" onChange={(e) => setEmail({ ...email, from: e.target.value })} />
            </Field>
            <Field label={t("triggers.subjectContains")}>
              <input value={email.subject ?? ""} placeholder={t("triggers.subjectPlaceholder")} onChange={(e) => setEmail({ ...email, subject: e.target.value })} />
            </Field>
          </div>
          <label className="check-row">
            <input type="checkbox" checked={email.markAsRead} onChange={(e) => setEmail({ ...email, markAsRead: e.target.checked })} />
            {t("triggers.markAsRead")}
          </label>
        </>
      )}

      {kind === "file" && (
        <>
          <Field label={t("triggers.watchPc")} hint={t("triggers.watchPcHint")}>
            <select value={form.targetAgentId ?? ""} onChange={(e) => setForm({ ...form, targetAgentId: e.target.value })}>
              <option value="">{t("triggers.choosePc")}</option>
              {agents.data?.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {canWatch(a.version) ? "" : ` (${t("triggers.pcTooOld")})`}
                </option>
              ))}
            </select>
          </Field>
          {pc && !canWatch(pc.version) && <p className="warn-text small">{t("triggers.updateAgent", { pc: pc.name, version: pc.version || "?" })}</p>}
          <div className="form-row">
            <Field label={t("triggers.watchFolder")}>
              <input value={file.folder} placeholder="C:\Scans\Invoices" onChange={(e) => setFile({ ...file, folder: e.target.value })} />
            </Field>
            <Field label={t("triggers.filePattern")} hint={t("triggers.filePatternHint")}>
              <input value={file.pattern} placeholder="*.pdf" onChange={(e) => setFile({ ...file, pattern: e.target.value })} />
            </Field>
          </div>
        </>
      )}

      <Field label={t("schedules.what")}>
        <div className="segmented">
          <button type="button" className={runs === "process" ? "active" : ""} onClick={() => setRuns("process")}>
            {t("schedules.aProcess")}
          </button>
          <button type="button" className={runs === "tests" ? "active" : ""} onClick={() => setRuns("tests")}>
            {t("schedules.testCases")}
          </button>
        </div>
      </Field>
      {runs === "process" ? (
        <Field label={t("common.process")} hint={packages.length ? undefined : t("schedules.noProcesses")}>
          <select value={form.packageId ?? ""} onChange={(e) => setForm({ ...form, packageId: e.target.value })}>
            <option value="">{t("schedules.selectProcess")}</option>
            {packages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} v{p.version}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <Field label={t("schedules.whichTests")}>
          <select
            value={testsValue}
            onChange={(e) => {
              const v = e.target.value;
              setForm({ ...form, tests: !v ? null : v === "all" ? {} : v.startsWith("f:") ? { folderId: v.slice(2) } : { caseIds: [v.slice(2)] } });
            }}
          >
            <option value="">{t("schedules.selectTests")}</option>
            <option value="all">{t("schedules.allTests")}</option>
            {tests?.folders.map((f) => (
              <option key={f.id} value={`f:${f.id}`}>
                📁 {f.name}
              </option>
            ))}
            {tests?.cases.map((c) => (
              <option key={c.id} value={`c:${c.id}`}>
                🧪 {c.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {runs === "process" && (
        <>
          <Field label={t("triggers.eventArgument")} hint={t(`triggers.eventHint.${kind}` as MessageKey, { name: eventArgument })}>
            <input value={form.eventArgument ?? "trigger"} onChange={(e) => setForm({ ...form, eventArgument: e.target.value })} />
          </Field>
          {pkg && !hasEventArgument && <p className="warn-text small">{t("triggers.noEventArgument", { name: eventArgument, process: pkg.name })}</p>}
          {otherInputs && <InputsEditor pkg={otherInputs} values={inputs} onChange={setInputs} />}
        </>
      )}
      {envsOn && (
        <Field label={t("processes.environment")}>
          <EnvironmentSelect value={form.environment ?? "prod"} onChange={(env) => setForm({ ...form, environment: env || undefined })} />
        </Field>
      )}
      {kind !== "file" && (
        <Field label={t("common.runOn")}>
          <select value={form.targetAgentId ?? ""} onChange={(e) => setForm({ ...form, targetAgentId: e.target.value })}>
            <option value="">{t("common.anyAgent")}</option>
            {agents.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
      )}
    </Modal>
  );
}
