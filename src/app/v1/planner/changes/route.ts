import { requireUser } from "@/lib/api/auth"
import { decodeCursor, encodeCursor, isChangesCursor, keysetAfter, type ChangesCursor } from "@/lib/api/cursor"
import { fromDb, handler, ok, searchParams } from "@/lib/api/http"
import { ensureLists } from "@/lib/api/planner"
import { changesSchema } from "@/lib/api/schemas"
import { ENTRY_COLUMNS, type Entry } from "@/lib/planner/types"

const EPOCH = "1970-01-01T00:00:00Z"
const ZERO_ID = "00000000-0000-0000-0000-000000000000"
const OVERLAP_MS = 5_000
/** Binned entries are purged after 90 days; a device away longer starts over. */
const KEEP_MS = 85 * 86_400_000

/**
 * GET /v1/planner/changes?since=<token> — every event and task changed since the token (binned ones carry
 * `deleted_at`), plus all calendars and task lists. Call without `since` for a full sync; keep calling with
 * `next_since` while `has_more` is true. Apply entries by id, ignoring ones whose `version` is not newer.
 */
export const GET = handler(async (request: Request) => {
  const { db } = await requireUser(request)
  const q = changesSchema.parse(Object.fromEntries(searchParams(request)))
  const since = decodeCursor(q.since, isChangesCursor) ?? { u: EPOCH, i: ZERO_ID, t: EPOCH, tail: false }

  if (since.s && Date.now() - new Date(since.s).getTime() > KEEP_MS) {
    return ok({ entries: [], lists: await ensureLists(db), next_since: null, has_more: false, reset: true, server_time: new Date().toISOString() })
  }
  const from = since.tail ? { u: new Date(new Date(since.u).getTime() - OVERLAP_MS).toISOString(), i: ZERO_ID } : { u: since.u, i: since.i }
  const [entriesRes, lists] = await Promise.all([
    db
      .from("planner_entries")
      .select(ENTRY_COLUMNS)
      .or(keysetAfter(from))
      .order("updated_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(q.limit + 1),
    ensureLists(db),
  ])
  if (entriesRes.error) throw fromDb(entriesRes.error)
  const rows = entriesRes.data as unknown as Entry[]
  const page = rows.slice(0, q.limit)
  const hasMore = rows.length > q.limit
  const last = page.at(-1)
  const next: ChangesCursor = { u: last?.updated_at ?? since.u, i: last?.id ?? since.i, t: EPOCH, tail: !hasMore, s: new Date().toISOString() }
  return ok({ entries: page, lists, next_since: encodeCursor(next), has_more: hasMore, reset: false, server_time: new Date().toISOString() })
})
