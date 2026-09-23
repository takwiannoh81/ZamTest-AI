import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Settings the Windows installer and tray app write to agent.json. */
export interface AgentFileConfig {
  server?: string;
  key?: string;
  /** The agent key encrypted for the current Windows user (DPAPI), base64. The tray app writes this instead of `key`. */
  keyProtected?: string;
  name?: string;
  /** Extra environment variables for workflows, e.g. ANTHROPIC_API_KEY. */
  env?: Record<string, string>;
}

/** Reads agent.json; command-line flags and environment variables still take precedence. */
export function loadAgentConfig(path: string | undefined): AgentFileConfig {
  if (!path) return {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf8").replace(/^﻿/, "");
  } catch (err) {
    throw new Error(`Cannot read the agent settings file ${path}: ${(err as Error).message}`);
  }
  let config: AgentFileConfig;
  try {
    config = JSON.parse(raw) as AgentFileConfig;
  } catch {
    throw new Error(`The agent settings file ${path} is not valid JSON`);
  }
  for (const [name, value] of Object.entries(config.env ?? {})) {
    if (process.env[name] === undefined) process.env[name] = String(value);
  }
  return config;
}

/** Must match ZamTechAgent.cs. */
const KEY_ENTROPY = "ZamTech AI Agent key";

/** The agent key from agent.json, decrypting `keyProtected` with Windows DPAPI when needed. */
export function agentKeyFrom(config: AgentFileConfig): string | undefined {
  if (config.key) return config.key;
  if (!config.keyProtected) return undefined;
  if (process.platform !== "win32") throw new Error("The agent key in agent.json is encrypted for a Windows user and cannot be read here");
  const script = [
    "Add-Type -AssemblyName System.Security",
    "$blob = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())",
    `$entropy = [Text.Encoding]::UTF8.GetBytes('${KEY_ENTROPY}')`,
    "$plain = [Security.Cryptography.ProtectedData]::Unprotect($blob, $entropy, 'CurrentUser')",
    "[Console]::Out.Write([Convert]::ToBase64String($plain))",
  ].join("; ");
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      input: config.keyProtected,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    return Buffer.from(out.trim(), "base64").toString("utf8");
  } catch {
    throw new Error("Cannot decrypt the agent key in agent.json. It only works for the Windows user who saved it; enter the key again in the agent's Settings.");
  }
}
