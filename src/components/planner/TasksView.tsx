"use client"
import { useMemo, useState } from "react"
import { describeRule, parseRule } from "@/lib/planner/recurrence"
import { addDays, dateParts, toWall, todayIn } from "@/lib/planner/time"
import type { Entry, PlannerList } from "@/lib/planner/types"
import type { Planner } from "@/lib/client/planner"
import { Icon } from "../app/icons"
import type { EditorTarget } from "./EntryEditor"
import { QuickAdd } from "./QuickAdd"

type Pick = { kind: "list"; id: string } | { kind: "all" } | { kind: "starred" } | { kind: "today" } | { kind: "upcoming" }
type Sort = "order" | "date" | "title"
const SORT_KEY = "dumpbox.tasks.sort"
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** Due date of a task as a wall date in the viewer's zone (null when undated). */
function dueDate(e: Entry, tz: string): string | null {
  if (e.start_date) return e.start_date
  if (e.start_at) return toWall(new Date(e.start_at), tz).date
  return null
}

function dueLabel(e: Entry, tz: string, today: string) {
  const d = dueDate(e, tz)
  if (!d) return null
  const t = e.start_at ? toWall(new Date(e.start_at), tz).time : null
  const p = dateParts(d)
  const day = d === today ? "Today" : d === addDays(today, 1) ? "Tomorrow" : d === addDays(today, -1) ? "Yesterday" : `${p.d} ${MONTHS[p.m - 1]}${p.y !== dateParts(today).y ? ` ${p.y}` : ""}`
  return { text: t ? `${day}, ${t}` : day, overdue: !e.completed_at && (d < today || (d === today && t !== null && e.start_at !== null && new Date(e.start_at) < new Date())) }
}

