import { z } from "zod"
import { requireUser } from "@/lib/api/auth"
import { fromDb, handler, ok } from "@/lib/api/http"
import { getItem } from "@/lib/api/items"

/** GET /v1/items/{id}/versions — the previous 10 versions of a note's title and text, newest first. */
export const GET = handler(async (request: Request, ctx: RouteContext<"/v1/items/[id]/versions">) => {
  const { db } = await requireUser(request)
  const id = z.uuid().parse((await ctx.params).id)
  await getItem(db, id)
  const { data, error } = await db
    .from("item_versions")
    .select("version,title,body,created_at")
    .eq("item_id", id)
    .order("version", { ascending: false })
    .limit(10)
  if (error) throw fromDb(error)
  return ok({ versions: data ?? [] })
})
