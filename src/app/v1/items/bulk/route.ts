import { requireUser } from "@/lib/api/auth"
import { fromDb, handler, ok, readJson } from "@/lib/api/http"
import { ensureTags, getItems } from "@/lib/api/items"
import { bulkSchema } from "@/lib/api/schemas"

/** POST /v1/items/bulk — one action on many items (tag, move, pin, star, archive, trash, restore). */
export const POST = handler(async (request: Request) => {
  const { db } = await requireUser(request)
  const input = bulkSchema.parse(await readJson(request))
  const ids = [...new Set(input.ids)]

  // Only the caller's items are visible, so unknown ids are silently skipped.
  const { data: owned, error } = await db.from("items").select("id").in("id", ids)
  if (error) throw fromDb(error)
  const targets = (owned ?? []).map((r) => r.id as string)
  if (!targets.length) return ok({ items: [], affected: 0 })

  const now = new Date().toISOString()
  const update = async (patch: Record<string, unknown>, onlyWhere?: (q: ReturnType<typeof base>) => ReturnType<typeof base>) => {
    const q = base(patch)
    const { error: e } = await (onlyWhere ? onlyWhere(q) : q)
    if (e) throw fromDb(e)
  }
  const base = (patch: Record<string, unknown>) => db.from("items").update(patch).in("id", targets)

  switch (input.action) {
    case "pin":
      await update({ pinned: true })
      break
    case "unpin":
      await update({ pinned: false })
      break
    case "star":
      await update({ starred: true })
      break
    case "unstar":
      await update({ starred: false })
      break
    case "archive":
      await update({ archived_at: now }, (q) => q.is("archived_at", null))
      break
    case "unarchive":
      await update({ archived_at: null })
      break
    case "delete":
      await update({ deleted_at: now, pinned: false }, (q) => q.is("deleted_at", null))
      break
    case "restore":
      await update({ deleted_at: null })
      break
    case "add_tags": {
      const tagIds = await ensureTags(db, input.tags ?? [])
      const rows = targets.flatMap((item_id) => tagIds.map((tag_id) => ({ item_id, tag_id })))
      const { error: e } = await db.from("item_tags").upsert(rows, { onConflict: "item_id,tag_id", ignoreDuplicates: true })
      if (e) throw fromDb(e)
      break
    }
    case "remove_tags": {
      const { data: tags, error: te } = await db.from("tags").select("id,name")
      if (te) throw fromDb(te)
      const names = new Set((input.tags ?? []).map((t) => t.toLowerCase()))
      const tagIds = (tags ?? []).filter((t) => names.has(String(t.name).toLowerCase())).map((t) => t.id as string)
      if (tagIds.length) {
        const { error: e } = await db.from("item_tags").delete().in("item_id", targets).in("tag_id", tagIds)
        if (e) throw fromDb(e)
      }
      break
    }
    case "add_to_collection": {
      const rows = targets.map((item_id) => ({ item_id, collection_id: input.collection_id! }))
      const { error: e } = await db
        .from("item_collections")
        .upsert(rows, { onConflict: "item_id,collection_id", ignoreDuplicates: true })
      if (e) throw fromDb(e, "Collection not found")
      break
    }
    case "remove_from_collection": {
      const { error: e } = await db
        .from("item_collections")
        .delete()
        .in("item_id", targets)
        .eq("collection_id", input.collection_id!)
      if (e) throw fromDb(e)
      break
    }
  }

  return ok({ items: await getItems(db, targets), affected: targets.length })
})
