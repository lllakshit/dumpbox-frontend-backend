/**
 * Import: turns a JSON document, an .ics file or plain text lines into entry drafts.
 *
 * JSON shapes understood (an array, or an object holding the array under events / tasks / entries / items):
 *  - DumpBox export ({ format: "dumpbox-planner", entries: [...] }) and API entry objects
 *  - Google Calendar API events (summary, start.dateTime | start.date, end, recurrence, reminders.overrides)
 *  - Google Tasks API tasks (title, notes, due, status)
 *  - Simple objects: { "title": "Dentist", "date": "2026-12-01", "time": "10:00", "end_time": "11:00",
 *      "type": "event" | "task", "repeat": "weekly", "remind": "15m", "location": "...", "notes": "...",
 *      "list": "Work", "done": false }
 *    Also start / end as ISO date-times, "due", "duration" (minutes or "1h"), "all_day".
 * Plain text: one entry per line, read like quick add ("Dentist tomorrow 5pm").
 */
import { parseIcs } from "./ics"
import { parseQuickAdd } from "./parse"
import { formatRule, parseRule, type Rule } from "./recurrence"
import { addDays, fromWall, isTimeZone, isWallDate, minutesOf, timeFromMinutes, toWall } from "./time"

export type EntryDraft = {
  id?: string
  kind: "event" | "task"
  title: string
  notes?: string | null
  location?: string | null
  all_day?: boolean
  start_at?: string | null
  end_at?: string | null
  start_date?: string | null
  end_date?: string | null
  time_zone?: string | null
  rrule?: string | null
  exdates?: string[]
  reminders?: number[]
  color?: string | null
  completed?: boolean
  starred?: boolean
  external_id?: string | null
  /** Calendar or task list by name; created when missing. */
  list_name?: string | null
  list_id?: string | null
}

export type ImportResult = { format: string; drafts: EntryDraft[]; errors: string[] }

type Ctx = { tz: string; now: Date; defaultKind: "event" | "task"; defaultEventMinutes: number }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_DT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/

function str(v: unknown, max = 1000): string | null {
  if (typeof v === "number") return String(v)
  if (typeof v !== "string") return null
  const s = v.trim()
  return s ? s.slice(0, max) : null
}

function pick(o: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k]
    const hit = Object.keys(o).find((x) => x.toLowerCase().replace(/[\s_-]/g, "") === k.toLowerCase().replace(/[\s_-]/g, ""))
    if (hit && o[hit] !== undefined && o[hit] !== null && o[hit] !== "") return o[hit]
  }
  return undefined
}

/** "15", 15, "15m", "1h", "1 day" → minutes. */
function minutesValue(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v)
  const s = str(v)
  if (!s) return null
  const m = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hrs?|hours?|d|days?|w|weeks?)?(?:\s+before)?$/i.exec(s)
  if (!m) return null
  const n = Number(m[1])
  const u = (m[2] ?? "m").toLowerCase()
  return Math.round(u.startsWith("h") ? n * 60 : u.startsWith("d") ? n * 1440 : u.startsWith("w") ? n * 10080 : n)
}

function remindersValue(v: unknown): number[] | undefined {
  if (v === undefined) return undefined
  if (v === false || v === null) return []
  const list = Array.isArray(v) ? v : [v]
  const out = list
    .map((x) => (typeof x === "object" && x ? minutesValue((x as Record<string, unknown>).minutes) : minutesValue(x)))
    .filter((x): x is number => x !== null && x >= 0 && x <= 40320)
  return [...new Set(out)].slice(0, 5)
}

