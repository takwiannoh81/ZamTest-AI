import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

let app: FastifyInstance;
afterEach(() => app?.close());

const agent = { "x-agent-key": "k" };
const PASSWORD = "correct horse battery";
type Headers = Record<string, string>;
const open: Headers = {};
const call = (headers: Headers, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) => app.inject({ method, url, headers, payload: payload as object });
const cookieOf = (res: LightMyRequestResponse) => String(res.headers["set-cookie"]).split(";")[0]!;

const definition = {
  id: "greet",
  name: "Greet",
  variables: [
    { name: "who", type: "string", direction: "in", default: "world" },
    { name: "greeting", type: "string", direction: "out" },
  ],
  root: { id: "root", type: "core.sequence", props: {}, slots: { body: [{ id: "a", type: "core.log", props: { message: "hi {{ who }}" } }] } },
};

/** The bot takes each pending job and finishes it with these outputs. */
async function finishJobs(agentId: string, outputsFor: (inputs: Record<string, unknown>) => Record<string, unknown>) {
  for (;;) {
    const next = await app.inject({ method: "POST", url: "/api/agent/jobs/next", headers: agent, payload: { agentId } });
    if (next.statusCode === 204) return;
    const job = next.json();
    await app.inject({ method: "POST", url: `/api/agent/jobs/${job.id}/complete`, headers: agent, payload: { agentId, status: "succeeded", outputs: outputsFor(job.inputs) } });
  }
}

describe("test cases", () => {
  it("live in nested folders, run all or by folder, and pass or fail on their expected outputs", async () => {
    // Local mode (no sign-in): the platform's own workspace, where the shared-key bot works.
    ({ app } = await buildApp({ config: { ...loadConfig({ ZAMTEST_AGENT_KEY: "k" }), dataDir: null }, ai: null }));
    const wf = (await call(open, "POST", "/api/workflows", { definition })).json();

    const smoke = (await call(open, "POST", "/api/test-folders", { name: "Smoke" })).json();
    const europe = (await call(open, "POST", "/api/test-folders", { name: "Europe", parentId: smoke.id })).json();
    const regression = (await call(open, "POST", "/api/test-folders", { name: "Regression" })).json();
    // A folder cannot move inside its own subfolder.
    expect((await call(open, "PUT", `/api/test-folders/${smoke.id}`, { parentId: europe.id })).statusCode).toBe(400);

    const ada = (await call(open, "POST", "/api/test-cases", { name: "Greets Ada", folderId: smoke.id, workflowId: wf.id, inputs: { who: "Ada" }, expectedOutputs: { greeting: "Hello Ada" } })).json();
    await call(open, "POST", "/api/test-cases", { name: "Greets Bob", folderId: europe.id, workflowId: wf.id, inputs: { who: "Bob" }, expectedOutputs: { greeting: "Hello Bob" } });
    await call(open, "POST", "/api/test-cases", { name: "Just runs", folderId: regression.id, workflowId: wf.id });
    const tree = (await call(open, "GET", "/api/tests")).json();
    expect(tree.folders.map((f: { name: string }) => f.name)).toEqual(["Europe", "Regression", "Smoke"]);
    expect(tree.cases.find((c: { id: string }) => c.id === ada.id)).toMatchObject({ workflowName: "Greet" });

    // Run the Smoke folder, with its Europe subfolder; the bot answers wrongly for Bob.
    const { agentId } = (await app.inject({ method: "POST", url: "/api/agent/register", headers: agent, payload: { name: "bot" } })).json();
    const started = await call(open, "POST", "/api/test-runs", { folderId: smoke.id });
    expect(started.statusCode, started.body).toBe(201);
    expect(started.json()).toMatchObject({ name: "Smoke", running: 2, done: false });
    expect(started.json().items.map((i: { path: string; name: string }) => `${i.path} > ${i.name}`)).toEqual(["Smoke > Greets Ada", "Smoke / Europe > Greets Bob"]);
    await finishJobs(agentId, (inputs) => ({ greeting: inputs.who === "Bob" ? "Hi Bob" : `Hello ${String(inputs.who)}` }));
    const smokeRun = (await call(open, "GET", `/api/test-runs/${started.json().id}`)).json();
    expect(smokeRun).toMatchObject({ done: true, passed: 1, failed: 1 });
    expect(smokeRun.items[1]).toMatchObject({ status: "failed", message: 'Output "greeting" is "Hi Bob", expected "Hello Bob"' });

    // Run all: three cases; each case shows its latest result.
    const all = (await call(open, "POST", "/api/test-runs", {})).json();
    expect(all).toMatchObject({ name: "All test cases", running: 3 });
    await finishJobs(agentId, (inputs) => ({ greeting: `Hello ${String(inputs.who ?? "world")}` }));
    expect((await call(open, "GET", `/api/test-runs/${all.id}`)).json()).toMatchObject({ done: true, passed: 3, failed: 0 });
    expect((await call(open, "GET", "/api/tests")).json().cases.every((c: { last?: { status: string } }) => c.last?.status === "passed")).toBe(true);
    const jobs = (await call(open, "GET", "/api/jobs")).json() as Array<{ source: string }>;
    expect(jobs.every((j) => j.source === "test")).toBe(true);

    // The whole project to a file, and back in as new workflows and test cases.
    const project = (await call(open, "GET", "/api/project/export")).json();
    expect(project).toMatchObject({ format: "zamtech-ai-project", workflows: [{ name: "Greet" }] });
    expect(project.testCases).toHaveLength(3);
    const imported = await call(open, "POST", "/api/project/import", project);
    expect(imported.json()).toEqual({ workflows: 1, testFolders: 3, testCases: 3, skipped: 0 });
    const after = (await call(open, "GET", "/api/tests")).json();
    expect(after.folders).toHaveLength(6);
    expect(new Set(after.cases.map((c: { workflowId: string }) => c.workflowId)).size).toBe(2);

    // Deleting a folder deletes its subfolders and test cases.
    expect((await call(open, "DELETE", `/api/test-folders/${smoke.id}`)).statusCode).toBe(204);
    const pruned = (await call(open, "GET", "/api/tests")).json();
    expect(pruned.folders).toHaveLength(4);
    expect(pruned.cases).toHaveLength(4);
  });

  it("belong to one customer", async () => {
    const config = { ...loadConfig({ ZAMTEST_ADMIN_TOKEN: "master-token-0123456789abcdef", ZAMTEST_ALLOW_SIGNUP: "true" }), dataDir: null };
    ({ app } = await buildApp({ config, ai: null }));
    const signUp = async (company: string, email: string) => {
      const res = await app.inject({ method: "POST", url: "/api/auth/signup", payload: { company, name: company, email, password: PASSWORD } });
      return { cookie: cookieOf(res), "x-zamtech-client": "test" } as Headers;
    };
    const acme = await signUp("Acme", "a@acme.example");
    const globex = await signUp("Globex", "g@globex.example");
    const wf = (await call(acme, "POST", "/api/workflows", { definition })).json();
    const folder = (await call(acme, "POST", "/api/test-folders", { name: "Acme tests" })).json();
    const testCase = (await call(acme, "POST", "/api/test-cases", { name: "Acme case", folderId: folder.id, workflowId: wf.id })).json();

    expect((await call(globex, "GET", "/api/tests")).json()).toEqual({ folders: [], cases: [] });
    expect((await call(globex, "POST", "/api/test-cases", { name: "x", workflowId: wf.id })).statusCode).toBe(404);
    expect((await call(globex, "POST", "/api/test-runs", { caseIds: [testCase.id] })).statusCode).toBe(404);
    expect((await call(globex, "DELETE", `/api/test-folders/${folder.id}`)).statusCode).toBe(404);
  });
});

