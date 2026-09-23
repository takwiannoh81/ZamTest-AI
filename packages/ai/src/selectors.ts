import type { AiClient } from "./client.js";
import { jsonOf } from "./client.js";

export interface SelectorCandidate {
  selector: string;
  strategy: "testid" | "id" | "role" | "label" | "placeholder" | "text" | "css" | "xpath";
  confidence: number;
  reason: string;
}

export interface SelectorSuggestion {
  candidates: SelectorCandidate[];
}

const SELECTOR_SCHEMA = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          selector: { type: "string" },
          strategy: { type: "string", enum: ["testid", "id", "role", "label", "placeholder", "text", "css", "xpath"] },
          confidence: { type: "number" },
          reason: { type: "string" },
        },
        required: ["selector", "strategy", "confidence", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["candidates"],
  additionalProperties: false,
} as const;

const SYSTEM = `You write UI element selectors for an RPA platform that drives browsers with Playwright.

Selectors must use Playwright selector syntax, for example:
- css=[data-testid="submit"]      - css=#email      - css=form.login button[type=submit]
- role=button[name="Sign in"]      - text="Forgot password?"
- internal:label="Email address"   - xpath=//table[@id="orders"]//tr[2]/td[3]

Rank candidates by how likely they are to keep working after the page changes:
1. Stable test hooks (data-testid, data-test, data-qa) and meaningful, non-generated ids.
2. Accessible role + accessible name, or the associated label.
3. Short CSS anchored on stable attributes (name, type, aria-*).
4. Visible text (fragile under translation).
5. XPath / positional selectors only as a last resort.
Avoid auto-generated class names or ids (hashes, long digit runs, css-modules suffixes) and nth-child chains.
Each selector must match exactly one element in the provided DOM. Confidence is 0..1.
Return 1-4 candidates, best first.`;

/** Suggests robust selectors for an element described in plain language. */
export async function suggestSelectors(
  ai: AiClient,
  input: { html: string; description: string; url?: string; currentSelector?: string; language?: string },
): Promise<SelectorSuggestion> {
  const message = await ai.create({
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { effort: "medium", format: { type: "json_schema", schema: SELECTOR_SCHEMA } },
    messages: [
      {
        role: "user",
        content: [
          input.url ? `Page URL: ${input.url}` : "",
          input.currentSelector ? `Current selector: ${input.currentSelector}` : "",
          `Target element: ${input.description}`,
          input.language && input.language !== "English" ? `Write each "reason" in ${input.language}.` : "",
          "Page DOM (scripts, styles and SVG internals removed):",
          "<dom>",
          input.html,
          "</dom>",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  });
  return sortCandidates(jsonOf<SelectorSuggestion>(message));
}

/**
 * Self-healing: a selector stopped matching at run time. Given the element's
 * description and the live DOM, propose replacements.
 */
export async function healSelector(
  ai: AiClient,
  input: { failedSelector: string; description?: string; html: string; url?: string; error?: string },
): Promise<SelectorSuggestion> {
  const message = await ai.create({
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { effort: "medium", format: { type: "json_schema", schema: SELECTOR_SCHEMA } },
    messages: [
      {
        role: "user",
        content: [
          "A selector in a running automation no longer finds its element. Find the element it was meant to target in the current DOM and propose replacement selectors.",
          input.url ? `Page URL: ${input.url}` : "",
          `Broken selector: ${input.failedSelector}`,
          input.description ? `The element is described as: ${input.description}` : "",
          input.error ? `Error: ${input.error}` : "",
          "If no element in the DOM plausibly matches, return an empty candidates list.",
          "<dom>",
          input.html,
          "</dom>",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  });
  return sortCandidates(jsonOf<SelectorSuggestion>(message));
}

function sortCandidates(s: SelectorSuggestion): SelectorSuggestion {
  return { candidates: [...(s.candidates ?? [])].sort((a, b) => b.confidence - a.confidence) };
}

/* ------------------------------------------------------------------ */
/* Desktop (Windows UI Automation) selectors                           */
/* ------------------------------------------------------------------ */

export interface DesktopSelectorCandidate {
  selector: string;
  confidence: number;
  reason: string;
}

const DESKTOP_SCHEMA = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: { selector: { type: "string" }, confidence: { type: "number" }, reason: { type: "string" } },
        required: ["selector", "confidence", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["candidates"],
  additionalProperties: false,
} as const;

const DESKTOP_SYSTEM = `You write selectors for Windows desktop applications in an RPA platform that uses Microsoft UI Automation.

Selector grammar (CSS-like):
- Segments separated by ">" ; each segment is searched among all descendants of the previous match. The first segment matches top-level windows.
- A segment is a lower-case control type (window, pane, button, edit, document, text, checkbox, radiobutton, combobox, list, listitem, menu, menubar, menuitem, tab, tabitem, tree, treeitem, datagrid, dataitem, table, header, headeritem, hyperlink, image, group, toolbar, statusbar, titlebar, custom, ...) or *.
- Attributes: [name="..."] (UI Automation Name), [id="..."] (AutomationId), [class="..."] (ClassName), [process="..."] (process name without .exe, first segment only), [index=N] (1-based among matches).
- Operators: = exact, ~= contains, ^= starts with, $= ends with. Case-insensitive.

Examples:
  window[process="notepad"] > document
  window[name$=" - Notepad"] > menuitem[name="File"]
  window[process="calculatorapp"] > button[id="num7Button"]
  window[process="saplogon"] > edit[name="User"]

Rank candidates by how likely they are to keep working:
1. A stable AutomationId (not a number, not a GUID).
2. The Name of the element, anchored in a window matched by process.
3. ClassName or an ancestor with a stable id, then [index=N] only as a last resort.
Window titles often contain a document name ("report.txt - Notepad"): match the stable part with $= or use process.
Each selector must match exactly one element in the tree shown. Confidence is 0..1. Return 1-4 candidates, best first.`;

/** Desktop self-healing: proposes replacements for a broken desktop selector from the live UI Automation tree. */
export async function healDesktopSelector(
  ai: AiClient,
  input: { failedSelector: string; description?: string; tree: string; error?: string },
): Promise<{ candidates: DesktopSelectorCandidate[] }> {
  const message = await ai.create({
    max_tokens: 16000,
    system: DESKTOP_SYSTEM,
    output_config: { effort: "medium", format: { type: "json_schema", schema: DESKTOP_SCHEMA } },
    messages: [
      {
        role: "user",
        content: [
          "A selector in a running desktop automation no longer finds its element. Find the element it was meant to target in the current UI Automation tree and propose replacement selectors.",
          `Broken selector: ${input.failedSelector}`,
          input.description ? `The element is described as: ${input.description}` : "",
          input.error ? `Error: ${input.error}` : "",
          "If no element plausibly matches, return an empty candidates list.",
          "UI Automation tree (indentation = nesting; top-level lines are windows with their process):",
          "<tree>",
          input.tree,
          "</tree>",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  });
  const result = jsonOf<{ candidates: DesktopSelectorCandidate[] }>(message);
  return { candidates: [...(result.candidates ?? [])].sort((a, b) => b.confidence - a.confidence) };
}
