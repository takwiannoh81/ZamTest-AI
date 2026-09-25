/**
 * Test cases: folders (nested) of tests, each with its own steps built in the
 * Designer ("Verify ..." checks, and "Call Workflow" to run a workflow). A test
 * passes when its run succeeds. A folder, or all of them, can be run at once.
 * Older test cases run a workflow with inputs and check its outputs.
 * Also: a whole project (workflows and test cases) as one file, to save on a PC
 * and import again.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { WorkflowSchema } from "@zamtest/core";
import type { Workflow } from "@zamtest/core";
import { HttpError, parse } from "./errors.js";
import { createJob } from "./jobs.js";
import { remapCalls } from "./calls.js";
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
  definition: WorkflowSchema.optional(),
  workflowId: z.string().min(1).optional(),
  inputs: z.record(z.unknown()).default({}),
  expectedOutputs: z.record(z.unknown()).nullish(),
  targetAgentId: z.string().nullish(),
  description: z.string().max(2000).nullish(),
});

/** "Invoices / Europe" for a folder. */
export function testPath(store: Store, folderId: string | undefined): string {
  const names: string[] = [];
  for (let id = folderId, guard = 0; id && guard < 100; guard++) {
    const folder = store.data.testFolders[id];
    if (!folder) break;
    names.unshift(folder.name);
    id = folder.parentId;
  }
  return names.join(" / ");
}

/** The folder and everything below it. */
export function folderSubtree(store: Store, workspaceId: string, folderId: string): Set<string> {
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
}

/** Which test cases a run (or a schedule) runs: these cases, a folder with its sub-folders, or all. */
export interface TestSelection {
  caseIds?: string[];
  /** A folder (with everything below it); unset or null with no caseIds: all test cases. */
  folderId?: string | null;
}

/**
 * Starts a test run: a job per test case, as "Run all" does. Used by the Designer
 * and by schedules. Throws when there is nothing to run.
 */
