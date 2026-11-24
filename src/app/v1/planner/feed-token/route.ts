import { createHash, randomBytes } from "node:crypto"
import { requireUser } from "@/lib/api/auth"
import { fromDb, handler, noContent, ok } from "@/lib/api/http"
/** Built from the address the request came in on, so the phone gets the same host it already reaches. */
function feedUrls(request: Request, token: string) {
  const u = new URL(request.url)
  const host = request.headers.get("x-forwarded-host") ?? u.host
  const proto = request.headers.get("x-forwarded-proto") ?? u.protocol.replace(":", "")
  const base = `${proto}://${host}`
  return { json_url: `${base}/v1/planner/feed?token=${token}`, ics_url: `${base}/v1/planner/feed?token=${token}&format=ics` }
}

/**
 * POST /v1/planner/feed-token — makes (or replaces) the secret calendar address. The token is shown once; only its
 * hash is kept. Anyone with the address can read your events and tasks, so keep it private.
 */
export const POST = handler(async (request: Request) => {
  const { db, userId } = await requireUser(request)
  const token = randomBytes(32).toString("base64url")
  const token_hash = createHash("sha256").update(token).digest("hex")
  const { error } = await db.from("planner_feed_tokens").upsert({ user_id: userId, token_hash, created_at: new Date().toISOString(), last_used_at: null }, { onConflict: "user_id" })
  if (error) throw fromDb(error)
  return ok({ token, ...feedUrls(request, token) }, 201)
})

/** GET /v1/planner/feed-token — whether an address exists (the token itself cannot be shown again). */
export const GET = handler(async (request: Request) => {
  const { db } = await requireUser(request)
  const { data, error } = await db.from("planner_feed_tokens").select("created_at,last_used_at").maybeSingle()
  if (error) throw fromDb(error)
  return ok({ active: Boolean(data), created_at: data?.created_at ?? null, last_used_at: data?.last_used_at ?? null })
})

/** DELETE /v1/planner/feed-token — turns the secret address off. */
export const DELETE = handler(async (request: Request) => {
  const { db, userId } = await requireUser(request)
  const { error } = await db.from("planner_feed_tokens").delete().eq("user_id", userId)
  if (error) throw fromDb(error)
  return noContent()
})
