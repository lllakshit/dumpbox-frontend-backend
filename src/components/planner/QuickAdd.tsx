"use client"
import { useMemo, useState } from "react"
import { parseQuickAdd } from "@/lib/planner/parse"
import { describeRule, parseRule } from "@/lib/planner/recurrence"
import { resolveParsed, type ResolvedEntry } from "@/lib/planner/resolve"
import { toWall } from "@/lib/planner/time"
import { reminderLabel, type EntryKind } from "@/lib/planner/types"
import type { Planner } from "@/lib/client/planner"
import { Icon } from "../app/icons"

/** Text → body for POST /v1/planner/entries, with the list picked by #name when one matches. */
export function quickBody(planner: Planner, text: string, kind: EntryKind, defaultDate?: string): { body: Record<string, unknown>; resolved: ResolvedEntry } {
  const parsed = parseQuickAdd(text, toWall(new Date(), planner.tz), { weekStart: planner.prefs.week_start })
  const r = resolveParsed(parsed, { tz: planner.tz, kind, defaultEventMinutes: planner.prefs.default_event_minutes, defaultDate })
  const listKind = r.kind === "event" ? "calendar" : "tasks"
  const list = r.list_name ? planner.lists.find((l) => l.kind === listKind && l.name.toLowerCase() === r.list_name!.toLowerCase()) : undefined
  const hasDate = Boolean(r.start_at || r.start_date)
  const body: Record<string, unknown> = {
    kind: r.kind,
    title: list || !r.list_name ? r.title : `${r.title} #${r.list_name}`,
    all_day: r.all_day,
    start_at: r.start_at,
    end_at: r.end_at,
    start_date: r.start_date,
    end_date: r.end_date,
    time_zone: r.time_zone,
    rrule: r.rrule,
    reminders: r.reminders ?? (hasDate ? (r.kind === "event" ? planner.prefs.default_event_reminders : planner.prefs.default_task_reminders) : []),
    location: r.location,
    starred: r.starred,
    ...(list ? { list_id: list.id } : {}),
  }
  return { body, resolved: r }
}

export function describeBody(b: Record<string, unknown>, tz: string): string[] {
  const out: string[] = []
  const fmt = (iso: string) => {
    const w = toWall(new Date(iso), tz)
    return `${w.date} ${w.time}`
  }
  if (b.start_at) out.push(`${fmt(b.start_at as string)}${b.end_at ? ` → ${toWall(new Date(b.end_at as string), tz).time}` : ""}`)
  else if (b.start_date) out.push(`${b.start_date}${b.end_date ? ` → ${b.end_date}` : ""} (all day)`)
  if (b.rrule) out.push(describeRule(parseRule(b.rrule as string), (b.start_date as string) ?? undefined))
  for (const m of (b.reminders as number[]) ?? []) out.push(`🔔 ${reminderLabel(m, Boolean(b.all_day))}`)
  if (b.location) out.push(`📍 ${b.location}`)
  if (b.starred) out.push("★ starred")
  return out
}

export function QuickAdd({
  planner,
  defaultKind,
  defaultDate,
  listId,
  parentId,
  placeholder,
  onMore,
}: {
  planner: Planner
  defaultKind: EntryKind
  defaultDate?: string
  listId?: string
  parentId?: string
  placeholder?: string
  onMore?: (body: Record<string, unknown>) => void
}) {
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const preview = useMemo(() => (text.trim() ? quickBody(planner, text, defaultKind, defaultDate) : null), [text, planner, defaultKind, defaultDate])

  const submit = async () => {
    if (!preview || busy) return
    const body = { ...preview.body }
    if (listId && body.kind === defaultKind && !body.list_id) body.list_id = listId
    if (parentId) body.parent_id = parentId
    if (body.kind === "event" && !body.start_at && !body.start_date) {
      // An event needs a day: today, all day.
      body.all_day = true
      body.start_date = toWall(new Date(), planner.tz).date
    }
    setBusy(true)
    const made = await planner.create(body)
    setBusy(false)
    if (made) setText("")
  }

  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        className="flex items-center gap-2"
      >
        <label htmlFor={`qa-${defaultKind}-${parentId ?? "root"}`} className="sr-only">
          Quick add
        </label>
        <input
          id={`qa-${defaultKind}-${parentId ?? "root"}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setText("")}
          placeholder={placeholder ?? (defaultKind === "task" ? "Add a task: “Pay rent on the 1st every month”" : "Add: “Lunch with Rahul friday 1pm”")}
          maxLength={2000}
          className="min-w-0 flex-1 rounded-xl border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
        />
        {onMore && preview ? (
          <button type="button" onClick={() => onMore(preview.body)} className="rounded-xl px-2 py-2 text-xs text-accent hover:bg-panel-2">
            More options
          </button>
        ) : null}
        <button type="submit" disabled={!preview || busy} className="grid h-9 w-9 place-items-center rounded-xl bg-accent text-accent-ink disabled:opacity-40" aria-label="Add">
          <Icon.plus width={18} height={18} />
        </button>
      </form>
      {preview ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-2" aria-live="polite">
          <span className="rounded-full bg-accent-soft px-2 py-0.5 font-medium text-accent">{preview.body.kind === "event" ? "Event" : "Task"}</span>
          <span className="font-medium text-ink">{String(preview.body.title)}</span>
          {describeBody(preview.body, planner.tz).map((d) => (
            <span key={d} className="rounded-full border border-line px-2 py-0.5">
              {d}
            </span>
          ))}
          {preview.resolved.list_name ? <span className="rounded-full border border-line px-2 py-0.5">#{preview.resolved.list_name}{preview.body.list_id ? "" : " (no such list)"}</span> : null}
        </div>
      ) : null}
    </div>
  )
}
