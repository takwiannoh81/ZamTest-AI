/** Where the other ZamTech AI apps and downloads live (set at build time for production). */
export const DESIGNER_URL = (import.meta.env.VITE_DESIGNER_URL ?? "http://localhost:5174").replace(/\/+$/, "");

/** The Windows agent installer: the latest GitHub release unless the deployment hosts its own copy. */
export const AGENT_DOWNLOAD_URL =
  import.meta.env.VITE_AGENT_DOWNLOAD_URL ?? "https://github.com/takwiannoh81/ZamTest-AI/releases/latest/download/ZamTechAI-Agent-Setup.exe";

/**
 * The page to go back to after signing in (?return=...), when it is one of ours:
 * the Designer or this Portal. Anything else is ignored, so the sign-in page
 * cannot be used to send people to another site.
 */
export function returnTarget(search = window.location.search): string | undefined {
  const value = new URLSearchParams(search).get("return");
  if (!value) return undefined;
  try {
    const url = new URL(value, window.location.origin);
    const allowed = [window.location.origin, new URL(DESIGNER_URL).origin];
    return allowed.includes(url.origin) && (url.protocol === "https:" || url.protocol === "http:") ? url.href : undefined;
  } catch {
    return undefined;
  }
}
