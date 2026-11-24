"use client"
import { useMemo, useState } from "react"
import { describeRule, formatRule, parseRule, rulePresets, WD, type Rule } from "@/lib/planner/recurrence"
import { addDays, diffDays, fromWall, isTimeZone, minutesOf, timeFromMinutes, toWall, todayIn, weekday, zoneOffsetMinutes } from "@/lib/planner/time"
import { REMINDER_CHOICES, reminderLabel, type Entry, type EntryKind, type PlannerList } from "@/lib/planner/types"
import type { Planner } from "@/lib/client/planner"
import { occurrenceDate, shiftExdates, splitSeries } from "@/lib/planner/series"
import { Button, Modal } from "../app/ui"
import { Icon } from "../app/icons"

export type EditorTarget = {
  /** Existing entry, or a draft for a new one. */
  entry?: Entry
  /** For a repeating event opened from the calendar: the occurrence that was clicked. */
  occurrence?: { key: string; allDay: boolean; start: string; end: string; startDate: string; endDate: string }
  /** Prefill for new entries. */
  draft?: Partial<Entry> & { kind: EntryKind }
}

type Form = {
  kind: EntryKind
  title: string
  allDay: boolean
  hasDate: boolean
  startDate: string
  startTime: string
  endDate: string
  endTime: string
  tz: string
  rrule: string | null
  reminders: number[]
  listId: string
  location: string
  notes: string
  color: string | null
  starred: boolean
  completed: boolean
}

const COLORS = [null, "#3a5bd9", "#1e8a52", "#c0392b", "#d97706", "#8e44ad", "#0e7490", "#db2777", "#4b5563"]
const field = "w-full rounded-xl border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
const label = "mb-1 block text-xs font-medium text-ink-2"

function initialForm(t: EditorTarget, p: Planner): Form {
  const e = t.entry
  const d = t.draft
  const kind: EntryKind = e?.kind ?? d?.kind ?? "event"
  const tz = e?.time_zone && isTimeZone(e.time_zone) ? e.time_zone : p.tz
  const today = todayIn(p.tz)
  const def = (k: EntryKind) => p.lists.find((l) => l.kind === (k === "event" ? "calendar" : "tasks") && l.is_default)?.id ?? ""
  const src = e ?? (d as Entry | undefined)
  const occ = t.occurrence
  let allDay = Boolean(src?.all_day)
  let hasDate = kind === "event" || Boolean(src?.start_at || src?.start_date)
  let startDate = today
  let startTime = timeFromMinutes(Math.min(23 * 60, (Math.floor(minutesOf(toWall(new Date(), p.tz).time) / 30) + 1) * 30))
  let endDate = today
  let endTime = timeFromMinutes(minutesOf(startTime) + p.prefs.default_event_minutes)
  if (src?.start_at) {
    const s = toWall(new Date(src.start_at), tz)
    startDate = s.date
    startTime = s.time
    if (src.end_at) {
      const en = toWall(new Date(src.end_at), tz)
      endDate = en.date
      endTime = en.time
    } else {
      endDate = s.date
      endTime = timeFromMinutes(minutesOf(s.time) + (kind === "event" ? p.prefs.default_event_minutes : 0))
    }
    allDay = false
  } else if (src?.start_date) {
    startDate = src.start_date
    endDate = src.end_date ?? src.start_date
    allDay = true
    if (kind === "task") allDay = true
  }
  if (occ) {
    if (occ.allDay) {
      startDate = occ.startDate
      endDate = occ.endDate
    } else {
      // Shown and edited in the entry's own zone, like the rest of the form.
      const s = toWall(new Date(occ.start), tz)
      const en = toWall(new Date(occ.end), tz)
      startDate = s.date
      startTime = s.time
      endDate = en.date
      endTime = en.time
    }
  }
  if (kind === "task" && !src?.start_at) allDay = true
  if (!hasDate && kind === "task") allDay = true
  if (!e && kind === "event" && !src?.start_at && !src?.start_date) hasDate = true
  return {
    kind,
    title: src?.title ?? "",
    allDay,
    hasDate,
    startDate,
    startTime,
    endDate: endDate < startDate ? startDate : endDate,
    endTime,
    tz,
    rrule: src?.rrule ?? null,
    reminders: e ? e.reminders : (d?.reminders ?? (kind === "event" ? p.prefs.default_event_reminders : hasDate ? p.prefs.default_task_reminders : [])),
    listId: src?.list_id ?? def(kind),
    location: src?.location ?? "",
    notes: src?.notes ?? "",
    color: src?.color ?? null,
    starred: Boolean(src?.starred),
    completed: Boolean(src?.completed_at),
  }
}

