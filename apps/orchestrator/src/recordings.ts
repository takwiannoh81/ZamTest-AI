/**
 * Recording from the Designer: the Designer asks for a recording on a PC, the
 * PC's agent (which checks every few seconds) opens the browser or program and
 * records there, sending the steps as they happen; the Designer shows them live
 * and asks it to stop. "Indicate" goes the same way: the person clicks the
 * application on the PC and its path comes back. Recordings are short-lived and
 * kept in memory only.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { StepSchema, VariableDefSchema } from "@zamtest/core";
import type { Step, VariableDef } from "@zamtest/core";
import { HttpError, parse } from "./errors.js";
import { newId, nowIso } from "./store.js";
import type { Store } from "./store.js";
import type { Agent, Principal } from "./types.js";

export interface Recording {
  id: string;
  workspaceId: string;
  agentId: string;
  agentName: string;
  kind: "web" | "desktop" | "indicate";
  /** Web: where the browser starts. */
  url?: string;
  /** Desktop: the program to start and record (unset: whatever application is used). */
  program?: string;
  /** Desktop: the program is already open (it was indicated), so it is not started again. */
  attach?: boolean;
  /** Indicate: the instruction shown on the PC's screen. */
  hint?: string;
  /** Indicate: the application clicked (unset when the person pressed Esc or did not click in time). */
  picked?: { path: string; process: string; title: string };
  status: "pending" | "recording" | "stopping" | "done" | "failed" | "cancelled";
  requestedBy: string;
  requestedAt: string;
  updatedAt: string;
  steps: Step[];
  variables: VariableDef[];
  error?: string;
}

const ACTIVE: Recording["status"][] = ["pending", "recording", "stopping"];
/** A PC that has not taken a pending recording in this long is not coming. */
const PICKUP_TIMEOUT_MS = 60_000;
/** Recordings are forgotten this long after they end. */
const KEEP_MS = 30 * 60_000;

/** Agents before this version do not know "indicate" (they would record the whole desktop instead). */
const INDICATE_SINCE = [0, 3, 1];
export function canIndicate(version: string | undefined): boolean {
  const parts = (version ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < INDICATE_SINCE.length; i++) {
    if ((parts[i] ?? 0) !== INDICATE_SINCE[i]) return (parts[i] ?? 0) > INDICATE_SINCE[i]!;
  }
  return true;
}

export interface RecordingContext {
  store: Store;
  me(req: FastifyRequest): Principal;
  own<T extends { workspaceId: string }>(collection: Record<string, T>, id: string, what: string, req: FastifyRequest): T;
  who(p: Principal): string;
  agentFor(req: FastifyRequest): Agent;
}

