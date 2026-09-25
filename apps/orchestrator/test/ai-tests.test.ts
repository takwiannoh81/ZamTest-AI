import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { BUILTIN_ACTIONS } from "@zamtest/core";
import { checkTests } from "@zamtest/ai";
import type { GenerateTestsInput, ZamAI } from "@zamtest/ai";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

let app: FastifyInstance;
afterEach(() => app?.close());

const agent = { "x-agent-key": "k" };
const call = (method: "GET" | "POST", url: string, payload?: unknown, headers: Record<string, string> = {}) => app.inject({ method, url, headers, payload: payload as object });

const loginSteps = {
  schemaVersion: 1,
  id: "login",
  name: "VIWEB login",
  variables: [{ name: "cred", type: "object", direction: "local" }],
  root: {
    id: "root",
    type: "core.sequence",
    props: {},
    slots: {
      body: [
        { id: "open", type: "browser.open", props: { url: "http://192.168.1.106/viweb" } },
        { id: "get", type: "core.getAsset", props: { name: "VideoInsight/Login", variable: "cred" } },
        { id: "user", type: "browser.type", props: { selector: "css=#user", text: "{{ cred.username }}" } },
      ],
    },
  },
};

const page = (path: string, extra: object = {}) => ({
  url: `http://192.168.1.106${path}`,
  title: path,
  headings: ["Cameras"],
  text: "Cameras Cam 1 Online",
  fields: [],
  buttons: [],
  links: [{ selector: 'role=link[name="Cameras"]', text: "Cameras", href: "http://192.168.1.106/cameras" }],
  tables: [{ selector: "css=#cams", headers: ["Name", "Status"], rows: 2 }],
  screen: Buffer.from("jpeg-bytes").toString("base64"),
  ...extra,
});

