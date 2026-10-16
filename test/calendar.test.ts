import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIcs } from "../src/ical.ts";
import { queryEvents, parseDateInput, formatResult } from "../src/calendar.ts";
import { callTool } from "../src/mcp.ts";
import worker from "../src/index.ts";

const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//itslearning//Calendar//DE",
  "BEGIN:VTIMEZONE",
  "TZID:W. Europe Standard Time",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "UID:a1",
  "DTSTART;TZID=W. Europe Standard Time:20261020T080000",
  "DTEND;TZID=W. Europe Standard Time:20261020T093000",
  "SUMMARY:Mathematik",
  "LOCATION:Raum 101",
  "RRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261105T235959Z",
  "EXDATE;TZID=W. Europe Standard Time:20261022T080000",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:b2",
  "DTSTART:20261023T215900Z",
  "DTEND:20261023T215900Z",
  "SUMMARY:Abgabe: Erörterung Deutsch",
  "DESCRIPTION:Bitte als PDF hochladen.\\nUmfang: 2 Seiten",
  "URL:https://example.itslearning.com/essay/read_essay.aspx?EssayID=1",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:c3",
  "DTSTART;VALUE=DATE:20261026",
  "DTEND;VALUE=DATE:20261031",
  "SUMMARY:Herbstferien",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:d4",
  "DTSTART;TZID=Europe/Berlin:20261101T100000",
  "DURATION:PT45M",
  "SUMMARY:Englisch Vokabeltest mit einer sehr langen Zeile, die laut RFC 5545 gef",
  " altet wird",
  "BEGIN:VALARM",
  "TRIGGER:-PT15M",
  "SUMMARY:Alarm",
  "END:VALARM",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const env = { ICAL_URL: "https://example.invalid/feed.ics", MCP_TOKEN: "secret", DISPLAY_TZ: "Europe/Berlin" };
const NOW = Date.parse("2026-10-19T10:00:00Z");

test("Wiederholungen, EXDATE und Zeitzonen", () => {
  const ev = parseIcs(ICS, new Date("2026-10-01T00:00:00Z"), new Date("2026-12-01T00:00:00Z")).filter(
    (e) => e.uid === "a1",
  );
  // Di 20., (Do 22. ausgenommen), Di 27., Do 29., Di 3.11., Do 5.11.
  assert.deepEqual(
    ev.map((e) => e.start.toISOString()),
    [
      "2026-10-20T06:00:00.000Z",
      "2026-10-27T07:00:00.000Z", // nach Zeitumstellung (25.10.) wieder 08:00 lokal
      "2026-10-29T07:00:00.000Z",
      "2026-11-03T07:00:00.000Z",
      "2026-11-05T07:00:00.000Z",
    ],
  );
  assert.equal(ev[0].end.toISOString(), "2026-10-20T07:30:00.000Z");
  assert.equal(ev[0].location, "Raum 101");
});

test("Zeilenfaltung, DURATION, ganztägig, VALARM ignoriert", () => {
  const ev = parseIcs(ICS, new Date("2026-10-01T00:00:00Z"), new Date("2026-12-01T00:00:00Z"));
  const d4 = ev.find((e) => e.uid === "d4")!;
  assert.match(d4.summary, /gefaltet wird$/);
  assert.equal(d4.end.getTime() - d4.start.getTime(), 45 * 60_000);
  const c3 = ev.find((e) => e.uid === "c3")!;
  assert.equal(c3.allDay, true);
  assert.equal(c3.start.toISOString(), "2026-10-25T23:00:00.000Z"); // 26.10. 00:00 MEZ (nach Zeitumstellung)
});

test("Abgaben werden erkannt", () => {
  const r = queryEvents(ICS, env, { days: 30, assignmentsOnly: true }, NOW);
  assert.deepEqual(r.events.map((e) => e.uid), ["b2", "d4"]);
  assert.match(r.events[0].description, /Umfang: 2 Seiten/);
});

test("Zeitraum und Suche", () => {
  const r = queryEvents(ICS, env, { from: "2026-10-20", to: "2026-10-20" }, NOW);
  assert.deepEqual(r.events.map((e) => e.uid), ["a1"]);
  const s = queryEvents(ICS, env, { from: "01.10.2026", days: 60, query: "mathematik" }, NOW);
  assert.equal(s.events.length, 5);
  const text = formatResult(r, env, "Termine");
  assert.match(text, /Mathematik/);
  assert.match(text, /08:00 – 09:30/);
});

test("Relative Datumsangaben", () => {
  assert.equal(new Date(parseDateInput("morgen", "Europe/Berlin", NOW)).toISOString(), "2026-10-19T22:00:00.000Z");
});

test("MCP-Endpunkt: Auth, initialize, tools/list, tools/call", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(ICS)) as typeof fetch;
  try {
    const post = (path: string, body: unknown) =>
      worker.fetch(
        new Request(`https://w.example${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        env,
      );
    assert.equal((await post("/mcp/falsch", { jsonrpc: "2.0", id: 1, method: "ping" })).status, 401);

    const init = await (await post("/mcp/secret", {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    })).json() as any;
    assert.equal(init.result.protocolVersion, "2025-06-18");

    const note = await post("/mcp/secret", { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(note.status, 202);

    const list = await (await post("/mcp/secret", { jsonrpc: "2.0", id: 2, method: "tools/list" })).json() as any;
    assert.deepEqual(list.result.tools.map((t: any) => t.name), ["list_events", "list_assignments", "search_events"]);

    const call = await (await post("/mcp/secret", {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "search_events", arguments: { query: "Erörterung" } },
    })).json() as any;
    assert.equal(call.result.isError, undefined);
    assert.match(call.result.content[0].text, /Abgabe: Erörterung Deutsch/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Tool-Fehler werden als isError gemeldet", async () => {
  await assert.rejects(callTool("search_events", {}, env), /query/);
});
