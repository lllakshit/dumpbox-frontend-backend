"use client"
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react"
import { occurrences, type Occurrence } from "@/lib/planner/recurrence"
import { addDays, dateParts, diffDays, fromWall, makeDate, minutesOf, startOfWeek, timeFromMinutes, toWall, todayIn, weekday } from "@/lib/planner/time"
import type { Entry } from "@/lib/planner/types"
import type { Planner } from "@/lib/client/planner"
import { Icon } from "../app/icons"
import type { EditorTarget } from "./EntryEditor"
import { QuickAdd } from "./QuickAdd"

export type CalView = "day" | "3day" | "week" | "month" | "schedule"
const VIEW_KEY = "dumpbox.calendar.view"
const HOUR = 48
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
const WDS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

function fmtTime(t: string) {
  const [h, m] = t.split(":").map(Number)
  const hh = h % 12 || 12
  return `${hh}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`
}

function rangeTitle(view: CalView, anchor: string, weekStart: number) {
  const p = dateParts(anchor)
  if (view === "month") return `${MONTHS[p.m - 1]} ${p.y}`
  if (view === "day") return `${WDS[weekday(anchor)]}, ${p.d} ${MONTHS[p.m - 1].slice(0, 3)} ${p.y}`
  const s = view === "week" ? startOfWeek(anchor, weekStart) : anchor
  const e = addDays(s, view === "week" ? 6 : view === "3day" ? 2 : 59)
  const ps = dateParts(s)
  const pe = dateParts(e)
  if (ps.m === pe.m) return `${ps.d} – ${pe.d} ${MONTHS[ps.m - 1].slice(0, 3)} ${ps.y}`
  return `${ps.d} ${MONTHS[ps.m - 1].slice(0, 3)} – ${pe.d} ${MONTHS[pe.m - 1].slice(0, 3)} ${pe.y}`
}

/** Side-by-side columns for overlapping timed events in one day. */
function layoutDay(items: { occ: Occurrence; s: number; e: number }[]) {
  const sorted = [...items].sort((a, b) => a.s - b.s || b.e - a.e)
  const out: { occ: Occurrence; s: number; e: number; col: number; cols: number }[] = []
  let cluster: typeof out = []
  let clusterEnd = -1
  const flush = () => {
    const cols = Math.max(1, ...cluster.map((c) => c.col + 1))
    for (const c of cluster) c.cols = cols
    out.push(...cluster)
    cluster = []
  }
  for (const it of sorted) {
    if (it.s >= clusterEnd && cluster.length) flush()
    const used = new Set(cluster.filter((c) => c.e > it.s).map((c) => c.col))
    let col = 0
    while (used.has(col)) col++
    cluster.push({ ...it, col, cols: 1 })
    clusterEnd = Math.max(clusterEnd, it.e)
  }
  if (cluster.length) flush()
  return out
}

