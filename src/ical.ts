// Kleiner, abhängigkeitsfreier iCalendar-Parser (RFC 5545) für den itslearning-Kalenderfeed.
// Unterstützt: VEVENT, Zeitzonen (TZID), ganztägige Termine, DURATION,
// einfache Wiederholungen (RRULE DAILY/WEEKLY/MONTHLY/YEARLY), EXDATE, RECURRENCE-ID.

export interface CalEvent {
  uid: string;
  summary: string;
  description: string;
  location: string;
  url: string;
  categories: string[];
  status: string;
  start: Date;
  end: Date;
  allDay: boolean;
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

interface Fields {
  y: number;
  m: number; // 1-12
  d: number;
  h: number;
  mi: number;
  s: number;
}

interface DateValue {
  fields: Fields;
  kind: "date" | "utc" | "local";
  tz?: string;
}

interface RawEvent {
  props: Prop[];
}

// Windows-Zeitzonennamen, wie sie Microsoft-basierte Systeme (u. a. itslearning) teils ausgeben.
const WINDOWS_TZ: Record<string, string> = {
  "W. Europe Standard Time": "Europe/Berlin",
  "Central Europe Standard Time": "Europe/Budapest",
  "Romance Standard Time": "Europe/Paris",
  "Central European Standard Time": "Europe/Warsaw",
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "FLE Standard Time": "Europe/Helsinki",
  "E. Europe Standard Time": "Europe/Chisinau",
  "UTC": "UTC",
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago",
  "Pacific Standard Time": "America/Los_Angeles",
};

export function normalizeTz(tz: string | undefined, fallback: string): string {
  if (!tz) return fallback;
  const cleaned = tz.replace(/^"|"$/g, "").replace(/^\/+/, "");
  const mapped = WINDOWS_TZ[cleaned] ?? cleaned;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: mapped });
    return mapped;
  } catch {
    return fallback;
  }
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    dtfCache.set(tz, f);
  }
  return f;
}

/** Wandelt einen UTC-Zeitpunkt in Wanduhr-Felder der Zeitzone um. */
export function utcToZoned(ms: number, tz: string): Fields {
  const out: Record<string, number> = {};
  for (const p of partsFormatter(tz).formatToParts(new Date(ms))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return { y: out.year, m: out.month, d: out.day, h: out.hour % 24, mi: out.minute, s: out.second };
}

function fieldsToNaiveMs(f: Fields): number {
  return Date.UTC(f.y, f.m - 1, f.d, f.h, f.mi, f.s);
}

function naiveMsToFields(ms: number): Fields {
  const d = new Date(ms);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    s: d.getUTCSeconds(),
  };
}

/** Wandelt Wanduhr-Felder einer Zeitzone in einen UTC-Zeitpunkt (ms) um. */
export function zonedToUtc(f: Fields, tz: string): number {
  const naive = fieldsToNaiveMs(f);
  const offset = (t: number) => fieldsToNaiveMs(utcToZoned(t, tz)) - t;
  const o1 = offset(naive);
  let t = naive - o1;
  const o2 = offset(t);
  if (o2 !== o1) t = naive - o2;
  return t;
}

// ---------------------------------------------------------------------------
// Grundlegendes Parsen

function unfold(text: string): string[] {
  return text
    .replace(/^﻿/, "")
    .replace(/\r?\n[ \t]/g, "")
    .split(/\r?\n/)
    .filter((l) => l.length > 0);
}

