/** Turns a parsed quick-add line into the fields of a create request. Shared by the server and the web app. */
import type { ParsedEntry } from "./parse"
import { fromWall } from "./time"

export type ResolvedEntry = {
  kind: "event" | "task"
  title: string
  all_day: boolean
  start_at: string | null
  end_at: string | null
  start_date: string | null
  end_date: string | null
  time_zone: string
  rrule: string | null
  reminders: number[] | null
  location: string | null
  starred: boolean
  list_name: string | null
}

export function resolveParsed(p: ParsedEntry, opts: { tz: string; kind: "event" | "task"; defaultEventMinutes: number; defaultDate?: string }): ResolvedEntry {
  const kind = p.kind ?? opts.kind
  const date = p.date ?? (kind === "event" ? (opts.defaultDate ?? null) : null)
  const out: ResolvedEntry = {
    kind,
    title: p.title,
    all_day: false,
    start_at: null,
    end_at: null,
    start_date: null,
    end_date: null,
    time_zone: opts.tz,
    rrule: p.rrule,
    reminders: p.reminders,
    location: p.location,
    starred: p.starred,
    list_name: p.list,
  }
  if (date && p.time) {
    const s = fromWall(date, p.time, opts.tz)
    out.start_at = s.toISOString()
    if (p.endTime) out.end_at = fromWall(p.endDate ?? date, p.endTime, opts.tz).toISOString()
    else if (kind === "event") out.end_at = new Date(s.getTime() + opts.defaultEventMinutes * 60_000).toISOString()
  } else if (date) {
    out.all_day = true
    out.start_date = date
    out.end_date = p.endDate && p.endDate > date ? p.endDate : null
  }
  return out
}
