import { z } from "zod"
import { requireUser } from "@/lib/api/auth"
import { fromDb, handler, ok, readJson } from "@/lib/api/http"
import { createEntrySchema, ensureLists, rowFromCreate } from "@/lib/api/planner"
import { readImport, type EntryDraft } from "@/lib/planner/importers"
import { isTimeZone } from "@/lib/planner/time"
import { ENTRY_COLUMNS, LIST_COLORS, LIST_COLUMNS, type Entry, type PlannerList } from "@/lib/planner/types"

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

const BATCH = 200

/**
 * POST /v1/planner/import — imports events and tasks. `dry_run: true` returns what would be imported (and the
 * problems found) without saving. Importing the same file twice updates the same entries (matched by `id`, the
 * file's UID / external id), so nothing is duplicated.
 */
export const POST = handler(async (request: Request) => {
  const { db } = await requireUser(request)
  const input = schema.parse(await readJson(request, 4_400_000))
  const read = readImport(input.text ?? input.data, { tz: input.time_zone, defaultKind: input.default_kind, defaultEventMinutes: input.default_event_minutes })
  const errors = [...read.errors]

  // Validate each draft exactly as a normal create would be.
  type Ok = { draft: EntryDraft; body: z.infer<typeof createEntrySchema> }
  const valid: Ok[] = []
  read.drafts.forEach((d, i) => {
    const rest: Partial<EntryDraft> = { ...d }
    delete rest.list_name
    delete rest.list_id
    const r = createEntrySchema.safeParse({ ...rest, time_zone: rest.time_zone ?? input.time_zone })
    if (r.success) valid.push({ draft: d, body: r.data })
    else errors.push(`“${d.title}” (${i + 1}): ${r.error.issues.map((x) => `${x.path.join(".") || "entry"} ${x.message}`).join("; ")}`)
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

  let lists = await ensureLists(db)
  // Create calendars / lists named in the file that do not exist yet.
  const want = new Map<string, "calendar" | "tasks">()
  for (const v of valid) {
    if (!v.draft.list_name) continue
    const kind = v.body.kind === "event" ? "calendar" : "tasks"
    if ((kind === "calendar" && input.calendar_id) || (kind === "tasks" && input.list_id)) continue
    if (!lists.some((l) => l.kind === kind && l.name.toLowerCase() === v.draft.list_name!.toLowerCase())) want.set(`${kind}:${v.draft.list_name.toLowerCase()}`, kind)
  }
  for (const [key, kind] of want) {
    const name = valid.find((v) => v.draft.list_name?.toLowerCase() === key.split(":").slice(1).join(":"))!.draft.list_name!.slice(0, 80)
    const n = lists.filter((l) => l.kind === kind).length
    const { error } = await db.from("planner_lists").insert({ kind, name, color: LIST_COLORS[n % LIST_COLORS.length], position: n + 1 }).select(LIST_COLUMNS).single()
    if (error && error.code !== "23505") throw fromDb(error)
  }
  if (want.size) lists = await ensureLists(db)
  const byName = (kind: "calendar" | "tasks", name: string | null | undefined): PlannerList | undefined =>
    name ? lists.find((l) => l.kind === kind && l.name.toLowerCase() === name.toLowerCase()) : undefined

  const rows = valid.map((v) => {
    const kind = v.body.kind === "event" ? "calendar" : "tasks"
    const listId = (kind === "calendar" ? input.calendar_id : input.list_id) ?? byName(kind, v.draft.list_name)?.id ?? null
    return rowFromCreate({ ...v.body, list_id: listId }, lists) as Record<string, unknown>
  })

  // Re-imports update the entries they made before (same external id), including ones in the bin.
  const ext = rows.map((r) => r.external_id as string | null).filter((x): x is string => Boolean(x))
  const existing = new Map<string, string>()
  for (let i = 0; i < ext.length; i += BATCH) {
    const { data, error } = await db.from("planner_entries").select("id,external_id").in("external_id", ext.slice(i, i + BATCH))
    if (error) throw fromDb(error)
    for (const r of data ?? []) existing.set(r.external_id as string, r.id as string)
  }
  const saved: Entry[] = []
  const upserts = rows.map((r) => {
    const id = r.external_id ? existing.get(r.external_id as string) : undefined
    return id ? { ...r, id, deleted_at: null } : r
  })
  // Count what already exists (by id) so the summary can say created vs updated.
  const ids = upserts.map((r) => r.id as string | undefined).filter((x): x is string => Boolean(x))
  let updated = 0
  for (let i = 0; i < ids.length; i += BATCH) {
    const { data, error } = await db.from("planner_entries").select("id").in("id", ids.slice(i, i + BATCH))
    if (error) throw fromDb(error)
    updated += data?.length ?? 0
  }
  for (let i = 0; i < upserts.length; i += BATCH) {
    const chunk = upserts.slice(i, i + BATCH)
    const withId = chunk.filter((r) => r.id)
    const fresh = chunk.filter((r) => !r.id)
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
