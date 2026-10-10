// test-helpers.ts – shared helpers for end-to-end tests: starts mcp-server.ts on a free port
// and connects the way Claude does (MCP client + Bearer token).

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface McpContext {
  url: string;
  client: Client;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

// Absolute, so the tests work from any working directory.
const SERVER_ENTRY = fileURLToPath(new URL("../../src/server/mcp-server.ts", import.meta.url));

function startServer(port: number, env: Record<string, string>): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      env: { ...process.env, STATS_LOG: "false", ...env, PORT: String(port) }, // test calls stay out of the real stats log
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stderr.on("data", (d) => (output += d));
    child.stdout.on("data", (d) => {
      output += d;
      if (output.includes("MCP server listening")) resolve(child);
    });
    child.on("exit", (code) => reject(new Error(`Server exited (code ${code}):\n${output}`)));
  });
}

// Registers before/after in the current describe; the context is filled in by `before`.
// `env` overrides the server's environment (e.g. CACHE_DB_PATH).
export function useMcpServer(env: Record<string, string> = {}): McpContext {
  const ctx = {} as McpContext;
  let server: ChildProcess | undefined;

  before(async () => {
    const token = process.env.MCP_AUTH_TOKEN;
    assert.ok(token, "MCP_AUTH_TOKEN is not set in .env");

    const port = await freePort();
    ctx.url = `http://127.0.0.1:${port}/mcp`;
    server = await startServer(port, env);

    ctx.client = new Client({ name: "e2e-test", version: "1.0.0" });
    await ctx.client.connect(
      new StreamableHTTPClientTransport(new URL(ctx.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
  });

  after(async () => {
    await ctx.client?.close();
    server?.kill();
  });

  return ctx;
}

// Shared server tests: authorization and presence of the provider's tools.
export function serverTests(ctx: McpContext, tools: string[]) {
  const listTools = (headers: Record<string, string>) =>
    fetch(ctx.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

  test("no token -> 401", async () => {
    assert.equal((await listTools({})).status, 401);
  });

  test("wrong token -> 401", async () => {
    assert.equal((await listTools({ Authorization: "Bearer wrong-token" })).status, 401);
  });

  test("tools/list contains all provider tools", async () => {
    const names = new Set((await ctx.client.listTools()).tools.map((t) => t.name));
    for (const t of tools) assert.ok(names.has(t), `Missing tool ${t}`);
  });
}

// Calls a tool, asserts it did not fail and returns the parsed JSON.
export async function call(ctx: McpContext, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const res = await ctx.client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0]?.text ?? "";
  assert.notEqual(res.isError, true, `Tool ${name} returned an error: ${text}`);
  return JSON.parse(text);
}

// Calls a tool that answers with plain text (format "table") and returns the text.
export async function callText(ctx: McpContext, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const res = await ctx.client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0]?.text ?? "";
  assert.notEqual(res.isError, true, `Tool ${name} returned an error: ${text}`);
  return text;
}

// Asserts a format "table" answer: the header lines, then a CSV header starting with "time," and `rows` data rows
// (at least one when `rows` is not given).
export function assertTable(text: string, columns: string[], rows?: number) {
  const lines = text.split("\n");
  assert.match(lines[1] ?? "", /^as of \d{4}-\d\d-\d\dT\d\d:\d\dZ; /, text.slice(0, 300));
  const header = lines.find((l) => l.startsWith("time,"));
  assert.ok(header, `No CSV header: ${text.slice(0, 300)}`);
  for (const c of columns) assert.ok(header.split(",").includes(c), `Column ${c} missing in ${header}`);
  const data = lines.filter((l) => /^\d{4}-\d\d-\d\dT\d\d:\d\dZ,/.test(l));
  if (rows === undefined) assert.ok(data.length > 0, text.slice(0, 500));
  else assert.equal(data.length, rows, text.slice(0, 500));
}

const isNumeric = (v: unknown) =>
  (typeof v === "number" || typeof v === "string") && v !== "" && Number.isFinite(Number(v));

// Asserts `points` is a non-empty array and every point has numeric `timeField` and `fields`.
export function assertPoints(points: unknown, fields: string[], timeField: string) {
  assert.ok(Array.isArray(points), `Expected an array, got: ${JSON.stringify(points).slice(0, 200)}`);
  assert.ok(points.length > 0, "Empty data array");
  for (const p of points as Record<string, unknown>[]) {
    for (const f of [timeField, ...fields]) {
      assert.ok(isNumeric(p[f]), `Missing/invalid field ${f}: ${JSON.stringify(p)}`);
    }
  }
}
