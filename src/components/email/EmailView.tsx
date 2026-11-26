"use client"
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { ApiFailure } from "@/lib/client/api"
import { browserSupabase, liveSupabase } from "@/lib/client/supabase"
import {
  emailApi,
  fullDate,
  gmailUrl,
  PRIORITY_LABEL,
  senders,
  shortDate,
  type EmailCounts,
  type EmailFilter,
  type EmailMessage,
  type EmailThread,
} from "@/lib/client/email"
import type { Planner } from "@/lib/client/planner"
import { Icon } from "../app/icons"
import { Linkified } from "../app/ui"

const FILTER_KEY = "dumpbox.email.filter"
type Notify = (text: string, tone?: "ok" | "error") => void

const PRIORITY_STYLE: Record<1 | 2 | 3, string> = {
  1: "bg-danger-soft text-danger",
  2: "bg-accent-soft text-warn",
  3: "bg-panel-2 text-ink-2",
}

function failText(e: unknown) {
  return e instanceof ApiFailure ? (e.offline ? "You are offline. Try again when connected." : e.message) : "Something went wrong"
}

function sameFilter(a: EmailFilter, b: EmailFilter) {
  return a.view === b.view && a.label === b.label && a.priority === b.priority
}

/** Labels as a tree ("Work/Clients/Acme" under "Work/Clients" under "Work"); parents that are not labels themselves are shown greyed. */
function labelTree(labels: EmailCounts["labels"]) {
  const byName = new Map(labels.map((l) => [l.name, l]))
  const names = new Set<string>()
  for (const l of labels) {
    const parts = l.name.split("/")
    for (let i = 1; i <= parts.length; i++) names.add(parts.slice(0, i).join("/"))
  }
  return [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, depth: name.split("/").length - 1, short: name.split("/").pop() ?? name, count: byName.get(name) ?? null }))
}

