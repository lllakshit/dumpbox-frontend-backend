import { z } from "zod"
import { requireUser } from "@/lib/api/auth"
import { ApiError, fromDb, handler, noContent, ok, readJson } from "@/lib/api/http"
import { tagUpdateSchema } from "@/lib/api/schemas"

/** PATCH /v1/tags/{id} — rename or recolour. */
export const PATCH = handler(async (request: Request, ctx: RouteContext<"/v1/tags/[id]">) => {
  const { db } = await requireUser(request)
  const id = z.uuid().parse((await ctx.params).id)
  const input = tagUpdateSchema.parse(await readJson(request))
  const { data, error } = await db.from("tags").update(input).eq("id", id).select("id,name,color,created_at").maybeSingle()
  if (error) throw fromDb(error, "Tag not found")
  if (!data) throw new ApiError("not_found", "Tag not found")
  // Items carrying the tag must reach other devices with the new name.
  const { error: te } = await db.rpc("touch_tag_items", { p_tag: id })
  if (te) throw fromDb(te)
  return ok({ tag: data })
})

/** DELETE /v1/tags/{id} — removes the tag from every item; the items stay. */
export const DELETE = handler(async (request: Request, ctx: RouteContext<"/v1/tags/[id]">) => {
  const { db } = await requireUser(request)
  const id = z.uuid().parse((await ctx.params).id)
  const { data, error } = await db.from("tags").delete().eq("id", id).select("id")
  if (error) throw fromDb(error, "Tag not found")
  if (!data?.length) throw new ApiError("not_found", "Tag not found")
  return noContent()
})
