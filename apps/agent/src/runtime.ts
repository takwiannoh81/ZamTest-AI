import { builtinHandlers } from "@zamtest/actions";
import type { QueueService } from "@zamtest/actions";
import { AiClient, ZamAI } from "@zamtest/ai";
import { BUILTIN_ACTIONS, runWorkflow } from "@zamtest/core";
import type { AfterStepInfo, EngineEvent, EngineServices, RunResult, Workflow } from "@zamtest/core";

export interface ExecuteOptions {
  inputs?: Record<string, unknown>;
  signal?: AbortSignal;
  onEvent?: (event: EngineEvent) => void;
  getAsset?: (name: string) => Promise<unknown>;
  queues?: QueueService;
  /** After each action step (see RunOptions.afterStep), e.g. to take a screenshot. */
  afterStep?: (info: AfterStepInfo) => unknown | Promise<unknown>;
}

let ai: ZamAI | null | undefined;
function sharedAi(): ZamAI | null {
  if (ai === undefined) ai = AiClient.isConfigured() ? new ZamAI() : null;
  return ai;
}

/** Runs a workflow with every built-in action and (when configured) AI services. */
export function execute(workflow: Workflow, options: ExecuteOptions = {}): Promise<RunResult> {
  const services: EngineServices = { getAsset: options.getAsset, queues: options.queues };
  const aiService = sharedAi();
  if (aiService) services.ai = aiService;
  return runWorkflow(workflow, {
    handlers: builtinHandlers,
    catalog: BUILTIN_ACTIONS,
    inputs: options.inputs,
    signal: options.signal,
    services,
    onEvent: options.onEvent,
    afterStep: options.afterStep,
  });
}

export function aiEnabled(): boolean {
  return sharedAi() !== null;
}
