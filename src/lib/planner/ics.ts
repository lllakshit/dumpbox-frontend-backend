/**
 * iCalendar (.ics) reading and writing for events (VEVENT) and tasks (VTODO).
 * Reads what Google Calendar, Outlook and Apple Calendar export: DTSTART/DTEND with TZID, UTC or floating times,
 * all-day dates, DURATION, RRULE, EXDATE, VALARM triggers, UID.
 */
import { parseRule, formatRule, timeKey } from "./recurrence"
import { addDays, fromWall, isTimeZone, isWallDate } from "./time"
import type { Entry } from "./types"
import type { EntryDraft } from "./importers"

type Prop = { name: string; params: Record<string, string>; value: string }

function unfold(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n").filter(Boolean)
}

function parseLine(line: string): Prop | null {
  const colon = (() => {
    let inQuote = false
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') inQuote = !inQuote
      else if (line[i] === ":" && !inQuote) return i
    }
    return -1
  })()
  if (colon < 0) return null
  const head = line.slice(0, colon)
  const value = line.slice(colon + 1)
  const [name, ...ps] = head.split(";")
  const params: Record<string, string> = {}
  for (const p of ps) {
    const eq = p.indexOf("=")
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "")
  }
  return { name: name.toUpperCase(), params, value }
}

function unescape(v: string) {
  return v.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\")
}
function escape(v: string) {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;")
}

type IcsTime = { allDay: true; date: string } | { allDay: false; instant: Date; tz: string | null }

