import type { Env } from "./calendar.ts";
import { handleMcpPost } from "./mcp.ts";

// Endpunkte:
//   POST /mcp/<MCP_TOKEN>   – MCP (Streamable HTTP); Token im Pfad, da Claude-Connectors nur eine URL kennen
//   POST /mcp               – MCP mit Header "Authorization: Bearer <MCP_TOKEN>"
//   GET  /                  – kurzer Statustext

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
};

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function withCors(res: Response): Response {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS)) r.headers.set(k, v);
  return r;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === "/" && request.method === "GET") {
      return new Response("itslearning-Kalender MCP-Server läuft. MCP-Endpunkt: /mcp/<token>\n", {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    const match = url.pathname.match(/^\/mcp(?:\/([^/]+))?\/?$/);
    if (!match) return new Response("Not found", { status: 404 });

    if (!env.MCP_TOKEN) {
      return new Response("Server nicht konfiguriert: MCP_TOKEN fehlt (wrangler secret put MCP_TOKEN).", { status: 500 });
    }
    const bearer = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
    const supplied = match[1] ? decodeURIComponent(match[1]) : bearer ?? "";
    if (!timingSafeEqual(supplied, env.MCP_TOKEN)) return new Response("Unauthorized", { status: 401 });

    if (request.method === "POST") return withCors(await handleMcpPost(request, env));
    // Kein serverseitiger SSE-Stream und keine Sessions nötig (zustandsloser Server).
    return new Response("Method Not Allowed", { status: 405, headers: { ...CORS, Allow: "POST" } });
  },
} satisfies ExportedHandler<Env>;
