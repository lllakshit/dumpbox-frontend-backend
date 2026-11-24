#!/usr/bin/env node
/**
 * Production smoke test: a temporary account goes through capture, link preview, file upload, typo search, sync,
 * a share link (open, then revoke), calendar and tasks (quick add, repeats, reminders, import, secret feed, export,
 * profile preferences), and finally deletes itself with all its data (which also checks deleting an account that
 * has planner rows).
 * Env: APP_URL, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY (to create the temporary user).
 */
const { APP_URL, SUPABASE_URL: SB, SUPABASE_PUBLISHABLE_KEY: PUB, SUPABASE_SECRET_KEY: SEC } = process.env
if (!APP_URL || !SB || !PUB || !SEC) {
  console.error("APP_URL, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and SUPABASE_SECRET_KEY are required")
  process.exit(1)
}
const B = APP_URL.replace(/\/$/, "")
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => null) })
const checks = []
const check = (name, ok, detail = "") => {
  checks.push({ name, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`)
}

const email = `smoke-${Date.now()}@dumpbox-smoke.test`
const password = `pw-${crypto.randomUUID()}`
let tok = null
const api = async (m, p, b) =>
  j(await fetch(B + p, { method: m, headers: { authorization: `Bearer ${tok}`, ...(b ? { "content-type": "application/json" } : {}) }, body: b ? JSON.stringify(b) : undefined }))

try {
  check("health", (await fetch(`${B}/v1/health`)).ok)
  check("signed-out request refused", (await fetch(`${B}/v1/items`)).status === 401)

  const created = await j(await fetch(`${SB}/auth/v1/admin/users`, { method: "POST", headers: { apikey: SEC, Authorization: `Bearer ${SEC}`, "content-type": "application/json" }, body: JSON.stringify({ email, password, email_confirm: true }) }))
  check("temporary user created", created.status < 300, String(created.status))
  const session = await j(await fetch(`${SB}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: PUB, "content-type": "application/json" }, body: JSON.stringify({ email, password }) }))
  tok = session.body?.access_token
  check("signed in", Boolean(tok))

  const id = crypto.randomUUID()
  const t0 = Date.now()
  const note = await api("POST", "/v1/items", { id, type: "note", body: "Smoke test hostel invoice October", tags: ["smoke"] })
  check("capture note", note.status === 201, `${Date.now() - t0} ms`)
  check("capture retry is idempotent", (await api("POST", "/v1/items", { id, type: "note", body: "x" })).body?.created === false)
  const link = await api("POST", "/v1/items", { type: "link", url: "https://example.com" })
  check("link preview fetched", link.body?.item?.link?.title === "Example Domain", link.body?.item?.link?.title ?? "none")

  const file = (await api("POST", "/v1/items", { type: "file" })).body.item
  const bytes = new TextEncoder().encode("%PDF-1.4 smoke")
  const up = await api("POST", "/v1/uploads", { item_id: file.id, file_name: "smoke.pdf", mime_type: "application/pdf", size_bytes: bytes.length })
  const put = await fetch(up.body.upload_url, { method: "PUT", headers: { "content-type": "application/pdf" }, body: bytes })
  const reg = await api("POST", `/v1/items/${file.id}/files`, { file_id: up.body.file_id, storage_path: up.body.storage_path, file_name: "smoke.pdf", mime_type: "application/pdf" })
  check("file upload", up.status === 201 && put.ok && reg.status === 201, `${up.status}/${put.status}/${reg.status}`)
  const urls = await api("GET", `/v1/files/${up.body.file_id}`)
  const dl = await fetch(urls.body.download_url)
  check("file download matches", new Uint8Array(await dl.arrayBuffer()).length === bytes.length)

  const s = await api("GET", "/v1/search?q=invoce")
  check("typo search", s.body?.results?.some((x) => x.item.id === id))
  const ch = await api("GET", "/v1/changes")
  check("sync pull", ch.status === 200 && ch.body.items.length === 3, `${ch.body?.items?.length} items`)

  const sh = await api("POST", "/v1/shares", { item_id: file.id, expires_in_days: 1 })
  const token = sh.body.url.split("/s/")[1]
  const pub = await j(await fetch(`${B}/v1/public/shares/${token}`))
  check("share link opens without sign-in", pub.status === 200 && pub.body.items.length === 1)
  check("share link uses the app domain", new URL(sh.body.url).origin === new URL(B).origin, sh.body.url.split("/s/")[0])
  await api("DELETE", `/v1/shares/${sh.body.share.id}`)
  check("revoked link stops working", (await fetch(`${B}/v1/public/shares/${token}`)).status === 404)
  check("cron endpoint refuses strangers", (await fetch(`${B}/v1/internal/purge`)).status === 401)

  // ---- Calendar & tasks
  const lists = await api("GET", "/v1/planner/lists")
  check("planner: default calendar and task list", lists.body?.lists?.filter((l) => l.is_default).length === 2)
  const parsed = await api("POST", "/v1/planner/parse", { text: "Dentist tomorrow 5pm remind me 1h before", time_zone: "Asia/Kolkata" })
  check("planner: quick add read", parsed.body?.entry?.title === "Dentist" && parsed.body.entry.reminders?.[0] === 60, JSON.stringify(parsed.body?.entry?.reminders))
  const ev = await api("POST", "/v1/planner/entries", { ...parsed.body.entry, list_name: undefined })
  check("planner: event saved", ev.status === 201 && ev.body.entry.start_at !== null, String(ev.status))
  const task = await api("POST", "/v1/planner/entries", { kind: "task", title: "Smoke rent", start_date: "2026-12-01", rrule: "FREQ=MONTHLY;COUNT=2", reminders: [0] })
  const done = await api("PATCH", `/v1/planner/entries/${task.body?.entry?.id}`, { completed: true })
  check("planner: repeating task makes the next one", done.body?.next_entry?.start_date === "2027-01-01", done.body?.next_entry?.start_date ?? String(done.status))
  const pch = await api("GET", "/v1/planner/changes")
  check("planner: sync pull", pch.status === 200 && pch.body.entries.length === 3, `${pch.body?.entries?.length} entries`)
  const imp = await api("POST", "/v1/planner/import", { time_zone: "Asia/Kolkata", text: "Standup every weekday 10am\ntask: renew passport 15 jan" })
  check("planner: import", imp.body?.created === 2, JSON.stringify({ created: imp.body?.created, errors: imp.body?.errors }))
  const ft = await api("POST", "/v1/planner/feed-token", { label: "smoke" })
  const feed = await j(await fetch(ft.body.json_url))
  check("planner: secret feed (no sign-in)", feed.status === 200 && feed.body.entries.length >= 4 && new URL(ft.body.json_url).origin === new URL(B).origin, `${feed.status}, ${ft.body.json_url.split("?")[0]}`)
  const ics = await (await fetch(ft.body.ics_url)).text()
  check("planner: .ics feed", ics.includes("BEGIN:VCALENDAR") && ics.includes("SUMMARY:Dentist"))
  const prefs = await api("PATCH", "/v1/me", { planner: { week_start: 0 } })
  check("profile: planner preferences saved", prefs.body?.user?.planner?.week_start === 0)
} catch (e) {
  check("unexpected error", false, e instanceof Error ? e.message : String(e))
} finally {
  if (tok) check("temporary account deleted", (await api("DELETE", "/v1/me", { confirm: "DELETE" })).status === 204)
}

const failed = checks.filter((c) => !c.ok)
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import("node:fs")
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Production smoke test: ${failed.length ? "FAILED" : "passed"}\n${checks.map((c) => `- ${c.ok ? "✅" : "❌"} ${c.name}${c.detail ? ` (${c.detail})` : ""}`).join("\n")}\n`)
}
process.exit(failed.length ? 1 : 0)
