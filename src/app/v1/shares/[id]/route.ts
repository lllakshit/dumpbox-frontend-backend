import { z } from "zod"
import { requireUser } from "@/lib/api/auth"
import { ApiError, fromDb, handler, ok } from "@/lib/api/http"

/** DELETE /v1/shares/{id} — revokes a link; it stops working on the next request. */
export const DELETE = handler(async (request: Request, ctx: RouteContext<"/v1/shares/[id]">) => {
  const { db } = await requireUser(request)
  const id = z.uuid().parse((await ctx.params).id)
  const { data, error } = await db
    .from("share_links")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .is("revoked_at", null)
    .select("id,revoked_at")
  if (error) throw fromDb(error, "Share link not found")
  if (!data?.length) {
    const { data: existing } = await db.from("share_links").select("id,revoked_at").eq("id", id).maybeSingle()
    if (!existing) throw new ApiError("not_found", "Share link not found")
    return ok({ share: existing })
  }
  return ok({ share: data[0] })
})
