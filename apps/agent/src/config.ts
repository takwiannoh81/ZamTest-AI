import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

/** Settings the Windows installer and tray app write to agent.json. */
export interface AgentFileConfig {
  server?: string;
  name?: string;
  /**
   * This PC's own credential, issued when it was approved in the Portal. The
   * tray app keeps it encrypted for the Windows user (DPAPI, base64) as
   * `tokenProtected`; other systems store `token`.
   */
  token?: string;
  tokenProtected?: string;
  agentId?: string;
  /** Approves the PC without a browser; used once, then removed. */
  installKey?: string;
  /** Shared agent key (older installs, the cloud bot); `keyProtected` is its DPAPI form. */
  key?: string;
  keyProtected?: string;
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

export function saveAgentConfig(path: string, config: AgentFileConfig): void {
  writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/** Must match ZamTechAgent.cs. */
const KEY_ENTROPY = "ZamTech AI Agent key";

function dpapi(operation: "Protect" | "Unprotect", base64Input: string): string {
  const script = [
    "Add-Type -AssemblyName System.Security",
    "$data = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())",
    `$entropy = [Text.Encoding]::UTF8.GetBytes('${KEY_ENTROPY}')`,
    `$out = [Security.Cryptography.ProtectedData]::${operation}($data, $entropy, 'CurrentUser')`,
    "[Console]::Out.Write([Convert]::ToBase64String($out))",
  ].join("; ");
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input: base64Input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

/** Encrypts a secret for the current Windows user (DPAPI), as the tray app does. */
export function protectSecret(secret: string): string {
  return dpapi("Protect", Buffer.from(secret, "utf8").toString("base64"));
}

function revealSecret(plain: string | undefined, protectedValue: string | undefined, what: string): string | undefined {
  if (plain) return plain;
  if (!protectedValue) return undefined;
  if (process.platform !== "win32") throw new Error(`The ${what} in agent.json is encrypted for a Windows user and cannot be read here`);
  try {
    return Buffer.from(dpapi("Unprotect", protectedValue), "base64").toString("utf8");
  } catch {
    throw new Error(`Cannot decrypt the ${what} in agent.json. It only works for the Windows user who saved it; connect this PC again from the agent's tray icon.`);
  }
}

/** The PC's own credential from agent.json, decrypting `tokenProtected` with Windows DPAPI when needed. */
export function agentTokenFrom(config: AgentFileConfig): string | undefined {
  return revealSecret(config.token, config.tokenProtected, "agent credential");
}

/** The shared agent key from agent.json, decrypting `keyProtected` with Windows DPAPI when needed. */
export function agentKeyFrom(config: AgentFileConfig): string | undefined {
  return revealSecret(config.key, config.keyProtected, "agent key");
}
