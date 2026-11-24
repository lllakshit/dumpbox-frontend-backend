/**
 * Changing part of a repeating series ("this event", "this and following", "all events"). Pure functions shared by
 * the web editor; the phone has the same rules in lib/src/planner/series.dart.
 *
 * Occurrence dates are always taken in the ENTRY's zone (the zone its rule repeats in), never the viewer's: a
 * New York 10:00 event seen from India is still cut and moved by its New York date.
 */
import { formatRule, parseRule, ruleDates } from "./recurrence"
import { addDays, diffDays, toWall } from "./time"
import type { Entry } from "./types"

/** The series' first date in its own zone. */
export function seriesStart(e: Pick<Entry, "start_date" | "start_at" | "time_zone">, viewerTz: string): string | null {
  if (e.start_date) return e.start_date
  if (e.start_at) return toWall(new Date(e.start_at), e.time_zone || viewerTz).date
  return null
}

/** An occurrence's date in the entry's zone. `occStart` is the occurrence instant; `key` its all-day date. */
export function occurrenceDate(e: Pick<Entry, "all_day" | "start_date" | "time_zone">, occ: { key: string; start: string }, viewerTz: string): string {
  if (e.all_day || e.start_date) return occ.key
  return toWall(new Date(occ.start), e.time_zone || viewerTz).date
}

/**
 * "This and following": the old series ends the day before `splitDate`; the new one carries on with the remaining
 * COUNT (if any) and the skipped dates that fall after the split. `oldRule` null means the split is at the first
 * occurrence, so the old series goes away entirely.
 */
export function splitSeries(e: Pick<Entry, "rrule" | "exdates" | "start_date" | "start_at" | "time_zone">, splitDate: string, newRuleRaw: string | null, viewerTz: string) {
  const rule = parseRule(e.rrule)
  const first = seriesStart(e, viewerTz)
  if (!rule || !first) return { oldRule: null, oldExdates: e.exdates ?? [], newRule: newRuleRaw, newExdates: [] as string[] }
  const before = splitDate > first ? ruleDates(first, rule, addDays(splitDate, -1), 1_000_000).length : 0
  const oldRule = before === 0 ? null : formatRule({ ...rule, count: undefined, until: addDays(splitDate, -1) })
  let newRule = newRuleRaw
  const nr = parseRule(newRuleRaw)
  if (nr && rule.count && nr.count === rule.count) {
    // Same rule as before: only what is left of "10 times" carries on.
    const left = rule.count - before
    newRule = left > 0 ? formatRule({ ...nr, count: left }) : null
  }
  const isAfter = (k: string) => (k.length === 10 ? k >= splitDate : toWall(new Date(k.replace(/Z$/, ":00Z")), e.time_zone || viewerTz).date >= splitDate)
  const ex = e.exdates ?? []
  return { oldRule, oldExdates: ex.filter((k) => !isAfter(k)), newRule, newExdates: ex.filter(isAfter) }
}

/** "All events" moved by `ms` (timed) or `days` (all day): skipped dates move with it. */
export function shiftExdates(exdates: string[], by: { ms?: number; days?: number }): string[] {
  return exdates.map((k) => {
    if (k.length === 10) return by.days ? addDays(k, by.days) : k
    if (!by.ms) return k
    const d = new Date(new Date(k.replace(/Z$/, ":00Z")).getTime() + by.ms)
    return d.toISOString().slice(0, 16) + "Z"
  })
}

export { diffDays }
