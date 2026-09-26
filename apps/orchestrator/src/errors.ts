import type { z } from "zod";

/** An error with the HTTP status the API answers with. */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    /** More fields for the answer's body (for example a `code` the apps act on). */
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Validates a request body (400 with every problem when it does not fit). */
export function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(400, result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  }
  return result.data;
}
