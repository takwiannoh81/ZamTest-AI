/**
 * "Generate tests with AI": after the agent explored a website on the person's
 * PC, AI writes test cases from what it found (fields, buttons, links, text and
 * screens). The Designer shows them; the person keeps the ones they want.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { BUILTIN_ACTIONS, newStepId, SIGN_IN_VARIABLES, signInSteps } from "@zamtest/core";
import type { Step, VariableDef, Workflow } from "@zamtest/core";
import { TEST_KINDS } from "@zamtest/ai";
import type { ZamAI } from "@zamtest/ai";
import { languageName } from "@zamtest/i18n";
import { HttpError, parse } from "./errors.js";
import type { Recordings } from "./recordings.js";
import type { Store } from "./store.js";
import type { Principal } from "./types.js";

export interface AiTestsContext {
  store: Store;
  getAi(): ZamAI;
  useAi(workspaceId: string): void;
  me(req: FastifyRequest): Principal;
  own<T extends { workspaceId: string }>(collection: Record<string, T>, id: string, what: string, req: FastifyRequest): T;
  recordings: Recordings;
}

/** A copy of steps with new ids (so each test case's steps are its own). */
export function freshIds(steps: Step[]): Step[] {
  return steps.map((step) => ({
    ...step,
    id: newStepId(),
    slots: step.slots ? Object.fromEntries(Object.entries(step.slots).map(([slot, children]) => [slot, freshIds(children)])) : undefined,
  }));
}

/** An address as typed: https:// is added when it has no scheme. */
export const withScheme = (url: string) => (/^(https?|file):\/\//i.test(url) ? url : `https://${url}`);

const Body = z.object({
  exploreId: z.string().min(1),
  focus: z.string().max(2000).optional(),
  kinds: z.array(z.enum(TEST_KINDS)).max(TEST_KINDS.length).optional(),
  testData: z.string().max(4000).optional(),
  allowChanges: z.boolean().optional(),
  count: z.number().int().min(1).max(15).default(8),
  language: z.string().optional(),
  signIn: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("none") }),
      z.object({ kind: z.literal("steps"), workflowId: z.string().optional(), testCaseId: z.string().optional() }),
      z.object({ kind: z.literal("asset"), asset: z.string().min(1).max(200) }),
      // Signs in with a saved user name and password on the site's sign-in form (see signInSteps).
      z.object({ kind: z.literal("login"), asset: z.string().min(1).max(200), signInUrl: z.string().trim().max(2000).optional(), url: z.string().trim().max(2000).optional() }),
    ])
    .default({ kind: "none" }),
});

export function registerAiTests(app: FastifyInstance, ctx: AiTestsContext): void {
  const { store } = ctx;

  app.post("/api/ai/generate-tests", async (req) => {
    const ai = ctx.getAi();
    const body = parse(Body, req.body);
    const workspaceId = ctx.me(req).workspaceId;
    const explored = ctx.recordings.get(body.exploreId, workspaceId);
    if (!explored?.explored) throw new HttpError(404, "The exploration has expired; explore the site again");
    const pages = explored.explored.pages;
    if (!pages.some((p) => !p.beforeSignIn)) throw new HttpError(409, "No page was explored: check the address, and that the PC can open it");

    // The sign-in steps each test starts with (a workflow is called; a test case's steps are copied).
    let before: { steps: Step[]; variables: VariableDef[]; description: string } | undefined;
    if (body.signIn.kind === "steps") {
      if (body.signIn.workflowId) {
        const wf = ctx.own(store.data.workflows, body.signIn.workflowId, "Workflow", req);
        before = {
          steps: [{ id: newStepId(), type: "core.callWorkflow", label: wf.name, props: { workflowId: wf.id } }],
          variables: [],
          description: `the workflow "${wf.name}" runs first`,
        };
      } else if (body.signIn.testCaseId) {
        const tc = ctx.own(store.data.testCases, body.signIn.testCaseId, "Test case", req);
        const def = tc.definition as Workflow | undefined;
        if (!def?.root.slots?.body?.length) throw new HttpError(400, `The test case "${tc.name}" has no steps to sign in with`);
        before = { steps: def.root.slots.body, variables: def.variables, description: `the steps of the test case "${tc.name}" run first` };
      } else throw new HttpError(400, "Choose the workflow or test case that signs in");
    }
    if (body.signIn.kind === "asset" || body.signIn.kind === "login") {
      const asset = Object.values(store.data.assets).find((a) => a.workspaceId === workspaceId && a.name === (body.signIn as { asset: string }).asset);
      if (!asset) throw new HttpError(404, `There is no asset called "${body.signIn.asset}"`);
      if (asset.type !== "credential") throw new HttpError(400, `"${asset.name}" is not a credential (a user name and password)`);
    }
    if (body.signIn.kind === "asset" && !pages.some((p) => p.beforeSignIn)) {
      throw new HttpError(409, "The sign-in page was not seen: explore again with \"I sign in myself\"");
    }
    if (body.signIn.kind === "login") {
      const url = body.signIn.url ? withScheme(body.signIn.url) : undefined;
      const signInUrl = body.signIn.signInUrl ? withScheme(body.signIn.signInUrl) : url;
      if (!signInUrl) throw new HttpError(400, "Enter the address of the sign-in page");
      before = {
        steps: signInSteps({ asset: body.signIn.asset, signInUrl, thenUrl: url }),
        variables: SIGN_IN_VARIABLES,
        description: `they sign in with the saved user name and password "${body.signIn.asset}"`,
      };
    }
    ctx.useAi(workspaceId);

    const result = await ai.generateTests({
      pages: pages.map((p) => ({ ...p, screen: p.screen ? Buffer.from(p.screen, "base64") : undefined })),
      signIn: before ? { kind: "steps", description: before.description } : body.signIn.kind === "asset" ? { kind: "asset", asset: body.signIn.asset } : { kind: "none" },
      focus: body.focus,
      kinds: body.kinds,
      testData: body.testData,
      allowChanges: body.allowChanges,
      count: body.count,
      assets: Object.values(store.data.assets)
        .filter((a) => a.workspaceId === workspaceId)
        .map((a) => ({ name: a.name, type: a.type })),
      catalog: BUILTIN_ACTIONS,
      language: body.language ? languageName(body.language) : undefined,
    });

    return {
      notes: result.notes,
      tests: result.tests.map((t, i) => {
        const variables = [...(before?.variables ?? [])];
        for (const v of t.variables) if (!variables.some((x) => x.name === v.name)) variables.push(v);
        const definition: Workflow = {
          schemaVersion: 1,
          id: `generated-${i + 1}`,
          name: t.name,
          description: t.description,
          variables,
          root: { id: "root", type: "core.sequence", props: {}, slots: { body: [...(before ? freshIds(before.steps) : []), ...t.steps] } },
        };
        return { name: t.name, description: t.description, page: t.page, definition };
      }),
    };
  });
}
