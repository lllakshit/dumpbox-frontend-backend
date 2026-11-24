import { z } from "zod"
import { requireUser } from "@/lib/api/auth"
import { ApiError, fromDb, handler, ok, readJson } from "@/lib/api/http"
import { createEntrySchema, ensureLists, rowFromCreate } from "@/lib/api/planner"
import { readImport, type EntryDraft } from "@/lib/planner/importers"
import { isTimeZone } from "@/lib/planner/time"
import { ENTRY_COLUMNS, LIST_COLORS, LIST_COLUMNS, type Entry, type PlannerList } from "@/lib/planner/types"

export const maxDuration = 60

const schema = z
  .object({
    /** File or pasted text: JSON, .ics, or one entry per line. */
    text: z.string().max(4_000_000).optional(),
    /** Already-parsed JSON (an array, or an object with events / tasks / entries / items). */
    data: z.unknown().optional(),
    dry_run: z.boolean().default(false),
    time_zone: z.string().max(64).refine(isTimeZone, "Unknown time zone").default("UTC"),
    default_kind: z.enum(["event", "task"]).default("event"),
    /** Put everything in this calendar / list (else by each entry's list name, else the default). */
    calendar_id: z.uuid().optional(),
    list_id: z.uuid().optional(),
    default_event_minutes: z.number().int().min(5).max(1440).default(60),
  })
  .refine((v) => v.text !== undefined || v.data !== undefined, "Send `text` or `data`")

const WRITE_BATCH = 200
/** Ids and UIDs go in the query string; small batches keep it short (UIDs can be 500 characters). */
const LOOKUP_BATCH = 30

/**
 * POST /v1/planner/import — imports events and tasks. `dry_run: true` returns what would be imported (and the
 * problems found) without saving; both run exactly the same checks, and a bad entry is skipped (listed in
 * `errors`), never the whole file. Importing the same file twice updates the same entries (matched by the file's
 * UID / external id, or by id when it is already yours), so nothing is duplicated.
 */
