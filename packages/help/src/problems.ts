/**
 * The page's recent errors (uncaught errors, failed promises, and failed API calls
 * the app reports), kept in memory so a bug report can include them. Nothing is
 * sent anywhere unless the person sends a report (which shows them first).
 */
export interface PageProblem {
  time: string;
  message: string;
}

const MAX = 20;
const problems: PageProblem[] = [];

/** Adds one (the app calls it for API errors; the browser's own errors are caught below). */
export function noteProblem(message: string): void {
  const text = message.replace(/\s+/g, " ").trim().slice(0, 500);
  if (!text) return;
  // The same error again (a page retrying): once is enough.
  if (problems.slice(-5).some((p) => p.message === text)) return;
  problems.push({ time: new Date().toISOString(), message: text });
  if (problems.length > MAX) problems.splice(0, problems.length - MAX);
}

export const recentProblems = (): PageProblem[] => [...problems];

if (typeof window !== "undefined") {
  window.addEventListener("error", (e) => noteProblem(`${e.message}${e.filename ? ` (${e.filename.split("/").pop()}:${e.lineno})` : ""}`));
  window.addEventListener("unhandledrejection", (e) => {
    const reason = (e as PromiseRejectionEvent).reason as { message?: string } | string | undefined;
    noteProblem(`Unhandled: ${typeof reason === "string" ? reason : (reason?.message ?? String(reason))}`);
  });
}
