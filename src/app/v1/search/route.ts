import { requireUser } from "@/lib/api/auth"
import { fromDb, handler, ok, searchParams } from "@/lib/api/http"
import { getItems } from "@/lib/api/items"
import { searchSchema } from "@/lib/api/schemas"

/**
 * GET /v1/search?q=…&type=note,link&tags=…&collection=…&starred=true&from=…&to=…
 * Keyword search with prefix matching and typo tolerance across text, titles, link details, place names,
 * tag names and file names. Each result carries a `highlight` snippet with <mark> around matches.
 */
export const GET = handler(async (request: Request) => {
  const { db } = await requireUser(request)
  const q = searchSchema.parse(Object.fromEntries(searchParams(request)))

  const { data, error } = await db.rpc("search_items", {
    p_query: q.q,
    p_types: q.type ?? null,
    p_tag_ids: q.tags ?? null,
    p_collection_id: q.collection ?? null,
    p_starred: q.starred ?? null,
    p_from: q.from ?? null,
    p_to: q.to ?? null,
    p_include_archived: q.include_archived,
    p_limit: q.limit + 1,
    p_offset: q.offset,
  })
  if (error) throw fromDb(error)

  const hits = (data ?? []) as { item_id: string; rank: number; headline: string }[]
  const page = hits.slice(0, q.limit)
  const items = await getItems(
    db,
    page.map((h) => h.item_id),
  )
  const meta = new Map(page.map((h) => [h.item_id, h]))
  return ok({
    results: items.map((item) => ({ item, highlight: meta.get(item.id)?.headline ?? "", rank: meta.get(item.id)?.rank ?? 0 })),
    next_offset: hits.length > q.limit ? q.offset + q.limit : null,
  })
})
