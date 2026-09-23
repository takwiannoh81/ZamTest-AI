import { useI18n } from "@zamtest/i18n/react";
import type { MessageKey } from "@zamtest/i18n";
import { useState } from "react";
import type { ActionMeta, Step } from "@zamtest/core";
import type { Location } from "../tree";
import { summarize } from "../tree";
import { CATEGORY_COLORS, iconFor } from "./icons";
import { DRAG_ACTION, DRAG_STEP } from "./Palette";

interface CanvasProps {
  root: Step;
  metas: Map<string, ActionMeta>;
  selectedId?: string;
  runStatus: Record<string, "running" | "ok" | "error">;
  onSelect: (id: string) => void;
  onDropAction: (type: string, loc: Location) => void;
  onMoveStep: (id: string, loc: Location) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
}

export function Canvas(props: CanvasProps) {
  const { t } = useI18n();
  const body = props.root.slots?.body ?? [];
  return (
    <div className="canvas" onClick={() => props.onSelect(props.root.id)}>
      <div className="flow">
        <div className="flow-start">{t("canvas.start")}</div>
        <StepList steps={body} loc={{ parentId: props.root.id, slot: "body" }} {...props} />
        <div className="flow-end">{t("canvas.end")}</div>
      </div>
    </div>
  );
}

function StepList({ steps, loc, ...props }: CanvasProps & { steps: Step[]; loc: Omit<Location, "index"> }) {
  return (
    <div className="step-list">
      <DropZone loc={{ ...loc, index: 0 }} empty={steps.length === 0} {...props} />
      {steps.map((step, i) => (
        <div key={step.id}>
          <StepCard step={step} {...props} />
          <DropZone loc={{ ...loc, index: i + 1 }} {...props} />
        </div>
      ))}
    </div>
  );
}

function DropZone({ loc, empty, onDropAction, onMoveStep }: CanvasProps & { loc: Location; empty?: boolean }) {
  const { t } = useI18n();
  const [over, setOver] = useState(false);
  return (
    <div
      className={`drop-zone${over ? " over" : ""}${empty ? " empty" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DRAG_ACTION) || e.dataTransfer.types.includes(DRAG_STEP)) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        const type = e.dataTransfer.getData(DRAG_ACTION);
        const stepId = e.dataTransfer.getData(DRAG_STEP);
        if (type) onDropAction(type, loc);
        else if (stepId) onMoveStep(stepId, loc);
      }}
    >
      {empty ? t("canvas.drop") : null}
    </div>
  );
}

function StepCard({ step, ...props }: CanvasProps & { step: Step }) {
  const { t, actionName } = useI18n();
  const meta = props.metas.get(step.type);
  const color = CATEGORY_COLORS[meta?.category ?? ""] ?? "var(--muted)";
  const selected = props.selectedId === step.id;
  const status = props.runStatus[step.id];
  const [collapsed, setCollapsed] = useState(false);
  const slots = meta?.slots ?? Object.keys(step.slots ?? {});

  return (
    <div
      className={`step${selected ? " selected" : ""}${step.disabled ? " disabled" : ""}${status ? ` run-${status}` : ""}`}
      style={{ borderLeftColor: color }}
      onClick={(e) => {
        e.stopPropagation();
        props.onSelect(step.id);
      }}
    >
      <div
        className="step-head"
        draggable
        onDragStart={(e) => {
          e.stopPropagation();
          e.dataTransfer.setData(DRAG_STEP, step.id);
          e.dataTransfer.effectAllowed = "move";
        }}
      >
        <span className="step-icon" style={{ color }}>
          {iconFor(meta?.icon)}
        </span>
        <div className="step-title">
          <strong>{step.label || (meta ? actionName(meta) : step.type)}</strong>
          <small className="muted">{summarize(step) || (meta ? actionName(meta) : "")}</small>
        </div>
        <div className="step-tools">
          {step.retry?.count ? <span className="tag">{t("canvas.retry", { count: step.retry.count })}</span> : null}
          {step.continueOnError ? <span className="tag">{t("canvas.continueOnError")}</span> : null}
          {slots.length > 0 && (
            <button className="icon-btn" title={collapsed ? t("canvas.expand") : t("canvas.collapse")} onClick={(e) => { e.stopPropagation(); setCollapsed(!collapsed); }}>
              {collapsed ? "▸" : "▾"}
            </button>
          )}
          <button className="icon-btn" title={t("canvas.duplicate")} onClick={(e) => { e.stopPropagation(); props.onDuplicate(step.id); }}>
            ⧉
          </button>
          <button className="icon-btn" title={t("common.delete")} onClick={(e) => { e.stopPropagation(); props.onDelete(step.id); }}>
            🗑
          </button>
        </div>
      </div>
      {!collapsed && slots.length > 0 && (
        <div className={`slots slots-${slots.length}`}>
          {slots.map((slot) => (
            <div className="slot" key={slot}>
              <div className="slot-name">{t(`slot.${slot}` as MessageKey)}</div>
              <StepList steps={step.slots?.[slot] ?? []} loc={{ parentId: step.id, slot }} {...props} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
