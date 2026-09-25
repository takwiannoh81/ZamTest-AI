import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { GitRepos } from "../src/git.js";
import { Store } from "../src/store.js";

let app: FastifyInstance;
const cleanups: Array<() => void> = [];
afterEach(async () => {
  await app?.close();
  while (cleanups.length) cleanups.pop()!();
});

const TOKEN = "master-token-0123456789abcdef";
const master = { authorization: `Bearer ${TOKEN}` };
const PASSWORD = "correct horse battery";
const agentKey = { "x-agent-key": "shared-key-0123456789abcdef" };

const cookieOf = (res: LightMyRequestResponse) => String(res.headers["set-cookie"]).split(";")[0]!;
type Headers = Record<string, string>;
const call = (headers: Headers, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, headers, payload: payload as object });

const workflow = (name: string, message = "hello") => ({
  schemaVersion: 1,
  id: "wf_from_ci",
  name,
  variables: [],
  root: { id: "root", type: "core.sequence", props: {}, slots: { body: [{ id: "s1", type: "core.log", props: { message } }] } },
});

async function setup(git?: GitRepos) {
  const config = { ...loadConfig({ ZAMTEST_ADMIN_TOKEN: TOKEN, ZAMTEST_AGENT_KEY: agentKey["x-agent-key"], ZAMTEST_ALLOW_SIGNUP: "true" }), dataDir: null };
  ({ app } = await buildApp({ config, store: new Store(null), ai: null, git }));
}

/** People of the platform owner's own (Enterprise) workspace. */
async function person(role: string, name = role) {
  const email = `${name}@example.com`;
  await call(master, "POST", "/api/users", { email, name, role, password: PASSWORD });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return { cookie: cookieOf(res), "x-zamtech-client": "test" };
}

async function registerPc(name: string) {
  const res = await app.inject({ method: "POST", url: "/api/agent/register", headers: agentKey, payload: { name, machine: name } });
  return res.json().agentId as string;
}
const nextJob = (agentId: string) => app.inject({ method: "POST", url: "/api/agent/jobs/next", headers: agentKey, payload: { agentId } });