/** "daily", "every week", "weekly on mon,wed", "monthly", "yearly", "weekdays" or an RRULE. */
function repeatValue(v: unknown): string | null | undefined {
  if (v === undefined) return undefined
  if (Array.isArray(v)) {
    const r = v.map(String).find((x) => /^RRULE:/i.test(x))
    return r ? (parseRule(r) ? formatRule(parseRule(r)!) : null) : null
  }
  const s = str(v, 500)
  if (!s || /^(none|never|no|false)$/i.test(s)) return null
  if (/FREQ=/i.test(s)) {
    const r = parseRule(s)
    return r ? formatRule(r) : null
  }
  const w = s.toLowerCase()
  let rule: Rule | null = null
  if (/weekday/.test(w)) rule = { freq: "WEEKLY", interval: 1, byday: [1, 2, 3, 4, 5].map((wd) => ({ wd })) }
  else if (/day|daily/.test(w)) rule = { freq: "DAILY", interval: 1 }
  else if (/week/.test(w)) rule = { freq: "WEEKLY", interval: 1 }
  else if (/month/.test(w)) rule = { freq: "MONTHLY", interval: 1 }
  else if (/year|annual/.test(w)) rule = { freq: "YEARLY", interval: 1 }
  if (!rule) return null
  const every = /every\s+(\d+)/.exec(w)
  if (every) rule.interval = Math.max(1, Math.min(999, Number(every[1])))
  if (rule.freq === "WEEKLY") {
    const days = ["su", "mo", "tu", "we", "th", "fr", "sa"].map((d, i) => (new RegExp(`\\b${d}`).test(w.replace(/^.*?\bon\b/, "")) && /\bon\b/.test(w) ? i : -1)).filter((i) => i >= 0)
    if (days.length) rule.byday = days.map((wd) => ({ wd }))
  }
  return formatRule(rule)
}

function boolValue(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v
  if (typeof v === "number") return v !== 0
  const s = str(v)?.toLowerCase()
  if (!s) return undefined
  if (["true", "yes", "y", "1", "done", "completed", "complete"].includes(s)) return true
  if (["false", "no", "n", "0", "needsaction", "needs-action", "open", "todo", "pending"].includes(s)) return false
  return undefined
}

/** A date or date-time value: "2026-12-01", "2026-12-01T10:00", "2026-12-01T10:00:00+05:30", "01/12/2026". */
function whenValue(v: unknown, ctx: Ctx): { date: string } | { instant: Date; tz: string } | null {
  const s = str(v)
  if (!s) return null
  if (isWallDate(s)) return { date: s }
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s)
  if (dmy) {
    const d = `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`
    return isWallDate(d) ? { date: d } : null
  }
  if (ISO_DT.test(s)) {
    const norm = s.replace(" ", "T")
    if (/(Z|[+-]\d{2}:?\d{2})$/.test(norm)) {
      const d = new Date(norm)
      return Number.isNaN(d.getTime()) ? null : { instant: d, tz: ctx.tz }
    }
    const date = norm.slice(0, 10)
    const time = norm.slice(11, 16)
    if (!isWallDate(date)) return null
    return { instant: fromWall(date, time, ctx.tz), tz: ctx.tz }
  }
  return null
}

function timeValue(v: unknown): string | null {
  const s = str(v)?.toLowerCase()
  if (!s) return null
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/.exec(s)
  if (!m) return null
  let h = Number(m[1])
  const mi = Number(m[2] ?? 0)
  if (m[3]) {
    if (h < 1 || h > 12) return null
    h = m[3] === "am" ? (h === 12 ? 0 : h) : h === 12 ? 12 : h + 12
  }
  if (h > 23 || mi > 59) return null
  return timeFromMinutes(h * 60 + mi)
}

