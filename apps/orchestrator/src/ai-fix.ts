/**
 * "Fix with AI" with evidence: the failed run's log, its step screenshots, the
 * account's assets (names only), the PC, and (when the Designer asked the PC
 * first) the application window's live controls and the screen. Claude finds
 * the cause and proposes fixes the Designer can apply.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { WorkflowSchema } from "@zamtest/core";
import type { Workflow } from "@zamtest/core";
import type { ZamAI } from "@zamtest/ai";
import { languageName } from "@zamtest/i18n";
import { effectiveEnv, environmentsOn } from "./cicd.js";
import { HttpError, parse } from "./errors.js";
import type { Recordings } from "./recordings.js";
import type { ScreenshotStore } from "./screenshots.js";
import type { Store } from "./store.js";
import type { Principal } from "./types.js";

/** Screenshots Claude sees: the failed step's and the ones just before it. */
const MAX_SCREENSHOTS = 3;

export interface AiFixContext {
  store: Store;
  screenshots: ScreenshotStore;
  getAi(): ZamAI;
  useAi(workspaceId: string): void;
  me(req: FastifyRequest): Principal;
  own<T extends { workspaceId: string }>(collection: Record<string, T>, id: string, what: string, req: FastifyRequest): T;
  recordings: Recordings;
}

/** An inspect's result as the AI takes it. */
export function liveOf(recordings: Recordings, id: string | undefined, workspaceId: string) {
  if (!id) return undefined;
  const r = recordings.get(id, workspaceId);
  if (!r?.inspected) throw new HttpError(404, "The look at the PC's application has expired; try again");
  const { selector, found, tree, screen } = r.inspected;
  return { selector, found, tree, screen: screen ? Buffer.from(screen, "base64") : undefined };
}

export function registerAiFix(app: FastifyInstance, ctx: AiFixContext): void {
  const { store } = ctx;

  app.post("/api/ai/diagnose", async (req) => {
    const ai = ctx.getAi();
    const body = parse(
      z.object({
        jobId: z.string().min(1),
        /** The workflow as it is in the Designer now (it may have changed since the run). */
        workflow: WorkflowSchema.optional(),
        /** An "inspect" of the application window, done just before. */
        inspectId: z.string().optional(),
        previousAttempts: z.array(z.string().max(2000)).max(5).optional(),
        language: z.string().optional(),
      }),
      req.body,
    );
    const job = ctx.own(store.data.jobs, body.jobId, "Job", req);
    if (job.status !== "failed") throw new HttpError(409, "Only a failed run can be diagnosed");
    const workspaceId = job.workspaceId;
    ctx.useAi(workspaceId);

    const logs = store.data.jobLogs[job.id] ?? [];
    // The first step error is where it started (the containers around it fail after it).
    const rootId = job.definition?.root.id;
    const failedStepId = logs.find((l) => l.level === "error" && l.stepId && l.stepId !== rootId)?.stepId;
    const shots = ctx.screenshots.list(job.id);
    const failedAt = failedStepId ? shots.map((s) => s.stepId).lastIndexOf(failedStepId) : -1;
    const upTo = failedAt >= 0 ? failedAt + 1 : shots.length;
    const screenshots = shots
      .slice(Math.max(0, upTo - MAX_SCREENSHOTS), upTo)
      .map((s) => ({ entry: s, jpeg: ctx.screenshots.read(job.id, s.seq) }))
      .filter((s): s is { entry: typeof s.entry; jpeg: Buffer } => Boolean(s.jpeg))
      .map(({ entry, jpeg }) => ({ stepId: entry.stepId, label: entry.label, status: entry.status, jpeg }));

    const agent = job.agentId ? store.data.agents[job.agentId] : undefined;
    const envs = environmentsOn(store, workspaceId);
    return ai.diagnoseRun({
      workflow: (body.workflow as Workflow | undefined) ?? job.definition,
      error: job.error ?? "The run failed",
      failedStepId,
      logs,
      screenshots,
      assets: Object.values(store.data.assets)
        .filter((a) => a.workspaceId === workspaceId)
        .map((a) => ({ name: a.name, type: a.type, environment: a.environment })),
      pc: agent && {
        name: agent.name,
        os: agent.os,
        version: agent.version,
        environment: envs ? effectiveEnv(store, workspaceId, agent.environment) : undefined,
      },
      environment: envs ? effectiveEnv(store, workspaceId, job.environment) : undefined,
      live: liveOf(ctx.recordings, body.inspectId, workspaceId),
      previousAttempts: body.previousAttempts,
      language: body.language ? languageName(body.language) : undefined,
    });
  });
}
