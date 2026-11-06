import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { config } from "../../config.js";

const run = promisify(execFile);

const clients = new Map<string, Client>();
const connections = new Map<string, Promise<Client>>();
const clientKey = () => JSON.stringify(config().unity.mcp);

/** Runs the project's header helper. The token stays in memory and is never logged. */
async function authHeaders(): Promise<Record<string, string>> {
  const { headerHelper, headerHelperArgs } = config().unity.mcp;
  if (!headerHelper) return {};
  const { stdout } = await run(headerHelper, headerHelperArgs, { windowsHide: true });
  return JSON.parse(stdout) as Record<string, string>;
}

async function connect(): Promise<Client> {
  const headers = await authHeaders();
  const transport = new StreamableHTTPClientTransport(new URL(config().unity.mcp.url), {
    requestInit: { headers },
  });
  const c = new Client({ name: "devlog-studio", version: "0.1.0" });
  await c.connect(transport);
  return c;
}

async function getClient(): Promise<Client> {
  const key = clientKey();
  const client = clients.get(key);
  if (client) return client;
  let connecting = connections.get(key);
  if (!connecting) {
    connecting = connect().then((c) => { clients.set(key, c); return c; }).finally(() => connections.delete(key));
    connections.set(key, connecting);
  }
  return connecting;
}
export async function resetMcp() {
  const key = clientKey();
  const client = clients.get(key); clients.delete(key);
  await client?.close().catch(() => {});
}

export async function callTool(name: string, args: Record<string, unknown>, timeoutMs = 120_000) {
  try {
    const c = await getClient();
    return await c.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
  } catch (err) {
    await resetMcp();
    throw err;
  }
}

/** Names of the tools the connected MCP server lists. */
async function toolNames(): Promise<string[]> {
  const c = await getClient();
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await c.listTools(cursor ? { cursor } : undefined);
    names.push(...page.tools.map((t) => t.name));
    cursor = page.nextCursor;
  } while (cursor);
  return names;
}

/** Text content of a tool result, joined. Throws when the tool reports an error. */
export function resultText(result: Awaited<ReturnType<typeof callTool>>): string {
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  const text = content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
  if (result.isError) throw new Error(text || "Unity MCP tool failed");
  return text;
}

/**
 * Compiles and runs a static C# method in the open editor.
 * The method must return a string; this returns that string.
 */
export async function executeCSharp(code: string, className: string, methodName = "Run", timeoutMs = 120_000) {
  const result = await callTool("script-execute", { csharpCode: code, className, methodName }, timeoutMs);
  const text = resultText(result);
  return unwrapSerializedString(text);
}

/** script-execute wraps return values in a SerializedMember JSON envelope. */
function unwrapSerializedString(text: string): string {
  try {
    const parsed = JSON.parse(text);
    const value = parsed?.value ?? parsed?.result?.value ?? parsed?.structuredContent?.result?.value;
    if (typeof value === "string") return value;
    if (value !== undefined) return JSON.stringify(value);
  } catch {
    /* not JSON: return as-is */
  }
  return text;
}

/** Confirms the connected editor is the configured project. */
export async function verifyProject(): Promise<{ ok: boolean; dataPath: string }> {
  const code = `using UnityEngine; public static class DevlogProbe { public static string Run() { return Application.dataPath; } }`;
  const output = await executeCSharp(code, "DevlogProbe").catch(async (err) => {
    const names = await toolNames().catch(() => null);
    if (names && !names.includes("script-execute")) throw new Error("This MCP server has no script-execute tool. Unity capture needs Unity-MCP: https://github.com/IvanMurzak/Unity-MCP");
    throw err;
  });
  const dataPath = output.trim().replace(/^"|"$/g, "");
  const expected = config().unity.projectPath.replace(/\\/g, "/").replace(/\/$/, "") + "/Assets";
  return { ok: dataPath.toLowerCase() === expected.toLowerCase(), dataPath };
}