function fromObject(o: Record<string, unknown>, ctx: Ctx): EntryDraft | string {
  // Google Calendar API event
  if (o.summary !== undefined || (typeof o.start === "object" && o.start !== null)) {
    const title = str(o.summary) ?? str(o.title) ?? "(No title)"
    const st = (o.start ?? {}) as Record<string, unknown>
    const en = (o.end ?? {}) as Record<string, unknown>
    const tz = isTimeZone(st.timeZone) ? (st.timeZone as string) : ctx.tz
    const d: EntryDraft = {
      kind: "event",
      title,
      notes: str(o.description, 50000),
      location: str(o.location),
      external_id: str(o.iCalUID, 500) ?? str(o.id, 500),
      rrule: repeatValue(o.recurrence) ?? null,
      color: null,
    }
    const rem = o.reminders as { useDefault?: boolean; overrides?: { minutes: number }[] } | undefined
    if (rem?.overrides) d.reminders = remindersValue(rem.overrides)
    if (st.date && isWallDate(st.date)) {
      d.all_day = true
      d.start_date = st.date as string
      if (en.date && isWallDate(en.date) && addDays(en.date as string, -1) > d.start_date) d.end_date = addDays(en.date as string, -1)
    } else {
      const s = whenValue(st.dateTime, { ...ctx, tz })
      if (!s || !("instant" in s)) return `“${title}”: no start time`
      d.start_at = s.instant.toISOString()
      d.time_zone = tz
      const e = whenValue(en.dateTime, { ...ctx, tz })
      if (e && "instant" in e && e.instant >= s.instant) d.end_at = e.instant.toISOString()
    }
    if (o.status === "cancelled") return `“${title}”: cancelled, skipped`
    return d
  }

  const title = str(pick(o, "title", "name", "subject", "task", "event", "text", "summary"))
  if (!title) return "no title"
  const kindRaw = str(pick(o, "kind", "type", "category"))?.toLowerCase()
  let kind: "event" | "task" = kindRaw?.includes("task") || kindRaw === "todo" || kindRaw === "to-do" ? "task" : kindRaw?.includes("event") ? "event" : ctx.defaultKind
  if (!kindRaw && (o.due !== undefined || o.status !== undefined || o.completed !== undefined || o.done !== undefined)) kind = "task"

  const d: EntryDraft = {
    kind,
    title,
    notes: str(pick(o, "notes", "description", "details", "body", "note"), 50000),
    location: str(pick(o, "location", "place", "venue", "where")),
    external_id: str(pick(o, "external_id", "uid", "ical_uid"), 500),
    rrule: repeatValue(pick(o, "rrule", "repeat", "recurrence", "recurring", "repeats")) ?? null,
    reminders: remindersValue(pick(o, "reminders", "reminder", "remind", "alert", "alerts", "notify")),
    starred: boolValue(pick(o, "starred", "important", "star", "priority")),
    completed: boolValue(pick(o, "completed", "done", "status", "complete", "is_done")),
    list_name: str(pick(o, "list", "calendar", "list_name", "calendar_name", "project"), 80),
    color: typeof o.color === "string" && /^#[0-9a-fA-F]{6}$/.test(o.color) ? o.color : null,
  }
  if (typeof o.id === "string" && UUID.test(o.id)) d.id = o.id
  if (!d.external_id && typeof o.id === "string" && !UUID.test(o.id)) d.external_id = o.id.slice(0, 500)
  if (typeof o.completed_at === "string") d.completed = true
  if (typeof o.time_zone === "string" && isTimeZone(o.time_zone)) ctx = { ...ctx, tz: o.time_zone }

  // DumpBox API shape
  if (o.start_at !== undefined || o.start_date !== undefined) {
    const allDay = Boolean(o.all_day)
    if (allDay || (o.start_date && !o.start_at)) {
      if (o.start_date && !isWallDate(o.start_date)) return `“${title}”: bad start_date`
      d.all_day = true
      d.start_date = (o.start_date as string) ?? null
      d.end_date = isWallDate(o.end_date) ? (o.end_date as string) : null
    } else {
      const s = whenValue(o.start_at, ctx)
      if (!s || !("instant" in s)) return `“${title}”: bad start_at`
      d.start_at = s.instant.toISOString()
      const e = whenValue(o.end_at, ctx)
      if (e && "instant" in e) d.end_at = e.instant.toISOString()
      d.time_zone = ctx.tz
    }
    if (Array.isArray(o.exdates)) d.exdates = o.exdates.filter((x): x is string => typeof x === "string").slice(0, 500)
    if (kind === "event" && !d.start_at && !d.start_date) return `“${title}”: an event needs a date`
    return d
  }

  const startRaw = pick(o, "start", "starts", "starttime_iso", "begin", "datetime", "when", "due", "deadline", "date", "day", "on")
  const start = whenValue(startRaw, ctx)
  const timeRaw = pick(o, "time", "at", "from", "start_time")
  const endRaw = pick(o, "end", "ends", "end_time", "endtime", "until", "to", "end_date")
  const allDay = boolValue(pick(o, "all_day", "allday", "whole_day"))
  const durMin = minutesValue(pick(o, "duration", "length", "minutes"))

  if (!start) {
    if (startRaw !== undefined) return `“${title}”: could not read the date “${String(startRaw)}”`
    if (kind === "event") return `“${title}”: an event needs a date`
    return d
  }
  if ("date" in start) {
    const t = timeValue(timeRaw)
    if (t && allDay !== true) {
      const s = fromWall(start.date, t, ctx.tz)
      d.all_day = false
      d.start_at = s.toISOString()
      d.time_zone = ctx.tz
      const et = timeValue(endRaw)
      const ew = whenValue(endRaw, ctx)
      if (et) {
        const endDate = minutesOf(et) <= minutesOf(t) ? addDays(start.date, 1) : start.date
        d.end_at = fromWall(endDate, et, ctx.tz).toISOString()
      } else if (ew && "instant" in ew && ew.instant >= s) d.end_at = ew.instant.toISOString()
      else if (durMin) d.end_at = new Date(s.getTime() + durMin * 60_000).toISOString()
      else if (kind === "event") d.end_at = new Date(s.getTime() + ctx.defaultEventMinutes * 60_000).toISOString()
    } else {
      d.all_day = true
      d.start_date = start.date
      const ew = whenValue(endRaw, ctx)
      if (ew && "date" in ew && ew.date >= start.date) d.end_date = ew.date
    }
  } else {
    if (allDay) {
      d.all_day = true
      d.start_date = toWall(start.instant, ctx.tz).date
    } else {
      d.all_day = false
      d.start_at = start.instant.toISOString()
      d.time_zone = ctx.tz
      const e = whenValue(endRaw, ctx)
      const et = timeValue(endRaw)
      if (e && "instant" in e && e.instant >= start.instant) d.end_at = e.instant.toISOString()
      else if (et) {
        const w = toWall(start.instant, ctx.tz)
        const endDate = minutesOf(et) <= minutesOf(w.time) ? addDays(w.date, 1) : w.date
        d.end_at = fromWall(endDate, et, ctx.tz).toISOString()
      } else if (durMin) d.end_at = new Date(start.instant.getTime() + durMin * 60_000).toISOString()
      else if (kind === "event") d.end_at = new Date(start.instant.getTime() + ctx.defaultEventMinutes * 60_000).toISOString()
    }
  }
  return d
}

