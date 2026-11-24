import { requireUser } from "@/lib/api/auth"
import { listUserObjects, removeObjects } from "@/lib/api/storage-admin"
import { ApiError, fromDb, handler, noContent, ok, readJson } from "@/lib/api/http"
import { profileSchema } from "@/lib/api/schemas"
import { adminClient } from "@/lib/supabase/server"
import { DEFAULT_PREFS } from "@/lib/planner/types"

async function usage(db: Awaited<ReturnType<typeof requireUser>>["db"]) {
  const { data, error } = await db.rpc("account_usage").single()
  if (error) throw fromDb(error)
  const u = data as { items: number; files: number; storage_bytes: number }
  return { items: Number(u.items), files: Number(u.files), storage_bytes: Number(u.storage_bytes) }
}

/** GET /v1/me — profile and usage. */
export const GET = handler(async (request: Request) => {
  const { db, token } = await requireUser(request)
  const { data, error } = await db.auth.getUser(token)
  if (error || !data.user) throw new ApiError("unauthorized", "Session expired, sign in again")
  const u = data.user
  return ok({
    user: {
      id: u.id,
      email: u.email ?? null,
      name: (u.user_metadata?.name as string | undefined) ?? (u.user_metadata?.full_name as string | undefined) ?? null,
      avatar_url: (u.user_metadata?.avatar_url as string | undefined) ?? null,
      time_zone: (u.user_metadata?.time_zone as string | undefined) ?? null,
      planner: { ...DEFAULT_PREFS, ...((u.user_metadata?.planner as object | undefined) ?? {}) },
      created_at: u.created_at,
    },
    usage: await usage(db),
  })
})

/**
 * PATCH /v1/me — name, time zone and planner preferences (planner fields merge with the ones already saved).
 * Written with the server key for the caller's own verified id: a per-request client holds no session to update.
 */
export const PATCH = handler(async (request: Request) => {
  const { userId } = await requireUser(request)
  const input = profileSchema.parse(await readJson(request))
  const admin = adminClient()
  const { data: cur, error: ge } = await admin.auth.admin.getUserById(userId)
  if (ge || !cur.user) throw new ApiError("unauthorized", "Session expired, sign in again")
  const before = (cur.user.user_metadata ?? {}) as Record<string, unknown>
  const md: Record<string, unknown> = { ...before }
  if (input.name !== undefined) md.name = input.name
  if (input.time_zone !== undefined) md.time_zone = input.time_zone
  if (input.planner) md.planner = { ...DEFAULT_PREFS, ...((before.planner as object | undefined) ?? {}), ...input.planner }
  const { data, error } = await admin.auth.admin.updateUserById(userId, { user_metadata: md })
  if (error || !data.user) throw new ApiError("internal_error", "Could not update the profile")
  const saved = (data.user.user_metadata ?? {}) as Record<string, unknown>
  return ok({
    user: {
      id: data.user.id,
      name: (saved.name as string | undefined) ?? null,
      time_zone: (saved.time_zone as string | undefined) ?? null,
      planner: { ...DEFAULT_PREFS, ...((saved.planner as object | undefined) ?? {}) },
    },
  })
})

/**
 * DELETE /v1/me — deletes the account now: every stored file, then the user (rows cascade).
 * Send `{"confirm":"DELETE"}` so a stray request cannot do this.
 */
export const DELETE = handler(async (request: Request) => {
  const { userId } = await requireUser(request)
  const body = (await readJson(request)) as { confirm?: string }
  if (body?.confirm !== "DELETE") throw new ApiError("validation_failed", 'Send {"confirm":"DELETE"} to delete the account')

  const admin = adminClient()
  // Everything in the user's folder, including uploads that were never registered.
  try {
    await removeObjects(admin, await listUserObjects(admin, userId))
  } catch {
    throw new ApiError("internal_error", "Could not remove stored files; try again")
  }
  const { error: de } = await admin.auth.admin.deleteUser(userId)
  if (de) throw new ApiError("internal_error", "Could not delete the account; try again")
  return noContent()
})
