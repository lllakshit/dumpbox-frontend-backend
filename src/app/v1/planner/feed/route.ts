import { createHash } from "node:crypto"
import { ApiError, handler, ok, searchParams } from "@/lib/api/http"
import { toIcs } from "@/lib/planner/ics"
import { DEFAULT_PREFS, ENTRY_COLUMNS, LIST_COLUMNS, type Entry } from "@/lib/planner/types"
import { adminClient } from "@/lib/supabase/server"

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

/**
 * GET /v1/planner/feed?token=…[&format=ics] — no sign-in: the secret token is the key (made with
 * POST /v1/planner/feed-token). Read-only: events and tasks (not the bin), lists and planner preferences.
 * Used by the phone's background reminder check and by calendar apps that subscribe to an address.
 * Uses the server key, so the token is checked here and only that user's rows are read.
 */
export const GET = handler(async (request: Request) => {
  const sp = searchParams(request)
  const token = sp.get("token") ?? ""
  const notFound = new ApiError("not_found", "This calendar address does not exist or has been turned off")
  if (!TOKEN_RE.test(token)) throw notFound
  const admin = adminClient()
  const hash = createHash("sha256").update(token).digest("hex")
  const { data: row, error } = await admin.from("planner_feed_tokens").select("user_id").eq("token_hash", hash).maybeSingle()
  if (error) throw new ApiError("internal_error", "Could not read the calendar")
  if (!row) throw notFound
  const userId = row.user_id as string
  await admin.from("planner_feed_tokens").update({ last_used_at: new Date().toISOString() }).eq("user_id", userId)

  const entries: Entry[] = []
  for (let from = 0; from < 20_000; from += 1000) {
    const { data, error: e } = await admin.from("planner_entries").select(ENTRY_COLUMNS).eq("user_id", userId).is("deleted_at", null).order("id").range(from, from + 999)
    if (e) throw new ApiError("internal_error", "Could not read the calendar")
    entries.push(...((data ?? []) as unknown as Entry[]))
    if (!data || data.length < 1000) break
  }
  if (sp.get("format") === "ics") {
    return new Response(toIcs(entries, "DumpBox"), {
      headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
    })
  }
  const [{ data: lists }, { data: user }] = await Promise.all([
    admin.from("planner_lists").select(LIST_COLUMNS).eq("user_id", userId),
    admin.auth.admin.getUserById(userId),
  ])
  const prefs = { ...DEFAULT_PREFS, ...((user?.user?.user_metadata?.planner as object | undefined) ?? {}) }
  return ok({ entries, lists: lists ?? [], prefs, server_time: new Date().toISOString() })
})
