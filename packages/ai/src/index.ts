import { AiClient, jsonOf, textOf } from "./client.js";
import type { ZamAIOptions } from "./client.js";
import { runAgent } from "./agent.js";
import type { RunAgentInput } from "./agent.js";
import { healDesktopSelector, healSelector, suggestSelectors } from "./selectors.js";
import { generateWorkflow } from "./workflow-gen.js";
import { diagnoseRun } from "./diagnose.js";
import type { DiagnoseInput } from "./diagnose.js";
import { answerHelp, translateDoc } from "./help.js";
import type { DocText, HelpChatInput } from "./help.js";
import type { GenerateWorkflowInput } from "./workflow-gen.js";
import { generateTests } from "./test-gen.js";
import { readDocument } from "./documents.js";
import type { ReadDocumentInput } from "./documents.js";
import type { GenerateTestsInput } from "./test-gen.js";
import { describeSpot, lookAtScreen } from "./vision.js";
import type { DescribeSpotInput, VisionInput } from "./vision.js";

export * from "./client.js";
export type { AgentTool, RunAgentInput, RunAgentResult } from "./agent.js";
export type { DesktopSelectorCandidate, SelectorCandidate, SelectorSuggestion } from "./selectors.js";
export type { GenerateWorkflowInput, GenerateWorkflowResult } from "./workflow-gen.js";
export type { DiagnoseInput, Diagnosis, Fix } from "./diagnose.js";
export type { DocText, HelpChatInput } from "./help.js";
export type { GenerateTestsInput, GenerateTestsResult, GeneratedTest, SitePage, TestKind } from "./test-gen.js";
export { TEST_KINDS } from "./test-gen.js";
export { checkTests } from "./test-gen.js";
export { DOCUMENT_MEDIA_TYPES, DOCUMENT_PRESETS, parseFieldList } from "./documents.js";
export type { DocumentField, DocumentFieldType, ReadDocumentInput, ReadDocumentResult } from "./documents.js";
export type { DescribeSpotInput, DescribeSpotResult, VisionInput, VisionResult, VisionTask } from "./vision.js";

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

  healDesktopSelector(input: Parameters<typeof healDesktopSelector>[1]) {
    return healDesktopSelector(this.client, input);
  }

  generateWorkflow(input: GenerateWorkflowInput) {
    return generateWorkflow(this.client, input);
  }

  /** Writes test cases for a website from the pages the agent explored. */
  generateTests(input: GenerateTestsInput) {
    return generateTests(this.client, input);
  }

  /** Finds why a run failed, from its evidence, and proposes fixes. */
  diagnoseRun(input: DiagnoseInput) {
    return diagnoseRun(this.client, input);
  }

  /** A docs section in another language. */
  translateDoc(input: DocText & { language: string }) {
    return translateDoc(this.client, input);
  }

  /** Reads the fields of a document (PDF or image), with how sure it is of each. */
  readDocument(input: ReadDocumentInput) {
    return readDocument(this.client, input);
  }

  /** AI Vision: finds, reads or checks something on a screenshot. */
  lookAtScreen(input: VisionInput) {
    return lookAtScreen(this.client, input);
  }

  /** Indicate for AI Vision: what is at the spot the person clicked, in words, checked against the screen. */
  describeSpot(input: DescribeSpotInput) {
    return describeSpot(this.client, input);
  }

  /** The help assistant's answer, from the docs. */
  answerHelp(input: HelpChatInput) {
    return answerHelp(this.client, input);
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