export function CalendarView({ planner, onOpen }: { planner: Planner; onOpen: (t: EditorTarget) => void }) {
  const today = todayIn(planner.tz)
  const weekStart = planner.prefs.week_start === 6 ? 6 : planner.prefs.week_start
  const [view, setView] = useState<CalView>(() => {
    try {
      const v = localStorage.getItem(VIEW_KEY) as CalView | null
      if (v && ["day", "3day", "week", "month", "schedule"].includes(v)) return v
    } catch {
      // ignore
    }
    return typeof window !== "undefined" && window.innerWidth < 640 ? "schedule" : "week"
  })
  const [anchor, setAnchor] = useState(today)
  const [showSide, setShowSide] = useState(false)
  const [showCompleted, setShowCompleted] = useState(true)
  const [scheduleDays, setScheduleDays] = useState(60)

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view)
    } catch {
      // ignore
    }
  }, [view])

  const hiddenLists = useMemo(() => new Set(planner.lists.filter((l) => l.hidden).map((l) => l.id)), [planner.lists])
  const range = useMemo(() => {
    if (view === "month") {
      const p = dateParts(anchor)
      const first = startOfWeek(makeDate(p.y, p.m, 1), weekStart)
      return { from: first, to: addDays(first, 41) }
    }
    if (view === "week") {
      const s = startOfWeek(anchor, weekStart)
      return { from: s, to: addDays(s, 6) }
    }
    if (view === "3day") return { from: anchor, to: addDays(anchor, 2) }
    if (view === "day") return { from: anchor, to: anchor }
    return { from: anchor, to: addDays(anchor, scheduleDays - 1) }
  }, [view, anchor, weekStart, scheduleDays])

  const occs = useMemo(() => {
    const out: Occurrence[] = []
    for (const e of planner.entries) {
      if (e.list_id && hiddenLists.has(e.list_id)) continue
      if (e.kind === "task" && e.completed_at && !showCompleted) continue
      if (e.kind === "task" && e.parent_id) continue
      out.push(...occurrences(e, range.from, range.to, planner.tz))
    }
    return out.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.getTime() - b.start.getTime() || a.entry.title.localeCompare(b.entry.title))
  }, [planner.entries, planner.tz, hiddenLists, range, showCompleted])

  const step = (dir: number) => {
    if (view === "month") {
      const p = dateParts(anchor)
      setAnchor(makeDate(p.y, p.m + dir, 1))
    } else setAnchor(addDays(anchor, dir * (view === "week" ? 7 : view === "3day" ? 3 : view === "day" ? 1 : 30)))
  }

  // Keyboard: t today, d/x/w/m/a views, j/k or arrows to move, c create.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.closest("input,textarea,select,[contenteditable],[role=dialog]") || e.metaKey || e.ctrlKey || e.altKey) return
      const map: Record<string, () => void> = {
        t: () => setAnchor(today),
        d: () => setView("day"),
        x: () => setView("3day"),
        w: () => setView("week"),
        m: () => setView("month"),
        a: () => setView("schedule"),
        j: () => step(1),
        k: () => step(-1),
        ArrowRight: () => step(1),
        ArrowLeft: () => step(-1),
        c: () => onOpen({ draft: { kind: "event", start_date: anchor } }),
      }
      const fn = map[e.key]
      if (fn) {
        e.preventDefault()
        fn()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  const openOcc = (o: Occurrence) =>
    onOpen({ entry: o.entry, occurrence: o.recurring ? { key: o.key, startDate: o.startDate, endDate: o.endDate, startTime: o.startTime, endTime: o.endTime } : undefined })

  const newAt = (date: string, time?: string) => {
    if (!time) return onOpen({ draft: { kind: "event", all_day: true, start_date: date } })
    const s = fromWall(date, time, planner.tz)
    onOpen({ draft: { kind: "event", all_day: false, start_at: s.toISOString(), end_at: new Date(s.getTime() + planner.prefs.default_event_minutes * 60_000).toISOString(), time_zone: planner.tz } })
  }

  const toggleTask = (e: Entry) => planner.update(e, { completed: !e.completed_at }, e.completed_at ? "Marked not done" : e.rrule ? "Done. Next one scheduled." : "Done")

  return (
    <div className="flex h-full min-h-0">
      <aside className={`${showSide ? "fixed inset-0 z-30 block bg-black/30 md:static md:bg-transparent" : "hidden"} lg:block`} onClick={(e) => e.target === e.currentTarget && setShowSide(false)}>
        <div className="scroll-thin h-full w-64 overflow-y-auto border-r border-line bg-panel p-3">
          <MiniMonth anchor={anchor} today={today} weekStart={weekStart} onPick={(d) => { setAnchor(d); setShowSide(false) }} occDates={new Set(occs.map((o) => o.startDate))} />
          <CalendarsList planner={planner} />
          <label className="mt-4 flex items-center gap-2 px-1 text-sm text-ink-2">
            <input type="checkbox" checked={showCompleted} onChange={(e) => setShowCompleted(e.target.checked)} /> Show completed tasks
          </label>
          <p className="mt-4 px-1 text-xs text-ink-3">Keys: T today · D day · X 3 days · W week · M month · A schedule · J/K next/previous · C create</p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 md:px-4">
          <button className="rounded-lg p-1.5 text-ink-2 hover:bg-panel-2 lg:hidden" aria-label="Calendars and mini month" onClick={() => setShowSide(true)}>
            <Icon.calendar />
          </button>
          <button onClick={() => setAnchor(today)} className="rounded-xl border border-line px-3 py-1.5 text-sm hover:bg-panel-2">
            Today
          </button>
          <button onClick={() => step(-1)} className="rounded-lg p-1.5 text-ink-2 hover:bg-panel-2" aria-label="Previous">
            <span aria-hidden="true">‹</span>
          </button>
          <button onClick={() => step(1)} className="rounded-lg p-1.5 text-ink-2 hover:bg-panel-2" aria-label="Next">
            <span aria-hidden="true">›</span>
          </button>
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold">{rangeTitle(view, anchor, weekStart)}</h2>
          <label htmlFor="cal-view" className="sr-only">
            View
          </label>
          <select id="cal-view" value={view} onChange={(e) => setView(e.target.value as CalView)} className="rounded-xl border border-line bg-bg px-2 py-1.5 text-sm">
            <option value="day">Day</option>
            <option value="3day">3 days</option>
            <option value="week">Week</option>
            <option value="month">Month</option>
            <option value="schedule">Schedule</option>
          </select>
          <button onClick={() => onOpen({ draft: { kind: "event", start_date: anchor === today ? undefined : anchor } })} className="inline-flex items-center gap-1 rounded-xl bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink">
            <Icon.plus width={16} height={16} /> Create
          </button>
        </div>
        <div className="border-b border-line px-3 py-2 md:px-4">
          <QuickAdd planner={planner} defaultKind="event" defaultDate={anchor !== today ? anchor : undefined} placeholder="Quick add: “Dentist tomorrow 5pm remind me 1h before”" />
        </div>

        <div className="min-h-0 flex-1">
          {view === "month" ? <MonthGrid from={range.from} anchor={anchor} today={today} occs={occs} planner={planner} onOpen={openOcc} onNew={(d) => newAt(d, "09:00")} onMore={(d) => { setAnchor(d); setView("day") }} onToggle={toggleTask} /> : null}
          {view === "week" || view === "3day" || view === "day" ? <TimeGrid days={Array.from({ length: diffDays(range.from, range.to) + 1 }, (_, i) => addDays(range.from, i))} today={today} occs={occs} planner={planner} onOpen={openOcc} onNew={newAt} onToggle={toggleTask} onDay={(d) => { setAnchor(d); setView("day") }} /> : null}
          {view === "schedule" ? <Schedule from={range.from} to={range.to} today={today} occs={occs} planner={planner} onOpen={openOcc} onToggle={toggleTask} onMore={() => setScheduleDays((n) => n + 60)} /> : null}
        </div>
      </div>
    </div>
  )
}

