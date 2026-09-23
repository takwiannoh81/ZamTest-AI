import { AiClient, jsonOf, textOf } from "./client.js";
import type { ZamAIOptions } from "./client.js";
import { runAgent } from "./agent.js";
import type { RunAgentInput } from "./agent.js";
import { healSelector, suggestSelectors } from "./selectors.js";
import { generateWorkflow } from "./workflow-gen.js";
import type { GenerateWorkflowInput } from "./workflow-gen.js";

export * from "./client.js";
export type { AgentTool, RunAgentInput, RunAgentResult } from "./agent.js";
export type { SelectorCandidate, SelectorSuggestion } from "./selectors.js";
export type { GenerateWorkflowInput, GenerateWorkflowResult } from "./workflow-gen.js";

/** Facade over every AI capability of the platform. */
export class ZamAI {
  readonly client: AiClient;

  constructor(options: ZamAIOptions = {}) {
    this.client = new AiClient(options);
  }

  get model(): string {
    return this.client.model;
  }

  suggestSelectors(input: Parameters<typeof suggestSelectors>[1]) {
    return suggestSelectors(this.client, input);
  }

  healSelector(input: Parameters<typeof healSelector>[1]) {
    return healSelector(this.client, input);
  }

  generateWorkflow(input: GenerateWorkflowInput) {
    return generateWorkflow(this.client, input);
  }

  runAgent(input: RunAgentInput) {
    return runAgent(this.client, input);
  }

  async prompt(input: { prompt: string; system?: string }): Promise<string> {
    const message = await this.client.create({
      max_tokens: 16000,
      ...(input.system ? { system: input.system } : {}),
      messages: [{ role: "user", content: input.prompt }],
    });
    return textOf(message);
  }

  /** Structured extraction: returns JSON that matches `schema`. */
  async extract(input: { input: string; schema: Record<string, unknown>; instructions?: string }): Promise<unknown> {
    const message = await this.client.create({
      max_tokens: 16000,
      system:
        "You extract structured data from business documents for an automation platform. Use null for values that are not present; never guess.",
      output_config: { effort: "medium", format: { type: "json_schema", schema: input.schema } },
      messages: [
        {
          role: "user",
          content: `${input.instructions ? `${input.instructions}\n\n` : ""}<document>\n${input.input}\n</document>`,
        },
      ],
    });
    return jsonOf(message);
  }
}
