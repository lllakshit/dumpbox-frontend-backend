import { z } from "zod"
import { requireUser } from "@/lib/api/auth"
import { ApiError, fromDb, handler, noContent, ok, readJson } from "@/lib/api/http"
import { collectionUpdateSchema } from "@/lib/api/schemas"

/** PATCH /v1/collections/{id} — rename or change the description. */
export const PATCH = handler(async (request: Request, ctx: RouteContext<"/v1/collections/[id]">) => {
  const { db } = await requireUser(request)
  const id = z.uuid().parse((await ctx.params).id)
  const input = collectionUpdateSchema.parse(await readJson(request))
  const { data, error } = await db
    .from("collections")
    .update(input)
    .eq("id", id)
    .select("id,name,description,created_at,updated_at")
    .maybeSingle()
  if (error) throw fromDb(error, "Collection not found")
  if (!data) throw new ApiError("not_found", "Collection not found")
  return ok({ collection: data })
})

/** DELETE /v1/collections/{id} — deletes the collection; its items stay in the feed. */
export const DELETE = handler(async (request: Request, ctx: RouteContext<"/v1/collections/[id]">) => {
  const { db } = await requireUser(request)
  const id = z.uuid().parse((await ctx.params).id)
  const { data, error } = await db.from("collections").delete().eq("id", id).select("id")
  if (error) throw fromDb(error, "Collection not found")
  if (!data?.length) throw new ApiError("not_found", "Collection not found")
  return noContent()
})