describe("environments and promotion", () => {
  it("publishes to Development, promotes to Test, and needs a second admin's approval for Production", async () => {
    await setup();
    const dev = await person("developer", "dana");
    const admin1 = await person("admin", "ada");
    const admin2 = await person("admin", "ben");
    expect((await call(admin1, "PUT", "/api/cicd/settings", { environments: true, requireApproval: true })).statusCode).toBe(200);

    const wf = (await call(dev, "POST", "/api/workflows", { definition: workflow("Invoices") })).json();
    const v1 = (await call(dev, "POST", `/api/workflows/${wf.id}/publish`, {})).json();
    expect(Object.keys(v1.deployments)).toEqual(["dev"]);

    // Not in Test yet, so not to Production either.
    expect((await call(dev, "POST", `/api/packages/${v1.id}/promote`, { to: "prod" })).statusCode).toBe(409);
    const toTest = await call(dev, "POST", `/api/packages/${v1.id}/promote`, { to: "test" });
    expect(toTest.statusCode).toBe(200);
    expect(toTest.json()).toMatchObject({ status: "approved", to: "test" });

    const ask = await call(admin1, "POST", `/api/packages/${v1.id}/promote`, { to: "prod", note: "Tested by finance" });
    expect(ask.statusCode).toBe(202);
    const request = ask.json();
    expect(request).toMatchObject({ status: "pending", to: "prod", version: 1 });
    expect((await call(admin1, "POST", `/api/packages/${v1.id}/promote`, { to: "prod" })).statusCode).toBe(409);
    // Not the one who asked, and not a developer.
    expect((await call(admin1, "POST", `/api/promotions/${request.id}/approve`, {})).statusCode).toBe(403);
    expect((await call(dev, "POST", `/api/promotions/${request.id}/approve`, {})).statusCode).toBe(403);
    let envs = (await call(dev, "GET", "/api/environments")).json();
    expect(envs.environments.find((e: { id: string }) => e.id === "prod").processes).toEqual([]);

    const approved = await call(admin2, "POST", `/api/promotions/${request.id}/approve`, { note: "OK" });
    expect(approved.json()).toMatchObject({ status: "approved", decidedBy: "ben <ben@example.com>" });
    envs = (await call(dev, "GET", "/api/environments")).json();
    expect(envs.enabled).toBe(true);
    expect(envs.environments.map((e: { id: string; processes: unknown[] }) => [e.id, e.processes.length])).toEqual([["dev", 1], ["test", 1], ["prod", 1]]);

    // Version 2 is only in Development; Production keeps running version 1.
    await call(dev, "PUT", `/api/workflows/${wf.id}`, { definition: workflow("Invoices", "v2") });
    const v2 = (await call(dev, "POST", `/api/workflows/${wf.id}/publish`, {})).json();
    envs = (await call(dev, "GET", "/api/environments")).json();
    const current = (env: string) => envs.environments.find((e: { id: string }) => e.id === env).processes[0].version;
    expect([current("dev"), current("test"), current("prod")]).toEqual([2, 1, 1]);
    const rejected = await call(admin2, "POST", `/api/packages/${v2.id}/promote`, { to: "test" });
    expect(rejected.statusCode).toBe(200);
    const ask2 = (await call(dev, "POST", `/api/packages/${v2.id}/promote`, { to: "prod" })).json();
    expect((await call(admin1, "POST", `/api/promotions/${ask2.id}/reject`, { note: "Not yet" })).json()).toMatchObject({ status: "rejected" });
    expect((await call(dev, "GET", "/api/promotions")).json()).toHaveLength(4);
  });

  it("says why a job is waiting, so the Designer can tell what to do", async () => {
    await setup();
    const admin = await person("admin", "ada");
    const waiting = async (id: string) => (await call(admin, "GET", `/api/jobs/${id}`)).json().waiting;
    const draft = { definition: workflow("Draft") };

    const first = (await call(admin, "POST", "/api/jobs", draft)).json();
    expect(await waiting(first.id)).toEqual({ reason: "noAgents" });
    const pc = await registerPc("my-pc");
    expect(await waiting(first.id)).toEqual({ reason: "starting" });
    expect((await nextJob(pc)).json().id).toBe(first.id);
    expect(await waiting(first.id)).toBeUndefined();

    // The PC is running that one.
    const second = (await call(admin, "POST", "/api/jobs", draft)).json();
    expect(await waiting(second.id)).toEqual({ reason: "busy" });
    await call(admin, "POST", `/api/jobs/${second.id}/cancel`);

    // With environments on, a draft runs in Development, and the PC is in Production.
    await call(admin, "PUT", "/api/cicd/settings", { environments: true, requireApproval: false });
    const third = (await call(admin, "POST", "/api/jobs", draft)).json();
    expect(await waiting(third.id)).toEqual({ reason: "environment", environment: "dev" });
    await call(admin, "PUT", `/api/agents/${pc}/environment`, { environment: "dev" });
    expect(await waiting(third.id)).toEqual({ reason: "busy" });
  });

  it("runs each environment's jobs only on its own PCs, with its own assets", async () => {
    await setup();
    const admin = await person("admin", "ada");
    await call(admin, "PUT", "/api/cicd/settings", { environments: true, requireApproval: false });
    const devPc = await registerPc("dev-pc");
    const prodPc = await registerPc("prod-pc");
    expect((await call(admin, "PUT", `/api/agents/${devPc}/environment`, { environment: "dev" })).statusCode).toBe(200);

    const wf = (await call(admin, "POST", "/api/workflows", { definition: workflow("Payroll") })).json();
    const v1 = (await call(admin, "POST", `/api/workflows/${wf.id}/publish`, {})).json();
    // Version 1 is not in Production yet.
    expect((await call(admin, "POST", "/api/jobs", { packageId: v1.id })).statusCode).toBe(409);
    expect((await call(admin, "POST", "/api/jobs", { packageId: v1.id, targetAgentId: prodPc, environment: "dev" })).statusCode).toBe(409);
    const devJob = (await call(admin, "POST", "/api/jobs", { packageId: v1.id, environment: "dev" })).json();
    expect(devJob.environment).toBe("dev");
    // A test run of an unsaved workflow is for Development.
    expect((await call(admin, "POST", "/api/jobs", { definition: workflow("Draft"), environment: "prod" })).statusCode).toBe(409);

    expect((await nextJob(prodPc)).statusCode).toBe(204);
    expect((await nextJob(devPc)).json().id).toBe(devJob.id);

    // Same asset name: Development's own value for its PCs, the shared one elsewhere.
    await call(admin, "POST", "/api/assets", { name: "ErpUrl", type: "text", value: "https://erp.example" });
    await call(admin, "POST", "/api/assets", { name: "ErpUrl", type: "text", value: "https://erp-test.example", environment: "dev" });
    expect((await call(admin, "POST", "/api/assets", { name: "ErpUrl", type: "text", value: "x", environment: "dev" })).statusCode).toBe(409);
    const asset = (id: string) => app.inject({ method: "GET", url: "/api/agent/assets/ErpUrl", headers: agentKey, query: { agentId: id } });
    expect((await asset(prodPc)).json().value).toBe("https://erp.example");

    await call(admin, "POST", `/api/packages/${v1.id}/promote`, { to: "test" });
    await call(admin, "POST", `/api/packages/${v1.id}/promote`, { to: "prod" });
    const prodJob = (await call(admin, "POST", "/api/jobs", { packageId: v1.id })).json();
    expect(prodJob.environment).toBe("prod");
    expect((await nextJob(prodPc)).json().id).toBe(prodJob.id);
  });

  it("is part of Pro and Enterprise; while off, everything is Production as before", async () => {
    await setup();
    const signup = await app.inject({ method: "POST", url: "/api/auth/signup", payload: { company: "Small Co", name: "Sam", email: "sam@small.example", password: PASSWORD } });
    const sam = { cookie: cookieOf(signup), "x-zamtech-client": "test" };
    const put = await call(sam, "PUT", "/api/cicd/settings", { environments: true, requireApproval: true });
    expect(put.statusCode).toBe(402);
    expect((await call(sam, "POST", "/api/api-tokens", { name: "ci" })).statusCode).toBe(402);

    const wf = (await call(sam, "POST", "/api/workflows", { definition: workflow("Hello") })).json();
    const v1 = (await call(sam, "POST", `/api/workflows/${wf.id}/publish`, {})).json();
    expect(Object.keys(v1.deployments)).toEqual(["prod"]);
    expect((await call(sam, "POST", `/api/packages/${v1.id}/promote`, { to: "test" })).statusCode).toBe(409);
    expect((await call(sam, "POST", "/api/jobs", { packageId: v1.id })).statusCode).toBe(201);
    expect((await call(sam, "GET", "/api/environments")).json()).toMatchObject({ enabled: false, environments: [{ id: "prod" }] });
  });
});

