import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { VisionInput, VisionResult, ZamAI } from "@zamtest/ai";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { usageOf } from "../src/plans.js";
import { Store } from "../src/store.js";

let app: FastifyInstance;
afterEach(() => app?.close());

const agentKey = { "x-agent-key": "k" };

describe("AI Vision for bots", () => {
  it("looks at the screenshot with AI, counts one AI request per look, and checks what it gets", async () => {
    const seen: VisionInput[] = [];
    const ai = {
      model: "test",
      lookAtScreen: async (input: VisionInput): Promise<VisionResult> => {
        seen.push(input);
        return { found: true, x: 120, y: 48, confidence: 0.95, reason: "The Submit button" };
      },
    } as unknown as ZamAI;
    const store = new Store(null);
    ({ app } = await buildApp({ config: { ...loadConfig({ ZAMTEST_AGENT_KEY: "k" }), dataDir: null }, store, ai }));
    const { agentId } = (await app.inject({ method: "POST", url: "/api/agent/register", headers: agentKey, payload: { name: "pc", version: "0.4.0" } })).json();
    const image = Buffer.from("a jpeg").toString("base64");
    const look = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/api/agent/vision", headers: agentKey, payload: { agentId, task: "locate", target: "the Submit button", image, mediaType: "image/jpeg", width: 1280, height: 720, ...payload } });

    const before = usageOf(store, "ws_default").ai;
    const res = await look({});
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ found: true, x: 120, y: 48, confidence: 0.95, reason: "The Submit button" });
    expect(seen[0]).toMatchObject({ task: "locate", target: "the Submit button", width: 1280, height: 720, mediaType: "image/jpeg" });
    expect(seen[0]!.image.toString()).toBe("a jpeg");
    expect(usageOf(store, "ws_default").ai).toBe(before + 1);

    expect((await look({ target: "  " })).statusCode).toBe(400);
    expect((await look({ task: "click" })).statusCode).toBe(400);
    // Only bots can ask.
    expect((await app.inject({ method: "POST", url: "/api/agent/vision", payload: { task: "check" } })).statusCode).toBe(401);
  });
});
