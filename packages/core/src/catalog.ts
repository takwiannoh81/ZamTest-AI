import type { ActionMeta, PropDef } from "./schema.js";

/**
 * Built-in action metadata. This file must stay free of runtime
 * dependencies (no Node APIs) so the Designer can use it in the browser.
 * Runtime implementations live in @zamtest/actions, except the control
 * flow containers which are executed by the engine itself.
 */

const output = (label = "Save result to"): PropDef => ({
  name: "output",
  label,
  type: "variable",
  output: true,
  description: "Variable that receives the result",
});

const healing: PropDef[] = [
  {
    name: "description",
    label: "Target description",
    type: "string",
    description: "Plain-language description of the element (e.g. 'the blue Login button'). Used by AI to heal broken selectors.",
  },
  {
    name: "aiHeal",
    label: "AI self-healing",
    type: "boolean",
    default: true,
    description: "If the selector fails, ask AI for a replacement selector and retry once.",
  },
];

export const CONTROL_FLOW_TYPES = new Set([
  "core.sequence",
  "core.if",
  "core.forEach",
  "core.while",
  "core.tryCatch",
  "core.break",
]);

export const BUILTIN_ACTIONS: ActionMeta[] = [
  /* ----------------------------- Control flow ----------------------------- */
  {
    type: "core.sequence",
    displayName: "Sequence",
    category: "Control Flow",
    description: "Runs child actions in order.",
    icon: "list",
    props: [],
    slots: ["body"],
  },
  {
    type: "core.if",
    displayName: "If",
    category: "Control Flow",
    description: "Runs 'then' when the condition is truthy, otherwise 'else'.",
    icon: "split",
    props: [{ name: "condition", label: "Condition", type: "expression", required: true }],
    slots: ["then", "else"],
  },
  {
    type: "core.forEach",
    displayName: "For Each",
    category: "Control Flow",
    description: "Runs the body once per item in a list.",
    icon: "repeat",
    props: [
      { name: "items", label: "Items", type: "expression", required: true },
      { name: "itemVariable", label: "Item variable", type: "variable", default: "item" },
      { name: "indexVariable", label: "Index variable", type: "variable" },
    ],
    slots: ["body"],
  },
  {
    type: "core.while",
    displayName: "While",
    category: "Control Flow",
    description: "Repeats the body while the condition is truthy.",
    icon: "loop",
    props: [
      { name: "condition", label: "Condition", type: "expression", required: true },
      { name: "maxIterations", label: "Max iterations", type: "number", default: 1000 },
    ],
    slots: ["body"],
  },
  {
    type: "core.tryCatch",
    displayName: "Try / Catch",
    category: "Control Flow",
    description: "Handles errors raised by the 'try' block.",
    icon: "shield",
    props: [{ name: "errorVariable", label: "Error variable", type: "variable", default: "error" }],
    slots: ["try", "catch", "finally"],
  },
  {
    type: "core.break",
    displayName: "Break",
    category: "Control Flow",
    description: "Exits the nearest For Each / While loop.",
    icon: "stop",
    props: [],
  },
  {
    type: "core.throw",
    displayName: "Throw",
    category: "Control Flow",
    description: "Raises a business or system exception.",
    icon: "alert",
    props: [{ name: "message", label: "Message", type: "string", required: true }],
  },

  /* -------------------------------- System -------------------------------- */
  {
    type: "core.log",
    displayName: "Log Message",
    category: "System",
    description: "Writes a message to the job log.",
    icon: "message",
    props: [
      { name: "message", label: "Message", type: "string", required: true },
      { name: "level", label: "Level", type: "enum", options: ["debug", "info", "warn", "error"], default: "info" },
    ],
  },
  {
    type: "core.assign",
    displayName: "Assign",
    category: "System",
    description: "Sets a variable to the value of an expression.",
    icon: "equals",
    props: [
      { name: "variable", label: "Variable", type: "variable", required: true, output: true },
      { name: "value", label: "Value", type: "expression", required: true },
    ],
  },
  {
    type: "core.delay",
    displayName: "Delay",
    category: "System",
    description: "Waits for a number of milliseconds.",
    icon: "clock",
    props: [{ name: "ms", label: "Milliseconds", type: "number", default: 1000, required: true }],
  },
  {
    type: "core.comment",
    displayName: "Comment",
    category: "System",
    description: "Documentation only; does nothing at run time.",
    icon: "note",
    props: [{ name: "text", label: "Text", type: "text" }],
  },
  {
    type: "core.getAsset",
    displayName: "Get Asset",
    category: "System",
    description: "Reads a shared asset or credential from the Portal.",
    icon: "key",
    props: [{ name: "name", label: "Asset name", type: "string", required: true }, output("Save value to")],
  },
  {
    type: "core.runScript",
    displayName: "Run JavaScript",
    category: "System",
    description: "Runs a JavaScript snippet. Workflow variables are available as `vars`; the return value is saved to the output.",
    icon: "code",
    props: [{ name: "code", label: "Code", type: "text", required: true }, output()],
  },

  /* --------------------------------- Data --------------------------------- */
  {
    type: "data.httpRequest",
    displayName: "HTTP Request",
    category: "Data & Integration",
    description: "Calls a REST API. Result: { status, headers, body }.",
    icon: "globe",
    agentTool: true,
    props: [
      { name: "method", label: "Method", type: "enum", options: ["GET", "POST", "PUT", "PATCH", "DELETE"], default: "GET" },
      { name: "url", label: "URL", type: "string", required: true },
      { name: "headers", label: "Headers", type: "json" },
      { name: "body", label: "Body", type: "json" },
      output(),
    ],
  },
  {
    type: "data.parseJson",
    displayName: "Parse JSON",
    category: "Data & Integration",
    description: "Parses a JSON string into an object.",
    icon: "braces",
    props: [{ name: "text", label: "JSON text", type: "string", required: true }, output()],
  },
  {
    type: "file.read",
    displayName: "Read File",
    category: "Files",
    description: "Reads a text file.",
    icon: "file",
    agentTool: true,
    props: [{ name: "path", label: "Path", type: "string", required: true }, output()],
  },
  {
    type: "file.write",
    displayName: "Write File",
    category: "Files",
    description: "Writes (or appends) text to a file.",
    icon: "save",
    props: [
      { name: "path", label: "Path", type: "string", required: true },
      { name: "content", label: "Content", type: "string", required: true },
      { name: "append", label: "Append", type: "boolean", default: false },
    ],
  },

  /* -------------------------------- Browser ------------------------------- */
  {
    type: "browser.open",
    displayName: "Open Browser",
    category: "Browser",
    description: "Launches a browser and opens a URL.",
    icon: "browser",
    props: [
      { name: "url", label: "URL", type: "string", required: true },
      { name: "browser", label: "Browser", type: "enum", options: ["chromium", "firefox", "webkit"], default: "chromium" },
      { name: "headless", label: "Headless", type: "boolean", default: false },
    ],
  },
  {
    type: "browser.navigate",
    displayName: "Navigate To",
    category: "Browser",
    description: "Navigates the open browser to a URL.",
    icon: "arrow",
    agentTool: true,
    props: [{ name: "url", label: "URL", type: "string", required: true }],
  },
  {
    type: "browser.click",
    displayName: "Click",
    category: "Browser",
    description: "Clicks an element.",
    icon: "pointer",
    agentTool: true,
    props: [{ name: "selector", label: "Selector", type: "selector", required: true }, ...healing],
  },
  {
    type: "browser.type",
    displayName: "Type Into",
    category: "Browser",
    description: "Types text into an input.",
    icon: "keyboard",
    agentTool: true,
    props: [
      { name: "selector", label: "Selector", type: "selector", required: true },
      { name: "text", label: "Text", type: "string", required: true },
      { name: "clear", label: "Clear first", type: "boolean", default: true },
      { name: "pressEnter", label: "Press Enter after", type: "boolean", default: false },
      ...healing,
    ],
  },
  {
    type: "browser.getText",
    displayName: "Get Text",
    category: "Browser",
    description: "Reads the visible text of an element.",
    icon: "text",
    agentTool: true,
    props: [{ name: "selector", label: "Selector", type: "selector", required: true }, output(), ...healing],
  },
  {
    type: "browser.waitFor",
    displayName: "Wait For Element",
    category: "Browser",
    description: "Waits until an element is visible.",
    icon: "hourglass",
    props: [
      { name: "selector", label: "Selector", type: "selector", required: true },
      { name: "timeoutMs", label: "Timeout (ms)", type: "number", default: 30000 },
      ...healing,
    ],
  },
  {
    type: "browser.screenshot",
    displayName: "Take Screenshot",
    category: "Browser",
    description: "Saves a screenshot of the current page.",
    icon: "camera",
    props: [{ name: "path", label: "File path", type: "string", default: "screenshot.png" }],
  },
  {
    type: "browser.close",
    displayName: "Close Browser",
    category: "Browser",
    description: "Closes the browser.",
    icon: "close",
    props: [],
  },

  /* ---------------------------------- AI ---------------------------------- */
  {
    type: "ai.prompt",
    displayName: "AI Prompt",
    category: "AI",
    description: "Sends a prompt to Claude and saves the text answer.",
    icon: "sparkles",
    props: [
      { name: "prompt", label: "Prompt", type: "text", required: true },
      { name: "system", label: "System instructions", type: "text" },
      output(),
    ],
  },
  {
    type: "ai.extract",
    displayName: "AI Extract Data",
    category: "AI",
    description: "Extracts structured data (matching a JSON Schema) from text, e.g. an email or invoice.",
    icon: "table",
    props: [
      { name: "input", label: "Input text", type: "string", required: true },
      { name: "instructions", label: "Instructions", type: "text" },
      {
        name: "schema",
        label: "JSON Schema",
        type: "json",
        required: true,
        description: "Object schema. Every object needs `required` and `additionalProperties: false`.",
      },
      output(),
    ],
  },
  {
    type: "ai.agent",
    displayName: "AI Agent",
    category: "AI",
    description:
      "Gives Claude a goal and lets it decide which actions to run (browser, HTTP, files) until the goal is met.",
    icon: "robot",
    props: [
      { name: "goal", label: "Goal", type: "text", required: true },
      {
        name: "tools",
        label: "Allowed actions",
        type: "json",
        description: "Array of action types the agent may use. Defaults to every agent-capable action.",
      },
      { name: "maxSteps", label: "Max steps", type: "number", default: 20 },
      output("Save final answer to"),
    ],
  },
];

export function findAction(type: string, catalog: ActionMeta[] = BUILTIN_ACTIONS): ActionMeta | undefined {
  return catalog.find((a) => a.type === type);
}
