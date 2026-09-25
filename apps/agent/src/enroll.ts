import { spawn } from "node:child_process";
import { hostname, platform, release } from "node:os";
import { sleep } from "@zamtest/core";

const VERSION = "0.3.4";

export interface EnrollResult {
  agentId: string;
  /** This PC's own credential. Shown once by the server; store it safely. */
  agentToken: string;
  name: string;
  approvedBy?: string;
  portalUrl?: string;
  designerUrl?: string;
}

export interface EnrollOptions {
  server: string;
  name: string;
  /** Approves the PC without a browser (silent installs by IT). */
  installKey?: string;
  /** Called with the approval link when a person has to approve the PC. */
  onApprovalNeeded?: (url: string, userCode: string) => void;
  signal?: AbortSignal;
}

async function post<T>(server: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(new URL(path, server), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

/**
 * Connects this PC to the orchestrator: asks for approval (a signed-in
 * Developer or Admin approves it in the Portal, or an install key approves it
 * at once) and returns the PC's own credential.
 */
export async function enroll(options: EnrollOptions): Promise<EnrollResult> {
  const start = await post<{
    deviceCode: string;
    userCode: string;
    verificationUrl: string;
    expiresIn: number;
    interval: number;
    approved: boolean;
  }>(options.server, "/api/agent/enroll/start", {
    name: options.name,
    machine: hostname(),
    os: `${platform()} ${release()}`,
    version: VERSION,
    installKey: options.installKey,
  });
  if (!start.approved) options.onApprovalNeeded?.(start.verificationUrl, start.userCode);

  const deadline = Date.now() + start.expiresIn * 1000;
  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new Error("Cancelled");
    const poll = await post<{ status: string } & Partial<EnrollResult>>(options.server, "/api/agent/enroll/poll", { deviceCode: start.deviceCode });
    if (poll.status === "approved") return poll as EnrollResult;
    if (poll.status === "denied") throw new Error("Connecting this PC was declined in the Portal");
    if (poll.status === "expired") break;
    await sleep(start.interval * 1000);
  }
  throw new Error("Nobody approved this PC in time. Run the command again for a new link.");
}

/** Opens a link in the default browser. */
export function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => undefined).unref();
  } catch {
    // no browser available (server, container): the link is printed as well
  }
}
