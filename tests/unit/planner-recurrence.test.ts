import { describe, expect, it } from "vitest"
import { describeRule, nextAfterCurrent, occurrences, parseRule, ruleDates } from "@/lib/planner/recurrence"
import { fromWall, toWall } from "@/lib/planner/time"
import type { Entry } from "@/lib/planner/types"

function entry(p: Partial<Entry>): Entry {
  return {
    id: "e1",
    kind: "event",
    list_id: null,
    parent_id: null,
    title: "x",
    notes: null,
    location: null,
    all_day: false,
    start_at: null,
    end_at: null,
    start_date: null,
    end_date: null,
    time_zone: null,
    rrule: null,
    exdates: [],
    reminders: [],
    color: null,
    completed_at: null,
    starred: false,
    position: 0,
    source_item_id: null,
    external_id: null,
    deleted_at: null,
    version: 1,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    ...p,
  }
}

describe("time zones", () => {
  it("round-trips wall time", () => {
    const d = fromWall("2026-12-01", "10:00", "Asia/Kolkata")
    expect(d.toISOString()).toBe("2026-12-01T04:30:00.000Z")
    expect(toWall(d, "Asia/Kolkata")).toMatchObject({ date: "2026-12-01", time: "10:00" })
  })
  it("keeps wall time across DST", () => {
    expect(fromWall("2026-03-07", "10:00", "America/New_York").toISOString()).toBe("2026-03-07T15:00:00.000Z")
    expect(fromWall("2026-03-09", "10:00", "America/New_York").toISOString()).toBe("2026-03-09T14:00:00.000Z")
  })
})

