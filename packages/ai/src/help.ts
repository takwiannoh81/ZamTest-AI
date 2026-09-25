import type { AiClient, BetaMessageParam } from "./client.js";
import { jsonOf, textOf } from "./client.js";

/**
 * Help for people using the platform: the docs in their language, and a help
 * assistant that answers from the docs. A lighter model than for building
 * workflows: it is fast and these tasks do not need more.
 */
export const HELP_MODEL = process.env.ZAMTEST_HELP_MODEL || "claude-sonnet-5";

export interface DocText {
  title: string;
  summary: string;
  body: string;
}

const TRANSLATION_SCHEMA = {
  type: "object",
  properties: { title: { type: "string" }, summary: { type: "string" }, body: { type: "string" } },
  required: ["title", "summary", "body"],
  additionalProperties: false,
} as const;

/** Translates one docs section (Markdown) into a language, keeping its formatting. */
export async function translateDoc(ai: AiClient, input: DocText & { language: string }): Promise<DocText> {
  const message = await ai.create({
    model: HELP_MODEL,
    max_tokens: 16000,
    system: `You translate the documentation of ZamTech AI, a low-code automation platform, for its users.
Translate into ${input.language}, naturally and precisely, for business users.
- Keep the Markdown exactly: headings, lists, bold, \`code\`, links (translate the link text, not the URL).
- Do not translate: product names (ZamTech AI, Portal, Designer, ZamTech AI Agent), anything in \`code\`, selectors,
  expressions, URLs, keyboard keys (Esc, F2, Enter), file names and example values.
- Names of buttons, menus and fields: translate them the way a ${input.language} user interface would name them.
Return the translated title, summary and body.`,
    output_config: { effort: "low", format: { type: "json_schema", schema: TRANSLATION_SCHEMA } },
    messages: [{ role: "user", content: JSON.stringify({ title: input.title, summary: input.summary, body: input.body }) }],
  });
  return jsonOf<DocText>(message);
}

export interface HelpChatInput {
  /** The whole documentation (English Markdown), the source of the answers. */
  docs: string;
  /** The conversation so far, the person's question last. */
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  /** English name of the person's language. */
  language?: string;
  /** Where they are asking from, e.g. "the Designer, editing a test case". */
  where?: string;
  /** Where people get more help (support email), if there is one. */
  support?: string;
  /** A visitor of the public website (no account yet): what the product does, plans and prices, how to start. */
  visitor?: { pricing: string; signupUrl: string; siteUrl?: string };
}

/** Answers a question about using the platform, from the docs. */
export async function answerHelp(ai: AiClient, input: HelpChatInput): Promise<string> {
  const language = input.language ?? "English";
  const message = await ai.create({
    model: HELP_MODEL,
    max_tokens: 4000,
    system: [
      {
        type: "text",
        text: `${
          input.visitor
            ? `You are the assistant on the public website of ZamTech AI, a low-code RPA and test automation platform (Portal, Designer, and the ZamTech AI Agent on Windows PCs).
You talk with visitors who do not have an account yet: explain what the platform does and how it would help them, answer questions about features, plans and prices, and when they are interested, invite them to start for free: ${input.visitor.signupUrl}
Be warm and helpful, not pushy. Plans and prices (use only these; say prices can change and the Pricing section of the website is current):
${input.visitor.pricing}`
            : `You are the help assistant inside ZamTech AI, a low-code RPA and test automation platform (Portal, Designer, and the ZamTech AI Agent on Windows PCs).
You help people use the platform: explain features, walk them through tasks step by step, and help with problems.`
        }

Rules:
- Answer from the documentation below. If it does not cover the question, say so plainly and suggest ${input.support ? `contacting us at ${input.support}` : input.visitor ? "starting a free account to try it" : "asking their administrator"}; never invent features, buttons, limits or prices.
- Be concise and practical: short paragraphs, numbered steps for tasks, names of buttons and menus in **bold**.
- Answer in ${language}. Translate button and menu names the way the ${language} interface names them.
- Only help with ZamTech AI and automation or testing questions; politely decline anything else.
- Never ask for passwords, API keys or other secrets; tell people to enter them in the product (e.g. as an asset).

<documentation>
${input.docs}
</documentation>`,
        // The docs are the same for every question: cached, so follow-up questions cost little.
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      ...(input.where ? [{ role: "user" as const, content: `(Context: I am in ${input.where}.)` }, { role: "assistant" as const, content: "Understood." }] : []),
      ...input.messages.map((m): BetaMessageParam => ({ role: m.role, content: m.content })),
    ],
  });
  return textOf(message);
}
