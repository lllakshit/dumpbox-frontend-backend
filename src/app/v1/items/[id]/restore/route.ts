import { z } from "zod"
import { requireUser } from "@/lib/api/auth"
import { fromDb, handler, ok } from "@/lib/api/http"
import { getItem } from "@/lib/api/items"

/** POST /v1/items/{id}/restore — brings an item back from the trash. */
export const POST = handler(async (request: Request, ctx: RouteContext<"/v1/items/[id]/restore">) => {
  const { db } = await requireUser(request)
  const id = z.uuid().parse((await ctx.params).id)
  const item = await getItem(db, id)
  if (item.deleted_at) {
    const { error } = await db.from("items").update({ deleted_at: null }).eq("id", id)
    if (error) throw fromDb(error, "Item not found")
  }
  return ok({ item: await getItem(db, id) })
})
