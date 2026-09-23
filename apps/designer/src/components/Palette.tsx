import { useMemo, useState } from "react";
import type { ActionMeta } from "@zamtest/core";
import { CATEGORY_COLORS, iconFor } from "./icons";

export const DRAG_ACTION = "application/x-zamtest-action";
export const DRAG_STEP = "application/x-zamtest-step";

export function Palette({ catalog, onAdd }: { catalog: ActionMeta[]; onAdd: (meta: ActionMeta) => void }) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, ActionMeta[]>();
    for (const a of catalog) {
      if (q && !`${a.displayName} ${a.description} ${a.type}`.toLowerCase().includes(q)) continue;
      map.set(a.category, [...(map.get(a.category) ?? []), a]);
    }
    return [...map.entries()];
  }, [catalog, query]);

  return (
    <aside className="palette">
      <input className="palette-search" placeholder="Search actions..." value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="palette-list">
        {groups.map(([category, items]) => (
          <div key={category} className="palette-group">
            <button className="palette-cat" onClick={() => setCollapsed({ ...collapsed, [category]: !collapsed[category] })}>
              <span className="dot" style={{ background: CATEGORY_COLORS[category] ?? "var(--muted)" }} />
              {category}
              <span className="muted">{collapsed[category] && !query ? "+" : "−"}</span>
            </button>
            {(!collapsed[category] || query) &&
              items.map((a) => (
                <div
                  key={a.type}
                  className="palette-item"
                  draggable
                  title={a.description}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_ACTION, a.type);
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  onDoubleClick={() => onAdd(a)}
                >
                  <span className="palette-icon">{iconFor(a.icon)}</span>
                  <span>{a.displayName}</span>
                  <button className="add-btn" title="Add to workflow" onClick={() => onAdd(a)}>
                    +
                  </button>
                </div>
              ))}
          </div>
        ))}
      </div>
      <p className="palette-hint muted">Drag onto the canvas, or click + to add after the selected step.</p>
    </aside>
  );
}
