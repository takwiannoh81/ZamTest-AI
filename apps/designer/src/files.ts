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
  return saveText(suggestedName, `${JSON.stringify(data, null, 2)}\n`, kind, "application/json", ".json");
}

/** Saves a text file on the PC (e.g. a Playwright test). Returns false when the person cancelled the dialog. */
export async function saveText(suggestedName: string, text: string, kind: string, type: string, extension: string): Promise<boolean> {
  const blob = new Blob([text], { type });
  const picker = (window as PickerWindow).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({ suggestedName, types: [{ description: kind, accept: { [type]: [extension] } }] });
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
