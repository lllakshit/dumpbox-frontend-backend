import { z } from "zod"
import { requireUser } from "@/lib/api/auth"
import { BUCKET } from "@/lib/api/files"
import { ApiError, fromDb, handler, noContent, ok, readJson, searchParams } from "@/lib/api/http"
import { getItem } from "@/lib/api/items"
import { updateItemSchema } from "@/lib/api/schemas"

const idParam = z.uuid()

/** GET /v1/items/{id} */
export const GET = handler(async (request: Request, ctx: RouteContext<"/v1/items/[id]">) => {
  const { db } = await requireUser(request)
  const id = idParam.parse((await ctx.params).id)
  return ok({ item: await getItem(db, id) })
})

/**
 * PATCH /v1/items/{id} — send only the fields that changed. Edits to different fields from two devices merge
 * naturally; when both changed the same text, the latest write wins and the earlier text stays in version history.
 */
export const PATCH = handler(async (request: Request, ctx: RouteContext<"/v1/items/[id]">) => {
  const { db } = await requireUser(request)
  const id = idParam.parse((await ctx.params).id)
  const input = updateItemSchema.parse(await readJson(request))

  const before = await getItem(db, id)
  if (before.deleted_at) throw new ApiError("gone", "Item is in the trash; restore it first")

  const patch: Record<string, unknown> = {}
  if (input.title !== undefined) patch.title = input.title?.trim() || null
  if (input.body !== undefined) patch.body = input.body
  if (input.location_label !== undefined) patch.location_label = input.location_label?.trim() || null
  if (input.pinned !== undefined) patch.pinned = input.pinned
  if (input.starred !== undefined) patch.starred = input.starred
  if (input.archived !== undefined) patch.archived_at = input.archived ? (before.archived_at ?? new Date().toISOString()) : null
  if (before.type === "note" && "body" in patch && !String(patch.body ?? "").trim() && !String(patch.title ?? before.title ?? "").trim())
    throw new ApiError("validation_failed", "A note needs text")

  const { error } = await db.from("items").update(patch).eq("id", id)
  if (error) throw fromDb(error, "Item not found")

  const item = await getItem(db, id)
  return ok({ item, merged: input.base_version !== undefined && input.base_version < before.version })
})

/**
 * DELETE /v1/items/{id} — moves the item to the trash (restorable for 30 days).
 * DELETE /v1/items/{id}?permanent=true — removes it and its files now.
 */
export const DELETE = handler(async (request: Request, ctx: RouteContext<"/v1/items/[id]">) => {
  const { db } = await requireUser(request)
  const id = idParam.parse((await ctx.params).id)
  const permanent = searchParams(request).get("permanent") === "true"

  const item = await getItem(db, id)
  if (!permanent) {
    if (!item.deleted_at) {
      const { error } = await db.from("items").update({ deleted_at: new Date().toISOString(), pinned: false }).eq("id", id)
      if (error) throw fromDb(error, "Item not found")
    }
    return ok({ item: await getItem(db, id) })
  }

  const { data: files, error: fe } = await db.from("files").select("storage_path").eq("item_id", id)
  if (fe) throw fromDb(fe)
  const paths = (files ?? []).map((f) => f.storage_path as string)
  if (paths.length) {
    const { error: se } = await db.storage.from(BUCKET).remove(paths)
    if (se) throw new ApiError("internal_error", "Could not remove the item's files; try again")
  }
  const { error } = await db.from("items").delete().eq("id", id)
  if (error) throw fromDb(error, "Item not found")
  return noContent()
})
