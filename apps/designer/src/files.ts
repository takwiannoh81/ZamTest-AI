/**
 * Saving to and opening from the person's PC. Chrome and Edge let them choose
 * the folder and file name (File System Access API); other browsers download
 * the file to their Downloads folder.
 */

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: Array<{ description: string; accept: Record<string, string[]> }>;
}
interface WritableFile {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}
interface FileHandle {
  createWritable(): Promise<WritableFile>;
}
type PickerWindow = Window & { showSaveFilePicker?: (options: SaveFilePickerOptions) => Promise<FileHandle> };

/** "Invoice Processing" -> "invoice-processing". */
export const fileSlug = (name: string) => name.replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "workflow";

/**
 * Saves JSON on the PC. Returns false when the person cancelled the dialog.
 * `kind` describes the file in the dialog ("ZamTech AI workflow").
 */
export async function saveJson(suggestedName: string, data: unknown, kind: string): Promise<boolean> {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: "application/json" });
  const picker = (window as PickerWindow).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({ suggestedName, types: [{ description: kind, accept: { "application/json": [".json"] } }] });
      const file = await handle.createWritable();
      await file.write(blob);
      await file.close();
      return true;
    } catch (err) {
      if ((err as Error).name === "AbortError") return false;
      // Not allowed here (e.g. inside a frame): fall back to a download.
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = suggestedName;
  a.click();
  URL.revokeObjectURL(a.href);
  return true;
}

/** The kind of JSON file someone opened: one workflow, or a whole project. */
export function isProjectFile(data: unknown): boolean {
  return typeof data === "object" && data !== null && (data as { format?: unknown }).format === "zamtech-ai-project";
}
