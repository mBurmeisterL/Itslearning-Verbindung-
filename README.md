# itslearning-Kalender als MCP-Server für Claude

Ein kleiner [MCP](https://modelcontextprotocol.io)-Server, der auf **Cloudflare Workers** läuft. Er ruft deinen
persönlichen **itslearning-Kalenderfeed** (iCal) ab und gibt Claude deine Termine und Abgaben.
In Claude bindest du ihn als **benutzerdefinierten Connector** ein.

- Er liest nur: Der Server ruft den Feed ab und ändert nichts in itslearning.
- Er braucht keine Datenbank und keine Sessions. Der Feed wird 5 Minuten im Speicher gehalten.
- Er hat keine Laufzeit-Abhängigkeiten: iCal-Parser und MCP-Protokoll sind selbst geschrieben (`src/`).

## Tools für Claude

| Tool | Zweck | Standard |
|---|---|---|
| `list_events` | Alle Termine (Stundenplan, Events, Abgaben) in einem Zeitraum | heute + 7 Tage |
| `list_assignments` | Nur Abgaben, Aufgaben, Tests und Fristen | heute + 14 Tage |
| `search_events` | Sucht nach Stichworten, z. B. „Mathe Klausur“ | 30 Tage zurück bis 180 Tage voraus |

Datumsangaben gehen als `2026-10-20`, `20.10.2026`, als ISO-Zeitpunkt oder als `heute`, `morgen` oder `übermorgen`.

Beispiele in Claude:
- *„Welche Abgaben habe ich diese Woche?“*
- *„Was steht morgen im Stundenplan?“*
- *„Wann ist die nächste Englisch-Klausur?“*

## Einrichtung

### 1. Kalenderlink aus itslearning holen

In itslearning öffnest du **Kalender**, dann **Abonnieren** oder **Kalender exportieren** (die Bezeichnung hängt von der
Version ab). Kopiere den Link, z. B. `https://<schule>.itslearning.com/Calendar/CalendarFeed.ashx?...&Guid=...`.

> ⚠️ Der Link ist wie ein Passwort. Jeder, der ihn kennt, kann deinen Kalender lesen.
> Trag ihn deshalb **nicht** in den Code ein, sondern nur als Secret (siehe unten).

### 2. Auf Cloudflare deployen

Du brauchst einen kostenlosen Cloudflare-Account und Node.js 20 oder neuer.

```bash
npm install
npx wrangler login

# Kalenderlink als Secret hinterlegen
npx wrangler secret put ICAL_URL

# Ein zufälliges Zugriffstoken erzeugen und hinterlegen
openssl rand -hex 24          # Ausgabe kopieren
npx wrangler secret put MCP_TOKEN

npm run deploy
```

Danach zeigt Wrangler die URL des Workers an, z. B. `https://itslearning-calendar-mcp.<dein-name>.workers.dev`.

### 3. In Claude als Connector hinzufügen

Gehe in Claude zu **Einstellungen → Connectors → Benutzerdefinierten Connector hinzufügen** und trage ein:

- **Name:** itslearning Kalender
- **URL:** `https://itslearning-calendar-mcp.<dein-name>.workers.dev/mcp/<MCP_TOKEN>`

Das Token steht im Pfad, weil der Connector nur eine URL kennt. Behandle die vollständige URL also ebenfalls wie ein
Passwort. Andere MCP-Clients können das Token auch als Header `Authorization: Bearer <MCP_TOKEN>` an `/mcp` schicken.

Für Claude Code geht es so:

```bash
claude mcp add --transport http itslearning https://itslearning-calendar-mcp.<dein-name>.workers.dev/mcp/<MCP_TOKEN>
```

## Konfiguration

| Name | Art | Bedeutung |
|---|---|---|
| `ICAL_URL` | Secret | itslearning-Kalenderlink. `webcal://` wird automatisch zu `https://`. |
| `MCP_TOKEN` | Secret | Zugriffstoken für den MCP-Endpunkt (Pflicht) |
| `DISPLAY_TZ` | Variable | Zeitzone für die Anzeige (Standard `Europe/Berlin`) |
| `CACHE_TTL_SECONDS` | Variable | Wie lange der Feed zwischengespeichert wird (Standard `300`) |
| `ASSIGNMENT_KEYWORDS` | Variable, optional | Regex, an der Abgaben erkannt werden. Standard: `abgabe\|aufgabe\|hausaufgabe\|einreich\|frist\|fällig\|deadline\|assignment\|due\|submission\|essay\|test\|prüfung\|klausur\|quiz` |

Variablen änderst du in `wrangler.jsonc`, Secrets mit `npx wrangler secret put <NAME>`.

## Lokal entwickeln

```bash
cp .dev.vars.example .dev.vars   # ICAL_URL und MCP_TOKEN eintragen
npm run dev                      # http://localhost:8787/mcp/<MCP_TOKEN>
npm test                         # Unit-Tests (Parser, Abfragen, MCP-Endpunkt)
npm run typecheck
```

Schnelltest mit curl:

```bash
curl -s -X POST http://localhost:8787/mcp/<MCP_TOKEN> -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_assignments","arguments":{}}}'
```

## Grenzen

- Ob ein Termin eine Abgabe ist, erkennt der Server an Schlüsselwörtern in Titel, Beschreibung, Kategorie und Link.
  Wenn deine Schule andere Begriffe nutzt, passe `ASSIGNMENT_KEYWORDS` an.
- Bei Wiederholungen (`RRULE`) versteht der Server `DAILY`, `WEEKLY` (mit `BYDAY`), `MONTHLY` und `YEARLY`
  (gleicher Tag), jeweils mit `INTERVAL`, `COUNT`, `UNTIL`, `EXDATE` und `RECURRENCE-ID`. Seltene Regeln wie
  „jeder 2. Montag im Monat“ werden vereinfacht. itslearning liefert Termine aber in der Regel einzeln.
- Der Server kann nur sehen, was im Kalenderfeed steht. Abgabestatus, Noten oder Dateien liefert itslearning
  dort nicht mit.
