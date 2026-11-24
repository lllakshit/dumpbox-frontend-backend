/**
 * Repeat rules (a subset of RFC 5545 RRULE) and occurrence expansion.
 *
 * Supported: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, BYDAY (MO,WE or 1MO / -1FR for monthly/yearly),
 * BYMONTHDAY (15, -1), BYMONTH (with YEARLY), COUNT, UNTIL. Expansion works on wall dates in the entry's zone,
 * so "every Monday 10:00" stays at 10:00 across daylight-saving changes.
 */
import {
  addDays,
  dateParts,
  daysInMonth,
  diffDays,
  fromWall,
  isWallDate,
  localTimeZone,
  makeDate,
  startOfWeek,
  toWall,
  weekday,
  type WallDate,
  type WallTime,
} from "./time"
import type { Entry } from "./types"

export type Freq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY"
export type ByDay = { wd: number; n?: number }
export type Rule = {
  freq: Freq
  interval: number
  byday?: ByDay[]
  bymonthday?: number[]
  bymonth?: number[]
  count?: number
  /** Last allowed date (inclusive), as a wall date. */
  until?: WallDate
}

export const WD = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const
const WD_NAME = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const WD_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

/** Parses an RRULE value ("FREQ=WEEKLY;BYDAY=MO" or "RRULE:FREQ=…"). Returns null when it is not supported. */
export function parseRule(raw: string | null | undefined): Rule | null {
  if (!raw) return null
  const s = raw.trim().replace(/^RRULE:/i, "")
  if (!s) return null
  const parts = new Map<string, string>()
  for (const kv of s.split(";")) {
    if (!kv) continue
    const [k, v] = kv.split("=")
    if (!k || v === undefined) return null
    parts.set(k.toUpperCase(), v.toUpperCase())
  }
  const freq = parts.get("FREQ") as Freq | undefined
  if (!freq || !["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) return null
  const rule: Rule = { freq, interval: 1 }
  const interval = parts.get("INTERVAL")
  if (interval) {
    const n = Number(interval)
    if (!Number.isInteger(n) || n < 1 || n > 999) return null
    rule.interval = n
  }
  const byday = parts.get("BYDAY")
  if (byday) {
    const list: ByDay[] = []
    for (const tok of byday.split(",")) {
      const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(tok)
      if (!m) return null
      const n = m[1] ? Number(m[1]) : undefined
      if (n !== undefined && (n === 0 || n < -5 || n > 5)) return null
      list.push({ wd: WD.indexOf(m[2] as (typeof WD)[number]), ...(n !== undefined ? { n } : {}) })
    }
    rule.byday = list
  }
  const bmd = parts.get("BYMONTHDAY")
  if (bmd) {
    const list = bmd.split(",").map(Number)
    if (list.some((n) => !Number.isInteger(n) || n === 0 || n < -31 || n > 31)) return null
    rule.bymonthday = list
  }
  const bm = parts.get("BYMONTH")
  if (bm) {
    const list = bm.split(",").map(Number)
    if (list.some((n) => !Number.isInteger(n) || n < 1 || n > 12)) return null
    rule.bymonth = list
  }
  const count = parts.get("COUNT")
  if (count) {
    const n = Number(count)
    if (!Number.isInteger(n) || n < 1 || n > 5000) return null
    rule.count = n
  }
  const until = parts.get("UNTIL")
  if (until) {
    const m = /^(\d{4})(\d{2})(\d{2})(T\d{6}Z?)?$/.exec(until)
    if (!m) return null
    const d = `${m[1]}-${m[2]}-${m[3]}`
    if (!isWallDate(d)) return null
    rule.until = d
  }
  if (rule.count && rule.until) delete rule.count
  return rule
}

export function formatRule(r: Rule): string {
  const out = [`FREQ=${r.freq}`]
  if (r.interval > 1) out.push(`INTERVAL=${r.interval}`)
  if (r.byday?.length) out.push(`BYDAY=${r.byday.map((b) => `${b.n ?? ""}${WD[b.wd]}`).join(",")}`)
  if (r.bymonthday?.length) out.push(`BYMONTHDAY=${r.bymonthday.join(",")}`)
  if (r.bymonth?.length) out.push(`BYMONTH=${r.bymonth.join(",")}`)
  if (r.count) out.push(`COUNT=${r.count}`)
  else if (r.until) out.push(`UNTIL=${r.until.replaceAll("-", "")}`)
  return out.join(";")
}

function ordinal(n: number) {
  if (n === -1) return "last"
  return ["", "first", "second", "third", "fourth", "fifth"][n] ?? `${n}th`
}

/** Plain-English summary: "Every 2 weeks on Mon, Wed, 10 times". */
export function describeRule(r: Rule | null, start?: WallDate): string {
  if (!r) return "Does not repeat"
  const unit = { DAILY: "day", WEEKLY: "week", MONTHLY: "month", YEARLY: "year" }[r.freq]
  let s = r.interval === 1 ? { DAILY: "Daily", WEEKLY: "Weekly", MONTHLY: "Monthly", YEARLY: "Yearly" }[r.freq] : `Every ${r.interval} ${unit}s`
  const weekdaysOnly = r.byday && r.byday.length === 5 && [1, 2, 3, 4, 5].every((d) => r.byday!.some((b) => b.wd === d && !b.n))
  if (r.freq === "WEEKLY" && weekdaysOnly && r.interval === 1) s = "Every weekday (Mon–Fri)"
  else if (r.freq === "WEEKLY" && r.byday?.length) s += ` on ${r.byday.map((b) => WD_NAME[b.wd]).join(", ")}`
  else if (r.freq === "WEEKLY" && start) s += ` on ${WD_NAME[weekday(start)]}`
  if (r.freq === "MONTHLY") {
    if (r.byday?.length && r.byday[0].n) s += ` on the ${ordinal(r.byday[0].n)} ${WD_LONG[r.byday[0].wd]}`
    else if (r.bymonthday?.length) s += ` on day ${r.bymonthday.map((d) => (d === -1 ? "last" : d)).join(", ")}`
    else if (start) s += ` on day ${dateParts(start).d}`
  }
  if (r.freq === "YEARLY" && start) {
    const p = dateParts(start)
    s += ` on ${MONTHS[p.m - 1]} ${p.d}`
  }
  if (r.count) s += `, ${r.count} time${r.count === 1 ? "" : "s"}`
  else if (r.until) s += `, until ${r.until}`
  return s
}

/** Dates of the nth weekday wd in a month (n = 1..5 or -1..-5). */
function nthWeekday(y: number, m: number, wd: number, n: number): WallDate | null {
  const dim = daysInMonth(y, m)
  if (n > 0) {
    const first = weekday(makeDate(y, m, 1))
    const day = 1 + ((wd - first + 7) % 7) + (n - 1) * 7
    return day <= dim ? makeDate(y, m, day) : null
  }
  const last = weekday(makeDate(y, m, dim))
  const day = dim - ((last - wd + 7) % 7) + (n + 1) * 7
  return day >= 1 ? makeDate(y, m, day) : null
}

function monthDates(y: number, m: number, r: Rule, start: WallDate): WallDate[] {
  const dim = daysInMonth(y, m)
  const out: WallDate[] = []
  if (r.byday?.length) {
    for (const b of r.byday) {
      if (b.n) {
        const d = nthWeekday(y, m, b.wd, b.n)
        if (d) out.push(d)
      } else {
        for (let day = 1; day <= dim; day++) if (weekday(makeDate(y, m, day)) === b.wd) out.push(makeDate(y, m, day))
      }
    }
  } else if (r.bymonthday?.length) {
    for (const md of r.bymonthday) {
      const day = md > 0 ? md : dim + md + 1
      if (day >= 1 && day <= dim) out.push(makeDate(y, m, day))
    }
  } else {
    const day = dateParts(start).d
    if (day <= dim) out.push(makeDate(y, m, day))
  }
  return [...new Set(out)].sort()
}

/**
 * Occurrence dates of a rule from `start` (always the first occurrence, as calendar apps do, even when it does not
 * match BYDAY), up to `to` inclusive. Dates before `from` are counted (for COUNT) but not returned, so a daily series
 * started years ago stays cheap to show. Returns at most `limit` dates.
 */
export function ruleDates(start: WallDate, r: Rule, to: WallDate, limit = 5000, from?: WallDate): WallDate[] {
  const out: WallDate[] = []
  const last = r.until && r.until < to ? r.until : to
  const maxCount = r.count ?? Infinity
  let seen = 0
  const take = (d: WallDate) => {
    seen++
    if ((!from || d >= from) && out.length < limit) out.push(d)
  }
  if (start <= last) take(start)
  const sp = dateParts(start)
  for (let k = 0; k < 200000 && seen < maxCount && out.length < limit; k++) {
    let periodStart: WallDate
    let dates: WallDate[]
    if (r.freq === "DAILY") {
      periodStart = addDays(start, k * r.interval)
      dates = [periodStart]
    } else if (r.freq === "WEEKLY") {
      periodStart = addDays(startOfWeek(start, 1), k * 7 * r.interval)
      const wds = r.byday?.length ? r.byday.map((b) => b.wd) : [weekday(start)]
      dates = wds.map((wd) => addDays(periodStart, (wd - 1 + 7) % 7)).sort()
    } else if (r.freq === "MONTHLY") {
      periodStart = makeDate(sp.y, sp.m + k * r.interval, 1)
      const p = dateParts(periodStart)
      dates = monthDates(p.y, p.m, r, start)
    } else {
      const y = sp.y + k * r.interval
      periodStart = makeDate(y, 1, 1)
      const months = r.bymonth?.length ? r.bymonth : [sp.m]
      dates = []
      for (const m of months) {
        if (r.byday?.length || r.bymonthday?.length) dates.push(...monthDates(y, m, r, start))
        else if (sp.d <= daysInMonth(y, m)) dates.push(makeDate(y, m, sp.d))
      }
      dates.sort()
    }
    if (periodStart > last) break
    for (const d of dates) {
      if (d > start && d <= last && seen < maxCount) take(d)
    }
  }
  return out
}

export type Occurrence = {
  entry: Entry
  /** Stable id of this occurrence: the entry's start key for this date (date, or UTC ISO time). */
  key: string
  allDay: boolean
  /** Instant range for timed entries; for all-day, midnight to midnight in the viewer's zone. */
  start: Date
  end: Date
  /** Wall dates in the viewer's zone (inclusive). */
  startDate: WallDate
  endDate: WallDate
  /** Time of day in the viewer's zone (timed only). */
  startTime?: WallTime
  endTime?: WallTime
  recurring: boolean
}

/** Occurrence key for a timed start: minute precision UTC ISO string. */
export function timeKey(d: Date) {
  return d.toISOString().slice(0, 16) + "Z"
}

/**
 * All occurrences of an entry that touch the wall-date range [from, to] in the viewer's zone.
 * Entries without a date (tasks) have none.
 */
export function occurrences(entry: Entry, from: WallDate, to: WallDate, viewerTz = localTimeZone(), limit = 1000): Occurrence[] {
  const rule = parseRule(entry.rrule)
  const ex = new Set(entry.exdates ?? [])
  const out: Occurrence[] = []
  if (entry.all_day || (!entry.start_at && entry.start_date)) {
    const s = entry.start_date
    if (!s) return []
    const span = entry.end_date ? Math.max(0, diffDays(s, entry.end_date)) : 0
    const dates = rule ? ruleDates(s, rule, to, limit + 5, addDays(from, -span)) : [s]
    for (const d of dates) {
      const e = addDays(d, span)
      if (e < from) continue
      if (d > to) break
      if (ex.has(d)) continue
      out.push({
        entry,
        key: d,
        allDay: true,
        start: fromWall(d, "00:00", viewerTz),
        end: fromWall(addDays(e, 1), "00:00", viewerTz),
        startDate: d,
        endDate: e,
        recurring: Boolean(rule),
      })
      if (out.length >= limit) break
    }
    return out
  }
  if (!entry.start_at) return []
  const tz = entry.time_zone || viewerTz
  const startInstant = new Date(entry.start_at)
  const durMs = entry.end_at ? Math.max(0, new Date(entry.end_at).getTime() - startInstant.getTime()) : 0
  const wall = toWall(startInstant, tz)
  // Widen by a day on each side: zone differences can move an occurrence across the date line.
  const spanDays = Math.ceil(durMs / 86_400_000) + 2
  const dates = rule ? ruleDates(wall.date, rule, addDays(to, 1), limit + 5, addDays(from, -spanDays)) : [wall.date]
  for (const d of dates) {
    const s = rule ? fromWall(d, wall.time, tz) : startInstant
    const e = new Date(s.getTime() + durMs)
    const sw = toWall(s, viewerTz)
    const ew = toWall(durMs > 0 ? new Date(e.getTime() - 1) : e, viewerTz)
    if (ew.date < from) continue
    if (sw.date > to) {
      if (d > addDays(to, 1)) break
      continue
    }
    const key = timeKey(s)
    if (ex.has(key)) continue
    out.push({
      entry,
      key,
      allDay: false,
      start: s,
      end: e,
      startDate: sw.date,
      endDate: ew.date,
      startTime: sw.time,
      endTime: toWall(e, viewerTz).time,
      recurring: Boolean(rule),
    })
    if (out.length >= limit) break
  }
  return out
}

/**
 * The next start after the current one, for completing a repeating task (or null when the rule has ended).
 * Returns the new start fields and the rule to keep (COUNT reduced by one).
 */
export function nextAfterCurrent(
  entry: Pick<Entry, "all_day" | "start_at" | "start_date" | "end_at" | "end_date" | "rrule" | "time_zone">,
  tzFallback = "UTC",
): { start_at: string | null; end_at: string | null; start_date: string | null; end_date: string | null; rrule: string | null } | null {
  const rule = parseRule(entry.rrule)
  if (!rule) return null
  const nextRule = rule.count ? (rule.count > 1 ? { ...rule, count: rule.count - 1 } : null) : rule
  if (!nextRule) return null
  if (entry.all_day || (!entry.start_at && entry.start_date)) {
    const s = entry.start_date!
    const dates = ruleDates(s, rule, addDays(s, 366 * 30), 2)
    const n = dates[1]
    if (!n) return null
    const span = entry.end_date ? diffDays(s, entry.end_date) : null
    return { start_at: null, end_at: null, start_date: n, end_date: span !== null ? addDays(n, span) : null, rrule: formatRule(nextRule) }
  }
  if (!entry.start_at) return null
  const tz = entry.time_zone || tzFallback
  const s = new Date(entry.start_at)
  const w = toWall(s, tz)
  const dates = ruleDates(w.date, rule, addDays(w.date, 366 * 30), 2)
  const n = dates[1]
  if (!n) return null
  const ns = fromWall(n, w.time, tz)
  const dur = entry.end_at ? new Date(entry.end_at).getTime() - s.getTime() : null
  return {
    start_at: ns.toISOString(),
    end_at: dur !== null ? new Date(ns.getTime() + dur).toISOString() : null,
    start_date: null,
    end_date: null,
    rrule: formatRule(nextRule),
  }
}

/** Ends a rule the day before `date` (for "this and following" edits). */
export function endRuleBefore(raw: string, date: WallDate): string | null {
  const r = parseRule(raw)
  if (!r) return null
  return formatRule({ ...r, count: undefined, until: addDays(date, -1) })
}

/** Presets offered in the editors. */
export function rulePresets(start: WallDate): { label: string; rrule: string | null }[] {
  const wd = weekday(start)
  const p = dateParts(start)
  const nth = Math.ceil(p.d / 7)
  const isLast = p.d + 7 > daysInMonth(p.y, p.m)
  return [
    { label: "Does not repeat", rrule: null },
    { label: "Daily", rrule: "FREQ=DAILY" },
    { label: `Weekly on ${WD_LONG[wd]}`, rrule: `FREQ=WEEKLY;BYDAY=${WD[wd]}` },
    { label: "Every weekday (Mon–Fri)", rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" },
    { label: `Monthly on day ${p.d}`, rrule: `FREQ=MONTHLY;BYMONTHDAY=${p.d}` },
    { label: `Monthly on the ${ordinal(nth)} ${WD_LONG[wd]}`, rrule: `FREQ=MONTHLY;BYDAY=${nth}${WD[wd]}` },
    ...(isLast && nth !== 5 ? [{ label: `Monthly on the last ${WD_LONG[wd]}`, rrule: `FREQ=MONTHLY;BYDAY=-1${WD[wd]}` }] : []),
    { label: `Yearly on ${MONTHS[p.m - 1]} ${p.d}`, rrule: "FREQ=YEARLY" },
  ]
}
