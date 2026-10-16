// Minimaler, zustandsloser MCP-Server (Streamable HTTP, JSON-Antworten) ohne externe Abhängigkeiten.
import { formatResult, loadFeed, queryEvents, toStructured, type Env, type QueryOptions } from "./calendar.ts";

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "itslearning-kalender", title: "itslearning Kalender", version: "0.1.0" };

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string } };

const dateProp = (what: string) => ({
  type: "string",
  description: `${what}: YYYY-MM-DD, DD.MM.YYYY, ISO-Zeitpunkt oder "heute"/"morgen".`,
});

const TOOLS = [
  {
    name: "list_events",
    title: "Termine auflisten",
    description:
      "Listet alle Termine und Abgaben aus dem itslearning-Kalender in einem Zeitraum. " +
      "Ohne Angaben: heute plus die nächsten 7 Tage.",
    inputSchema: {
      type: "object",
      properties: {
        from: dateProp("Beginn (Standard: heute)"),
        to: dateProp("Ende, inklusive (überschreibt days)"),
        days: { type: "integer", minimum: 1, maximum: 366, description: "Anzahl Tage ab Beginn (Standard 7)." },
        query: { type: "string", description: "Optionaler Suchbegriff (Titel, Beschreibung, Ort, Kategorie)." },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Maximale Anzahl Einträge (Standard 100)." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "list_assignments",
    title: "Abgaben & Fristen",
    description:
      "Listet anstehende Abgaben, Aufgaben, Tests und Fristen aus dem itslearning-Kalender " +
      "(erkannt über Schlüsselwörter wie Abgabe, Aufgabe, Frist, Assignment, Test). Standard: die nächsten 14 Tage.",
    inputSchema: {
      type: "object",
      properties: {
        from: dateProp("Beginn (Standard: heute)"),
        to: dateProp("Ende, inklusive (überschreibt days)"),
        days: { type: "integer", minimum: 1, maximum: 366, description: "Anzahl Tage ab Beginn (Standard 14)." },
        query: { type: "string", description: "Optionaler Suchbegriff, z. B. ein Fach." },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "search_events",
    title: "Kalender durchsuchen",
    description:
      "Durchsucht den itslearning-Kalender nach Begriffen (alle Wörter müssen vorkommen). " +
      "Standard-Zeitraum: 30 Tage zurück bis 180 Tage voraus.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Suchbegriff(e), z. B. \"Mathe Klausur\"." },
        from: dateProp("Beginn"),
        to: dateProp("Ende, inklusive"),
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

function pickOptions(args: Record<string, unknown>): QueryOptions {
  const str = (k: string) => (typeof args[k] === "string" && (args[k] as string).trim() ? (args[k] as string) : undefined);
  const num = (k: string) => (typeof args[k] === "number" && Number.isFinite(args[k]) ? Math.floor(args[k] as number) : undefined);
  return { from: str("from"), to: str("to"), days: num("days"), query: str("query"), limit: num("limit") };
}

export async function callTool(name: string, args: Record<string, unknown>, env: Env, now = Date.now()) {
  const opts = pickOptions(args);
  let title: string;
  if (name === "list_events") {
    title = "Termine";
  } else if (name === "list_assignments") {
    title = "Abgaben & Fristen";
    opts.assignmentsOnly = true;
    opts.days ??= 14;
  } else if (name === "search_events") {
    if (!opts.query) throw new Error("Parameter 'query' fehlt.");
    title = `Suchergebnisse für "${opts.query}"`;
    if (!opts.from) opts.from = new Date(now - 30 * 86_400_000).toISOString();
    if (!opts.to) opts.days ??= 210;
  } else {
    throw new UnknownToolError(name);
  }
  const ics = await loadFeed(env);
  const result = queryEvents(ics, env, opts, now);
  return {
    content: [{ type: "text", text: formatResult(result, env, title) }],
    structuredContent: toStructured(result),
  };
}

class UnknownToolError extends Error {
  constructor(name: string) {
    super(`Unbekanntes Tool: ${name}`);
  }
}

async function handleMessage(msg: JsonRpcRequest, env: Env): Promise<JsonRpcResponse | null> {
  const isNotification = msg.id === undefined;
  const id = msg.id ?? null;
  const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
  const err = (code: number, message: string): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });

  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return isNotification ? null : err(-32600, "Invalid Request");
  }
  if (isNotification) return null; // z. B. notifications/initialized

  switch (msg.method) {
    case "initialize": {
      const requested = String(msg.params?.protocolVersion ?? "");
      return ok({
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Liefert Termine und Abgaben aus dem persönlichen itslearning-Kalender (iCal-Feed). " +
          "Nutze list_assignments für anstehende Abgaben/Fristen, list_events für den Stundenplan bzw. alle Termine " +
          "und search_events für die Suche nach Fächern oder Stichworten.",
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "resources/list":
      return ok({ resources: [] });
    case "prompts/list":
      return ok({ prompts: [] });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        return ok(await callTool(name, args, env));
      } catch (e) {
        if (e instanceof UnknownToolError) return err(-32602, e.message);
        return ok({ content: [{ type: "text", text: `Fehler: ${(e as Error).message}` }], isError: true });
      }
    }
    default:
      return err(-32601, `Method not found: ${msg.method}`);
  }
}

export async function handleMcpPost(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  if (Array.isArray(body)) {
    const responses = (await Promise.all(body.map((m) => handleMessage(m as JsonRpcRequest, env)))).filter(Boolean);
    return responses.length ? json(responses) : new Response(null, { status: 202 });
  }
  const response = await handleMessage(body as JsonRpcRequest, env);
  return response ? json(response) : new Response(null, { status: 202 });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
