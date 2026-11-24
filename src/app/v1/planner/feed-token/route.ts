import { createHash, randomBytes } from "node:crypto"
import { z } from "zod"
import { requireUser } from "@/lib/api/auth"
import { ApiError, fromDb, handler, noContent, ok, readJson, searchParams } from "@/lib/api/http"

const MAX_ADDRESSES = 10

/** Built from the address the request came in on, so the phone gets the same host it already reaches. */
function feedUrls(request: Request, token: string) {
  const u = new URL(request.url)
  const host = request.headers.get("x-forwarded-host") ?? u.host
  const proto = request.headers.get("x-forwarded-proto") ?? u.protocol.replace(":", "")
  const base = `${proto}://${host}`
  return { json_url: `${base}/v1/planner/feed?token=${token}`, ics_url: `${base}/v1/planner/feed?token=${token}&format=ics` }
}

/**
 * POST /v1/planner/feed-token — `{ label? }` makes a new secret calendar address (each device or calendar app gets
 * its own, so turning one off leaves the others working). The token is shown once; only its hash is kept. Anyone
 * with the address can read your events and tasks. Up to 10; the oldest goes when an 11th is made.
 */
export const POST = handler(async (request: Request) => {
  const { db } = await requireUser(request)
  const input = z.object({ label: z.string().trim().min(1).max(80).default("Calendar app") }).parse(await readJson(request, 4096))
  const token = randomBytes(32).toString("base64url")
  const token_hash = createHash("sha256").update(token).digest("hex")
  const { data, error } = await db.from("planner_feed_tokens").insert({ label: input.label, token_hash }).select("id,label,created_at").single()
  if (error) throw fromDb(error)
  const { data: all } = await db.from("planner_feed_tokens").select("id").order("created_at", { ascending: false })
  const extra = (all ?? []).slice(MAX_ADDRESSES).map((r) => r.id as string)
  if (extra.length) await db.from("planner_feed_tokens").delete().in("id", extra)
  return ok({ id: data.id, label: data.label, token, ...feedUrls(request, token) }, 201)
})

/** GET /v1/planner/feed-token — the addresses that exist (the tokens themselves cannot be shown again). */
export const GET = handler(async (request: Request) => {
  const { db } = await requireUser(request)
  const { data, error } = await db.from("planner_feed_tokens").select("id,label,created_at,last_used_at").order("created_at", { ascending: false })
  if (error) throw fromDb(error)
  return ok({ addresses: data ?? [], active: Boolean(data?.length) })
})

/** DELETE /v1/planner/feed-token?id=… — turns one address off (without `id`: all of them). */
export const DELETE = handler(async (request: Request) => {
  const { db, userId } = await requireUser(request)
  const id = searchParams(request).get("id")
  if (id !== null && !z.uuid().safeParse(id).success) throw new ApiError("validation_failed", "Bad id")
  const q = db.from("planner_feed_tokens").delete().eq("user_id", userId)
  const { error } = await (id ? q.eq("id", id) : q)
  if (error) throw fromDb(error)
  return noContent()
})