export function registerRecordings(app: FastifyInstance, ctx: RecordingContext): void {
  const { store } = ctx;
  const recordings = new Map<string, Recording>();
  /** Agents that can record (they ask for recordings; older agents never do), and when they last asked. */
  const recorders = new Map<string, number>();

  const prune = () => {
    const now = Date.now();
    for (const r of recordings.values()) {
      if (r.status === "pending" && now - Date.parse(r.requestedAt) > PICKUP_TIMEOUT_MS) {
        r.status = "failed";
        r.error = "The PC did not start the recording. Is the ZamTech AI agent running on it (and version 0.3.0 or newer)?";
        r.updatedAt = nowIso();
      }
      if (!ACTIVE.includes(r.status) && now - Date.parse(r.updatedAt) > KEEP_MS) recordings.delete(r.id);
    }
  };
  const mine = (req: FastifyRequest, id: string) => {
    prune();
    const r = recordings.get(id);
    if (!r || r.workspaceId !== ctx.me(req).workspaceId) throw new HttpError(404, `Recording ${id} not found`);
    return r;
  };

  /* ---------- the Designer ---------- */
  /** PCs that could record now: online, and with an agent that records. */
  app.get("/api/recordings/agents", async (req) => {
    const workspaceId = ctx.me(req).workspaceId;
    return Object.values(store.data.agents)
      .filter((a) => a.workspaceId === workspaceId && a.status !== "offline")
      .map((a) => ({
        id: a.id,
        name: a.name,
        machine: a.machine,
        os: a.os,
        // Asked for recordings lately, or is recording now (and so not asking).
        canRecord: Date.now() - (recorders.get(a.id) ?? 0) < 30_000 || [...recordings.values()].some((r) => r.agentId === a.id && ACTIVE.includes(r.status)),
        canIndicate: canIndicate(a.version),
      }));
  });

  app.post("/api/recordings", async (req, reply) => {
    const body = parse(
      z.object({
        agentId: z.string().min(1),
        kind: z.enum(["web", "desktop", "indicate"]),
        url: z.string().trim().max(2000).optional(),
        program: z.string().trim().max(500).optional(),
        attach: z.boolean().optional(),
        hint: z.string().trim().max(300).optional(),
      }),
      req.body,
    );
    const agent = ctx.own(store.data.agents, body.agentId, "Agent", req);
    if (agent.status === "offline") throw new HttpError(409, `${agent.name} is offline`);
    if (body.kind === "indicate" && !canIndicate(agent.version)) {
      throw new HttpError(409, `Update the ZamTech AI agent on ${agent.name} to use Indicate (it has version ${agent.version || "unknown"})`);
    }
    if (body.kind === "web") {
      if (!body.url) throw new HttpError(400, "Enter the address of the website to record");
      if (!/^https?:\/\//i.test(body.url)) body.url = `https://${body.url}`;
    }
    prune();
    if ([...recordings.values()].some((r) => r.agentId === agent.id && ACTIVE.includes(r.status))) {
      throw new HttpError(409, `${agent.name} is already recording; stop that recording first`);
    }
    const p = ctx.me(req);
    const recording: Recording = {
      id: newId("rec"),
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      agentName: agent.name,
      kind: body.kind,
      url: body.kind === "web" ? body.url : undefined,
      program: body.kind === "desktop" ? body.program || undefined : undefined,
      attach: body.kind === "desktop" && body.program ? body.attach || undefined : undefined,
      hint: body.kind === "indicate" ? body.hint || undefined : undefined,
      status: "pending",
      requestedBy: ctx.who(p),
      requestedAt: nowIso(),
      updatedAt: nowIso(),
      steps: [],
      variables: [],
    };
    recordings.set(recording.id, recording);
    return reply.status(201).send(recording);
  });

  app.get<{ Params: { id: string } }>("/api/recordings/:id", async (req) => mine(req, req.params.id));

  app.post<{ Params: { id: string } }>("/api/recordings/:id/stop", async (req) => {
    const r = mine(req, req.params.id);
    if (r.status === "pending") r.status = "cancelled";
    else if (r.status === "recording") r.status = "stopping";
    r.updatedAt = nowIso();
    return r;
  });

  app.post<{ Params: { id: string } }>("/api/recordings/:id/cancel", async (req) => {
    const r = mine(req, req.params.id);
    if (ACTIVE.includes(r.status)) {
      r.status = "cancelled";
      r.updatedAt = nowIso();
    }
    return r;
  });

  /* ---------- the PC's agent ---------- */
  /** The agent asks every few seconds; it gets a recording to start, if one waits for it. */
  app.post("/api/agent/recordings/next", async (req, reply) => {
    const agent = ctx.agentFor(req);
    recorders.set(agent.id, Date.now());
    prune();
    const next = [...recordings.values()].find((r) => r.agentId === agent.id && r.status === "pending");
    if (!next) return reply.status(204).send();
    next.status = "recording";
    next.updatedAt = nowIso();
    return { id: next.id, kind: next.kind, url: next.url, program: next.program, attach: next.attach, hint: next.hint };
  });

  /** The steps so far (all of them each time); the answer says whether to stop. */
  app.post<{ Params: { id: string } }>("/api/agent/recordings/:id/progress", async (req) => {
    const agent = ctx.agentFor(req);
    const r = recordings.get(req.params.id);
    if (!r || r.agentId !== agent.id) throw new HttpError(404, "Recording not found");
    const body = parse(
      z.object({
        agentId: z.string().optional(),
        steps: z.array(StepSchema).max(2000),
        variables: z.array(VariableDefSchema).max(100).default([]),
        done: z.boolean().default(false),
        error: z.string().max(2000).optional(),
        picked: z.object({ path: z.string().max(2000), process: z.string().max(260), title: z.string().max(1000) }).optional(),
      }),
      req.body,
    );
    if (ACTIVE.includes(r.status)) {
      r.steps = body.steps as Step[];
      r.variables = body.variables as VariableDef[];
      if (body.picked) r.picked = body.picked;
      if (body.error) {
        r.status = "failed";
        r.error = body.error;
      } else if (body.done) r.status = "done";
      r.updatedAt = nowIso();
    }
    return { stop: r.status === "stopping" || r.status === "cancelled" };
  });
}
