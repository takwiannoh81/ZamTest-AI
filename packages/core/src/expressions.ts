/**
 * Expression evaluation.
 *
 * - "expression" props are JavaScript expressions: `invoices.length > 0`
 * - string props may embed templates: `Hello {{ customer.name }}!`
 * - a string that is exactly one template keeps the raw value type:
 *   `{{ items }}` evaluates to the array, not "a,b,c".
 *
 * Workflows are authored by trusted automation developers and run on the
 * customer's own bot agents, so expressions are not sandboxed beyond
 * scoping them to workflow variables.
 */

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const TEMPLATE = /\{\{([\s\S]+?)\}\}/g;
const WHOLE_TEMPLATE = /^\s*\{\{([\s\S]+?)\}\}\s*$/;

export class ExpressionError extends Error {
  constructor(
    public readonly expression: string,
    cause: unknown,
  ) {
    super(`Failed to evaluate "${expression}": ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "ExpressionError";
  }
}

const fnCache = new Map<string, (...args: unknown[]) => unknown>();

export function evaluate(expression: string, vars: Record<string, unknown>): unknown {
  const names = Object.keys(vars).filter((n) => IDENTIFIER.test(n));
  const key = `${names.join(",")}::${expression}`;
  let fn = fnCache.get(key);
  try {
    if (!fn) {
      fn = new Function(...names, "vars", `"use strict"; return (${expression}\n);`) as (...args: unknown[]) => unknown;
      if (fnCache.size > 5000) fnCache.clear();
      fnCache.set(key, fn);
    }
    return fn(...names.map((n) => vars[n]), vars);
  } catch (err) {
    throw new ExpressionError(expression, err);
  }
}

export function hasTemplate(value: string): boolean {
  TEMPLATE.lastIndex = 0;
  return TEMPLATE.test(value);
}

export function interpolate(value: string, vars: Record<string, unknown>): unknown {
  const whole = WHOLE_TEMPLATE.exec(value);
  if (whole && whole[1] && !whole[1].includes("}}")) return evaluate(whole[1].trim(), vars);
  return value.replace(TEMPLATE, (_, expr: string) => stringify(evaluate(expr.trim(), vars)));
}

/** Recursively interpolates every string inside a JSON-like value. */
export function interpolateDeep(value: unknown, vars: Record<string, unknown>): unknown {
  if (typeof value === "string") return interpolate(value, vars);
  if (Array.isArray(value)) return value.map((v) => interpolateDeep(v, vars));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateDeep(v, vars)]));
  }
  return value;
}

export function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}
