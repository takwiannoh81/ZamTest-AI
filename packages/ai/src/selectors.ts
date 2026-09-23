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
