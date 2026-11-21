import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import { ApiError, fromDb } from "./http"

/** Columns read for an item, with tags, collections and files embedded. Search columns are never returned. */
export const ITEM_SELECT = [
  "id",
  "type",
  "title",
  "body",
  "source",
  "url",
  "link_title",
  "link_description",
  "link_image_url",
  "link_site",
  "latitude",
  "longitude",
  "location_label",
  "pinned",
  "starred",
  "archived_at",
  "deleted_at",
  "version",
  "created_at",
  "updated_at",
  "item_tags(tags(id,name,color))",
  "item_collections(collection_id)",
  "files(id,file_name,mime_type,size_bytes,sha256,width,height,created_at)",
].join(",")

export type ItemRow = {
  id: string
  type: string
  title: string | null
  body: string | null
  source: string
  url: string | null
  link_title: string | null
  link_description: string | null
  link_image_url: string | null
  link_site: string | null
  latitude: number | null
  longitude: number | null
  location_label: string | null
  pinned: boolean
  starred: boolean
  archived_at: string | null
  deleted_at: string | null
  version: number
  created_at: string
  updated_at: string
  item_tags?: { tags: { id: string; name: string; color: string | null } | null }[]
  item_collections?: { collection_id: string }[]
  files?: {
    id: string
    file_name: string
    mime_type: string
    size_bytes: number
    sha256: string | null
    width: number | null
    height: number | null
    created_at: string
  }[]
}

export type ApiItem = ReturnType<typeof toApiItem>

/** The public shape of an item in every /v1 response. */
export function toApiItem(row: ItemRow) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    source: row.source,
    url: row.url,
    link: row.url
      ? { title: row.link_title, description: row.link_description, image_url: row.link_image_url, site: row.link_site }
      : null,
    location:
      row.latitude != null && row.longitude != null
        ? { latitude: row.latitude, longitude: row.longitude, label: row.location_label }
        : null,
    pinned: row.pinned,
    starred: row.starred,
    archived_at: row.archived_at,
    deleted_at: row.deleted_at,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    tags: (row.item_tags ?? [])
      .map((t) => t.tags)
      .filter((t): t is NonNullable<typeof t> => Boolean(t))
      .sort((a, b) => a.name.localeCompare(b.name)),
    collection_ids: (row.item_collections ?? []).map((c) => c.collection_id),
    files: [...(row.files ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at)),
  }
}

export async function getItem(db: SupabaseClient, id: string) {
  const { data, error } = await db.from("items").select(ITEM_SELECT).eq("id", id).maybeSingle()
  if (error) throw fromDb(error, "Item not found")
  if (!data) throw new ApiError("not_found", "Item not found")
  return toApiItem(data as unknown as ItemRow)
}

export async function getItems(db: SupabaseClient, ids: string[]) {
  if (!ids.length) return []
  const { data, error } = await db.from("items").select(ITEM_SELECT).in("id", ids)
  if (error) throw fromDb(error)
  const byId = new Map((data as unknown as ItemRow[]).map((r) => [r.id, toApiItem(r)]))
  return ids.map((id) => byId.get(id)).filter((x): x is ApiItem => Boolean(x))
}

/**
 * Finds the caller's tags by name (case-insensitive) and creates the missing ones. Returns their ids in input order.
 * Tag lists are small, so matching in memory avoids an expression index lookup through PostgREST.
 */
export async function ensureTags(db: SupabaseClient, names: string[]): Promise<string[]> {
  const wanted = [...new Map(names.map((n) => [n.trim().toLowerCase(), n.trim()])).values()].filter(Boolean)
  if (!wanted.length) return []
  const load = async () => {
    const { data, error } = await db.from("tags").select("id,name")
    if (error) throw fromDb(error)
    return new Map((data ?? []).map((t) => [t.name.toLowerCase(), t.id as string]))
  }
  let existing = await load()
  const missing = wanted.filter((n) => !existing.has(n.toLowerCase()))
  if (missing.length) {
    const { error } = await db.from("tags").insert(missing.map((name) => ({ name })))
    // A parallel request may have created the same tag; reload and continue.
    if (error && error.code !== "23505") throw fromDb(error)
    existing = await load()
  }
  return wanted.map((n) => existing.get(n.toLowerCase())).filter((x): x is string => Boolean(x))
}

/** Replaces an item's tags with exactly `names`. */
export async function setItemTags(db: SupabaseClient, itemId: string, names: string[]) {
  const tagIds = await ensureTags(db, names)
  const { data: current, error } = await db.from("item_tags").select("tag_id").eq("item_id", itemId)
  if (error) throw fromDb(error)
  const have = new Set((current ?? []).map((r) => r.tag_id as string))
  const want = new Set(tagIds)
  const toRemove = [...have].filter((id) => !want.has(id))
  const toAdd = [...want].filter((id) => !have.has(id))
  if (toRemove.length) {
    const { error: e } = await db.from("item_tags").delete().eq("item_id", itemId).in("tag_id", toRemove)
    if (e) throw fromDb(e)
  }
  if (toAdd.length) {
    const { error: e } = await db.from("item_tags").insert(toAdd.map((tag_id) => ({ item_id: itemId, tag_id })))
    if (e && e.code !== "23505") throw fromDb(e, "Item not found")
  }
}

/** Replaces an item's collections with exactly `collectionIds`. */
export async function setItemCollections(db: SupabaseClient, itemId: string, collectionIds: string[]) {
  const { data: current, error } = await db.from("item_collections").select("collection_id").eq("item_id", itemId)
  if (error) throw fromDb(error)
  const have = new Set((current ?? []).map((r) => r.collection_id as string))
  const want = new Set(collectionIds)
  const toRemove = [...have].filter((id) => !want.has(id))
  const toAdd = [...want].filter((id) => !have.has(id))
  if (toRemove.length) {
    const { error: e } = await db.from("item_collections").delete().eq("item_id", itemId).in("collection_id", toRemove)
    if (e) throw fromDb(e)
  }
  if (toAdd.length) {
    const { error: e } = await db
      .from("item_collections")
      .insert(toAdd.map((collection_id) => ({ item_id: itemId, collection_id })))
    if (e && e.code !== "23505") throw fromDb(e, "Item or collection not found")
  }
}
