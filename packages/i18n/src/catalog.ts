import { BUILTIN_ACTIONS } from "@zamtest/core";
import type { ActionMeta } from "@zamtest/core";

/** Translation keys for the action catalog. */
export const catalogKey = {
  category: (category: string) => `category:${category}`,
  name: (type: string) => `action:${type}:name`,
  description: (type: string) => `action:${type}:description`,
  propLabel: (type: string, prop: string) => `action:${type}:prop:${prop}:label`,
  propDescription: (type: string, prop: string) => `action:${type}:prop:${prop}:description`,
};

/** English source text for every translatable catalog string. */
export function catalogSource(catalog: ActionMeta[] = BUILTIN_ACTIONS): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of catalog) {
    out[catalogKey.category(a.category)] = a.category;
    out[catalogKey.name(a.type)] = a.displayName;
    out[catalogKey.description(a.type)] = a.description;
    for (const p of a.props) {
      out[catalogKey.propLabel(a.type, p.name)] = p.label;
      if (p.description) out[catalogKey.propDescription(a.type, p.name)] = p.description;
    }
  }
  return out;
}