describe("API tokens for CI pipelines", () => {
  it("lets a pipeline check, publish and promote, but never administer or approve", async () => {
    await setup();
    const admin = await person("admin", "ada");
    await call(admin, "PUT", "/api/cicd/settings", { environments: true, requireApproval: true });
    const created = await call(admin, "POST", "/api/api-tokens", { name: "GitHub Actions", role: "developer", expiresInDays: 90 });
    expect(created.statusCode).toBe(201);
    const { token, id } = created.json();
    expect(token).toMatch(/^ztat_/);
    const list = (await call(admin, "GET", "/api/api-tokens")).json();
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(token);
    expect(JSON.stringify(list)).not.toContain("tokenHash");

    const ci = { authorization: `Bearer ${token}` };
    expect((await call(ci, "POST", "/api/ci/validate", { definition: workflow("Ok") })).json()).toEqual({ valid: true, errors: [] });
    const bad = workflow("Bad") as ReturnType<typeof workflow>;
    bad.root.slots.body[0]!.type = "acme.unknown";
    expect((await call(ci, "POST", "/api/ci/validate", { definition: bad })).json()).toMatchObject({ valid: false, errors: [expect.stringContaining("acme.unknown")] });
    expect((await call(ci, "POST", "/api/ci/publish", { definition: bad })).statusCode).toBe(400);

    const published = await call(ci, "POST", "/api/ci/publish", { definition: workflow("Invoices"), releaseNotes: "CI build 42", commit: "abc1234", path: "workflows/invoices.json" });
    expect(published.statusCode).toBe(201);
    const { workflowId, package: v1 } = published.json();
    expect(v1).toMatchObject({ version: 1, releaseNotes: "CI build 42", source: { commit: "abc1234" }, deployments: { dev: { by: 'API token "GitHub Actions"' } } });
    // Publishing again updates the same workflow (matched by name).
    const again = (await call(ci, "POST", "/api/ci/publish", { definition: workflow("Invoices", "v2") })).json();
    expect(again.workflowId).toBe(workflowId);
    expect(again.package.version).toBe(2);

    expect((await call(ci, "POST", `/api/packages/${v1.id}/promote`, { to: "test" })).statusCode).toBe(200);
    const ask = (await call(ci, "POST", `/api/packages/${v1.id}/promote`, { to: "prod" })).json();
    expect(ask.status).toBe("pending");
    expect((await call(ci, "GET", `/api/promotions/${ask.id}`)).json().status).toBe("pending");

    // Not an admin, not the platform owner, and no approvals.
    expect((await call(ci, "GET", "/api/users")).statusCode).toBe(403);
    expect((await call(ci, "GET", "/api/platform/workspaces")).statusCode).toBe(403);
    expect((await call(ci, "POST", "/api/api-tokens", { name: "more" })).statusCode).toBe(403);
    expect((await call(ci, "POST", `/api/promotions/${ask.id}/approve`, {})).statusCode).toBe(403);
    expect((await call(admin, "POST", `/api/promotions/${ask.id}/approve`, {})).json().status).toBe("approved");

    expect((await call(admin, "DELETE", `/api/api-tokens/${id}`)).statusCode).toBe(204);
    expect((await call(ci, "GET", "/api/packages")).statusCode).toBe(401);
  });
});

