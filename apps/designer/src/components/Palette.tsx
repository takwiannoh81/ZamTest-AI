import { useI18n } from "@zamtest/i18n/react";
import { useMemo, useState } from "react";
import type { ActionMeta } from "@zamtest/core";
import { CATEGORY_COLORS, iconFor } from "./icons";

export const DRAG_ACTION = "application/x-zamtest-action";
export const DRAG_STEP = "application/x-zamtest-step";

export function Palette({ catalog, onAdd }: { catalog: ActionMeta[]; onAdd: (meta: ActionMeta) => void }) {
  const { t, actionName, actionDescription, category: categoryName } = useI18n();
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, ActionMeta[]>();
    for (const a of catalog) {
      const haystack = `${actionName(a)} ${actionDescription(a)} ${a.displayName} ${a.type}`.toLowerCase();
      if (q && !haystack.includes(q)) continue;
      map.set(a.category, [...(map.get(a.category) ?? []), a]);
    }
    return [...map.entries()];
  }, [catalog, query, actionName, actionDescription]);

  return (
    <aside className="palette">
      <input className="palette-search" placeholder={t("palette.search")} value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="palette-list">
        {groups.map(([category, items]) => (
          <div key={category} className="palette-group">
            <button className="palette-cat" onClick={() => setCollapsed({ ...collapsed, [category]: !collapsed[category] })}>
              <span className="dot" style={{ background: CATEGORY_COLORS[category] ?? "var(--muted)" }} />
              {categoryName(category)}
              <span className="muted">{collapsed[category] && !query ? "+" : "−"}</span>
            </button>
            {(!collapsed[category] || query) &&
              items.map((a) => (
                <div
                  key={a.type}
                  className="palette-item"
                  draggable
                  title={actionDescription(a)}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_ACTION, a.type);
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  onDoubleClick={() => onAdd(a)}
                >
                  <span className="palette-icon">{iconFor(a.icon)}</span>
                  <span>{actionName(a)}</span>
                  <button className="add-btn" title={t("palette.add")} onClick={() => onAdd(a)}>
                    +
                  </button>
                </div>
              ))}
          </div>
        ))}
      </div>
      <p className="palette-hint muted">{t("palette.hint")}</p>
    </aside>
  );
}