describe("rules", () => {
  it("parses and describes", () => {
    expect(parseRule("RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4")).toEqual({ freq: "WEEKLY", interval: 1, byday: [{ wd: 1 }, { wd: 3 }], count: 4 })
    expect(parseRule("FREQ=HOURLY")).toBeNull()
    expect(parseRule("garbage")).toBeNull()
    expect(describeRule(parseRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE"))).toBe("Every 2 weeks on Mon, Wed")
    expect(describeRule(parseRule("FREQ=MONTHLY;BYDAY=-1FR"))).toBe("Monthly on the last Friday")
  })
  it("expands weekly with BYDAY and COUNT", () => {
    expect(ruleDates("2026-11-23", parseRule("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4")!, "2027-01-01")).toEqual(["2026-11-23", "2026-11-25", "2026-11-30", "2026-12-02"])
  })
  it("monthly on day 31 skips short months", () => {
    expect(ruleDates("2026-01-31", parseRule("FREQ=MONTHLY")!, "2026-06-30")).toEqual(["2026-01-31", "2026-03-31", "2026-05-31"])
  })
  it("monthly last friday and nth weekday", () => {
    expect(ruleDates("2026-11-27", parseRule("FREQ=MONTHLY;BYDAY=-1FR")!, "2027-01-31")).toEqual(["2026-11-27", "2026-12-25", "2027-01-29"])
    expect(ruleDates("2026-12-08", parseRule("FREQ=MONTHLY;BYDAY=2TU")!, "2027-02-28")).toEqual(["2026-12-08", "2027-01-12", "2027-02-09"])
  })
  it("yearly feb 29 only in leap years, until is inclusive", () => {
    expect(ruleDates("2024-02-29", parseRule("FREQ=YEARLY")!, "2032-12-31")).toEqual(["2024-02-29", "2028-02-29", "2032-02-29"])
    expect(ruleDates("2026-12-01", parseRule("FREQ=DAILY;UNTIL=20261203")!, "2027-01-01")).toEqual(["2026-12-01", "2026-12-02", "2026-12-03"])
  })
})

describe("occurrences", () => {
  it("timed weekly event in a range, with an exdate removed", () => {
    const e = entry({
      start_at: "2026-11-23T04:30:00Z",
      end_at: "2026-11-23T05:30:00Z",
      time_zone: "Asia/Kolkata",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      exdates: ["2026-11-30T04:30Z"],
    })
    const occ = occurrences(e, "2026-11-23", "2026-12-14", "Asia/Kolkata")
    expect(occ.map((o) => o.startDate)).toEqual(["2026-11-23", "2026-12-07", "2026-12-14"])
    expect(occ[0]).toMatchObject({ startTime: "10:00", endTime: "11:00", allDay: false, recurring: true })
  })
  it("all-day multi-day event overlapping the range start", () => {
    const e = entry({ all_day: true, start_date: "2026-11-20", end_date: "2026-11-25" })
    const occ = occurrences(e, "2026-11-23", "2026-11-29", "UTC")
    expect(occ).toHaveLength(1)
    expect(occ[0]).toMatchObject({ startDate: "2026-11-20", endDate: "2026-11-25", allDay: true })
  })
  it("viewer zone moves the date", () => {
    const e = entry({ start_at: "2026-12-01T20:00:00Z", time_zone: "UTC" })
    expect(occurrences(e, "2026-12-02", "2026-12-02", "Asia/Kolkata")[0].startTime).toBe("01:30")
  })
  it("undated tasks have none", () => {
    expect(occurrences(entry({ kind: "task" }), "2026-01-01", "2027-01-01", "UTC")).toEqual([])
  })
})

describe("repeating task completion", () => {
  it("moves a dated task to its next day and counts down", () => {
    expect(nextAfterCurrent({ all_day: true, start_date: "2026-11-30", end_date: null, start_at: null, end_at: null, rrule: "FREQ=MONTHLY;COUNT=3", time_zone: null })).toEqual({
      start_at: null,
      end_at: null,
      start_date: "2026-12-30",
      end_date: null,
      rrule: "FREQ=MONTHLY;COUNT=2",
    })
    expect(nextAfterCurrent({ all_day: true, start_date: "2026-11-30", end_date: null, start_at: null, end_at: null, rrule: "FREQ=DAILY;COUNT=1", time_zone: null })).toBeNull()
  })
  it("keeps the time of day in the task's zone", () => {
    const r = nextAfterCurrent({ all_day: false, start_at: "2026-11-24T03:30:00Z", end_at: null, start_date: null, end_date: null, rrule: "FREQ=WEEKLY;BYDAY=TU,FR", time_zone: "Asia/Kolkata" })
    expect(r?.start_at).toBe("2026-11-27T03:30:00.000Z")
  })
})

describe("long series", () => {
  it("a daily series from 2008 still shows in 2026, and COUNT still counts from the start", () => {
    const e = entry({ all_day: true, start_date: "2008-01-01", rrule: "FREQ=DAILY" })
    expect(occurrences(e, "2026-12-01", "2026-12-03", "UTC").map((o) => o.startDate)).toEqual(["2026-12-01", "2026-12-02", "2026-12-03"])
    const c = entry({ all_day: true, start_date: "2026-01-01", rrule: "FREQ=DAILY;COUNT=10" })
    expect(occurrences(c, "2026-01-09", "2026-01-31", "UTC").map((o) => o.startDate)).toEqual(["2026-01-09", "2026-01-10"])
  })
})

import { occurrenceDate, shiftExdates, splitSeries } from "@/lib/planner/series"

describe("editing part of a series", () => {
  it("cuts in the entry's own zone, carries COUNT and skipped dates over", () => {
    // Weekly Monday 10:00 New York, seen from India (Monday 20:30 IST).
    const e = entry({ start_at: "2026-11-30T15:00:00Z", time_zone: "America/New_York", rrule: "FREQ=WEEKLY;COUNT=6", exdates: ["2026-12-07T15:00Z", "2026-12-21T15:00Z"] })
    const occ = occurrences(e, "2026-12-14", "2026-12-14", "Asia/Kolkata")[0]
    const d = occurrenceDate(e, { key: occ.key, start: occ.start.toISOString() }, "Asia/Kolkata")
    expect(d).toBe("2026-12-14")
    const s = splitSeries(e, d, e.rrule, "Asia/Kolkata")
    expect(s.oldRule).toBe("FREQ=WEEKLY;UNTIL=20261213")
    expect(s.newRule).toBe("FREQ=WEEKLY;COUNT=4")
    expect(s.oldExdates).toEqual(["2026-12-07T15:00Z"])
    expect(s.newExdates).toEqual(["2026-12-21T15:00Z"])
    expect(splitSeries(e, "2026-11-30", e.rrule, "UTC").oldRule).toBeNull()
  })
  it("moving the whole series moves its skipped dates", () => {
    expect(shiftExdates(["2026-12-07T15:00Z", "2026-12-10"], { ms: 3600_000, days: 1 })).toEqual(["2026-12-07T16:00Z", "2026-12-11"])
  })
})
