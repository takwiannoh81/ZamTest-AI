import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FolderWatcher, patternTest } from "../src/folder-watch.js";

describe("watched folders", () => {
  it("reports a matching file once it stopped changing, and only once", async () => {
    const folder = mkdtempSync(join(tmpdir(), "zamtest-watch-"));
    const logs: string[] = [];
    const watcher = new FolderWatcher((m) => logs.push(m));
    watcher.setWatches([{ triggerId: "trg_1", folder, pattern: "*.pdf" }]);
    writeFileSync(join(folder, "invoice.pdf"), "part 1");
    writeFileSync(join(folder, "notes.txt"), "x");

    expect(await watcher.scan()).toEqual([]); // first look: maybe still being copied
    appendFileSync(join(folder, "invoice.pdf"), " part 2");
    expect(await watcher.scan()).toEqual([]); // it grew: still being copied
    const [event, ...rest] = await watcher.scan();
    expect(rest).toEqual([]);
    expect(event).toMatchObject({ triggerId: "trg_1", name: "invoice.pdf", path: join(folder, "invoice.pdf"), size: 13 });
    expect(await watcher.scan()).toEqual([]); // reported already
    expect(logs[0]).toContain(`Watching ${folder}`);
  });

  it("says once when a folder cannot be read", async () => {
    const logs: string[] = [];
    const watcher = new FolderWatcher((m) => logs.push(m));
    watcher.setWatches([{ triggerId: "t", folder: join(tmpdir(), "does-not-exist-zamtest"), pattern: "*" }]);
    await watcher.scan();
    await watcher.scan();
    expect(logs.filter((l) => l.startsWith("Cannot read"))).toHaveLength(1);
  });

  it("matches names like Windows does", () => {
    expect(patternTest("*.PDF").test("a.pdf")).toBe(true);
    expect(patternTest("").test("anything")).toBe(true);
    expect(patternTest("report-?.csv").test("report-10.csv")).toBe(false);
  });
});
