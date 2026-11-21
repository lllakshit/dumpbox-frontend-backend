#!/usr/bin/env node
/**
 * Production smoke test: a temporary account goes through capture, link preview, file upload, typo search, sync,
 * a share link (open, then revoke), and finally deletes itself with all its data.
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
