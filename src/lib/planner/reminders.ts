/** When each reminder fires. Same rules as the phone app (lib/src/planner/reminders.dart). */
import { occurrences, type Occurrence } from "./recurrence"
import { addDays, fromWall, toWall } from "./time"
import type { Entry } from "./types"

export type DueReminder = {
  /** Unique per entry + occurrence + reminder, for "already shown" bookkeeping. */
  id: string
  entry: Entry
  occurrence: Occurrence
  minutes: number
  at: Date
}

/**
 * Reminders that fire in [from, to]. Timed entries: start − minutes. All-day / date-only entries: `allDayTime`
 * on the day − minutes. Completed tasks and binned entries never remind.
 */
export function remindersBetween(entries: Iterable<Entry>, from: Date, to: Date, tz: string, allDayTime = "09:00"): DueReminder[] {
  const out: DueReminder[] = []
  const fromDate = toWall(from, tz).date
  // Look ahead far enough to catch "1 week before" reminders.
  const toDate = addDays(toWall(to, tz).date, 29)
  for (const e of entries) {
    if (e.deleted_at || e.completed_at || !e.reminders?.length) continue
    for (const occ of occurrences(e, addDays(fromDate, -1), toDate, tz, 400)) {
      const base = occ.allDay ? fromWall(occ.startDate, allDayTime, tz) : occ.start
      for (const m of e.reminders) {
        const at = new Date(base.getTime() - m * 60_000)
        if (at >= from && at <= to) out.push({ id: `${e.id}|${occ.key}|${m}`, entry: e, occurrence: occ, minutes: m, at })
      }
    }
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime())
}

/** "Starts in 15 min · 10:00–11:00 · Clinic" */
export function reminderBody(r: DueReminder, tz: string): string {
  const parts: string[] = []
  if (r.occurrence.allDay) parts.push(r.minutes >= 1440 ? `${toWall(r.occurrence.start, tz).date}` : "Today")
  else {
    const s = toWall(r.occurrence.start, tz).time
    const e = r.entry.end_at ? toWall(r.occurrence.end, tz).time : null
    parts.push(r.minutes === 0 ? `Now · ${s}${e ? `–${e}` : ""}` : `In ${r.minutes >= 60 ? `${Math.round(r.minutes / 6) / 10} h` : `${r.minutes} min`} · ${s}${e ? `–${e}` : ""}`)
  }
  if (r.entry.location) parts.push(r.entry.location)
  return parts.join(" · ")
}
