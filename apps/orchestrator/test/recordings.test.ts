import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

let app: FastifyInstance;
afterEach(() => app?.close());

const agent = { "x-agent-key": "k" };
const call = (method: "GET" | "POST", url: string, payload?: unknown, headers: Record<string, string> = {}) => app.inject({ method, url, headers, payload: payload as object });
const step = (id: string, type: string, props: Record<string, unknown> = {}) => ({ id, type, props });

describe("recording from the Designer", () => {
  it("goes to the PC's agent, streams its steps back, and stops when asked", async () => {
    ({ app } = await buildApp({ config: { ...loadConfig({ ZAMTEST_AGENT_KEY: "k" }), dataDir: null }, ai: null }));
    const { agentId } = (await call("POST", "/api/agent/register", { name: "my-pc" }, agent)).json();

    // Before its agent has asked for recordings, the PC shows as not able to record.
    expect((await call("GET", "/api/recordings/agents")).json()).toMatchObject([{ id: agentId, canRecord: false }]);
    expect((await call("POST", "/api/agent/recordings/next", { agentId }, agent)).statusCode).toBe(204);
    expect((await call("GET", "/api/recordings/agents")).json()).toMatchObject([{ id: agentId, canRecord: true }]);

    expect((await call("POST", "/api/recordings", { agentId, kind: "web" })).statusCode).toBe(400);
    const started = await call("POST", "/api/recordings", { agentId, kind: "web", url: "example.com" });
    expect(started.statusCode, started.body).toBe(201);
    const rec = started.json();
    expect(rec).toMatchObject({ status: "pending", url: "https://example.com", agentName: "my-pc" });
    // One recording at a time per PC.
    expect((await call("POST", "/api/recordings", { agentId, kind: "desktop" })).statusCode).toBe(409);

    // The agent takes it and reports steps as they happen.
    expect((await call("POST", "/api/agent/recordings/next", { agentId }, agent)).json()).toEqual({ id: rec.id, kind: "web", url: "https://example.com" });
    const steps = [step("s1", "browser.open", { url: "https://example.com" }), step("s2", "browser.click", { selector: "text=More" })];
    expect((await call("POST", `/api/agent/recordings/${rec.id}/progress`, { agentId, steps }, agent)).json()).toEqual({ stop: false });
    expect((await call("GET", `/api/recordings/${rec.id}`)).json()).toMatchObject({ status: "recording", steps: [{ id: "s1" }, { id: "s2" }] });

    // Stop in the Designer: the agent hears it with its next report, and sends the final steps.
    expect((await call("POST", `/api/recordings/${rec.id}/stop`)).json().status).toBe("stopping");
    expect((await call("POST", `/api/agent/recordings/${rec.id}/progress`, { agentId, steps }, agent)).json()).toEqual({ stop: true });
    const variables = [{ name: "password", type: "string", direction: "in" }];
    await call("POST", `/api/agent/recordings/${rec.id}/progress`, { agentId, steps: [...steps, step("s3", "browser.type", { selector: "#pw", text: "{{ password }}" })], variables, done: true }, agent);
    expect((await call("GET", `/api/recordings/${rec.id}`)).json()).toMatchObject({ status: "done", steps: [{}, {}, { id: "s3" }], variables: [{ name: "password" }] });

    // Now the PC is free again; a failure is reported with its message.
    const second = (await call("POST", "/api/recordings", { agentId, kind: "desktop", program: "notepad.exe" })).json();
    await call("POST", "/api/agent/recordings/next", { agentId }, agent);
    await call("POST", `/api/agent/recordings/${second.id}/progress`, { agentId, steps: [], error: "The program could not start" }, agent);
    expect((await call("GET", `/api/recordings/${second.id}`)).json()).toMatchObject({ status: "failed", error: "The program could not start" });
  });

  it("indicates the application to record on newer agents, then records it without starting it again", async () => {
    ({ app } = await buildApp({ config: { ...loadConfig({ ZAMTEST_AGENT_KEY: "k" }), dataDir: null }, ai: null }));
    const register = async (version: string, agentId?: string) =>
      (await call("POST", "/api/agent/register", { agentId, name: "my-pc", machine: "my-pc", version }, agent)).json().agentId as string;

    // A 0.3.0 agent would record the whole desktop instead: not offered.
    const agentId = await register("0.3.0");
    await call("POST", "/api/agent/recordings/next", { agentId }, agent);
    expect((await call("GET", "/api/recordings/agents")).json()).toMatchObject([{ canRecord: true, canIndicate: false }]);
    expect((await call("POST", "/api/recordings", { agentId, kind: "indicate" })).statusCode).toBe(409);

    await register("0.3.1", agentId);
    expect((await call("GET", "/api/recordings/agents")).json()).toMatchObject([{ canIndicate: true }]);
    const pick = (await call("POST", "/api/recordings", { agentId, kind: "indicate", hint: "Click the application" })).json();
    expect((await call("POST", "/api/agent/recordings/next", { agentId }, agent)).json()).toEqual({ id: pick.id, kind: "indicate", hint: "Click the application" });
    const picked = { path: "C:\\Windows\\System32\\charmap.exe", process: "charmap", title: "Character Map" };
    await call("POST", `/api/agent/recordings/${pick.id}/progress`, { agentId, steps: [], done: true, picked }, agent);
    expect((await call("GET", `/api/recordings/${pick.id}`)).json()).toMatchObject({ status: "done", picked });

    // The indicated program is open already: the agent is told not to start it again.
    const rec = (await call("POST", "/api/recordings", { agentId, kind: "desktop", program: picked.path, attach: true })).json();
    expect((await call("POST", "/api/agent/recordings/next", { agentId }, agent)).json()).toEqual({ id: rec.id, kind: "desktop", program: picked.path, attach: true });
  });

  it("lets the person indicate an element on a web page or in an application, on agents that know it", async () => {
    ({ app } = await buildApp({ config: { ...loadConfig({ ZAMTEST_AGENT_KEY: "k" }), dataDir: null }, ai: null }));
    const agentId = (await call("POST", "/api/agent/register", { name: "pc", machine: "pc", version: "0.3.2" }, agent)).json().agentId as string;
    expect((await call("POST", "/api/recordings", { agentId, kind: "pick", target: "web" })).statusCode).toBe(409);
    await call("POST", "/api/agent/register", { agentId, name: "pc", machine: "pc", version: "0.3.3" }, agent);
    expect((await call("GET", "/api/recordings/agents")).json()).toMatchObject([{ canPick: true }]);

    const web = (await call("POST", "/api/recordings", { agentId, kind: "pick", target: "web", url: "erp.example/login", hint: "Click it" })).json();
    expect((await call("POST", "/api/agent/recordings/next", { agentId }, agent)).json()).toEqual({ id: web.id, kind: "pick", target: "web", url: "https://erp.example/login", hint: "Click it" });
    const element = { selector: 'css=[data-testid="sign-in"]', description: "The Sign in button" };
    await call("POST", `/api/agent/recordings/${web.id}/progress`, { agentId, steps: [], done: true, element }, agent);
    expect((await call("GET", `/api/recordings/${web.id}`)).json()).toMatchObject({ status: "done", element });

    const app2 = (await call("POST", "/api/recordings", { agentId, kind: "pick" })).json();
    expect((await call("POST", "/api/agent/recordings/next", { agentId }, agent)).json()).toEqual({ id: app2.id, kind: "pick", target: "desktop" });
  });
});
