import { requireUser } from "@/lib/api/auth"
import { BUCKET, MAX_FILE_BYTES, isBlockedFile, storagePath } from "@/lib/api/files"
import { ApiError, fromDb, handler, ok, readJson } from "@/lib/api/http"
import { getItem } from "@/lib/api/items"
import { uploadRequestSchema } from "@/lib/api/schemas"

/**
 * POST /v1/uploads — step 1 of attaching a file: checks type and size and returns a one-time signed upload URL.
 * Step 2: PUT the bytes to `upload_url`. Step 3: POST /v1/items/{item_id}/files to register it.
 * If a file with the same SHA-256 already exists in the account, `duplicate_of` names the item that holds it.
 */
export const POST = handler(async (request: Request) => {
  const { db, userId } = await requireUser(request)
  const input = uploadRequestSchema.parse(await readJson(request))

  if (input.size_bytes > MAX_FILE_BYTES)
    throw new ApiError("payload_too_large", `Files can be at most ${MAX_FILE_BYTES / 1024 / 1024} MB`)
  if (isBlockedFile(input.file_name, input.mime_type))
    throw new ApiError("unsupported_file_type", "This file type is not allowed (programs and scripts are blocked)")

  const item = await getItem(db, input.item_id)
  if (item.deleted_at) throw new ApiError("gone", "Item is in the trash")

  let duplicateOf: { item_id: string; file_id: string } | null = null
  if (input.sha256) {
    const { data, error } = await db
      .from("files")
      .select("id,item_id,items!inner(deleted_at)")
      .eq("sha256", input.sha256)
      .is("items.deleted_at", null)
      .neq("item_id", input.item_id)
      .limit(1)
    if (error) throw fromDb(error)
    if (data?.[0]) duplicateOf = { item_id: data[0].item_id as string, file_id: data[0].id as string }
  }

  const fileId = crypto.randomUUID()
  const path = storagePath(userId, input.item_id, fileId, input.file_name)
  const { data: signed, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path)
  if (error || !signed) throw new ApiError("internal_error", "Could not prepare the upload")

  return ok(
    {
      file_id: fileId,
      storage_path: path,
      upload_url: signed.signedUrl,
      upload_token: signed.token,
      max_bytes: MAX_FILE_BYTES,
      duplicate_of: duplicateOf,
    },
    201,
  )
})
