import { requireUser } from "@/lib/api/auth"
import { ApiError, fromDb, handler, ok, readJson } from "@/lib/api/http"
import { createShareSchema } from "@/lib/api/schemas"
import { newShareToken } from "@/lib/api/share-token"
import { publicEnv } from "@/lib/env"

const SHARE_SELECT = "id,item_id,collection_id,allow_download,expires_at,open_count,last_opened_at,revoked_at,created_at"

/** GET /v1/shares — the caller's share links (active first) with open counts. */
export const GET = handler(async (request: Request) => {
  const { db } = await requireUser(request)
  const { data, error } = await db
    .from("share_links")
    .select(`${SHARE_SELECT},items(title,body,type,link_title,url),collections(name)`)
    .order("created_at", { ascending: false })
    .limit(500)
  if (error) throw fromDb(error)
  const now = Date.now()
  return ok({
    shares: (data ?? []).map((s) => ({
      ...s,
      active: !s.revoked_at && (!s.expires_at || new Date(s.expires_at).getTime() > now),
    })),
  })
})

/**
 * POST /v1/shares — creates a private link to one item or one collection. The link (with its token) is returned
 * only once; it cannot be shown again because only a hash is stored.
 */
export const POST = handler(async (request: Request) => {
  const { db, userId } = await requireUser(request)
  const input = createShareSchema.parse(await readJson(request))

  if (input.item_id) {
    const { data: item } = await db.from("items").select("id,deleted_at").eq("id", input.item_id).maybeSingle()
    if (!item) throw new ApiError("not_found", "Item not found")
    if (item.deleted_at) throw new ApiError("gone", "Item is in the trash")
  }

  const { token, hash } = newShareToken()
  const expires = input.expires_in_days ? new Date(Date.now() + input.expires_in_days * 86_400_000).toISOString() : null
  const { data, error } = await db
    .from("share_links")
    .insert({
      user_id: userId,
      item_id: input.item_id ?? null,
      collection_id: input.collection_id ?? null,
      token_hash: hash,
      allow_download: input.allow_download,
      expires_at: expires,
    })
    .select(SHARE_SELECT)
    .single()
  if (error) throw fromDb(error, "Item or collection not found")
  return ok({ share: { ...data, active: true }, url: `${publicEnv.appUrl}/s/${token}` }, 201)
})
