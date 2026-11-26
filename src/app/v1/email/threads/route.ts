import { z } from "zod"
import { requireUser } from "@/lib/api/auth"
import { decodeCursor, encodeCursor, isFeedCursor } from "@/lib/api/cursor"
import { THREAD_COLUMNS } from "@/lib/api/email"
import { fromDb, handler, ok, searchParams } from "@/lib/api/http"
import { likePattern } from "@/lib/email/normalize"

const listSchema = z.object({
  view: z.enum(["inbox", "new", "unread", "starred", "pinned", "archived"]).default("inbox"),
  label: z.string().trim().min(1).max(200).optional(),
  priority: z.coerce.number().int().min(1).max(3).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

/**
 * GET /v1/email/threads — conversations, newest activity first. `view` inbox (not archived, still under a synced label) | new (unread and not opened
 * here since its last message) | unread (in Gmail) | starred | pinned | archived; narrow with `label`, `priority` (1-3) and `q` (text).
 */
export const GET = handler(async (request: Request) => {
  const { db } = await requireUser(request)
  const q = listSchema.parse(Object.fromEntries(searchParams(request)))
  const cursor = decodeCursor(q.cursor, isFeedCursor)

  let query = db.from("email_threads").select(THREAD_COLUMNS).is("deleted_at", null)
  // Archived: archived here, or no longer under any synced Gmail label.
  query = query.eq("in_inbox", q.view !== "archived")
  if (q.view === "unread") query = query.eq("unread", true)
  if (q.view === "starred") query = query.eq("starred", true)
  if (q.view === "pinned") query = query.eq("pinned", true)
  if (q.view === "new") query = query.eq("fresh", true)
  if (q.label) query = query.contains("labels", [q.label])
  if (q.priority) query = query.eq("priority", q.priority)
  if (q.q) query = query.ilike("search_text", likePattern(q.q))
  if (cursor) query = query.or(`last_message_at.lt.${cursor.c},and(last_message_at.eq.${cursor.c},id.lt.${cursor.i})`)
  const { data, error } = await query.order("last_message_at", { ascending: false }).order("id", { ascending: false }).limit(q.limit + 1)
  if (error) throw fromDb(error)
  const rows = (data ?? []) as unknown as { id: string; last_message_at: string }[]
  const page = rows.slice(0, q.limit)
  const last = page[page.length - 1]
  return ok({
    threads: page,
    next_cursor: rows.length > q.limit && last ? encodeCursor({ c: last.last_message_at, i: last.id }) : null,
  })
})
