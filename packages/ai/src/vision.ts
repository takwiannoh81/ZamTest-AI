/**
 * AI Vision: Claude looks at a screenshot of a web page or of the whole screen
 * and finds what the step describes ("the blue Submit button"), reads a value
 * from it, or checks that it shows something. For screens where selectors do not
 * work: remote desktops and Citrix, canvas apps, old applications.
 *
 * Positions are pixels of the image sent, which the caller sizes so the model
 * sees it as it is (at most about 1456 x 816), and maps back to the screen.
 */
import type { AiClient } from "./client.js";
import { jsonOf } from "./client.js";

export type VisionTask = "locate" | "read" | "check";

export interface VisionInput {
  task: VisionTask;
  /** What to find or read ("the Amount field"), or what the screen should show (check). */
  target: string;
  /** The screenshot. */
  image: Buffer;
  mediaType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  /** English name of the language for the reason. */
  language?: string;
}

export interface VisionResult {
  /** locate / read: whether it is on the screen. check: whether the screen shows it. */
  found: boolean;
  /** locate: the point to click, in pixels of the image. */
  x?: number;
  y?: number;
  /** locate: the element's box, in pixels of the image. */
  box?: { x: number; y: number; width: number; height: number };
  /** read: the value, as written on the screen. */
  value?: string;
  /** 0 to 1. */
  confidence: number;
  /** In a sentence: what was seen, and why. */
  reason: string;
}

const SCHEMAS: Record<VisionTask, Record<string, unknown>> = {
  locate: {
    type: "object",
    properties: {
      found: { type: "boolean" },
      box: {
        type: "object",
        description: "The element's bounding box in pixels of the image; zeros when not found",
        properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } },
        required: ["x", "y", "width", "height"],
        additionalProperties: false,
      },
      x: { type: "number", description: "Where to click: pixels from the left edge of the image" },
      y: { type: "number", description: "Where to click: pixels from the top edge of the image" },
      confidence: { type: "number", description: "0 to 1" },
      reason: { type: "string" },
    },
    required: ["found", "box", "x", "y", "confidence", "reason"],
    additionalProperties: false,
  },
  read: {
    type: "object",
    properties: {
      found: { type: "boolean" },
      value: { type: "string", description: "The value exactly as shown, or empty when not found" },
      confidence: { type: "number", description: "0 to 1" },
      reason: { type: "string" },
    },
    required: ["found", "value", "confidence", "reason"],
    additionalProperties: false,
  },
  check: {
    type: "object",
    properties: {
      found: { type: "boolean", description: "Whether the screen shows what is described" },
      confidence: { type: "number", description: "0 to 1" },
      reason: { type: "string" },
    },
    required: ["found", "confidence", "reason"],
    additionalProperties: false,
  },
};

const ASK: Record<VisionTask, (target: string) => string> = {
  locate: (t) =>
    `Find this on the screenshot: ${t}\n\nGive its bounding box, and the point to click (normally its center; for a text field, inside the field). If several things match, choose the one that fits the description best. If it is not on the screenshot, found is false.`,
  read: (t) => `Read this from the screenshot: ${t}\n\nGive the value exactly as shown (text, number with its formatting, date as written). If it is not on the screenshot, found is false and the value is empty.`,
  check: (t) => `Does the screenshot show this? ${t}\n\nfound is true only when it clearly does. Say in the reason what you see.`,
};

export async function lookAtScreen(ai: AiClient, input: VisionInput): Promise<VisionResult> {
  if (!input.target.trim()) throw new Error("Say what to look for");
  const message = await ai.create({
    max_tokens: 2000,
    system: `You are the eyes of a software robot. You get a screenshot of a ${input.width} x ${input.height} pixel screen (a web page or a Windows desktop) and one task.
Positions are in pixels of this image: x from the left edge (0 to ${input.width}), y from the top edge (0 to ${input.height}).
Be precise: a click that misses by a few pixels hits the wrong control. Never guess: when you cannot see it, say so.
Confidence: 0.9 or more when there is no doubt; lower when it is small, hidden, ambiguous or hard to read.
The reason is one short sentence${input.language && input.language !== "English" ? ` in ${input.language}` : ""}.`,
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMAS[input.task] } },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: input.mediaType, data: input.image.toString("base64") } },
          { type: "text", text: ASK[input.task](input.target) },
        ],
      },
    ],
  });
  const raw = jsonOf<{ found: boolean; x?: number; y?: number; box?: VisionResult["box"]; value?: string; confidence?: number; reason?: string }>(message);
  const result: VisionResult = {
    found: Boolean(raw.found),
    confidence: Math.round(Math.min(1, Math.max(0, Number(raw.confidence ?? 0))) * 100) / 100,
    reason: String(raw.reason ?? "").slice(0, 400),
  };
  if (input.task === "locate" && result.found) {
    const clamp = (v: unknown, max: number) => Math.round(Math.min(max - 1, Math.max(0, Number(v) || 0)));
    const box = raw.box && raw.box.width > 0 && raw.box.height > 0 ? raw.box : undefined;
    // The click point should be inside the box; if it is not, the box's center is safer.
    const inside = box && raw.x! >= box.x && raw.x! <= box.x + box.width && raw.y! >= box.y && raw.y! <= box.y + box.height;
    result.x = clamp(box && !inside ? box.x + box.width / 2 : raw.x, input.width);
    result.y = clamp(box && !inside ? box.y + box.height / 2 : raw.y, input.height);
    if (box) result.box = { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
  }
  if (input.task === "read") result.value = result.found ? String(raw.value ?? "") : "";
  return result;
}