function parseTime(p: Prop, defaultTz: string): IcsTime | null {
  const v = p.value.trim()
  if (p.params.VALUE === "DATE" || /^\d{8}$/.test(v)) {
    const d = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`
    return isWallDate(d) ? { allDay: true, date: d } : null
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v)
  if (!m) return null
  const date = `${m[1]}-${m[2]}-${m[3]}`
  const time = `${m[4]}:${m[5]}`
  if (!isWallDate(date)) return null
  if (m[7]) return { allDay: false, instant: new Date(`${date}T${time}:${m[6] ?? "00"}Z`), tz: null }
  const tzid = p.params.TZID && isTimeZone(p.params.TZID) ? p.params.TZID : defaultTz
  return { allDay: false, instant: fromWall(date, time, tzid), tz: tzid }
}

/** "-PT15M", "-P1D", "PT0S", "-P1DT2H" → minutes before (positive), or null for triggers after the start. */
function triggerMinutes(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim())
  if (!m) return null
  const mins = Number(m[2] ?? 0) * 10080 + Number(m[3] ?? 0) * 1440 + Number(m[4] ?? 0) * 60 + Number(m[5] ?? 0)
  if (m[1] !== "-" && mins > 0) return null
  return mins
}

function durationMs(v: string): number | null {
  const m = /^\+?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim())
  if (!m) return null
  return ((Number(m[1] ?? 0) * 7 + Number(m[2] ?? 0)) * 1440 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0)) * 60_000 + Number(m[5] ?? 0) * 1000
}

/** Reads a .ics file into entry drafts. Unknown or broken components are reported, not fatal. */
export function parseIcs(text: string, defaultTz: string): { drafts: EntryDraft[]; errors: string[] } {
  const drafts: EntryDraft[] = []
  const errors: string[] = []
  let cur: Prop[] | null = null
  let kind: "event" | "task" | null = null
  let alarm: Prop[] | null = null
  let alarms: number[] = []
  let calName: string | null = null
  let n = 0
  for (const line of unfold(text)) {
    const p = parseLine(line)
    if (!p) continue
    if (p.name === "X-WR-CALNAME" && !cur) calName = unescape(p.value)
    if (p.name === "BEGIN" && (p.value === "VEVENT" || p.value === "VTODO")) {
      cur = []
      kind = p.value === "VEVENT" ? "event" : "task"
      alarms = []
      continue
    }
    if (p.name === "BEGIN" && p.value === "VALARM" && cur) {
      alarm = []
      continue
    }
    if (p.name === "END" && p.value === "VALARM" && alarm) {
      const trig = alarm.find((a) => a.name === "TRIGGER")
      if (trig && trig.params.VALUE !== "DATE-TIME") {
        const mins = triggerMinutes(trig.value)
        if (mins !== null && mins <= 40320) alarms.push(mins)
      }
      alarm = null
      continue
    }
    if (alarm) {
      alarm.push(p)
      continue
    }
    if (p.name === "END" && (p.value === "VEVENT" || p.value === "VTODO") && cur && kind) {
      n++
      const get = (name: string) => cur!.find((x) => x.name === name)
      const summary = get("SUMMARY")
      const title = summary ? unescape(summary.value).trim() : ""
      const ds = get("DTSTART") ?? (kind === "task" ? get("DUE") : undefined)
      const start = ds ? parseTime(ds, defaultTz) : null
      if (kind === "event" && !start) {
        errors.push(`Event ${n}${title ? ` “${title}”` : ""}: no start time`)
        cur = null
        continue
      }
      const draft: EntryDraft = {
        kind,
        title: title || "(No title)",
        notes: get("DESCRIPTION") ? unescape(get("DESCRIPTION")!.value) : null,
        location: get("LOCATION") ? unescape(get("LOCATION")!.value) : null,
        external_id: get("UID")?.value.slice(0, 500) ?? null,
        reminders: [...new Set(alarms)].slice(0, 5),
        list_name: calName,
      }
      if (start?.allDay) {
        draft.all_day = true
        draft.start_date = start.date
        const de = get("DTEND")
        const end = de ? parseTime(de, defaultTz) : null
        // DTEND is exclusive for dates.
        if (end?.allDay && end.date > start.date) draft.end_date = addDays(end.date, -1)
      } else if (start && !start.allDay) {
        draft.all_day = false
        draft.start_at = start.instant.toISOString()
        draft.time_zone = start.tz ?? defaultTz
        const de = get("DTEND")
        const end = de ? parseTime(de, defaultTz) : null
        const dur = get("DURATION")
        if (end && !end.allDay) draft.end_at = end.instant.toISOString()
        else if (dur) {
          const ms = durationMs(dur.value)
          if (ms !== null) draft.end_at = new Date(start.instant.getTime() + ms).toISOString()
        }
      }
      const rr = get("RRULE")
      if (rr) {
        const rule = parseRule(rr.value)
        if (rule) draft.rrule = formatRule(rule)
        else errors.push(`“${draft.title}”: repeat rule not supported, imported as a single ${kind}`)
      }
      const ex: string[] = []
      for (const x of cur.filter((c) => c.name === "EXDATE")) {
        for (const v of x.value.split(",")) {
          const t = parseTime({ ...x, value: v }, defaultTz)
          if (t) ex.push(t.allDay ? t.date : timeKey(t.instant))
        }
      }
      if (ex.length) draft.exdates = ex.slice(0, 500)
      if (kind === "task") {
        const status = get("STATUS")?.value.toUpperCase()
        const completed = get("COMPLETED")
        if (status === "COMPLETED" || completed) draft.completed = true
      }
      drafts.push(draft)
      cur = null
      continue
    }
    if (cur) cur.push(p)
  }
  return { drafts, errors }
}

function icsDate(d: string) {
  return d.replaceAll("-", "")
}
function icsUtc(iso: string) {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")
}
function fold(line: string) {
  const out: string[] = []
  let rest = line
  while (rest.length > 74) {
    out.push(rest.slice(0, 74))
    rest = " " + rest.slice(74)
  }
  out.push(rest)
  return out.join("\r\n")
}

/** Writes entries as one .ics calendar. Times are written in UTC; repeat rules and reminders are kept. */
export function toIcs(entries: Entry[], calendarName = "DumpBox"): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//DumpBox//Planner//EN", "CALSCALE:GREGORIAN", `X-WR-CALNAME:${escape(calendarName)}`]
  const stamp = icsUtc(new Date().toISOString())
  for (const e of entries) {
    if (e.deleted_at) continue
    const comp = e.kind === "event" ? "VEVENT" : "VTODO"
    lines.push(`BEGIN:${comp}`, `UID:${e.external_id ?? `${e.id}@dumpbox`}`, `DTSTAMP:${stamp}`, `SUMMARY:${escape(e.title)}`)
    if (e.notes) lines.push(`DESCRIPTION:${escape(e.notes)}`)
    if (e.location) lines.push(`LOCATION:${escape(e.location)}`)
    if (e.all_day && e.start_date) {
      lines.push(`${e.kind === "event" ? "DTSTART" : "DUE"};VALUE=DATE:${icsDate(e.start_date)}`)
      if (e.kind === "event") lines.push(`DTEND;VALUE=DATE:${icsDate(addDays(e.end_date ?? e.start_date, 1))}`)
    } else if (e.start_at) {
      lines.push(`${e.kind === "event" ? "DTSTART" : "DUE"}:${icsUtc(e.start_at)}`)
      if (e.end_at && e.kind === "event") lines.push(`DTEND:${icsUtc(e.end_at)}`)
    }
    if (e.rrule) lines.push(`RRULE:${e.rrule}`)
    for (const x of e.exdates ?? []) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(x)) lines.push(`EXDATE;VALUE=DATE:${icsDate(x)}`)
      else lines.push(`EXDATE:${icsUtc(x)}`)
    }
    if (e.kind === "task") {
      lines.push(`STATUS:${e.completed_at ? "COMPLETED" : "NEEDS-ACTION"}`)
      if (e.completed_at) lines.push(`COMPLETED:${icsUtc(e.completed_at)}`)
    }
    for (const r of e.reminders ?? []) {
      lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escape(e.title)}`, `TRIGGER:${r === 0 ? "PT0S" : `-PT${r}M`}`, "END:VALARM")
    }
    lines.push(`END:${comp}`)
  }
  lines.push("END:VCALENDAR")
  return lines.map(fold).join("\r\n") + "\r\n"
}
