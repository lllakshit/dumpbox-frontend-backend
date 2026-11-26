/**
 * End-to-end tests for the Email section (/v1/email). Same setup as api.test.ts (running app + local Supabase).
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
  const email = `e-${randomUUID()}@test.dev`
  const password = `pw-${randomUUID()}`
  const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error) throw error
  const anon = createClient(SB_URL, PUB, { auth: { persistSession: false } })
  const { data, error: e2 } = await anon.auth.signInWithPassword({ email, password })
  if (e2 || !data.session) throw e2 ?? new Error("no session")
  return data.session.access_token
}

async function req(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as Json }
}

const gmailThread = (id: string, over: Json = {}) => ({
  external_id: id,
  subject: "Electricity bill November",
  labels: ["Bills", "Home/Flat"],
  starred: false,
  important: true,
  unread: true,
  priority: 1,
  messages: [
    { external_id: `${id}-1`, from: "BESCOM <billing@bescom.in>", to: "me@x.com", sent_at: "2026-11-20T08:00:00Z", body_text: "Your bill of Rs 1,240 is due on 30 Nov." },
    { external_id: `${id}-2`, from: "Me <me@x.com>", to: "billing@bescom.in", sent_at: "2026-11-21T09:30:00Z", body_text: "Paid today, reference 77812." },
  ],
  ...over,
})

let A = ""
let B = ""
let keyA = ""

beforeAll(async () => {
  ;[A, B] = await Promise.all([makeUser(), makeUser()])
  const r = await req("POST", "/v1/email/import-keys", A, { label: "Test Gmail" })
  expect(r.status).toBe(201)
  keyA = r.json.key
})

describe("email", () => {
  it("refuses an import without a valid key, and a sign-in token is not a key", async () => {
    expect((await req("POST", "/v1/email/import", null, { threads: [gmailThread("x")] })).status).toBe(401)
    expect((await req("POST", "/v1/email/import", "A".repeat(43), { threads: [gmailThread("x")] })).status).toBe(401)
    expect((await req("POST", "/v1/email/import", A, { threads: [gmailThread("x")] })).status).toBe(401)
  })

  it("lists keys without the key itself", async () => {
    const r = await req("GET", "/v1/email/import-keys", A)
    expect(r.status).toBe(200)
    expect(r.json.keys).toHaveLength(1)
    expect(JSON.stringify(r.json)).not.toContain(keyA)
  })

  it("imports a conversation once, then updates it in place", async () => {
    const first = await req("POST", "/v1/email/import", keyA, { threads: [gmailThread("t-1")] })
    expect(first.status).toBe(200)
    expect(first.json).toMatchObject({ created: 1, updated: 0, skipped: 0, messages: 2 })

    const list = await req("GET", "/v1/email/threads", A)
    expect(list.json.threads).toHaveLength(1)
    const t = list.json.threads[0]
    expect(t).toMatchObject({ subject: "Electricity bill November", labels: ["Bills", "Home/Flat"], priority: 1, fresh: true, message_count: 2, from_email: "me@x.com" })
    expect(t).not.toHaveProperty("search_text")

    // Pin it in DumpBox, then a new message and a label change arrive from Gmail.
    expect((await req("PATCH", `/v1/email/threads/${t.id}`, A, { pinned: true })).json.thread.pinned).toBe(true)
    const again = gmailThread("t-1", {
      labels: ["Bills"],
      messages: [...gmailThread("t-1").messages, { external_id: "t-1-3", from: "BESCOM <billing@bescom.in>", to: "me@x.com", sent_at: "2026-11-22T10:00:00Z", body_text: "Payment received." }],
    })
    const second = await req("POST", "/v1/email/import", keyA, { threads: [again] })
    expect(second.json).toMatchObject({ created: 0, updated: 1, messages: 3 })

    const one = await req("GET", `/v1/email/threads/${t.id}`, A)
    expect(one.status).toBe(200)
    expect(one.json.thread).toMatchObject({ labels: ["Bills"], pinned: true, message_count: 3, fresh: false })
    expect(one.json.messages.map((m: Json) => m.external_id)).toEqual(["t-1-1", "t-1-2", "t-1-3"])
    expect(one.json.messages[0]).toMatchObject({ from_name: "BESCOM", from_email: "billing@bescom.in" })
  })

  it("filters by label, priority, view and text", async () => {
    await req("POST", "/v1/email/import", keyA, {
      threads: [gmailThread("t-2", { subject: "Flight to Goa", labels: ["Travel"], priority: null, unread: false, messages: [{ external_id: "t-2-1", from: "IndiGo <no-reply@goindigo.in>", sent_at: "2026-11-23T06:00:00Z", body_text: "PNR X7Y8Z9" }] })],
    })
    const names = async (q: string) => (await req("GET", `/v1/email/threads?${q}`, A)).json.threads.map((t: Json) => t.subject)
    expect(await names("label=Travel")).toEqual(["Flight to Goa"])
    expect(await names("priority=1")).toEqual(["Electricity bill November"])
    expect(await names("q=x7y8")).toEqual(["Flight to Goa"])
    expect(await names("q=50%25")).toEqual([])
    expect(await names("view=pinned")).toEqual(["Electricity bill November"])

    const c = (await req("GET", "/v1/email/counts", A)).json
    expect(c.all.total).toBe(2)
    expect(c.labels.map((l: Json) => l.name)).toEqual(["Bills", "Travel"])
    expect(c.priorities.find((p: Json) => p.priority === 1).total).toBe(1)
  })

  it("archive hides it until newer mail arrives", async () => {
    const t = (await req("GET", "/v1/email/threads?label=Travel", A)).json.threads[0]
    await req("PATCH", `/v1/email/threads/${t.id}`, A, { archived: true })
    expect((await req("GET", "/v1/email/threads?label=Travel", A)).json.threads).toHaveLength(0)
    expect((await req("GET", "/v1/email/threads?view=archived", A)).json.threads).toHaveLength(1)
    await req("POST", "/v1/email/import", keyA, {
      threads: [gmailThread("t-2", { subject: "Flight to Goa", labels: ["Travel"], priority: null, messages: [{ external_id: "t-2-2", from: "IndiGo <no-reply@goindigo.in>", sent_at: "2026-11-24T06:00:00Z", body_text: "Check-in open" }] })],
    })
    expect((await req("GET", "/v1/email/threads?label=Travel", A)).json.threads).toHaveLength(1)
  })

  it("delete removes the content for good and the import does not bring it back", async () => {
    const t = (await req("GET", "/v1/email/threads?label=Travel", A)).json.threads[0]
    expect((await req("DELETE", `/v1/email/threads/${t.id}`, A)).status).toBe(204)
    expect((await req("GET", `/v1/email/threads/${t.id}`, A)).status).toBe(404)
    const r = await req("POST", "/v1/email/import", keyA, { threads: [gmailThread("t-2", { labels: ["Travel"] })] })
    expect(r.json).toMatchObject({ created: 0, updated: 0, skipped: 1 })
    expect((await req("GET", "/v1/email/threads?label=Travel", A)).json.threads).toHaveLength(0)
    const admin = createClient(SB_URL, SECRET, { auth: { persistSession: false } })
    const { data } = await admin.from("email_messages").select("id").eq("thread_id", t.id)
    expect(data).toEqual([])
  })

  it("keeps one person's mail from another", async () => {
    const t = (await req("GET", "/v1/email/threads", A)).json.threads[0]
    expect((await req("GET", `/v1/email/threads/${t.id}`, B)).status).toBe(404)
    expect((await req("PATCH", `/v1/email/threads/${t.id}`, B, { pinned: false })).status).toBe(404)
    expect((await req("DELETE", `/v1/email/threads/${t.id}`, B)).status).toBe(404)
    expect((await req("GET", "/v1/email/threads", B)).json.threads).toEqual([])
    expect((await req("GET", "/v1/email/counts", B)).json.all.total).toBe(0)
    // B's own key writes only into B's mail, even with the same Gmail ids.
    const keyB = (await req("POST", "/v1/email/import-keys", B, {})).json.key
    expect((await req("POST", "/v1/email/import", keyB, { threads: [gmailThread("t-1")] })).json.created).toBe(1)
    expect((await req("GET", `/v1/email/threads/${t.id}`, A)).json.thread.labels).toEqual(["Bills"])
  })

  it("signed-in users cannot write mail directly", async () => {
    const client = createClient(SB_URL, PUB, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${A}` } } })
    const { data: me } = await client.auth.getUser(A)
    const ins = await client.from("email_threads").insert({ user_id: me.user!.id, external_id: "forged", subject: "x" })
    expect(ins.error).not.toBeNull()
    const t = (await req("GET", "/v1/email/threads", A)).json.threads[0]
    const upd = await client.from("email_threads").update({ starred: true, unread: false }).eq("id", t.id)
    expect(upd.error).not.toBeNull()
    const msg = await client.from("email_messages").insert({ user_id: me.user!.id, thread_id: t.id, external_id: "forged", sent_at: new Date().toISOString() })
    expect(msg.error).not.toBeNull()
    expect((await client.from("email_threads").update({ subject: "edited" }).eq("id", t.id)).error).not.toBeNull()
    expect((await client.from("email_threads").update({ deleted_at: null }).eq("id", t.id)).error).not.toBeNull()
    expect((await client.from("email_messages").delete().eq("thread_id", t.id)).error).not.toBeNull()
    expect((await client.from("email_threads").delete().eq("id", t.id)).error).not.toBeNull()
  })

  it("one odd email (NUL, half emoji, very long sender) is saved, not refused", async () => {
    const r = await req("POST", "/v1/email/import", keyA, {
      threads: [
        gmailThread("t-odd", {
          subject: "Odd\u0000 subject \ud83d",
          labels: ["Bills"],
          messages: [{ external_id: "t-odd-1", from: `"${"N".repeat(600)}" <${"e".repeat(330)}@x.com>`, sent_at: "2026-11-25T10:00:00Z", body_text: "zero\u0000byte \ud83d half" }],
        }),
      ],
    })
    expect(r.status).toBe(200)
    expect(r.json.created).toBe(1)
  })

  it("mail imported after you opened the conversation still counts as new", async () => {
    await req("POST", "/v1/email/import", keyA, { threads: [gmailThread("t-late", { labels: ["Bills"], messages: [{ external_id: "t-late-1", from: "a@b.com", sent_at: new Date(Date.now() - 600_000).toISOString(), body_text: "one" }] })] })
    const id = (await req("GET", "/v1/email/threads?q=one", A)).json.threads.find((t: Json) => t.external_id === "t-late").id
    await req("GET", `/v1/email/threads/${id}`, A) // opened now
    // A message that reached Gmail 5 minutes ago (before the open) arrives with the next import.
    await req("POST", "/v1/email/import", keyA, {
      threads: [gmailThread("t-late", { labels: ["Bills"], messages: [{ external_id: "t-late-1", from: "a@b.com", sent_at: new Date(Date.now() - 600_000).toISOString(), body_text: "one" }, { external_id: "t-late-2", from: "a@b.com", sent_at: new Date(Date.now() - 300_000).toISOString(), body_text: "two" }] })],
    })
    const list = (await req("GET", "/v1/email/threads?view=new", A)).json.threads.map((t: Json) => t.external_id)
    expect(list).toContain("t-late")
  })

  it("a conversation whose labels were removed in Gmail moves to Archived", async () => {
    await req("POST", "/v1/email/import", keyA, { threads: [gmailThread("t-late", { labels: ["Personal"], in_scope: false, messages: [{ external_id: "t-late-2", from: "a@b.com", sent_at: new Date(Date.now() - 300_000).toISOString(), body_text: "two" }] })] })
    expect((await req("GET", "/v1/email/threads", A)).json.threads.map((t: Json) => t.external_id)).not.toContain("t-late")
    expect((await req("GET", "/v1/email/threads?view=archived", A)).json.threads.map((t: Json) => t.external_id)).toContain("t-late")
  })

  it("an import racing a delete cannot write content back", async () => {
    const t = (await req("GET", "/v1/email/threads?q=zero", A)).json.threads[0]
    expect((await req("DELETE", `/v1/email/threads/${t.id}`, A)).status).toBe(204)
    // Simulate an import that read the thread before the delete and writes after it.
    const admin = createClient(SB_URL, SECRET, { auth: { persistSession: false } })
    await admin.from("email_threads").update({ subject: "back again", search_text: "back again" }).eq("id", t.id)
    await admin.from("email_messages").upsert({ user_id: t.user_id ?? (await admin.from("email_threads").select("user_id").eq("id", t.id).single()).data!.user_id, thread_id: t.id, external_id: "t-odd-late", sent_at: new Date().toISOString(), body_text: "late" }, { onConflict: "user_id,external_id" })
    const { data: row } = await admin.from("email_threads").select("subject,search_text,deleted_at").eq("id", t.id).single()
    expect(row).toMatchObject({ subject: "", search_text: "" })
    const { data: msgs } = await admin.from("email_messages").select("id").eq("thread_id", t.id)
    expect(msgs).toEqual([])
  })

  it("refuses a 6th import key instead of turning one off", async () => {
    for (let i = 0; i < 4; i++) expect((await req("POST", "/v1/email/import-keys", B, { label: `k${i}` })).status).toBe(201)
    const sixth = await req("POST", "/v1/email/import-keys", B, {})
    expect(sixth.status).toBe(409)
    expect((await req("GET", "/v1/email/import-keys", B)).json.keys).toHaveLength(5)
  })

  it("turning a key off stops imports", async () => {
    const keys = (await req("GET", "/v1/email/import-keys", A)).json.keys
    expect((await req("DELETE", `/v1/email/import-keys?id=${keys[0].id}`, A)).status).toBe(204)
    expect((await req("POST", "/v1/email/import", keyA, { threads: [gmailThread("t-9")] })).status).toBe(401)
  })
})
