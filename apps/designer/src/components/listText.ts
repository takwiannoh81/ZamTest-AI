import type { TargetList } from "@zamtest/core";
import type { MessageKey } from "@zamtest/i18n";

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

/** A step's list in plain words, e.g. "The first of 17 similar items, skipping the marked ones". */
export function listSummary(t: Translate, list: TargetList): string {
  const base = t(`list.summary.${list.which}` as MessageKey, { count: list.count ?? "?" });
  const rules: string[] = [];
  if (list.skipIfHas) rules.push(t("list.rule.skipHas"));
  if (list.onlyText) rules.push(t("list.rule.only", { text: list.onlyText }));
  if (list.skipText) rules.push(t("list.rule.skipText", { text: list.skipText }));
  return rules.length ? `${base}, ${rules.join(", ")}` : base;
}
