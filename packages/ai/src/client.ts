import Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages";

export const DEFAULT_MODEL = "claude-opus-5";

/** Models that support the server-side refusal fallback (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(["claude-opus-5", "claude-fable-5-1"]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface ZamAIOptions {
  apiKey?: string;
  model?: string;
  /** Pre-built client (useful for tests). */
  client?: Anthropic;
}

export class AiNotConfiguredError extends Error {
  constructor() {
    super("AI features need ANTHROPIC_API_KEY (or an `ant auth login` profile) on this machine.");
    this.name = "AiNotConfiguredError";
  }
}

export class AiRefusalError extends Error {
  constructor(public readonly category?: string | null) {
    super(`Claude declined this request${category ? ` (${category})` : ""}.`);
    this.name = "AiRefusalError";
  }
}

/** An error answered by Anthropic's API (bad key, rate limit, overload...); `status` is its HTTP status. */
export const AiApiError = Anthropic.APIError;

export type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
export type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type CreateParams = Omit<MessageCreateParamsNonStreaming, "model"> & { model?: string };

/** Thin wrapper around the Anthropic SDK shared by every AI feature. */
export class AiClient {
  readonly model: string;
  readonly anthropic: Anthropic;

  constructor(options: ZamAIOptions = {}) {
    this.model = options.model || process.env.ZAMTEST_AI_MODEL || DEFAULT_MODEL;
    this.anthropic = options.client ?? new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});
  }

  static isConfigured(): boolean {
    return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
  }

  /**
   * Streams a request and returns the final message. Streaming avoids HTTP
   * timeouts on long generations (workflow generation, agents with thinking).
   */
  async create(params: CreateParams): Promise<BetaMessage> {
    const model = params.model ?? this.model;
    const useFallbacks = FALLBACK_MODELS.has(model);
    const request = {
      ...params,
      model,
      ...(useFallbacks ? { fallbacks: "default" as const, betas: [...(params.betas ?? []), FALLBACK_BETA] } : {}),
    };
    const message = await this.anthropic.beta.messages.stream(request).finalMessage();
    if (message.stop_reason === "refusal") {
      throw new AiRefusalError(message.stop_details?.category ?? null);
    }
    return message;
  }
}

export function textOf(message: BetaMessage): string {
  return message.content
    .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** Returns the parsed JSON from a structured-output (`output_config.format`) response. */
export function jsonOf<T>(message: BetaMessage): T {
  if (message.stop_reason === "max_tokens") {
    throw new Error("AI response was cut off before the JSON was complete (max_tokens).");
  }
  return JSON.parse(textOf(message)) as T;
}

/** Extracts the first JSON value from free-form text (fenced ```json block or bare). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.search(/[[{]/);
  if (start < 0) throw new Error("No JSON found in AI response");
  const open = candidate[start];
  const close = open === "{" ? "}" : "]";
  const end = candidate.lastIndexOf(close);
  if (end < start) throw new Error("Unterminated JSON in AI response");
  return JSON.parse(candidate.slice(start, end + 1));
}