describe("test cases with their own steps", () => {
  it("are built like workflows, call workflows, and keep those calls when a project is imported", async () => {
    ({ app } = await buildApp({ config: { ...loadConfig({ ZAMTEST_AGENT_KEY: "k" }), dataDir: null }, ai: null }));
    const login = (await call(open, "POST", "/api/workflows", { definition: { ...definition, id: "login", name: "Log in" } })).json();

    // A new test case starts with no steps, and is edited like a workflow.
    const created = (await call(open, "POST", "/api/test-cases", { name: "Login works" })).json();
    expect(created).toMatchObject({ name: "Login works", steps: 0 });
    expect(created.workflowId).toBeUndefined();
    const steps = {
      schemaVersion: 1,
      id: "ignored",
      name: "ignored",
      variables: [],
      root: {
        id: "root",
        type: "core.sequence",
        props: {},
        slots: {
          body: [
            { id: "call", type: "core.callWorkflow", props: { workflowId: login.id, inputs: { who: "Ivo" }, output: "login" } },
            { id: "check", type: "verify.condition", props: { condition: "true" } },
          ],
        },
      },
    };
    expect((await call(open, "PUT", `/api/test-cases/${created.id}`, { definition: steps })).json()).toMatchObject({ steps: 2 });
    const full = (await call(open, "GET", `/api/test-cases/${created.id}`)).json();
    expect(full.definition).toMatchObject({ id: created.id, name: "Login works" });

    // Running it: the job carries the test's steps and the workflow it calls.
    const { agentId } = (await app.inject({ method: "POST", url: "/api/agent/register", headers: agent, payload: { name: "bot" } })).json();
    const run = (await call(open, "POST", "/api/test-runs", { caseIds: [created.id] })).json();
    const job = (await app.inject({ method: "POST", url: "/api/agent/jobs/next", headers: agent, payload: { agentId } })).json();
    expect(job.id).toBe(run.items[0].jobId);
    expect(job.definition.root.slots.body.map((s: { type: string }) => s.type)).toEqual(["core.callWorkflow", "verify.condition"]);
    expect(job.definition.workflows[login.id]).toMatchObject({ name: "Log in" });

    // Calling a workflow that is gone is refused when the run starts.
    await call(open, "DELETE", `/api/workflows/${login.id}`);
    const again = (await call(open, "POST", "/api/test-runs", { caseIds: [created.id] })).json();
    expect(again.items[0]).toMatchObject({ status: "failed", message: expect.stringContaining("does not exist") });

    // A project file keeps test steps, and their calls point at the imported workflows.
    const wf2 = (await call(open, "POST", "/api/workflows", { definition: { ...definition, id: "login2", name: "Log in again" } })).json();
    const steps2 = structuredClone(steps);
    steps2.root.slots.body[0]!.props.workflowId = wf2.id;
    const tc2 = (await call(open, "POST", "/api/test-cases", { name: "Second", definition: steps2 })).json();
    const project = (await call(open, "GET", "/api/project/export")).json();
    const imported = (await call(open, "POST", "/api/project/import", project)).json();
    expect(imported).toMatchObject({ workflows: 1, skipped: 0 });
    const tree = (await call(open, "GET", "/api/tests")).json() as { cases: Array<{ id: string; name: string }> };
    const copies = tree.cases.filter((c) => c.name === "Second" && c.id !== tc2.id);
    expect(copies).toHaveLength(1);
    const copy = (await call(open, "GET", `/api/test-cases/${copies[0]!.id}`)).json();
    const newWorkflowId = copy.definition.root.slots.body[0].props.workflowId;
    expect(newWorkflowId).not.toBe(wf2.id);
    expect((await call(open, "GET", `/api/workflows/${newWorkflowId}`)).json().name).toBe("Log in again");
  });
});