/** Request body from the form. */
function bodyOf(f: Form): Record<string, unknown> {
  const b: Record<string, unknown> = {
    kind: f.kind,
    title: f.title.trim(),
    list_id: f.listId || null,
    location: f.location.trim() || null,
    notes: f.notes.trim() || null,
    color: f.color,
    starred: f.starred,
    reminders: f.hasDate ? f.reminders : [],
    rrule: f.hasDate ? f.rrule : null,
    time_zone: f.tz,
  }
  if (!f.hasDate) {
    Object.assign(b, { all_day: true, start_at: null, end_at: null, start_date: null, end_date: null })
  } else if (f.allDay) {
    Object.assign(b, { all_day: true, start_at: null, end_at: null, start_date: f.startDate, end_date: f.kind === "event" && f.endDate > f.startDate ? f.endDate : null })
  } else {
    const s = fromWall(f.startDate, f.startTime, f.tz)
    let e = fromWall(f.endDate, f.endTime, f.tz)
    if (e < s) e = s
    Object.assign(b, { all_day: false, start_date: null, end_date: null, start_at: s.toISOString(), end_at: f.kind === "event" ? e.toISOString() : null })
  }
  return b
}

export function EntryEditor({ target, planner, onClose }: { target: EditorTarget; planner: Planner; onClose: () => void }) {
  const [f, setF] = useState<Form>(() => initialForm(target, planner))
  const [busy, setBusy] = useState(false)
  const [scope, setScope] = useState<null | "save" | "delete">(null)
  const [customRepeat, setCustomRepeat] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (p: Partial<Form>) => setF((cur) => ({ ...cur, ...p }))
  const entry = target.entry
  const isNew = !entry
  const repeating = Boolean(entry?.rrule && target.occurrence)
  const lists = planner.lists.filter((l) => l.kind === (f.kind === "event" ? "calendar" : "tasks"))
  const presets = useMemo(() => rulePresets(f.startDate), [f.startDate])
  const presetMatch = presets.find((p) => p.rrule === f.rrule)

  const setStart = (date: string, time?: string) => {
    // Moving the start moves the end with it (keeps the length), like Google Calendar.
    const lenMin = (diffDays(f.startDate, f.endDate) * 1440 + minutesOf(f.endTime) - minutesOf(f.startTime)) | 0
    const t = time ?? f.startTime
    const startMin = minutesOf(t) + lenMin
    const endDate = f.allDay ? addDays(date, Math.max(0, diffDays(f.startDate, f.endDate))) : addDays(date, Math.floor(startMin / 1440))
    set({ startDate: date, startTime: t, endDate, endTime: f.allDay ? f.endTime : timeFromMinutes(startMin) })
  }

  const switchKind = (k: EntryKind) => {
    if (k === f.kind) return
    const def = planner.lists.find((l) => l.kind === (k === "event" ? "calendar" : "tasks") && l.is_default)?.id ?? ""
    set({
      kind: k,
      listId: def,
      hasDate: k === "event" ? true : f.hasDate,
      reminders: isNew ? (k === "event" ? planner.prefs.default_event_reminders : planner.prefs.default_task_reminders) : f.reminders,
    })
  }

  const validate = (): string | null => {
    if (!f.title.trim()) return "Add a title"
    if (f.hasDate && !f.allDay && f.kind === "event" && fromWall(f.endDate, f.endTime, f.tz) < fromWall(f.startDate, f.startTime, f.tz)) return "The end is before the start"
    if (f.hasDate && f.allDay && f.endDate < f.startDate) return "The end date is before the start date"
    return null
  }

  async function save(mode: "all" | "this" | "following" = "all") {
    const v = validate()
    if (v) {
      setError(v)
      return
    }
    setBusy(true)
    const body = bodyOf(f)
    let ok = true
    if (isNew) {
      ok = Boolean(await planner.create({ ...body, ...(target.draft?.source_item_id ? { source_item_id: target.draft.source_item_id } : {}), ...(target.draft?.parent_id ? { parent_id: target.draft.parent_id } : {}), completed: f.completed || undefined }))
    } else if (!repeating || mode === "all") {
      let patch: Record<string, unknown> = { ...body, completed: f.kind === "task" ? f.completed : undefined }
      if (repeating && target.occurrence) {
        // "All events": shift the whole series (and its skipped dates) by how far this occurrence moved.
        const occ = target.occurrence
        if (f.allDay && entry!.start_date) {
          const shift = diffDays(occurrenceDate(entry!, occ, planner.tz), f.startDate)
          const span = Math.max(0, diffDays(f.startDate, f.endDate))
          const s = addDays(entry!.start_date, shift)
          patch = { ...patch, start_date: s, end_date: span ? addDays(s, span) : null, exdates: shiftExdates(entry!.exdates ?? [], { days: shift }) }
        } else if (!f.allDay && entry!.start_at && !occ.allDay) {
          const shift = fromWall(f.startDate, f.startTime, f.tz).getTime() - new Date(occ.start).getTime()
          const len = fromWall(f.endDate, f.endTime, f.tz).getTime() - fromWall(f.startDate, f.startTime, f.tz).getTime()
          const s = new Date(new Date(entry!.start_at).getTime() + shift)
          patch = {
            ...patch,
            start_at: s.toISOString(),
            end_at: f.kind === "event" ? new Date(s.getTime() + Math.max(0, len)).toISOString() : null,
            exdates: shiftExdates(entry!.exdates ?? [], { ms: shift }),
          }
        }
      }
      ok = Boolean(await planner.update(entry!, patch))
    } else if (mode === "this") {
      // One occurrence becomes its own entry; the series skips that date.
      const made = await planner.create({ ...body, rrule: null })
      ok = Boolean(made) && Boolean(await planner.update(entry!, { exdates: [...new Set([...(entry!.exdates ?? []), target.occurrence!.key])] }))
    } else {
      // The old series stops the day before (in its own zone); the new one carries the rest of COUNT and the
      // skipped dates after the split.
      const split = splitSeries(entry!, occurrenceDate(entry!, target.occurrence!, planner.tz), f.rrule, planner.tz)
      const made = await planner.create({ ...body, rrule: split.newRule, exdates: split.newExdates })
      ok = Boolean(made)
      if (ok) {
        if (!split.oldRule) ok = Boolean(await planner.update(entry!, { deleted: true }))
        else ok = Boolean(await planner.update(entry!, { rrule: split.oldRule, exdates: split.oldExdates }))
      }
    }
    setBusy(false)
    if (ok) onClose()
  }

  async function remove(mode: "all" | "this" | "following" = "all") {
    if (!entry) return
    setBusy(true)
    if (!repeating || mode === "all") await planner.remove(entry)
    else if (mode === "this") await planner.update(entry, { exdates: [...new Set([...(entry.exdates ?? []), target.occurrence!.key])] }, "Occurrence deleted")
    else {
      const split = splitSeries(entry, occurrenceDate(entry, target.occurrence!, planner.tz), null, planner.tz)
      if (!split.oldRule) await planner.remove(entry)
      else await planner.update(entry, { rrule: split.oldRule, exdates: split.oldExdates }, "Following events deleted")
    }
    setBusy(false)
    onClose()
  }

  const title = isNew ? (f.kind === "event" ? "New event" : "New task") : f.kind === "event" ? "Edit event" : "Edit task"

  return (
    <Modal title={title} onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (repeating) setScope("save")
          else save()
        }}
        className="space-y-4"
      >
        <div className="inline-flex rounded-xl border border-line p-0.5 text-sm" role="radiogroup" aria-label="Type">
          {(["event", "task"] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={f.kind === k} onClick={() => switchKind(k)} className={`rounded-lg px-3 py-1.5 ${f.kind === k ? "bg-accent text-accent-ink" : "text-ink-2"}`}>
              {k === "event" ? "Event" : "Task"}
            </button>
          ))}
        </div>

        <div>
          <label htmlFor="ed-title" className="sr-only">
            Title
          </label>
          <input id="ed-title" value={f.title} onChange={(e) => set({ title: e.target.value })} placeholder={f.kind === "event" ? "Add title" : "Task title"} maxLength={1000} className="w-full border-b border-line bg-transparent pb-2 text-lg font-medium outline-none focus:border-accent" autoFocus />
        </div>

        {/* When */}
        <div className="space-y-2 rounded-xl border border-line p-3">
          <div className="flex flex-wrap items-center gap-4 text-sm">
            {f.kind === "task" ? (
              <label className="inline-flex items-center gap-2">
                <input type="checkbox" checked={f.hasDate} onChange={(e) => set({ hasDate: e.target.checked, reminders: e.target.checked && !f.reminders.length && isNew ? planner.prefs.default_task_reminders : f.reminders })} /> Date
              </label>
            ) : null}
            {f.hasDate ? (
              <label className="inline-flex items-center gap-2">
                <input type="checkbox" checked={!f.allDay} onChange={(e) => set({ allDay: !e.target.checked })} /> {f.kind === "event" ? "At a time (off = all day)" : "Time"}
              </label>
            ) : null}
          </div>
          {f.hasDate ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div>
                <label htmlFor="ed-sd" className={label}>
                  {f.kind === "event" ? "Starts" : "Due"}
                </label>
                <input id="ed-sd" type="date" value={f.startDate} onChange={(e) => e.target.value && setStart(e.target.value)} className={field} required />
              </div>
              {!f.allDay ? (
                <div>
                  <label htmlFor="ed-st" className={label}>
                    Time
                  </label>
                  <input id="ed-st" type="time" value={f.startTime} onChange={(e) => e.target.value && setStart(f.startDate, e.target.value)} className={field} required />
                </div>
              ) : null}
              {f.kind === "event" ? (
                <>
                  <div>
                    <label htmlFor="ed-ed" className={label}>
                      Ends
                    </label>
                    <input id="ed-ed" type="date" value={f.endDate} min={f.startDate} onChange={(e) => e.target.value && set({ endDate: e.target.value })} className={field} />
                  </div>
                  {!f.allDay ? (
                    <div>
                      <label htmlFor="ed-et" className={label}>
                        Time
                      </label>
                      <input id="ed-et" type="time" value={f.endTime} onChange={(e) => e.target.value && set({ endTime: e.target.value, endDate: e.target.value <= f.startTime && f.endDate === f.startDate ? addDays(f.startDate, 1) : f.endDate })} className={field} />
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-ink-3">No date: the task stays in its list without a due day.</p>
          )}
          {f.hasDate && !f.allDay && zoneOffsetMinutes(fromWall(f.startDate, f.startTime, f.tz).getTime(), f.tz) !== zoneOffsetMinutes(fromWall(f.startDate, f.startTime, f.tz).getTime(), planner.tz) ? <p className="text-xs text-ink-3">Time zone: {f.tz}</p> : null}

          {f.hasDate ? (
            <div>
              <label htmlFor="ed-rep" className={label}>
                Repeat
              </label>
              <select
                id="ed-rep"
                className={field}
                value={customRepeat || (!presetMatch && f.rrule) ? "custom" : (f.rrule ?? "")}
                onChange={(e) => {
                  if (e.target.value === "custom") {
                    setCustomRepeat(true)
                    if (!f.rrule) set({ rrule: `FREQ=WEEKLY;BYDAY=${WD[weekday(f.startDate)]}` })
                  } else {
                    setCustomRepeat(false)
                    set({ rrule: e.target.value || null })
                  }
                }}
              >
                {presets.map((p) => (
                  <option key={p.label} value={p.rrule ?? ""}>
                    {p.label}
                  </option>
                ))}
                <option value="custom">{!presetMatch && f.rrule ? describeRule(parseRule(f.rrule), f.startDate) : "Custom…"}</option>
              </select>
              {customRepeat || (!presetMatch && f.rrule) ? <CustomRepeat value={f.rrule} start={f.startDate} onChange={(r) => set({ rrule: r })} /> : null}
            </div>
          ) : null}
        </div>

        {/* Reminders */}
        {f.hasDate ? (
          <div>
            <p className={label}>Notifications</p>
            <div className="flex flex-wrap gap-2">
              {f.reminders.map((m) => (
                <span key={m} className="inline-flex items-center gap-1 rounded-full border border-line bg-panel-2 px-2.5 py-1 text-xs">
                  {reminderLabel(m, f.allDay)}
                  <button type="button" aria-label={`Remove ${reminderLabel(m, f.allDay)}`} onClick={() => set({ reminders: f.reminders.filter((x) => x !== m) })} className="text-ink-3 hover:text-danger">
                    <Icon.close width={12} height={12} />
                  </button>
                </span>
              ))}
              {f.reminders.length < 5 ? <ReminderAdd allDay={f.allDay} have={f.reminders} onAdd={(m) => set({ reminders: [...new Set([...f.reminders, m])].sort((a, b) => a - b) })} /> : null}
            </div>
            {f.allDay ? <p className="mt-1 text-xs text-ink-3">All-day reminders are counted from {planner.prefs.all_day_reminder_time} on the day.</p> : null}
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="ed-list" className={label}>
              {f.kind === "event" ? "Calendar" : "List"}
            </label>
            <select id="ed-list" className={field} value={f.listId} onChange={(e) => set({ listId: e.target.value })}>
              {lists.map((l: PlannerList) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="ed-loc" className={label}>
              Location
            </label>
            <input id="ed-loc" value={f.location} onChange={(e) => set({ location: e.target.value })} maxLength={1000} placeholder="Add location" className={field} />
          </div>
        </div>

        <div>
          <label htmlFor="ed-notes" className={label}>
            Description
          </label>
          <textarea id="ed-notes" value={f.notes} onChange={(e) => set({ notes: e.target.value })} rows={3} maxLength={50000} placeholder="Add notes, links, agenda" className={field} />
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Colour">
            {COLORS.map((c) => (
              <button
                key={c ?? "list"}
                type="button"
                role="radio"
                aria-checked={f.color === c}
                aria-label={c ? `Colour ${c}` : "Calendar colour"}
                onClick={() => set({ color: c })}
                className={`grid h-6 w-6 place-items-center rounded-full border ${f.color === c ? "ring-2 ring-accent ring-offset-1 ring-offset-panel" : "border-line"}`}
                style={{ background: c ?? planner.lists.find((l) => l.id === f.listId)?.color ?? "var(--panel-2)" }}
              >
                {!c ? <span className="text-[9px] font-bold text-white">A</span> : null}
              </button>
            ))}
          </div>
          {f.kind === "task" ? (
            <>
              <label className="inline-flex items-center gap-2 text-sm">
                <input type="checkbox" checked={f.starred} onChange={(e) => set({ starred: e.target.checked })} /> Starred
              </label>
              {!isNew ? (
                <label className="inline-flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={f.completed} onChange={(e) => set({ completed: e.target.checked })} /> Done
                </label>
              ) : null}
            </>
          ) : null}
        </div>

        {error ? <p className="text-sm text-danger">{error}</p> : null}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4">
          <div>
            {!isNew ? (
              <Button kind="ghost" onClick={() => (repeating ? setScope("delete") : remove())} disabled={busy} className="text-danger">
                <Icon.trash /> Delete
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" kind="primary" disabled={busy}>
              Save
            </Button>
          </div>
        </div>
      </form>

      {scope ? (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={scope === "save" ? "Save repeating event" : "Delete repeating event"}>
          <div className="w-full max-w-xs rounded-2xl border border-line bg-panel p-5 shadow-[var(--shadow)]">
            <h3 className="mb-3 font-semibold">{scope === "save" ? "Save changes to" : "Delete"}</h3>
            <div className="space-y-1">
              {(
                [
                  ["this", "This event"],
                  ["following", "This and following events"],
                  ["all", "All events"],
                ] as const
              ).map(([m, l]) => (
                <button
                  key={m}
                  className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-panel-2"
                  onClick={() => {
                    const s = scope
                    setScope(null)
                    if (s === "save") save(m)
                    else remove(m)
                  }}
                >
                  {l}
                </button>
              ))}
            </div>
            <div className="mt-3 flex justify-end">
              <Button onClick={() => setScope(null)}>Cancel</Button>
            </div>
          </div>
        </div>
      ) : null}
    </Modal>
  )
}

function ReminderAdd({ allDay, have, onAdd }: { allDay: boolean; have: number[]; onAdd: (m: number) => void }) {
  const [custom, setCustom] = useState(false)
  const [n, setN] = useState("30")
  const [unit, setUnit] = useState("1")
  if (custom)
    return (
      <span className="inline-flex items-center gap-1">
        <label htmlFor="rem-n" className="sr-only">
          Amount
        </label>
        <input id="rem-n" type="number" min={0} max={9999} value={n} onChange={(e) => setN(e.target.value)} className="w-16 rounded-lg border border-line bg-bg px-2 py-1 text-xs" />
        <label htmlFor="rem-u" className="sr-only">
          Unit
        </label>
        <select id="rem-u" value={unit} onChange={(e) => setUnit(e.target.value)} className="rounded-lg border border-line bg-bg px-2 py-1 text-xs">
          <option value="1">minutes</option>
          <option value="60">hours</option>
          <option value="1440">days</option>
          <option value="10080">weeks</option>
        </select>
        <button
          type="button"
          className="rounded-lg bg-accent px-2 py-1 text-xs text-accent-ink"
          onClick={() => {
            const m = Math.round(Number(n) * Number(unit))
            if (Number.isFinite(m) && m >= 0 && m <= 40320) onAdd(m)
            setCustom(false)
          }}
        >
          Add
        </button>
        <button type="button" className="text-xs text-ink-3" onClick={() => setCustom(false)}>
          Cancel
        </button>
      </span>
    )
  return (
    <>
      <label htmlFor="rem-add" className="sr-only">
        Add notification
      </label>
      <select
        id="rem-add"
        value=""
        onChange={(e) => {
          if (e.target.value === "custom") setCustom(true)
          else if (e.target.value) onAdd(Number(e.target.value))
        }}
        className="rounded-full border border-dashed border-line bg-transparent px-2.5 py-1 text-xs text-accent"
      >
        <option value="">+ Add notification</option>
        {REMINDER_CHOICES.filter((m) => !have.includes(m)).map((m) => (
          <option key={m} value={m}>
            {reminderLabel(m, allDay)}
          </option>
        ))}
        <option value="custom">Custom…</option>
      </select>
    </>
  )
}

function CustomRepeat({ value, start, onChange }: { value: string | null; start: string; onChange: (r: string) => void }) {
  const r: Rule = parseRule(value) ?? { freq: "WEEKLY", interval: 1, byday: [{ wd: weekday(start) }] }
  const emit = (p: Partial<Rule>) => onChange(formatRule({ ...r, ...p }))
  const ends = r.count ? "count" : r.until ? "until" : "never"
  const nth = Math.ceil(Number(start.slice(8, 10)) / 7)
  return (
    <div className="mt-2 space-y-2 rounded-xl bg-panel-2 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span>Every</span>
        <label htmlFor="cr-int" className="sr-only">
          Interval
        </label>
        <input id="cr-int" type="number" min={1} max={999} value={r.interval} onChange={(e) => emit({ interval: Math.max(1, Math.min(999, Number(e.target.value) || 1)) })} className="w-16 rounded-lg border border-line bg-bg px-2 py-1" />
        <label htmlFor="cr-freq" className="sr-only">
          Frequency
        </label>
        <select
          id="cr-freq"
          value={r.freq}
          onChange={(e) => {
            const freq = e.target.value as Rule["freq"]
            emit({ freq, byday: freq === "WEEKLY" ? [{ wd: weekday(start) }] : undefined, bymonthday: undefined, bymonth: undefined })
          }}
          className="rounded-lg border border-line bg-bg px-2 py-1"
        >
          <option value="DAILY">day{r.interval > 1 ? "s" : ""}</option>
          <option value="WEEKLY">week{r.interval > 1 ? "s" : ""}</option>
          <option value="MONTHLY">month{r.interval > 1 ? "s" : ""}</option>
          <option value="YEARLY">year{r.interval > 1 ? "s" : ""}</option>
        </select>
      </div>
      {r.freq === "WEEKLY" ? (
        <div className="flex gap-1" role="group" aria-label="Days of the week">
          {["S", "M", "T", "W", "T", "F", "S"].map((l, wd) => {
            const on = r.byday?.some((b) => b.wd === wd)
            return (
              <button
                key={wd}
                type="button"
                aria-pressed={on}
                aria-label={["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][wd]}
                onClick={() => {
                  const cur = r.byday?.map((b) => b.wd) ?? []
                  const next = on ? cur.filter((x) => x !== wd) : [...cur, wd]
                  emit({ byday: (next.length ? next : [weekday(start)]).sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((x) => ({ wd: x })) })
                }}
                className={`h-8 w-8 rounded-full text-xs font-medium ${on ? "bg-accent text-accent-ink" : "border border-line bg-bg"}`}
              >
                {l}
              </button>
            )
          })}
        </div>
      ) : null}
      {r.freq === "MONTHLY" ? (
        <select
          aria-label="Monthly on"
          value={r.byday?.length ? "nth" : "day"}
          onChange={(e) => emit(e.target.value === "nth" ? { byday: [{ wd: weekday(start), n: nth > 4 ? -1 : nth }], bymonthday: undefined } : { byday: undefined, bymonthday: [Number(start.slice(8, 10))] })}
          className="rounded-lg border border-line bg-bg px-2 py-1"
        >
          <option value="day">On day {Number(start.slice(8, 10))}</option>
          <option value="nth">On the {nth > 4 ? "last" : ["", "first", "second", "third", "fourth"][nth]} {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][weekday(start)]}</option>
        </select>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <span>Ends</span>
        <label htmlFor="cr-ends" className="sr-only">
          Ends
        </label>
        <select
          id="cr-ends"
          value={ends}
          onChange={(e) => {
            if (e.target.value === "never") emit({ count: undefined, until: undefined })
            else if (e.target.value === "count") emit({ count: 10, until: undefined })
            else emit({ count: undefined, until: addDays(start, 90) })
          }}
          className="rounded-lg border border-line bg-bg px-2 py-1"
        >
          <option value="never">Never</option>
          <option value="until">On date</option>
          <option value="count">After</option>
        </select>
        {ends === "until" ? (
          <>
            <label htmlFor="cr-until" className="sr-only">
              Last date
            </label>
            <input id="cr-until" type="date" min={start} value={r.until} onChange={(e) => e.target.value && emit({ until: e.target.value })} className="rounded-lg border border-line bg-bg px-2 py-1" />
          </>
        ) : null}
        {ends === "count" ? (
          <>
            <label htmlFor="cr-count" className="sr-only">
              Occurrences
            </label>
            <input id="cr-count" type="number" min={1} max={5000} value={r.count} onChange={(e) => emit({ count: Math.max(1, Math.min(5000, Number(e.target.value) || 1)) })} className="w-20 rounded-lg border border-line bg-bg px-2 py-1" />
            <span>times</span>
          </>
        ) : null}
      </div>
      <p className="text-xs text-ink-3">{describeRule(r, start)}</p>
    </div>
  )
}