describe("Git for workflows", () => {
  /** A repository like one on GitHub, as a bare repository on disk (file://). */
  function remoteRepo() {
    const dir = mkdtempSync(join(tmpdir(), "zt-remote-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const bare = join(dir, "automations.git");
    execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch", "main", bare]);
    const url = pathToFileURL(bare).href;
    /** Someone else's clone, to change files the way a developer's push would. */
    const clone = () => {
      const work = join(dir, `work-${Date.now()}`);
      execFileSync("git", ["-c", "protocol.file.allow=always", "clone", "--quiet", url, work]);
      const git = (...args: string[]) => execFileSync("git", ["-C", work, "-c", "user.name=Eve", "-c", "user.email=eve@acme.example", "-c", "protocol.file.allow=always", ...args], { encoding: "utf8" });
      return { work, git };
    };
    return { url, clone };
  }

  it("commits workflows from the Designer, shows their history, and publishes pushes to Development", async () => {
    const repos = new GitRepos(null, { allowLocal: true });
    await setup(repos);
    const remote = remoteRepo();
    const admin = await person("admin", "ada");
    const dev = await person("developer", "dana");
    await call(admin, "PUT", "/api/cicd/settings", { environments: true, requireApproval: true });

    expect((await call(admin, "PUT", "/api/git/settings", { url: "http://insecure.example/repo.git", token: "t" })).statusCode).toBe(400);
    expect((await call(dev, "PUT", "/api/git/settings", { url: remote.url, token: "t" })).statusCode).toBe(403);
    const connect = await call(admin, "PUT", "/api/git/settings", { url: remote.url, branch: "main", folder: "workflows", token: "pat-secret-token", autoPublish: true });
    expect(connect.statusCode, connect.body).toBe(200);
    const settings = (await call(admin, "GET", "/api/git/settings")).json();
    expect(settings).toMatchObject({ connected: true, tokenSet: true, branch: "main", folder: "workflows" });
    expect(JSON.stringify(settings)).not.toContain("pat-secret-token");
    expect(settings.webhookUrl).toMatch(/\/api\/git\/webhook\/ws_default$/);
    // Developers see that Git is connected, not its secrets.
    expect((await call(dev, "GET", "/api/git/settings")).json().webhookSecret).toBeUndefined();

    // Commit from the Designer (the first commit starts the empty repository).
    const wf = (await call(dev, "POST", "/api/workflows", { definition: workflow("Invoice Processing") })).json();
    const first = await call(dev, "POST", `/api/workflows/${wf.id}/commit`, { message: "First version" });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ path: "workflows/invoice-processing.json", unchanged: false });
    expect((await call(dev, "POST", `/api/workflows/${wf.id}/commit`, { message: "Nothing new" })).json()).toMatchObject({ unchanged: true, commit: null });
    await call(dev, "PUT", `/api/workflows/${wf.id}`, { definition: workflow("Invoice Processing", "second") });
    await call(dev, "POST", `/api/workflows/${wf.id}/commit`, { message: "Log the second message" });

    const history = (await call(dev, "GET", `/api/workflows/${wf.id}/history`)).json();
    expect(history.map((c: { message: string }) => c.message)).toEqual(["Log the second message", "First version"]);
    expect(history[0].author).toBe("dana <dana@example.com>");
    const old = (await call(dev, "GET", `/api/workflows/${wf.id}/history/${history[1].sha}`)).json();
    expect(old.definition.root.slots.body[0].props.message).toBe("hello");
    expect(old.definition.id).toBe(wf.id);

    // A developer changes the file and adds one in their own clone, and pushes.
    const { work, git } = remote.clone();
    const file = join(work, "workflows", "invoice-processing.json");
    const content = JSON.parse(readFileSync(file, "utf8"));
    content.root.slots.body[0].props.message = "from a push";
    writeFileSync(file, JSON.stringify(content, null, 2));
    writeFileSync(join(work, "workflows", "payroll.json"), JSON.stringify({ ...workflow("Payroll"), id: "wf_payroll_file" }, null, 2));
    writeFileSync(join(work, "workflows", "broken.json"), "{ not json");
    git("add", "-A");
    git("commit", "--quiet", "-m", "Change invoices, add payroll");
    git("push", "--quiet", "origin", "main");

    // The host calls the webhook: a wrong signature is refused; the right one publishes to Development.
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const hook = (signature: string, payload = body) =>
      app.inject({ method: "POST", url: "/api/git/webhook/ws_default", headers: { "content-type": "application/json", "x-hub-signature-256": signature, "x-github-event": "push" }, payload });
    expect((await hook("sha256=00")).statusCode).toBe(401);
    const sign = (payload: string) => `sha256=${createHmac("sha256", settings.webhookSecret).update(payload).digest("hex")}`;
    const other = JSON.stringify({ ref: "refs/heads/feature" });
    expect((await hook(sign(other), other)).json()).toEqual({ ignored: true });
    expect((await hook(sign(body))).statusCode).toBe(202);
    // The sync runs after the answer; wait for it.
    let lastSync: { changed?: number; error?: string } | undefined;
    for (let i = 0; i < 200 && !lastSync; i++) {
      await new Promise((r) => setTimeout(r, 50));
      lastSync = (await call(admin, "GET", "/api/git/settings")).json().lastSync;
    }
    expect(lastSync).toMatchObject({ changed: 2 });
    const packages = (await call(dev, "GET", "/api/packages")).json() as Array<{ name: string; version: number; deployments: object; source?: { commit: string } }>;
    expect(packages.map((p) => [p.name, p.version, Object.keys(p.deployments)])).toEqual(
      expect.arrayContaining([
        ["Invoice Processing", 1, ["dev"]],
        ["Payroll", 1, ["dev"]],
      ]),
    );
    expect(packages[0]!.source?.commit).toMatch(/^[0-9a-f]{40}$/);
    const updated = (await call(dev, "GET", `/api/workflows/${wf.id}`)).json();
    expect(updated.definition.root.slots.body[0].props.message).toBe("from a push");

    // Pulling again finds nothing new, and reports the broken file.
    const pull = (await call(dev, "POST", "/api/git/pull", {})).json();
    expect(pull).toMatchObject({ created: [], updated: [], unchanged: 2, errors: [{ path: "workflows/broken.json" }] });

    // Disconnecting forgets the repository.
    expect((await call(admin, "DELETE", "/api/git/settings")).statusCode).toBe(204);
    expect((await call(dev, "POST", `/api/workflows/${wf.id}/commit`, { message: "x" })).statusCode).toBe(409);
  });
});
