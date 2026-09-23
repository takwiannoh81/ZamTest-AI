#!/usr/bin/env node
// Stands in for driver.ps1 in tests: answers the same JSON-lines protocol
// against a tiny fake UI. The elements that exist are listed as formatted
// selectors in FAKE_DESKTOP_ELEMENTS (JSON array); every call is logged to
// FAKE_DESKTOP_LOG (JSON lines) when set.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const elements = new Set(JSON.parse(process.env.FAKE_DESKTOP_ELEMENTS || "[]"));
const quote = (v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const format = (segments) =>
  segments.map((s) => s.type + s.conditions.map((c) => `[${c.attr}${c.op}${quote(c.value)}]`).join("") + (s.index ? `[index=${s.index}]` : "")).join(" > ");

function run(op, args) {
  const sel = Array.isArray(args.selector) ? format(args.selector) : undefined;
  const need = () => {
    if (!elements.has(sel)) throw new Error("Element not found");
  };
  switch (op) {
    case "ping": return { pong: true, powershell: "fake" };
    case "count": return { count: elements.has(sel) ? 1 : 0 };
    case "tree": return { tree: 'window name="Invoices - ERP" process="erp"\n  button name="Save invoice" id="saveButton"\n  datagrid id="lines"' };
    case "click": need(); return { method: "invoke" };
    case "type": need(); return { method: "value" };
    case "getText": need(); return { text: "  Saved  " };
    case "readTable": need(); return { headers: ["Item", "Qty", ""], rows: [["Paper", "2", "x"], ["Ink", "1", "y"]] };
    case "launch": return { pid: 4242 };
    case "waitFor": need(); return { ok: true };
    default: throw new Error(`Unknown operation '${op}'`);
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, op, args = {} } = JSON.parse(line);
  if (process.env.FAKE_DESKTOP_LOG) appendFileSync(process.env.FAKE_DESKTOP_LOG, `${JSON.stringify({ op, args })}\n`);
  let out;
  try {
    out = { id, ok: true, result: run(op, args) };
  } catch (err) {
    out = { id, ok: false, error: err.message };
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
});
