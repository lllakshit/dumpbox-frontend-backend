import { z } from "zod"
import { requireUser } from "@/lib/api/auth"
import { MESSAGE_COLUMNS, THREAD_COLUMNS } from "@/lib/api/email"
import { ApiError, fromDb, handler, noContent, ok, readJson } from "@/lib/api/http"

const idParam = z.uuid()

/** GET /v1/email/threads/{id} — the conversation with every message, oldest first. Marks it opened in DumpBox. */
export const GET = handler(async (request: Request, ctx: RouteContext<"/v1/email/threads/[id]">) => {
  const { db } = await requireUser(request)
  const id = idParam.parse((await ctx.params).id)
  const { data: thread, error } = await db.from("email_threads").select(THREAD_COLUMNS).eq("id", id).is("deleted_at", null).maybeSingle()
  if (error) throw fromDb(error)
  if (!thread) throw new ApiError("not_found", "Conversation not found")
  const { data: messages, error: e2 } = await db.from("email_messages").select(MESSAGE_COLUMNS).eq("thread_id", id).order("sent_at").limit(500)
  if (e2) throw fromDb(e2)
  // Seen = the newest message that is here now; mail imported later still counts as new.
  const opened_at = new Date().toISOString()
  const seen_message_at = (thread as unknown as { last_message_at: string }).last_message_at
  await db.from("email_threads").update({ opened_at, seen_message_at }).eq("id", id)
  return ok({ thread: { ...thread, opened_at, seen_message_at, fresh: false }, messages: messages ?? [] })
})

const patchSchema = z.object({ pinned: z.boolean().optional(), archived: z.boolean().optional() })

/** PATCH /v1/email/threads/{id} — `{ pinned?, archived? }`, the DumpBox-side flags (Gmail is not changed). */
export const PATCH = handler(async (request: Request, ctx: RouteContext<"/v1/email/threads/[id]">) => {
  const { db } = await requireUser(request)
  const id = idParam.parse((await ctx.params).id)
  const input = patchSchema.parse(await readJson(request, 4096))
  const patch: Record<string, unknown> = {}
  if (input.pinned !== undefined) patch.pinned = input.pinned
  if (input.archived !== undefined) patch.archived_at = input.archived ? new Date().toISOString() : null
  if (!Object.keys(patch).length) throw new ApiError("validation_failed", "Nothing to change")
  const { data, error } = await db.from("email_threads").update(patch).eq("id", id).is("deleted_at", null).select(THREAD_COLUMNS).maybeSingle()
  if (error) throw fromDb(error)
  if (!data) throw new ApiError("not_found", "Conversation not found")
  return ok({ thread: data })
})

/**
 * DELETE /v1/email/threads/{id} — removes the conversation's content from DumpBox for good and keeps a marker so
 * the Gmail script does not bring it back. Gmail is not changed.
 */
export const DELETE = handler(async (request: Request, ctx: RouteContext<"/v1/email/threads/[id]">) => {
  const { db } = await requireUser(request)
  const id = idParam.parse((await ctx.params).id)
  // One transaction in the database: content wiped, marker kept, messages removed.
  const { data, error } = await db.rpc("email_delete_thread", { p_id: id })
  if (error) throw fromDb(error)
  if (data !== true) throw new ApiError("not_found", "Conversation not found")
  return noContent()
})
