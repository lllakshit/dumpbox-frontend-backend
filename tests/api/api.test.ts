/**
 * End-to-end API tests. Needs a running app (API_BASE, default http://localhost:3000) and local Supabase.
 * Run: npm run test:api
 */
import { createHash, randomUUID } from "node:crypto"
import { createClient } from "@supabase/supabase-js"
import { beforeAll, describe, expect, it } from "vitest"

const BASE = process.env.API_BASE ?? "http://localhost:3000"
const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321"
const PUB = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? ""
const SECRET = process.env.SUPABASE_SECRET_KEY ?? ""

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

async function makeUser() {
  const admin = createClient(SB_URL, SECRET, { auth: { persistSession: false } })
  const email = `t-${randomUUID()}@test.dev`
  const password = `pw-${randomUUID()}`
  const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error) throw error
  const anon = createClient(SB_URL, PUB, { auth: { persistSession: false } })
  const { data, error: e2 } = await anon.auth.signInWithPassword({ email, password })
  if (e2 || !data.session) throw e2 ?? new Error("no session")
  return { token: data.session.access_token, id: data.user.id }
}

function api(token: string | null) {
  return async (method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> => {
    const res = await fetch(BASE + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    return { status: res.status, json: text ? JSON.parse(text) : {} }
  }
}

let A: ReturnType<typeof api>
let B: ReturnType<typeof api>

beforeAll(async () => {
  const [a, b] = await Promise.all([makeUser(), makeUser()])
  A = api(a.token)
  B = api(b.token)
})

describe("auth", () => {
  it("rejects missing and bad tokens", async () => {
    expect((await api(null)("GET", "/v1/items")).status).toBe(401)
    const r = await api("not-a-token")("GET", "/v1/items")
    expect(r.status).toBe(401)
    expect(r.json.error.code).toBe("unauthorized")
  })
  it("health and openapi are public", async () => {
    expect((await api(null)("GET", "/v1/health")).status).toBe(200)
    expect((await api(null)("GET", "/v1/openapi.json")).json.openapi).toBe("3.1.0")
  })
})

describe("capture and feed", () => {
  it("creates a note, is idempotent on retry, and returns a validation error shape", async () => {
    const id = randomUUID()
    const first = await A("POST", "/v1/items", { id, type: "note", body: "Hostel invoice October 4200", tags: ["Bills", "hostel"] })
    expect(first.status).toBe(201)
    expect(first.json.item.tags.map((t: Json) => t.name)).toEqual(["Bills", "hostel"])
    const retry = await A("POST", "/v1/items", { id, type: "note", body: "Hostel invoice October 4200" })
    expect(retry.status).toBe(200)
    expect(retry.json.created).toBe(false)

    const bad = await A("POST", "/v1/items", { type: "note", body: " " })
    expect(bad.status).toBe(400)
    expect(bad.json.error.code).toBe("validation_failed")
  })

  it("keeps the device capture time for offline items", async () => {
    const r = await A("POST", "/v1/items", { type: "note", body: "captured offline", captured_at: "2026-01-02T03:04:05Z", source: "android" })
    expect(r.json.item.created_at.startsWith("2026-01-02T03:04:05")).toBe(true)
    expect(r.json.item.source).toBe("android")
  })

  it("stores locations and links (preview fetch never blocks capture)", async () => {
    const loc = await A("POST", "/v1/items", { type: "location", latitude: 26.9124, longitude: 75.7873, location_label: "Jaipur office" })
    expect(loc.status).toBe(201)
    expect(loc.json.item.location.label).toBe("Jaipur office")
    const link = await A("POST", "/v1/items", { type: "link", url: "http://127.0.0.1:54321/rest/v1/" })
    expect(link.status).toBe(201)
    expect(link.json.item.link.title).toBeNull() // private address: never fetched
  })

  it("pages the feed with a cursor and filters by view and type", async () => {
    for (let i = 0; i < 5; i++) await A("POST", "/v1/items", { type: "note", body: `page note ${i}` })
    const p1 = await A("GET", "/v1/items?limit=3")
    expect(p1.json.items).toHaveLength(3)
    const p2 = await A("GET", `/v1/items?limit=3&cursor=${p1.json.next_cursor}`)
    const ids1 = p1.json.items.map((i: Json) => i.id)
    expect(p2.json.items.every((i: Json) => !ids1.includes(i.id))).toBe(true)
    const places = await A("GET", "/v1/items?type=location")
    expect(places.json.items.every((i: Json) => i.type === "location")).toBe(true)
  })
})

describe("edit, versions, trash", () => {
  it("edits merge per field and keep history", async () => {
    const { json } = await A("POST", "/v1/items", { type: "note", body: "v1 text" })
    const id = json.item.id
    const v = json.item.version
    await A("PATCH", `/v1/items/${id}`, { starred: true, base_version: v }) // device 1
    const r = await A("PATCH", `/v1/items/${id}`, { body: "v2 text", base_version: v }) // device 2, stale
    expect(r.json.merged).toBe(true)
    expect(r.json.item.starred).toBe(true)
    expect(r.json.item.body).toBe("v2 text")
    const versions = await A("GET", `/v1/items/${id}/versions`)
    expect(versions.json.versions[0].body).toBe("v1 text")
  })

  it("trash, restore and permanent delete with tombstone in changes", async () => {
    const { json } = await A("POST", "/v1/items", { type: "note", body: "to be deleted" })
    const id = json.item.id
    const del = await A("DELETE", `/v1/items/${id}`)
    expect(del.json.item.deleted_at).not.toBeNull()
    expect((await A("PATCH", `/v1/items/${id}`, { body: "x" })).status).toBe(410)
    const trash = await A("GET", "/v1/items?view=trash")
    expect(trash.json.items.some((i: Json) => i.id === id)).toBe(true)
    const restored = await A("POST", `/v1/items/${id}/restore`)
    expect(restored.json.item.deleted_at).toBeNull()

    const before = await A("GET", "/v1/changes")
    let since = before.json.next_since
    while (before.json.has_more) {
      const more = await A("GET", `/v1/changes?since=${since}`)
      since = more.json.next_since
      if (!more.json.has_more) break
    }
    expect((await A("DELETE", `/v1/items/${id}?permanent=true`)).status).toBe(204)
    const after = await A("GET", `/v1/changes?since=${since}`)
    expect(after.json.deleted_ids).toContain(id)
    expect((await A("GET", `/v1/items/${id}`)).status).toBe(404)
  })
})

describe("sync tokens", () => {
  it("start=now returns an empty page positioned at the present, then picks up new items", async () => {
    const start = await A("GET", "/v1/changes?start=now")
    expect(start.json.items).toEqual([])
    const created = (await A("POST", "/v1/items", { type: "note", body: "after the token" })).json.item
    const next = await A("GET", `/v1/changes?since=${start.json.next_since}`)
    expect(next.json.items.map((i: Json) => i.id)).toContain(created.id)
    // Re-reading with the same caught-up token is harmless (overlap window): versions are unchanged.
    const again = await A("GET", `/v1/changes?since=${next.json.next_since}`)
    for (const it of again.json.items) expect(it.version).toBeGreaterThanOrEqual(1)
  })
})

describe("organize and search", () => {
  it("collections, tags and bulk actions", async () => {
    const col = await A("POST", "/v1/collections", { name: `Trip ${randomUUID().slice(0, 6)}` })
    expect(col.status).toBe(201)
    const a = (await A("POST", "/v1/items", { type: "note", body: "train ticket" })).json.item.id
    const b = (await A("POST", "/v1/items", { type: "note", body: "hotel booking" })).json.item.id
    const bulk = await A("POST", "/v1/items/bulk", { ids: [a, b], action: "add_to_collection", collection_id: col.json.collection.id })
    expect(bulk.json.affected).toBe(2)
    const inCol = await A("GET", `/v1/items?collection=${col.json.collection.id}`)
    expect(inCol.json.items.map((i: Json) => i.id).sort()).toEqual([a, b].sort())
    await A("POST", "/v1/items/bulk", { ids: [a, b], action: "add_tags", tags: ["travel"] })
    const tags = await A("GET", "/v1/tags")
    const travel = tags.json.tags.find((t: Json) => t.name === "travel")
    expect(travel.item_count).toBe(2)
    const byTag = await A("GET", `/v1/items?tag=${travel.id}`)
    expect(byTag.json.items).toHaveLength(2)
    expect((await A("POST", "/v1/tags", { name: "TRAVEL" })).status).toBe(409)
  })

  it("search finds by word, prefix, typo and tag, with highlights", async () => {
    const id = (await A("POST", "/v1/items", { type: "note", body: "October electricity bill paid 1450", tags: ["utilities"] })).json.item.id
    for (const q of ["electricity", "electr", "electrcity", "utilities"]) {
      const r = await A("GET", `/v1/search?q=${q}`)
      expect(r.json.results.some((x: Json) => x.item.id === id), q).toBe(true)
    }
    const r = await A("GET", "/v1/search?q=electricity")
    expect(r.json.results[0].highlight).toContain("<mark>")
  })
})

describe("files", () => {
  it("uploads through a signed URL, detects duplicates and blocks executables", async () => {
    const item = (await A("POST", "/v1/items", { type: "file", title: "Invoice" })).json.item
    const bytes = Buffer.from("%PDF-1.4 hello invoice")
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    const up = await A("POST", "/v1/uploads", { item_id: item.id, file_name: "invoice.pdf", mime_type: "application/pdf", size_bytes: bytes.length, sha256 })
    expect(up.status).toBe(201)
    const put = await fetch(up.json.upload_url, { method: "PUT", headers: { "content-type": "application/pdf" }, body: bytes })
    expect(put.ok).toBe(true)
    const reg = await A("POST", `/v1/items/${item.id}/files`, {
      file_id: up.json.file_id,
      storage_path: up.json.storage_path,
      file_name: "invoice.pdf",
      mime_type: "application/pdf",
      sha256,
    })
    expect(reg.status).toBe(201)
    expect(reg.json.item.files[0].size_bytes).toBe(bytes.length)

    const urls = await A("GET", `/v1/files/${up.json.file_id}`)
    const dl = await fetch(urls.json.download_url)
    expect(Buffer.from(await dl.arrayBuffer()).equals(bytes)).toBe(true)

    const other = (await A("POST", "/v1/items", { type: "file" })).json.item
    const dup = await A("POST", "/v1/uploads", { item_id: other.id, file_name: "copy.pdf", mime_type: "application/pdf", size_bytes: bytes.length, sha256 })
    expect(dup.json.duplicate_of.item_id).toBe(item.id)

    const exe = await A("POST", "/v1/uploads", { item_id: item.id, file_name: "setup.exe", mime_type: "application/octet-stream", size_bytes: 10 })
    expect(exe.status).toBe(415)
    const big = await A("POST", "/v1/uploads", { item_id: item.id, file_name: "big.zip", mime_type: "application/zip", size_bytes: 60 * 1024 * 1024 })
    expect(big.status).toBe(413)

    // A path with "..", or any other shape, is refused before anything is looked up
    const traversal = await A("POST", `/v1/items/${item.id}/files`, {
      file_id: up.json.file_id,
      storage_path: `${up.json.storage_path.split("/")[0]}/../x/${item.id}/${up.json.file_id}-a.pdf`,
      file_name: "a.pdf",
      mime_type: "application/pdf",
    })
    expect(traversal.status).toBe(400)

    // The type Storage really holds is checked, not just the claimed one
    const sneaky = (await A("POST", "/v1/items", { type: "file" })).json.item
    const up2 = await A("POST", "/v1/uploads", { item_id: sneaky.id, file_name: "pic.png", mime_type: "image/png", size_bytes: 20 })
    await fetch(up2.json.upload_url, { method: "PUT", headers: { "content-type": "text/html" }, body: "<script>alert(1)</script>" })
    const reg2 = await A("POST", `/v1/items/${sneaky.id}/files`, { file_id: up2.json.file_id, storage_path: up2.json.storage_path, file_name: "pic.png", mime_type: "image/png" })
    expect(reg2.status).toBe(415)

    // Registering a path that was never uploaded fails
    const ghost = await A("POST", `/v1/items/${item.id}/files`, {
      file_id: randomUUID(),
      storage_path: `${up.json.storage_path.split("/")[0]}/${item.id}/${randomUUID()}-x.pdf`,
      file_name: "x.pdf",
      mime_type: "application/pdf",
    })
    expect(ghost.status).toBe(400)
  })
})

describe("sharing", () => {
  it("public link shows only the shared item and stops after revoke", async () => {
    const item = (await A("POST", "/v1/items", { type: "note", body: "shared note" })).json.item
    await A("POST", "/v1/items", { type: "note", body: "private note" })
    const share = await A("POST", "/v1/shares", { item_id: item.id, expires_in_days: 7 })
    expect(share.status).toBe(201)
    const token = share.json.url.split("/s/")[1]
    const pub = await api(null)("GET", `/v1/public/shares/${token}`)
    expect(pub.status).toBe(200)
    expect(pub.json.items).toHaveLength(1)
    expect(pub.json.items[0].body).toBe("shared note")
    expect(JSON.stringify(pub.json)).not.toContain("user_id")
    const list = await A("GET", "/v1/shares")
    expect(list.json.shares.find((s: Json) => s.id === share.json.share.id).open_count).toBe(1)
    await A("DELETE", `/v1/shares/${share.json.share.id}`)
    expect((await api(null)("GET", `/v1/public/shares/${token}`)).status).toBe(404)
    expect((await api(null)("GET", "/v1/public/shares/short")).status).toBe(404)
  })
})

describe("isolation between users", () => {
  it("user B cannot read, change, tag, upload to, share or search user A's items", async () => {
    const item = (await A("POST", "/v1/items", { type: "note", body: "A secret zebra note" })).json.item
    expect((await B("GET", `/v1/items/${item.id}`)).status).toBe(404)
    expect((await B("PATCH", `/v1/items/${item.id}`, { body: "pwned" })).status).toBe(404)
    expect((await B("DELETE", `/v1/items/${item.id}`)).status).toBe(404)
    expect((await B("PUT", `/v1/items/${item.id}/tags`, { tags: ["x"] })).status).toBe(404)
    expect((await B("POST", "/v1/uploads", { item_id: item.id, file_name: "a.pdf", mime_type: "application/pdf", size_bytes: 1 })).status).toBe(404)
    expect((await B("POST", "/v1/shares", { item_id: item.id })).status).toBe(404)
    expect((await B("GET", "/v1/search?q=zebra")).json.results).toHaveLength(0)
    const bulk = await B("POST", "/v1/items/bulk", { ids: [item.id], action: "delete" })
    expect(bulk.json.affected).toBe(0)
    const changes = await B("GET", "/v1/changes")
    expect(changes.json.items.some((i: Json) => i.id === item.id)).toBe(false)
    expect((await A("GET", `/v1/items/${item.id}`)).json.item.body).toBe("A secret zebra note")
    // B creating an item with A's id must not overwrite it
    const clash = await B("POST", "/v1/items", { id: item.id, type: "note", body: "clash" })
    expect([400, 404, 409]).toContain(clash.status)
    expect((await A("GET", `/v1/items/${item.id}`)).json.item.body).toBe("A secret zebra note")
  })
})

describe("account", () => {
  it("returns profile with usage and exports JSON", async () => {
    const me = await A("GET", "/v1/me")
    expect(me.json.usage.items).toBeGreaterThan(0)
    const ex = await A("GET", "/v1/export")
    expect(ex.json.format).toBe("dumpbox-export")
    expect(ex.json.next_page).toBeNull()
    expect(ex.json.items.length).toBeGreaterThan(0)
  })
  it("deletes an account only with confirmation", async () => {
    const c = await makeUser()
    const C = api(c.token)
    await C("POST", "/v1/items", { type: "note", body: "temp" })
    expect((await C("DELETE", "/v1/me", {})).status).toBe(400)
    expect((await C("DELETE", "/v1/me", { confirm: "DELETE" })).status).toBe(204)
  })
})
