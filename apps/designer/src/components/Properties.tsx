import type { ActivityMeta, PropDef, Step, VariableDef, Workflow } from "@zamtest/core";
import { Field } from "./ui";

interface Props {
  step: Step;
  meta?: ActivityMeta;
  variables: VariableDef[];
  aiEnabled: boolean;
  onChange: (step: Step) => void;
  onSelectorAssist: (propName: string) => void;
}

function PropInput({ def, value, variables, onChange }: { def: PropDef; value: unknown; variables: VariableDef[]; onChange: (v: unknown) => void }) {
  const placeholder = def.default !== undefined ? String(typeof def.default === "object" ? JSON.stringify(def.default) : def.default) : "";
  switch (def.type) {
    case "boolean":
      return (
        <select value={value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value === "true")}>
          <option value="">Default ({placeholder || "false"})</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      );
    case "enum":
      return (
        <select value={value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">Default ({placeholder})</option>
          {def.options?.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      );
    case "number":
      return <input value={value === undefined ? "" : String(value)} placeholder={placeholder} onChange={(e) => onChange(e.target.value === "" ? undefined : isNaN(Number(e.target.value)) ? e.target.value : Number(e.target.value))} />;
    case "variable":
      return (
        <>
          <input list="zamtest-vars" value={String(value ?? "")} placeholder={placeholder || "variable name"} onChange={(e) => onChange(e.target.value || undefined)} />
          <datalist id="zamtest-vars">
            {variables.map((v) => (
              <option key={v.name} value={v.name} />
            ))}
          </datalist>
        </>
      );
    case "text":
      return <textarea className={def.name === "code" ? "mono" : ""} rows={def.name === "code" ? 8 : 4} value={String(value ?? "")} placeholder={placeholder} onChange={(e) => onChange(e.target.value || undefined)} />;
    case "json":
      return <JsonInput value={value} onChange={onChange} />;
    case "expression":
      return <input className="mono" value={String(value ?? "")} placeholder={placeholder || "e.g. total > 100"} onChange={(e) => onChange(e.target.value || undefined)} />;
    case "secret":
      return <input type="password" value={String(value ?? "")} onChange={(e) => onChange(e.target.value || undefined)} />;
    default:
      return <input className={def.type === "selector" ? "mono" : ""} value={String(value ?? "")} placeholder={placeholder} onChange={(e) => onChange(e.target.value || undefined)} />;
  }
}

function JsonInput({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const text = value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
  let invalid = false;
  if (typeof value === "string" && value.trim()) {
    try {
      JSON.parse(value);
    } catch {
      invalid = !value.includes("{{");
    }
  }
  return (
    <>
      <textarea
        className="mono"
        rows={5}
        defaultValue={text}
        onBlur={(e) => {
          const t = e.target.value.trim();
          if (!t) return onChange(undefined);
          try {
            onChange(JSON.parse(t));
          } catch {
            onChange(t);
          }
        }}
      />
      {invalid && <small className="warn-text">Not valid JSON</small>}
    </>
  );
}

export function Properties({ step, meta, variables, aiEnabled, onChange, onSelectorAssist }: Props) {
  const setProp = (name: string, v: unknown) => {
    const props = { ...step.props };
    if (v === undefined) delete props[name];
    else props[name] = v;
    onChange({ ...step, props });
  };

  return (
    <div className="props-panel" key={step.id}>
      <div className="props-head">
        <strong>{meta?.displayName ?? step.type}</strong>
        <small className="muted">{meta?.description}</small>
      </div>
      <Field label="Label">
        <input value={step.label ?? ""} placeholder={meta?.displayName} onChange={(e) => onChange({ ...step, label: e.target.value || undefined })} />
      </Field>
      {meta?.props.map((def) => (
        <Field key={def.name} label={`${def.label}${def.required ? " *" : ""}`} hint={def.description}>
          <div className="prop-row">
            <PropInput def={def} value={step.props[def.name]} variables={variables} onChange={(v) => setProp(def.name, v)} />
            {def.type === "selector" && (
              <button className="btn-ghost ai-btn" disabled={!aiEnabled} title={aiEnabled ? "Suggest selectors with AI" : "AI not configured on the orchestrator"} onClick={() => onSelectorAssist(def.name)}>
                ✨ AI
              </button>
            )}
          </div>
        </Field>
      ))}
      {!meta && <p className="warn-text">Unknown activity type. It may come from a package that is not installed.</p>}
      {meta && !meta.slots?.length && step.type !== "core.comment" && (
        <details className="advanced">
          <summary>Error handling & timeouts</summary>
          <label className="toggle">
            <input type="checkbox" checked={Boolean(step.continueOnError)} onChange={(e) => onChange({ ...step, continueOnError: e.target.checked || undefined })} />
            Continue on error
          </label>
          <Field label="Retry count">
            <input
              type="number"
              min={0}
              max={20}
              value={step.retry?.count ?? 0}
              onChange={(e) => {
                const count = Number(e.target.value);
                onChange({ ...step, retry: count > 0 ? { count, delayMs: step.retry?.delayMs ?? 1000 } : undefined });
              }}
            />
          </Field>
          {step.retry && (
            <Field label="Retry delay (ms)">
              <input type="number" min={0} value={step.retry.delayMs ?? 1000} onChange={(e) => onChange({ ...step, retry: { ...step.retry!, delayMs: Number(e.target.value) } })} />
            </Field>
          )}
          <Field label="Timeout (ms)">
            <input type="number" min={0} value={step.timeoutMs ?? ""} placeholder="none" onChange={(e) => onChange({ ...step, timeoutMs: Number(e.target.value) || undefined })} />
          </Field>
        </details>
      )}
      <label className="toggle">
        <input type="checkbox" checked={Boolean(step.disabled)} onChange={(e) => onChange({ ...step, disabled: e.target.checked || undefined })} />
        Disabled (skip at run time)
      </label>
      <p className="muted tiny">Step id: {step.id}</p>
    </div>
  );
}

const TYPES: VariableDef["type"][] = ["string", "number", "boolean", "object", "array", "any"];
const DIRECTIONS: VariableDef["direction"][] = ["local", "in", "out", "inout"];

export function WorkflowSettings({ workflow, onChange }: { workflow: Workflow; onChange: (w: Workflow) => void }) {
  const setVar = (i: number, patch: Partial<VariableDef>) => {
    const variables = workflow.variables.map((v, j) => (j === i ? { ...v, ...patch } : v));
    onChange({ ...workflow, variables });
  };
  return (
    <div className="props-panel">
      <div className="props-head">
        <strong>Workflow</strong>
        <small className="muted">Select a step to edit its properties.</small>
      </div>
      <Field label="Name">
        <input value={workflow.name} onChange={(e) => onChange({ ...workflow, name: e.target.value })} />
      </Field>
      <Field label="Description">
        <textarea rows={2} value={workflow.description ?? ""} onChange={(e) => onChange({ ...workflow, description: e.target.value || undefined })} />
      </Field>
      <div className="vars-head">
        <strong>Variables & arguments</strong>
        <button className="btn-ghost small" onClick={() => onChange({ ...workflow, variables: [...workflow.variables, { name: `var${workflow.variables.length + 1}`, type: "any", direction: "local" }] })}>
          + Add
        </button>
      </div>
      <p className="muted tiny">"in" arguments are filled when a job starts; "out" are returned when it ends. Use them in expressions by name, or in text as {"{{ name }}"}.</p>
      {workflow.variables.map((v, i) => (
        <div className="var-row" key={i}>
          <input className="mono" value={v.name} onChange={(e) => setVar(i, { name: e.target.value })} />
          <select value={v.type} onChange={(e) => setVar(i, { type: e.target.value as VariableDef["type"] })}>
            {TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <select value={v.direction} onChange={(e) => setVar(i, { direction: e.target.value as VariableDef["direction"] })}>
            {DIRECTIONS.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
          <input
            className="mono"
            placeholder="default (JSON)"
            defaultValue={v.default === undefined ? "" : JSON.stringify(v.default)}
            onBlur={(e) => {
              const t = e.target.value.trim();
              let value: unknown;
              if (t) {
                try {
                  value = JSON.parse(t);
                } catch {
                  value = t;
                }
              }
              setVar(i, { default: value });
            }}
          />
          <button className="icon-btn" title="Remove" onClick={() => onChange({ ...workflow, variables: workflow.variables.filter((_, j) => j !== i) })}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