export const POST = handler(async (request: Request) => {
  const { db } = await requireUser(request)
  const input = schema.parse(await readJson(request, 4_400_000))
  const read = readImport(input.text ?? input.data, { tz: input.time_zone, defaultKind: input.default_kind, defaultEventMinutes: input.default_event_minutes })
  const errors = [...read.errors]

  // Same UID twice in one file: the later one wins.
  const byExt = new Map<string, number>()
  const drafts: EntryDraft[] = []
  for (const d of read.drafts) {
    if (d.external_id && byExt.has(d.external_id)) {
      drafts[byExt.get(d.external_id)!] = d
      errors.push(`“${d.title}”: appears twice in the file, the later copy is used`)
      continue
    }
    if (d.external_id) byExt.set(d.external_id, drafts.length)
    drafts.push(d)
  }

  let lists = await ensureLists(db)
  const byName = (kind: "calendar" | "tasks", name: string | null | undefined): PlannerList | undefined =>
    name ? lists.find((l) => l.kind === kind && l.name.toLowerCase() === name.toLowerCase()) : undefined

  // Validate each draft exactly as a normal create is (schema, then timing rules).
  type Ok = { draft: EntryDraft; body: z.infer<typeof createEntrySchema> }
  const valid: Ok[] = []
  drafts.forEach((d, i) => {
    const rest: Partial<EntryDraft> = { ...d }
    delete rest.list_name
    delete rest.list_id
    const r = createEntrySchema.safeParse({ ...rest, time_zone: rest.time_zone ?? input.time_zone })
    if (!r.success) {
      errors.push(`“${d.title}” (${i + 1}): ${r.error.issues.map((x) => `${x.path.join(".") || "entry"} ${x.message}`).join("; ")}`)
      return
    }
    try {
      rowFromCreate(r.data, lists)
      valid.push({ draft: d, body: r.data })
    } catch (e) {
      errors.push(`“${d.title}” (${i + 1}): ${e instanceof ApiError ? e.message : "not valid"}`)
    }
  })

  const summary = {
    format: read.format,
    events: valid.filter((v) => v.body.kind === "event").length,
    tasks: valid.filter((v) => v.body.kind === "task").length,
    errors,
  }
  if (input.dry_run) {
    return ok({ ...summary, dry_run: true, preview: valid.slice(0, 200).map((v) => ({ ...v.body, list_name: v.draft.list_name ?? null })) })
  }

  // Create calendars / lists named in the file that do not exist yet.
  const want = new Map<string, { kind: "calendar" | "tasks"; name: string }>()
  for (const v of valid) {
    if (!v.draft.list_name) continue
    const kind = v.body.kind === "event" ? "calendar" : "tasks"
    if ((kind === "calendar" && input.calendar_id) || (kind === "tasks" && input.list_id)) continue
    if (!byName(kind, v.draft.list_name)) want.set(`${kind}:${v.draft.list_name.toLowerCase()}`, { kind, name: v.draft.list_name.slice(0, 80) })
  }
  for (const { kind, name } of want.values()) {
    const n = lists.filter((l) => l.kind === kind).length
    const { error } = await db.from("planner_lists").insert({ kind, name, color: LIST_COLORS[n % LIST_COLORS.length], position: n + 1 }).select(LIST_COLUMNS).single()
    if (error && error.code !== "23505") throw fromDb(error)
  }
  if (want.size) lists = await ensureLists(db)

  const rows = valid.map((v) => {
    const kind = v.body.kind === "event" ? "calendar" : "tasks"
    const listId = (kind === "calendar" ? input.calendar_id : input.list_id) ?? byName(kind, v.draft.list_name)?.id ?? null
    return rowFromCreate({ ...v.body, list_id: listId }, lists) as Record<string, unknown>
  })

  async function existing(column: "id" | "external_id", values: string[]) {
    const found = new Map<string, string>()
    for (let i = 0; i < values.length; i += LOOKUP_BATCH) {
      const { data, error } = await db.from("planner_entries").select("id,external_id").in(column, values.slice(i, i + LOOKUP_BATCH))
      if (error) throw fromDb(error)
      for (const r of data ?? []) found.set(String(r[column]), r.id as string)
    }
    return found
  }
  // Rows already in this account: by UID first, then by id. Ids from someone else's export are dropped (a new id
  // is made), so moving data between accounts works.
  const byUid = await existing("external_id", rows.map((r) => r.external_id as string | null).filter((x): x is string => Boolean(x)))
  const mine = await existing("id", rows.map((r) => r.id as string | undefined).filter((x): x is string => Boolean(x)))
  const seenIds = new Set<string>()
  const upserts = rows.map((r) => {
    const uidMatch = r.external_id ? byUid.get(r.external_id as string) : undefined
    let id = uidMatch ?? (r.id && mine.has(r.id as string) ? (r.id as string) : undefined)
    if (id && seenIds.has(id)) id = undefined
    if (id) seenIds.add(id)
    const rest = { ...r }
    delete rest.id
    return id ? { ...rest, id, deleted_at: null } : rest
  })
  const updated = upserts.filter((r) => "id" in r).length

  const saved: Entry[] = []
  for (let i = 0; i < upserts.length; i += WRITE_BATCH) {
    const chunk = upserts.slice(i, i + WRITE_BATCH)
    const withId = chunk.filter((r) => "id" in r)
    const fresh = chunk.filter((r) => !("id" in r))
    if (withId.length) {
      const { data, error } = await db.from("planner_entries").upsert(withId, { onConflict: "id" }).select(ENTRY_COLUMNS)
      if (error) throw fromDb(error)
      saved.push(...((data ?? []) as unknown as Entry[]))
    }
    if (fresh.length) {
      const { data, error } = await db.from("planner_entries").insert(fresh).select(ENTRY_COLUMNS)
      if (error) throw fromDb(error)
      saved.push(...((data ?? []) as unknown as Entry[]))
    }
  }
  return ok({ ...summary, dry_run: false, created: saved.length - updated, updated, entries: saved.slice(0, 500), lists })
})
