import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exploreSite, SNAPSHOT_SCRIPT } from "../src/explorer.js";

const executable = process.env.ZAMTEST_BROWSER_EXECUTABLE;
const canRun = Boolean(executable && existsSync(executable));

/** A small site: a sign-in page, a home page linking to cameras, settings, a PDF and "Sign out". */
const PAGES: Record<string, string> = {
  "/login": `<title>Sign in</title><h1>VideoInsight</h1><form action="/home"><label>User <input id="user" required></label><label>Password <input id="pass" type="password"></label><button>Sign in</button></form>`,
  "/home": `<title>Home</title><h1>Dashboard</h1><nav><a href="/cameras">Cameras</a> <a href="/settings#top">Settings</a> <a href="/manual.pdf">Manual</a> <a href="/logout">Sign out</a> <a href="https://example.com/">Elsewhere</a></nav>`,
  "/cameras": `<title>Cameras</title><h1>Cameras</h1><table id="cams"><thead><tr><th>Name</th><th>Status</th></tr></thead><tbody><tr><td>Cam 1</td><td>Online</td></tr><tr><td>Cam 2</td><td>Offline</td></tr></tbody></table><a href="/home">Home</a>`,
  "/settings": `<title>Settings</title><h1>Settings</h1><label>Retention <select id="days"><option>7 days</option><option>30 days</option></select></label><button data-testid="save">Save</button>`,
};

let base = "";
const visits: string[] = [];
const server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0]!;
  visits.push(path);
  const html = PAGES[path];
  res.writeHead(html ? 200 : 404, { "content-type": "text/html" });
  res.end(html ?? "not found");
});
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("the explorer's page script", () => {
  it("is valid JavaScript", () => {
    expect(() => new Function(`return ${SNAPSHOT_SCRIPT}`)).not.toThrow();
  });
});

describe.skipIf(!canRun)("exploring a website", () => {
  it("follows the site's own links, never signs out or downloads, and captures each page", async () => {
    visits.length = 0;
    const progress: string[] = [];
    const pages = await exploreSite(`${base}/home`, { headless: true, maxPages: 5, stopped: () => false, onProgress: (p) => progress.push(`${p.stage}:${p.page}`) });
    expect(pages.map((p) => new URL(p.url).pathname)).toEqual(["/home", "/cameras", "/settings"]);
    expect(visits).not.toContain("/logout");
    expect(visits).not.toContain("/manual.pdf");
    expect(progress).toEqual(["exploring:1", "exploring:2", "exploring:3"]);
    const [home, cameras, settings] = pages;
    expect(home!.links.map((l) => l.text)).toContain("Sign out");
    expect(cameras!.tables[0]).toMatchObject({ selector: "css=#cams", headers: ["Name", "Status"], rows: 2 });
    expect(settings!.fields[0]).toMatchObject({ selector: "css=#days", type: "select", options: ["7 days", "30 days"] });
    expect(settings!.buttons[0]).toMatchObject({ selector: 'css=[data-testid="save"]' });
    expect(home!.screen?.length).toBeGreaterThan(1000);
  }, 60_000);

  it("waits for the person to sign in, keeping the sign-in page for AI", async () => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true, executablePath: executable });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${base}/login`);
    const stages: string[] = [];
    const exploring = exploreSite("about:blank", {
      attachTo: browser,
      waitForPerson: true,
      maxPages: 2,
      stopped: () => false,
      onProgress: (p) => stages.push(p.stage),
    });
    // The person signs in, then clicks Start exploring in the banner.
    await page.waitForSelector("#__zamtech-explore button", { timeout: 20_000 });
    await page.fill("#user", "ada");
    await page.click("text=Sign in");
    await page.waitForURL(/\/home/);
    await page.click("#__zamtech-explore button", { timeout: 20_000 });
    const pages = await exploring;
    expect(stages[0]).toBe("waiting");
    expect(pages[0]).toMatchObject({ beforeSignIn: true, title: "Sign in" });
    expect(pages[0]!.fields.map((f) => f.selector)).toEqual(["css=#user", "css=#pass"]);
    expect(pages[0]!.fields[0]!.required).toBe(true);
    expect(pages.slice(1).map((p) => new URL(p.url).pathname)).toEqual(["/home", "/cameras"]);
    // The banner is never part of what AI sees.
    expect(JSON.stringify(pages.slice(1))).not.toContain("Start exploring");
  }, 60_000);
});
