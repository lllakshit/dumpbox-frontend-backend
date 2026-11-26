import "server-only"
import { createHash } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { messageRows, threadRow, type ImportThread } from "@/lib/email/normalize"
import { ApiError } from "./http"

/** Columns returned for a conversation (search_text is internal). */
export const THREAD_COLUMNS =
  "id,provider,external_id,subject,snippet,from_name,from_email,participants,labels,message_count,has_attachments,starred,important,unread,priority,first_message_at,last_message_at,in_scope,in_inbox,pinned,archived_at,opened_at,seen_message_at,fresh,created_at,updated_at"
export const MESSAGE_COLUMNS = "id,external_id,from_name,from_email,to_list,cc_list,sent_at,body_text,attachments,unread"

const KEY_RE = /^[A-Za-z0-9_-]{43}$/

export function hashKey(key: string) {
  return createHash("sha256").update(key).digest("hex")
}

/** The Gmail script authenticates with its import key (not a sign-in). Returns whose mail it is. */
export async function userForImportKey(admin: SupabaseClient, request: Request): Promise<string> {
  const header = request.headers.get("authorization") ?? ""
  const key = /^Bearer\s+(\S+)$/i.exec(header)?.[1] ?? ""
  const denied = new ApiError("unauthorized", "This import key does not exist or has been turned off. Make a new one in DumpBox → Settings → Email.")
  if (!KEY_RE.test(key)) throw denied
  const { data, error } = await admin.from("email_import_keys").select("id,user_id").eq("key_hash", hashKey(key)).maybeSingle()
  if (error) throw new ApiError("internal_error", "Could not check the import key")
  if (!data) throw denied
  await admin.from("email_import_keys").update({ last_used_at: new Date().toISOString() }).eq("id", data.id as string)
  return data.user_id as string
}

export type ImportResult = { created: number; updated: number; skipped: number; messages: number }

/**
 * Saves conversations from Gmail. Same Gmail thread → same row, so sending it again updates it.
 * Conversations deleted in DumpBox are skipped (never brought back). An archived one comes back to the inbox
 * when a newer message arrives, like Gmail.
 */
export async function importThreads(admin: SupabaseClient, userId: string, threads: ImportThread[]): Promise<ImportResult> {
  // One conversation sent twice in the same request: the last copy wins.
  const byId = new Map(threads.map((t) => [t.external_id, t]))
  const list = [...byId.values()]
  const { data: existing, error: e1 } = await admin
    .from("email_threads")
    .select("id,external_id,deleted_at,archived_at,last_message_at")
    .eq("user_id", userId)
    .in("external_id", list.map((t) => t.external_id))
  if (e1) throw new ApiError("internal_error", "Could not read existing mail")
  const known = new Map((existing ?? []).map((r) => [r.external_id as string, r]))

  const keep = list.filter((t) => !known.get(t.external_id)?.deleted_at)
  const result: ImportResult = { created: 0, updated: 0, skipped: list.length - keep.length, messages: 0 }
  if (!keep.length) return result

  const rows = keep.map((t) => threadRow(userId, t))
  const { data: saved, error: e2 } = await admin.from("email_threads").upsert(rows, { onConflict: "user_id,external_id" }).select("id,external_id")
  if (e2) throw new ApiError("internal_error", `Could not save mail: ${e2.message}`)
  const idOf = new Map((saved ?? []).map((r) => [r.external_id as string, r.id as string]))

  const unarchive: string[] = []
  for (const row of rows) {
    const before = known.get(row.external_id)
    if (!before) result.created++
    else {
      result.updated++
      if (before.archived_at && row.last_message_at > new Date(before.last_message_at as string).toISOString()) unarchive.push(before.id as string)
    }
  }
  if (unarchive.length) await admin.from("email_threads").update({ archived_at: null }).in("id", unarchive)

  // Messages in chunks that stay well under the database request size. The same message twice in one request
  // would make the upsert fail, so the last copy wins.
  const messages = [...new Map(keep.flatMap((t) => messageRows(userId, idOf.get(t.external_id)!, t)).map((m) => [m.external_id, m])).values()]
  let chunk: typeof messages = []
  let bytes = 0
  const flush = async () => {
    if (!chunk.length) return
    const { error } = await admin.from("email_messages").upsert(chunk, { onConflict: "user_id,external_id" })
    if (error) throw new ApiError("internal_error", `Could not save messages: ${error.message}`)
    result.messages += chunk.length
    chunk = []
    bytes = 0
  }
  for (const m of messages) {
    const size = m.body_text.length * 3 + 2000
    if (bytes + size > 2_000_000 || chunk.length >= 200) await flush()
    chunk.push(m)
    bytes += size
  }
  await flush()
  return result
}
