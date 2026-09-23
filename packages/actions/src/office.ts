import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import ExcelJS from "exceljs";
import type { ActionHandler } from "@zamtest/core";

type Row = Record<string, unknown> | unknown[];

/** Excel cells can be formulas, rich text or hyperlinks; turn them into plain values. */
function cellValue(value: ExcelJS.CellValue): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if ("result" in value) return cellValue(value.result as ExcelJS.CellValue);
    if ("richText" in value) return value.richText.map((r) => r.text).join("");
    if ("text" in value) return value.text;
    if ("error" in value) return value.error;
  }
  return value;
}

function toRows(value: unknown): Row[] {
  if (!Array.isArray(value)) throw new Error("Rows must be a list");
  return value as Row[];
}

function headerOf(rows: Row[]): string[] {
  const keys = new Set<string>();
  for (const r of rows) if (!Array.isArray(r)) Object.keys(r).forEach((k) => keys.add(k));
  return [...keys];
}

async function ensureDir(path: string) {
  await mkdir(dirname(path), { recursive: true });
}

export const officeHandlers: Record<string, ActionHandler> = {
  "excel.read": async (props) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(String(props.path));
    const ws = props.sheet ? wb.getWorksheet(String(props.sheet)) : wb.worksheets[0];
    if (!ws) throw new Error(`Sheet "${props.sheet}" not found`);
    const raw: unknown[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const values = (row.values as ExcelJS.CellValue[]).slice(1); // exceljs rows are 1-based
      raw.push(values.map(cellValue));
    });
    if (props.hasHeader === false) return raw;
    const [header = [], ...body] = raw;
    const names = header.map((h, i) => (h === null || h === "" ? `column${i + 1}` : String(h)));
    return body.map((cells) => Object.fromEntries(names.map((n, i) => [n, cells[i] ?? null])));
  },

  "excel.write": async (props) => {
    const path = String(props.path);
    const sheetName = String(props.sheet || "Sheet1");
    const rows = toRows(props.rows);
    const wb = new ExcelJS.Workbook();
    if (existsSync(path)) await wb.xlsx.readFile(path);
    let ws = wb.getWorksheet(sheetName);
    if (ws && !props.append) {
      wb.removeWorksheet(ws.id);
      ws = undefined;
    }
    ws ??= wb.addWorksheet(sheetName);
    const objects = rows.length > 0 && !Array.isArray(rows[0]);
    if (objects) {
      let header: string[];
      if (ws.rowCount > 0) {
        header = ((ws.getRow(1).values as ExcelJS.CellValue[]).slice(1) as unknown[]).map(String);
      } else {
        header = headerOf(rows);
        ws.addRow(header).font = { bold: true };
      }
      for (const r of rows as Record<string, unknown>[]) ws.addRow(header.map((h) => r[h] ?? null));
    } else {
      for (const r of rows as unknown[][]) ws.addRow(r);
    }
    await ensureDir(path);
    await wb.xlsx.writeFile(path);
    return rows.length;
  },

  "csv.read": async (props) =>
    parse(await readFile(String(props.path), "utf8"), {
      columns: props.hasHeader !== false,
      delimiter: String(props.delimiter || ","),
      skip_empty_lines: true,
      bom: true,
      relax_column_count: true,
      trim: true,
    }),

  "csv.write": async (props) => {
    const path = String(props.path);
    const rows = toRows(props.rows);
    const appending = Boolean(props.append) && existsSync(path);
    const objects = rows.length > 0 && !Array.isArray(rows[0]);
    const text = stringify(rows as never, {
      delimiter: String(props.delimiter || ","),
      header: objects && !appending,
      columns: objects ? headerOf(rows) : undefined,
    });
    await ensureDir(path);
    if (appending) await appendFile(path, text, "utf8");
    else await writeFile(path, text, "utf8");
    return rows.length;
  },
};
