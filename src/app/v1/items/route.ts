import { requireUser } from "@/lib/api/auth"
import { decodeCursor, encodeCursor, isFeedCursor, keysetBefore } from "@/lib/api/cursor"
import { ApiError, fromDb, handler, ok, readJson, searchParams } from "@/lib/api/http"
import { ITEM_SELECT, getItem, setItemCollections, setItemTags, toApiItem, type ItemRow } from "@/lib/api/items"
import { createItemSchema, listItemsSchema } from "@/lib/api/schemas"
import { fetchLinkPreview } from "@/lib/link-preview"

/** GET /v1/items — the feed, newest first, cursor-paginated. */
export const GET = handler(async (request: Request) => {
  const { db } = await requireUser(request)
  const q = listItemsSchema.parse(Object.fromEntries(searchParams(request)))

  let select = ITEM_SELECT
  if (q.tag) select += ",tag_filter:item_tags!inner(tag_id)"
  if (q.collection) select += ",collection_filter:item_collections!inner(collection_id)"

  let query = db.from("items").select(select)
  if (q.tag) query = query.eq("tag_filter.tag_id", q.tag)
  if (q.collection) query = query.eq("collection_filter.collection_id", q.collection)

  switch (q.view) {
    case "feed":
      query = query.is("deleted_at", null).is("archived_at", null)
      break
    case "pinned":
      query = query.is("deleted_at", null).eq("pinned", true)
      break
    case "starred":
      query = query.is("deleted_at", null).eq("starred", true)
      break
    case "archived":
      query = query.is("deleted_at", null).not("archived_at", "is", null)
      break
    case "trash":
      query = query.not("deleted_at", "is", null)
      break
  }
  if (q.type?.length) query = query.in("type", q.type)

  const cursor = decodeCursor(q.cursor, isFeedCursor)
  if (cursor) query = query.or(keysetBefore(cursor))

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(q.limit + 1)
  if (error) throw fromDb(error)

  const rows = data as unknown as ItemRow[]
  const page = rows.slice(0, q.limit)
  const last = page.at(-1)
  return ok({
    items: page.map(toApiItem),
    next_cursor: rows.length > q.limit && last ? encodeCursor({ c: last.created_at, i: last.id }) : null,
  })
})

/**
 * POST /v1/items — capture. Sending the same client-generated `id` twice returns the existing item (200) instead of
 * creating a duplicate, so offline queues can retry safely.
 */
export const POST = handler(async (request: Request) => {
  const { db, userId } = await requireUser(request)
  const input = createItemSchema.parse(await readJson(request))

  if (input.id) {
    const { data: existing, error } = await db.from("items").select("id").eq("id", input.id).maybeSingle()
    if (error) throw fromDb(error)
    if (existing) return ok({ item: await getItem(db, input.id), created: false })
  }

  const preview = input.type === "link" && input.url ? await fetchLinkPreview(input.url) : null

  const row = {
    ...(input.id ? { id: input.id } : {}),
    user_id: userId,
    type: input.type,
    title: input.title?.trim() || null,
    body: input.body ?? null,
    source: input.source,
    url: input.url ?? null,
    link_title: preview?.title ?? null,
    link_description: preview?.description ?? null,
    link_image_url: preview?.image_url ?? null,
    link_site: preview?.site ?? null,
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    location_label: input.location_label?.trim() || null,
    pinned: input.pinned ?? false,
    starred: input.starred ?? false,
    ...(input.captured_at ? { created_at: input.captured_at } : {}),
  }

  const { data, error } = await db.from("items").insert(row).select("id").single()
  if (error) {
    // Same id inserted by a parallel retry: return what is there.
    if (error.code === "23505" && input.id) return ok({ item: await getItem(db, input.id), created: false })
    throw fromDb(error)
  }

  if (input.tags?.length) await setItemTags(db, data.id, input.tags)
  if (input.collection_ids?.length) await setItemCollections(db, data.id, input.collection_ids)

  const item = await getItem(db, data.id)
  if (!item) throw new ApiError("internal_error", "Item was not saved")
  return ok({ item, created: true }, 201)
})
