import { requireUser } from "@/lib/api/auth"
import { ApiError, fromDb, handler, ok, readJson, searchParams } from "@/lib/api/http"
import { createEntrySchema, ensureLists, getEntry, rangeSchema, rowFromCreate } from "@/lib/api/planner"
import { addDays } from "@/lib/planner/time"
import { ENTRY_COLUMNS, type Entry } from "@/lib/planner/types"

const MAX = 2000

/**
 * GET /v1/planner/entries?from=YYYY-MM-DD&to=YYYY-MM-DD[&kind=event|task]
 * Entries that may fall in the range: dated ones overlapping it, plus every repeating entry (expand them with the
 * repeat rule). Without from/to: every entry, newest change first (up to 2000); use /v1/planner/changes to sync.
 */
export const GET = handler(async (request: Request) => {
  const { db } = await requireUser(request)
  const sp = searchParams(request)
  if (!sp.get("from") && !sp.get("to")) {
    let q = db.from("planner_entries").select(ENTRY_COLUMNS).is("deleted_at", null).order("updated_at", { ascending: false }).limit(MAX)
    const kind = sp.get("kind")
    if (kind === "event" || kind === "task") q = q.eq("kind", kind)
    const { data, error } = await q
    if (error) throw fromDb(error)
    return ok({ entries: data })
  }
  const r = rangeSchema.parse(Object.fromEntries(sp))
  if (r.to < r.from) throw new ApiError("validation_failed", "`to` is before `from`")
  // A day of slack on each side covers time zones.
  const fromTs = `${addDays(r.from, -1)}T00:00:00Z`
  const toTs = `${addDays(r.to, 2)}T00:00:00Z`
  const base = () => {
    const q = db.from("planner_entries").select(ENTRY_COLUMNS).is("deleted_at", null).limit(MAX)
    return r.kind ? q.eq("kind", r.kind) : q
  }
  const [repeating, timed, allDay] = await Promise.all([
    base().not("rrule", "is", null).or(`start_at.lte.${toTs},start_date.lte.${r.to}`),
    base().is("rrule", null).eq("all_day", false).lte("start_at", toTs).or(`end_at.gte.${fromTs},and(end_at.is.null,start_at.gte.${fromTs})`),
    base().is("rrule", null).eq("all_day", true).lte("start_date", r.to).or(`end_date.gte.${r.from},and(end_date.is.null,start_date.gte.${r.from})`),
  ])
  for (const res of [repeating, timed, allDay]) if (res.error) throw fromDb(res.error)
  const seen = new Set<string>()
  const entries = [...(repeating.data ?? []), ...(timed.data ?? []), ...(allDay.data ?? [])].filter((e) => {
    const id = (e as unknown as Entry).id
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
  return ok({ entries })
})

/** POST /v1/planner/entries — create an event or task. Sending the same `id` twice returns the existing one. */
export const POST = handler(async (request: Request) => {
  const { db } = await requireUser(request)
  const input = createEntrySchema.parse(await readJson(request))
  if (input.id) {
    const { data } = await db.from("planner_entries").select("id").eq("id", input.id).maybeSingle()
    if (data) return ok({ entry: await getEntry(db, input.id), created: false })
  }
  const lists = await ensureLists(db)
  const { data, error } = await db.from("planner_entries").insert(rowFromCreate(input, lists)).select(ENTRY_COLUMNS).single()
  if (error) {
    // Lost a race with a retry of the same request.
    if (error.code === "23505" && input.id) return ok({ entry: await getEntry(db, input.id), created: false })
    if (error.code === "23505") throw new ApiError("conflict", "An entry with this external_id already exists")
    throw fromDb(error)
  }
  return ok({ entry: data, created: true }, 201)
})
