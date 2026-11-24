/**
 * End-to-end tests for /v1/planner. Same setup as api.test.ts (running app + local Supabase).
 */
import { randomUUID } from "node:crypto"
import { createClient } from "@supabase/supabase-js"
import { beforeAll, describe, expect, it } from "vitest"

const BASE = process.env.API_BASE ?? "http://localhost:3000"
const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321"
const PUB = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? ""
const SECRET = process.env.SUPABASE_SECRET_KEY ?? ""

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

async function makeUser() {
  const admin = createClient(SB_URL, SECRET, { auth: { persistSession: false } })
  const email = `p-${randomUUID()}@test.dev`
  const password = `pw-${randomUUID()}`
  const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error) throw error
  const anon = createClient(SB_URL, PUB, { auth: { persistSession: false } })
  const { data, error: e2 } = await anon.auth.signInWithPassword({ email, password })
  if (e2 || !data.session) throw e2 ?? new Error("no session")
  return data.session.access_token
}

function api(token: string) {
  return async (method: string, path: string, body?: unknown): Promise<{ status: number; json: Json; text: string }> => {
    const res = await fetch(BASE + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let json: Json = {}
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      // not JSON (ics export)
    }
    return { status: res.status, json, text }
  }
}

let A: ReturnType<typeof api>
let B: ReturnType<typeof api>

beforeAll(async () => {
  const [a, b] = await Promise.all([makeUser(), makeUser()])
  A = api(a)
  B = api(b)
})