export function TasksView({ planner, onOpen }: { planner: Planner; onOpen: (t: EditorTarget) => void }) {
  const tz = planner.tz
  const today = todayIn(tz)
  const taskLists = planner.lists.filter((l) => l.kind === "tasks")
  const def = taskLists.find((l) => l.is_default)
  const [pick, setPick] = useState<Pick>(() => (def ? { kind: "list", id: def.id } : { kind: "all" }))
  const [sort, setSortState] = useState<Sort>(() => {
    try {
      return (localStorage.getItem(SORT_KEY) as Sort) || "order"
    } catch {
      return "order"
    }
  })
  const setSort = (s: Sort) => {
    setSortState(s)
    try {
      localStorage.setItem(SORT_KEY, s)
    } catch {
      // ignore
    }
  }
  const [showDone, setShowDone] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [renaming, setRenaming] = useState<PlannerList | null>(null)
  const [newList, setNewList] = useState(false)
  const [name, setName] = useState("")
  const [navOpen, setNavOpen] = useState(false)

  const tasks = useMemo(() => planner.entries.filter((e) => e.kind === "task"), [planner.entries])
  const children = useMemo(() => {
    const m = new Map<string, Entry[]>()
    for (const t of tasks) if (t.parent_id) m.set(t.parent_id, [...(m.get(t.parent_id) ?? []), t])
    for (const v of m.values()) v.sort((a, b) => a.position - b.position)
    return m
  }, [tasks])

  const matches = (p: Pick, t: Entry) => {
    switch (p.kind) {
      case "list":
        return t.list_id === p.id
      case "all":
        return true
      case "starred":
        return t.starred
      case "today": {
        const d = dueDate(t, tz)
        return d !== null && d <= today
      }
      case "upcoming": {
        const d = dueDate(t, tz)
        return d !== null && d > today && d <= addDays(today, 7)
      }
    }
  }
  const inPick = (t: Entry) => matches(pick, t)

  const top = tasks.filter((t) => !t.parent_id && inPick(t))
  const sorter = (a: Entry, b: Entry) => {
    if (sort === "title") return a.title.localeCompare(b.title)
    if (sort === "date") {
      const da = a.start_at ?? (a.start_date ? `${a.start_date}T99` : "9999")
      const db = b.start_at ?? (b.start_date ? `${b.start_date}T99` : "9999")
      return da.localeCompare(db) || a.position - b.position
    }
    return a.position - b.position || a.created_at.localeCompare(b.created_at)
  }
  const open = top.filter((t) => !t.completed_at).sort(sorter)
  const done = top.filter((t) => t.completed_at).sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""))
  const currentList = pick.kind === "list" ? taskLists.find((l) => l.id === pick.id) : undefined
  const title = pick.kind === "list" ? (currentList?.name ?? "Tasks") : { all: "All tasks", starred: "Starred", today: "Today & overdue", upcoming: "Next 7 days" }[pick.kind]

  const toggle = (t: Entry) => planner.update(t, { completed: !t.completed_at }, t.completed_at ? "Marked not done" : t.rrule ? "Done. Next one scheduled." : "Done")
  const move = (t: Entry, dir: -1 | 1) => {
    const list = open
    const i = list.findIndex((x) => x.id === t.id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= list.length) return
    const other = list[j]
    const neighbour = list[j + dir]
    const pos = neighbour ? (other.position + neighbour.position) / 2 : other.position + dir
    planner.update(t, { position: pos })
  }

  const counts = (p: Pick) => tasks.filter((t) => !t.parent_id && !t.completed_at && matches(p, t)).length

  const navItem = (p: Pick, label: string, icon: React.ReactNode, list?: PlannerList) => {
    const active = JSON.stringify(p) === JSON.stringify(pick)
    return (
      <li key={label + (list?.id ?? "")} className="group flex items-center">
        <button
          onClick={() => {
            setPick(p)
            setNavOpen(false)
          }}
          aria-current={active ? "page" : undefined}
          className={`flex min-w-0 flex-1 items-center gap-2 rounded-xl px-3 py-2 text-left text-sm ${active ? "bg-accent-soft font-medium text-accent" : "text-ink-2 hover:bg-panel-2"}`}
        >
          {list ? <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: list.color }} /> : icon}
          <span className="flex-1 truncate">{label}</span>
          <span className="text-xs text-ink-3">{counts(p) || ""}</span>
        </button>
      </li>
    )
  }

  const row = (t: Entry, depth = 0) => {
    const due = dueLabel(t, tz, today)
    const kids = children.get(t.id) ?? []
    const isOpen = expanded.has(t.id)
    const list = t.list_id ? planner.listById.get(t.list_id) : undefined
    return (
      <li key={t.id}>
        <div className={`group flex items-start gap-3 rounded-xl px-2 py-2 hover:bg-panel-2 ${depth ? "ml-8" : ""}`}>
          <button
            onClick={() => toggle(t)}
            aria-label={t.completed_at ? `Mark “${t.title}” not done` : `Mark “${t.title}” done`}
            className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border-2"
            style={{ borderColor: planner.colorOf(t), background: t.completed_at ? planner.colorOf(t) : undefined }}
          >
            {t.completed_at ? <Icon.check width={12} height={12} className="text-white" /> : null}
          </button>
          <button onClick={() => onOpen({ entry: t })} className="min-w-0 flex-1 text-left">
            <span className={`block text-sm ${t.completed_at ? "text-ink-3 line-through" : ""}`}>{t.title}</span>
            {t.notes ? <span className="line-clamp-2 block text-xs text-ink-3">{t.notes}</span> : null}
            <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs">
              {t.starred ? <span className="text-warn" aria-label="Starred">★</span> : null}
              {due ? <span className={`rounded-full border px-2 py-0.5 ${due.overdue ? "border-danger text-danger" : "border-line text-ink-2"}`}>{due.text}</span> : null}
              {t.rrule ? <span className="text-ink-3" title={describeRule(parseRule(t.rrule))}>↻ {describeRule(parseRule(t.rrule))}</span> : null}
              {t.reminders.length && due ? <span className="text-ink-3">🔔</span> : null}
              {pick.kind !== "list" && list ? <span className="text-ink-3">{list.name}</span> : null}
              {kids.length ? (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation()
                    setExpanded((s) => {
                      const n = new Set(s)
                      if (n.has(t.id)) n.delete(t.id)
                      else n.add(t.id)
                      return n
                    })
                  }}
                  onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLElement).click()}
                  className="cursor-pointer text-accent"
                >
                  {kids.filter((k) => k.completed_at).length}/{kids.length} subtasks {isOpen ? "▾" : "▸"}
                </span>
              ) : null}
            </span>
          </button>
          <div className="flex shrink-0 items-center gap-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
            {!t.completed_at && depth === 0 && sort === "order" ? (
              <>
                <button onClick={() => move(t, -1)} className="rounded p-1 text-ink-3 hover:bg-panel" aria-label="Move up">
                  ↑
                </button>
                <button onClick={() => move(t, 1)} className="rounded p-1 text-ink-3 hover:bg-panel" aria-label="Move down">
                  ↓
                </button>
              </>
            ) : null}
            {depth === 0 ? (
              <button
                onClick={() => setExpanded((s) => new Set(s).add(t.id))}
                className="rounded p-1 text-ink-3 hover:bg-panel"
                aria-label="Add subtask"
                title="Add subtask"
              >
                <Icon.plus width={14} height={14} />
              </button>
            ) : null}
            <button onClick={() => planner.update(t, { starred: !t.starred })} className={`rounded p-1 hover:bg-panel ${t.starred ? "text-warn" : "text-ink-3"}`} aria-label={t.starred ? "Unstar" : "Star"} aria-pressed={t.starred}>
              <Icon.star width={16} height={16} fill={t.starred ? "currentColor" : "none"} />
            </button>
            <button onClick={() => planner.remove(t)} className="rounded p-1 text-ink-3 hover:bg-panel hover:text-danger" aria-label="Delete">
              <Icon.trash width={16} height={16} />
            </button>
          </div>
        </div>
        {depth === 0 && isOpen ? (
          <div className="ml-8 space-y-1">
            <ul>{kids.map((k) => row(k, 1))}</ul>
            <div className="py-1 pl-2">
              <QuickAdd planner={planner} defaultKind="task" listId={t.list_id ?? undefined} parentId={t.id} placeholder="Add a subtask" />
            </div>
          </div>
        ) : null}
      </li>
    )
  }

  return (
    <div className="flex h-full min-h-0">
      <aside className={`${navOpen ? "fixed inset-0 z-30 block bg-black/30 md:static md:bg-transparent" : "hidden"} md:block`} onClick={(e) => e.target === e.currentTarget && setNavOpen(false)}>
        <nav aria-label="Task lists" className="scroll-thin h-full w-64 overflow-y-auto border-r border-line bg-panel p-3">
          <ul className="space-y-0.5">
            {navItem({ kind: "all" }, "All tasks", <Icon.check />)}
            {navItem({ kind: "today" }, "Today & overdue", <Icon.history />)}
            {navItem({ kind: "upcoming" }, "Next 7 days", <Icon.feed />)}
            {navItem({ kind: "starred" }, "Starred", <Icon.star />)}
          </ul>
          <div className="mt-4 flex items-center justify-between px-3 pb-1">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-3">Lists</p>
            <button onClick={() => setNewList(true)} className="text-ink-2 hover:text-accent" aria-label="New list">
              <Icon.plus width={14} height={14} />
            </button>
          </div>
          <ul className="space-y-0.5">{taskLists.map((l) => navItem({ kind: "list", id: l.id }, l.name, null, l))}</ul>
          {newList ? (
            <form
              className="mt-1 flex gap-1 px-1"
              onSubmit={async (e) => {
                e.preventDefault()
                if (!name.trim()) return
                const l = await planner.listOps.create("tasks", name.trim())
                if (l) {
                  setPick({ kind: "list", id: l.id })
                  setName("")
                  setNewList(false)
                }
              }}
            >
              <label htmlFor="new-task-list" className="sr-only">
                List name
              </label>
              <input id="new-task-list" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="List name" className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-2 py-1 text-sm" />
              <button className="rounded-lg bg-accent px-2 text-sm text-accent-ink">Add</button>
            </form>
          ) : null}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 md:px-6">
          <button className="rounded-lg p-1.5 text-ink-2 hover:bg-panel-2 md:hidden" aria-label="Task lists" onClick={() => setNavOpen(true)}>
            <Icon.folder />
          </button>
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold">{title}</h2>
          <label htmlFor="task-sort" className="sr-only">
            Sort
          </label>
          <select id="task-sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="rounded-xl border border-line bg-bg px-2 py-1.5 text-sm">
            <option value="order">My order</option>
            <option value="date">Date</option>
            <option value="title">Title</option>
          </select>
          {currentList ? (
            <>
              <button onClick={() => { setRenaming(currentList); setName(currentList.name) }} className="rounded-lg p-1.5 text-ink-2 hover:bg-panel-2" aria-label="Rename list" title="Rename list">
                <Icon.edit />
              </button>
              {!currentList.is_default ? (
                <button
                  onClick={async () => {
                    if (!window.confirm(`Delete the list “${currentList.name}” and its ${tasks.filter((t) => t.list_id === currentList.id).length} tasks? They go to the bin for 90 days.`)) return
                    if (await planner.listOps.remove(currentList)) setPick(def ? { kind: "list", id: def.id } : { kind: "all" })
                  }}
                  className="rounded-lg p-1.5 text-ink-2 hover:bg-panel-2 hover:text-danger"
                  aria-label="Delete list"
                  title="Delete list"
                >
                  <Icon.trash />
                </button>
              ) : null}
            </>
          ) : null}
        </div>
        {renaming ? (
          <form
            className="flex gap-2 border-b border-line px-3 py-2 md:px-6"
            onSubmit={async (e) => {
              e.preventDefault()
              if (name.trim()) await planner.listOps.update(renaming, { name: name.trim() })
              setRenaming(null)
            }}
          >
            <label htmlFor="rename-list" className="sr-only">
              List name
            </label>
            <input id="rename-list" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className="min-w-0 flex-1 rounded-xl border border-line bg-bg px-3 py-1.5 text-sm" />
            <button className="rounded-xl bg-accent px-3 text-sm text-accent-ink">Save</button>
            <button type="button" onClick={() => setRenaming(null)} className="rounded-xl border border-line px-3 text-sm">
              Cancel
            </button>
          </form>
        ) : null}
        <div className="border-b border-line px-3 py-2 md:px-6">
          <QuickAdd
            planner={planner}
            defaultKind="task"
            listId={currentList?.id}
            defaultDate={pick.kind === "today" ? today : undefined}
            onMore={(body) => onOpen({ draft: { ...(body as Partial<Entry>), kind: "task", list_id: (body.list_id as string) ?? currentList?.id ?? null } })}
          />
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 py-2 md:px-5">
          {!planner.ready ? <p className="py-10 text-center text-sm text-ink-3">Loading…</p> : null}
          {planner.ready && !open.length && !done.length ? <p className="mx-auto max-w-sm py-16 text-center text-ink-2">No tasks here. Type one above — dates, times, “every monday” and “remind me 10 min before” are understood.</p> : null}
          <ul className="space-y-0.5">{open.map((t) => row(t))}</ul>
          {done.length ? (
            <div className="mt-4">
              <button onClick={() => setShowDone((s) => !s)} className="px-2 py-1 text-sm font-medium text-ink-2" aria-expanded={showDone}>
                {showDone ? "▾" : "▸"} Completed ({done.length})
              </button>
              {showDone ? <ul className="space-y-0.5">{done.map((t) => row(t))}</ul> : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
