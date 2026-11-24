/**
 * Date helpers for the planner. Shared by the server and the browser (no Node-only APIs).
 *
 * "Wall" values are clock readings in a time zone (2026-12-01 10:00 in Asia/Kolkata). They are carried around as
 * plain strings ("2026-12-01", "10:00") or as a UTC Date used only as a container (Date.UTC(y, m, d, h, mi)), so
 * arithmetic on them never shifts with the machine's own zone.
 */

export type WallDate = string // YYYY-MM-DD
export type WallTime = string // HH:MM (24 h)

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

export function isWallDate(s: unknown): boolean {
  if (typeof s !== "string") return false
  const m = DATE_RE.exec(s)
  if (!m) return false
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]
}

export function dateParts(d: WallDate): { y: number; m: number; d: number } {
  const [y, m, day] = d.split("-").map(Number)
  return { y, m, d: day }
}

export function makeDate(y: number, m: number, d: number): WallDate {
  const x = new Date(Date.UTC(y, m - 1, d))
  return `${String(x.getUTCFullYear()).padStart(4, "0")}-${String(x.getUTCMonth() + 1).padStart(2, "0")}-${String(x.getUTCDate()).padStart(2, "0")}`
}

export function addDays(d: WallDate, n: number): WallDate {
  const p = dateParts(d)
  return makeDate(p.y, p.m, p.d + n)
}

export function addMonths(d: WallDate, n: number): WallDate {
  const p = dateParts(d)
  return makeDate(p.y, p.m + n, 1)
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(d: WallDate): number {
  const p = dateParts(d)
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

export function diffDays(a: WallDate, b: WallDate): number {
  const pa = dateParts(a)
  const pb = dateParts(b)
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86_400_000)
}

/** Start of the week containing d. weekStart: 0 = Sunday, 1 = Monday. */
export function startOfWeek(d: WallDate, weekStart = 1): WallDate {
  return addDays(d, -((weekday(d) - weekStart + 7) % 7))
}

export function minutesOf(t: WallTime): number {
  const [h, m] = t.split(":").map(Number)
  return h * 60 + m
}

export function timeFromMinutes(min: number): WallTime {
  const m = ((min % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`
}

// ---------------------------------------------------------------------------- time zones

const fmtCache = new Map<string, Intl.DateTimeFormat>()
function formatter(tz: string) {
  let f = fmtCache.get(tz)
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
    })
    fmtCache.set(tz, f)
  }
  return f
}

export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false
  try {
    formatter(tz)
    return true
  } catch {
    return false
  }
}

/** The device's own zone (browser) or UTC (server). */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

/** Wall clock reading of an instant in a zone. */
export function toWall(instant: Date | number, tz: string): { date: WallDate; time: WallTime; seconds: number } {
  const parts = formatter(tz).formatToParts(new Date(instant))
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  const y = get("year")
  const m = get("month")
  const d = get("day")
  const h = get("hour") % 24
  const mi = get("minute")
  return { date: makeDate(y, m, d), time: timeFromMinutes(h * 60 + mi), seconds: get("second") }
}

/** Offset of the zone from UTC at an instant, in minutes (Asia/Kolkata = +330). */
export function zoneOffsetMinutes(instant: number, tz: string): number {
  const w = toWall(instant, tz)
  const p = dateParts(w.date)
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, 0, minutesOf(w.time), w.seconds)
  return Math.round((asUtc - Math.floor(instant / 1000) * 1000) / 60_000)
}

/** The instant at which the zone's clock shows date + time. In a DST gap the later valid time is used. */
export function fromWall(date: WallDate, time: WallTime, tz: string): Date {
  const p = dateParts(date)
  const naive = Date.UTC(p.y, p.m - 1, p.d, 0, minutesOf(time))
  let guess = naive - zoneOffsetMinutes(naive, tz) * 60_000
  // Two refinements settle DST edges.
  for (let i = 0; i < 2; i++) {
    const next = naive - zoneOffsetMinutes(guess, tz) * 60_000
    if (next === guess) break
    guess = next
  }
  return new Date(guess)
}

export function todayIn(tz: string, now: Date = new Date()): WallDate {
  return toWall(now, tz).date
}
