/**
 * Templates run for real: against a local "CRM" API and a local web form
 * (in place of the example addresses a customer replaces).
 */
import { createServer } from "node:http";
import type { AddressInfo, Server } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEMPLATES, walkSteps, workflowFromTemplate } from "@zamtest/core";
import type { Workflow } from "@zamtest/core";
import { execute } from "../src/runtime.js";

let server: Server;
let base = "";
const created: unknown[] = [];

const FORM = `<!doctype html><title>New customer</title>
<form id="f"><input id="name"><input id="email"><input id="phone"><button type="submit">Save</button></form><p id="msg"></p>
<script>
document.getElementById("f").onsubmit = (e) => { e.preventDefault();
  const v = (id) => document.getElementById(id).value;
  if (!v("email").includes("@")) { msg.textContent = "Email is not valid"; return; }
  fetch("/customers", { method: "POST", body: JSON.stringify({ name: v("name"), email: v("email"), phone: v("phone") }) }).then(() => msg.textContent = "Saved"); };
</script>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/v1/contacts") {
        if (req.headers.authorization !== "Bearer secret-key") return res.writeHead(401).end(JSON.stringify({ error: "bad key" }));
        const contact = JSON.parse(body);
        if (contact.email === "taken@example.com") return res.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ error: "exists" }));
        created.push(contact);
        return res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ id: 1000 + created.length }));
      }
      if (req.url === "/customers") {
        created.push(JSON.parse(body));
        return res.writeHead(204).end();
      }
      res.writeHead(200, { "content-type": "text/html" }).end(FORM);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** The template, with its example addresses pointed at the local server. */
function local(id: string, change: (step: { type: string; props: Record<string, unknown> }) => void = () => undefined): Workflow {
  const template = TEMPLATES.find((t) => t.id === id)!;
  const workflow = workflowFromTemplate(template, id);
  walkSteps(workflow.root, (step) => {
    for (const [k, value] of Object.entries(step.props)) {
      if (typeof value === "string") step.props[k] = value.replace("https://api.example-crm.com", base).replace("https://example.com", base);
    }
    change(step);
  });
  return workflow;
}

describe("templates, run", () => {
  it("web request to an API: creates the contact, and fails clearly when the API refuses", async () => {
    const workflow = local("webhook-to-api");
    const getAsset = async (name: string) => (name === "CRM/ApiKey" ? "secret-key" : undefined);
    const ok = await execute(workflow, { inputs: { trigger: { body: { name: "Ada", email: "ada@example.com" } } }, getAsset });
    expect(ok.status, ok.error).toBe("succeeded");
    expect(ok.outputs.createdId).toBe("1001");
    expect(created).toContainEqual({ name: "Ada", email: "ada@example.com", source: "ZamTech AI" });

    const refused = await execute(workflow, { inputs: { trigger: { body: { name: "B", email: "taken@example.com" } } }, getAsset });
    expect(refused.status).toBe("failed");
    expect(refused.error).toContain("The CRM answered 409");
    const empty = await execute(workflow, { inputs: { trigger: { body: {} } }, getAsset });
    expect(empty.error).toContain("The request has no email");
  });

  it("Excel rows into a web form: enters each row, and notes the rows that fail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zamtest-template-"));
    const file = join(dir, "customers.xlsx");
    const prepare = await execute({
      schemaVersion: 1,
      id: "prep",
      name: "prep",
      variables: [],
      root: {
        id: "root",
        type: "core.sequence",
        props: {},
        slots: {
          body: [
            {
              id: "w",
              type: "excel.write",
              props: {
                path: file,
                rows: '[{ Name: "Ada", Email: "ada@example.com", Phone: "1" }, { Name: "Bob", Email: "not-an-email", Phone: "2" }, { Name: "Cy", Email: "cy@example.com", Phone: "3" }]',
              },
            },
          ],
        },
      },
    });
    expect(prepare.status, prepare.error).toBe("succeeded");
    created.length = 0;
    const workflow = local("excel-to-web-form", (step) => {
      if (step.type === "browser.open") step.props.headless = true;
      if (step.type === "browser.waitFor") step.props.timeoutMs = 3000;
      if (step.type === "browser.navigate") step.props.url = `${base}/customers/new`;
    });
    const result = await execute(workflow, { inputs: { file } });
    expect(result.status, result.error).toBe("succeeded");
    expect(result.outputs).toMatchObject({ done: 2, failed: ["Bob"] });
    expect(created.map((c) => (c as { name: string }).name)).toEqual(["Ada", "Cy"]);
  }, 120_000);
});