describe("planner", () => {
  it("creates default lists on first use", async () => {
    const r = await A("GET", "/v1/planner/lists")
    expect(r.status).toBe(200)
    const kinds = r.json.lists.filter((l: Json) => l.is_default).map((l: Json) => l.kind).sort()
    expect(kinds).toEqual(["calendar", "tasks"])
  })

  it("creates an event idempotently and keeps it private", async () => {
    const id = randomUUID()
    const body = { id, kind: "event", title: "Dentist", start_at: "2026-12-01T04:30:00Z", end_at: "2026-12-01T05:30:00Z", reminders: [60, 10, 10], time_zone: "Asia/Kolkata" }
    const r1 = await A("POST", "/v1/planner/entries", body)
    expect(r1.status).toBe(201)
    expect(r1.json.entry).toMatchObject({ id, kind: "event", reminders: [10, 60], all_day: false })
    expect(r1.json.entry.list_id).toBeTruthy()
    const r2 = await A("POST", "/v1/planner/entries", body)
    expect(r2.status).toBe(200)
    expect(r2.json.created).toBe(false)
    expect((await B("GET", `/v1/planner/entries/${id}`)).status).toBe(404)
    expect((await B("PATCH", `/v1/planner/entries/${id}`, { title: "x" })).status).toBe(404)
  })

  it("validates timing", async () => {
    expect((await A("POST", "/v1/planner/entries", { kind: "event", title: "No time" })).status).toBe(400)
    expect((await A("POST", "/v1/planner/entries", { kind: "event", title: "Back", start_at: "2026-12-01T10:00:00Z", end_at: "2026-12-01T09:00:00Z" })).status).toBe(400)
    expect((await A("POST", "/v1/planner/entries", { kind: "task", title: "Bad rule", start_date: "2026-12-01", rrule: "FREQ=SECONDLY" })).status).toBe(400)
    const allDay = await A("POST", "/v1/planner/entries", { kind: "event", title: "Trip", all_day: true, start_date: "2026-12-20", end_date: "2026-12-22" })
    expect(allDay.json.entry).toMatchObject({ all_day: true, start_at: null, start_date: "2026-12-20", end_date: "2026-12-22" })
  })

  it("completing a repeating task creates the next one", async () => {
    const t = await A("POST", "/v1/planner/entries", { kind: "task", title: "Pay rent", start_date: "2026-12-01", rrule: "FREQ=MONTHLY;COUNT=3" })
    const r = await A("PATCH", `/v1/planner/entries/${t.json.entry.id}`, { completed: true })
    expect(r.status).toBe(200)
    expect(r.json.entry.completed_at).toBeTruthy()
    expect(r.json.entry.rrule).toBeNull()
    expect(r.json.next_entry).toMatchObject({ title: "Pay rent", start_date: "2027-01-01", rrule: "FREQ=MONTHLY;COUNT=2", completed_at: null })
  })

  it("subtasks follow their parent into the bin and back", async () => {
    const p = await A("POST", "/v1/planner/entries", { kind: "task", title: "Trip prep" })
    const c = await A("POST", "/v1/planner/entries", { kind: "task", title: "Pack", parent_id: p.json.entry.id })
    expect(c.status).toBe(201)
    expect((await A("DELETE", `/v1/planner/entries/${p.json.entry.id}`)).json.entry.deleted_at).toBeTruthy()
    expect((await A("GET", `/v1/planner/entries/${c.json.entry.id}`)).json.entry.deleted_at).toBeTruthy()
    await A("PATCH", `/v1/planner/entries/${p.json.entry.id}`, { deleted: false })
    expect((await A("GET", `/v1/planner/entries/${c.json.entry.id}`)).json.entry.deleted_at).toBeNull()
    // Another user's task cannot be a parent.
    expect((await B("POST", "/v1/planner/entries", { kind: "task", title: "Sneaky", parent_id: p.json.entry.id })).status).toBe(404)
  })

  it("changes feed pages and includes binned entries", async () => {
    const first = await A("GET", "/v1/planner/changes")
    expect(first.status).toBe(200)
    expect(first.json.entries.length).toBeGreaterThan(3)
    expect(first.json.lists.length).toBeGreaterThanOrEqual(2)
    const since = first.json.next_since
    const e = await A("POST", "/v1/planner/entries", { kind: "task", title: "New after sync" })
    await A("DELETE", `/v1/planner/entries/${e.json.entry.id}`)
    const next = await A("GET", `/v1/planner/changes?since=${since}`)
    const hit = next.json.entries.find((x: Json) => x.id === e.json.entry.id)
    expect(hit.deleted_at).toBeTruthy()
    expect((await B("GET", "/v1/planner/changes")).json.entries).toEqual([])
  })

  it("range query returns overlapping and repeating entries", async () => {
    await A("POST", "/v1/planner/entries", { kind: "event", title: "Weekly sync", start_at: "2026-01-05T05:00:00Z", end_at: "2026-01-05T05:30:00Z", rrule: "FREQ=WEEKLY" })
    const r = await A("GET", "/v1/planner/entries?from=2026-12-01&to=2026-12-31")
    const titles = r.json.entries.map((e: Json) => e.title)
    expect(titles).toContain("Weekly sync")
    expect(titles).toContain("Trip")
    expect(titles).toContain("Dentist")
  })

  it("parses quick add text", async () => {
    const r = await A("POST", "/v1/planner/parse", { text: "Lunch with Rahul tomorrow 1pm remind me 15 min before", time_zone: "Asia/Kolkata", now: "2026-11-24T04:30:00Z" })
    expect(r.status).toBe(200)
    expect(r.json.entry).toMatchObject({ kind: "event", title: "Lunch with Rahul", start_at: "2026-11-25T07:30:00.000Z", end_at: "2026-11-25T08:30:00.000Z", reminders: [15] })
  })

  it("imports JSON (dry run, then for real, then again without duplicates)", async () => {
    const data = {
      events: [{ title: "Conference", date: "2027-02-10", time: "09:00", end_time: "17:00", uid: "conf-2027", calendar: "Work" }],
      tasks: [{ title: "Book hotel", due: "2027-01-15", list: "Travel" }, { title: "No title missing" }],
    }
    const dry = await A("POST", "/v1/planner/import", { data, dry_run: true, time_zone: "Asia/Kolkata" })
    expect(dry.json).toMatchObject({ dry_run: true, events: 1, tasks: 2 })
    const real = await A("POST", "/v1/planner/import", { data, time_zone: "Asia/Kolkata" })
    expect(real.json).toMatchObject({ created: 3, updated: 0 })
    expect(real.json.lists.map((l: Json) => l.name)).toEqual(expect.arrayContaining(["Work", "Travel"]))
    const again = await A("POST", "/v1/planner/import", { data, time_zone: "Asia/Kolkata" })
    expect(again.json.updated).toBe(1)
    const ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x1\r\nSUMMARY:From ICS\r\nDTSTART:20270301T100000Z\r\nDTEND:20270301T110000Z\r\nEND:VEVENT\r\nEND:VCALENDAR"
    const fromIcs = await A("POST", "/v1/planner/import", { text: ics })
    expect(fromIcs.json).toMatchObject({ format: "ics", created: 1 })
  })

  it("exports JSON and ICS", async () => {
    const j = await A("GET", "/v1/planner/export?format=json")
    expect(j.json.format).toBe("dumpbox-planner")
    expect(j.json.entries.length).toBeGreaterThan(3)
    const i = await A("GET", "/v1/planner/export?format=ics")
    expect(i.text).toContain("BEGIN:VCALENDAR")
    expect(i.text).toContain("SUMMARY:Dentist")
  })

  it("lists: create, rename, cannot delete default, delete bins its entries", async () => {
    const l = await A("POST", "/v1/planner/lists", { kind: "calendar", name: "Gym" })
    expect(l.status).toBe(201)
    const e = await A("POST", "/v1/planner/entries", { kind: "event", title: "Leg day", start_at: "2026-12-02T01:00:00Z", list_id: l.json.list.id })
    expect(e.json.entry.list_id).toBe(l.json.list.id)
    expect((await A("PATCH", `/v1/planner/lists/${l.json.list.id}`, { name: "Fitness", color: "#1e8a52" })).json.list.name).toBe("Fitness")
    const lists = (await A("GET", "/v1/planner/lists")).json.lists as Json[]
    const def = lists.find((x) => x.kind === "calendar" && x.is_default)!
    expect((await A("DELETE", `/v1/planner/lists/${def.id}`)).status).toBe(409)
    expect((await A("DELETE", `/v1/planner/lists/${l.json.list.id}`)).status).toBe(204)
    expect((await A("GET", `/v1/planner/entries/${e.json.entry.id}`)).json.entry.deleted_at).toBeTruthy()
  })

  it("saves planner preferences in the profile", async () => {
    const r = await A("PATCH", "/v1/me", { planner: { week_start: 0, default_event_reminders: [30] } })
    expect(r.json.user.planner).toMatchObject({ week_start: 0, default_event_reminders: [30], default_event_minutes: 60 })
    expect((await A("GET", "/v1/me")).json.user.planner.week_start).toBe(0)
  })
})

describe("planner feed", () => {
  it("secret address reads only its owner's calendar and can be turned off", async () => {
    await A("POST", "/v1/planner/entries", { kind: "event", title: "Feed check", start_at: "2026-12-05T04:30:00Z" })
    const t = await A("POST", "/v1/planner/feed-token")
    expect(t.status).toBe(201)
    expect(t.json.ics_url).toContain("format=ics")
    const res = await fetch(`${BASE}/v1/planner/feed?token=${t.json.token}`)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.entries.map((e: Json) => e.title)).toContain("Feed check")
    expect(body.prefs.all_day_reminder_time).toBeTruthy()
    const ics = await (await fetch(`${BASE}/v1/planner/feed?token=${t.json.token}&format=ics`)).text()
    expect(ics).toContain("SUMMARY:Feed check")
    expect((await fetch(`${BASE}/v1/planner/feed?token=${"x".repeat(43)}`)).status).toBe(404)
    expect((await B("GET", "/v1/planner/feed-token")).json.active).toBe(false)
    expect((await A("DELETE", "/v1/planner/feed-token")).status).toBe(204)
    expect((await fetch(`${BASE}/v1/planner/feed?token=${t.json.token}`)).status).toBe(404)
  })
})