/** Text lines read like quick add. */
function fromLines(text: string, ctx: Ctx): ImportResult {
  const now = toWall(ctx.now, ctx.tz)
  const drafts: EntryDraft[] = []
  const errors: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:[-*•]|\d+[.)])?\s*(?:\[[ x]\])?\s*/i, "").trim()
    if (!line) continue
    const done = /^\s*(?:[-*•]|\d+[.)])?\s*\[x\]/i.test(raw)
    const r = parseQuickAdd(line, now)
    const kind = r.kind ?? (r.time && (r.endTime || r.kind === "event") ? "event" : ctx.defaultKind)
    if (kind === "event" && !r.date) {
      errors.push(`“${line}”: no date found for an event`)
      continue
    }
    const d: EntryDraft = { kind, title: r.title, location: r.location, rrule: r.rrule, starred: r.starred, list_name: r.list, completed: done || undefined }
    if (r.reminders) d.reminders = r.reminders
    if (r.date && r.time) {
      const s = fromWall(r.date, r.time, ctx.tz)
      d.all_day = false
      d.start_at = s.toISOString()
      d.time_zone = ctx.tz
      if (r.endTime) d.end_at = fromWall(r.endDate ?? r.date, r.endTime, ctx.tz).toISOString()
      else if (kind === "event") d.end_at = new Date(s.getTime() + ctx.defaultEventMinutes * 60_000).toISOString()
    } else if (r.date) {
      d.all_day = true
      d.start_date = r.date
      if (r.endDate) d.end_date = r.endDate
    }
    drafts.push(d)
  }
  return { format: "text", drafts, errors }
}

