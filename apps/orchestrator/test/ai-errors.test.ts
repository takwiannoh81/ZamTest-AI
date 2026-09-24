import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { AiApiError } from "@zamtest/ai";
import type { ZamAI } from "@zamtest/ai";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

let app: FastifyInstance;
afterEach(() => app?.close());

/** An AI whose calls fail the way Anthropic's API answers. */
const failingAi = (status: number) =>
  ({
    model: "test",
    generateWorkflow: async () => {
      throw new AiApiError(status, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, "invalid x-api-key", new Headers());
    },
  }) as unknown as ZamAI;

describe("AI service errors", () => {
  it("say what to do instead of showing the raw answer", async () => {
    const config = { ...loadConfig({}), dataDir: null };
    for (const [status, code] of [
      [401, "ai_key_invalid"],
      [529, "ai_busy"],
    ] as const) {
      ({ app } = await buildApp({ config, ai: failingAi(status) }));
      const res = await app.inject({ method: "POST", url: "/api/ai/generate-workflow", payload: { prompt: "open a website" } });
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe(code);
      expect(res.body).not.toContain("x-api-key");
      await app.close();
    }
  });
});
