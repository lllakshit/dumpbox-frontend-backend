import { describe, expect, it } from "vitest"
import { parseIcs, toIcs } from "@/lib/planner/ics"
import { readImport } from "@/lib/planner/importers"
import type { Entry } from "@/lib/planner/types"

const tz = "Asia/Kolkata"
const now = new Date("2026-11-24T04:30:00Z") // 10:00 IST, Tuesday

describe("JSON import", () => {
  it("simple objects with date, time, repeat, reminder", () => {
    const r = readImport(
      [
        { title: "Dentist", date: "2026-12-01", time: "10:00", end_time: "11:30", remind: "15m", location: "Clinic" },
        { title: "Pay rent", type: "task", due: "2026-12-01", repeat: "monthly" },
        { title: "Standup", date: "2026-12-01", time: "9:30am", repeat: "weekdays" },
        { title: "No date event", type: "event" },
        { title: "Undated task", type: "task" },
      ],
      { tz, now },
    )
    expect(r.errors).toEqual(["Entry 4: “No date event”: an event needs a date"])
    expect(r.drafts[0]).toMatchObject({ kind: "event", all_day: false, start_at: "2026-12-01T04:30:00.000Z", end_at: "2026-12-01T06:00:00.000Z", reminders: [15], location: "Clinic" })
    expect(r.drafts[1]).toMatchObject({ kind: "task", all_day: true, start_date: "2026-12-01", rrule: "FREQ=MONTHLY" })
    expect(r.drafts[2]).toMatchObject({ start_at: "2026-12-01T04:00:00.000Z", rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" })
    expect(r.drafts[3]).toMatchObject({ kind: "task", title: "Undated task" })
  })
  it("events/tasks object and ISO times with offsets", () => {
    const r = readImport({ events: [{ title: "Call", start: "2026-12-02T15:00:00+05:30", end: "2026-12-02T15:30:00+05:30" }], tasks: [{ title: "Read", done: true }] }, { tz, now })
    expect(r.drafts).toHaveLength(2)
    expect(r.drafts[0]).toMatchObject({ kind: "event", start_at: "2026-12-02T09:30:00.000Z", end_at: "2026-12-02T10:00:00.000Z" })
    expect(r.drafts[1]).toMatchObject({ kind: "task", completed: true })
  })
  it("Google Calendar API export", () => {
    const r = readImport(
      {
        kind: "calendar#events",
        items: [
          { id: "abc", iCalUID: "abc@google.com", summary: "Weekly 1:1", start: { dateTime: "2026-12-03T11:00:00+05:30", timeZone: "Asia/Kolkata" }, end: { dateTime: "2026-12-03T11:30:00+05:30" }, recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TH"], reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 10 }] } },
          { summary: "Holiday", start: { date: "2026-12-25" }, end: { date: "2026-12-26" } },
        ],
      },
      { tz, now },
    )
    expect(r.format).toBe("google-calendar")
    expect(r.drafts[0]).toMatchObject({ external_id: "abc@google.com", rrule: "FREQ=WEEKLY;BYDAY=TH", reminders: [10], start_at: "2026-12-03T05:30:00.000Z" })
    expect(r.drafts[1]).toMatchObject({ all_day: true, start_date: "2026-12-25" })
    expect(r.drafts[1].end_date).toBeUndefined()
  })
  it("Google Tasks export", () => {
    const r = readImport({ kind: "tasks#tasks", items: [{ id: "t1", title: "Renew insurance", due: "2026-12-10T00:00:00.000Z", status: "needsAction", notes: "Policy 123" }] }, { tz, now })
    expect(r.drafts[0]).toMatchObject({ kind: "task", title: "Renew insurance", completed: false, notes: "Policy 123", external_id: "t1" })
  })
  it("bad JSON and plain text lines", () => {
    expect(readImport("{oops", { tz, now }).errors[0]).toMatch(/Not valid JSON/)
    const r = readImport("- Dentist tomorrow 5pm\n- [x] Buy milk\nTeam sync friday 3-4pm", { tz, now, defaultKind: "task" })
    expect(r.format).toBe("text")
    expect(r.drafts.map((d) => [d.kind, d.title])).toEqual([
      ["task", "Dentist"],
      ["task", "Buy milk"],
      ["event", "Team sync"],
    ])
    expect(r.drafts[1].completed).toBe(true)
  })
})

describe("ICS", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "X-WR-CALNAME:Work",
    "BEGIN:VEVENT",
    "UID:ev1@x",
    "SUMMARY:Planning\\, Q1",
    "DTSTART;TZID=Asia/Kolkata:20261204T100000",
    "DTEND;TZID=Asia/Kolkata:20261204T110000",
    "RRULE:FREQ=WEEKLY;COUNT=3",
    "EXDATE;TZID=Asia/Kolkata:20261211T100000",
    "DESCRIPTION:Line one\\nLine two",
    "BEGIN:VALARM",
    "TRIGGER:-PT30M",
    "END:VALARM",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "SUMMARY:Offsite",
    "DTSTART;VALUE=DATE:20261220",
    "DTEND;VALUE=DATE:20261223",
    "END:VEVENT",
    "BEGIN:VTODO",
    "SUMMARY:File taxes",
    "DUE;VALUE=DATE:20261231",
    "STATUS:NEEDS-ACTION",
    "END:VTODO",
    "END:VCALENDAR",
  ].join("\r\n")
  it("reads events, all-day spans, tasks, alarms, exdates", () => {
    const r = parseIcs(ics, "UTC")
    expect(r.errors).toEqual([])
    expect(r.drafts[0]).toMatchObject({ title: "Planning, Q1", start_at: "2026-12-04T04:30:00.000Z", end_at: "2026-12-04T05:30:00.000Z", rrule: "FREQ=WEEKLY;COUNT=3", reminders: [30], exdates: ["2026-12-11T04:30Z"], notes: "Line one\nLine two", list_name: "Work", external_id: "ev1@x" })
    expect(r.drafts[1]).toMatchObject({ all_day: true, start_date: "2026-12-20", end_date: "2026-12-22" })
    expect(r.drafts[2]).toMatchObject({ kind: "task", all_day: true, start_date: "2026-12-31" })
  })
  it("round-trips through export", () => {
    const e = { id: "11111111-1111-1111-1111-111111111111", kind: "event", title: "Trip, day 1", all_day: true, start_date: "2026-12-20", end_date: "2026-12-22", reminders: [1440], exdates: [], rrule: null, notes: null, location: null, external_id: null, deleted_at: null, start_at: null, end_at: null, completed_at: null } as unknown as Entry
    const back = parseIcs(toIcs([e]), "UTC").drafts[0]
    expect(back).toMatchObject({ title: "Trip, day 1", start_date: "2026-12-20", end_date: "2026-12-22", reminders: [1440] })
  })
})
