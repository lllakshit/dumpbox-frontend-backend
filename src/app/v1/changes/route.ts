import { requireUser } from "@/lib/api/auth"
import { decodeCursor, encodeCursor, isChangesCursor, keysetAfter, type ChangesCursor } from "@/lib/api/cursor"
import { fromDb, handler, ok, searchParams } from "@/lib/api/http"
import { ITEM_SELECT, toApiItem, type ItemRow } from "@/lib/api/items"
import { changesSchema } from "@/lib/api/schemas"

const EPOCH = "1970-01-01T00:00:00Z"
const ZERO_ID = "00000000-0000-0000-0000-000000000000"
/** Re-read window for transactions that commit slightly after a later timestamp was handed out. */
const OVERLAP_MS = 5_000
const MAX_PAGE_BYTES = 3_000_000
const TOMBSTONE_KEEP_MS = 85 * 86_400_000

function minus(iso: string, ms: number) {
  return new Date(new Date(iso).getTime() - ms).toISOString()
}

/**
 * GET /v1/changes?since=<token> — everything that changed since the token: items (including trashed ones, with
 * `deleted_at` set) and ids of items removed for good. Call without `since` for a full sync. Keep calling with
 * `next_since` while `has_more` is true. Clients apply items by id and ignore ones whose `version` is not newer
 * than what they hold, so overlapping pages are harmless.
 */
export const GET = handler(async (request: Request) => {
  const { db } = await requireUser(request)
  const q = changesSchema.parse(Object.fromEntries(searchParams(request)))
  const since = decodeCursor(q.since, isChangesCursor) ?? { u: EPOCH, i: ZERO_ID, t: EPOCH, tail: false }

  if (q.start === "now" && !q.since) {
    const now = new Date().toISOString()
    const token: ChangesCursor = { u: now, i: ZERO_ID, t: now, tail: true, s: now }
    return ok({ items: [], deleted_ids: [], next_since: encodeCursor(token), has_more: false, reset: false, server_time: now })
  }

  // Tombstones are kept for 90 days; a device away longer must drop its cache and sync from scratch.
  if (since.s && Date.now() - new Date(since.s).getTime() > TOMBSTONE_KEEP_MS) {
    return ok({ items: [], deleted_ids: [], next_since: null, has_more: false, reset: true, server_time: new Date().toISOString() })
  }

  // When the previous page said "caught up", look back a few seconds in case a slow transaction committed late.
  const itemFrom = since.tail ? { u: minus(since.u, OVERLAP_MS), i: ZERO_ID } : { u: since.u, i: since.i }
  const tombFrom = since.tail ? minus(since.t, OVERLAP_MS) : since.t

  const [itemsRes, tombRes] = await Promise.all([
    db
      .from("items")
      .select(ITEM_SELECT)
      .or(keysetAfter(itemFrom))
      .order("updated_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(q.limit + 1),
    db
      .from("item_tombstones")
      .select("item_id,deleted_at")
      .gt("deleted_at", tombFrom)
      .order("deleted_at", { ascending: true })
      .limit(q.limit + 1),
  ])
  if (itemsRes.error) throw fromDb(itemsRes.error)
  if (tombRes.error) throw fromDb(tombRes.error)

  const rows = itemsRes.data as unknown as ItemRow[]
  const tombs = (tombRes.data ?? []) as { item_id: string; deleted_at: string }[]
  // Keep each page well under the 4.5 MB serverless response limit: stop early when items are large.
  const itemPage: ItemRow[] = []
  let bytes = 0
  for (const r of rows.slice(0, q.limit)) {
    const size = JSON.stringify(r).length
    if (itemPage.length > 0 && bytes + size > MAX_PAGE_BYTES) break
    itemPage.push(r)
    bytes += size
  }
  const tombPage = tombs.slice(0, q.limit)
  const hasMore = rows.length > itemPage.length || tombs.length > q.limit

  const lastItem = itemPage.at(-1)
  const lastTomb = tombPage.at(-1)
  const next: ChangesCursor = {
    u: lastItem?.updated_at ?? since.u,
    i: lastItem?.id ?? since.i,
    t: lastTomb?.deleted_at ?? since.t,
    tail: !hasMore,
    s: new Date().toISOString(),
  }

  return ok({
    items: itemPage.map(toApiItem),
    deleted_ids: tombPage.map((t) => t.item_id),
    next_since: encodeCursor(next),
    has_more: hasMore,
    reset: false,
    server_time: new Date().toISOString(),
  })
})
