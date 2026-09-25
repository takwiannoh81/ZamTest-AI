/**
 * Dynamic targets: a step that points at "an item of a list" instead of one fixed
 * element, e.g. "the first camera that is not offline". Kept in the step's
 * `list` prop (its `selector` stays the one item that was indicated). Works for
 * web pages (Playwright selectors) and Windows applications (desktop selectors).
 */
import { z } from "zod";

export interface TargetList {
  /** Matches every item of the list (e.g. every camera row). */
  items: string;
  /** Inside the chosen item: the part to act on (e.g. its name). Unset: the item itself. */
  inner?: string;
  /** Items that contain this (e.g. the offline icon) are skipped. */
  skipIfHas?: string;
  /** Only items whose text contains this (not case-sensitive). */
  onlyText?: string;
  /** Items whose text contains this are skipped (not case-sensitive). */
  skipText?: string;
  /** Which of the remaining items: the first, the last, any one, or each in turn until the step works. */
  which: "first" | "last" | "random" | "next";
  /** How many items matched when it was indicated (shown in the Designer). */
  count?: number;
  /** How many of them the skip rule matched when it was indicated. */
  skipCount?: number;
}

export const TargetListSchema: z.ZodType<TargetList> = z.object({
  items: z.string().min(1),
  inner: z.string().optional(),
  skipIfHas: z.string().optional(),
  onlyText: z.string().optional(),
  skipText: z.string().optional(),
  which: z.enum(["first", "last", "random", "next"]).default("first"),
  count: z.number().int().optional(),
  skipCount: z.number().int().optional(),
}) as z.ZodType<TargetList>;

/** The step's list, if it has a usable one. */
export function targetListOf(props: Record<string, unknown>): TargetList | undefined {
  const parsed = TargetListSchema.safeParse(props.list);
  return parsed.success ? parsed.data : undefined;
}

/** Keeps the items an item's text allows (onlyText, skipText). */
export function textAllows(list: TargetList, text: string): boolean {
  const t = text.toLowerCase();
  if (list.onlyText && !t.includes(list.onlyText.toLowerCase())) return false;
  if (list.skipText && t.includes(list.skipText.toLowerCase())) return false;
  return true;
}

/** The order to try the remaining items in (their positions in the list). */
export function tryOrder(list: TargetList, positions: number[]): number[] {
  if (!positions.length) return [];
  switch (list.which) {
    case "last":
      return [positions.at(-1)!];
    case "random":
      return [positions[Math.floor(Math.random() * positions.length)]!];
    case "next":
      return positions;
    default:
      return [positions[0]!];
  }
}