export function startTestRun(store: Store, input: TestSelection & { workspaceId: string; startedBy: string; targetAgentId?: string }): TestRun {
  const all = Object.values(store.data.testCases).filter((c) => c.workspaceId === input.workspaceId);
  let cases: TestCase[];
  let name: string;
  if (input.caseIds?.length) {
    const wanted = new Set(input.caseIds);
    cases = all.filter((c) => wanted.has(c.id));
    name = cases.length === 1 ? cases[0]!.name : `${cases.length} test cases`;
  } else if (input.folderId) {
    const ids = folderSubtree(store, input.workspaceId, input.folderId);
    cases = all.filter((c) => c.folderId && ids.has(c.folderId));
    name = testPath(store, input.folderId);
  } else {
    cases = all;
    name = "All test cases";
  }
  if (!cases.length) throw new HttpError(400, "There are no test cases to run here");
  cases.sort((a, b) => testPath(store, a.folderId).localeCompare(testPath(store, b.folderId)) || a.name.localeCompare(b.name));

  const run: TestRun = { id: newId("trn"), workspaceId: input.workspaceId, name, startedBy: input.startedBy, startedAt: nowIso(), items: [] };
  for (const c of cases) {
    const item: TestRun["items"][number] = { testCaseId: c.id, name: c.name, path: testPath(store, c.folderId) };
    // Its own steps; older test cases run their workflow.
    const wf: WorkflowDraft | undefined = c.workflowId ? store.data.workflows[c.workflowId] : undefined;
    const definition = c.definition ?? (wf && wf.workspaceId === run.workspaceId ? wf.definition : undefined);
    if (!definition) item.error = "Its workflow was deleted";
    else {
      try {
        const agent = input.targetAgentId ?? c.targetAgentId;
        const job = createJob(store, {
          workspaceId: run.workspaceId,
          definition,
          inputs: c.inputs,
          targetAgentId: agent && store.data.agents[agent] ? agent : undefined,
          source: "test",
          startedBy: `${input.startedBy} (test: ${c.name})`,
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
  const runs = Object.values(store.data.testRuns)
    .filter((r) => r.workspaceId === input.workspaceId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  for (const old of runs.slice(50)) delete store.data.testRuns[old.id];
  store.save();
  return run;
}

export function registerTestCases(app: FastifyInstance, ctx: TestCaseContext): void {
  const { store } = ctx;
  const ws = (req: FastifyRequest) => ctx.me(req).workspaceId;
  const folderOf = (req: FastifyRequest, id: string | null | undefined): string | undefined => (id ? ctx.own(store.data.testFolders, id, "Folder", req).id : undefined);

  const pathOf = (folderId: string | undefined): string => testPath(store, folderId);
  const subtree = (workspaceId: string, folderId: string): Set<string> => folderSubtree(store, workspaceId, folderId);
  /** A test case in the tree: without its steps (open it for those). */
  const caseView = ({ definition, ...c }: TestCase) => {
    const job = c.lastJobId ? store.data.jobs[c.lastJobId] : undefined;
    return {
      ...c,
      steps: definition ? (definition.root.slots?.body ?? []).length : undefined,
      workflowName: c.workflowId ? store.data.workflows[c.workflowId]?.name : undefined,
      last: job ? { jobId: job.id, at: job.finishedAt ?? job.createdAt, ...resultOf(job, c.expectedOutputs) } : undefined,
    };
  };
  const blankSteps = (id: string, name: string): Workflow => ({
    schemaVersion: 1,
    id,
    name,
    variables: [],
    root: { id: "root", type: "core.sequence", props: {}, slots: { body: [] } },
  });

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
    if (body.workflowId) ctx.own(store.data.workflows, body.workflowId, "Workflow", req);
    if (body.targetAgentId) ctx.own(store.data.agents, body.targetAgentId, "Agent", req);
    const id = newId("tc");
    const testCase: TestCase = {
      id,
      workspaceId: ws(req),
      name: body.name,
      folderId: folderOf(req, body.folderId),
      // New test cases have steps of their own.
      definition: body.workflowId ? undefined : { ...(body.definition ?? blankSteps(id, body.name)), id, name: body.name },
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
    if (body.definition) testCase.definition = body.definition as Workflow;
    if (testCase.definition) testCase.definition = { ...testCase.definition, id: testCase.id, name: testCase.name };
    if (body.inputs) testCase.inputs = body.inputs;
    if (body.expectedOutputs !== undefined) testCase.expectedOutputs = body.expectedOutputs ?? undefined;
    if (body.targetAgentId !== undefined) testCase.targetAgentId = body.targetAgentId ?? undefined;
    if (body.description !== undefined) testCase.description = body.description ?? undefined;
    testCase.updatedAt = nowIso();
    store.save();
    return caseView(testCase);
  });

  /** A test case with its steps (the Designer opens it). */
  app.get<{ Params: { id: string } }>("/api/test-cases/:id", async (req) => {
    const testCase = ctx.own(store.data.testCases, req.params.id, "Test case", req);
    return { ...caseView(testCase), definition: testCase.definition };
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
    // Only this account's cases and folders.
    for (const id of body.caseIds ?? []) ctx.own(store.data.testCases, id, "Test case", req);
    if (body.folderId) ctx.own(store.data.testFolders, body.folderId, "Folder", req);
    const p = ctx.me(req);
    const run = startTestRun(store, { workspaceId: ws(req), caseIds: body.caseIds, folderId: body.folderId, startedBy: p.email || p.name });
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
      testCases: ctx
        .mine(store.data.testCases, req)
        .map(({ id, name, folderId, definition, workflowId, inputs, expectedOutputs, description }) => ({ id, name, folderId, definition, workflowId, inputs, expectedOutputs, description })),
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
          .array(
            z.object({
              id: z.string(),
              name: z.string().min(1).max(200),
              folderId: z.string().nullish(),
              definition: WorkflowSchema.nullish(),
              workflowId: z.string().nullish(),
              inputs: z.record(z.unknown()).default({}),
              expectedOutputs: z.record(z.unknown()).nullish(),
              description: z.string().nullish(),
            }),
          )
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
    for (const definition of definitions) ids.set(definition.id, newId("wf"));
    for (const definition of definitions) {
      const id = ids.get(definition.id)!;
      // "Call Workflow" steps point at the imported copies.
      const own = { ...definition, id, root: remapCalls(definition.root, ids) };
      store.data.workflows[id] = { id, workspaceId, name: definition.name, description: definition.description, definition: own, createdAt: nowIso(), updatedAt: nowIso() };
    }
    const folderIds = new Map(body.testFolders.map((f) => [f.id, newId("tfd")]));
    for (const f of body.testFolders) {
      store.data.testFolders[folderIds.get(f.id)!] = { id: folderIds.get(f.id)!, workspaceId, name: f.name, parentId: f.parentId ? folderIds.get(f.parentId) : undefined, createdAt: nowIso() };
    }
    let skipped = 0;
    for (const c of body.testCases) {
      const workflowId = c.workflowId ? ids.get(c.workflowId) : undefined;
      if (!c.definition && !workflowId) {
        skipped++;
        continue;
      }
      const id = newId("tc");
      const definition = c.definition ? ({ ...c.definition, id, name: c.name, root: remapCalls(c.definition.root, ids) } as Workflow) : undefined;
      store.data.testCases[id] = {
        id,
        workspaceId,
        name: c.name,
        folderId: c.folderId ? folderIds.get(c.folderId) : undefined,
        definition,
        workflowId: definition ? undefined : workflowId,
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