export function EmailView({ planner, notify, onSetup }: { planner: Planner; notify: Notify; onSetup: () => void }) {
  const [filter, setFilterState] = useState<EmailFilter>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(FILTER_KEY) ?? "null") as EmailFilter | null
      if (saved && typeof saved.view === "string") return saved
    } catch {
      // ignore
    }
    return { view: "inbox" }
  })
  const [query, setQuery] = useState("")
  const [typed, setTyped] = useState("")
  const [threads, setThreads] = useState<EmailThread[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [counts, setCounts] = useState<EmailCounts | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [navOpen, setNavOpen] = useState(false)
  const seq = useRef(0)
  // How many pages are on screen; a background refresh must not throw away pages loaded with "Load more".
  const pages = useRef(1)

  const setFilter = (f: EmailFilter) => {
    setFilterState(f)
    setOpenId(null)
    setNavOpen(false)
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify(f))
    } catch {
      // ignore
    }
  }

  const loadCounts = useCallback(() => {
    emailApi.counts().then(setCounts, () => {})
  }, [])

  const load = useCallback(
    async (more: boolean) => {
      const mine = ++seq.current
      setLoading(true)
      setError(null)
      try {
        const r = await emailApi.threads(filter, query, more ? cursor : null)
        if (mine !== seq.current) return
        setThreads((prev) => (more ? [...prev, ...r.threads.filter((t) => !prev.some((p) => p.id === t.id))] : r.threads))
        setCursor(r.next_cursor)
        pages.current = more ? pages.current + 1 : 1
      } catch (e) {
        if (mine === seq.current) setError(failText(e))
      } finally {
        if (mine === seq.current) setLoading(false)
      }
    },
    [filter, query, cursor],
  )

  // Reload when the filter or search changes (not when the cursor moves).
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  }, [load])
  useEffect(() => {
    loadRef.current(false)
  }, [filter, query])
  useEffect(() => {
    loadCounts()
  }, [loadCounts])

  // Background refresh: fetch page 1 again and merge it in, keeping any further pages already loaded.
  const refreshTop = useCallback(async () => {
    // Does not take a turn of its own: if you load or change the filter meanwhile, that result wins.
    const at = seq.current
    try {
      const r = await emailApi.threads(filter, query, null)
      if (at !== seq.current) return
      if (pages.current <= 1) {
        setThreads(r.threads)
        setCursor(r.next_cursor)
        return
      }
      // Further pages stay (and so does the cursor to the page after them); page 1 is replaced by the fresh one.
      setThreads((prev) => {
        const ids = new Set(r.threads.map((t) => t.id))
        const oldest = r.threads[r.threads.length - 1]?.last_message_at ?? ""
        return [...r.threads, ...prev.filter((p) => !ids.has(p.id) && p.last_message_at <= oldest)]
      })
    } catch {
      // a failed background refresh changes nothing
    }
  }, [filter, query])

  // Web and phone stay in step: a change to any conversation (new mail from the import, pin, archive, opened,
  // deleted, on any device) arrives as a live event and refreshes this screen. Where the direct live connection is
  // blocked, it checks every 20 seconds while visible instead (every 2 minutes as a safety net when live).
  const refreshRef = useRef(refreshTop)
  useEffect(() => {
    refreshRef.current = refreshTop
  }, [refreshTop])
  useEffect(() => {
    let live = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const refresh = () => {
      if (document.visibilityState !== "visible") return
      loadCounts()
      refreshRef.current()
    }
    const nudge = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(refresh, 400)
    }
    const live$ = liveSupabase()
    let channel: ReturnType<typeof live$.channel> | null = null
    let closed = false
    browserSupabase()
      .auth.getSession()
      .then(({ data }) => {
        if (!data.session || closed) return
        live$.realtime.setAuth(data.session.access_token)
        channel = live$
          .channel(`email:${data.session.user.id}`)
          .on("postgres_changes", { event: "*", schema: "public", table: "email_threads", filter: `user_id=eq.${data.session.user.id}` }, nudge)
          .subscribe((status) => {
            live = status === "SUBSCRIBED"
          })
      })
    let ticks = 0
    const interval = setInterval(() => {
      ticks++
      if (!live || ticks % 6 === 0) refresh()
    }, 20_000)
    document.addEventListener("visibilitychange", refresh)
    return () => {
      closed = true
      clearInterval(interval)
      if (timer) clearTimeout(timer)
      document.removeEventListener("visibilitychange", refresh)
      if (channel) live$.removeChannel(channel)
    }
  }, [loadCounts])

  // Search as you type, after a short pause.
  useEffect(() => {
    const t = setTimeout(() => setQuery(typed), 300)
    return () => clearTimeout(t)
  }, [typed])

  const patchLocal = (t: EmailThread) => setThreads((list) => list.map((x) => (x.id === t.id ? { ...x, ...t } : x)))
  const dropLocal = (id: string) => setThreads((list) => list.filter((x) => x.id !== id))

  const title = filter.label
    ? filter.label
    : filter.priority
      ? `${PRIORITY_LABEL[filter.priority]} priority`
      : { inbox: "Inbox", new: "New", unread: "Unread in Gmail", starred: "Starred", pinned: "Pinned", archived: "Archived" }[filter.view]

  const tree = useMemo(() => labelTree(counts?.labels ?? []), [counts])
  const noMailAtAll = counts !== null && counts.all.total === 0 && counts.archived === 0

  const navItem = (f: EmailFilter, label: ReactNode, icon: ReactNode, count?: number, fresh?: number, depth = 0, muted = false) => {
    const active = sameFilter(f, filter)
    return (
      <li key={`${f.view}|${f.label ?? ""}|${f.priority ?? ""}`}>
        <button
          onClick={() => setFilter(f)}
          aria-current={active ? "page" : undefined}
          style={{ paddingLeft: 12 + depth * 14 }}
          className={`flex w-full items-center gap-2.5 rounded-xl py-1.5 pr-3 text-left text-sm ${active ? "bg-accent-soft font-medium text-accent" : muted ? "text-ink-3 hover:bg-panel-2" : "text-ink-2 hover:bg-panel-2"}`}
        >
          {icon}
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {fresh ? <span className="rounded-full bg-accent px-1.5 text-[11px] font-semibold text-accent-ink">{fresh}</span> : count ? <span className="text-xs text-ink-3">{count}</span> : null}
        </button>
      </li>
    )
  }

  return (
    <div className="flex h-full min-h-0">
      <aside className={`${navOpen ? "fixed inset-0 z-30 block bg-black/30 md:static md:bg-transparent" : "hidden"} md:block`} onClick={(e) => e.target === e.currentTarget && setNavOpen(false)}>
        <nav aria-label="Email folders" className="scroll-thin h-full w-64 overflow-y-auto border-r border-line bg-panel p-3">
          <ul className="space-y-0.5">
            {navItem({ view: "inbox" }, "Inbox", <Icon.mail />, counts?.all.total, counts?.all.fresh)}
            {navItem({ view: "new" }, "New", <Icon.bell />, counts?.all.fresh)}
            {navItem({ view: "unread" }, "Unread in Gmail", <Icon.dot />, counts?.unread)}
            {navItem({ view: "starred" }, "Starred", <Icon.star />, counts?.starred)}
            {navItem({ view: "pinned" }, "Pinned", <Icon.pin />, counts?.pinned)}
            {navItem({ view: "archived" }, "Archived", <Icon.archive />, counts?.archived)}
          </ul>
          <p className="mt-4 px-3 pb-1 text-xs font-medium uppercase tracking-wide text-ink-3">Priority</p>
          <ul className="space-y-0.5">
            {([1, 2, 3] as const).map((p) => {
              const c = counts?.priorities.find((x) => x.priority === p)
              return navItem({ view: "inbox", priority: p }, PRIORITY_LABEL[p], <span className={`h-2.5 w-2.5 rounded-full ${p === 1 ? "bg-danger" : p === 2 ? "bg-warn" : "bg-ink-3"}`} />, c?.total, c?.fresh)
            })}
          </ul>
          <p className="mt-4 px-3 pb-1 text-xs font-medium uppercase tracking-wide text-ink-3">Labels</p>
          {tree.length ? (
            <ul className="space-y-0.5">
              {tree.map((l) => navItem({ view: "inbox", label: l.name }, l.short, <Icon.tag />, l.count?.total, l.count?.fresh, l.depth, !l.count))}
            </ul>
          ) : (
            <p className="px-3 text-xs text-ink-3">Labels from Gmail show here.</p>
          )}
          <button onClick={onSetup} className="mt-4 flex w-full items-center gap-2 rounded-xl px-3 py-1.5 text-left text-xs text-ink-2 hover:bg-panel-2">
            <Icon.settings width={14} height={14} /> Gmail import settings
          </button>
        </nav>
      </aside>

      {/* The list stays next to an open conversation on wide screens (xl); on smaller ones the conversation replaces it. */}
      <section className={`${openId ? "hidden xl:flex" : "flex"} min-w-0 flex-1 flex-col xl:max-w-sm xl:flex-none xl:basis-[22rem] xl:border-r xl:border-line`}>
        <div className="flex items-center gap-2 border-b border-line px-3 py-2 md:px-4">
          <button className="rounded-lg p-1.5 text-ink-2 hover:bg-panel-2 md:hidden" aria-label="Email folders" onClick={() => setNavOpen(true)}>
            <Icon.folder />
          </button>
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold">{title}</h2>
          <button
            onClick={() => {
              loadCounts()
              load(false)
            }}
            className="rounded-lg p-1.5 text-ink-2 hover:bg-panel-2"
            aria-label="Refresh"
            title="Refresh"
          >
            <Icon.restore />
          </button>
        </div>
        <div className="border-b border-line px-3 py-2 md:px-4">
          <label htmlFor="email-search" className="sr-only">
            Search mail
          </label>
          <input
            id="email-search"
            type="search"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Search subject, people, text"
            className="w-full rounded-xl border border-line bg-bg px-3 py-1.5 text-sm"
          />
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          {noMailAtAll ? (
            <div className="mx-auto max-w-sm px-6 py-12 text-center">
              <p className="font-medium">No email yet</p>
              <p className="mt-1 text-sm text-ink-2">Bring your Gmail conversations in with their labels and priority. It takes about five minutes.</p>
              <button onClick={onSetup} className="mt-4 rounded-xl bg-accent px-3.5 py-2 text-sm font-medium text-accent-ink">
                Set up Gmail import
              </button>
            </div>
          ) : null}
          {!noMailAtAll && !loading && !error && !threads.length ? <p className="px-4 py-10 text-center text-sm text-ink-3">{query ? "No conversations match." : "Nothing here."}</p> : null}
          {error ? (
            <p className="px-4 py-6 text-center text-sm text-danger">
              {error}{" "}
              <button className="underline" onClick={() => load(false)}>
                Try again
              </button>
            </p>
          ) : null}
          <ul>
            {threads.map((t) => (
              <li key={t.id}>
                <button
                  onClick={() => setOpenId(t.id)}
                  aria-current={openId === t.id ? "true" : undefined}
                  className={`flex w-full gap-2.5 border-b border-line px-3 py-2.5 text-left md:px-4 ${openId === t.id ? "bg-accent-soft" : "hover:bg-panel-2"}`}
                >
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${t.fresh ? "bg-accent" : "bg-transparent"}`} aria-label={t.fresh ? "New" : undefined} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className={`min-w-0 flex-1 truncate text-sm ${t.fresh ? "font-semibold text-ink" : "text-ink-2"}`}>{senders(t)}</span>
                      {t.pinned ? <Icon.pin width={13} height={13} className="shrink-0 text-accent" aria-label="Pinned" /> : null}
                      {t.has_attachments ? <Icon.attach width={13} height={13} className="shrink-0 text-ink-3" aria-label="Has attachments" /> : null}
                      <span className={`shrink-0 text-xs ${t.fresh ? "font-semibold text-ink" : "text-ink-3"}`}>{shortDate(t.last_message_at)}</span>
                    </span>
                    <span className={`block truncate text-sm ${t.fresh ? "font-semibold" : ""}`}>{t.subject || "(no subject)"}</span>
                    <span className="block truncate text-xs text-ink-3">{t.snippet}</span>
                    <ThreadChips t={t} max={3} />
                  </span>
                  {t.starred ? <Icon.star width={15} height={15} className="mt-0.5 shrink-0 fill-current text-warn" aria-label="Starred" /> : null}
                </button>
              </li>
            ))}
          </ul>
          {loading ? <p className="py-4 text-center text-sm text-ink-3">Loading…</p> : null}
          {cursor && !loading ? (
            <div className="py-3 text-center">
              <button onClick={() => load(true)} className="rounded-xl border border-line px-3 py-1.5 text-sm text-ink-2 hover:bg-panel-2">
                Load more
              </button>
            </div>
          ) : null}
        </div>
      </section>

      {openId ? (
        <ThreadPane
          key={openId}
          id={openId}
          planner={planner}
          notify={notify}
          onBack={() => setOpenId(null)}
          onLabel={(label) => setFilter({ view: "inbox", label })}
          onChanged={(t) => {
            patchLocal(t)
            loadCounts()
            if ((filter.view === "archived") === t.in_inbox || (filter.view === "pinned" && !t.pinned)) dropLocal(t.id)
          }}
          onDeleted={(id) => {
            dropLocal(id)
            setOpenId(null)
            loadCounts()
          }}
        />
      ) : (
        <div className="hidden flex-1 place-items-center text-sm text-ink-3 xl:grid">Choose a conversation to read it.</div>
      )}
    </div>
  )
}

function ThreadChips({ t, max, onLabel }: { t: EmailThread; max?: number; onLabel?: (label: string) => void }) {
  const shown = max ? t.labels.slice(0, max) : t.labels
  if (!t.priority && !t.important && !t.labels.length) return null
  return (
    <span className="mt-1 flex flex-wrap items-center gap-1">
      {t.priority ? <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium ${PRIORITY_STYLE[t.priority]}`}>{PRIORITY_LABEL[t.priority]}</span> : null}
      {t.important ? <span className="rounded-md bg-panel-2 px-1.5 py-0.5 text-[11px] text-warn">Important</span> : null}
      {shown.map((l) =>
        onLabel ? (
          <button key={l} onClick={() => onLabel(l)} className="rounded-md border border-line px-1.5 py-0.5 text-[11px] text-ink-2 hover:border-accent hover:text-accent">
            {l}
          </button>
        ) : (
          <span key={l} className="max-w-[10rem] truncate rounded-md border border-line px-1.5 py-0.5 text-[11px] text-ink-2">
            {l}
          </span>
        ),
      )}
      {max && t.labels.length > max ? <span className="text-[11px] text-ink-3">+{t.labels.length - max}</span> : null}
    </span>
  )
}