function Chip({ o, planner, onOpen, onToggle, compact }: { o: Occurrence; planner: Planner; onOpen: (o: Occurrence) => void; onToggle: (e: Entry) => void; compact?: boolean }) {
  const color = planner.colorOf(o.entry)
  const done = Boolean(o.entry.completed_at)
  const isTask = o.entry.kind === "task"
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation()
        onOpen(o)
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen(o)
      }}
      className={`flex w-full min-w-0 items-center gap-1 rounded-md px-1.5 text-left text-[12px] leading-5 ${o.allDay ? "text-white" : "text-ink hover:bg-panel-2"} ${done ? "opacity-60" : ""}`}
      style={o.allDay ? { background: color } : undefined}
      title={o.entry.title}
    >
      {isTask ? (
        <button
          type="button"
          aria-label={done ? "Mark not done" : "Mark done"}
          onClick={(e) => {
            e.stopPropagation()
            onToggle(o.entry)
          }}
          className={`grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full border ${o.allDay ? "border-white" : ""}`}
          style={!o.allDay ? { borderColor: color } : undefined}
        >
          {done ? <Icon.check width={10} height={10} /> : null}
        </button>
      ) : !o.allDay ? (
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
      ) : null}
      {!o.allDay && o.startTime && !compact ? <span className="shrink-0 text-ink-3">{fmtTime(o.startTime)}</span> : null}
      <span className={`truncate ${done ? "line-through" : ""}`}>{o.entry.title}</span>
    </div>
  )
}

