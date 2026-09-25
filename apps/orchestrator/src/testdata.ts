/**
 * Test data from a file: a CSV (comma, semicolon or tab) or an Excel workbook's
 * first sheet. The first row names the columns; they become variable names.
 */
import ExcelJS from "exceljs";
import { HttpError } from "./errors.js";
import { MAX_DATA_COLUMNS, MAX_DATA_ROWS } from "./testcases.js";
import type { TestData } from "./types.js";

export interface ParsedTestData extends TestData {
  /** Headers that had to change to be variable names ("First name" -> "First_name"). */
  renamed: Array<{ from: string; to: string }>;
  /** Rows after the first MAX_DATA_ROWS were left out. */
  truncated: boolean;
}

/** "First name" -> "First_name", "2nd" -> "_2nd", "" -> "Column3"; each one unique. */
export function variableNames(headers: string[]): { columns: string[]; renamed: ParsedTestData["renamed"] } {
  const columns: string[] = [];
  const renamed: ParsedTestData["renamed"] = [];
  headers.forEach((header, i) => {
    const text = header.trim();
    let name = text.replace(/[^A-Za-z0-9_$]+/g, "_").replace(/^_+|_+$/g, "") || `Column${i + 1}`;
    if (/^[0-9]/.test(name)) name = `_${name}`;
    const base = name;
    for (let n = 2; columns.includes(name); n++) name = `${base}_${n}`;
    columns.push(name);
    if (name !== text) renamed.push({ from: text || `(column ${i + 1})`, to: name });
  });
  return { columns, renamed };
}

/** CSV with quotes ("a, b" and "" inside), in the delimiter the first line uses most. */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, "");
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = [",", ";", "\t"].map((d) => ({ d, n: firstLine.split(d).length })).sort((a, b) => b.n - a.n)[0]!.d;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]!;
    if (quoted) {
      if (c === '"' && clean[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && clean[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    const iso = value.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
  }
  if (typeof value === "object") {
    if ("result" in value) return cellText(value.result as ExcelJS.CellValue);
    if ("richText" in value) return value.richText.map((r) => r.text).join("");
    if ("text" in value) return String(value.text);
    if ("error" in value) return String(value.error);
    return "";
  }
  return String(value);
}

async function readExcel(data: Buffer): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(data as unknown as ArrayBuffer);
  } catch {
    throw new HttpError(400, "This file could not be read as an Excel workbook (.xlsx). Save it as .xlsx or .csv and try again.");
  }
  const sheet = workbook.worksheets.find((s) => s.actualRowCount > 0);
  if (!sheet) return [];
  const rows: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = (row.values as ExcelJS.CellValue[]).slice(1); // exceljs rows are 1-based
    rows.push(values.map(cellText));
  });
  return rows;
}

export async function parseTestData(fileName: string, data: Buffer): Promise<ParsedTestData> {
  const lower = fileName.toLowerCase();
  let table: string[][];
  if (lower.endsWith(".xlsx")) table = await readExcel(data);
  else if (lower.endsWith(".csv") || lower.endsWith(".txt") || lower.endsWith(".tsv")) table = parseCsv(data.toString("utf8"));
  else if (lower.endsWith(".xls")) throw new HttpError(400, "Old Excel files (.xls) are not supported: in Excel, Save As .xlsx or .csv");
  else throw new HttpError(400, "Choose a .csv or .xlsx file");
  // Blank lines are not tests.
  table = table.filter((r) => r.some((v) => v.trim() !== ""));
  if (!table.length) throw new HttpError(400, "The file is empty");
  const [header, ...body] = table as [string[], ...string[][]];
  const width = Math.min(MAX_DATA_COLUMNS, Math.max(header.length, ...body.map((r) => r.length)));
  const headers = Array.from({ length: width }, (_, i) => header[i] ?? "");
  const { columns, renamed } = variableNames(headers);
  const rows = body.slice(0, MAX_DATA_ROWS).map((r) => Array.from({ length: width }, (_, i) => (r[i] ?? "").slice(0, 10_000)));
  return { columns, rows, renamed, truncated: body.length > MAX_DATA_ROWS };
}
