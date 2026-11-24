/**
 * Quick add: turns typed text into an event or task.
 *
 *   "Dentist tomorrow 5pm for 30 min remind me 1h before"
 *   "Team call every Mon and Wed 10-10:30am @Zoom #work"
 *   "task: pay rent on the 1st every month"      "Mom's birthday 12 Aug every year"
 *
 * Recognised pieces are cut out of the text; what remains is the title (original casing kept). Works on wall
 * dates/times relative to `now` in the user's zone; the caller turns them into instants.
 */
import { formatRule, WD, type Rule } from "./recurrence"
import {
  addDays,
  dateParts,
  daysInMonth,
  isWallDate,
  makeDate,
  minutesOf,
  startOfWeek,
  timeFromMinutes,
  weekday,
  type WallDate,
  type WallTime,
} from "./time"

export type ParsedEntry = {
  title: string
  /** Set when the text says what it is ("task:", "remind me to", a time range…). */
  kind: "event" | "task" | null
  date: WallDate | null
  time: WallTime | null
  endDate: WallDate | null
  endTime: WallTime | null
  allDay: boolean
  rrule: string | null
  reminders: number[] | null
  location: string | null
  list: string | null
  starred: boolean
  /** The pieces that were understood, for showing as chips. */
  matched: { kind: "date" | "time" | "repeat" | "reminder" | "duration" | "location" | "list" | "kind" | "star"; text: string }[]
}

const WEEKDAYS: [RegExp, number][] = [
  [/^sun(?:day)?$/, 0],
  [/^mon(?:day)?$/, 1],
  [/^tue(?:s|sday)?$/, 2],
  [/^wed(?:s|nesday)?$/, 3],
  [/^thu(?:r|rs|rsday)?$/, 4],
  [/^fri(?:day)?$/, 5],
  [/^sat(?:urday)?$/, 6],
]
const WD_PATTERN = "sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:s|nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?"
const MONTH_PATTERN = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?"
const MONTH_KEYS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
const NUM_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, other: 2 }
const PLACE_WORDS = "home|office|work|gym|school|college|university|hospital|clinic|airport|station|cafe|café|restaurant|mall|park|temple|church|bank|hotel|zoom|meet|teams|skype|site|studio|library"

function wdIndex(s: string): number {
  const w = s.toLowerCase()
  for (const [re, n] of WEEKDAYS) if (re.test(w)) return n
  return -1
}
function monthIndex(s: string): number {
  return MONTH_KEYS.indexOf(s.toLowerCase().slice(0, 3)) + 1
}
function num(s: string): number {
  const w = s.toLowerCase()
  return w in NUM_WORDS ? NUM_WORDS[w] : Number(w)
}

/** "15m", "1.5 h", "2 days" → minutes. */
function unitMinutes(n: number, unit: string): number {
  const u = unit.toLowerCase()
  if (/^m/.test(u)) return Math.round(n)
  if (/^h/.test(u)) return Math.round(n * 60)
  if (/^d/.test(u)) return Math.round(n * 1440)
  if (/^w/.test(u)) return Math.round(n * 10080)
  return Math.round(n)
}

/** 12/24 h time parts → "HH:MM", or null when not a valid time. */
function toTime(h: number, m: number, mer: string | undefined): WallTime | null {
  if (m < 0 || m > 59) return null
  const md = mer?.toLowerCase().replace(/\./g, "")
  if (md) {
    if (h < 1 || h > 12) return null
    if (md.startsWith("a")) h = h === 12 ? 0 : h
    else h = h === 12 ? 12 : h + 12
  } else if (h > 23) return null
  return timeFromMinutes(h * 60 + m)
}

