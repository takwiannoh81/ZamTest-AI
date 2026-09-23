import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stringify } from "@zamtest/core";
import type { ActionHandler } from "@zamtest/core";

export const dataHandlers: Record<string, ActionHandler> = {
  "data.httpRequest": async (props, ctx) => {
    const method = String(props.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    if (props.headers && typeof props.headers === "object") {
      for (const [k, v] of Object.entries(props.headers)) headers[k] = stringify(v);
    }
    let body: string | undefined;
    if (props.body !== undefined && props.body !== null && props.body !== "" && method !== "GET") {
      if (typeof props.body === "string") {
        body = props.body;
      } else {
        body = JSON.stringify(props.body);
        if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
          headers["content-type"] = "application/json";
        }
      }
    }
    const res = await fetch(String(props.url), { method, headers, body, signal: ctx.signal });
    const text = await res.text();
    let parsed: unknown = text;
    if ((res.headers.get("content-type") ?? "").includes("json")) {
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep raw text */
      }
    }
    ctx.log("info", `${method} ${props.url} -> ${res.status}`);
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    return { status: res.status, ok: res.ok, headers: responseHeaders, body: parsed };
  },

  "data.parseJson": (props) => (typeof props.text === "string" ? JSON.parse(props.text) : props.text),

  "file.read": (props) => readFile(String(props.path), "utf8"),

  "file.write": async (props) => {
    const path = String(props.path);
    await mkdir(dirname(path), { recursive: true });
    const content = stringify(props.content);
    if (props.append) await appendFile(path, content, "utf8");
    else await writeFile(path, content, "utf8");
    return path;
  },
};
