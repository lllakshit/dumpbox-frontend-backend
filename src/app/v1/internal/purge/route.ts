import { timingSafeEqual } from "node:crypto"
import { removeObjects } from "@/lib/api/storage-admin"
import { ApiError, handler, ok } from "@/lib/api/http"
import { requireServerEnv } from "@/lib/env"
import { adminClient } from "@/lib/supabase/server"

const TRASH_DAYS = 30
const TOMBSTONE_DAYS = 90
const BATCH = 200

function authorized(request: Request) {
  const expected = Buffer.from(`Bearer ${requireServerEnv("CRON_SECRET")}`)
  const given = Buffer.from(request.headers.get("authorization") ?? "")
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/**
 * GET /v1/internal/purge — daily job (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`).
 * Removes items that have been in the trash for 30 days, with their files, and old tombstones.
 */
export const GET = handler(async (request: Request) => {
  if (!authorized(request)) throw new ApiError("unauthorized", "Not allowed")
  const admin = adminClient()
  // Also counts as database activity, so the project is not paused for being idle.
  await admin.rpc("keepalive", { p_source: "vercel-cron" })
  const cutoff = new Date(Date.now() - TRASH_DAYS * 86_400_000).toISOString()

  let removedItems = 0
  let removedFiles = 0
  for (let round = 0; round < 25; round++) {
    const { data: items, error } = await admin.from("items").select("id").lt("deleted_at", cutoff).limit(BATCH)
    if (error) throw new ApiError("internal_error", "Could not list trash")
    if (!items?.length) break
    const ids = items.map((i) => i.id as string)
    // Page through the files of this batch; stop (and keep the items) if anything fails, so no file is orphaned.
    const paths: string[] = []
    for (let from = 0; ; from += 1000) {
      const { data: files, error: fe } = await admin.from("files").select("storage_path").in("item_id", ids).order("id").range(from, from + 999)
      if (fe) throw new ApiError("internal_error", "Could not list files")
      paths.push(...(files ?? []).map((f) => f.storage_path as string))
      if (!files || files.length < 1000) break
    }
    if (paths.length) {
      try {
        await removeObjects(admin, paths)
      } catch {
        throw new ApiError("internal_error", "Could not remove files")
      }
      removedFiles += paths.length
    }
    const { error: de } = await admin.from("items").delete().in("id", ids)
    if (de) throw new ApiError("internal_error", "Could not remove items")
    removedItems += ids.length
  }

  const tombCutoff = new Date(Date.now() - TOMBSTONE_DAYS * 86_400_000).toISOString()
  await admin.from("item_tombstones").delete().lt("deleted_at", tombCutoff)

  return ok({ removed_items: removedItems, removed_files: removedFiles })
})
