import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

let app: FastifyInstance;
afterEach(() => app?.close());

const call = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => app.inject({ method, url, payload: payload as object });
const steps = { schemaVersion: 1, id: "t", name: "t", variables: [], root: { id: "root", type: "core.sequence", props: {}, slots: { body: [{ id: "s", type: "core.log", props: { message: "hi" } }] } } };

describe("schedules of test cases", () => {
  it("run a folder's test cases (with its sub-folders) as a test run, in the time zone chosen", async () => {
    ({ app } = await buildApp({ config: { ...loadConfig({}), dataDir: null }, ai: null }));
    const web = (await call("POST", "/api/test-folders", { name: "Web" })).json();
    const login = (await call("POST", "/api/test-folders", { name: "Login", parentId: web.id })).json();
    await call("POST", "/api/test-cases", { name: "VIWEB", folderId: login.id, definition: steps });
    await call("POST", "/api/test-cases", { name: "Elsewhere", definition: steps });

    // Nothing chosen, or both: said plainly.
    expect((await call("POST", "/api/schedules", { name: "x", cron: "*/5 * * * *" })).json().error).toContain("Choose what to run");
    expect((await call("POST", "/api/schedules", { name: "x", cron: "*/5 * * * *", packageId: "p", tests: {} })).json().error).toContain("either a process or test cases");
    // "CST" is understood; a made-up zone is explained.
    expect((await call("POST", "/api/schedules", { name: "x", cron: "*/5 * * * *", tests: {}, timezone: "Mars/Olympus" })).json().error).toContain("Unknown time zone");

    const created = await call("POST", "/api/schedules", { name: "Web every 5 minutes", cron: "*/5 * * * *", tests: { folderId: web.id }, timezone: "CST" });
    expect(created.statusCode, created.body).toBe(201);
    const schedule = created.json();
    expect(schedule).toMatchObject({ tests: { folderId: web.id }, timezone: "America/Chicago" });
    expect(schedule.packageId).toBeUndefined();

    expect((await call("POST", `/api/schedules/${schedule.id}/run`)).statusCode).toBe(200);
    const runs = (await call("GET", "/api/test-runs")).json();
    expect(runs[0]).toMatchObject({ name: "Web", startedBy: "schedule: Web every 5 minutes" });
    expect(runs[0].items.map((i: { name: string }) => i.name)).toEqual(["VIWEB"]);
  });
});
