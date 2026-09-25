import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { DiagnoseInput, Diagnosis, GenerateWorkflowInput, ZamAI } from "@zamtest/ai";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

let app: FastifyInstance;
afterEach(() => app?.close());

const agentHeaders = { "x-agent-key": "k" };
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
const call = (method: "GET" | "POST", url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers, payload: payload as object });

const definition = {
  schemaVersion: 1,
  id: "wf_vi",
  name: "VideoInsight login",
  variables: [],
  root: {
    id: "root",
    type: "core.sequence",
    props: {},
    slots: {
      body: [
        { id: "start", type: "desktop.launch", label: "Start VI Monitor", props: { path: "C:\\VI Monitor.lnk" } },
        { id: "cred", type: "core.getAsset", label: "Get VideoInsight credential", props: { name: "VideoInsight/Login", variable: "credential" } },
      ],
    },
  },
};

describe("Fix with AI", () => {
  it("gives Claude the run's evidence: log, failed step, screenshots, asset names, PC and the live application", async () => {
    let seen: DiagnoseInput | undefined;
    let generated: GenerateWorkflowInput | undefined;
    const diagnosis: Diagnosis = {
      summary: "The credential VideoInsight/Login does not exist.",
      cause: "asset",
      details: "The log says the asset was not found.",
      fixes: [{ kind: "createAsset", title: "Create the credential", why: "The step needs it", name: "VideoInsight/Login", assetType: "credential" }],
    };
    const ai = {
      model: "test",
      diagnoseRun: async (input: DiagnoseInput) => ((seen = input), diagnosis),
      generateWorkflow: async (input: GenerateWorkflowInput) => ((generated = input), { workflow: definition, notes: "" }),
    } as unknown as ZamAI;
    ({ app } = await buildApp({ config: { ...loadConfig({ ZAMTEST_AGENT_KEY: "k" }), dataDir: null }, ai }));

    // Names like folders are allowed now (not at the start or end).
    expect((await call("POST", "/api/assets", { name: "Erp/Url", type: "text", value: "https://erp" })).statusCode).toBe(201);
    expect((await call("POST", "/api/assets", { name: "/bad", type: "text", value: "x" })).statusCode).toBe(400);
    await call("POST", "/api/assets", { name: "VideoInsight.Login", type: "credential", value: { username: "admin", password: "secret-pw" } });

    const { agentId } = (await call("POST", "/api/agent/register", { name: "my-pc", machine: "my-pc", os: "win32 10", version: "0.3.2" }, agentHeaders)).json();
    const job = (await call("POST", "/api/jobs", { definition, source: "designer" })).json();
    await call("POST", "/api/agent/jobs/next", { agentId }, agentHeaders);
    expect((await call("POST", "/api/ai/diagnose", { jobId: job.id })).statusCode).toBe(409); // not failed yet
    const upload = (stepId: string, status: string) =>
      app.inject({ method: "POST", url: `/api/agent/jobs/${job.id}/screenshots?stepId=${stepId}&status=${status}&source=desktop&agentId=${agentId}`, headers: { ...agentHeaders, "content-type": "image/jpeg" }, payload: jpeg });
    await upload("start", "ok");
    await upload("cred", "error");
    await call("POST", `/api/agent/jobs/${job.id}/events`, { agentId, events: [{ type: "stepEnd", stepId: "cred", status: "error", error: 'Asset "VideoInsight/Login" not found', time: new Date().toISOString() }] }, agentHeaders);
    await call("POST", `/api/agent/jobs/${job.id}/complete`, { agentId, status: "failed", error: 'Asset "VideoInsight/Login" not found' }, agentHeaders);

    // The Designer asks the PC for the application's window first.
    const inspect = (await call("POST", "/api/recordings", { agentId, kind: "inspect", selector: 'window[process="vimonitor"]' })).json();
    expect((await call("POST", "/api/agent/recordings/next", { agentId }, agentHeaders)).json()).toMatchObject({ kind: "inspect", selector: 'window[process="vimonitor"]' });
    const inspected = { selector: 'window[process="vimonitor"]', found: true, tree: 'window name="Login" process="vimonitor"\n  edit id="Password"', screen: jpeg.toString("base64") };
    await call("POST", `/api/agent/recordings/${inspect.id}/progress`, { agentId, steps: [], done: true, inspected }, agentHeaders);
    // The Designer does not get the screen back.
    const polled = (await call("GET", `/api/recordings/${inspect.id}`)).json();
    expect(polled.inspected).toMatchObject({ found: true, hasScreen: true });
    expect(polled.inspected.screen).toBeUndefined();

    const res = await call("POST", "/api/ai/diagnose", { jobId: job.id, inspectId: inspect.id, language: "de" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual(diagnosis);
    expect(seen).toMatchObject({
      error: 'Asset "VideoInsight/Login" not found',
      failedStepId: "cred",
      pc: { name: "my-pc", version: "0.3.2" },
      language: "German",
      live: { selector: 'window[process="vimonitor"]', found: true },
    });
    expect(seen!.screenshots!.map((s) => [s.stepId, s.status])).toEqual([["start", "ok"], ["cred", "error"]]);
    expect(seen!.live!.screen).toEqual(jpeg);
    expect(seen!.assets).toEqual(expect.arrayContaining([{ name: "VideoInsight.Login", type: "credential" }]));
    // Asset values never reach the AI.
    expect(JSON.stringify(seen)).not.toContain("secret-pw");
    expect(seen!.logs.some((l) => l.message.includes("not found"))).toBe(true);

    // Build with AI gets the asset names and the application's controls too.
    await call("POST", "/api/ai/generate-workflow", { prompt: "Log in to VI Monitor", inspectId: inspect.id });
    expect(generated).toMatchObject({ live: { selector: 'window[process="vimonitor"]', tree: inspected.tree } });
    expect(generated!.assets).toEqual(expect.arrayContaining([{ name: "Erp/Url", type: "text" }]));
    expect(JSON.stringify(generated)).not.toContain("secret-pw");
  });

  it("does not send inspect to agents that do not know it", async () => {
    ({ app } = await buildApp({ config: { ...loadConfig({ ZAMTEST_AGENT_KEY: "k" }), dataDir: null }, ai: null }));
    const { agentId } = (await call("POST", "/api/agent/register", { name: "old-pc", version: "0.3.1" }, agentHeaders)).json();
    expect((await call("GET", "/api/recordings/agents")).json()).toMatchObject([{ canIndicate: true, canInspect: false }]);
    expect((await call("POST", "/api/recordings", { agentId, kind: "inspect", selector: "window" })).statusCode).toBe(409);
  });
});
