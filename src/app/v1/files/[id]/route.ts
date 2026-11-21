import { z } from "zod"
import { requireUser } from "@/lib/api/auth"
import { BUCKET } from "@/lib/api/files"
import { ApiError, fromDb, handler, noContent, ok } from "@/lib/api/http"

const SIGNED_URL_SECONDS = 60 * 60

/** GET /v1/files/{id} — short-lived URLs to view and to download the file. */
export const GET = handler(async (request: Request, ctx: RouteContext<"/v1/files/[id]">) => {
  const { db } = await requireUser(request)
  const id = z.uuid().parse((await ctx.params).id)
  const { data: file, error } = await db
    .from("files")
    .select("id,item_id,storage_path,file_name,mime_type,size_bytes")
    .eq("id", id)
    .maybeSingle()
  if (error) throw fromDb(error, "File not found")
  if (!file) throw new ApiError("not_found", "File not found")

  const bucket = db.storage.from(BUCKET)
  const [view, download] = await Promise.all([
    bucket.createSignedUrl(file.storage_path, SIGNED_URL_SECONDS),
    bucket.createSignedUrl(file.storage_path, SIGNED_URL_SECONDS, { download: file.file_name }),
  ])
  if (view.error || download.error) throw new ApiError("not_found", "File content not found")
  return ok({
    file: { id: file.id, item_id: file.item_id, file_name: file.file_name, mime_type: file.mime_type, size_bytes: file.size_bytes },
    view_url: view.data.signedUrl,
    download_url: download.data.signedUrl,
    expires_in: SIGNED_URL_SECONDS,
  })
})

/** DELETE /v1/files/{id} — removes one file from its item. */
export const DELETE = handler(async (request: Request, ctx: RouteContext<"/v1/files/[id]">) => {
  const { db } = await requireUser(request)
  const id = z.uuid().parse((await ctx.params).id)
  const { data: file, error } = await db.from("files").select("id,storage_path").eq("id", id).maybeSingle()
  if (error) throw fromDb(error, "File not found")
  if (!file) throw new ApiError("not_found", "File not found")
  const { error: se } = await db.storage.from(BUCKET).remove([file.storage_path])
  if (se) throw new ApiError("internal_error", "Could not remove the file; try again")
  const { error: de } = await db.from("files").delete().eq("id", id)
  if (de) throw fromDb(de)
  return noContent()
})
