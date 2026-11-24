import { z } from "zod"
import { requireUser } from "@/lib/api/auth"
import { handler, ok, readJson } from "@/lib/api/http"
import { ensureLists, getEntry, patchEntry, updateEntrySchema } from "@/lib/api/planner"

/** GET /v1/planner/entries/{id} */
export const GET = handler(async (request: Request, ctx: RouteContext<"/v1/planner/entries/[id]">) => {
  const { db } = await requireUser(request)
  const id = z.uuid().parse((await ctx.params).id)
  return ok({ entry: await getEntry(db, id) })
})

/**
 * PATCH /v1/planner/entries/{id} — change any field. `completed: true` on a repeating task finishes this one and
 * returns `next_entry`, the same task at its next date. `deleted: false` restores from the bin.
 */
export const PATCH = handler(async (request: Request, ctx: RouteContext<"/v1/planner/entries/[id]">) => {
  const { db } = await requireUser(request)
  const id = z.uuid().parse((await ctx.params).id)
  const input = updateEntrySchema.parse(await readJson(request))
  const lists = await ensureLists(db)
  const r = await patchEntry(db, id, input, lists)
  return ok({ entry: r.entry, next_entry: r.next, merged: r.merged })
})

/**
 * DELETE /v1/planner/entries/{id} — moves it (and its subtasks) to the bin; restore with PATCH `deleted: false`.
 * Binned entries stay visible to sync for 90 days (so every device drops them), then are removed for good.
 */
export const DELETE = handler(async (request: Request, ctx: RouteContext<"/v1/planner/entries/[id]">) => {
  const { db } = await requireUser(request)
  const id = z.uuid().parse((await ctx.params).id)
  const lists = await ensureLists(db)
  const r = await patchEntry(db, id, { deleted: true }, lists)
  return ok({ entry: r.entry })
})
