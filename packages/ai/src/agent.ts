import type Anthropic from "@anthropic-ai/sdk";
import type { AiClient, BetaMessageParam } from "./client.js";
import { AiRefusalError, textOf } from "./client.js";

export interface AgentTool {
  name: string;
  description: string;
  input_schema: Anthropic.Beta.Messages.BetaTool.InputSchema;
  run: (input: Record<string, unknown>) => Promise<unknown>;
}

export interface RunAgentInput {
  goal: string;
  tools: AgentTool[];
  maxSteps?: number;
  context?: string;
  signal?: AbortSignal;
  onLog?: (message: string, data?: unknown) => void;
}

export interface RunAgentResult {
  answer: string;
  steps: number;
  finished: boolean;
}

const SYSTEM = `You are an automation agent running inside ZamTest AI, a robotic process automation platform.
You complete business tasks by calling the provided tools, which perform real actions (browser, HTTP, files).
Work carefully: inspect before acting, verify results, and do not repeat an action that already succeeded.
If a tool fails, read the error and adjust. Never invent data you did not observe.
When the goal is achieved (or cannot be achieved), stop calling tools and reply with a concise final answer.`;

function toResultContent(value: unknown): string {
  if (value === undefined) return "OK";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Agentic loop: Claude chooses which platform actions to run until the
 * goal is met. A manual loop (rather than the SDK tool runner) lets the bot
 * agent enforce step limits, cancellation and per-call logging.
 */
export async function runAgent(ai: AiClient, input: RunAgentInput): Promise<RunAgentResult> {
  const maxSteps = input.maxSteps ?? 20;
  const byName = new Map(input.tools.map((t) => [t.name, t]));
  const tools: Anthropic.Beta.Messages.BetaTool[] = input.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
  const messages: BetaMessageParam[] = [
    { role: "user", content: `${input.context ? `${input.context}\n\n` : ""}Goal: ${input.goal}` },
  ];

  for (let step = 1; step <= maxSteps; step++) {
    if (input.signal?.aborted) throw new Error("Agent cancelled");
    const response = await ai.create({
      max_tokens: 32000,
      system: SYSTEM,
      tools,
      output_config: { effort: "high" },
      messages,
    });
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "pause_turn") continue;
    if (response.stop_reason === "max_tokens") {
      throw new Error("AI agent response exceeded max_tokens");
    }

    const calls = response.content.filter(
      (b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use",
    );
    const thought = textOf(response);
    if (thought) input.onLog?.(`Agent: ${thought}`);
    if (calls.length === 0) {
      return { answer: thought, steps: step, finished: true };
    }

    // UI actions must not race each other, so tool calls run one at a time.
    const results: Anthropic.Beta.Messages.BetaToolResultBlockParam[] = [];
    for (const call of calls) {
      const tool = byName.get(call.name);
      input.onLog?.(`Agent -> ${call.name}`, call.input);
      if (!tool) {
        results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: `Unknown tool ${call.name}` });
        continue;
      }
      try {
        const output = await tool.run((call.input ?? {}) as Record<string, unknown>);
        results.push({ type: "tool_result", tool_use_id: call.id, content: toResultContent(output) });
      } catch (err) {
        if (err instanceof AiRefusalError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        input.onLog?.(`Agent tool ${call.name} failed: ${message}`);
        results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: message });
      }
    }
    messages.push({ role: "user", content: results });
  }

  return { answer: `Stopped after ${maxSteps} steps without finishing.`, steps: maxSteps, finished: false };
}
