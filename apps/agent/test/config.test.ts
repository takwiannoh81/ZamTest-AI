import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentKeyFrom, loadAgentConfig } from "../src/config.js";

const dir = mkdtempSync(join(tmpdir(), "zt-agent-config-"));
const file = (name: string, content: string) => {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};

describe("agent.json", () => {
  afterEach(() => {
    delete process.env.ZT_TEST_FROM_FILE;
    delete process.env.ZT_TEST_ALREADY_SET;
  });

  it("is optional", () => {
    expect(loadAgentConfig(undefined)).toEqual({});
  });

  it("reads the installer's file, including a UTF-8 byte order mark", () => {
    const path = file("bom.json", '﻿{"server":"https://api.example.com","key":"k","name":"Bürο-PC"}');
    expect(loadAgentConfig(path)).toEqual({ server: "https://api.example.com", key: "k", name: "Bürο-PC" });
  });

  it("adds env entries without overriding real environment variables", () => {
    process.env.ZT_TEST_ALREADY_SET = "real";
    loadAgentConfig(file("env.json", '{"env":{"ZT_TEST_FROM_FILE":"file","ZT_TEST_ALREADY_SET":"file"}}'));
    expect(process.env.ZT_TEST_FROM_FILE).toBe("file");
    expect(process.env.ZT_TEST_ALREADY_SET).toBe("real");
  });

  it("explains broken files", () => {
    expect(() => loadAgentConfig(file("bad.json", "{server:"))).toThrow(/not valid JSON/);
    expect(() => loadAgentConfig(join(dir, "missing.json"))).toThrow(/Cannot read the agent settings file/);
  });

  it.skipIf(process.platform !== "win32")("decrypts a key the tray app protected for this Windows user", () => {
    // The same DPAPI call as AgentSettings.Save in installer/ZamTechAgent.cs.
    const script =
      "Add-Type -AssemblyName System.Security; " +
      "$e = [Text.Encoding]::UTF8.GetBytes('ZamTech AI Agent key'); " +
      "$b = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes('s3cret-ключ'), $e, 'CurrentUser'); " +
      "[Console]::Out.Write([Convert]::ToBase64String($b))";
    const keyProtected = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8" }).trim();
    expect(agentKeyFrom({ keyProtected })).toBe("s3cret-ключ");
    expect(() => agentKeyFrom({ keyProtected: "bm90IGEgYmxvYg==" })).toThrow(/Cannot decrypt the agent key/);
  });

  it("prefers a plain key and has none when neither is set", () => {
    expect(agentKeyFrom({ key: "plain", keyProtected: "ignored" })).toBe("plain");
    expect(agentKeyFrom({})).toBeUndefined();
  });
});