function collect(doc: unknown): { list: unknown[]; format: string; listHint?: { kind: "event" | "task" } } {
  if (Array.isArray(doc)) return { list: doc, format: "json-array" }
  if (doc && typeof doc === "object") {
    const o = doc as Record<string, unknown>
    if (o.format === "dumpbox-planner" && Array.isArray(o.entries)) return { list: o.entries, format: "dumpbox" }
    const out: unknown[] = []
    let format = "json"
    if (Array.isArray(o.events)) out.push(...o.events.map((e) => (e && typeof e === "object" ? { kind: "event", ...(e as object) } : e)))
    if (Array.isArray(o.tasks)) out.push(...o.tasks.map((t) => (t && typeof t === "object" ? { kind: "task", ...(t as object) } : t)))
    if (Array.isArray(o.entries)) out.push(...o.entries)
    if (Array.isArray(o.items)) {
      format = o.kind === "calendar#events" ? "google-calendar" : o.kind === "tasks#tasks" ? "google-tasks" : "json"
      out.push(...o.items.map((t) => (o.kind === "tasks#tasks" && t && typeof t === "object" ? { kind: "task", ...(t as object) } : t)))
    }
    if (out.length || Array.isArray(o.events) || Array.isArray(o.tasks) || Array.isArray(o.entries) || Array.isArray(o.items)) return { list: out, format }
    return { list: [o], format: "json-object" }
  }
  return { list: [], format: "unknown" }
}

export const MAX_IMPORT = 2000

/** Reads any supported input. `input` is a parsed JSON value or raw text (JSON, .ics, or lines). */
export function readImport(input: unknown, opts: { tz: string; now?: Date; defaultKind?: "event" | "task"; defaultEventMinutes?: number }): ImportResult {
  const ctx: Ctx = { tz: opts.tz, now: opts.now ?? new Date(), defaultKind: opts.defaultKind ?? "event", defaultEventMinutes: opts.defaultEventMinutes ?? 60 }
  let doc = input
  if (typeof input === "string") {
    const t = input.replace(/^﻿/, "").trim()
    if (!t) return { format: "empty", drafts: [], errors: ["Nothing to import"] }
    if (/^BEGIN:VCALENDAR/i.test(t)) {
      const r = parseIcs(t, ctx.tz)
      return { format: "ics", drafts: r.drafts.slice(0, MAX_IMPORT), errors: r.drafts.length > MAX_IMPORT ? [...r.errors, `Only the first ${MAX_IMPORT} were read`] : r.errors }
    }
    if (/^[[{]/.test(t)) {
      try {
        doc = JSON.parse(t)
      } catch (e) {
        return { format: "json", drafts: [], errors: [`Not valid JSON: ${e instanceof Error ? e.message : "parse error"}`] }
      }
    } else return fromLines(t, ctx)
  }
  const { list, format } = collect(doc)
  const drafts: EntryDraft[] = []
  const errors: string[] = []
  list.slice(0, MAX_IMPORT).forEach((x, i) => {
    if (!x || typeof x !== "object" || Array.isArray(x)) {
      errors.push(`Entry ${i + 1}: not an object`)
      return
    }
    const r = fromObject(x as Record<string, unknown>, ctx)
    if (typeof r === "string") errors.push(`Entry ${i + 1}: ${r}`)
    else drafts.push(r)
  })
  if (list.length > MAX_IMPORT) errors.push(`Only the first ${MAX_IMPORT} entries were read`)
  if (!list.length) errors.push("No events or tasks found in the file")
  return { format, drafts, errors }
}
