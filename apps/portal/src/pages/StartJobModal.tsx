import { useI18n } from "@zamtest/i18n/react";
import { useState } from "react";
import { api } from "../api";
import type { Agent, Job, Package } from "../api";
import { usePoll } from "../hooks";
import { ErrorBanner, Field, Modal } from "../ui";

/** Parses user input as JSON when possible so numbers/arrays keep their type. */
export function parseInput(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function formatInput(value: unknown): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function InputsEditor({
  pkg,
  values,
  onChange,
}: {
  pkg: Package;
  values: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
}) {
  const { t } = useI18n();
  const inputs = pkg.variables.filter((v) => v.direction === "in" || v.direction === "inout");
  if (!inputs.length) return <p className="muted">{t("startJob.noInputs")}</p>;
  return (
    <>
      {inputs.map((v) => (
        <Field key={v.name} label={`${v.name} (${v.type})`} hint={v.description}>
          <input value={values[v.name] ?? ""} placeholder={formatInput(v.default)} onChange={(e) => onChange({ ...values, [v.name]: e.target.value })} />
        </Field>
      ))}
    </>
  );
}

export function collectInputs(values: Record<string, string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== "").map(([k, v]) => [k, parseInput(v)]));
}

export function StartJobModal({ pkg, onClose }: { pkg: Package; onClose: () => void }) {
  const { t } = useI18n();
  const agents = usePoll<Agent[]>("/api/agents", 0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [agentId, setAgentId] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    try {
      const job = await api<Job>("/api/jobs", {
        method: "POST",
        body: { packageId: pkg.id, inputs: collectInputs(values), targetAgentId: agentId || undefined, source: "manual" },
      });
      window.location.hash = `/jobs/${job.id}`;
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("startJob.title", { name: pkg.name, version: pkg.version })}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn" disabled={busy} onClick={() => void start()}>
            {t("startJob.submit")}
          </button>
        </>
      }
    >
      <ErrorBanner error={error} />
      <Field label={t("common.runOn")}>
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          <option value="">{t("common.anyAgent")}</option>
          {agents.data?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({t(`status.${a.status}`)})
            </option>
          ))}
        </select>
      </Field>
      <InputsEditor pkg={pkg} values={values} onChange={setValues} />
    </Modal>
  );
}
