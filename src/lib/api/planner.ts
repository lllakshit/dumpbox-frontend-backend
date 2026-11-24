import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"
import { formatRule, nextAfterCurrent, parseRule } from "@/lib/planner/recurrence"
import { isTimeZone, isWallDate } from "@/lib/planner/time"
import { ENTRY_COLUMNS, LIST_COLORS, LIST_COLUMNS, type Entry, type EntryKind, type PlannerList } from "@/lib/planner/types"
import { ApiError, fromDb } from "./http"

// ---------------------------------------------------------------------------- schemas

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/)
const wallDate = z.string().refine(isWallDate, "Must be a date (YYYY-MM-DD)")
const instant = z.iso.datetime({ offset: true })
const rrule = z
  .string()
  .max(500)
  .refine((v) => parseRule(v) !== null, "Unsupported repeat rule")
  .transform((v) => formatRule(parseRule(v)!))
const tz = z.string().max(64).refine(isTimeZone, "Unknown time zone")
/** The database limits notes by bytes (UTF-8), not characters. */
const notesText = z.string().refine((v) => new TextEncoder().encode(v).length <= 50_000, "Notes must be at most 50,000 bytes")

const entryFields = {
  kind: z.enum(["event", "task"]),
  list_id: z.uuid().nullable(),
  parent_id: z.uuid().nullable(),
  title: z.string().trim().min(1).max(1000),
  notes: notesText.nullable(),
  location: z.string().max(1000).nullable(),
  all_day: z.boolean(),
  start_at: instant.nullable(),
  end_at: instant.nullable(),
  start_date: wallDate.nullable(),
  end_date: wallDate.nullable(),
  time_zone: tz.nullable(),
  rrule: rrule.nullable(),
  exdates: z.array(z.string().max(40)).max(500),
  reminders: z.array(z.number().int().min(0).max(40_320)).max(5),
  color: hex.nullable(),
  completed: z.boolean(),
  starred: z.boolean(),
  position: z.number().finite(),
  source_item_id: z.uuid().nullable(),
  external_id: z.string().max(500).nullable(),
}

export const createEntrySchema = z.object({
  /** Client-generated id makes retries from offline queues idempotent. */
  id: z.uuid().optional(),
  kind: entryFields.kind,
  title: entryFields.title,
  list_id: entryFields.list_id.optional(),
  parent_id: entryFields.parent_id.optional(),
  notes: entryFields.notes.optional(),
  location: entryFields.location.optional(),
  all_day: entryFields.all_day.optional(),
  start_at: entryFields.start_at.optional(),
  end_at: entryFields.end_at.optional(),
  start_date: entryFields.start_date.optional(),
  end_date: entryFields.end_date.optional(),
  time_zone: entryFields.time_zone.optional(),
  rrule: entryFields.rrule.optional(),
  exdates: entryFields.exdates.optional(),
  reminders: entryFields.reminders.optional(),
  color: entryFields.color.optional(),
  completed: entryFields.completed.optional(),
  starred: entryFields.starred.optional(),
  position: entryFields.position.optional(),
  source_item_id: entryFields.source_item_id.optional(),
  external_id: entryFields.external_id.optional(),
})
export type CreateEntryInput = z.infer<typeof createEntrySchema>

export const updateEntrySchema = createEntrySchema
  .omit({ id: true })
  .partial()
  .extend({
    /** false restores an entry from the bin. */
    deleted: z.boolean().optional(),
    /** Version the client last saw; reported back as `merged` when the row had moved on. */
    base_version: z.number().int().positive().optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== "base_version"), "Nothing to update")