describe("Generate tests with AI", () => {
  it("explores on a PC with a new enough agent, then AI writes tests that start with the sign-in steps", async () => {
    let seen: GenerateTestsInput | undefined;
    const ai = {
      model: "test",
      generateTests: async (input: GenerateTestsInput) => {
        seen = input;
        return {
          notes: "- Covered the camera list",
          tests: [
            {
              name: "Camera list shows cameras",
              description: "The cameras page lists the cameras",
              page: "http://192.168.1.106/cameras",
              variables: [{ name: "cred", type: "object", direction: "local" }],
              steps: [
                { id: "nav", type: "browser.navigate", props: { url: "http://192.168.1.106/cameras" } },
                { id: "check", type: "browser.verifyText", props: { selector: "css=#cams", text: "Cam 1" } },
              ],
            },
          ],
        };
      },
    } as unknown as ZamAI;
    ({ app } = await buildApp({ config: { ...loadConfig({ ZAMTEST_AGENT_KEY: "k" }), dataDir: null }, ai }));
    const login = (await call("POST", "/api/test-cases", { name: "VIWEB login", definition: loginSteps })).json();

    const old = (await call("POST", "/api/agent/register", { name: "old-pc", version: "0.3.7" }, agent)).json();
    const tooOld = await call("POST", "/api/recordings", { agentId: old.agentId, kind: "explore", url: "192.168.1.106/viweb" });
    expect(tooOld.statusCode).toBe(409);
    expect(tooOld.json().error).toContain("0.3.8");

    const pc = (await call("POST", "/api/agent/register", { name: "qa-pc", version: "0.3.8" }, agent)).json();
    const pcs = (await call("GET", "/api/recordings/agents")).json();
    expect(pcs.find((p: { id: string }) => p.id === pc.agentId)).toMatchObject({ canExplore: true });
    const started = (await call("POST", "/api/recordings", { agentId: pc.agentId, kind: "explore", url: "192.168.1.106/viweb", prefix: loginSteps, maxPages: 5 })).json();

    // The PC takes it, with the sign-in steps and how far to go.
    const next = (await call("POST", "/api/agent/recordings/next", { agentId: pc.agentId }, agent)).json();
    expect(next).toMatchObject({ kind: "explore", url: "https://192.168.1.106/viweb", maxPages: 5 });
    expect(next.prefix.root.slots.body).toHaveLength(3);
    await call("POST", `/api/agent/recordings/${started.id}/progress`, { agentId: pc.agentId, steps: [], stage: "exploring", note: "1: Cameras" }, agent);
    expect((await call("GET", `/api/recordings/${started.id}`)).json()).toMatchObject({ stage: "exploring", note: "1: Cameras" });
    await call("POST", `/api/agent/recordings/${started.id}/progress`, { agentId: pc.agentId, steps: [], done: true, explored: { pages: [page("/home"), page("/cameras")] } }, agent);

    // The Designer sees which pages were found, not their screens.
    const done = (await call("GET", `/api/recordings/${started.id}`)).json();
    expect(done.explored.pages).toEqual([
      { url: "http://192.168.1.106/home", title: "/home" },
      { url: "http://192.168.1.106/cameras", title: "/cameras" },
    ]);

    const asNotCredential = await call("POST", "/api/assets", { name: "Viweb/Url", type: "text", value: "x" });
    expect(asNotCredential.statusCode).toBe(201);
    expect((await call("POST", "/api/ai/generate-tests", { exploreId: started.id, signIn: { kind: "asset", asset: "Viweb/Url" } })).statusCode).toBe(400);

    const result = await call("POST", "/api/ai/generate-tests", { exploreId: started.id, count: 3, focus: "the cameras", language: "de", signIn: { kind: "steps", testCaseId: login.id } });
    expect(result.statusCode, result.body).toBe(200);
    expect(seen).toMatchObject({ count: 3, focus: "the cameras", language: "German", signIn: { kind: "steps", description: 'the steps of the test case "VIWEB login" run first' } });
    expect(seen!.pages[1]!.screen).toEqual(Buffer.from("jpeg-bytes"));
    const [test] = result.json().tests;
    const body = test.definition.root.slots.body;
    // The sign-in steps first (with their own ids), then AI's steps.
    expect(body.map((s: { type: string }) => s.type)).toEqual(["browser.open", "core.getAsset", "browser.type", "browser.navigate", "browser.verifyText"]);
    expect(body[0].id).not.toBe("open");
    expect(test.definition.variables).toEqual([{ name: "cred", type: "object", direction: "local" }]);
    // It becomes a test case as it is.
    expect((await call("POST", "/api/test-cases", { name: test.name, definition: test.definition })).statusCode).toBe(201);
  });
});

describe("checking AI's tests", () => {
  const catalog = BUILTIN_ACTIONS;
  const reply = (tests: unknown) => "- summary\n```json\n" + JSON.stringify({ tests }) + "\n```";
  it("refuses tests that check nothing or use unknown actions", () => {
    const { errors } = checkTests(
      reply([
        { name: "Opens", steps: [{ id: "a", type: "browser.open", props: { url: "https://x" } }] },
        { name: "Magic", steps: [{ id: "b", type: "browser.teleport", props: {} }, { id: "c", type: "browser.verifyTitle", props: { title: "X" } }] },
      ]),
      catalog,
      5,
    );
    expect(errors).toEqual(['tests[0] ("Opens") checks nothing: add a Verify step', 'tests[1] uses unknown action type "browser.teleport"']);
  });
  it("accepts good tests", () => {
    const { tests, errors } = checkTests(
      reply([{ name: "Title", description: "d", steps: [{ id: "a", type: "browser.open", props: { url: "https://x" } }, { id: "a", type: "browser.verifyTitle", props: { title: "X" } }] }]),
      catalog,
      5,
    );
    expect(errors).toEqual([]);
    // Two steps with the same id get different ones.
    expect(new Set(tests![0]!.steps.map((s) => s.id)).size).toBe(2);
  });
});
