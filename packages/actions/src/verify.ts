/**
 * Checks for test cases ("Verify ..." actions): a failed check fails the run with
 * a message that says what was expected and what was found.
 */
import { sleep } from "@zamtest/core";
import type { ActionHandler } from "@zamtest/core";

export type Match = "contains" | "equals" | "regex";

export class VerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationError";
  }
}

export function textMatches(actual: string, expected: string, match: Match): boolean {
  if (match === "equals") return actual.trim() === expected.trim();
  if (match === "regex") {
    try {
      return new RegExp(expected).test(actual);
    } catch {
      throw new VerificationError(`"${expected}" is not a valid regular expression`);
    }
  }
  return actual.toLowerCase().includes(expected.toLowerCase());
}

/** "contain "Welcome"" / "equal ..." / "match /.../": for messages. */
export const expectation = (match: Match, expected: string) =>
  match === "equals" ? `equal "${expected}"` : match === "regex" ? `match /${expected}/` : `contain "${expected}"`;

export const matchOf = (value: unknown): Match => (value === "equals" || value === "regex" ? value : "contains");

/** Short enough for a log line, but enough to see what was there. */
export const shown = (text: string | undefined) => {
  if (text === undefined) return "nothing (element not found)";
  const flat = text.replace(/\s+/g, " ").trim();
  return `"${flat.length > 200 ? `${flat.slice(0, 200)}...` : flat}"`;
};

/**
 * Reads until the check passes or the timeout ends (pages and windows load in
 * their own time). Returns whether it passed and the last value read.
 */
export async function waitFor<T>(read: () => Promise<T>, ok: (value: T) => boolean, timeoutMs: number, signal?: AbortSignal): Promise<{ passed: boolean; last: T }> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const last = await read();
    if (ok(last)) return { passed: true, last };
    if (Date.now() >= deadline) return { passed: false, last };
    await sleep(Math.min(250, Math.max(10, deadline - Date.now())), signal);
  }
}

export const verifyHandlers: Record<string, ActionHandler> = {
  "verify.condition": (props, ctx) => {
    if (props.condition) {
      ctx.log("info", "Check passed");
      return;
    }
    const raw = typeof ctx.step.props.condition === "string" ? ctx.step.props.condition : "the condition";
    throw new VerificationError(props.message ? String(props.message) : `Expected ${raw} to be true, but it was not`);
  },
};
