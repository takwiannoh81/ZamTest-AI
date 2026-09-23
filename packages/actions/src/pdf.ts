import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PDFDocument } from "pdf-lib";
import { extractText, getDocumentProxy } from "unpdf";
import type { ActionHandler } from "@zamtest/core";

export const pdfHandlers: Record<string, ActionHandler> = {
  "pdf.readText": async (props) => {
    const pdf = await getDocumentProxy(new Uint8Array(await readFile(String(props.path))));
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  },

  "pdf.merge": async (props) => {
    const files = Array.isArray(props.files) ? props.files.map(String) : [];
    if (files.length === 0) throw new Error("Files must be a non-empty list of PDF paths");
    const merged = await PDFDocument.create();
    for (const file of files) {
      const source = await PDFDocument.load(await readFile(file));
      const pages = await merged.copyPages(source, source.getPageIndices());
      pages.forEach((p) => merged.addPage(p));
    }
    const out = String(props.path);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, await merged.save());
    return out;
  },
};
