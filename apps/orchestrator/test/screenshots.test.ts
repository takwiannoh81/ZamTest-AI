import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

let app: FastifyInstance;
afterEach(() => app?.close());

const agentHeaders = { "x-agent-key": "k" };
const definition = {
  id: "hello",
  name: "Hello",
  variables: [],
  root: { id: "root", type: "core.sequence", props: {}, slots: { body: [{ id: "open", type: "browser.open", label: "Open the ERP", props: { url: "https://erp.example" } }] } },
};
// The smallest valid-looking JPEG header is enough for the server.
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

describe("step screenshots", () => {
  it("are uploaded by the job's PC, listed with the step's name, shown, and deleted with the job", async () => {
    const config = { ...loadConfig({ ZAMTEST_AGENT_KEY: "k" }), dataDir: null };
    ({ app } = await buildApp({ config, ai: null }));
    const { agentId } = (await app.inject({ method: "POST", url: "/api/agent/register", headers: agentHeaders, payload: { name: "bot-1" } })).json();
    const other = (await app.inject({ method: "POST", url: "/api/agent/register", headers: agentHeaders, payload: { name: "bot-2", machine: "other" } })).json().agentId;
    const job = (await app.inject({ method: "POST", url: "/api/jobs", payload: { definition, source: "designer" } })).json();
    await app.inject({ method: "POST", url: "/api/agent/jobs/next", headers: agentHeaders, payload: { agentId } });

    const upload = (body: Buffer, query: string, agent = agentId) =>
      app.inject({ method: "POST", url: `/api/agent/jobs/${job.id}/screenshots?${query}&agentId=${agent}`, headers: { ...agentHeaders, "content-type": "image/jpeg" }, payload: body });
    expect((await upload(Buffer.from("not an image"), "stepId=open")).statusCode).toBe(400);
    const first = await upload(jpeg, "stepId=open&status=ok&source=browser");
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toMatchObject({ seq: 1, stepId: "open", label: "Open the ERP", stepType: "browser.open", status: "ok" });
    expect((await upload(jpeg, "stepId=open&status=error&source=desktop")).json().seq).toBe(2);

    const list = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/screenshots` })).json();
    expect(list.map((s: { seq: number; status: string }) => [s.seq, s.status])).toEqual([[1, "ok"], [2, "error"]]);
    const image = await app.inject({ method: "GET", url: `/api/jobs/${job.id}/screenshots/1` });
    expect(image.headers["content-type"]).toBe("image/jpeg");
    expect(image.rawPayload.equals(jpeg)).toBe(true);
    expect((await app.inject({ method: "GET", url: `/api/jobs/${job.id}/screenshots/9` })).statusCode).toBe(404);

    await app.inject({ method: "POST", url: `/api/agent/jobs/${job.id}/complete`, headers: agentHeaders, payload: { agentId, status: "succeeded" } });
    expect((await app.inject({ method: "DELETE", url: `/api/jobs/${job.id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/api/jobs/${job.id}/screenshots/1` })).statusCode).toBe(404);
    void other;
  });
});
