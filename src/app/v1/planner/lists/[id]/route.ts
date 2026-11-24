import { z } from "zod"
import { requireUser } from "@/lib/api/auth"
import { ApiError, fromDb, handler, noContent, ok, readJson } from "@/lib/api/http"
import { listUpdateSchema } from "@/lib/api/planner"
import { LIST_COLUMNS } from "@/lib/planner/types"

/** PATCH /v1/planner/lists/{id} — rename, recolour, hide/show, reorder. */
export const PATCH = handler(async (request: Request, ctx: RouteContext<"/v1/planner/lists/[id]">) => {
  const { db } = await requireUser(request)
  const id = z.uuid().parse((await ctx.params).id)
  const input = listUpdateSchema.parse(await readJson(request))
  const { data, error } = await db.from("planner_lists").update(input).eq("id", id).select(LIST_COLUMNS).maybeSingle()
  if (error) throw fromDb(error, "List not found")
  if (!data) throw new ApiError("not_found", "List not found")
  return ok({ list: data })
})

/**
 * DELETE /v1/planner/lists/{id} — removes a calendar or task list with everything in it (entries go to the bin
 * first, so every device learns about them). The default calendar and default task list cannot be removed.
 */
export const DELETE = handler(async (request: Request, ctx: RouteContext<"/v1/planner/lists/[id]">) => {
  const { db } = await requireUser(request)
  const id = z.uuid().parse((await ctx.params).id)
  const { data: list, error } = await db.from("planner_lists").select("id,is_default").eq("id", id).maybeSingle()
  if (error) throw fromDb(error, "List not found")
  if (!list) throw new ApiError("not_found", "List not found")
  if (list.is_default) throw new ApiError("conflict", "The default calendar and task list cannot be deleted")
  const { error: ue } = await db.from("planner_entries").update({ deleted_at: new Date().toISOString() }).eq("list_id", id).is("deleted_at", null)
  if (ue) throw fromDb(ue)
  const { error: de } = await db.from("planner_lists").delete().eq("id", id)
  if (de) throw fromDb(de)
  return noContent()
})
