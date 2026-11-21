import { z } from "zod"
import { requireUser } from "@/lib/api/auth"
import { handler, ok, readJson } from "@/lib/api/http"
import { getItem, setItemCollections } from "@/lib/api/items"
import { setCollectionsSchema } from "@/lib/api/schemas"

/** PUT /v1/items/{id}/collections — sets which collections the item is in. */
export const PUT = handler(async (request: Request, ctx: RouteContext<"/v1/items/[id]/collections">) => {
  const { db } = await requireUser(request)
  const id = z.uuid().parse((await ctx.params).id)
  const { collection_ids } = setCollectionsSchema.parse(await readJson(request))
  await getItem(db, id)
  await setItemCollections(db, id, collection_ids)
  return ok({ item: await getItem(db, id) })
})
