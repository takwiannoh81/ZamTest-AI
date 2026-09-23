import type { MessageKey } from "./locales/en.js";

export type UiMessages = Record<MessageKey, string>;

/** A translation bundle. `ui` must be complete (the compiler checks it); `catalog` is checked by tests. */
export interface LocaleMessages {
  ui: UiMessages;
  /** Keys produced by `catalogKeys()`: action names, descriptions, prop labels, categories. */
  catalog: Record<string, string>;
}
