import { parseIcs, utcToZoned, zonedToUtc, type CalEvent } from "./ical.ts";

export interface Env {
  ICAL_URL: string;
  MCP_TOKEN?: string;
  DISPLAY_TZ?: string;
  CACHE_TTL_SECONDS?: string;
  ASSIGNMENT_KEYWORDS?: string;
}

const DAY = 86_400_000;

const DEFAULT_ASSIGNMENT_KEYWORDS =
  "abgabe|aufgabe|hausaufgabe|einreich|frist|fällig|deadline|assignment|due|submission|essay|test|prüfung|klausur|quiz";

// ---------------------------------------------------------------------------
// Feed laden (mit kurzem In-Memory-Cache pro Worker-Instanz)

let cache: { url: string; text: string; fetchedAt: number } | null = null;

export async function loadFeed(env: Env, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (!env.ICAL_URL) throw new Error("ICAL_URL ist nicht gesetzt (wrangler secret put ICAL_URL).");
  const url = env.ICAL_URL.trim().replace(/^webcals?:\/\//i, "https://");
  const ttl = Math.max(0, Number(env.CACHE_TTL_SECONDS ?? 300) || 0) * 1000;
  if (cache && cache.url === url && Date.now() - cache.fetchedAt < ttl) return cache.text;

  const res = await fetchImpl(url, {
    headers: { "User-Agent": "itslearning-calendar-mcp/0.1", Accept: "text/calendar, */*" },
  });
  if (!res.ok) throw new Error(`Kalenderfeed konnte nicht geladen werden (HTTP ${res.status}).`);
  const text = await res.text();
  if (!text.includes("BEGIN:VCALENDAR")) {
    throw new Error("Die Antwort ist kein iCal-Feed. Ist der Kalenderlink noch gültig?");
  }
  cache = { url, text, fetchedAt: Date.now() };
  return text;
}

export function clearFeedCache(): void {
  cache = null;
}

// ---------------------------------------------------------------------------
// Datumsangaben

/** Mitternacht (lokal in tz) des Tages, der `ms` enthält, plus `addDays` Tage. */
export function startOfDay(ms: number, tz: string, addDays = 0): number {
  const f = utcToZoned(ms, tz);
  const shifted = new Date(Date.UTC(f.y, f.m - 1, f.d + addDays));
  return zonedToUtc(
    { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() + 1, d: shifted.getUTCDate(), h: 0, mi: 0, s: 0 },
    tz,
  );
}

const RELATIVE: Record<string, number> = {
  today: 0, heute: 0,
  tomorrow: 1, morgen: 1,
  yesterday: -1, gestern: -1,
  "übermorgen": 2, uebermorgen: 2,
};

/**
 * Parst "YYYY-MM-DD", ISO-Zeitpunkte, "DD.MM.YYYY" oder "heute"/"morgen"/….
 * Bei `endOfDay` wird für reine Datumsangaben das Ende des Tages geliefert.
 */
export function parseDateInput(input: string, tz: string, now: number, endOfDay = false): number {
  const v = input.trim().toLowerCase();
  if (v in RELATIVE) return startOfDay(now, tz, RELATIVE[v] + (endOfDay ? 1 : 0));
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/) ?? null;
  let ymd: [number, number, number] | null = m ? [+m[1], +m[2], +m[3]] : null;
  if (!ymd) {
    m = v.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (m) ymd = [+m[3], +m[2], +m[1]];
  }
  if (ymd) {
    const ms = zonedToUtc({ y: ymd[0], m: ymd[1], d: ymd[2], h: 0, mi: 0, s: 0 }, tz);
    return endOfDay ? startOfDay(ms, tz, 1) : ms;
  }
  // ISO-Zeitpunkt; ohne Offset als lokale Zeit in tz interpretieren
  m = v.match(/^(\d{4})-(\d{2})-(\d{2})t(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) return zonedToUtc({ y: +m[1], m: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: m[6] ? +m[6] : 0 }, tz);
  const t = Date.parse(input);
  if (!Number.isNaN(t)) return t;
  throw new Error(`Unbekanntes Datumsformat: "${input}" (erwartet z. B. 2026-10-16, 16.10.2026 oder "morgen").`);
}

// ---------------------------------------------------------------------------
// Abfragen

export interface QueryOptions {
  from?: string;
  to?: string;
  days?: number;
  query?: string;
  limit?: number;
  assignmentsOnly?: boolean;
}

export interface QueryResult {
  from: Date;
  to: Date;
  events: CalEvent[];
  truncated: boolean;
}

function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function isAssignment(e: CalEvent, keywords: string): boolean {
  let re: RegExp;
  try {
    re = new RegExp(keywords, "i");
  } catch {
    re = new RegExp(DEFAULT_ASSIGNMENT_KEYWORDS, "i");
  }
  return re.test([e.summary, e.categories.join(" "), e.url, e.description].join("\n"));
}

export function queryEvents(icsText: string, env: Env, opts: QueryOptions, now = Date.now()): QueryResult {
  const tz = env.DISPLAY_TZ || "Europe/Berlin";
  const from = opts.from ? parseDateInput(opts.from, tz, now) : startOfDay(now, tz);
  let to: number;
  if (opts.to) to = parseDateInput(opts.to, tz, now, true);
  else to = startOfDay(from, tz, Math.min(Math.max(opts.days ?? 7, 1), 366));
  if (to <= from) throw new Error("Das Enddatum muss nach dem Startdatum liegen.");
  if (to - from > 400 * DAY) throw new Error("Zeitraum zu groß (maximal ca. 400 Tage).");

  let events = parseIcs(icsText, new Date(from), new Date(to), tz)
    .filter((e) => e.status !== "CANCELLED")
    .map((e) => ({ ...e, description: stripHtml(e.description) }));

  if (opts.assignmentsOnly) {
    const kw = env.ASSIGNMENT_KEYWORDS || DEFAULT_ASSIGNMENT_KEYWORDS;
    events = events.filter((e) => isAssignment(e, kw));
  }
  if (opts.query) {
    const terms = opts.query.toLowerCase().split(/\s+/).filter(Boolean);
    events = events.filter((e) => {
      const hay = [e.summary, e.description, e.location, e.categories.join(" ")].join("\n").toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  return { from: new Date(from), to: new Date(to), events: events.slice(0, limit), truncated: events.length > limit };
}

// ---------------------------------------------------------------------------
// Ausgabe

function fmt(d: Date, tz: string, withTime: boolean): string {
  return new Intl.DateTimeFormat("de-DE", {
    timeZone: tz,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(d);
}

function fmtTime(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("de-DE", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(d);
}

export function describeEvent(e: CalEvent, tz: string): string {
  let when: string;
  if (e.allDay) {
    const lastDay = new Date(e.end.getTime() - 1);
    const a = fmt(e.start, tz, false);
    const b = fmt(lastDay, tz, false);
    when = a === b || e.end <= e.start ? `${a} (ganztägig)` : `${a} – ${b} (ganztägig)`;
  } else if (e.end.getTime() <= e.start.getTime()) {
    when = fmt(e.start, tz, true);
  } else {
    const sameDay = fmt(e.start, tz, false) === fmt(e.end, tz, false);
    when = sameDay ? `${fmt(e.start, tz, true)} – ${fmtTime(e.end, tz)}` : `${fmt(e.start, tz, true)} – ${fmt(e.end, tz, true)}`;
  }
  const lines = [`• ${e.summary || "(ohne Titel)"}`, `  Wann: ${when}`];
  if (e.location) lines.push(`  Ort: ${e.location}`);
  if (e.categories.length) lines.push(`  Kategorie: ${e.categories.join(", ")}`);
  if (e.description) {
    const desc = e.description.length > 500 ? e.description.slice(0, 500) + " …" : e.description;
    lines.push(`  Details: ${desc.replace(/\n+/g, " / ")}`);
  }
  if (e.url) lines.push(`  Link: ${e.url}`);
  return lines.join("\n");
}

export function formatResult(r: QueryResult, env: Env, title: string): string {
  const tz = env.DISPLAY_TZ || "Europe/Berlin";
  const range = `${fmt(r.from, tz, false)} bis ${fmt(new Date(r.to.getTime() - 1), tz, false)}`;
  if (r.events.length === 0) return `${title} (${range}): keine Einträge gefunden.`;
  const body = r.events.map((e) => describeEvent(e, tz)).join("\n\n");
  const more = r.truncated ? "\n\n(Liste gekürzt – Zeitraum einschränken oder limit erhöhen.)" : "";
  return `${title} (${range}, Zeitzone ${tz}) – ${r.events.length} ${r.events.length === 1 ? "Eintrag" : "Einträge"}:\n\n${body}${more}`;
}

export function toStructured(r: QueryResult) {
  return {
    from: r.from.toISOString(),
    to: r.to.toISOString(),
    truncated: r.truncated,
    events: r.events.map((e) => ({
      uid: e.uid,
      title: e.summary,
      start: e.start.toISOString(),
      end: e.end.toISOString(),
      allDay: e.allDay,
      location: e.location || undefined,
      description: e.description || undefined,
      url: e.url || undefined,
      categories: e.categories.length ? e.categories : undefined,
    })),
  };
}
