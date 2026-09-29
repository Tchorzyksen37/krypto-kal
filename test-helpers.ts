// test-helpers.ts – wspólne narzędzia testów end-to-end: uruchamia mcp-server.ts na wolnym porcie
// i łączy się jak Claude (klient MCP + Bearer token).

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
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

function startServer(port: number): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["mcp-server.ts"], {
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.on("data", (d) => {
      if (String(d).includes("MCP server:")) resolve(child);
    });
    child.on("exit", (code) => reject(new Error(`Serwer zakończył się (kod ${code}):\n${stderr}`)));
  });
}

// Rejestruje before/after w bieżącym describe; kontekst jest wypełniony po `before`.
export function useMcpServer(): McpContext {
  const ctx = {} as McpContext;
  let server: ChildProcess | undefined;

  before(async () => {
    const token = process.env.MCP_AUTH_TOKEN;
    assert.ok(token, "Brak MCP_AUTH_TOKEN w .env");

    const port = await freePort();
    ctx.url = `http://127.0.0.1:${port}/mcp`;
    server = await startServer(port);

    ctx.client = new Client({ name: "sanity-test", version: "1.0.0" });
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

// Wspólne testy serwera: autoryzacja i obecność narzędzi danego dostawcy.
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

  test("bez tokenu -> 401", async () => {
    assert.equal((await listTools({})).status, 401);
  });

  test("zły token -> 401", async () => {
    assert.equal((await listTools({ Authorization: "Bearer zly-token" })).status, 401);
  });

  test("tools/list zawiera wszystkie narzędzia dostawcy", async () => {
    const names = new Set((await ctx.client.listTools()).tools.map((t) => t.name));
    for (const t of tools) assert.ok(names.has(t), `Brak narzędzia ${t}`);
  });
}

// Woła narzędzie, sprawdza że nie ma błędu i zwraca sparsowany JSON.
export async function call(ctx: McpContext, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const res = await ctx.client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0]?.text ?? "";
  assert.notEqual(res.isError, true, `Narzędzie ${name} zwróciło błąd: ${text}`);
  return JSON.parse(text);
}

const isNumeric = (v: unknown) =>
  (typeof v === "number" || typeof v === "string") && v !== "" && Number.isFinite(Number(v));

// Sprawdza, że `points` to niepusta tablica, a każdy punkt ma numeryczne `timeField` i `fields`.
export function assertPoints(points: unknown, fields: string[], timeField: string) {
  assert.ok(Array.isArray(points), `Oczekiwano tablicy, otrzymano: ${JSON.stringify(points).slice(0, 200)}`);
  assert.ok(points.length > 0, "Pusta tablica danych");
  for (const p of points as Record<string, unknown>[]) {
    for (const f of [timeField, ...fields]) {
      assert.ok(isNumeric(p[f]), `Brak/niepoprawne pole ${f}: ${JSON.stringify(p)}`);
    }
  }
}
