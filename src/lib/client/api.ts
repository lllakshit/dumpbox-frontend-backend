"use client"
import { browserSupabase } from "./supabase"
import type { Collection, Item, Share, Tag } from "./types"

export class ApiFailure extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
  /** True when the request never reached the server (offline, DNS, timeout). */
  get offline() {
    return this.status === 0
  }
}

async function token(): Promise<string> {
  const { data } = await browserSupabase().auth.getSession()
  if (!data.session) throw new ApiFailure(401, "unauthorized", "Sign in again")
  return data.session.access_token
}

export async function call<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      headers: {
        ...(auth ? { authorization: `Bearer ${await token()}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch (e) {
    if (e instanceof ApiFailure) throw e
    throw new ApiFailure(0, "offline", "You are offline")
  }
  if (res.status === 204) return undefined as T
  const text = await res.text()
  const data = text ? JSON.parse(text) : {}
  if (!res.ok) throw new ApiFailure(res.status, data?.error?.code ?? "error", data?.error?.message ?? `Request failed (${res.status})`)
  return data as T
}

export const api = {
  listItems: (query: string, cursor?: string | null) =>
    call<{ items: Item[]; next_cursor: string | null }>("GET", `/v1/items?${query}&limit=40${cursor ? `&cursor=${cursor}` : ""}`),
  createItem: (body: Record<string, unknown>) => call<{ item: Item; created: boolean }>("POST", "/v1/items", body),
  updateItem: (id: string, body: Record<string, unknown>) => call<{ item: Item; merged: boolean }>("PATCH", `/v1/items/${id}`, body),
  trashItem: (id: string) => call<{ item: Item }>("DELETE", `/v1/items/${id}`),
  deleteForever: (id: string) => call<void>("DELETE", `/v1/items/${id}?permanent=true`),
  restoreItem: (id: string) => call<{ item: Item }>("POST", `/v1/items/${id}/restore`),
  versions: (id: string) =>
    call<{ versions: { version: number; title: string | null; body: string | null; created_at: string }[] }>("GET", `/v1/items/${id}/versions`),
  setTags: (id: string, tags: string[]) => call<{ item: Item }>("PUT", `/v1/items/${id}/tags`, { tags }),
  setCollections: (id: string, collection_ids: string[]) => call<{ item: Item }>("PUT", `/v1/items/${id}/collections`, { collection_ids }),
  bulk: (ids: string[], action: string, extra: Record<string, unknown> = {}) =>
    call<{ items: Item[]; affected: number }>("POST", "/v1/items/bulk", { ids, action, ...extra }),
  search: (params: URLSearchParams) =>
    call<{ results: { item: Item; highlight: string }[]; next_offset: number | null }>("GET", `/v1/search?${params}`),
  changes: (since: string | null) =>
    call<{ items: Item[]; deleted_ids: string[]; next_since: string | null; has_more: boolean; reset: boolean }>(
      "GET",
      `/v1/changes?${since ? `since=${since}` : "start=now"}`,
    ),
  tags: () => call<{ tags: Tag[] }>("GET", "/v1/tags"),
  renameTag: (id: string, name: string) => call<{ tag: Tag }>("PATCH", `/v1/tags/${id}`, { name }),
  deleteTag: (id: string) => call<void>("DELETE", `/v1/tags/${id}`),
  collections: () => call<{ collections: Collection[] }>("GET", "/v1/collections"),
  createCollection: (name: string) => call<{ collection: Collection }>("POST", "/v1/collections", { name }),
  renameCollection: (id: string, name: string) => call<{ collection: Collection }>("PATCH", `/v1/collections/${id}`, { name }),
  deleteCollection: (id: string) => call<void>("DELETE", `/v1/collections/${id}`),
  fileUrls: (id: string) => call<{ view_url: string; download_url: string }>("GET", `/v1/files/${id}`),
  requestUpload: (body: Record<string, unknown>) =>
    call<{ file_id: string; storage_path: string; upload_url: string; duplicate_of: { item_id: string } | null }>("POST", "/v1/uploads", body),
  registerFile: (itemId: string, body: Record<string, unknown>) => call<{ item: Item }>("POST", `/v1/items/${itemId}/files`, body),
  shares: () => call<{ shares: Share[] }>("GET", "/v1/shares"),
  createShare: (body: Record<string, unknown>) => call<{ share: Share; url: string }>("POST", "/v1/shares", body),
  revokeShare: (id: string) => call<{ share: Share }>("DELETE", `/v1/shares/${id}`),
  me: () =>
    call<{
      user: { id: string; email: string | null; name: string | null; time_zone: string | null }
      usage: { items: number; files: number; storage_bytes: number }
    }>("GET", "/v1/me"),
  updateMe: (body: Record<string, unknown>) => call("PATCH", "/v1/me", body),
  deleteMe: () => call<void>("DELETE", "/v1/me", { confirm: "DELETE" }),
  /** Reads every export page and returns one document. */
  exportAll: async () => {
    type Page = { next_page: number | null; items: unknown[]; tags?: unknown[]; collections?: unknown[]; exported_at: string }
    const first = await call<Page>("GET", "/v1/export?page=0")
    const items = [...first.items]
    let next = first.next_page
    while (next !== null) {
      const p = await call<Page>("GET", `/v1/export?page=${next}`)
      items.push(...p.items)
      next = p.next_page
    }
    return { format: "dumpbox-export", version: 1, exported_at: first.exported_at, items, tags: first.tags ?? [], collections: first.collections ?? [] }
  },
}

/** Hex SHA-256 of a file, for duplicate detection. */
export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer())
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/** Uploads one file into an item: ask for a signed URL, PUT the bytes, register. */
export async function uploadFile(itemId: string, file: File): Promise<{ item: Item; duplicateOf: string | null }> {
  const sha256 = file.size <= 100 * 1024 * 1024 ? await sha256Hex(file) : undefined
  const mime = file.type || "application/octet-stream"
  const up = await api.requestUpload({ item_id: itemId, file_name: file.name, mime_type: mime, size_bytes: file.size, sha256 })
  let put: Response
  try {
    put = await fetch(up.upload_url, { method: "PUT", headers: { "content-type": mime, "x-upsert": "false" }, body: file })
  } catch {
    throw new ApiFailure(0, "offline", "Upload interrupted; you are offline")
  }
  if (!put.ok) throw new ApiFailure(put.status, "upload_failed", "Upload failed")
  const dims = mime.startsWith("image/") ? await imageSize(file).catch(() => null) : null
  const { item } = await api.registerFile(itemId, {
    file_id: up.file_id,
    storage_path: up.storage_path,
    file_name: file.name,
    mime_type: mime,
    sha256,
    ...(dims ?? {}),
  })
  return { item, duplicateOf: up.duplicate_of?.item_id ?? null }
}

function imageSize(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight })
      URL.revokeObjectURL(url)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error("not an image"))
    }
    img.src = url
  })
}
