import { requireUser } from "@/lib/api/auth"
import { fromDb, handler, ok, searchParams } from "@/lib/api/http"
import { ensureLists } from "@/lib/api/planner"
import { toIcs } from "@/lib/planner/ics"
import { ENTRY_COLUMNS, type Entry } from "@/lib/planner/types"

/**
 * GET /v1/planner/export?format=json|ics[&list=<id>] — every event and task (not the bin).
 * JSON can be imported again as is; .ics opens in Google Calendar, Outlook and Apple Calendar.
 */
export const GET = handler(async (request: Request) => {
  const { db } = await requireUser(request)
  const sp = searchParams(request)
  const format = sp.get("format") === "ics" ? "ics" : "json"
  const listId = sp.get("list")
  const lists = await ensureLists(db)
  const entries: Entry[] = []
  for (let from = 0; ; from += 1000) {
    let q = db.from("planner_entries").select(ENTRY_COLUMNS).is("deleted_at", null).order("id").range(from, from + 999)
    if (listId) q = q.eq("list_id", listId)
    const { data, error } = await q
    if (error) throw fromDb(error)
    entries.push(...((data ?? []) as unknown as Entry[]))
    if (!data || data.length < 1000) break
  }
  const day = new Date().toISOString().slice(0, 10)
  if (format === "ics") {
    const name = listId ? (lists.find((l) => l.id === listId)?.name ?? "DumpBox") : "DumpBox"
    return new Response(toIcs(entries, name), {
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        "content-disposition": `attachment; filename="dumpbox-calendar-${day}.ics"`,
        "cache-control": "no-store",
      },
    })
  }
  const listName = new Map(lists.map((l) => [l.id, l.name]))
  return ok(
    {
      format: "dumpbox-planner",
      version: 1,
      exported_at: new Date().toISOString(),
      lists,
      entries: entries.map((e) => ({ ...e, list: e.list_id ? (listName.get(e.list_id) ?? null) : null })),
    },
    200,
    { "content-disposition": `attachment; filename="dumpbox-planner-${day}.json"` },
  )
})
