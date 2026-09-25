import { useI18n } from "@zamtest/i18n/react";
import type { MessageKey } from "@zamtest/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
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

/** Between steps: drop an action or a step here, or click + to pick an action for this place. */
function DropZone({ loc, empty, metas, onDropAction, onMoveStep }: CanvasProps & { loc: Location; empty?: boolean }) {
  const { t } = useI18n();
  const [over, setOver] = useState(false);
  const [picking, setPicking] = useState(false);
  return (
    <div
      className={`drop-zone${over ? " over" : ""}${empty ? " empty" : ""}${picking ? " picking" : ""}`}
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
      {empty ? <span>{t("canvas.drop")}</span> : null}
      <button
        type="button"
        className="insert-btn"
        title={t("canvas.insert")}
        aria-label={t("canvas.insert")}
        onClick={(e) => {
          e.stopPropagation();
          setPicking(!picking);
        }}
      >
        +
      </button>
      {picking && (
        <ActionPicker
          metas={metas}
          onPick={(type) => {
            setPicking(false);
            onDropAction(type, loc);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}

/** The actions to insert at a place, with search (Enter takes the first, arrows move, Esc closes). */
function ActionPicker({ metas, onPick, onClose }: { metas: Map<string, ActionMeta>; onPick: (type: string) => void; onClose: () => void }) {
  const { t, actionName, actionDescription, category: categoryName } = useI18n();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...metas.values()]
      .filter((a) => !q || `${actionName(a)} ${actionDescription(a)} ${a.displayName} ${a.type}`.toLowerCase().includes(q));
  }, [metas, query, actionName, actionDescription]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    const outside = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [onClose]);
  useEffect(() => {
    box.current?.querySelector(".picker-item.active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  let lastCategory = "";
  return (
    <div className="action-picker" ref={box} onClick={(e) => e.stopPropagation()}>
      <input
        autoFocus
        placeholder={t("palette.search")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          else if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => Math.min(i + 1, items.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter" && items[active]) onPick(items[active].type);
        }}
      />
      <div className="picker-list">
        {items.map((a, i) => {
          const heading = a.category !== lastCategory ? categoryName(a.category) : undefined;
          lastCategory = a.category;
          return (
            <div key={a.type}>
              {heading && (
                <div className="picker-cat">
                  <span className="dot" style={{ background: CATEGORY_COLORS[a.category] ?? "var(--muted)" }} />
                  {heading}
                </div>
              )}
              <button
                type="button"
                className={`picker-item${i === active ? " active" : ""}`}
                title={actionDescription(a)}
                onMouseEnter={() => setActive(i)}
                onClick={() => onPick(a.type)}
              >
                <span className="palette-icon">{iconFor(a.icon)}</span>
                {actionName(a)}
              </button>
            </div>
          );
        })}
        {!items.length && <p className="muted tiny">{t("canvas.noActions")}</p>}
      </div>
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
      style={{ borderInlineStartColor: color }}
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
              <span className={collapsed ? "flip-rtl" : undefined}>{collapsed ? "▸" : "▾"}</span>
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