function MonthGrid({ from, anchor, today, occs, planner, onOpen, onNew, onMore, onToggle }: { from: string; anchor: string; today: string; occs: Occurrence[]; planner: Planner; onOpen: (o: Occurrence) => void; onNew: (d: string) => void; onMore: (d: string) => void; onToggle: (e: Entry) => void }) {
  const month = dateParts(anchor).m
  const byDay = useMemo(() => {
    const m = new Map<string, Occurrence[]>()
    for (const o of occs) {
      for (let d = o.startDate; d <= o.endDate; d = addDays(d, 1)) {
        const list = m.get(d) ?? []
        list.push(o)
        m.set(d, list)
        if (diffDays(o.startDate, d) > 60) break
      }
    }
    return m
  }, [occs])
  const days = Array.from({ length: 42 }, (_, i) => addDays(from, i))
  return (
    <div className="flex h-full flex-col">
      <div className="grid grid-cols-7 border-b border-line text-center text-[11px] font-medium uppercase text-ink-3">
        {days.slice(0, 7).map((d) => (
          <div key={d} className="py-1.5">
            {WDS[weekday(d)]}
          </div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6">
        {days.map((d) => {
          const list = byDay.get(d) ?? []
          const p = dateParts(d)
          return (
            <div key={d} onClick={() => onNew(d)} className={`min-h-[84px] cursor-pointer overflow-hidden border-b border-r border-line p-1 ${p.m !== month ? "bg-panel-2/40" : ""}`}>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onMore(d)
                }}
                className={`mb-0.5 grid h-6 min-w-6 place-items-center rounded-full px-1 text-xs ${d === today ? "bg-accent font-semibold text-accent-ink" : p.m !== month ? "text-ink-3" : "text-ink-2 hover:bg-panel-2"}`}
                aria-label={`Open ${d}`}
              >
                {p.d === 1 ? `${p.d} ${MONTHS[p.m - 1].slice(0, 3)}` : p.d}
              </button>
              <div className="space-y-0.5">
                {list.slice(0, 3).map((o) => (
                  <Chip key={`${o.entry.id}-${o.key}`} o={o} planner={planner} onOpen={onOpen} onToggle={onToggle} compact />
                ))}
                {list.length > 3 ? (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onMore(d)
                    }}
                    className="px-1.5 text-[11px] font-medium text-ink-2 hover:underline"
                  >
                    +{list.length - 3} more
                  </button>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

type Drag = { id: string; occ: Occurrence; mode: "move" | "resize"; startY: number; startX: number; dayIdx: number; origS: number; origE: number; s: number; e: number; dayShift: number; moved: boolean }

function TimeGrid({ days, today, occs, planner, onOpen, onNew, onToggle, onDay }: { days: string[]; today: string; occs: Occurrence[]; planner: Planner; onOpen: (o: Occurrence) => void; onNew: (d: string, t?: string) => void; onToggle: (e: Entry) => void; onDay: (d: string) => void }) {
  const scroller = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(() => toWall(new Date(), planner.tz))
  const [drag, setDragState] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const setDrag = (d: Drag | null) => {
    dragRef.current = d
    setDragState(d)
  }

  useEffect(() => {
    const iv = setInterval(() => setNow(toWall(new Date(), planner.tz)), 60_000)
    return () => clearInterval(iv)
  }, [planner.tz])
  useEffect(() => {
    // Open at 7:00, or an hour before now when today is shown.
    const el = scroller.current
    if (!el) return
    const h = days.includes(today) ? Math.max(0, minutesOf(toWall(new Date(), planner.tz).time) / 60 - 1.5) : 7
    el.scrollTop = h * HOUR
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days.join()])

  const allDay = occs.filter((o) => o.allDay || (o.entry.kind === "task" && !o.startTime))
  const timed = occs.filter((o) => !o.allDay && o.startTime)

  const perDay = days.map((d) => {
    const items = timed
      .filter((o) => o.startDate <= d && o.endDate >= d)
      .map((o) => {
        const s = o.startDate < d ? 0 : minutesOf(o.startTime!)
        const e = o.endDate > d ? 1440 : Math.max(s + (o.entry.kind === "task" ? 30 : 15), o.end.getTime() === o.start.getTime() ? s + 30 : minutesOf(o.endTime ?? o.startTime!))
        return { occ: o, s, e: Math.min(1440, e) }
      })
    return layoutDay(items)
  })

  const startDrag = (ev: RPointerEvent, o: Occurrence, dayIdx: number, s: number, e: number, mode: "move" | "resize") => {
    if (o.recurring || o.startDate !== o.endDate || o.entry.kind === "task") return
    ev.stopPropagation()
    ;(ev.target as HTMLElement).setPointerCapture?.(ev.pointerId)
    setDrag({ id: o.entry.id, occ: o, mode, startY: ev.clientY, startX: ev.clientX, dayIdx, origS: s, origE: e, s, e, dayShift: 0, moved: false })
  }
  const onMove = (ev: RPointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const dy = ev.clientY - d.startY
    const deltaMin = Math.round(((dy / HOUR) * 60) / 15) * 15
    const colW = (gridRef.current?.clientWidth ?? 1) / days.length
    const dayShift = d.mode === "move" ? Math.max(-d.dayIdx, Math.min(days.length - 1 - d.dayIdx, Math.round((ev.clientX - d.startX) / colW))) : 0
    const len = d.origE - d.origS
    const s = d.mode === "move" ? Math.max(0, Math.min(1440 - len, d.origS + deltaMin)) : d.origS
    const e = d.mode === "move" ? s + len : Math.max(d.origS + 15, Math.min(1440, d.origE + deltaMin))
    setDrag({ ...d, s, e, dayShift, moved: d.moved || Math.abs(dy) > 4 || dayShift !== 0 })
  }
  const endDrag = async () => {
    const d = dragRef.current
    setDrag(null)
    if (!d) return
    if (!d.moved) {
      onOpen(d.occ)
      return
    }
    const day = days[d.dayIdx + d.dayShift]
    const s = fromWall(day, timeFromMinutes(d.s), planner.tz)
    const e = d.e >= 1440 ? fromWall(addDays(day, 1), "00:00", planner.tz) : fromWall(day, timeFromMinutes(d.e), planner.tz)
    await planner.update(d.occ.entry, { start_at: s.toISOString(), end_at: e.toISOString(), time_zone: planner.tz }, "Moved")
  }

  const nowMin = minutesOf(now.time)

  return (
    <div className="flex h-full flex-col">
      {/* Day headers + all-day row */}
      <div className="flex border-b border-line">
        <div className="w-14 shrink-0" />
        <div className="grid flex-1" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
          {days.map((d) => (
            <button key={d} onClick={() => onDay(d)} className="flex flex-col items-center border-l border-line py-1.5">
              <span className={`text-[11px] uppercase ${d === today ? "text-accent" : "text-ink-3"}`}>{WDS[weekday(d)]}</span>
              <span className={`grid h-8 w-8 place-items-center rounded-full text-lg ${d === today ? "bg-accent text-accent-ink" : ""}`}>{dateParts(d).d}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="flex border-b border-line">
        <div className="w-14 shrink-0 py-1 pr-1 text-right text-[10px] text-ink-3">all day</div>
        <div className="grid flex-1" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
          {days.map((d) => (
            <div key={d} onClick={() => onNew(d)} className="min-h-7 cursor-pointer space-y-0.5 border-l border-line p-0.5">
              {allDay
                .filter((o) => o.startDate <= d && o.endDate >= d)
                .map((o) => (
                  <Chip key={`${o.entry.id}-${o.key}`} o={o} planner={planner} onOpen={onOpen} onToggle={onToggle} />
                ))}
            </div>
          ))}
        </div>
      </div>

      <div ref={scroller} className="scroll-thin relative min-h-0 flex-1 overflow-y-auto" onPointerMove={onMove} onPointerUp={endDrag} onPointerCancel={() => setDrag(null)}>
        <div className="flex" style={{ height: 24 * HOUR }}>
          <div className="relative w-14 shrink-0">
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="absolute right-1 -translate-y-1/2 text-[10px] text-ink-3" style={{ top: h * HOUR }}>
                {h === 0 ? "" : fmtTime(`${String(h).padStart(2, "0")}:00`)}
              </div>
            ))}
          </div>
          <div ref={gridRef} className="relative grid flex-1" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
            {days.map((d, di) => (
              <div
                key={d}
                className="relative border-l border-line"
                onClick={(ev) => {
                  const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect()
                  const min = Math.floor(((ev.clientY - rect.top) / HOUR) * 2) * 30
                  onNew(d, timeFromMinutes(Math.max(0, Math.min(1410, min))))
                }}
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} className="pointer-events-none absolute inset-x-0 border-t border-line/70" style={{ top: h * HOUR }} />
                ))}
                {d === today ? (
                  <div className="pointer-events-none absolute inset-x-0 z-20" style={{ top: (nowMin / 60) * HOUR }}>
                    <div className="relative h-0.5 bg-danger">
                      <span className="absolute -left-1 -top-1 h-2.5 w-2.5 rounded-full bg-danger" />
                    </div>
                  </div>
                ) : null}
                {perDay[di].map((it) => {
                  const isDrag = drag && drag.id === it.occ.entry.id && drag.dayIdx === di
                  const s = isDrag ? drag.s : it.s
                  const e = isDrag ? drag.e : it.e
                  const color = planner.colorOf(it.occ.entry)
                  const done = Boolean(it.occ.entry.completed_at)
                  const height = Math.max(18, ((e - s) / 60) * HOUR - 2)
                  return (
                    <div
                      key={`${it.occ.entry.id}-${it.occ.key}`}
                      role="button"
                      tabIndex={0}
                      aria-label={`${it.occ.entry.title}, ${fmtTime(timeFromMinutes(s))}`}
                      onClick={(ev) => ev.stopPropagation()}
                      onKeyDown={(ev) => ev.key === "Enter" && onOpen(it.occ)}
                      onPointerDown={(ev) => {
                        if (it.occ.recurring || it.occ.entry.kind === "task" || it.occ.startDate !== it.occ.endDate) return
                        startDrag(ev, it.occ, di, it.s, it.e, "move")
                      }}
                      onPointerUp={(ev) => {
                        if (!dragRef.current) {
                          ev.stopPropagation()
                          onOpen(it.occ)
                        }
                      }}
                      className={`absolute z-10 cursor-pointer touch-none select-none overflow-hidden rounded-md border border-white/40 px-1.5 py-0.5 text-[11px] leading-tight text-white shadow-sm ${isDrag ? "opacity-80 ring-2 ring-accent" : ""} ${done ? "opacity-60" : ""}`}
                      style={{
                        top: (s / 60) * HOUR + 1,
                        height,
                        left: `calc(${(it.col / it.cols) * 100}% + 2px)`,
                        width: `calc(${100 / it.cols}% - 4px)`,
                        background: color,
                        transform: isDrag && drag.dayShift ? `translateX(${drag.dayShift * 100 * it.cols}%)` : undefined,
                      }}
                    >
                      <div className="flex items-center gap-1 font-medium">
                        {it.occ.entry.kind === "task" ? (
                          <button
                            type="button"
                            aria-label={done ? "Mark not done" : "Mark done"}
                            onPointerDown={(ev) => ev.stopPropagation()}
                            onPointerUp={(ev) => ev.stopPropagation()}
                            onClick={(ev) => {
                              ev.stopPropagation()
                              onToggle(it.occ.entry)
                            }}
                            className="grid h-3 w-3 shrink-0 place-items-center rounded-full border border-white"
                          >
                            {done ? <Icon.check width={9} height={9} /> : null}
                          </button>
                        ) : null}
                        <span className={`truncate ${done ? "line-through" : ""}`}>{it.occ.entry.title}</span>
                      </div>
                      {height > 30 ? (
                        <div className="truncate opacity-90">
                          {fmtTime(timeFromMinutes(s))}
                          {it.occ.entry.kind === "event" ? `–${fmtTime(timeFromMinutes(e % 1440))}` : ""}
                          {it.occ.entry.location ? ` · ${it.occ.entry.location}` : ""}
                        </div>
                      ) : null}
                      {!it.occ.recurring && it.occ.entry.kind === "event" && it.occ.startDate === it.occ.endDate ? (
                        <div className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize" onPointerDown={(ev) => startDrag(ev, it.occ, di, it.s, it.e, "resize")} aria-hidden="true" />
                      ) : null}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function Schedule({ from, to, today, occs, planner, onOpen, onToggle, onMore }: { from: string; to: string; today: string; occs: Occurrence[]; planner: Planner; onOpen: (o: Occurrence) => void; onToggle: (e: Entry) => void; onMore: () => void }) {
  const byDay = new Map<string, Occurrence[]>()
  for (const o of occs) {
    const d = o.startDate < from ? from : o.startDate
    const list = byDay.get(d) ?? []
    list.push(o)
    byDay.set(d, list)
  }
  const dates = [...byDay.keys()].filter((d) => d <= to).sort()
  return (
    <div className="scroll-thin h-full overflow-y-auto px-3 py-3 md:px-6">
      {!dates.length ? <p className="py-16 text-center text-ink-2">Nothing planned. Use quick add above, or Create.</p> : null}
      <ul className="space-y-4">
        {dates.map((d) => {
          const p = dateParts(d)
          return (
            <li key={d} className="flex gap-4">
              <div className="w-14 shrink-0 text-center">
                <div className={`text-[11px] uppercase ${d === today ? "text-accent" : "text-ink-3"}`}>{WDS[weekday(d)]}</div>
                <div className={`mx-auto grid h-9 w-9 place-items-center rounded-full text-lg ${d === today ? "bg-accent text-accent-ink" : ""}`}>{p.d}</div>
                <div className="text-[10px] text-ink-3">{MONTHS[p.m - 1].slice(0, 3)}</div>
              </div>
              <ul className="min-w-0 flex-1 space-y-1">
                {byDay.get(d)!.map((o) => {
                  const color = planner.colorOf(o.entry)
                  const done = Boolean(o.entry.completed_at)
                  return (
                    <li key={`${o.entry.id}-${o.key}`}>
                      <div role="button" tabIndex={0} onClick={() => onOpen(o)} onKeyDown={(e) => e.key === "Enter" && onOpen(o)} className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-panel-2">
                        {o.entry.kind === "task" ? (
                          <button
                            type="button"
                            aria-label={done ? "Mark not done" : "Mark done"}
                            onClick={(e) => {
                              e.stopPropagation()
                              onToggle(o.entry)
                            }}
                            className="grid h-5 w-5 shrink-0 place-items-center rounded-full border-2"
                            style={{ borderColor: color, background: done ? color : undefined }}
                          >
                            {done ? <Icon.check width={12} height={12} className="text-white" /> : null}
                          </button>
                        ) : (
                          <span className="mx-1 h-3 w-3 shrink-0 rounded-full" style={{ background: color }} />
                        )}
                        <span className="w-20 shrink-0 text-xs text-ink-2 sm:w-28">
                          {o.allDay || !o.startTime ? "All day" : `${fmtTime(o.startTime)}${o.entry.kind === "event" && o.endTime ? ` – ${fmtTime(o.endTime)}` : ""}`}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className={`block truncate text-sm ${done ? "text-ink-3 line-through" : ""}`}>{o.entry.title}</span>
                          {o.entry.location ? <span className="block truncate text-xs text-ink-3">{o.entry.location}</span> : null}
                        </span>
                        {o.recurring ? <span className="text-xs text-ink-3" title="Repeats">↻</span> : null}
                        {o.entry.reminders.length ? <span className="text-xs text-ink-3" title="Has notifications">🔔</span> : null}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </li>
          )
        })}
      </ul>
      <div className="py-6 text-center">
        <button onClick={onMore} className="rounded-xl border border-line px-3 py-1.5 text-sm hover:bg-panel-2">
          Show more
        </button>
      </div>
    </div>
  )
}

function MiniMonth({ anchor, today, weekStart, onPick, occDates }: { anchor: string; today: string; weekStart: number; onPick: (d: string) => void; occDates: Set<string> }) {
  const monthOf = (d: string) => {
    const p = dateParts(d)
    return makeDate(p.y, p.m, 1)
  }
  // Follows the main calendar when it moves; the arrows here browse on their own.
  const [st, setSt] = useState({ anchor, month: monthOf(anchor) })
  if (st.anchor !== anchor) setSt({ anchor, month: monthOf(anchor) })
  const month = st.month
  const setMonth = (m: string) => setSt({ anchor, month: m })
  const p = dateParts(month)
  const first = startOfWeek(month, weekStart)
  const days = Array.from({ length: 42 }, (_, i) => addDays(first, i))
  return (
    <div className="mb-4">
      <div className="mb-1 flex items-center justify-between px-1">
        <span className="text-sm font-medium">
          {MONTHS[p.m - 1]} {p.y}
        </span>
        <span>
          <button className="rounded p-1 text-ink-2 hover:bg-panel-2" aria-label="Previous month" onClick={() => setMonth(makeDate(p.y, p.m - 1, 1))}>
            ‹
          </button>
          <button className="rounded p-1 text-ink-2 hover:bg-panel-2" aria-label="Next month" onClick={() => setMonth(makeDate(p.y, p.m + 1, 1))}>
            ›
          </button>
        </span>
      </div>
      <div className="grid grid-cols-7 text-center text-[10px] text-ink-3">
        {days.slice(0, 7).map((d) => (
          <span key={d}>{WDS[weekday(d)][0]}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 text-center text-xs">
        {days.map((d) => {
          const dp = dateParts(d)
          return (
            <button key={d} onClick={() => onPick(d)} className={`relative m-0.5 grid h-7 place-items-center rounded-full ${d === today ? "bg-accent text-accent-ink" : d === anchor ? "bg-accent-soft text-accent" : dp.m !== p.m ? "text-ink-3" : "hover:bg-panel-2"}`} aria-label={d}>
              {dp.d}
              {occDates.has(d) && d !== today ? <span className="absolute bottom-0.5 h-1 w-1 rounded-full bg-accent" /> : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function CalendarsList({ planner }: { planner: Planner }) {
  const [adding, setAdding] = useState<null | "calendar" | "tasks">(null)
  const [name, setName] = useState("")
  const section = (kind: "calendar" | "tasks", title: string) => (
    <div className="mt-3">
      <div className="flex items-center justify-between px-1 pb-1">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-3">{title}</p>
        <button onClick={() => setAdding(kind)} className="text-ink-2 hover:text-accent" aria-label={`Add ${kind === "calendar" ? "calendar" : "task list"}`}>
          <Icon.plus width={14} height={14} />
        </button>
      </div>
      <ul className="space-y-0.5">
        {planner.lists
          .filter((l) => l.kind === kind)
          .map((l) => (
            <li key={l.id}>
              <label className="flex items-center gap-2 rounded-lg px-1 py-1 text-sm hover:bg-panel-2">
                <input type="checkbox" aria-label={`Show ${l.name}`} checked={!l.hidden} onChange={(e) => planner.listOps.update(l, { hidden: !e.target.checked })} style={{ accentColor: l.color }} />
                <span className="truncate">{l.name}</span>
              </label>
            </li>
          ))}
      </ul>
      {adding === kind ? (
        <form
          className="mt-1 flex gap-1"
          onSubmit={async (e) => {
            e.preventDefault()
            if (!name.trim()) return
            if (await planner.listOps.create(kind, name.trim())) {
              setName("")
              setAdding(null)
            }
          }}
        >
          <label htmlFor={`new-${kind}`} className="sr-only">
            Name
          </label>
          <input id={`new-${kind}`} autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Name" className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-2 py-1 text-sm" />
          <button className="rounded-lg bg-accent px-2 text-sm text-accent-ink">Add</button>
        </form>
      ) : null}
    </div>
  )
  return (
    <>
      {section("calendar", "My calendars")}
      {section("tasks", "Task lists")}
    </>
  )
}
