/**
 * AI Vision for bots: a step sends a screenshot and what to find, read or check;
 * AI answers here, so bot PCs need no AI of their own. Each look counts as one AI
 * request of the plan. Screenshots are not kept.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZamAI } from "@zamtest/ai";
import { z } from "zod";
import { parse } from "./errors.js";
import { HttpError } from "./jobs.js";
import { useAi } from "./plans.js";
import type { Store } from "./store.js";
import type { Agent } from "./types.js";

/** A screenshot as base64 JPEG or PNG (about 1456 x 816 is enough). */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

const LookBody = z.object({
  agentId: z.string().optional(),
  jobId: z.string().optional(),
  task: z.enum(["locate", "read", "check"]),
  target: z.string().trim().min(1, "Say what to look for").max(2000),
  image: z.string().min(1),
  mediaType: z.enum(["image/jpeg", "image/png"]),
  width: z.number().int().positive().max(10_000),
  height: z.number().int().positive().max(10_000),
  language: z.string().max(40).optional(),
});

export interface VisionContext {
  store: Store;
  getAi(): ZamAI;
  agentFor(req: FastifyRequest): Agent;
}

export function registerVision(app: FastifyInstance, ctx: VisionContext) {
  app.post("/api/agent/vision", { bodyLimit: Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 64 * 1024 }, async (req) => {
    const agent = ctx.agentFor(req);
    const body = parse(LookBody, req.body);
    const image = Buffer.from(body.image, "base64");
    if (image.length > MAX_IMAGE_BYTES) throw new HttpError(413, "The screenshot is too large");
    const ai = ctx.getAi();
    useAi(ctx.store, agent.workspaceId);
    ctx.store.save();
    return ai.lookAtScreen({
      task: body.task,
      target: body.target,
      image,
      mediaType: body.mediaType,
      width: body.width,
      height: body.height,
      language: body.language,
    });
  });
}
