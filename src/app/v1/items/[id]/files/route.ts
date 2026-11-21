import { z } from "zod"
import { requireUser } from "@/lib/api/auth"
import { BUCKET, MAX_FILE_BYTES, isBlockedFile } from "@/lib/api/files"
import { ApiError, fromDb, handler, ok, readJson } from "@/lib/api/http"
import { getItem } from "@/lib/api/items"
import { registerFileSchema } from "@/lib/api/schemas"

/**
 * POST /v1/items/{id}/files — step 3 of an upload: records a file that was PUT to its signed URL.
 * The size stored is the size Storage reports, not what the client claims.
 */
export const POST = handler(async (request: Request, ctx: RouteContext<"/v1/items/[id]/files">) => {
  const { db, userId } = await requireUser(request)
  const itemId = z.uuid().parse((await ctx.params).id)
  const input = registerFileSchema.parse(await readJson(request))

  const prefix = `${userId}/${itemId}/${input.file_id}-`
  if (!input.storage_path.startsWith(prefix)) throw new ApiError("validation_failed", "storage_path does not match this item and file")
  if (isBlockedFile(input.file_name, input.mime_type)) throw new ApiError("unsupported_file_type", "This file type is not allowed")
  await getItem(db, itemId)

  const { data: existing } = await db.from("files").select("id").eq("id", input.file_id).maybeSingle()
  if (existing) return ok({ item: await getItem(db, itemId) })

  const folder = `${userId}/${itemId}`
  const name = input.storage_path.slice(folder.length + 1)
  const { data: objects, error: le } = await db.storage.from(BUCKET).list(folder, { search: name, limit: 5 })
  if (le) throw new ApiError("internal_error", "Could not check the upload")
  const object = objects?.find((o) => o.name === name)
  if (!object) throw new ApiError("not_found", "Upload not found; PUT the file to upload_url first")
  const size = Number((object.metadata as { size?: number } | null)?.size ?? 0)
  if (size > MAX_FILE_BYTES) {
    await db.storage.from(BUCKET).remove([input.storage_path])
    throw new ApiError("payload_too_large", "File is too large")
  }

  const { error } = await db.from("files").insert({
    id: input.file_id,
    item_id: itemId,
    user_id: userId,
    storage_path: input.storage_path,
    file_name: input.file_name,
    mime_type: input.mime_type,
    size_bytes: size,
    sha256: input.sha256 ?? null,
    width: input.width ?? null,
    height: input.height ?? null,
  })
  if (error && error.code !== "23505") throw fromDb(error, "Item not found")
  return ok({ item: await getItem(db, itemId) }, 201)
})
