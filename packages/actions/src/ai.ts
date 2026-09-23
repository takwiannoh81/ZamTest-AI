import { AiNotConfiguredError } from "@zamtest/ai";
import type { AgentTool, ZamAI } from "@zamtest/ai";
import type { ActionContext, ActionHandler, ActionMeta, PropDef } from "@zamtest/core";
import { stringify } from "@zamtest/core";
import { hasPage, getPage, MAX_DOM_CHARS, snapshotDom } from "./browser.js";

/** The host puts a ZamAI instance in `services.ai` when AI is configured. */
export function getAi(ctx: ActionContext, required = true): ZamAI | undefined {
  const ai = ctx.services.ai as ZamAI | undefined;
  if (!ai && required) throw new AiNotConfiguredError();
  return ai;
}

const HIDDEN_FROM_AGENT = new Set(["output", "aiHeal"]);

function propSchema(p: PropDef): Record<string, unknown> {
  const base: Record<string, unknown> = { description: p.description ?? p.label };
  switch (p.type) {
    case "number":
      return { ...base, type: "number" };
    case "boolean":
      return { ...base, type: "boolean" };
    case "enum":
      return { ...base, type: "string", enum: p.options ?? [] };
    case "json":
      return base;
    case "selector":
      return { ...base, type: "string", description: `${base.description}. Playwright selector, e.g. css=#id, role=button[name="Save"], text="Next"` };
    default:
      return { ...base, type: "string" };
  }
}

/** Turns catalog actions into tools an AI agent can call. */
export function actionTools(ctx: ActionContext, allowed?: string[]): AgentTool[] {
  const metas = ctx.catalog.filter((a: ActionMeta) => a.agentTool && (!allowed?.length || allowed.includes(a.type)));
  const tools: AgentTool[] = metas.map((meta) => {
    const props = meta.props.filter((p) => !HIDDEN_FROM_AGENT.has(p.name));
    const defaults = Object.fromEntries(meta.props.filter((p) => p.default !== undefined).map((p) => [p.name, p.default]));
    return {
      name: meta.type.replace(/\./g, "_"),
      description: `${meta.displayName}: ${meta.description}`,
      input_schema: {
        type: "object",
        properties: Object.fromEntries(props.map((p) => [p.name, propSchema(p)])),
        required: props.filter((p) => p.required).map((p) => p.name),
      },
      run: (input) => ctx.invoke(meta.type, { ...defaults, ...input }),
    };
  });

  const browserAllowed = !allowed?.length || allowed.some((t) => t.startsWith("browser."));
  if (browserAllowed) {
    tools.push({
      name: "browser_snapshot",
      description:
        "Returns the current page URL, title and a condensed DOM of the open browser. Call this before choosing selectors.",
      input_schema: { type: "object", properties: {}, required: [] },
      run: async () => {
        if (!hasPage(ctx)) return "No browser is open.";
        const page = getPage(ctx);
        const { html, truncated } = await snapshotDom(page, 60_000);
        return `URL: ${page.url()}\nTitle: ${await page.title()}\n${truncated ? "(DOM truncated to 60000 characters)\n" : ""}${html}`;
      },
    });
  }
  return tools;
}

export const aiHandlers: Record<string, ActionHandler> = {
  "ai.prompt": (props, ctx) =>
    getAi(ctx)!.prompt({ prompt: stringify(props.prompt), system: props.system ? stringify(props.system) : undefined }),

  "ai.extract": (props, ctx) => {
    const schema = typeof props.schema === "string" ? JSON.parse(props.schema) : props.schema;
    if (!schema || typeof schema !== "object") throw new Error("AI Extract needs a JSON Schema object");
    return getAi(ctx)!.extract({
      input: stringify(props.input),
      schema: schema as Record<string, unknown>,
      instructions: props.instructions ? stringify(props.instructions) : undefined,
    });
  },

  "ai.agent": async (props, ctx) => {
    const allowed = Array.isArray(props.tools) ? props.tools.map(String) : undefined;
    const tools = actionTools(ctx, allowed);
    ctx.log("info", `AI agent started with ${tools.length} tools (DOM limit ${MAX_DOM_CHARS} chars)`);
    const result = await getAi(ctx)!.runAgent({
      goal: stringify(props.goal),
      tools,
      maxSteps: Number(props.maxSteps ?? 20),
      signal: ctx.signal,
      onLog: (message, data) => ctx.log("info", message, data),
    });
    if (!result.finished) ctx.log("warn", result.answer);
    return result.answer;
  },
};
