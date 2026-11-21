import { z } from "zod"
import { requireUser } from "@/lib/api/auth"
import { handler, ok, readJson } from "@/lib/api/http"
import { getItem, setItemTags } from "@/lib/api/items"
import { setTagsSchema } from "@/lib/api/schemas"

/** PUT /v1/items/{id}/tags — sets the item's tags by name; unknown names are created. */
export const PUT = handler(async (request: Request, ctx: RouteContext<"/v1/items/[id]/tags">) => {
  const { db } = await requireUser(request)
  const id = z.uuid().parse((await ctx.params).id)
  const { tags } = setTagsSchema.parse(await readJson(request))
  await getItem(db, id)
  await setItemTags(db, id, tags)
  return ok({ item: await getItem(db, id) })
})
