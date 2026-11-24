import { describe, expect, it } from "vitest"
import { parseQuickAdd } from "@/lib/planner/parse"

// Tuesday 24 Nov 2026, 10:00
const now = { date: "2026-11-24", time: "10:00" }
const p = (t: string) => parseQuickAdd(t, now)

describe("quick add parser", () => {
  it("date + time + title", () => {
    const r = p("Dentist tomorrow 5pm")
    expect(r).toMatchObject({ title: "Dentist", date: "2026-11-25", time: "17:00", allDay: false })
  })
  it("time only: today if still ahead, else tomorrow", () => {
    expect(p("Call mom at 6:30pm")).toMatchObject({ title: "Call mom", date: "2026-11-24", time: "18:30" })
    expect(p("Standup 9am")).toMatchObject({ date: "2026-11-25", time: "09:00" })
    expect(p("Lunch at 1")).toMatchObject({ time: "13:00" })
    expect(p("Gym 18:15")).toMatchObject({ time: "18:15" })
  })
  it("date only becomes all-day", () => {
    expect(p("Pay rent on 1st")).toMatchObject({ title: "Pay rent", date: "2026-12-01", allDay: true, time: null })
    expect(p("Trip 25 dec")).toMatchObject({ title: "Trip", date: "2026-12-25", allDay: true })
    expect(p("Exam Jan 5")).toMatchObject({ date: "2027-01-05" })
    expect(p("Passport renewal 15/03/2027")).toMatchObject({ date: "2027-03-15" })
    expect(p("Something 2026-12-31")).toMatchObject({ date: "2026-12-31" })
    expect(p("Old one 10 nov")).toMatchObject({ date: "2027-11-10" })
  })
  it("weekdays", () => {
    expect(p("Review friday")).toMatchObject({ date: "2026-11-27" })
    expect(p("Review tuesday")).toMatchObject({ date: "2026-11-24" })
    expect(p("Review next friday")).toMatchObject({ date: "2026-12-04" })
    expect(p("Plan weekend")).toMatchObject({ date: "2026-11-28" })
    expect(p("Sprint next week")).toMatchObject({ date: "2026-11-30" })
  })
  it("relative", () => {
    expect(p("Check oven in 20 minutes")).toMatchObject({ date: "2026-11-24", time: "10:20", title: "Check oven" })
    expect(p("Follow up in 3 days")).toMatchObject({ date: "2026-11-27", allDay: true })
    expect(p("Dinner tonight")).toMatchObject({ date: "2026-11-24", time: "21:00", title: "Dinner" })
    expect(p("Taxes day after tomorrow")).toMatchObject({ date: "2026-11-26" })
  })
  it("ranges and durations make events", () => {
    expect(p("Team sync 5-6pm thursday")).toMatchObject({ title: "Team sync", date: "2026-11-26", time: "17:00", endTime: "18:00", kind: "event" })
    expect(p("Workshop from 10 to 12:30 tomorrow")).toMatchObject({ time: "10:00", endTime: "12:30", date: "2026-11-25" })
    expect(p("Movie 9pm for 2h30m")).toMatchObject({ time: "21:00", endTime: "23:30" })
    expect(p("Yoga 7am for 45 min")).toMatchObject({ time: "07:00", endTime: "07:45", kind: "event" })
    expect(p("Party 10pm-1am sat")).toMatchObject({ date: "2026-11-28", time: "22:00", endTime: "01:00", endDate: "2026-11-29" })
  })
  it("does not treat counts as time ranges", () => {
    const r = p("Buy 2-3 notebooks")
    expect(r.time).toBeNull()
    expect(r.title).toBe("Buy 2-3 notebooks")
  })
  it("repeats", () => {
    expect(p("Water plants every day 8am")).toMatchObject({ rrule: "FREQ=DAILY", time: "08:00", title: "Water plants" })
    expect(p("Standup every weekday 10:30am")).toMatchObject({ rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", date: "2026-11-24", time: "10:30" })
    expect(p("Badminton every mon and wed 7pm")).toMatchObject({ rrule: "FREQ=WEEKLY;BYDAY=MO,WE", date: "2026-11-25" })
    expect(p("Rent every 1st")).toMatchObject({ rrule: "FREQ=MONTHLY;BYMONTHDAY=1", date: "2026-12-01", allDay: true })
    expect(p("Mom's birthday 12 Aug every year")).toMatchObject({ rrule: "FREQ=YEARLY", date: "2027-08-12", title: "Mom's birthday" })
    expect(p("Review every 2 weeks friday")).toMatchObject({ rrule: "FREQ=WEEKLY;INTERVAL=2" })
    expect(p("Book club every last friday 6pm")).toMatchObject({ rrule: "FREQ=MONTHLY;BYDAY=-1FR", date: "2026-11-27" })
    expect(p("Pills daily 9pm 10 times")).toMatchObject({ rrule: "FREQ=DAILY;COUNT=10" })
  })
  it("reminders, lists, stars, kind", () => {
    expect(p("Flight tomorrow 6am remind me 2 hours before alert 1 day")).toMatchObject({ reminders: [120, 1440], title: "Flight" })
    expect(p("Report friday #work !!")).toMatchObject({ list: "work", starred: true, title: "Report" })
    expect(p("task: send invoice")).toMatchObject({ kind: "task", title: "Send invoice", date: null })
    expect(p("remind me to call bank tomorrow 11am")).toMatchObject({ kind: "task", title: "Call bank", time: "11:00" })
    expect(p("Buy milk").date).toBeNull()
  })
  it("locations", () => {
    expect(p("Lunch at Cafe Mocha tomorrow 1pm")).toMatchObject({ title: "Lunch", location: "Cafe Mocha", time: "13:00" })
    expect(p("Call @Zoom 4pm")).toMatchObject({ location: "Zoom", title: "Call" })
    expect(p("Work out at gym 7am")).toMatchObject({ location: "gym", title: "Work out" })
    expect(p("Look at the report tomorrow")).toMatchObject({ location: null, title: "Look at the report" })
    expect(p("Meeting at office with Rahul 3pm")).toMatchObject({ location: "office", title: "Meeting with Rahul" })
  })
})
