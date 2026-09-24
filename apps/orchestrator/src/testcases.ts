/**
 * Test cases for workflows: folders (nested) of test cases, each running a
 * workflow as saved in the Designer with given inputs. A case passes when its
 * run succeeds and every expected output has that value. A folder, or all of
 * them, can be run at once. Also: a whole project (workflows and test cases)
 * as one file, to save on a PC and import again.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { WorkflowSchema } from "@zamtest/core";
import type { Workflow } from "@zamtest/core";
import { HttpError, parse } from "./errors.js";
import { createJob } from "./jobs.js";
import { PlanLimitError } from "./plans.js";
import { newId, nowIso } from "./store.js";
import type { Store } from "./store.js";
import type { Job, Principal, TestCase, TestFolder, TestRun, WorkflowDraft } from "./types.js";

export interface TestCaseContext {
  store: Store;
  me(req: FastifyRequest): Principal;
  own<T extends { workspaceId: string }>(collection: Record<string, T>, id: string, what: string, req: FastifyRequest): T;
  mine<T extends { workspaceId: string }>(collection: Record<string, T>, req: FastifyRequest): T[];
}

export type TestStatus = "pending" | "running" | "passed" | "failed" | "cancelled";

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A test case's outcome from its job. */
export function resultOf(job: Job | undefined, expected?: Record<string, unknown>): { status: TestStatus; message?: string } | undefined {
  if (!job) return undefined;
  if (job.status === "pending") return { status: "pending" };
  if (job.status === "running" || job.status === "cancelling") return { status: "running" };
  if (job.status === "cancelled") return { status: "cancelled", message: job.error };
  if (job.status === "failed") return { status: "failed", message: job.error };
  for (const [name, value] of Object.entries(expected ?? {})) {
    const actual = job.outputs?.[name];
    if (!equal(actual, value)) return { status: "failed", message: `Output "${name}" is ${JSON.stringify(actual) ?? "missing"}, expected ${JSON.stringify(value)}` };
  }
  return { status: "passed" };
}

const PROJECT_FORMAT = "zamtech-ai-project";

const FolderBody = z.object({ name: z.string().trim().min(1).max(200), parentId: z.string().nullish() });
const CaseBody = z.object({
  name: z.string().trim().min(1).max(200),
  folderId: z.string().nullish(),
  workflowId: z.string().min(1),
  inputs: z.record(z.unknown()).default({}),
  expectedOutputs: z.record(z.unknown()).nullish(),
  targetAgentId: z.string().nullish(),
  description: z.string().max(2000).nullish(),
});

