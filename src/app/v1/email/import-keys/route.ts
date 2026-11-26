import { randomBytes } from "node:crypto"
import { z } from "zod"
import { requireUser } from "@/lib/api/auth"
import { hashKey } from "@/lib/api/email"
import { ApiError, fromDb, handler, noContent, ok, readJson, searchParams } from "@/lib/api/http"

const MAX_KEYS = 5

/**
 * POST /v1/email/import-keys — `{ label? }` makes a key for the Gmail script. Shown once; only its hash is kept.
 * Up to 5: a 6th is refused (never turns off a key a running script may be using).
 */
export const POST = handler(async (request: Request) => {
  const { db } = await requireUser(request)
  const input = z.object({ label: z.string().trim().min(1).max(80).default("Gmail script") }).parse(await readJson(request, 4096))
  const { data: all, error: e1 } = await db.from("email_import_keys").select("id,label").order("created_at")
  if (e1) throw fromDb(e1)
  if ((all ?? []).length >= MAX_KEYS)
    throw new ApiError("conflict", `You already have ${MAX_KEYS} import keys. Turn one off first (oldest: “${all![0].label}”).`)
  const key = randomBytes(32).toString("base64url")
  const { data, error } = await db.from("email_import_keys").insert({ label: input.label, key_hash: hashKey(key) }).select("id,label,created_at").single()
  if (error) throw fromDb(error)
  const u = new URL(request.url)
  const host = request.headers.get("x-forwarded-host") ?? u.host
  const proto = request.headers.get("x-forwarded-proto") ?? u.protocol.replace(":", "")
  return ok({ id: data.id, label: data.label, created_at: data.created_at, key, api_url: `${proto}://${host}` }, 201)
})

/** GET /v1/email/import-keys — keys that exist (labels and dates; the keys themselves cannot be shown again). */
export const GET = handler(async (request: Request) => {
  const { db } = await requireUser(request)
  const { data, error } = await db.from("email_import_keys").select("id,label,created_at,last_used_at").order("created_at", { ascending: false })
  if (error) throw fromDb(error)
  return ok({ keys: data ?? [] })
})

/** DELETE /v1/email/import-keys?id=… — turns one key off (without `id`: all of them). Imported mail stays. */
export const DELETE = handler(async (request: Request) => {
  const { db, userId } = await requireUser(request)
  const id = searchParams(request).get("id")
  if (id !== null && !z.uuid().safeParse(id).success) throw new ApiError("validation_failed", "Bad id")
  const q = db.from("email_import_keys").delete().eq("user_id", userId)
  const { error } = await (id ? q.eq("id", id) : q)
  if (error) throw fromDb(error)
  return noContent()
})
