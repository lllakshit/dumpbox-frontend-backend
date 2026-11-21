import { requireUser } from "@/lib/api/auth"
import { fromDb, handler, ok, readJson } from "@/lib/api/http"
import { collectionSchema } from "@/lib/api/schemas"

/** GET /v1/collections — all collections with their live item counts. */
export const GET = handler(async (request: Request) => {
  const { db } = await requireUser(request)
  const { data, error } = await db
    .from("collections")
    .select("id,name,description,created_at,updated_at,item_collections(items!inner(deleted_at))")
    .order("name")
  if (error) throw fromDb(error)
  type Row = {
    id: string
    name: string
    description: string | null
    created_at: string
    updated_at: string
    item_collections: { items: { deleted_at: string | null } | null }[]
  }
  return ok({
    collections: (data as unknown as Row[]).map(({ item_collections, ...c }) => ({
      ...c,
      item_count: item_collections.filter((ic) => ic.items && !ic.items.deleted_at).length,
    })),
  })
})

/** POST /v1/collections */
export const POST = handler(async (request: Request) => {
  const { db } = await requireUser(request)
  const input = collectionSchema.parse(await readJson(request))
  const { data, error } = await db
    .from("collections")
    .insert({ name: input.name, description: input.description ?? null })
    .select("id,name,description,created_at,updated_at")
    .single()
  if (error) throw fromDb(error)
  return ok({ collection: { ...data, item_count: 0 } }, 201)
})