export function registerTestCases(app: FastifyInstance, ctx: TestCaseContext): void {
  const { store } = ctx;
  const ws = (req: FastifyRequest) => ctx.me(req).workspaceId;
  const folderOf = (req: FastifyRequest, id: string | null | undefined): string | undefined => (id ? ctx.own(store.data.testFolders, id, "Folder", req).id : undefined);

  /** "Invoices / Europe" for a folder. */
  const pathOf = (folderId: string | undefined): string => {
    const names: string[] = [];
    for (let id = folderId, guard = 0; id && guard < 100; guard++) {
      const folder = store.data.testFolders[id];
      if (!folder) break;
      names.unshift(folder.name);
      id = folder.parentId;
    }
    return names.join(" / ");
  };
  /** The folder and everything below it. */
  const subtree = (workspaceId: string, folderId: string): Set<string> => {
    const ids = new Set([folderId]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const f of Object.values(store.data.testFolders)) {
        if (f.workspaceId === workspaceId && f.parentId && ids.has(f.parentId) && !ids.has(f.id)) {
          ids.add(f.id);
          grew = true;
        }
      }
    }
    return ids;
  };
  const caseView = (c: TestCase) => {
    const job = c.lastJobId ? store.data.jobs[c.lastJobId] : undefined;
    return { ...c, workflowName: store.data.workflows[c.workflowId]?.name, last: job ? { jobId: job.id, at: job.finishedAt ?? job.createdAt, ...resultOf(job, c.expectedOutputs) } : undefined };
  };

  /* ---------- tree ---------- */
  app.get("/api/tests", async (req) => ({
    folders: ctx.mine(store.data.testFolders, req).sort((a, b) => a.name.localeCompare(b.name)),
    cases: ctx.mine(store.data.testCases, req).sort((a, b) => a.name.localeCompare(b.name)).map(caseView),
  }));

  app.post("/api/test-folders", async (req, reply) => {
    const body = parse(FolderBody, req.body);
    const folder: TestFolder = { id: newId("tfd"), workspaceId: ws(req), name: body.name, parentId: folderOf(req, body.parentId), createdAt: nowIso() };
    store.data.testFolders[folder.id] = folder;
    store.save();
    return reply.status(201).send(folder);
  });

  app.put<{ Params: { id: string } }>("/api/test-folders/:id", async (req) => {
    const folder = ctx.own(store.data.testFolders, req.params.id, "Folder", req);
    const body = parse(FolderBody.partial(), req.body);
    if (body.name) folder.name = body.name;
    if (body.parentId !== undefined) {
      const parent = folderOf(req, body.parentId);
      if (parent && subtree(folder.workspaceId, folder.id).has(parent)) throw new HttpError(400, "A folder cannot go inside itself");
      folder.parentId = parent;
    }
    store.save();
    return folder;
  });

  /** Deletes the folder with its subfolders and test cases. */
  app.delete<{ Params: { id: string } }>("/api/test-folders/:id", async (req, reply) => {
    const folder = ctx.own(store.data.testFolders, req.params.id, "Folder", req);
    const ids = subtree(folder.workspaceId, folder.id);
    for (const id of ids) delete store.data.testFolders[id];
    for (const c of ctx.mine(store.data.testCases, req)) if (c.folderId && ids.has(c.folderId)) delete store.data.testCases[c.id];
    store.save();
    return reply.status(204).send();
  });

  app.post("/api/test-cases", async (req, reply) => {
    const body = parse(CaseBody, req.body);
    ctx.own(store.data.workflows, body.workflowId, "Workflow", req);
    if (body.targetAgentId) ctx.own(store.data.agents, body.targetAgentId, "Agent", req);
    const testCase: TestCase = {
      id: newId("tc"),
      workspaceId: ws(req),
      name: body.name,
      folderId: folderOf(req, body.folderId),
      workflowId: body.workflowId,
      inputs: body.inputs,
      expectedOutputs: body.expectedOutputs ?? undefined,
      targetAgentId: body.targetAgentId ?? undefined,
      description: body.description ?? undefined,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    store.data.testCases[testCase.id] = testCase;
    store.save();
    return reply.status(201).send(caseView(testCase));
  });

  app.put<{ Params: { id: string } }>("/api/test-cases/:id", async (req) => {
    const testCase = ctx.own(store.data.testCases, req.params.id, "Test case", req);
    const body = parse(CaseBody.partial(), req.body);
    if (body.workflowId) ctx.own(store.data.workflows, body.workflowId, "Workflow", req);
    if (body.targetAgentId) ctx.own(store.data.agents, body.targetAgentId, "Agent", req);
    if (body.name) testCase.name = body.name;
    if (body.folderId !== undefined) testCase.folderId = folderOf(req, body.folderId);
    if (body.workflowId) testCase.workflowId = body.workflowId;
    if (body.inputs) testCase.inputs = body.inputs;
    if (body.expectedOutputs !== undefined) testCase.expectedOutputs = body.expectedOutputs ?? undefined;
    if (body.targetAgentId !== undefined) testCase.targetAgentId = body.targetAgentId ?? undefined;
    if (body.description !== undefined) testCase.description = body.description ?? undefined;
    testCase.updatedAt = nowIso();
    store.save();
    return caseView(testCase);
  });

  app.delete<{ Params: { id: string } }>("/api/test-cases/:id", async (req, reply) => {
    ctx.own(store.data.testCases, req.params.id, "Test case", req);
    delete store.data.testCases[req.params.id];
    store.save();
    return reply.status(204).send();
  });

  /* ---------- running ---------- */
  const runView = (run: TestRun) => {
    const items = run.items.map((item) => {
      const job = item.jobId ? store.data.jobs[item.jobId] : undefined;
      const result = item.error ? { status: "failed" as const, message: item.error } : (resultOf(job, store.data.testCases[item.testCaseId]?.expectedOutputs) ?? { status: "failed" as const, message: "The job was deleted" });
      return { ...item, ...result };
    });
    const count = (s: TestStatus) => items.filter((i) => i.status === s).length;
    const done = items.every((i) => !["pending", "running"].includes(i.status));
    return { ...run, items, done, passed: count("passed"), failed: count("failed") + count("cancelled"), running: count("pending") + count("running") };
  };

  /** Runs one test case, a folder (with its subfolders), or all of them. */
  app.post("/api/test-runs", async (req, reply) => {
    const body = parse(z.object({ folderId: z.string().nullish(), caseIds: z.array(z.string()).max(1000).optional() }), req.body ?? {});
    const all = ctx.mine(store.data.testCases, req);
    let cases: TestCase[];
    let name: string;
    if (body.caseIds?.length) {
      cases = body.caseIds.map((id) => ctx.own(store.data.testCases, id, "Test case", req));
      name = cases.length === 1 ? cases[0]!.name : `${cases.length} test cases`;
    } else if (body.folderId) {
      const folder = ctx.own(store.data.testFolders, body.folderId, "Folder", req);
      const ids = subtree(folder.workspaceId, folder.id);
      cases = all.filter((c) => c.folderId && ids.has(c.folderId));
      name = pathOf(folder.id);
    } else {
      cases = all;
      name = "All test cases";
    }
    if (!cases.length) throw new HttpError(400, "There are no test cases to run here");
    cases.sort((a, b) => pathOf(a.folderId).localeCompare(pathOf(b.folderId)) || a.name.localeCompare(b.name));

    const p = ctx.me(req);
    const run: TestRun = { id: newId("trn"), workspaceId: ws(req), name, startedBy: p.email || p.name, startedAt: nowIso(), items: [] };
    for (const c of cases) {
      const item: TestRun["items"][number] = { testCaseId: c.id, name: c.name, path: pathOf(c.folderId) };
      const wf: WorkflowDraft | undefined = store.data.workflows[c.workflowId];
      if (!wf || wf.workspaceId !== run.workspaceId) item.error = "Its workflow was deleted";
      else {
        try {
          const job = createJob(store, {
            workspaceId: run.workspaceId,
            definition: wf.definition,
            inputs: c.inputs,
            targetAgentId: c.targetAgentId && store.data.agents[c.targetAgentId] ? c.targetAgentId : undefined,
            source: "test",
            startedBy: `${p.email || p.name} (test: ${c.name})`,
          });
          item.jobId = job.id;
          c.lastJobId = job.id;
        } catch (err) {
          // Out of runs for the month, a PC in another environment...: this case fails, the others still run.
          item.error = err instanceof PlanLimitError || err instanceof HttpError ? err.message : String(err);
        }
      }
      run.items.push(item);
    }
    store.data.testRuns[run.id] = run;
    // Keep the 50 newest runs of each workspace.
    const runs = ctx.mine(store.data.testRuns, req).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    for (const old of runs.slice(50)) delete store.data.testRuns[old.id];
    store.save();
    return reply.status(201).send(runView(run));
  });

  app.get("/api/test-runs", async (req) =>
    ctx
      .mine(store.data.testRuns, req)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, 20)
      .map(runView),
  );
  app.get<{ Params: { id: string } }>("/api/test-runs/:id", async (req) => runView(ctx.own(store.data.testRuns, req.params.id, "Test run", req)));

  /* ---------- a whole project in one file ---------- */
  app.get("/api/project/export", async (req, reply) => {
    const workflows = ctx.mine(store.data.workflows, req);
    const data = {
      format: PROJECT_FORMAT,
      version: 1,
      exportedAt: nowIso(),
      workflows: workflows.map((w) => ({ ...w.definition, id: w.id, name: w.name, description: w.description })),
      testFolders: ctx.mine(store.data.testFolders, req).map(({ id, name, parentId }) => ({ id, name, parentId })),
      testCases: ctx.mine(store.data.testCases, req).map(({ id, name, folderId, workflowId, inputs, expectedOutputs, description }) => ({ id, name, folderId, workflowId, inputs, expectedOutputs, description })),
    };
    return reply.header("content-type", "application/json; charset=utf-8").send(JSON.stringify(data, null, 2));
  });

  /** Adds a project's workflows and test cases (as new ones, next to what is there). */
  app.post("/api/project/import", async (req, reply) => {
    const body = parse(
      z.object({
        format: z.literal(PROJECT_FORMAT),
        workflows: z.array(z.unknown()).max(1000),
        testFolders: z.array(z.object({ id: z.string(), name: z.string().min(1).max(200), parentId: z.string().nullish() })).max(5000).default([]),
        testCases: z
          .array(z.object({ id: z.string(), name: z.string().min(1).max(200), folderId: z.string().nullish(), workflowId: z.string(), inputs: z.record(z.unknown()).default({}), expectedOutputs: z.record(z.unknown()).nullish(), description: z.string().nullish() }))
          .max(10000)
          .default([]),
      }),
      req.body,
    );
    const definitions: Workflow[] = [];
    for (const [i, raw] of body.workflows.entries()) {
      const check = WorkflowSchema.safeParse(raw);
      if (!check.success) throw new HttpError(400, `Workflow ${i + 1} is not valid: ${check.error.issues[0]?.message ?? ""}`);
      definitions.push(check.data as Workflow);
    }
    const workspaceId = ws(req);
    const ids = new Map<string, string>();
    for (const definition of definitions) {
      const id = newId("wf");
      ids.set(definition.id, id);
      store.data.workflows[id] = { id, workspaceId, name: definition.name, description: definition.description, definition: { ...definition, id }, createdAt: nowIso(), updatedAt: nowIso() };
    }
    const folderIds = new Map(body.testFolders.map((f) => [f.id, newId("tfd")]));
    for (const f of body.testFolders) {
      store.data.testFolders[folderIds.get(f.id)!] = { id: folderIds.get(f.id)!, workspaceId, name: f.name, parentId: f.parentId ? folderIds.get(f.parentId) : undefined, createdAt: nowIso() };
    }
    let skipped = 0;
    for (const c of body.testCases) {
      const workflowId = ids.get(c.workflowId);
      if (!workflowId) {
        skipped++;
        continue;
      }
      const id = newId("tc");
      store.data.testCases[id] = {
        id,
        workspaceId,
        name: c.name,
        folderId: c.folderId ? folderIds.get(c.folderId) : undefined,
        workflowId,
        inputs: c.inputs,
        expectedOutputs: c.expectedOutputs ?? undefined,
        description: c.description ?? undefined,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
    }
    store.save();
    return reply.status(201).send({ workflows: definitions.length, testFolders: body.testFolders.length, testCases: body.testCases.length - skipped, skipped });
  });
}