export function parseQuickAdd(text: string, now: { date: WallDate; time: WallTime }, opts: { weekStart?: number } = {}): ParsedEntry {
  const weekStart = opts.weekStart ?? 1
  let work = ` ${text.replace(/\s+/g, " ").trim()} `
  const original = work
  const matched: ParsedEntry["matched"] = []
  const res: ParsedEntry = {
    title: "",
    kind: null,
    date: null,
    time: null,
    endDate: null,
    endTime: null,
    allDay: false,
    rrule: null,
    reminders: null,
    location: null,
    list: null,
    starred: false,
    matched,
  }

  /** Finds the first match, blanks it out (positions are kept so the title keeps its casing), returns groups. */
  const take = (re: RegExp, kind: ParsedEntry["matched"][number]["kind"], caseSensitive = false): RegExpExecArray | null => {
    const m = new RegExp(re.source, caseSensitive || re.flags.includes("i") ? re.flags : re.flags + "i").exec(work)
    if (!m) return null
    const start = m.index
    const end = start + m[0].length
    matched.push({ kind, text: original.slice(start, end).trim() })
    work = work.slice(0, start) + " ".repeat(end - start) + work.slice(end)
    return m
  }

  // ---- kind
  const pre = take(/^\s*(task|todo|to-do|reminder|event|meeting|appointment)\s*:\s*/, "kind")
  if (pre) res.kind = /^(event|meeting|appointment)$/i.test(pre[1]) ? "event" : "task"
  if (!res.kind && take(/^\s*remind me to\b/, "kind")) res.kind = "task"

  // ---- starred / list
  if (take(/\s(!!|!important|!star)(?=\s)/, "star")) res.starred = true
  const list = take(/\s#([\p{L}\p{N}_-]{1,40})(?=\s)/u, "list")
  if (list) res.list = list[1]

  // ---- reminders ("remind me 15 min before", "alert 1h", "notify 2 days before"), several allowed
  const reminders: number[] = []
  for (let i = 0; i < 5; i++) {
    const r = take(
      /\s(?:remind(?:er)?(?:\s+me)?|alert(?:\s+me)?|notify(?:\s+me)?)\s+(\d+(?:\.\d+)?|an?|one|two|three)\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?)\b(?:\s+(?:before|early|prior|ahead))?(?=\s)/,
      "reminder",
    )
    if (!r) break
    reminders.push(Math.min(40320, unitMinutes(num(r[1]), r[2])))
  }
  if (take(/\s(?:no reminders?|don'?t remind(?: me)?)(?=\s)/, "reminder")) res.reminders = []
  if (reminders.length) res.reminders = [...new Set(reminders)].sort((a, b) => a - b)

  // ---- repeat
  let rule: Rule | null = null
  let rep: RegExpExecArray | null
  if ((rep = take(/\s(?:every\s*day|everyday|daily)(?=\s)/, "repeat"))) rule = { freq: "DAILY", interval: 1 }
  else if ((rep = take(/\s(?:every\s+weekday|on\s+weekdays|weekdays)(?=\s)/, "repeat")))
    rule = { freq: "WEEKLY", interval: 1, byday: [1, 2, 3, 4, 5].map((wd) => ({ wd })) }
  else if ((rep = take(/\s(?:every\s+weekend|on\s+weekends|weekends)(?=\s)/, "repeat"))) rule = { freq: "WEEKLY", interval: 1, byday: [{ wd: 6 }, { wd: 0 }] }
  else if ((rep = take(/\severy\s+(\d+|other|two|three|four)\s+(day|week|month|year)s?(?=\s)/, "repeat"))) {
    const unit = rep[2].toLowerCase()
    rule = { freq: unit === "day" ? "DAILY" : unit === "week" ? "WEEKLY" : unit === "month" ? "MONTHLY" : "YEARLY", interval: Math.max(1, Math.min(999, num(rep[1]))) }
  } else if ((rep = take(new RegExp(`\\severy\\s+(first|second|third|fourth|last|1st|2nd|3rd|4th)\\s+(${WD_PATTERN})(?:\\s+of\\s+(?:the|every)\\s+month)?(?=\\s)`), "repeat"))) {
    const n = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, last: -1 }[rep[1].toLowerCase()] ?? 1
    rule = { freq: "MONTHLY", interval: 1, byday: [{ wd: wdIndex(rep[2]), n }] }
  } else if ((rep = take(new RegExp(`\\s(?:every|each)\\s+((?:${WD_PATTERN})(?:\\s*(?:,|and|&|\\+)\\s*(?:${WD_PATTERN}))*)s?(?=\\s)`), "repeat"))) {
    const days = rep[1].split(/\s*(?:,|and|&|\+)\s*/).map(wdIndex).filter((n) => n >= 0)
    rule = { freq: "WEEKLY", interval: 1, byday: [...new Set(days)].map((wd) => ({ wd })) }
  } else if ((rep = take(/\s(?:every\s+(?:month|year|week)|weekly|monthly|yearly|annually|every\s+year)(?=\s)/, "repeat"))) {
    const w = rep[0].toLowerCase()
    rule = { freq: /week/.test(w) ? "WEEKLY" : /month/.test(w) ? "MONTHLY" : "YEARLY", interval: 1 }
  } else if ((rep = take(/\severy\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+of\s+(?:the|every)\s+month)?(?=\s)/, "repeat"))) {
    const d = Number(rep[1])
    if (d >= 1 && d <= 31) rule = { freq: "MONTHLY", interval: 1, bymonthday: [d] }
  }
  if (rule) {
    const cnt = take(/\s(?:for\s+)?(\d{1,4})\s+times(?=\s)/, "repeat")
    if (cnt) rule.count = Math.min(5000, Number(cnt[1]))
  }

  // ---- duration ("for 2h", "for 30 minutes", "for an hour", "for half an hour")
  let durationMin: number | null = null
  const dur = take(/\sfor\s+(\d+(?:\.\d+)?|an?|one|two|three|half an?)\s*(m|mins?|minutes?|h|hrs?|hours?)(?=\s)/, "duration")
  if (dur) durationMin = dur[1].toLowerCase().startsWith("half") ? (/^h/i.test(dur[2]) ? 30 : 0) : unitMinutes(num(dur[1]), dur[2])
  if (!dur) {
    const hm = take(/\sfor\s+(\d+)\s*h\s*(\d+)\s*m(?:in)?s?(?=\s)/, "duration")
    if (hm) durationMin = Number(hm[1]) * 60 + Number(hm[2])
  }

  // ---- time range ("5-6pm", "from 3 to 4:30pm", "10:00–11:30", "9am till noon")
  const T = "(\\d{1,2})(?:[:.](\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?|am|pm)?"
  const range = take(new RegExp(`\\s(?:from\\s+|between\\s+)?${T}\\s*(?:-|–|—|to|till|until|and)\\s*(?:${T}|(noon|midnight))(?=\\s)`), "time")
  let rangeOk = false
  if (range) {
    const [, h1, m1, mer1, h2, m2, mer2, word2] = range
    const end = word2 ? (word2.toLowerCase() === "noon" ? "12:00" : "23:59") : toTime(Number(h2), Number(m2 ?? 0), mer2)
    const hasSignal = Boolean(mer1 || mer2 || m1 || m2 || word2 || /from|between/i.test(range[0]))
    let start = toTime(Number(h1), Number(m1 ?? 0), mer1 ?? (mer2 && Number(h1) <= Number(h2 ?? 12) ? mer2 : undefined))
    if (start && !mer1 && !mer2 && !word2 && Number(h1) <= 12 && Number(h1) < 7) start = toTime(Number(h1) + 12, Number(m1 ?? 0), undefined)
    if (start && end && hasSignal) {
      res.time = start
      res.endTime = end
      rangeOk = true
      if (!res.kind) res.kind = "event"
    } else {
      // Not a time range after all (e.g. "2-3 people"): restore the text.
      work = work.slice(0, range.index) + original.slice(range.index, range.index + range[0].length) + work.slice(range.index + range[0].length)
      matched.pop()
    }
  }

  // ---- single time
  if (!rangeOk) {
    const t =
      take(/\s(?:at\s+|@\s*|by\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?|am|pm)(?=\s)/, "time") ??
      take(/\s(?:at\s+|@\s*|by\s+)?([01]?\d|2[0-3])[:.]([0-5]\d)(?=\s)/, "time")
    if (t) {
      res.time = toTime(Number(t[1]), Number(t[2] ?? 0), t[3])
    } else {
      const bare = take(/\sat\s+(\d{1,2})(?=\s)/, "time")
      if (bare) {
        const h = Number(bare[1])
        res.time = h >= 1 && h <= 6 ? toTime(h + 12, 0, undefined) : toTime(h, 0, undefined)
      }
    }
    if (!res.time) {
      const word = take(/\s(?:at\s+)?(noon|midday|midnight|morning|afternoon|evening|tonight|night)(?=\s)/, "time")
      if (word) {
        const w = word[1].toLowerCase()
        res.time = { noon: "12:00", midday: "12:00", midnight: "00:00", morning: "09:00", afternoon: "14:00", evening: "18:00", tonight: "21:00", night: "21:00" }[w] ?? null
        if (w === "tonight") res.date = now.date
      }
    }
  }

  // ---- date
  const setDate = (d: WallDate | null) => {
    if (d && !res.date) res.date = d
  }
  const nextWeekday = (wd: number, includeToday: boolean) => {
    const diff = (wd - weekday(now.date) + 7) % 7
    return addDays(now.date, diff === 0 && !includeToday ? 7 : diff)
  }
  let d: RegExpExecArray | null
  if ((d = take(/\s(?:on\s+)?(?:the\s+)?day\s+after\s+tomorrow(?=\s)/, "date"))) setDate(addDays(now.date, 2))
  else if ((d = take(/\s(?:on\s+)?(?:today|tod)(?=\s)/, "date"))) setDate(now.date)
  else if ((d = take(/\s(?:on\s+)?(?:tomorrow|tmrw|tmr|tomo)(?=\s)/, "date"))) setDate(addDays(now.date, 1))
  else if ((d = take(/\s(?:on\s+)?yesterday(?=\s)/, "date"))) setDate(addDays(now.date, -1))
  else if ((d = take(/\sin\s+(\d+|an?|one|two|three|four|five|six|seven|ten)\s+(minute|min|hour|hr|day|week|month|year)s?(?=\s)/, "date"))) {
    const n = num(d[1])
    const unit = d[2].toLowerCase()
    if (unit.startsWith("min") || unit.startsWith("h")) {
      const mins = minutesOf(now.time) + (unit.startsWith("min") ? n : n * 60)
      setDate(addDays(now.date, Math.floor(mins / 1440)))
      if (!res.time) res.time = timeFromMinutes(mins)
    } else if (unit === "day") setDate(addDays(now.date, n))
    else if (unit === "week") setDate(addDays(now.date, n * 7))
    else {
      const p = dateParts(now.date)
      const months = unit === "month" ? n : n * 12
      const target = makeDate(p.y, p.m + months, 1)
      const tp = dateParts(target)
      setDate(makeDate(tp.y, tp.m, Math.min(p.d, daysInMonth(tp.y, tp.m))))
    }
  } else if ((d = take(new RegExp(`\\s(?:on\\s+)?(next|this|coming)?\\s*(${WD_PATTERN})(?=\\s)`), "date"))) {
    const wd = wdIndex(d[2])
    if (d[1]?.toLowerCase() === "next") {
      // "next friday" = Friday of next week.
      setDate(addDays(startOfWeek(now.date, weekStart), 7 + ((wd - weekStart + 7) % 7)))
    } else setDate(nextWeekday(wd, true))
  } else if ((d = take(/\s(?:next|by\s+next)\s+week(?=\s)/, "date"))) setDate(addDays(startOfWeek(now.date, weekStart), 7))
  else if ((d = take(/\s(?:this\s+)?weekend(?=\s)/, "date"))) setDate(nextWeekday(6, true))
  else if ((d = take(/\snext\s+month(?=\s)/, "date"))) {
    const p = dateParts(now.date)
    setDate(makeDate(p.y, p.m + 1, 1))
  } else if ((d = take(/\s(?:by\s+)?(?:end of (?:the )?month|eom)(?=\s)/, "date"))) {
    const p = dateParts(now.date)
    setDate(makeDate(p.y, p.m, daysInMonth(p.y, p.m)))
  } else if ((d = take(/\snext\s+year(?=\s)/, "date"))) setDate(makeDate(dateParts(now.date).y + 1, 1, 1))

  if (!res.date) {
    const p = dateParts(now.date)
    const withYear = (y: number | null, m: number, day: number): WallDate | null => {
      if (m < 1 || m > 12 || day < 1) return null
      if (y !== null) {
        const yy = y < 100 ? 2000 + y : y
        return day <= daysInMonth(yy, m) ? makeDate(yy, m, day) : null
      }
      // No year: this year, or next year once the date has passed.
      for (const yy of [p.y, p.y + 1]) {
        if (day > daysInMonth(yy, m)) continue
        const c = makeDate(yy, m, day)
        if (c >= now.date) return c
      }
      return null
    }
    if ((d = take(/\s(?:on\s+)?(\d{4})-(\d{2})-(\d{2})(?=\s)/, "date"))) setDate(isWallDate(`${d[1]}-${d[2]}-${d[3]}`) ? `${d[1]}-${d[2]}-${d[3]}` : null)
    else if ((d = take(new RegExp(`\\s(?:on\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_PATTERN})\\.?(?:,?\\s+(\\d{4}))?(?=\\s)`), "date")))
      setDate(withYear(d[3] ? Number(d[3]) : null, monthIndex(d[2]), Number(d[1])))
    else if ((d = take(new RegExp(`\\s(?:on\\s+)?(${MONTH_PATTERN})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?(?=\\s)`), "date")))
      setDate(withYear(d[3] ? Number(d[3]) : null, monthIndex(d[1]), Number(d[2])))
    else if ((d = take(/\s(?:on\s+)?(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?(?=\s)/, "date")))
      // Day first (India / UK style): 25/12, 25/12/2026.
      setDate(withYear(d[3] ? Number(d[3]) : null, Number(d[2]), Number(d[1])))
    else if ((d = take(/\s(?:on|by)\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)(?=\s)/, "date"))) {
      const day = Number(d[1])
      for (let k = 0; k < 3 && !res.date; k++) {
        const first = makeDate(p.y, p.m + k, 1)
        const fp = dateParts(first)
        if (day <= daysInMonth(fp.y, fp.m)) {
          const c = makeDate(fp.y, fp.m, day)
          if (c >= now.date) setDate(c)
        }
      }
    }
  }

  // "until 31 dec" for repeats
  if (rule) {
    const u = take(new RegExp(`\\suntil\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_PATTERN})(?:\\s+(\\d{4}))?(?=\\s)`), "repeat")
    if (u) {
      const y = u[3] ? Number(u[3]) : dateParts(now.date).y
      const m = monthIndex(u[2])
      const day = Number(u[1])
      if (day <= daysInMonth(y, m)) rule.until = makeDate(y, m, day)
    }
  }

  // ---- location: "@ Zoom", "at Cafe Mocha", "at home" (not "look at the report")
  const loc =
    take(/\s@\s?([^\s@#][^@#,;]*?)(?=\s+(?:with|for|about|re)\s|[,;]|\s*$)/, "location") ??
    take(
      new RegExp(`\\s(?:[Aa]t|[Ii]n)\\s+((?:the\\s+)?(?:${PLACE_WORDS})\\b[^,;#@]*?|(?:the\\s+)?[A-Z][\\p{L}'&.-]*(?:\\s+[A-Z0-9][\\p{L}0-9'&.-]*)*)(?=\\s+(?:with|for|about|re)\\s|[,;]|\\s*$)`, "u"),
      "location",
      true,
    )
  if (loc) res.location = loc[1].trim().replace(/[.,;]+$/, "") || null

  // ---- resolve
  if (rule) {
    res.rrule = formatRule(rule)
    if (!res.date) {
      // First matching day from today.
      if (rule.byday?.length && rule.freq === "WEEKLY") {
        const cands = rule.byday.map((b) => nextWeekday(b.wd, true)).sort()
        res.date = cands[0]
      } else if (rule.byday?.length && rule.byday[0].n) {
        const p = dateParts(now.date)
        for (let k = 0; k < 3 && !res.date; k++) {
          const first = makeDate(p.y, p.m + k, 1)
          const fp = dateParts(first)
          const b = rule.byday[0]
          const dim = daysInMonth(fp.y, fp.m)
          let day: number
          if (b.n! > 0) day = 1 + ((b.wd - weekday(first) + 7) % 7) + (b.n! - 1) * 7
          else day = dim - ((weekday(makeDate(fp.y, fp.m, dim)) - b.wd + 7) % 7)
          if (day <= dim && makeDate(fp.y, fp.m, day) >= now.date) res.date = makeDate(fp.y, fp.m, day)
        }
      } else if (rule.bymonthday?.length) {
        const p = dateParts(now.date)
        const day = rule.bymonthday[0]
        for (let k = 0; k < 3 && !res.date; k++) {
          const first = makeDate(p.y, p.m + k, 1)
          const fp = dateParts(first)
          if (day <= daysInMonth(fp.y, fp.m) && makeDate(fp.y, fp.m, day) >= now.date) res.date = makeDate(fp.y, fp.m, day)
        }
      } else res.date = now.date
    }
  }

  if (res.time && !res.date) {
    // A time with no date: today if still ahead, else tomorrow.
    res.date = minutesOf(res.time) > minutesOf(now.time) ? now.date : addDays(now.date, 1)
  }
  if (res.time && res.date) {
    if (res.endTime) {
      res.endDate = minutesOf(res.endTime) <= minutesOf(res.time) ? addDays(res.date, 1) : res.date
    } else if (durationMin) {
      const total = minutesOf(res.time) + durationMin
      res.endDate = addDays(res.date, Math.floor(total / 1440))
      res.endTime = timeFromMinutes(total)
      if (!res.kind) res.kind = "event"
    }
  } else if (res.date) {
    res.allDay = true
    if (durationMin && durationMin >= 1440) res.endDate = addDays(res.date, Math.round(durationMin / 1440) - 1)
  }

  // ---- title: what is left, tidied
  let title = work
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:on|at|by|from|for|in|to|and|,|-|–|:)\s+/i, "")
    .replace(/\s+(?:on|at|by|from|for|in|to|and|,|-|–|the)$/i, "")
    .replace(/^[,;:\-–\s]+|[,;:\-–\s]+$/g, "")
    .trim()
  if (!title) title = text.trim()
  res.title = title.charAt(0).toUpperCase() + title.slice(1)
  return res
}

export { WD }
