import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseSelector } from "./selector.js";
import type { Segment } from "./selector.js";

/** Path of the PowerShell script that talks to Microsoft UI Automation. */
export const DRIVER_SCRIPT = fileURLToPath(new URL("./driver.ps1", import.meta.url));

/** Extra time a driver call may take beyond its own timeout before the driver is considered stuck. */
const CALL_GRACE_MS = 60_000;

export class DesktopUnsupportedError extends Error {
  constructor() {
    super("Desktop actions run on Windows bot agents only. Start this job on a Windows machine that has a signed-in desktop session.");
    this.name = "DesktopUnsupportedError";
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/**
 * Client for driver.ps1. One PowerShell process is started per job and
 * requests are answered in order over stdin/stdout (JSON lines).
 */
export class DesktopDriver {
  private proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stderr = "";
  private exited = false;

  private constructor(command: string) {
    this.proc = spawn(command, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", DRIVER_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    createInterface({ input: this.proc.stdout }).on("line", (line) => this.onLine(line));
    this.proc.on("error", (err) => this.failAll(err));
    this.proc.on("exit", (code) => {
      this.exited = true;
      this.failAll(new Error(`The desktop driver stopped (exit code ${code})${this.stderr ? `: ${this.stderr.trim()}` : ""}`));
    });
  }

  /**
   * Starts the driver. Uses Windows PowerShell on Windows; `ZAMTEST_POWERSHELL`
   * overrides the executable (tests use PowerShell 7 on Linux for the protocol).
   */
  static start(): DesktopDriver {
    const override = process.env.ZAMTEST_POWERSHELL;
    if (override) return new DesktopDriver(override);
    if (process.platform !== "win32") throw new DesktopUnsupportedError();
    const root = process.env.SystemRoot ?? "C:\\Windows";
    const builtin = `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    return new DesktopDriver(existsSync(builtin) ? builtin : "powershell.exe");
  }

  private onLine(line: string) {
    if (!line.trim()) return;
    let msg: { id?: number; ok?: boolean; result?: unknown; error?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // stray output (e.g. a warning written to stdout)
    }
    const waiter = msg.id === undefined ? undefined : this.pending.get(msg.id);
    if (!waiter) return;
    this.pending.delete(msg.id!);
    if (msg.ok) waiter.resolve(msg.result);
    else waiter.reject(new Error(msg.error || "Desktop driver error"));
  }

  private failAll(err: Error) {
    for (const waiter of this.pending.values()) waiter.reject(err);
    this.pending.clear();
  }

  /** Sends one operation. Selector strings in `args.selector` are parsed first. */
  call<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    if (this.exited) return Promise.reject(new Error("The desktop driver is not running"));
    const payload: Record<string, unknown> = { ...args };
    try {
      if (typeof payload.selector === "string") payload.selector = parseSelector(payload.selector) satisfies Segment[];
    } catch (err) {
      return Promise.reject(err);
    }
    const id = this.nextId++;
    // A UI call that never returns (e.g. a modal dialog blocking the app) must not hang the job:
    // after the step's own timeout plus a grace period the driver is stopped and the step fails.
    const limit = (Number(args.timeoutMs) || 10_000) + CALL_GRACE_MS;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The desktop driver did not answer "${op}" within ${Math.round(limit / 1000)} s and was restarted`));
        this.proc.kill();
      }, limit);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          (resolve as (v: unknown) => void)(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.proc.stdin.write(`${JSON.stringify({ id, op, args: payload })}\n`);
    });
  }

  /** False once the PowerShell process has stopped (crashed, killed after a hang, or closed). */
  get running(): boolean {
    return !this.exited;
  }

  async close(): Promise<void> {
    if (this.exited) return;
    const done = new Promise<void>((resolve) => this.proc.once("exit", () => resolve()));
    this.proc.stdin.end();
    const timer = setTimeout(() => this.proc.kill(), 3000);
    await done;
    clearTimeout(timer);
  }
}