export const listSchema = z.object({
  kind: z.enum(["calendar", "tasks"]),
  name: z.string().trim().min(1).max(80),
  color: hex.optional(),
})
export const listUpdateSchema = z
  .object({ name: z.string().trim().min(1).max(80), color: hex, hidden: z.boolean(), position: z.number().int().min(0).max(10_000) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update")

export const rangeSchema = z.object({
  from: wallDate,
  to: wallDate,
  kind: z.enum(["event", "task"]).optional(),
})

// ---------------------------------------------------------------------------- rows

type Row = Omit<Entry, never>

/** Shapes timing so the database checks hold: all-day uses dates only, timed uses instants only. */
export function normaliseTiming(e: {
  kind: EntryKind
  all_day: boolean
  start_at: string | null
  end_at: string | null
  start_date: string | null
  end_date: string | null
}) {
  const out = { ...e }
  if (out.all_day) {
    if (!out.start_date && out.start_at) out.start_date = out.start_at.slice(0, 10)
    out.start_at = null
    out.end_at = null
    if (out.end_date && out.start_date && out.end_date < out.start_date) throw new ApiError("validation_failed", "End date is before the start date")
    if (out.end_date === out.start_date) out.end_date = null
    if (!out.start_date) out.end_date = null
  } else {
    out.start_date = null
    out.end_date = null
    if (out.end_at && !out.start_at) out.end_at = null
    if (out.start_at && out.end_at && new Date(out.end_at) < new Date(out.start_at)) throw new ApiError("validation_failed", "End time is before the start time")
    if (out.start_at) out.start_at = new Date(out.start_at).toISOString()
    if (out.end_at) out.end_at = new Date(out.end_at).toISOString()
  }
  if (e.kind === "event" && !out.start_at && !out.start_date) throw new ApiError("validation_failed", "An event needs a start date or time")
  // A rule needs a start to repeat from.
  return out
}

export async function readLists(db: SupabaseClient): Promise<PlannerList[]> {
  const { data, error } = await db.from("planner_lists").select(LIST_COLUMNS).order("kind").order("position").order("name")
  if (error) throw fromDb(error)
  return data as PlannerList[]
}

/** Lists, creating the default calendar and task list the first time. */
export async function ensureLists(db: SupabaseClient): Promise<PlannerList[]> {
  let lists = await readLists(db)
  const missing: { kind: "calendar" | "tasks"; name: string; color: string; is_default: true }[] = []
  if (!lists.some((l) => l.kind === "calendar" && l.is_default)) missing.push({ kind: "calendar", name: "Personal", color: LIST_COLORS[0], is_default: true })
  if (!lists.some((l) => l.kind === "tasks" && l.is_default)) missing.push({ kind: "tasks", name: "My Tasks", color: LIST_COLORS[1], is_default: true })
  if (missing.length) {
    for (const m of missing) {
      const { error } = await db.from("planner_lists").insert(m)
      // Another device created it at the same moment (default or name taken): fine.
      if (error && error.code !== "23505") throw fromDb(error)
    }
    lists = await readLists(db)
  }
  return lists
}

export function defaultListId(lists: PlannerList[], kind: EntryKind): string | null {
  const want = kind === "event" ? "calendar" : "tasks"
  return lists.find((l) => l.kind === want && l.is_default)?.id ?? lists.find((l) => l.kind === want)?.id ?? null
}

/** Picks the list for an entry: the given one when it fits the kind, else the default. */
export function listFor(lists: PlannerList[], kind: EntryKind, listId: string | null | undefined): string | null {
  const want = kind === "event" ? "calendar" : "tasks"
  if (listId) {
    // A list deleted elsewhere (say, while the phone was offline) falls back to the default instead of failing.
    const l = lists.find((x) => x.id === listId)
    if (l && l.kind === want) return l.id
  }
  return defaultListId(lists, kind)
}

/** Insert row for a create request. */
export function rowFromCreate(input: CreateEntryInput, lists: PlannerList[]) {
  const timing = normaliseTiming({
    kind: input.kind,
    all_day: input.all_day ?? Boolean(input.start_date && !input.start_at),
    start_at: input.start_at ?? null,
    end_at: input.end_at ?? null,
    start_date: input.start_date ?? null,
    end_date: input.end_date ?? null,
  })
  return {
    ...(input.id ? { id: input.id } : {}),
    list_id: listFor(lists, input.kind, input.list_id),
    parent_id: input.kind === "task" ? (input.parent_id ?? null) : null,
    title: input.title,
    notes: input.notes ?? null,
    location: input.location ?? null,
    ...timing,
    time_zone: input.time_zone ?? null,
    rrule: timing.start_at || timing.start_date ? (input.rrule ?? null) : null,
    exdates: input.exdates ?? [],
    reminders: [...new Set(input.reminders ?? [])].sort((a, b) => a - b),
    color: input.color ?? null,
    completed_at: input.completed ? new Date().toISOString() : null,
    starred: input.starred ?? false,
    position: input.position ?? Date.now() / 1000,
    source_item_id: input.source_item_id ?? null,
    external_id: input.external_id ?? null,
  }
}

export async function getEntry(db: SupabaseClient, id: string): Promise<Row> {
  const { data, error } = await db.from("planner_entries").select(ENTRY_COLUMNS).eq("id", id).maybeSingle()
  if (error) throw fromDb(error, "Entry not found")
  if (!data) throw new ApiError("not_found", "Entry not found")
  return data as unknown as Row
}

/**
 * Applies a patch to an entry. Completing a repeating task moves the repeat to a new copy at the next date (the
 * finished one stays in "Completed"), as Google Tasks does. Returns the updated entry and that copy, if any.
 */
export async function patchEntry(
  db: SupabaseClient,
  id: string,
  input: z.infer<typeof updateEntrySchema>,
  lists: PlannerList[],
): Promise<{ entry: Row; next: Row | null; merged: boolean }> {
  const cur = await getEntry(db, id)
  const kind = input.kind ?? cur.kind
  const timing = normaliseTiming({
    kind,
    all_day: input.all_day ?? cur.all_day,
    start_at: input.start_at !== undefined ? input.start_at : cur.start_at,
    end_at: input.end_at !== undefined ? input.end_at : cur.end_at,
    start_date: input.start_date !== undefined ? input.start_date : cur.start_date,
    end_date: input.end_date !== undefined ? input.end_date : cur.end_date,
  })
  const patch: Record<string, unknown> = { ...timing }
  for (const k of ["title", "notes", "location", "time_zone", "rrule", "exdates", "color", "starred", "position", "source_item_id", "external_id", "parent_id"] as const) {
    if (input[k] !== undefined) patch[k] = input[k]
  }
  if (input.reminders !== undefined) patch.reminders = [...new Set(input.reminders)].sort((a, b) => a - b)
  if (input.list_id !== undefined || input.kind !== undefined) patch.list_id = listFor(lists, kind, input.list_id !== undefined ? input.list_id : cur.list_id)
  if (kind === "event") patch.parent_id = null
  if (!timing.start_at && !timing.start_date) patch.rrule = null
  if (input.deleted === false) patch.deleted_at = null
  if (input.deleted === true) patch.deleted_at = new Date().toISOString()

  let nextRow: Record<string, unknown> | null = null
  if (input.completed !== undefined) {
    patch.completed_at = input.completed ? (cur.completed_at ?? new Date().toISOString()) : null
    const rule = (patch.rrule !== undefined ? patch.rrule : cur.rrule) as string | null
    if (input.completed && !cur.completed_at && kind === "task" && rule) {
      const n = nextAfterCurrent({ ...cur, ...timing, rrule: rule, time_zone: (patch.time_zone as string | null | undefined) ?? cur.time_zone }, "UTC")
      if (n) {
        nextRow = {
          kind: "task",
          list_id: (patch.list_id as string | null | undefined) ?? cur.list_id,
          parent_id: cur.parent_id,
          title: (patch.title as string | undefined) ?? cur.title,
          notes: patch.notes !== undefined ? patch.notes : cur.notes,
          location: patch.location !== undefined ? patch.location : cur.location,
          all_day: timing.all_day,
          ...n,
          time_zone: (patch.time_zone as string | null | undefined) ?? cur.time_zone,
          reminders: (patch.reminders as number[] | undefined) ?? cur.reminders,
          color: patch.color !== undefined ? patch.color : cur.color,
          starred: (patch.starred as boolean | undefined) ?? cur.starred,
          position: cur.position,
          source_item_id: cur.source_item_id,
        }
      }
      // The finished one no longer repeats; the copy carries the rule on.
      patch.rrule = null
      patch.exdates = []
    }
  }

  // Finishing a repeating task only counts once: the update matches only while it is still open, so a second
  // device completing it at the same moment does not make a second "next" copy.
  let q = db.from("planner_entries").update(patch).eq("id", id)
  if (nextRow) q = q.is("completed_at", null)
  const { data, error } = await q.select(ENTRY_COLUMNS).maybeSingle()
  if (error) throw fromDb(error, "Entry not found")
  if (!data) {
    if (nextRow) return { entry: await getEntry(db, id), next: null, merged: true }
    throw new ApiError("not_found", "Entry not found")
  }
  let next: Row | null = null
  if (nextRow) {
    const r = await db.from("planner_entries").insert(nextRow).select(ENTRY_COLUMNS).single()
    if (r.error) {
      // Put the repeat back so it is not lost.
      await db.from("planner_entries").update({ completed_at: null, rrule: cur.rrule, exdates: cur.exdates }).eq("id", id)
      throw fromDb(r.error)
    }
    next = r.data as unknown as Row
  }
  // Removing a task removes its subtasks with it (and restoring brings them back).
  if (input.deleted !== undefined && kind === "task") {
    const { error: ce } = await db.from("planner_entries").update({ deleted_at: input.deleted ? patch.deleted_at : null }).eq("parent_id", id)
    if (ce) throw fromDb(ce)
  }
  return { entry: data as unknown as Row, next, merged: input.base_version !== undefined && input.base_version < cur.version }
}