function parseLine(line: string): Prop | null {
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ":" && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = head.match(/(?:[^;"]|"[^"]*")+/g) ?? [head];
  const name = parts[0].toUpperCase();
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name, params, value };
}

export function unescapeText(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

function parseDateValue(prop: Prop): DateValue | null {
  return parseDateString(prop.value.trim(), prop.params.VALUE === "DATE", prop.params.TZID);
}

function parseDateString(v: string, forceDate: boolean, tz?: string): DateValue | null {
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const fields: Fields = {
    y: +m[1],
    m: +m[2],
    d: +m[3],
    h: m[4] ? +m[4] : 0,
    mi: m[5] ? +m[5] : 0,
    s: m[6] ? +m[6] : 0,
  };
  if (forceDate || !m[4]) return { fields: { ...fields, h: 0, mi: 0, s: 0 }, kind: "date" };
  if (m[7]) return { fields, kind: "utc" };
  return { fields, kind: "local", tz };
}

function dateValueToMs(dv: DateValue, defaultTz: string): number {
  if (dv.kind === "utc") return fieldsToNaiveMs(dv.fields);
  const tz = dv.kind === "local" ? normalizeTz(dv.tz, defaultTz) : defaultTz;
  return zonedToUtc(dv.fields, tz);
}

function parseDuration(v: string): number | null {
  const m = v.trim().match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const [w, d, h, mi, s] = [m[2], m[3], m[4], m[5], m[6]].map((x) => (x ? +x : 0));
  return sign * ((((w * 7 + d) * 24 + h) * 60 + mi) * 60 + s) * 1000;
}

function parseRaw(text: string): RawEvent[] {
  const events: RawEvent[] = [];
  const stack: string[] = [];
  let current: RawEvent | null = null;
  for (const line of unfold(text)) {
    const prop = parseLine(line);
    if (!prop) continue;
    if (prop.name === "BEGIN") {
      const comp = prop.value.trim().toUpperCase();
      stack.push(comp);
      if (comp === "VEVENT") current = { props: [] };
      continue;
    }
    if (prop.name === "END") {
      const comp = stack.pop();
      if (comp === "VEVENT" && current) {
        events.push(current);
        current = null;
      }
      continue;
    }
    if (current && stack[stack.length - 1] === "VEVENT") current.props.push(prop);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Wiederholungen

interface RRule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count?: number;
  until?: number; // UTC ms
  byday?: number[]; // 0 = Montag … 6 = Sonntag
}

const DAY_INDEX: Record<string, number> = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 };

function parseRRule(v: string, defaultTz: string, startKind: DateValue["kind"], startTz?: string): RRule | null {
  const parts: Record<string, string> = {};
  for (const kv of v.split(";")) {
    const [k, val] = kv.split("=");
    if (k && val) parts[k.toUpperCase()] = val.toUpperCase();
  }
  const freq = parts.FREQ as RRule["freq"];
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) return null;
  const rule: RRule = { freq, interval: Math.max(1, Number(parts.INTERVAL ?? 1) || 1) };
  if (parts.COUNT) rule.count = Number(parts.COUNT);
  if (parts.UNTIL) {
    const dv = parseDateString(parts.UNTIL, false, startKind === "local" ? startTz : undefined);
    if (dv) {
      rule.until = dateValueToMs(dv, defaultTz);
      if (dv.kind === "date") rule.until += 86_400_000 - 1; // UNTIL-Datum ist inklusive
    }
  }
  if (parts.BYDAY) {
    const days = parts.BYDAY.split(",")
      .map((d) => DAY_INDEX[d.replace(/^[+-]?\d+/, "")])
      .filter((d) => d !== undefined);
    if (days.length) rule.byday = [...new Set(days)].sort((a, b) => a - b);
  }
  return rule;
}

/** Liefert die Wanduhr-Startzeiten (naive ms) der Wiederholungen in aufsteigender Reihenfolge. */
function* occurrences(start: Fields, rule: RRule): Generator<number> {
  const startNaive = fieldsToNaiveMs(start);
  const DAY = 86_400_000;
  const MAX = 5000;
  let emitted = 0;
  if (rule.freq === "DAILY") {
    for (let i = 0; emitted < MAX; i++) {
      const t = startNaive + i * rule.interval * DAY;
      if (rule.byday && !rule.byday.includes((new Date(t).getUTCDay() + 6) % 7)) continue;
      emitted++;
      yield t;
    }
  } else if (rule.freq === "WEEKLY") {
    const weekday = (new Date(startNaive).getUTCDay() + 6) % 7;
    const days = rule.byday ?? [weekday];
    const weekStart = startNaive - weekday * DAY;
    for (let w = 0; emitted < MAX; w++) {
      for (const d of days) {
        const t = weekStart + (w * rule.interval * 7 + d) * DAY;
        if (t < startNaive) continue;
        emitted++;
        yield t;
      }
    }
  } else {
    for (let i = 0; emitted < MAX && i < MAX; i++) {
      const y = rule.freq === "YEARLY" ? start.y + i * rule.interval : start.y;
      const mo = rule.freq === "MONTHLY" ? start.m - 1 + i * rule.interval : start.m - 1;
      const t = Date.UTC(y, mo, start.d, start.h, start.mi, start.s);
      if (new Date(t).getUTCDate() !== start.d) continue; // z. B. 31. Februar überspringen
      emitted++;
      yield t;
    }
  }
}

// ---------------------------------------------------------------------------
// Öffentliche API

/**
 * Parst einen iCal-Text und liefert alle Termine, die das Zeitfenster [rangeStart, rangeEnd) berühren,
 * mit expandierten Wiederholungen, sortiert nach Beginn.
 */
export function parseIcs(text: string, rangeStart: Date, rangeEnd: Date, defaultTz = "Europe/Berlin"): CalEvent[] {
  const raws = parseRaw(text);
  const from = rangeStart.getTime();
  const to = rangeEnd.getTime();
  const result: CalEvent[] = [];

  // Überschriebene Einzeltermine (RECURRENCE-ID) einsammeln, damit sie die Serie ersetzen.
  const overridden = new Map<string, Set<number>>();
  for (const raw of raws) {
    const uid = raw.props.find((p) => p.name === "UID")?.value ?? "";
    const rid = raw.props.find((p) => p.name === "RECURRENCE-ID");
    const dv = rid && parseDateValue(rid);
    if (dv) {
      if (!overridden.has(uid)) overridden.set(uid, new Set());
      overridden.get(uid)!.add(dateValueToMs(dv, defaultTz));
    }
  }

  for (const raw of raws) {
    const get = (n: string) => raw.props.find((p) => p.name === n);
    const dtstartProp = get("DTSTART");
    const start = dtstartProp && parseDateValue(dtstartProp);
    if (!start) continue;

    const allDay = start.kind === "date";
    const startMs = dateValueToMs(start, defaultTz);
    let durationMs: number;
    const dtendProp = get("DTEND") ?? get("DUE");
    const endDv = dtendProp && parseDateValue(dtendProp);
    const durProp = get("DURATION");
    if (endDv) durationMs = dateValueToMs(endDv, defaultTz) - startMs;
    else if (durProp && parseDuration(durProp.value) !== null) durationMs = parseDuration(durProp.value)!;
    else durationMs = allDay ? 86_400_000 : 0;
    if (durationMs < 0) durationMs = 0;

    const uid = get("UID")?.value ?? "";
    const base = {
      uid,
      summary: unescapeText(get("SUMMARY")?.value ?? "").trim(),
      description: unescapeText(get("DESCRIPTION")?.value ?? "").trim(),
      location: unescapeText(get("LOCATION")?.value ?? "").trim(),
      url: (get("URL")?.value ?? "").trim(),
      categories: raw.props
        .filter((p) => p.name === "CATEGORIES")
        .flatMap((p) => p.value.split(/(?<!\\),/).map((c) => unescapeText(c).trim()))
        .filter(Boolean),
      status: (get("STATUS")?.value ?? "").trim().toUpperCase(),
      allDay,
    };

    const push = (s: number) => {
      const e = s + durationMs;
      const effectiveEnd = e > s ? e : s + 1; // Zeitpunkt-Termine (z. B. Abgabefristen) nicht verlieren
      if (s < to && effectiveEnd > from) result.push({ ...base, start: new Date(s), end: new Date(e) });
    };

    const rruleProp = get("RRULE");
    const isOverride = !!get("RECURRENCE-ID");
    const rule = rruleProp && !isOverride ? parseRRule(rruleProp.value, defaultTz, start.kind, start.tz) : null;
    if (!rule) {
      push(startMs);
      continue;
    }

    const exdates = new Set<number>(overridden.get(uid) ?? []);
    for (const p of raw.props.filter((p) => p.name === "EXDATE")) {
      for (const v of p.value.split(",")) {
        const dv = parseDateString(v.trim(), p.params.VALUE === "DATE", p.params.TZID ?? start.tz);
        if (dv) exdates.add(dateValueToMs(dv, defaultTz));
      }
    }

    const tz = start.kind === "local" ? normalizeTz(start.tz, defaultTz) : start.kind === "date" ? defaultTz : "UTC";
    let n = 0;
    for (const naive of occurrences(start.fields, rule)) {
      const occ = start.kind === "utc" ? naive : zonedToUtc(naiveMsToFields(naive), tz);
      if (rule.until !== undefined && occ > rule.until) break;
      if (rule.count !== undefined && n >= rule.count) break;
      n++;
      if (occ >= to) break;
      if (!exdates.has(occ)) push(occ);
    }
  }

  result.sort((a, b) => a.start.getTime() - b.start.getTime() || a.summary.localeCompare(b.summary));
  return result;
}
