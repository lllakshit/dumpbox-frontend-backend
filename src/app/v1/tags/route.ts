import { requireUser } from "@/lib/api/auth"
import { fromDb, handler, ok, readJson } from "@/lib/api/http"
import { tagSchema } from "@/lib/api/schemas"

/** GET /v1/tags — all tags with how many live items use each. */
export const GET = handler(async (request: Request) => {
  const { db } = await requireUser(request)
  const { data, error } = await db
    .from("tags")
    .select("id,name,color,created_at,item_tags(items!inner(deleted_at))")
    .order("name")
  if (error) throw fromDb(error)
  type Row = { id: string; name: string; color: string | null; created_at: string; item_tags: { items: { deleted_at: string | null } | null }[] }
  return ok({
    tags: (data as unknown as Row[]).map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      created_at: t.created_at,
      item_count: t.item_tags.filter((it) => it.items && !it.items.deleted_at).length,
    })),
  })
})

/** POST /v1/tags */
export const POST = handler(async (request: Request) => {
  const { db } = await requireUser(request)
  const input = tagSchema.parse(await readJson(request))
  const { data, error } = await db.from("tags").insert({ name: input.name, color: input.color ?? null }).select("id,name,color,created_at").single()
  if (error) throw fromDb(error)
  return ok({ tag: { ...data, item_count: 0 } }, 201)
})