function ThreadPane({
  id,
  planner,
  notify,
  onBack,
  onLabel,
  onChanged,
  onDeleted,
}: {
  id: string
  planner: Planner
  notify: Notify
  onBack: () => void
  onLabel: (label: string) => void
  onChanged: (t: EmailThread) => void
  onDeleted: (id: string) => void
}) {
  const [data, setData] = useState<{ thread: EmailThread; messages: EmailMessage[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const onChangedRef = useRef(onChanged)
  useEffect(() => {
    onChangedRef.current = onChanged
  }, [onChanged])

  useEffect(() => {
    let live = true
    emailApi.thread(id).then(
      (r) => {
        if (!live) return
        setData(r)
        // The last message and anything new since you last opened it start open, like Gmail.
        const last = r.messages[r.messages.length - 1]
        setExpanded(new Set(r.messages.filter((m) => m === last || m.unread).map((m) => m.id)))
        onChangedRef.current({ ...r.thread, fresh: false })
      },
      (e) => live && setError(failText(e)),
    )
    return () => {
      live = false
    }
  }, [id])

  const act = async (run: () => Promise<void>) => {
    setBusy(true)
    try {
      await run()
    } catch (e) {
      notify(failText(e), "error")
    } finally {
      setBusy(false)
    }
  }

  if (error) {
    return (
      <section className="flex min-w-0 flex-1 flex-col">
        <PaneBar onBack={onBack} />
        <p className="p-6 text-center text-sm text-danger">{error}</p>
      </section>
    )
  }
  if (!data) {
    return (
      <section className="flex min-w-0 flex-1 flex-col">
        <PaneBar onBack={onBack} />
        <p className="p-6 text-center text-sm text-ink-3">Loading…</p>
      </section>
    )
  }
  const { thread: t, messages } = data
  const setThread = (next: EmailThread) => {
    setData({ thread: next, messages })
    onChanged(next)
  }
  const defaultTasks = planner.lists.find((l) => l.kind === "tasks" && l.is_default)
  const allOpen = messages.every((m) => expanded.has(m.id))

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <PaneBar onBack={onBack}>
        <IconButton label={t.pinned ? "Unpin" : "Pin"} active={t.pinned} disabled={busy} onClick={() => act(async () => setThread((await emailApi.update(t.id, { pinned: !t.pinned })).thread))}>
          <Icon.pin />
        </IconButton>
        <IconButton
          label={t.archived_at ? "Move to inbox" : "Archive"}
          disabled={busy}
          onClick={() =>
            act(async () => {
              const r = await emailApi.update(t.id, { archived: !t.archived_at })
              setThread(r.thread)
              notify(r.thread.archived_at ? "Archived in DumpBox (Gmail unchanged)" : "Back in the inbox", "ok")
            })
          }
        >
          {t.archived_at ? <Icon.restore /> : <Icon.archive />}
        </IconButton>
        <IconButton
          label="Make a task"
          disabled={busy}
          onClick={() =>
            act(async () => {
              const from = t.from_name || t.from_email || ""
              const made = await planner.create({
                kind: "task",
                title: (t.subject || "Email").slice(0, 1000),
                notes: `${from ? `From ${from}\n` : ""}${gmailUrl(t)}`,
                list_id: defaultTasks?.id,
                starred: t.priority === 1,
              })
              if (made) notify("Task added", "ok")
            })
          }
        >
          <Icon.task />
        </IconButton>
        <a href={gmailUrl(t)} target="_blank" rel="noopener noreferrer" className="rounded-lg p-1.5 text-ink-2 hover:bg-panel-2" aria-label="Open in Gmail" title="Open in Gmail">
          <Icon.external />
        </a>
        <IconButton
          label="Delete from DumpBox"
          danger
          disabled={busy}
          onClick={() => {
            if (!window.confirm("Delete this conversation from DumpBox? Its text is removed here for good and the Gmail script will not bring it back. Gmail is not changed.")) return
            act(async () => {
              await emailApi.remove(t.id)
              notify("Deleted from DumpBox", "ok")
              onDeleted(t.id)
            })
          }}
        >
          <Icon.trash />
        </IconButton>
      </PaneBar>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-6">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-start gap-2">
            <h2 className="min-w-0 flex-1 text-xl font-semibold leading-snug break-words">{t.subject || "(no subject)"}</h2>
            {t.starred ? <Icon.star width={18} height={18} className="mt-1 shrink-0 fill-current text-warn" aria-label="Starred in Gmail" /> : null}
          </div>
          <ThreadChips t={t} onLabel={onLabel} />
          {!t.in_scope ? (
            <p className="mt-2 rounded-lg bg-panel-2 px-3 py-2 text-xs text-ink-2">This conversation no longer has a label the Gmail script brings in, so it is kept under Archived.</p>
          ) : null}
          <div className="mt-2 flex items-center gap-3 text-xs text-ink-3">
            <span>
              {t.message_count} message{t.message_count === 1 ? "" : "s"}
              {t.message_count > messages.length ? ` (latest ${messages.length} here)` : ""}
            </span>
            {messages.length > 1 ? (
              <button className="text-accent hover:underline" onClick={() => setExpanded(allOpen ? new Set([messages[messages.length - 1].id]) : new Set(messages.map((m) => m.id)))}>
                {allOpen ? "Collapse all" : "Expand all"}
              </button>
            ) : null}
          </div>

          <ol className="mt-4 space-y-3">
            {messages.map((m) => (
              <li key={m.id}>
                <MessageCard
                  m={m}
                  open={expanded.has(m.id)}
                  toggle={() =>
                    setExpanded((s) => {
                      const n = new Set(s)
                      if (n.has(m.id)) n.delete(m.id)
                      else n.add(m.id)
                      return n
                    })
                  }
                />
              </li>
            ))}
          </ol>
          <p className="mt-6 text-center text-xs text-ink-3">
            Reply and attachments are in{" "}
            <a href={gmailUrl(t)} target="_blank" rel="noopener noreferrer" className="text-accent underline">
              Gmail
            </a>
            .
          </p>
        </div>
      </div>
    </section>
  )
}

function MessageCard({ m, open, toggle }: { m: EmailMessage; open: boolean; toggle: () => void }) {
  const name = m.from_name || m.from_email || "Unknown"
  const initial = name.replace(/[^\p{L}\p{N}]/gu, "").charAt(0).toUpperCase() || "?"
  const preview = m.body_text.replace(/\s+/g, " ").trim().slice(0, 160)
  return (
    <article className={`rounded-2xl border border-line bg-panel ${open ? "" : "hover:bg-panel-2"}`}>
      <button onClick={toggle} aria-expanded={open} className="flex w-full items-start gap-3 p-3 text-left md:p-4">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent">{initial}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-sm">
              <span className="font-semibold">{name}</span>
              {m.from_name && m.from_email ? <span className="text-ink-3"> &lt;{m.from_email}&gt;</span> : null}
            </span>
            <span className="shrink-0 text-xs text-ink-3">{fullDate(m.sent_at)}</span>
          </span>
          {open ? (
            <span className="block truncate text-xs text-ink-3">
              to {m.to_list || "—"}
              {m.cc_list ? ` · cc ${m.cc_list}` : ""}
            </span>
          ) : (
            <span className="block truncate text-xs text-ink-3">{preview}</span>
          )}
        </span>
      </button>
      {open ? (
        <div className="px-3 pb-4 md:px-4 md:pl-16">
          <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">{m.body_text ? <Linkified text={m.body_text} /> : <span className="text-ink-3">(no text)</span>}</div>
          {m.attachments.length ? (
            <ul className="mt-3 flex flex-wrap gap-2">
              {m.attachments.map((a, i) => (
                <li key={i} className="flex items-center gap-1.5 rounded-lg border border-line px-2 py-1 text-xs text-ink-2">
                  <Icon.attach width={13} height={13} />
                  <span className="max-w-[14rem] truncate">{a.name || "attachment"}</span>
                  {a.size ? <span className="text-ink-3">{Math.max(1, Math.round(a.size / 1024))} KB</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

function PaneBar({ onBack, children }: { onBack: () => void; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-1 border-b border-line px-2 py-2 md:px-4">
      <button onClick={onBack} className="rounded-lg p-1.5 text-ink-2 hover:bg-panel-2" aria-label="Back to the list" title="Back to the list">
        <Icon.back />
      </button>
      <span className="flex-1" />
      {children}
    </div>
  )
}

function IconButton({ label, onClick, children, active, danger, disabled }: { label: string; onClick: () => void; children: ReactNode; active?: boolean; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={`rounded-lg p-1.5 disabled:opacity-50 ${active ? "bg-accent-soft text-accent" : danger ? "text-ink-2 hover:bg-panel-2 hover:text-danger" : "text-ink-2 hover:bg-panel-2"}`}
    >
      {children}
    </button>
  )
}
